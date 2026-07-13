import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { getSettings } from './settings.js';
import type { ChannelProvider } from './providers/types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export class InboundPoller {
  private running = false;
  private loop?: Promise<void>;
  private controller?: AbortController;

  constructor(
    private db: Db,
    private providers: Map<string, ChannelProvider>,
    private log: Logger,
    private events?: EventEmitter,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop;
    this.loop = undefined;
    this.controller = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(new Date(), this.controller?.signal);
      } catch (err) {
        if (this.running) this.log.error({ err }, 'error en el poll de entrantes');
      }
      if (!this.running) break;
      const settings = await getSettings(this.db);
      try {
        await sleep(settings.inbound_poll_ms, this.controller?.signal);
      } catch {
        break;
      }
    }
  }

  /** Un ciclo de ingesta. Nunca borra el buffer del equipo. */
  async pollOnce(now = new Date(), signal?: AbortSignal): Promise<number> {
    let inserted = 0;
    const detail: Record<string, unknown> = {};
    try {
      for (const [channel, provider] of this.providers) {
        if (!provider.fetchInbox) continue;
        const messages = await provider.fetchInbox(signal);
        const capacity = provider.inboxCapacity;
        const atCapacity = capacity !== undefined && messages.length >= capacity;
        detail[channel] = { visible: messages.length, capacity: capacity ?? null, at_capacity: atCapacity };
        if (atCapacity) {
          this.log.error(
            { channel, visible: messages.length, capacity },
            'inbox del provider lleno; pueden haberse sobrescrito mensajes anteriores',
          );
        }
        for (const msg of [...messages].reverse()) {
          const hash = createHash('sha256')
            .update(`${channel}|${msg.deviceTime}|${msg.sender}|${msg.body}`)
            .digest('hex');
          const { rowCount } = await this.db.query(
            `INSERT INTO inbound_messages
               (channel, sender, body, device_time, device_received_at, dedup_hash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (dedup_hash) DO NOTHING`,
            [channel, msg.sender, msg.body, msg.deviceTime, inferDeviceReceivedAt(msg.deviceTime, now), hash],
          );
          inserted += rowCount ?? 0;
        }
      }
      await this.db.query(
        `INSERT INTO service_health (component, last_success_at, last_error, detail, updated_at)
         VALUES ('inbound_poller', now(), NULL, $1, now())
         ON CONFLICT (component) DO UPDATE SET last_success_at = now(), last_error = NULL,
           detail = EXCLUDED.detail, updated_at = now()`,
        [JSON.stringify(detail)],
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      await this.db.query(
        `INSERT INTO service_health (component, last_error_at, last_error, detail, updated_at)
         VALUES ('inbound_poller', now(), $1, $2, now())
         ON CONFLICT (component) DO UPDATE SET last_error_at = now(), last_error = EXCLUDED.last_error,
           detail = EXCLUDED.detail, updated_at = now()`,
        [err instanceof Error ? err.message : String(err), JSON.stringify(detail)],
      );
      throw err;
    }
    if (inserted > 0) {
      this.log.info({ inserted }, 'SMS entrantes ingeridos');
      this.events?.emit('change');
    }
    return inserted;
  }
}

/** El GOIP reporta MM-DD HH:MM:SS en hora de Lima y omite el año. */
export function inferDeviceReceivedAt(deviceTime: string, now = new Date()): Date | null {
  const match = deviceTime.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, month, day, hour, minute, second] = match;
  const limaNow = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const baseYear = limaNow.getUTCFullYear();
  const candidates = [baseYear - 1, baseYear, baseYear + 1]
    .map((year) => new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}-05:00`))
    .filter((date) => {
      if (Number.isNaN(date.getTime())) return false;
      const local = new Date(date.getTime() - 5 * 60 * 60 * 1000);
      return local.getUTCMonth() + 1 === Number(month) && local.getUTCDate() === Number(day) &&
        local.getUTCHours() === Number(hour) && local.getUTCMinutes() === Number(minute) &&
        local.getUTCSeconds() === Number(second);
    });
  return candidates.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0] ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('operación abortada'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('operación abortada'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
