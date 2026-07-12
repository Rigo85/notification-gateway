import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { getSettings } from './settings.js';
import type { ChannelProvider } from './providers/types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Poller de SMS entrantes: lee el inbox del provider y lo ingiere en
 * inbound_messages. No borra nada del equipo — la deduplicación es por
 * hash único (device_time + sender + body), así el buffer rotativo del
 * GOIP puede releerse en cada poll sin duplicar filas.
 */
export class InboundPoller {
  private db: Db;
  private providers: Map<string, ChannelProvider>;
  private log: Logger;
  private events?: EventEmitter;
  private running = false;
  private loop?: Promise<void>;

  constructor(db: Db, providers: Map<string, ChannelProvider>, log: Logger, events?: EventEmitter) {
    this.db = db;
    this.providers = providers;
    this.log = log;
    this.events = events;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.log.error({ err }, 'error en el poll de entrantes');
      }
      const settings = await getSettings(this.db);
      await sleep(settings.inbound_poll_ms);
    }
  }

  /** Un ciclo de ingesta. Devuelve cuántos mensajes nuevos guardó. */
  async pollOnce(): Promise<number> {
    let inserted = 0;
    for (const [channel, provider] of this.providers) {
      if (!provider.fetchInbox) continue;
      const messages = await provider.fetchInbox();
      for (const msg of messages) {
        const hash = createHash('sha256')
          .update(`${channel}|${msg.deviceTime}|${msg.sender}|${msg.body}`)
          .digest('hex');
        const { rowCount } = await this.db.query(
          `INSERT INTO inbound_messages (channel, sender, body, device_time, dedup_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (dedup_hash) DO NOTHING`,
          [channel, msg.sender, msg.body, msg.deviceTime, hash],
        );
        inserted += rowCount ?? 0;
      }
    }
    if (inserted > 0) {
      this.log.info({ inserted }, 'SMS entrantes ingeridos');
      this.events?.emit('change');
    }
    return inserted;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
