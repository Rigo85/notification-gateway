import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';
import { Worker } from './worker.js';
import { InboundPoller } from './inbound.js';
import { FakeProvider } from './providers/fake.js';
import { GoipProvider } from './providers/goip.js';
import type { ChannelProvider } from './providers/types.js';

async function main(): Promise<void> {
  const db = createPool(config.databaseUrl);

  const providers = new Map<string, ChannelProvider>();
  if (config.smsProvider === 'goip') {
    providers.set('sms', new GoipProvider(config.goip));
  } else {
    providers.set('sms', new FakeProvider({ latencyMs: 100 }));
  }

  const events = new EventEmitter();
  events.setMaxListeners(100);
  const app = buildApp(db, providers, config.logLevel, {
    sessionSecret: process.env.SESSION_SECRET,
    events,
    trustProxy: config.trustProxy,
    systemAlertRecipients: config.systemAlertRecipients,
  });
  await migrate(db, (msg) => app.log.info(msg));

  const worker = new Worker(db, providers, app.log, events);
  const inbound = new InboundPoller(db, providers, app.log, events);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'apagando');
    await Promise.all([worker.stop(), inbound.stop()]);
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // listen ANTES de arrancar el worker: si el puerto está ocupado (instancia
  // duplicada), el proceso debe morir sin haber disparado ningún envío real.
  await app.listen({ port: config.port, host: config.host });

  if (!config.workerDisabled) {
    await worker.recoverStaleLocks();
    worker.start();
    inbound.start();
    app.log.info('worker de envío y poller de entrantes iniciados');
  } else {
    app.log.warn('worker deshabilitado (WORKER_DISABLED=true)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
