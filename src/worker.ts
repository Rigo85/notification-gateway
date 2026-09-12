import type { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { getSettings, type Settings } from './settings.js';
import type { ChannelProvider, SendResult } from './providers/types.js';
import { splitSmsText } from './sms-text.js';

interface ClaimedDelivery {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
  first_attempt_at: Date;
  send_started_at: Date | null;
  submitted_at: Date | null;
  notification_source: string;
  notification_dedup_key: string | null;
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
type WorkerState = 'starting' | 'idle' | 'sending' | 'blocked_uncertain' | 'provider_unavailable' | 'error' | 'stopped';

interface WorkerStateEntry {
  state: WorkerState;
  since: string;
  deliveryId?: string;
  error?: string;
}

/** Worker estrictamente serial por canal; un uncertain pausado protege de duplicados. */
export class Worker {
  private db: Db;
  private providers: Map<string, ChannelProvider>;
  private log: Logger;
  private events?: EventEmitter;
  private systemAlertRecipients: string[];
  private running = false;
  private loops: Promise<void>[] = [];
  private controller: AbortController | null = null;
  private workerStates = new Map<string, WorkerStateEntry>();

  constructor(
    db: Db,
    providers: Map<string, ChannelProvider>,
    log: Logger,
    events?: EventEmitter,
    systemAlertRecipients: string[] = [],
  ) {
    this.db = db;
    this.providers = providers;
    this.log = log;
    this.events = events;
    this.systemAlertRecipients = systemAlertRecipients;
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
    await Promise.allSettled([...this.providers.keys()].map((channel) =>
      this.reportState(channel, 'stopped')));
  }

  private async channelLoop(channel: string): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.runOnce(channel);
      } catch (err) {
        this.log.error({ err, channel }, 'error en el loop del worker');
        try {
          await this.reportState(channel, 'error', undefined, err instanceof Error ? err.message : String(err));
        } catch (healthErr) {
          this.log.error({ err: healthErr, channel }, 'no se pudo registrar el error del worker');
        }
      }
      if (!this.running) break;
      let delayMs = 2_000;
      try {
        const settings = await getSettings(this.db);
        delayMs = processed ? settings.send_gap_ms : settings.poll_ms;
      } catch (err) {
        this.log.error({ err, channel }, 'no se pudo leer la configuración del worker');
      }
      await sleep(delayMs, this.controller?.signal);
    }
  }

  /** Procesa o reconcilia a lo sumo una delivery. */
  async runOnce(channel: string): Promise<boolean> {
    const provider = this.providers.get(channel);
    if (!provider) return false;
    const settings = await getSettings(this.db);

    const uncertain = await this.getUncertain(channel);
    if (uncertain) {
      await this.reportState(channel, 'blocked_uncertain', uncertain.id);
      const rebootAt = deviceRebootAfterSubmission(provider, uncertain);
      if (rebootAt) {
        await this.finishUnresolved(uncertain, {
          outcome: 'unresolved', countsAsAttempt: false, providerId: uncertain.provider_id ?? undefined,
          error: `GOIP reinició después de aceptar el envío (${rebootAt.toISOString()}); resultado final desconocido`,
          response: provider.runtimeState?.(),
        });
        await this.reportState(channel, 'idle');
        return true;
      }
      if (uncertaintyAgeMs(uncertain) >= settings.uncertain_max_block_s * 1000) {
        await this.finishUnresolved(uncertain, {
          outcome: 'unresolved', countsAsAttempt: false, providerId: uncertain.provider_id ?? undefined,
          error: `reconciliación agotó el bloqueo máximo de ${settings.uncertain_max_block_s}s; resultado final desconocido`,
          response: { timeout_s: settings.uncertain_max_block_s },
        });
        await this.reportState(channel, 'idle');
        return true;
      }
      if (uncertain.next_retry_at.getTime() > Date.now()) return false;
      const processed = await this.reconcile(provider, uncertain, settings);
      const remaining = await this.getUncertain(channel);
      await this.reportState(channel, remaining ? 'blocked_uncertain' : 'idle', remaining?.id);
      return processed;
    }

    if (await this.expireOverdue(channel, settings.retry_window_s)) {
      await this.reportState(channel, 'idle');
      this.events?.emit('change');
      return true;
    }

    const claimed = await this.claim(channel);
    if (!claimed) {
      await this.reportState(channel, 'idle');
      return false;
    }
    if (isOutsideWindow(claimed.first_attempt_at, settings.retry_window_s)) {
      await this.markExpired(claimed.id, 'ventana de reintento agotada antes del envío');
      await this.reportState(channel, 'idle');
      return true;
    }

    let health;
    try {
      health = await provider.health(this.controller?.signal);
    } catch (err) {
      health = { ok: false, detail: { error: err instanceof Error ? err.message : String(err) } };
    }
    if (!health.ok) {
      await this.reportState(channel, 'provider_unavailable', claimed.id,
        typeof health.detail?.error === 'string' ? health.detail.error : undefined);
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
    await this.reportState(channel, 'sending', claimed.id);

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
    const processed = await this.applySendResult(claimed, result, attempts, settings);
    await this.reportState(channel, result.outcome === 'uncertain' && (result.providerId || attempts < 2)
      ? 'blocked_uncertain'
      : 'idle', result.outcome === 'uncertain' && (result.providerId || attempts < 2) ? claimed.id : undefined);
    return processed;
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
      if (!result.providerId && attempts >= 2) {
        await this.finishUnresolved(claimed, {
          ...result,
          outcome: 'unresolved',
          error: result.error ?? 'segundo resultado incierto sin smskey; resultado final desconocido',
        }, attempts);
        return true;
      }
      const retryMs = result.retryAfterMs ?? (result.providerId
        ? settings.uncertain_poll_s * 1000
        : settings.uncertain_without_smskey_retry_s * 1000);
      await this.db.query(
        `UPDATE deliveries SET status = 'uncertain', attempts = $2, locked_at = NULL,
         provider_id = COALESCE($3, provider_id),
         provider_response = COALESCE(provider_response, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb),
         last_error = $5,
         first_uncertain_at = COALESCE(first_uncertain_at, now()),
         first_uncertain_error = COALESCE(first_uncertain_error, $5),
         first_uncertain_response = COALESCE(first_uncertain_response, $4::jsonb),
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
    await this.db.query(
      `UPDATE deliveries SET reconcile_count = reconcile_count + 1 WHERE id = $1 AND status = 'uncertain'`,
      [delivery.id],
    );
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
    if (result.outcome === 'unresolved') {
      await this.finishUnresolved(delivery, result);
      return true;
    }
    return this.applySendResult(delivery, { ...result, countsAsAttempt: false }, delivery.attempts, settings);
  }

  private async getUncertain(channel: string): Promise<UncertainDelivery | null> {
    const { rows } = await this.db.query<UncertainDelivery>(
      `SELECT d.id, d.recipient, d.payload, d.attempts, d.first_attempt_at, d.send_started_at,
              d.submitted_at, d.provider_id, d.next_retry_at,
              n.source AS notification_source, n.dedup_key AS notification_dedup_key
       FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.channel = $1 AND d.status = 'uncertain'
         AND (d.provider_id IS NOT NULL OR d.attempts < 2)
       ORDER BY d.created_at ASC LIMIT 1`,
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
       RETURNING d.id, d.recipient, d.payload, d.attempts, d.first_attempt_at,
         d.send_started_at, d.submitted_at,
         (SELECT source FROM notifications WHERE id = d.notification_id) AS notification_source,
         (SELECT dedup_key FROM notifications WHERE id = d.notification_id) AS notification_dedup_key`,
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
         last_reconciled_at = now(),
         provider_response = COALESCE($3, provider_response), last_error = $4
       WHERE id = $1 AND status = 'uncertain'`,
      [id, retryAfterS, jsonb(response), error],
    );
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

  /**
   * Resultado terminal que el GOIP ya no permite asociar con certeza al smskey.
   * Se conserva toda la evidencia, no bloquea el canal y nunca se reintenta solo.
   */
  private async finishUnresolved(
    delivery: ClaimedDelivery,
    result: SendResult,
    attempts = delivery.attempts,
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE deliveries SET status = 'unresolved', finished_at = now(), locked_at = NULL,
           last_reconciled_at = now(),
           provider_response = COALESCE($2::jsonb, provider_response),
           last_error = $3, attempts = $4
         WHERE id = $1 AND status IN ('uncertain', 'processing')`,
        [delivery.id, jsonb(result.response), result.error ?? 'resultado final desconocido', attempts],
      );
      if (rowCount) {
        await this.insertRecoveryAlert(client, delivery);
        await client.query('COMMIT');
        this.log.warn({ deliveryId: delivery.id }, 'delivery con resultado desconocido; no se reintentará automáticamente');
        this.events?.emit('change');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      await client.query('ROLLBACK');
      this.log.error({ err, deliveryId: delivery.id }, 'no se pudo finalizar la delivery incierta');
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertRecoveryAlert(client: PoolClient, delivery: ClaimedDelivery): Promise<void> {
    if (this.systemAlertRecipients.length === 0 ||
        (delivery.notification_source === 'notification-gateway' &&
         delivery.notification_dedup_key?.startsWith('system-sms-recovery:'))) return;
    const blockedS = Math.max(1, Math.round(uncertaintyAgeMs(delivery) / 1000));
    const message = `GATEWAY: bloqueo SMS liberado tras ${formatDuration(blockedS)}; 1 envio quedo sin confirmar.`;
    const parts = splitSmsText(message);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO notifications (source, channel, message, priority, dedup_key)
       VALUES ('notification-gateway', 'sms', $1, 'critical', $2) RETURNING id`,
      [message, `system-sms-recovery:${delivery.id}`],
    );
    for (const recipient of this.systemAlertRecipients) {
      for (const part of parts) {
        await client.query(
          `INSERT INTO deliveries
             (notification_id, channel, recipient, payload, part, parts, priority, status)
           VALUES ($1, 'sms', $2, $3, $4, $5, 3, 'queued')`,
          [rows[0]!.id, recipient, part.payload, part.part, part.parts],
        );
      }
    }
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

  private async reportState(
    channel: string,
    state: WorkerState,
    deliveryId?: string,
    error?: string,
    force = false,
  ): Promise<void> {
    const previous = this.workerStates.get(channel);
    if (!force && previous?.state === state && previous.deliveryId === deliveryId && previous.error === error) return;
    const entry: WorkerStateEntry = {
      state,
      since: previous?.state === state ? previous.since : new Date().toISOString(),
      ...(deliveryId ? { deliveryId } : {}),
      ...(error ? { error } : {}),
    };
    this.workerStates.set(channel, entry);
    await this.db.query(
      `INSERT INTO service_health (component, last_success_at, last_error_at, last_error, detail, updated_at)
       VALUES ($1, now(), $2, $3, $4, now())
       ON CONFLICT (component) DO UPDATE SET last_success_at = now(),
         last_error_at = COALESCE(EXCLUDED.last_error_at, service_health.last_error_at),
         last_error = COALESCE(EXCLUDED.last_error, service_health.last_error),
         detail = EXCLUDED.detail, updated_at = now()`,
      [
        `${channel}_worker`,
        state === 'error' ? new Date() : null,
        state === 'error' ? error ?? 'error del worker' : null,
        JSON.stringify({ ...entry, heartbeatAt: new Date().toISOString() }),
      ],
    );
  }

  private async staleLockLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.recoverStaleLocks();
      } catch (err) {
        this.log.error({ err }, 'error rescatando locks viejos');
      }
      for (const channel of this.providers.keys()) {
        const current = this.workerStates.get(channel);
        try {
          await this.reportState(channel, current?.state ?? 'starting', current?.deliveryId, current?.error, true);
        } catch (err) {
          this.log.error({ err, channel }, 'no se pudo actualizar el heartbeat del worker');
        }
      }
      await sleep(60_000, this.controller?.signal);
    }
  }
}

function isOutsideWindow(firstAttemptAt: Date, retryWindowS: number): boolean {
  return Date.now() - firstAttemptAt.getTime() >= retryWindowS * 1000;
}

function uncertaintyAgeMs(delivery: ClaimedDelivery): number {
  const anchor = delivery.submitted_at ?? delivery.send_started_at ?? delivery.first_attempt_at;
  return Math.max(0, Date.now() - anchor.getTime());
}

function deviceRebootAfterSubmission(provider: ChannelProvider, delivery: ClaimedDelivery): Date | null {
  if (!delivery.submitted_at) return null;
  const raw = provider.runtimeState?.().device_boot_at;
  if (typeof raw !== 'string') return null;
  const bootAt = new Date(raw);
  if (Number.isNaN(bootAt.getTime())) return null;
  return bootAt.getTime() > delivery.submitted_at.getTime() + 2_000 ? bootAt : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3_600).toFixed(1)}h`;
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
