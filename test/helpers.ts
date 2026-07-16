import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { FakeProvider } from '../src/providers/fake.js';
import { generateToken, hashToken } from '../src/auth.js';
import { invalidateSettingsCache } from '../src/settings.js';
import type { ChannelProvider } from '../src/providers/types.js';

// Base PROPIA de tests, separada de la de desarrollo: las sobras de un test en la
// base de dev se convierten en envíos reales si el server corre con provider goip.
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:dev@localhost:5433/notification_gateway_test';

export interface TestContext {
  db: Db;
  app: FastifyInstance;
  fake: FakeProvider;
  providers: Map<string, ChannelProvider>;
  token: string;
}

export async function setupContext(): Promise<TestContext> {
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  const fake = new FakeProvider();
  const providers = new Map<string, ChannelProvider>([['sms', fake]]);
  const app = buildApp(db, providers, 'silent');
  const token = generateToken();
  await resetData(db, token);
  return { db, app, fake, providers, token };
}

export async function resetData(db: Db, token: string): Promise<void> {
  await db.query(
    `TRUNCATE rate_limit_events, notification_requests, deliveries, notifications,
              api_keys, users, inbound_messages RESTART IDENTITY CASCADE`,
  );
  await db.query(
    `UPDATE service_health SET last_success_at = NULL, last_error_at = NULL,
       last_error = NULL, detail = '{}', updated_at = now()`,
  );
  await db.query(
    `UPDATE settings SET value = d.v::jsonb FROM (VALUES
      ('send_gap_ms', '3000'), ('poll_ms', '2000'), ('max_attempts', '3'),
      ('retry_backoff_s', '[30, 120, 600]'), ('dedup_window_s', '900'),
      ('global_hourly_warning', '120'), ('global_hourly_limit', '240'),
      ('recipient_hourly_warning', '60'), ('per_recipient_hourly_limit', '120'),
      ('critical_hourly_reserve', '20'),
      ('queue_warning_depth', '20'), ('queue_normal_limit', '60'),
      ('queue_critical_reserve', '20'), ('queue_warning_oldest_s', '300'),
      ('queue_hard_oldest_s', '900'), ('retry_window_s', '3600'),
      ('unavailable_retry_s', '30'), ('uncertain_poll_s', '10'), ('uncertain_without_smskey_retry_s', '60'),
      ('inbound_poll_ms', '10000')
     ) AS d(k, v) WHERE settings.key = d.k`,
  );
  invalidateSettingsCache();
  await db.query(
    `INSERT INTO api_keys (name, key_hash, warning_limit_per_hour, rate_limit_per_hour)
     VALUES ('test-app', $1, 60, 120)`,
    [hashToken(token)],
  );
}

export async function teardownContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.end();
}

export function authHeaders(ctx: TestContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.token}` };
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  invalidateSettingsCache();
}

/** Corre el worker hasta vaciar la cola (para tests, sin pausas reales). */
export async function drainQueue(ctx: TestContext, worker: { runOnce: (c: string) => Promise<boolean> }): Promise<number> {
  let n = 0;
  while (await worker.runOnce('sms')) {
    n++;
    if (n > 100) throw new Error('drainQueue: demasiadas iteraciones');
  }
  return n;
}
