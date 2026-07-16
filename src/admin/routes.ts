import type { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { getQueueMetrics, getQueueState } from '../queue-guard.js';
import { invalidateSettingsCache, getSettings, SETTINGS_DEFAULTS, validateSettings } from '../settings.js';
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
  systemAlertRecipients: string[];
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
              count(d.id) FILTER (WHERE d.status IN ('queued','retrying','processing','uncertain')) AS pending,
              count(d.id) FILTER (WHERE d.status IN ('failed','exhausted','expired')) AS failed
       FROM notifications n LEFT JOIN deliveries d ON d.notification_id = n.id
       GROUP BY n.id ORDER BY n.created_at DESC LIMIT 20`,
    );
    const settings = await getSettings(db);
    const queue = await getQueueMetrics(db);
    const { rows: serviceHealth } = await db.query(
      `SELECT component, last_success_at, last_error_at, last_error, detail, updated_at,
              extract(epoch FROM now() - last_success_at)::int AS age_s,
              extract(epoch FROM now() - COALESCE(last_success_at, updated_at))::int AS reference_age_s
       FROM service_health ORDER BY component`,
    );
    return {
      last24h: byStatus,
      providers: health,
      recent,
      queue: {
        ...queue,
        state: getQueueState(queue, settings),
        normalLimit: settings.queue_normal_limit,
        absoluteLimit: settings.queue_normal_limit + settings.queue_critical_reserve,
      },
      serviceHealth,
      inboundStaleAfterS: Math.max(60, Math.ceil(settings.inbound_poll_ms * 3 / 1000)),
    };
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
              count(d.id) FILTER (WHERE d.status IN ('queued','retrying','processing','uncertain')) AS pending,
              count(d.id) FILTER (WHERE d.status IN ('failed','exhausted','expired')) AS failed,
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
           last_error = NULL, finished_at = NULL, locked_at = NULL,
           first_attempt_at = NULL, send_started_at = NULL, submitted_at = NULL, last_reconciled_at = NULL,
           provider_id = NULL, provider_response = NULL
         WHERE id = $1 AND status IN ('failed', 'exhausted', 'expired', 'cancelled', 'suppressed')
         RETURNING id`,
        [req.params.id],
      );
      if (!rows[0]) return reply.code(409).send({ error: 'Solo se reintentan deliveries failed/exhausted/expired/cancelled/suppressed' });
      opts.events.emit('change');
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { status: 'sent' | 'failed' } }>(
    '/admin/api/deliveries/:id/resolve-uncertain',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: { status: { type: 'string', enum: ['sent', 'failed'] } },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await db.query(
        `UPDATE deliveries SET status = $2, locked_at = NULL, finished_at = now(),
           sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
           last_reconciled_at = now(),
           last_error = CASE WHEN $2 = 'failed'
             THEN 'resultado incierto resuelto manualmente como fallido' ELSE NULL END
         WHERE id = $1 AND status = 'uncertain' RETURNING id`,
        [req.params.id, req.body.status],
      );
      if (!rows[0]) return reply.code(409).send({ error: 'Solo se resuelven deliveries uncertain' });
      opts.events.emit('change');
      return { ok: true, status: req.body.status };
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
          keyWarningRateLimit: 1000,
          keyRateLimit: 1000,
          recipients: [req.body.recipient],
          message: req.body.message,
          channel: 'sms',
          priority: 'normal',
          systemAlertRecipients: opts.systemAlertRecipients,
        });
        for (const rateLimit of result.rateLimitEvents) {
          req.log.warn({ rateLimit }, 'umbral de rate limit alcanzado');
        }
        opts.events.emit('change');
        if (result.kind === 'created' && result.queued === 0 && result.suppressed > 0) {
          return reply.code(429).send({
            ...result,
            status: 'suppressed',
            reasons: result.suppressionReasons,
            retryable: false,
          });
        }
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
      `SELECT id, name, channels_allowed, warning_limit_per_hour, rate_limit_per_hour,
              enabled, created_at, last_used_at
       FROM api_keys ORDER BY created_at DESC`,
    );
    return { keys: rows };
  });

  app.post<{ Body: { name: string; warning_limit_per_hour?: number; rate_limit_per_hour?: number } }>(
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
            warning_limit_per_hour: { type: 'integer', minimum: 1, maximum: 1000 },
            rate_limit_per_hour: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      const token = generateToken();
      const hardLimit = req.body.rate_limit_per_hour ?? 120;
      const warningLimit = req.body.warning_limit_per_hour ?? Math.min(60, hardLimit);
      if (warningLimit > hardLimit) {
        return reply.code(400).send({ error: 'El umbral de aviso no puede superar el corte' });
      }
      try {
        const { rows } = await db.query<{ id: number }>(
          `INSERT INTO api_keys (name, key_hash, warning_limit_per_hour, rate_limit_per_hour)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [req.body.name, hashToken(token), warningLimit, hardLimit],
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

  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; warning_limit_per_hour?: number; rate_limit_per_hour?: number };
  }>(
    '/admin/api/keys/:id',
    {
      onRequest: requireSession,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            warning_limit_per_hour: { type: 'integer', minimum: 1, maximum: 1000000 },
            rate_limit_per_hour: { type: 'integer', minimum: 1, maximum: 1000000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { rows: currentRows } = await db.query<{
        warning_limit_per_hour: number;
        rate_limit_per_hour: number;
      }>(
        `SELECT warning_limit_per_hour, rate_limit_per_hour FROM api_keys WHERE id = $1`,
        [req.params.id],
      );
      const current = currentRows[0];
      if (!current) return reply.code(404).send({ error: 'Key no encontrada' });
      const warningLimit = req.body.warning_limit_per_hour ?? current.warning_limit_per_hour;
      const hardLimit = req.body.rate_limit_per_hour ?? current.rate_limit_per_hour;
      if (warningLimit > hardLimit) {
        return reply.code(400).send({ error: 'El aviso de la API key no puede superar el corte' });
      }
      await db.query(
        `UPDATE api_keys
         SET enabled = COALESCE($2, enabled), warning_limit_per_hour = $3, rate_limit_per_hour = $4
         WHERE id = $1`,
        [req.params.id, req.body.enabled ?? null, warningLimit, hardLimit],
      );
      return { ok: true, warning_limit_per_hour: warningLimit, rate_limit_per_hour: hardLimit };
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
        'global_hourly_warning',
        'global_hourly_limit',
        'recipient_hourly_warning',
        'per_recipient_hourly_limit',
        'critical_hourly_reserve',
        'queue_warning_depth',
        'queue_normal_limit',
        'queue_critical_reserve',
        'queue_warning_oldest_s',
        'queue_hard_oldest_s',
        'retry_window_s',
        'unavailable_retry_s',
        'uncertain_poll_s',
        'uncertain_without_smskey_retry_s',
        'inbound_poll_ms',
      ]);
      const entries = Object.entries(req.body).filter(([k]) => editable.has(k));
      if (!entries.length) return reply.code(400).send({ error: 'Nada editable en el cuerpo' });
      const current = await getSettings(db);
      const candidate = { ...current, ...Object.fromEntries(entries) };
      const validationError = validateSettings(candidate);
      if (validationError) return reply.code(400).send({ error: validationError });

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of entries) {
          await client.query(
            `INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
            [key, JSON.stringify(value)],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
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
        `SELECT id, channel, sender, body, device_time, device_received_at, received_at, parsed_as_command
         FROM inbound_messages ${where}
         ORDER BY COALESCE(device_received_at, received_at) DESC, received_at DESC LIMIT ${limit}`,
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
