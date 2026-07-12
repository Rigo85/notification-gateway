import type { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { getSettings } from './settings.js';
import type { ChannelProvider } from './providers/types.js';

interface ClaimedDelivery {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

const STALE_LOCK_MINUTES = 5;
const SEND_TIMEOUT_MS = 90_000;

/**
 * Worker de envío: estrictamente serial por canal (el GOIP no tiene cola
 * interna y responde "L1 busy" — goip-validacion §5.3).
 */
export class Worker {
  private db: Db;
  private providers: Map<string, ChannelProvider>;
  private log: Logger;
  private events?: EventEmitter;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(db: Db, providers: Map<string, ChannelProvider>, log: Logger, events?: EventEmitter) {
    this.db = db;
    this.providers = providers;
    this.log = log;
    this.events = events;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const channel of this.providers.keys()) {
      this.loops.push(this.channelLoop(channel));
    }
    this.loops.push(this.staleLockLoop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async channelLoop(channel: string): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.runOnce(channel);
      } catch (err) {
        this.log.error({ err, channel }, 'error en el loop del worker');
      }
      const settings = await getSettings(this.db);
      const waitMs = processed ? settings.send_gap_ms : settings.poll_ms;
      await sleep(waitMs);
    }
  }

  /** Procesa a lo sumo una delivery del canal. Devuelve true si procesó algo. */
  async runOnce(channel: string): Promise<boolean> {
    const provider = this.providers.get(channel);
    if (!provider) return false;

    const claimed = await this.claim(channel);
    if (!claimed) return false;

    const settings = await getSettings(this.db);
    let result;
    try {
      result = await withTimeout(provider.send(claimed), SEND_TIMEOUT_MS);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }

    const attempts = claimed.attempts + 1;
    if (result.ok) {
      await this.db.query(
        `UPDATE deliveries SET status = 'sent', attempts = $2, sent_at = now(), finished_at = now(),
           locked_at = NULL, provider_id = $3, provider_response = $4, last_error = NULL
         WHERE id = $1`,
        [claimed.id, attempts, result.providerId ?? null, jsonb(result.response)],
      );
      this.log.info({ deliveryId: claimed.id, recipient: claimed.recipient, channel }, 'delivery enviada');
      this.events?.emit('change');
      return true;
    }

    const retryable = result.retryable !== false;
    if (!retryable) {
      await this.finishFailed(claimed.id, attempts, 'failed', result);
      this.log.warn({ deliveryId: claimed.id, error: result.error }, 'delivery con fallo permanente');
    } else if (attempts >= settings.max_attempts) {
      await this.finishFailed(claimed.id, attempts, 'exhausted', result);
      this.log.warn({ deliveryId: claimed.id, error: result.error, attempts }, 'delivery agotó reintentos');
    } else {
      const backoffS = settings.retry_backoff_s[attempts - 1] ?? 600;
      await this.db.query(
        `UPDATE deliveries SET status = 'retrying', attempts = $2, locked_at = NULL,
           next_retry_at = now() + $3 * interval '1 second',
           provider_response = $4, last_error = $5
         WHERE id = $1`,
        [claimed.id, attempts, backoffS, jsonb(result.response), result.error ?? 'error desconocido'],
      );
      this.log.warn(
        { deliveryId: claimed.id, error: result.error, attempts, backoffS },
        'delivery fallida, reintento programado',
      );
    }
    this.events?.emit('change');
    return true;
  }

  private async claim(channel: string): Promise<ClaimedDelivery | null> {
    const { rows } = await this.db.query<ClaimedDelivery>(
      `WITH next AS (
         SELECT id FROM deliveries
         WHERE channel = $1 AND status IN ('queued', 'retrying') AND next_retry_at <= now()
         ORDER BY priority DESC, created_at ASC, part ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE deliveries d SET status = 'processing', locked_at = now()
       FROM next WHERE d.id = next.id
       RETURNING d.id, d.recipient, d.payload, d.attempts`,
      [channel],
    );
    return rows[0] ?? null;
  }

  private async finishFailed(
    id: string,
    attempts: number,
    status: 'failed' | 'exhausted',
    result: { error?: string; response?: unknown },
  ): Promise<void> {
    await this.db.query(
      `UPDATE deliveries SET status = $2, attempts = $3, finished_at = now(), locked_at = NULL,
         provider_response = $4, last_error = $5
       WHERE id = $1`,
      [id, status, attempts, jsonb(result.response), result.error ?? 'error desconocido'],
    );
  }

  /** Rescata deliveries con lock viejo (worker muerto a mitad de envío). */
  async recoverStaleLocks(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE deliveries SET status = 'queued', locked_at = NULL
       WHERE status = 'processing' AND locked_at < now() - interval '${STALE_LOCK_MINUTES} minutes'`,
    );
    if (rowCount) this.log.warn({ recovered: rowCount }, 'deliveries rescatadas de lock viejo');
    return rowCount ?? 0;
  }

  private async staleLockLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.recoverStaleLocks();
      } catch (err) {
        this.log.error({ err }, 'error rescatando locks viejos');
      }
      await sleep(60_000);
    }
  }
}

function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de envío tras ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
