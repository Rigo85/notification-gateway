import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import type { Settings } from './settings.js';

export const ESTIMATED_SMS_SECONDS = 15;

export interface QueueMetrics {
  pendingTotal: number;
  ready: number;
  oldestPendingS: number;
  oldestReadyS: number;
  estimatedDrainS: number;
}

export type QueueState = 'ok' | 'warning' | 'critical_only' | 'full';

export function getQueueState(metrics: QueueMetrics, settings: Settings): QueueState {
  const absoluteLimit = settings.queue_normal_limit + settings.queue_critical_reserve;
  if (metrics.pendingTotal >= absoluteLimit) return 'full';
  if (metrics.pendingTotal >= settings.queue_normal_limit ||
      metrics.oldestReadyS >= settings.queue_hard_oldest_s) return 'critical_only';
  if (metrics.pendingTotal >= settings.queue_warning_depth ||
      metrics.oldestReadyS >= settings.queue_warning_oldest_s) return 'warning';
  return 'ok';
}

export async function getQueueMetrics(db: Db | PoolClient, channel = 'sms'): Promise<QueueMetrics> {
  const { rows } = await db.query<{
    pending: string;
    ready: string;
    oldest_pending_s: string | null;
    oldest_ready_s: string | null;
  }>(
    `SELECT
       count(*) AS pending,
       count(*) FILTER (WHERE status IN ('queued', 'processing') OR next_retry_at <= now()) AS ready,
       extract(epoch FROM now() - min(created_at))::int::text AS oldest_pending_s,
       extract(epoch FROM now() - min(created_at) FILTER (
         WHERE status IN ('queued', 'processing') OR next_retry_at <= now()
       ))::int::text AS oldest_ready_s
     FROM deliveries
     WHERE channel = $1 AND status IN ('queued', 'retrying', 'processing', 'uncertain')`,
    [channel],
  );
  const row = rows[0];
  const pendingTotal = Number(row?.pending ?? 0);
  return {
    pendingTotal,
    ready: Number(row?.ready ?? 0),
    oldestPendingS: Number(row?.oldest_pending_s ?? 0),
    oldestReadyS: Number(row?.oldest_ready_s ?? 0),
    estimatedDrainS: pendingTotal * ESTIMATED_SMS_SECONDS,
  };
}
