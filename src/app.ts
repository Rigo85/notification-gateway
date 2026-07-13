import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Db } from './db.js';
import { registerRoutes } from './routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { ChannelProvider } from './providers/types.js';

export interface AppOptions {
  sessionSecret?: string;
  events?: EventEmitter;
  trustProxy?: boolean;
  systemAlertRecipients?: string[];
}

export function buildApp(
  db: Db,
  providers: Map<string, ChannelProvider>,
  logLevel = 'info',
  opts: AppOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel }, trustProxy: opts.trustProxy ?? false });
  const events = opts.events ?? new EventEmitter();
  const sessionSecret = opts.sessionSecret ?? randomBytes(32).toString('hex');

  void app.register(fastifyCookie);
  void app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), 'web'),
    prefix: '/admin/',
  });
  app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
  app.get('/', (_req, reply) => reply.redirect('/admin/'));

  registerRoutes(app, db, providers, events, opts.systemAlertRecipients ?? []);
  registerAdminRoutes(app, db, providers, {
    sessionSecret,
    events,
    systemAlertRecipients: opts.systemAlertRecipients ?? [],
  });
  return app;
}
