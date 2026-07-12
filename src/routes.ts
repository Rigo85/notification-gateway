import type { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { makeAuthHook } from './auth.js';
import { EnqueueError, enqueueNotification } from './enqueue.js';
import type { ChannelProvider } from './providers/types.js';

const notificationBodySchema = {
  type: 'object',
  required: ['recipients', 'message'],
  additionalProperties: false,
  properties: {
    recipients: { type: 'array', items: { type: 'string', minLength: 7, maxLength: 20 }, minItems: 1, maxItems: 50 },
    message: { type: 'string', minLength: 1, maxLength: 1000 },
    channel: { type: 'string', enum: ['sms'], default: 'sms' },
    priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], default: 'normal' },
    dedup_key: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;

interface NotificationBody {
  recipients: string[];
  message: string;
  channel: 'sms';
  priority: 'low' | 'normal' | 'high' | 'critical';
  dedup_key?: string;
}

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  providers: Map<string, ChannelProvider>,
  events?: EventEmitter,
): void {
  const authHook = makeAuthHook(db);

  app.get('/health', async () => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    try {
      await db.query('SELECT 1');
      checks.db = 'ok';
    } catch (err) {
      checks.db = String(err);
      ok = false;
    }
    for (const [channel, provider] of providers) {
      try {
        const h = await withTimeout(provider.health(), 3000);
        checks[`provider_${channel}`] = h.ok ? { ok: true, ...h.detail } : { ok: false, ...h.detail };
        if (!h.ok) ok = false;
      } catch (err) {
        checks[`provider_${channel}`] = { ok: false, error: String(err) };
        ok = false;
      }
    }
    const { rows } = await db.query<{ pending: string; oldest_s: string | null }>(
      `SELECT count(*) AS pending,
              extract(epoch FROM now() - min(created_at))::int::text AS oldest_s
       FROM deliveries WHERE status IN ('queued', 'retrying', 'processing')`,
    );
    checks.queue = { pending: Number(rows[0]?.pending ?? 0), oldest_pending_s: rows[0]?.oldest_s ? Number(rows[0].oldest_s) : 0 };
    return { ok, checks };
  });

  app.post<{ Body: NotificationBody }>(
    '/api/notifications',
    { schema: { body: notificationBodySchema }, onRequest: authHook },
    async (req, reply) => {
      const key = req.apiKey!;
      if (!key.channelsAllowed.includes(req.body.channel)) {
        return reply.code(403).send({ error: `El canal '${req.body.channel}' no está permitido para esta API key` });
      }
      try {
        const result = await enqueueNotification(db, {
          source: key.name,
          keyRateLimit: key.rateLimitPerHour,
          recipients: req.body.recipients,
          message: req.body.message,
          channel: req.body.channel,
          priority: req.body.priority,
          dedupKey: req.body.dedup_key,
        });
        events?.emit('change');
        if (result.kind === 'suppressed_dedup') {
          return reply.code(200).send({
            notification_id: result.notificationId,
            status: 'suppressed',
            reason: 'dedup',
            window_remaining_s: result.windowRemainingS,
            suppressed_count: result.suppressedCount,
          });
        }
        return reply.code(202).send({
          notification_id: result.notificationId,
          status: result.queued > 0 ? 'queued' : 'suppressed',
          deliveries_queued: result.queued,
          deliveries_suppressed: result.suppressed,
          invalid_recipients: result.invalidRecipients,
        });
      } catch (err) {
        if (err instanceof EnqueueError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/notifications/:id',
    { onRequest: authHook },
    async (req, reply) => {
      const { rows: notifRows } = await db.query(
        `SELECT id, source, channel, message, priority, dedup_key, suppressed_count, created_at
         FROM notifications WHERE id = $1`,
        [req.params.id],
      );
      const notif = notifRows[0];
      if (!notif) return reply.code(404).send({ error: 'Notificación no encontrada' });
      const { rows: deliveries } = await db.query(
        `SELECT id, recipient, payload, part, parts, status, attempts, next_retry_at,
                provider_id, last_error, created_at, sent_at, finished_at
         FROM deliveries WHERE notification_id = $1 ORDER BY recipient, part`,
        [req.params.id],
      );
      return { ...notif, deliveries };
    },
  );
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
