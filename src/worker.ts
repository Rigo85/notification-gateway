import type { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { getSettings, type Settings } from './settings.js';
import type { ChannelProvider, SendResult } from './providers/types.js';

interface ClaimedDelivery {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
  first_attempt_at: Date;
}

interface UncertainDelivery extends ClaimedDelivery {
  provider_id: string | null;
  next_retry_at: Date;
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

const STALE_LOCK_MINUTES = 5;
const SEND_TIMEOUT_MS = 90_000;

/** Worker estrictamente serial por canal; un uncertain pausa su canal. */
export class Worker {
  private db: Db;
  private providers: Map<string, ChannelProvider>;
  private log: Logger;
  private events?: EventEmitter;
  private running = false;
  private loops: Promise<void>[] = [];
  private controller: AbortController | null = null;

  constructor(db: Db, providers: Map<string, ChannelProvider>, log: Logger, events?: EventEmitter) {
    this.db = db;
    this.providers = providers;
    this.log = log;
    this.events = events;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    for (const channel of this.providers.keys()) this.loops.push(this.channelLoop(channel));
    this.loops.push(this.staleLockLoop());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort(new Error('worker detenido'));
    await Promise.allSettled(this.loops);
    this.loops = [];
    this.controller = null;
  }

  private async channelLoop(channel: string): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.runOnce(channel);
      } catch (err) {
        this.log.error({ err, channel }, 'error en el loop del worker');
      }
      if (!this.running) break;
      const settings = await getSettings(this.db);
      await sleep(processed ? settings.send_gap_ms : settings.poll_ms, this.controller?.signal);
    }
  }

  /** Procesa o reconcilia a lo sumo una delivery. */
  async runOnce(channel: string): Promise<boolean> {
    const provider = this.providers.get(channel);
    if (!provider) return false;
    const settings = await getSettings(this.db);

    const uncertain = await this.getUncertain(channel);
    if (uncertain) {
      if (uncertain.next_retry_at.getTime() > Date.now()) return false;
      return this.reconcile(provider, uncertain, settings);
    }

    if (await this.expireOverdue(channel, settings.retry_window_s)) {
      this.events?.emit('change');
      return true;
    }

    const claimed = await this.claim(channel);
    if (!claimed) return false;
    if (isOutsideWindow(claimed.first_attempt_at, settings.retry_window_s)) {
      await this.markExpired(claimed.id, 'ventana de reintento agotada antes del envío');
      return true;
    }

    let health;
    try {
      health = await provider.health(this.controller?.signal);
    } catch (err) {
      health = { ok: false, detail: { error: err instanceof Error ? err.message : String(err) } };
    }
    if (!health.ok) {
      await this.requeueWithoutAttempt(
        claimed.id,
        settings.unavailable_retry_s * 1000,
        `provider no disponible: ${JSON.stringify(health.detail ?? {})}`,
        health.detail,
      );
      return true;
    }

    // Debe persistirse antes de tocar send.html. Desde este punto, una caída no permite
    // distinguir si el GOIP recibió la solicitud y la recuperación debe ser conservadora.
    await this.db.query(
      `UPDATE deliveries SET send_started_at = now() WHERE id = $1 AND status = 'processing'`,
      [claimed.id],
    );

    let result: SendResult;
    try {
      result = await withTimeout(
        provider.send(claimed, async (providerId) => {
          await this.db.query(
            `UPDATE deliveries SET provider_id = $2, submitted_at = now() WHERE id = $1`,
            [claimed.id, providerId],
          );
        }, this.controller?.signal),
        SEND_TIMEOUT_MS,
      );
    } catch (err) {
      result = {
        outcome: 'uncertain',
        countsAsAttempt: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const attempts = claimed.attempts + (result.countsAsAttempt ? 1 : 0);
    return this.applySendResult(claimed, result, attempts, settings);
  }

  private async applySendResult(
    claimed: ClaimedDelivery,
    result: SendResult,
    attempts: number,
    settings: Settings,
  ): Promise<boolean> {
    if (result.outcome === 'sent') {
      await this.db.query(
        `UPDATE deliveries SET status = 'sent', attempts = $2, sent_at = now(), finished_at = now(),
           locked_at = NULL, provider_id = COALESCE($3, provider_id), provider_response = $4,
           last_error = NULL, last_reconciled_at = now()
         WHERE id = $1`,
        [claimed.id, attempts, result.providerId ?? null, jsonb(result.response)],
      );
      this.log.info({ deliveryId: claimed.id, channel: 'sms' }, 'delivery enviada');
    } else if (result.outcome === 'uncertain') {
      const retryMs = result.retryAfterMs ?? (result.providerId
        ? settings.uncertain_poll_s * 1000
        : settings.uncertain_without_smskey_retry_s * 1000);
      await this.db.query(
        `UPDATE deliveries SET status = 'uncertain', attempts = $2, locked_at = NULL,
         provider_id = COALESCE($3, provider_id),
         provider_response = COALESCE(provider_response, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb),
         last_error = $5,
         next_retry_at = now() + $6 * interval '1 millisecond'
         WHERE id = $1`,
        [claimed.id, attempts, result.providerId ?? null, jsonb(result.response), result.error, retryMs],
      );
      this.log.warn({ deliveryId: claimed.id, providerId: result.providerId }, 'delivery con resultado incierto; canal pausado');
    } else if (result.outcome === 'busy' || result.outcome === 'unavailable') {
      await this.requeueWithoutAttempt(
        claimed.id,
        result.retryAfterMs ?? settings.unavailable_retry_s * 1000,
        result.error ?? result.outcome,
        result.response,
      );
    } else if (result.outcome === 'permanent') {
      await this.finishFailed(claimed.id, attempts, 'failed', result);
      this.log.warn({ deliveryId: claimed.id, error: result.error }, 'delivery con fallo permanente');
    } else if (isOutsideWindow(claimed.first_attempt_at, settings.retry_window_s)) {
      await this.markExpired(claimed.id, result.error ?? 'ventana de reintento agotada');
    } else if (attempts >= settings.max_attempts) {
      await this.finishFailed(claimed.id, attempts, 'exhausted', result);
      this.log.warn({ deliveryId: claimed.id, error: result.error, attempts }, 'delivery agotó reintentos');
    } else {
      const backoffS = settings.retry_backoff_s[Math.max(0, attempts - 1)] ?? 600;
      await this.db.query(
        `UPDATE deliveries SET status = 'retrying', attempts = $2, locked_at = NULL,
           next_retry_at = now() + $3 * interval '1 second', provider_response = $4, last_error = $5,
           send_started_at = NULL, submitted_at = NULL, provider_id = NULL
         WHERE id = $1`,
        [claimed.id, attempts, backoffS, jsonb(result.response), result.error ?? 'error desconocido'],
      );
      this.log.warn({ deliveryId: claimed.id, error: result.error, attempts, backoffS }, 'delivery fallida, reintento programado');
    }
    this.events?.emit('change');
    return true;
  }

  private async reconcile(
    provider: ChannelProvider,
    delivery: UncertainDelivery,
    settings: Settings,
  ): Promise<boolean> {
    if (!delivery.provider_id) {
      return this.retryWithoutSmskey(delivery);
    }
    if (!provider.reconcile) {
      await this.deferUncertain(delivery.id, settings.uncertain_poll_s, 'reconciliación manual requerida');
      return false;
    }
    let result: SendResult;
    try {
      result = await provider.reconcile(delivery.provider_id, this.controller?.signal);
    } catch (err) {
      result = {
        outcome: 'uncertain', countsAsAttempt: false, providerId: delivery.provider_id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.outcome === 'uncertain' || result.outcome === 'busy' || result.outcome === 'unavailable') {
      await this.deferUncertain(
        delivery.id,
        Math.ceil((result.retryAfterMs ?? settings.uncertain_poll_s * 1000) / 1000),
        result.error ?? 'estado aun incierto',
        result.response,
      );
      return true;
    }
    return this.applySendResult(delivery, { ...result, countsAsAttempt: false }, delivery.attempts, settings);
  }

  private async getUncertain(channel: string): Promise<UncertainDelivery | null> {
    const { rows } = await this.db.query<UncertainDelivery>(
      `SELECT id, recipient, payload, attempts, first_attempt_at, provider_id, next_retry_at
       FROM deliveries WHERE channel = $1 AND status = 'uncertain'
         AND (provider_id IS NOT NULL OR attempts < 2)
       ORDER BY created_at ASC LIMIT 1`,
      [channel],
    );
    return rows[0] ?? null;
  }

  /**
   * Sin smskey no existe forma de reconciliar el slot del GOIP. Se permite un solo
   * reintento, se conserva el primer error y un segundo incierto deja de pausar la cola.
   */
  private async retryWithoutSmskey(delivery: UncertainDelivery): Promise<boolean> {
    await this.db.query(
      `UPDATE deliveries SET status = 'retrying', locked_at = NULL, next_retry_at = now(),
         last_reconciled_at = now(),
         provider_response = COALESCE(provider_response, '{}'::jsonb) ||
           jsonb_build_object('uncertain_without_smskey_first_error', last_error),
         last_error = 'reintento único tras resultado incierto sin smskey',
         send_started_at = NULL, submitted_at = NULL, provider_id = NULL
       WHERE id = $1 AND status = 'uncertain' AND provider_id IS NULL AND attempts < 2`,
      [delivery.id],
    );
    this.log.warn({ deliveryId: delivery.id }, 'delivery sin smskey reintentada una vez; la cola continúa después');
    this.events?.emit('change');
    return true;
  }

  private async claim(channel: string): Promise<ClaimedDelivery | null> {
    const { rows } = await this.db.query<ClaimedDelivery>(
      `WITH next AS (
         SELECT id FROM deliveries
         WHERE channel = $1 AND status IN ('queued', 'retrying') AND next_retry_at <= now()
         ORDER BY priority DESC, created_at ASC, part ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE deliveries d SET status = 'processing', locked_at = now(),
         first_attempt_at = COALESCE(d.first_attempt_at, now())
       FROM next WHERE d.id = next.id
       RETURNING d.id, d.recipient, d.payload, d.attempts, d.first_attempt_at`,
      [channel],
    );
    return rows[0] ?? null;
  }

  private async expireOverdue(channel: string, retryWindowS: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE deliveries SET status = 'expired', finished_at = now(), locked_at = NULL,
         last_error = 'ventana de reintento agotada' ||
           CASE WHEN last_error IS NULL THEN '' ELSE '; ultimo error: ' || last_error END
       WHERE channel = $1 AND status IN ('queued', 'retrying') AND first_attempt_at IS NOT NULL
         AND first_attempt_at <= now() - $2 * interval '1 second'`,
      [channel, retryWindowS],
    );
    return rowCount ?? 0;
  }

  private async requeueWithoutAttempt(id: string, retryAfterMs: number, error: string, response?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE deliveries SET status = 'retrying', locked_at = NULL,
         next_retry_at = now() + $2 * interval '1 millisecond', provider_response = $3, last_error = $4,
         send_started_at = NULL, submitted_at = NULL, provider_id = NULL
       WHERE id = $1`,
      [id, retryAfterMs, jsonb(response), error],
    );
    this.log.warn({ deliveryId: id, error, retryAfterMs }, 'provider no disponible; intento conservado');
    this.events?.emit('change');
  }

  private async deferUncertain(id: string, retryAfterS: number, error: string, response?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE deliveries SET next_retry_at = now() + $2 * interval '1 second',
         last_reconciled_at = now(), provider_response = COALESCE($3, provider_response), last_error = $4
       WHERE id = $1 AND status = 'uncertain'`,
      [id, retryAfterS, jsonb(response), error],
    );
    this.events?.emit('change');
  }

  private async markExpired(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE deliveries SET status = 'expired', finished_at = now(), locked_at = NULL, last_error = $2
       WHERE id = $1`,
      [id, error],
    );
    this.log.warn({ deliveryId: id, error }, 'delivery conservada sin reintento por antigüedad');
    this.events?.emit('change');
  }

  private async finishFailed(
    id: string,
    attempts: number,
    status: 'failed' | 'exhausted',
    result: { error?: string; response?: unknown },
  ): Promise<void> {
    await this.db.query(
      `UPDATE deliveries SET status = $2, attempts = $3, finished_at = now(), locked_at = NULL,
         provider_response = $4, last_error = $5, last_reconciled_at = now()
       WHERE id = $1`,
      [id, status, attempts, jsonb(result.response), result.error ?? 'error desconocido'],
    );
  }

  async recoverStaleLocks(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE deliveries SET
         status = CASE WHEN send_started_at IS NOT NULL OR submitted_at IS NOT NULL OR provider_id IS NOT NULL
           THEN 'uncertain' ELSE 'queued' END,
         attempts = attempts + CASE
           WHEN send_started_at IS NOT NULL OR submitted_at IS NOT NULL OR provider_id IS NOT NULL THEN 1 ELSE 0 END,
         next_retry_at = now(), locked_at = NULL,
         last_error = CASE WHEN send_started_at IS NOT NULL OR submitted_at IS NOT NULL OR provider_id IS NOT NULL
           THEN 'worker interrumpido durante el envío; requiere reconciliación'
           ELSE last_error END
       WHERE status = 'processing' AND locked_at < now() - interval '${STALE_LOCK_MINUTES} minutes'`,
    );
    if (rowCount) this.log.warn({ recovered: rowCount }, 'deliveries recuperadas de lock viejo');
    return rowCount ?? 0;
  }

  private async staleLockLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.recoverStaleLocks();
      } catch (err) {
        this.log.error({ err }, 'error rescatando locks viejos');
      }
      await sleep(60_000, this.controller?.signal);
    }
  }
}

function isOutsideWindow(firstAttemptAt: Date, retryWindowS: number): boolean {
  return Date.now() - firstAttemptAt.getTime() >= retryWindowS * 1000;
}

function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de envío tras ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
