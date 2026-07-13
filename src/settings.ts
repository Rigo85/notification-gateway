import type { Db } from './db.js';

export interface Settings {
  send_gap_ms: number;
  poll_ms: number;
  max_attempts: number;
  retry_backoff_s: number[];
  dedup_window_s: number;
  global_hourly_warning: number;
  global_hourly_limit: number;
  recipient_hourly_warning: number;
  per_recipient_hourly_limit: number;
  critical_hourly_reserve: number;
  queue_warning_depth: number;
  queue_normal_limit: number;
  queue_critical_reserve: number;
  queue_warning_oldest_s: number;
  queue_hard_oldest_s: number;
  inbound_poll_ms: number;
}

export const SETTINGS_DEFAULTS: Settings = {
  send_gap_ms: 3000,
  poll_ms: 2000,
  max_attempts: 3,
  retry_backoff_s: [30, 120, 600],
  dedup_window_s: 900,
  global_hourly_warning: 120,
  global_hourly_limit: 240,
  recipient_hourly_warning: 60,
  per_recipient_hourly_limit: 120,
  critical_hourly_reserve: 20,
  queue_warning_depth: 20,
  queue_normal_limit: 60,
  queue_critical_reserve: 20,
  queue_warning_oldest_s: 300,
  queue_hard_oldest_s: 900,
  inbound_poll_ms: 10_000,
};

const CACHE_TTL_MS = 10_000;
let cache: { value: Settings; at: number } | null = null;

export async function getSettings(db: Db): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const merged: Settings = { ...SETTINGS_DEFAULTS };
  for (const row of rows) {
    if (row.key in merged) (merged as unknown as Record<string, unknown>)[row.key] = row.value;
  }
  cache = { value: merged, at: Date.now() };
  return merged;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
