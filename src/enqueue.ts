import type { Db } from './db.js';
import { getSettings } from './settings.js';
import { normalizeRecipient, splitSmsText } from './sms-text.js';

export const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export interface EnqueueRequest {
  source: string;
  keyRateLimit: number;
  recipients: string[];
  message: string;
  channel: string;
  priority: string;
  dedupKey?: string;
}

export type EnqueueResult =
  | { kind: 'suppressed_dedup'; notificationId: string; windowRemainingS: number; suppressedCount: number }
  | {
      kind: 'created';
      notificationId: string;
      queued: number;
      suppressed: number;
      invalidRecipients: string[];
    };

export async function enqueueNotification(db: Db, req: EnqueueRequest): Promise<EnqueueResult> {
  const settings = await getSettings(db);

  // 1. Deduplicación: misma dedup_key + source dentro de la ventana → suprimir
  if (req.dedupKey) {
    const { rows } = await db.query<{ id: string; created_at: Date; suppressed_count: number }>(
      `UPDATE notifications n SET suppressed_count = suppressed_count + 1
       WHERE n.id = (
         SELECT id FROM notifications
         WHERE dedup_key = $1 AND source = $2
           AND created_at > now() - $3 * interval '1 second'
         ORDER BY created_at DESC LIMIT 1
       )
       RETURNING n.id, n.created_at, n.suppressed_count`,
      [req.dedupKey, req.source, settings.dedup_window_s],
    );
    const hit = rows[0];
    if (hit) {
      const elapsedS = Math.floor((Date.now() - hit.created_at.getTime()) / 1000);
      return {
        kind: 'suppressed_dedup',
        notificationId: hit.id,
        windowRemainingS: Math.max(0, settings.dedup_window_s - elapsedS),
        suppressedCount: hit.suppressed_count,
      };
    }
  }

  // 2. Normalizar destinatarios
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of req.recipients) {
    const normalized = normalizeRecipient(raw);
    if (normalized) {
      if (!valid.includes(normalized)) valid.push(normalized);
    } else {
      invalid.push(raw);
    }
  }
  if (valid.length === 0) {
    throw new EnqueueError(400, `Ningún destinatario válido: ${invalid.join(', ')}`);
  }

  // 3. Límites (conteo de la última hora, sin contar suprimidas)
  const [globalCount, keyCount, perRecipient] = await Promise.all([
    countLastHour(db, `status <> 'suppressed'`, []),
    countLastHour(
      db,
      `status <> 'suppressed' AND notification_id IN (SELECT id FROM notifications WHERE source = $1)`,
      [req.source],
    ),
    recipientCountsLastHour(db, valid),
  ]);

  let suppressAll: string | null = null;
  if (globalCount >= settings.global_hourly_limit) suppressAll = 'rate_limit:global';
  else if (keyCount >= req.keyRateLimit) suppressAll = 'rate_limit:api_key';

  const parts = splitSmsText(req.message);
  const priorityRank = PRIORITY_RANK[req.priority] ?? 1;

  // 4. Insertar notificación + deliveries en una transacción
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const {
      rows: [notif],
    } = await client.query<{ id: string }>(
      `INSERT INTO notifications (source, channel, message, priority, dedup_key)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.source, req.channel, req.message, req.priority, req.dedupKey ?? null],
    );
    if (!notif) throw new Error('INSERT notifications no devolvió fila');

    let queued = 0;
    let suppressed = 0;
    for (const recipient of valid) {
      const recipientSuppressed =
        suppressAll ??
        ((perRecipient.get(recipient) ?? 0) >= settings.per_recipient_hourly_limit
          ? 'rate_limit:recipient'
          : null);
      for (const part of parts) {
        const status = recipientSuppressed ? 'suppressed' : 'queued';
        await client.query(
          `INSERT INTO deliveries
             (notification_id, channel, recipient, payload, part, parts, priority, status, last_error, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            notif.id,
            req.channel,
            recipient,
            part.payload,
            part.part,
            part.parts,
            priorityRank,
            status,
            recipientSuppressed,
            recipientSuppressed ? new Date() : null,
          ],
        );
        if (recipientSuppressed) suppressed++;
        else queued++;
      }
    }
    await client.query('COMMIT');
    return { kind: 'created', notificationId: notif.id, queued, suppressed, invalidRecipients: invalid };
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

async function countLastHour(db: Db, where: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM deliveries
     WHERE created_at > now() - interval '1 hour' AND ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function recipientCountsLastHour(db: Db, recipients: string[]): Promise<Map<string, number>> {
  const { rows } = await db.query<{ recipient: string; n: string }>(
    `SELECT recipient, count(*) AS n FROM deliveries
     WHERE recipient = ANY($1) AND created_at > now() - interval '1 hour'
       AND status <> 'suppressed'
     GROUP BY recipient`,
    [recipients],
  );
  return new Map(rows.map((r) => [r.recipient, Number(r.n)]));
}
