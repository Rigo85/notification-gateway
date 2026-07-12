import type { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { invalidateSettingsCache, getSettings, SETTINGS_DEFAULTS } from '../settings.js';
import { enqueueNotification, EnqueueError } from '../enqueue.js';
import { generateToken, hashToken } from '../auth.js';
import {
  clearLoginFails,
  createSession,
  loginBlocked,
  registerLoginFail,
  verifyPassword,
  verifySession,
} from './session.js';
import type { ChannelProvider } from '../providers/types.js';

const COOKIE = 'ngw_session';

export interface AdminOptions {
  sessionSecret: string;
  events: EventEmitter;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  db: Db,
  providers: Map<string, ChannelProvider>,
  opts: AdminOptions,
): void {
  const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = verifySession(req.cookies[COOKIE], opts.sessionSecret);
    if (!user) {
      await reply.code(401).send({ error: 'Sesión inválida o expirada' });
    }
  };

  // --- sesión ---

  app.post<{ Body: { username: string; password: string } }>(
    '/admin/api/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 60 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (loginBlocked(req.ip)) {
        return reply.code(429).send({ error: 'Demasiados intentos; espera 15 minutos' });
      }
      const { rows } = await db.query<{ username: string; password_hash: string }>(
        'SELECT username, password_hash FROM users WHERE username = $1',
        [req.body.username],
      );
      const user = rows[0];
      if (!user || !verifyPassword(req.body.password, user.password_hash)) {
        registerLoginFail(req.ip);
        return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
      }
      clearLoginFails(req.ip);
      return reply
        .setCookie(COOKIE, createSession(user.username, opts.sessionSecret), {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 7 * 24 * 3600,
        })
        .send({ ok: true, username: user.username });
    },
  );

  app.post('/admin/api/logout', async (_req, reply) => {
    return reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });

  app.get('/admin/api/me', { onRequest: requireSession }, async (req) => {
    return { username: verifySession(req.cookies[COOKIE], opts.sessionSecret) };
  });

  // --- dashboard ---

  app.get('/admin/api/overview', { onRequest: requireSession }, async () => {
    const { rows: counters } = await db.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM deliveries
       WHERE created_at > now() - interval '24 hours' GROUP BY status`,
    );
    const byStatus: Record<string, number> = {};
    for (const row of counters) byStatus[row.status] = Number(row.n);

    const health: Record<string, unknown> = {};
    for (const [channel, provider] of providers) {
      try {
        health[channel] = await withTimeout(provider.health(), 3000);
      } catch (err) {
        health[channel] = { ok: false, detail: { error: String(err) } };
      }
    }

    const { rows: recent } = await db.query(
      `SELECT n.id, n.source, n.channel, n.message, n.priority, n.suppressed_count, n.created_at,
              count(d.id) AS deliveries,
              count(d.id) FILTER (WHERE d.status = 'sent') AS sent,
              count(d.id) FILTER (WHERE d.status IN ('queued','retrying','processing')) AS pending,
              count(d.id) FILTER (WHERE d.status IN ('failed','exhausted')) AS failed
       FROM notifications n LEFT JOIN deliveries d ON d.notification_id = n.id
       GROUP BY n.id ORDER BY n.created_at DESC LIMIT 20`,
    );
    return { last24h: byStatus, providers: health, recent };
  });

  // --- notificaciones ---

  app.get<{
    Querystring: { status?: string; source?: string; from?: string; to?: string; limit?: number; offset?: number };
  }>('/admin/api/notifications', { onRequest: requireSession }, async (req) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conds.push(sql.replace('?', `$${params.length}`));
    };
    if (req.query.source) add('n.source = ?', req.query.source);
    if (req.query.from) add('n.created_at >= ?', req.query.from);
    if (req.query.to) add('n.created_at <= ?', req.query.to);
    if (req.query.status) add('EXISTS (SELECT 1 FROM deliveries dx WHERE dx.notification_id = n.id AND dx.status = ?)', req.query.status);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const { rows } = await db.query(
      `SELECT n.id, n.source, n.channel, n.message, n.priority, n.dedup_key, n.suppressed_count, n.created_at,
              count(d.id) AS deliveries,
              count(d.id) FILTER (WHERE d.status = 'sent') AS sent,
              count(d.id) FILTER (WHERE d.status IN ('queued','retrying','processing')) AS pending,
              count(d.id) FILTER (WHERE d.status IN ('failed','exhausted')) AS failed,
              count(d.id) FILTER (WHERE d.status = 'suppressed') AS suppressed
       FROM notifications n LEFT JOIN deliveries d ON d.notification_id = n.id
       ${where}
       GROUP BY n.id ORDER BY n.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { notifications: rows, limit, offset };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/api/notifications/:id',
    { onRequest: requireSession },
    async (req, reply) => {
      const { rows } = await db.query('SELECT * FROM notifications WHERE id = $1', [req.params.id]);
      if (!rows[0]) return reply.code(404).send({ error: 'No encontrada' });
      const { rows: deliveries } = await db.query(
        'SELECT * FROM deliveries WHERE notification_id = $1 ORDER BY recipient, part',
        [req.params.id],
      );
      return { ...rows[0], deliveries };
    },
  );

  // --- acciones sobre deliveries ---

  app.post<{ Params: { id: string } }>(
    '/admin/api/deliveries/:id/retry',
    { onRequest: requireSession },
    async (req, reply) => {
      const { rows } = await db.query(
        `UPDATE deliveries SET status = 'queued', attempts = 0, next_retry_at = now(),
           last_error = NULL, finished_at = NULL, locked_at = NULL
         WHERE id = $1 AND status IN ('failed', 'exhausted', 'cancelled', 'suppressed')
         RETURNING id`,
        [req.params.id],
      );
      if (!rows[0]) return reply.code(409).send({ error: 'Solo se reintentan deliveries failed/exhausted/cancelled/suppressed' });
      opts.events.emit('change');
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/api/deliveries/:id/cancel',
    { onRequest: requireSession },
    async (req, reply) => {
      const { rows } = await db.query(
        `UPDATE deliveries SET status = 'cancelled', finished_at = now(), locked_at = NULL
         WHERE id = $1 AND status IN ('queued', 'retrying')
         RETURNING id`,
        [req.params.id],
      );
      if (!rows[0]) return reply.code(409).send({ error: 'Solo se cancelan deliveries queued/retrying' });
      opts.events.emit('change');
      return { ok: true };
    },
  );

  // --- envío de prueba ---

  app.post<{ Body: { recipient: string; message: string } }>(
    '/admin/api/test-send',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['recipient', 'message'],
          additionalProperties: false,
          properties: {
            recipient: { type: 'string', minLength: 7, maxLength: 20 },
            message: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await enqueueNotification(db, {
          source: 'panel-test',
          keyRateLimit: 1000,
          recipients: [req.body.recipient],
          message: req.body.message,
          channel: 'sms',
          priority: 'normal',
        });
        opts.events.emit('change');
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof EnqueueError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    },
  );

  // --- API keys ---

  app.get('/admin/api/keys', { onRequest: requireSession }, async () => {
    const { rows } = await db.query(
      `SELECT id, name, channels_allowed, rate_limit_per_hour, enabled, created_at, last_used_at
       FROM api_keys ORDER BY created_at DESC`,
    );
    return { keys: rows };
  });

  app.post<{ Body: { name: string; rate_limit_per_hour?: number } }>(
    '/admin/api/keys',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[a-zA-Z0-9._-]+$' },
            rate_limit_per_hour: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      const token = generateToken();
      try {
        const { rows } = await db.query<{ id: number }>(
          `INSERT INTO api_keys (name, key_hash, rate_limit_per_hour) VALUES ($1, $2, $3) RETURNING id`,
          [req.body.name, hashToken(token), req.body.rate_limit_per_hour ?? 20],
        );
        return reply.code(201).send({ id: rows[0]!.id, name: req.body.name, token });
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: `Ya existe una key con nombre '${req.body.name}'` });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/admin/api/keys/:id',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await db.query('UPDATE api_keys SET enabled = $2 WHERE id = $1 RETURNING id', [
        req.params.id,
        req.body.enabled,
      ]);
      if (!rows[0]) return reply.code(404).send({ error: 'Key no encontrada' });
      return { ok: true };
    },
  );

  // --- settings ---

  app.get('/admin/api/settings', { onRequest: requireSession }, async () => {
    return getSettings(db);
  });

  app.put<{ Body: Record<string, unknown> }>(
    '/admin/api/settings',
    { onRequest: requireSession },
    async (req, reply) => {
      const editable = new Set([
        'send_gap_ms',
        'poll_ms',
        'max_attempts',
        'retry_backoff_s',
        'dedup_window_s',
        'global_hourly_limit',
        'per_recipient_hourly_limit',
        'inbound_poll_ms',
      ]);
      const entries = Object.entries(req.body).filter(([k]) => editable.has(k));
      if (!entries.length) return reply.code(400).send({ error: 'Nada editable en el cuerpo' });
      for (const [key, value] of entries) {
        await db.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
          [key, JSON.stringify(value)],
        );
      }
      invalidateSettingsCache();
      return getSettings(db);
    },
  );

  // --- SMS entrantes ---

  app.get<{ Querystring: { limit?: number; sender?: string } }>(
    '/admin/api/inbound',
    { onRequest: requireSession },
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const params: unknown[] = [];
      let where = '';
      if (req.query.sender) {
        params.push(`%${req.query.sender}%`);
        where = `WHERE sender ILIKE $1`;
      }
      const { rows } = await db.query(
        `SELECT id, channel, sender, body, device_time, received_at, parsed_as_command
         FROM inbound_messages ${where}
         ORDER BY received_at DESC LIMIT ${limit}`,
        params,
      );
      return { messages: rows };
    },
  );

  app.post('/admin/api/settings/reset', { onRequest: requireSession }, async () => {
    for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
    invalidateSettingsCache();
    return getSettings(db);
  });

  // --- SSE: el panel se refresca cuando algo cambia ---

  app.get('/admin/api/stream', { onRequest: requireSession }, (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('event: hello\ndata: {}\n\n');
    const onChange = (): void => {
      reply.raw.write(`event: change\ndata: {}\n\n`);
    };
    opts.events.on('change', onChange);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 30_000);
    req.raw.on('close', () => {
      opts.events.off('change', onChange);
      clearInterval(heartbeat);
    });
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
