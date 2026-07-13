import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { getQueueMetrics, type QueueMetrics } from './queue-guard.js';
import { getSettings, type Settings } from './settings.js';
import {
  normalizeRecipient,
  SmsTextTooLongError,
  splitSmsText,
  type SmsPart,
} from './sms-text.js';

export const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, critical: 3 };

const INGRESS_ADVISORY_LOCK = 7_203_140_517;

export interface EnqueueRequest {
  source: string;
  apiKeyId?: number;
  keyWarningRateLimit: number;
  keyRateLimit: number;
  recipients: string[];
  message: string;
  channel: string;
  priority: string;
  dedupKey?: string;
  systemAlertRecipients?: string[];
}

export interface RateLimitEvent {
  scope: 'api_key' | 'global' | 'recipient' | 'queue';
  scopeKey: string;
  level: 'warning' | 'hard';
  observedCount: number;
  projectedCount: number;
  limit: number;
  alertDeliveries: number;
}

interface ResultMeta {
  rateLimitEvents: RateLimitEvent[];
  suppressionReasons: string[];
}

export type EnqueueResult =
  | (ResultMeta & {
      kind: 'suppressed_dedup';
      notificationId: string;
      windowRemainingS: number;
      suppressedCount: number;
    })
  | (ResultMeta & {
      kind: 'created';
      notificationId: string;
      queued: number;
      suppressed: number;
      invalidRecipients: string[];
    });

interface LimitObservation {
  scope: RateLimitEvent['scope'];
  scopeKey: string;
  level: RateLimitEvent['level'];
  observedCount: number;
  projectedCount: number;
  limit: number;
}

interface PlannedDelivery {
  recipient: string;
  part: SmsPart;
  suppressionReason: string | null;
}

export async function enqueueNotification(db: Db, req: EnqueueRequest): Promise<EnqueueResult> {
  const settings = await getSettings(db);
  const { validRecipients, invalidRecipients } = normalizeRecipients(req.recipients);
  if (validRecipients.length === 0) {
    throw new EnqueueError(400, `Ningún destinatario válido: ${invalidRecipients.join(', ')}`);
  }

  let parts: SmsPart[];
  try {
    parts = splitSmsText(req.message);
  } catch (err) {
    if (err instanceof SmsTextTooLongError) throw new EnqueueError(400, err.message);
    throw err;
  }

  const systemAlertRecipients = normalizeRecipients(req.systemAlertRecipients ?? []).validRecipients;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [INGRESS_ADVISORY_LOCK]);

    const requestId = await insertRequest(client, req);
    const apiKeyCount = await countApiKeyRequests(client, req.source);
    const apiObservations = apiLimitObservations(req, apiKeyCount);

    const dedupHit = req.dedupKey
      ? await suppressDuplicate(client, req, settings.dedup_window_s)
      : null;
    if (dedupHit) {
      await client.query(
        `UPDATE notification_requests SET notification_id = $2, outcome = 'dedup' WHERE id = $1`,
        [requestId, dedupHit.id],
      );
      const rateLimitEvents = await recordRateLimitEvents(
        client,
        apiObservations,
        systemAlertRecipients,
        settings,
      );
      await client.query('COMMIT');
      const elapsedS = Math.floor((Date.now() - dedupHit.created_at.getTime()) / 1000);
      return {
        kind: 'suppressed_dedup',
        notificationId: dedupHit.id,
        windowRemainingS: Math.max(0, settings.dedup_window_s - elapsedS),
        suppressedCount: dedupHit.suppressed_count,
        rateLimitEvents,
        suppressionReasons: dedupHit.suppression_reasons,
      };
    }

    const globalCount = await countPhysicalDeliveries(client);
    const recipientCounts = await recipientCountsLastHour(client, validRecipients);
    const queueMetrics = await getQueueMetrics(client, req.channel);
    const critical = req.priority === 'critical';
    const globalRequestLimit = critical
      ? settings.global_hourly_limit
      : Math.max(0, settings.global_hourly_limit - settings.critical_hourly_reserve);
    const apiHardExceeded = !critical && apiKeyCount > req.keyRateLimit;
    const queueRequestLimit = critical
      ? settings.queue_normal_limit + settings.queue_critical_reserve
      : settings.queue_normal_limit;
    const queueAgeBlocked = !critical && queueMetrics.oldestReadyS >= settings.queue_hard_oldest_s;
    const planned = planDeliveries(
      validRecipients,
      parts,
      recipientCounts,
      globalCount,
      globalRequestLimit,
      settings.per_recipient_hourly_limit,
      apiHardExceeded,
      critical,
      queueMetrics.pendingTotal,
      queueRequestLimit,
      queueAgeBlocked,
    );

    const notificationId = await insertNotification(client, req);
    await insertDeliveries(client, req, notificationId, planned);
    await client.query(
      `UPDATE notification_requests SET notification_id = $2, outcome = 'created' WHERE id = $1`,
      [requestId, notificationId],
    );

    const observations = [
      ...apiObservations,
      ...deliveryLimitObservations(
        req,
        planned,
        parts.length,
        validRecipients,
        globalCount,
        recipientCounts,
        globalRequestLimit,
        settings,
      ),
      ...queueLimitObservations(req, planned, queueMetrics, queueRequestLimit, settings),
    ];
    const rateLimitEvents = await recordRateLimitEvents(
      client,
      observations,
      systemAlertRecipients,
      settings,
    );

    await client.query('COMMIT');
    const queued = planned.filter((delivery) => !delivery.suppressionReason).length;
    const suppressionReasons = uniqueSuppressionReasons(planned);
    return {
      kind: 'created',
      notificationId,
      queued,
      suppressed: planned.length - queued,
      invalidRecipients,
      rateLimitEvents,
      suppressionReasons,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export class EnqueueError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normalizeRecipients(recipients: string[]): { validRecipients: string[]; invalidRecipients: string[] } {
  const validRecipients: string[] = [];
  const invalidRecipients: string[] = [];
  for (const raw of recipients) {
    const normalized = normalizeRecipient(raw);
    if (!normalized) invalidRecipients.push(raw);
    else if (!validRecipients.includes(normalized)) validRecipients.push(normalized);
  }
  return { validRecipients, invalidRecipients };
}

async function insertRequest(client: PoolClient, req: EnqueueRequest): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO notification_requests (source, api_key_id) VALUES ($1, $2) RETURNING id`,
    [req.source, req.apiKeyId ?? null],
  );
  return Number(rows[0]!.id);
}

async function suppressDuplicate(
  client: PoolClient,
  req: EnqueueRequest,
  windowSeconds: number,
): Promise<{
  id: string;
  created_at: Date;
  suppressed_count: number;
  suppression_reasons: string[];
} | null> {
  const { rows } = await client.query<{ id: string; created_at: Date; suppressed_count: number }>(
    `UPDATE notifications n SET suppressed_count = suppressed_count + 1
     WHERE n.id = (
       SELECT id FROM notifications
       WHERE dedup_key = $1 AND source = $2
         AND created_at > now() - $3 * interval '1 second'
         AND EXISTS (
           SELECT 1 FROM deliveries dx
           WHERE dx.notification_id = notifications.id AND dx.status <> 'suppressed'
         )
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING n.id, n.created_at, n.suppressed_count`,
    [req.dedupKey, req.source, windowSeconds],
  );
  const hit = rows[0];
  if (!hit) return null;
  const statuses = await client.query<{ reason: string }>(
    `SELECT DISTINCT last_error AS reason FROM deliveries
     WHERE notification_id = $1 AND status = 'suppressed' AND last_error IS NOT NULL`,
    [hit.id],
  );
  const accepted = await client.query(
    `SELECT 1 FROM deliveries WHERE notification_id = $1 AND status <> 'suppressed' LIMIT 1`,
    [hit.id],
  );
  return {
    ...hit,
    suppression_reasons: accepted.rowCount ? [] : statuses.rows.map((row) => row.reason),
  };
}

async function insertNotification(client: PoolClient, req: EnqueueRequest): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO notifications (source, channel, message, priority, dedup_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.source, req.channel, req.message, req.priority, req.dedupKey ?? null],
  );
  if (!rows[0]) throw new Error('INSERT notifications no devolvió fila');
  return rows[0].id;
}

function planDeliveries(
  recipients: string[],
  parts: SmsPart[],
  initialRecipientCounts: Map<string, number>,
  initialGlobalCount: number,
  globalLimit: number,
  recipientLimit: number,
  apiHardExceeded: boolean,
  critical: boolean,
  initialQueueCount: number,
  queueLimit: number,
  queueAgeBlocked: boolean,
): PlannedDelivery[] {
  let globalCount = initialGlobalCount;
  let queueCount = initialQueueCount;
  const recipientCounts = new Map(initialRecipientCounts);
  const planned: PlannedDelivery[] = [];

  for (const recipient of recipients) {
    for (const part of parts) {
      let suppressionReason: string | null = null;
      if (apiHardExceeded) suppressionReason = 'rate_limit:api_key';
      else if (queueAgeBlocked) suppressionReason = 'queue_limit:age';
      else if (!critical && (recipientCounts.get(recipient) ?? 0) >= recipientLimit) {
        suppressionReason = 'rate_limit:recipient';
      } else if (globalCount >= globalLimit) {
        suppressionReason = critical ? 'rate_limit:global_absolute' : 'rate_limit:global_reserved';
      } else if (queueCount >= queueLimit) {
        suppressionReason = critical ? 'queue_limit:absolute' : 'queue_limit:reserved';
      }

      planned.push({ recipient, part, suppressionReason });
      if (!suppressionReason) {
        globalCount++;
        queueCount++;
        recipientCounts.set(recipient, (recipientCounts.get(recipient) ?? 0) + 1);
      }
    }
  }
  return planned;
}

function uniqueSuppressionReasons(planned: PlannedDelivery[]): string[] {
  return [...new Set(planned.flatMap((delivery) => delivery.suppressionReason ?? []))];
}

async function insertDeliveries(
  client: PoolClient,
  req: EnqueueRequest,
  notificationId: string,
  planned: PlannedDelivery[],
): Promise<void> {
  const priorityRank = PRIORITY_RANK[req.priority] ?? 1;
  for (const delivery of planned) {
    const suppressed = delivery.suppressionReason !== null;
    await client.query(
      `INSERT INTO deliveries
         (notification_id, channel, recipient, payload, part, parts, priority, status, last_error, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        notificationId,
        req.channel,
        delivery.recipient,
        delivery.part.payload,
        delivery.part.part,
        delivery.part.parts,
        priorityRank,
        suppressed ? 'suppressed' : 'queued',
        delivery.suppressionReason,
        suppressed ? new Date() : null,
      ],
    );
  }
}

function apiLimitObservations(req: EnqueueRequest, count: number): LimitObservation[] {
  const observations: LimitObservation[] = [];
  if (count >= req.keyWarningRateLimit) {
    observations.push({
      scope: 'api_key',
      scopeKey: req.source,
      level: 'warning',
      observedCount: count - 1,
      projectedCount: count,
      limit: req.keyWarningRateLimit,
    });
  }
  if (req.priority !== 'critical' && count > req.keyRateLimit) {
    observations.push({
      scope: 'api_key',
      scopeKey: req.source,
      level: 'hard',
      observedCount: count - 1,
      projectedCount: count,
      limit: req.keyRateLimit,
    });
  }
  return observations;
}

function deliveryLimitObservations(
  req: EnqueueRequest,
  planned: PlannedDelivery[],
  partCount: number,
  recipients: string[],
  globalCount: number,
  recipientCounts: Map<string, number>,
  globalRequestLimit: number,
  settings: Settings,
): LimitObservation[] {
  const observations: LimitObservation[] = [];
  const queued = planned.filter((delivery) => !delivery.suppressionReason);
  if (globalCount + queued.length >= settings.global_hourly_warning) {
    observations.push({
      scope: 'global',
      scopeKey: req.channel,
      level: 'warning',
      observedCount: globalCount,
      projectedCount: globalCount + queued.length,
      limit: settings.global_hourly_warning,
    });
  }
  if (planned.some((delivery) => delivery.suppressionReason?.startsWith('rate_limit:global'))) {
    observations.push({
      scope: 'global',
      scopeKey: req.channel,
      level: 'hard',
      observedCount: globalCount,
      projectedCount: globalCount + planned.length,
      limit: globalRequestLimit,
    });
  }

  for (const recipient of recipients) {
    const observed = recipientCounts.get(recipient) ?? 0;
    const accepted = queued.filter((delivery) => delivery.recipient === recipient).length;
    if (observed + accepted >= settings.recipient_hourly_warning) {
      observations.push({
        scope: 'recipient',
        scopeKey: recipient,
        level: 'warning',
        observedCount: observed,
        projectedCount: observed + accepted,
        limit: settings.recipient_hourly_warning,
      });
    }
    if (planned.some(
      (delivery) => delivery.recipient === recipient && delivery.suppressionReason === 'rate_limit:recipient',
    )) {
      observations.push({
        scope: 'recipient',
        scopeKey: recipient,
        level: 'hard',
        observedCount: observed,
        projectedCount: observed + partCount,
        limit: settings.per_recipient_hourly_limit,
      });
    }
  }
  return observations;
}

function queueLimitObservations(
  req: EnqueueRequest,
  planned: PlannedDelivery[],
  metrics: QueueMetrics,
  queueRequestLimit: number,
  settings: Settings,
): LimitObservation[] {
  const observations: LimitObservation[] = [];
  const queued = planned.filter((delivery) => !delivery.suppressionReason).length;
  if (metrics.pendingTotal + queued >= settings.queue_warning_depth) {
    observations.push({
      scope: 'queue',
      scopeKey: `${req.channel}:depth`,
      level: 'warning',
      observedCount: metrics.pendingTotal,
      projectedCount: metrics.pendingTotal + queued,
      limit: settings.queue_warning_depth,
    });
  }
  if (planned.some((delivery) => delivery.suppressionReason?.startsWith('queue_limit:') &&
    delivery.suppressionReason !== 'queue_limit:age')) {
    observations.push({
      scope: 'queue',
      scopeKey: `${req.channel}:depth`,
      level: 'hard',
      observedCount: metrics.pendingTotal,
      projectedCount: metrics.pendingTotal + planned.length,
      limit: queueRequestLimit,
    });
  }
  if (metrics.oldestReadyS >= settings.queue_warning_oldest_s) {
    observations.push({
      scope: 'queue',
      scopeKey: `${req.channel}:age`,
      level: 'warning',
      observedCount: metrics.oldestReadyS,
      projectedCount: metrics.oldestReadyS,
      limit: settings.queue_warning_oldest_s,
    });
  }
  if (planned.some((delivery) => delivery.suppressionReason === 'queue_limit:age')) {
    observations.push({
      scope: 'queue',
      scopeKey: `${req.channel}:age`,
      level: 'hard',
      observedCount: metrics.oldestReadyS,
      projectedCount: metrics.oldestReadyS,
      limit: settings.queue_hard_oldest_s,
    });
  }
  return observations;
}

async function recordRateLimitEvents(
  client: PoolClient,
  observations: LimitObservation[],
  alertRecipients: string[],
  settings: Settings,
): Promise<RateLimitEvent[]> {
  const unique = new Map<string, LimitObservation>();
  for (const observation of observations) {
    unique.set(`${observation.scope}:${observation.scopeKey}:${observation.level}`, observation);
  }

  const events: RateLimitEvent[] = [];
  for (const observation of unique.values()) {
    const existing = await client.query(
      `SELECT 1 FROM rate_limit_events
       WHERE scope = $1 AND scope_key = $2 AND level = $3
         AND created_at > now() - interval '1 hour'
       LIMIT 1`,
      [observation.scope, observation.scopeKey, observation.level],
    );
    if (existing.rowCount) continue;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO rate_limit_events
         (scope, scope_key, level, observed_count, projected_count, limit_value)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        observation.scope,
        observation.scopeKey,
        observation.level,
        observation.observedCount,
        observation.projectedCount,
        observation.limit,
      ],
    );
    const eventId = Number(rows[0]!.id);
    const alertDeliveries = observation.level === 'hard'
      ? await insertSystemAlert(client, eventId, observation, alertRecipients, settings)
      : 0;
    if (alertDeliveries) {
      await client.query('UPDATE rate_limit_events SET alert_deliveries = $2 WHERE id = $1', [
        eventId,
        alertDeliveries,
      ]);
    }
    events.push({ ...observation, alertDeliveries });
  }
  return events;
}

async function insertSystemAlert(
  client: PoolClient,
  eventId: number,
  observation: LimitObservation,
  recipients: string[],
  settings: Settings,
): Promise<number> {
  if (recipients.length === 0) return 0;
  const globalCount = await countPhysicalDeliveries(client);
  const queue = await getQueueMetrics(client, 'sms');
  const queueAbsoluteLimit = settings.queue_normal_limit + settings.queue_critical_reserve;
  const capacity = Math.min(
    settings.global_hourly_limit - globalCount,
    queueAbsoluteLimit - queue.pendingTotal,
  );
  const selected = recipients.slice(0, Math.max(0, capacity));
  if (selected.length === 0) return 0;

  const message = systemAlertMessage(observation);
  const parts = splitSmsText(message);
  const maxRecipients = Math.floor(capacity / parts.length);
  const finalRecipients = selected.slice(0, maxRecipients);
  if (finalRecipients.length === 0) return 0;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO notifications (source, channel, message, priority, dedup_key)
     VALUES ('notification-gateway', 'sms', $1, 'critical', $2) RETURNING id`,
    [message, `system-rate-limit:${eventId}`],
  );
  const notificationId = rows[0]!.id;
  for (const recipient of finalRecipients) {
    for (const part of parts) {
      await client.query(
        `INSERT INTO deliveries
           (notification_id, channel, recipient, payload, part, parts, priority, status)
         VALUES ($1, 'sms', $2, $3, $4, $5, $6, 'queued')`,
        [notificationId, recipient, part.payload, part.part, part.parts, PRIORITY_RANK.critical],
      );
    }
  }
  return finalRecipients.length * parts.length;
}

function systemAlertMessage(observation: LimitObservation): string {
  if (observation.scope === 'queue') {
    const unit = observation.scopeKey.endsWith(':age') ? 's' : 'deliveries';
    return `GATEWAY: corte cola SMS; ${observation.projectedCount}/${observation.limit} ${unit}. Exceso no critico suprimido.`;
  }
  const scope = observation.scope === 'global'
    ? 'global SMS'
    : observation.scope === 'api_key'
      ? `API ${observation.scopeKey}`
      : `destinatario ${observation.scopeKey}`;
  return `GATEWAY: corte ${scope}; ${observation.projectedCount}/${observation.limit} en 1h. Exceso no critico suprimido.`;
}

async function countApiKeyRequests(client: PoolClient, source: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM notification_requests
     WHERE source = $1 AND created_at > now() - interval '1 hour'`,
    [source],
  );
  return Number(rows[0]?.n ?? 0);
}

async function countPhysicalDeliveries(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM deliveries
     WHERE created_at > now() - interval '1 hour' AND status <> 'suppressed'`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function recipientCountsLastHour(
  client: PoolClient,
  recipients: string[],
): Promise<Map<string, number>> {
  const { rows } = await client.query<{ recipient: string; n: string }>(
    `SELECT recipient, count(*) AS n FROM deliveries
     WHERE recipient = ANY($1) AND created_at > now() - interval '1 hour'
       AND status <> 'suppressed'
     GROUP BY recipient`,
    [recipients],
  );
  return new Map(rows.map((row) => [row.recipient, Number(row.n)]));
}
