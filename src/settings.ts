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
  retry_window_s: number;
  unavailable_retry_s: number;
  uncertain_poll_s: number;
  uncertain_without_smskey_retry_s: number;
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
  retry_window_s: 3600,
  unavailable_retry_s: 30,
  uncertain_poll_s: 10,
  uncertain_without_smskey_retry_s: 60,
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
  const validationError = validateSettings(merged as unknown as Record<string, unknown>);
  if (validationError) throw new Error(`Configuración inválida en PostgreSQL: ${validationError}`);
  cache = { value: merged, at: Date.now() };
  return merged;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export function validateSettings(settings: Record<string, unknown>): string | null {
  const ranges: Record<string, [number, number]> = {
    send_gap_ms: [1_000, 60_000],
    poll_ms: [250, 60_000],
    max_attempts: [1, 10],
    dedup_window_s: [0, 604_800],
    global_hourly_warning: [1, 1_000_000],
    global_hourly_limit: [1, 1_000_000],
    recipient_hourly_warning: [1, 1_000_000],
    per_recipient_hourly_limit: [1, 1_000_000],
    critical_hourly_reserve: [0, 1_000_000],
    queue_warning_depth: [1, 1_000_000],
    queue_normal_limit: [1, 1_000_000],
    queue_critical_reserve: [0, 1_000_000],
    queue_warning_oldest_s: [1, 604_800],
    queue_hard_oldest_s: [1, 604_800],
    retry_window_s: [60, 604_800],
    unavailable_retry_s: [1, 3_600],
    uncertain_poll_s: [1, 300],
    uncertain_without_smskey_retry_s: [10, 3_600],
    inbound_poll_ms: [1_000, 300_000],
  };
  for (const [name, [minimum, maximum]] of Object.entries(ranges)) {
    const value = settings[name];
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
      return `${name} debe ser un entero entre ${minimum} y ${maximum}`;
    }
  }

  const backoff = settings.retry_backoff_s;
  if (!Array.isArray(backoff) || backoff.length === 0 || backoff.length > 10 ||
      backoff.some((value) => !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 86_400)) {
    return 'retry_backoff_s debe ser un arreglo de 1 a 10 enteros entre 1 y 86400';
  }
  if (backoff.length < Number(settings.max_attempts) - 1) {
    return 'retry_backoff_s debe cubrir todos los reintentos de max_attempts';
  }

  const globalLimit = Number(settings.global_hourly_limit);
  const reserve = Number(settings.critical_hourly_reserve);
  if (reserve >= globalLimit) return 'La reserva crítica debe ser menor que el corte global';
  if (Number(settings.global_hourly_warning) > globalLimit - reserve) {
    return 'El aviso global no puede superar la capacidad normal (corte global menos reserva crítica)';
  }
  if (Number(settings.recipient_hourly_warning) > Number(settings.per_recipient_hourly_limit)) {
    return 'El aviso por destinatario no puede superar su corte';
  }
  if (Number(settings.queue_warning_depth) > Number(settings.queue_normal_limit)) {
    return 'El aviso de profundidad no puede superar el límite normal de cola';
  }
  if (Number(settings.queue_warning_oldest_s) > Number(settings.queue_hard_oldest_s)) {
    return 'El aviso de antigüedad no puede superar su corte';
  }
  return null;
}
