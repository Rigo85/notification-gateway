-- Ingreso auditable y límites de dos niveles.

ALTER TABLE api_keys
  ALTER COLUMN rate_limit_per_hour SET DEFAULT 120;

ALTER TABLE api_keys
  ADD COLUMN warning_limit_per_hour integer NOT NULL DEFAULT 60;

-- 20 era el default anterior y 30 el valor operativo verificado antes del cambio.
UPDATE api_keys
SET rate_limit_per_hour = 120
WHERE rate_limit_per_hour IN (20, 30);

-- Conservar otros cortes personalizados sin dejar un aviso por encima del corte.
UPDATE api_keys
SET warning_limit_per_hour = LEAST(warning_limit_per_hour, rate_limit_per_hour);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_rate_limits_valid
  CHECK (warning_limit_per_hour > 0 AND
         rate_limit_per_hour > 0 AND
         warning_limit_per_hour <= rate_limit_per_hour);

CREATE TABLE notification_requests (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  api_key_id integer REFERENCES api_keys (id) ON DELETE SET NULL,
  notification_id uuid REFERENCES notifications (id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'received'
    CHECK (outcome IN ('received', 'created', 'dedup')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_requests_source_time
  ON notification_requests (source, created_at DESC);

CREATE TABLE rate_limit_events (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('api_key', 'global', 'recipient')),
  scope_key text NOT NULL,
  level text NOT NULL CHECK (level IN ('warning', 'hard')),
  observed_count integer NOT NULL,
  projected_count integer NOT NULL,
  limit_value integer NOT NULL,
  alert_deliveries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rate_limit_events_scope_time
  ON rate_limit_events (scope, scope_key, level, created_at DESC);

INSERT INTO settings (key, value) VALUES
  ('global_hourly_warning',        '120'),
  ('recipient_hourly_warning',     '60'),
  ('critical_hourly_reserve',      '20')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

UPDATE settings SET value = '240', updated_at = now()
WHERE key = 'global_hourly_limit';

UPDATE settings SET value = '120', updated_at = now()
WHERE key = 'per_recipient_hourly_limit';
