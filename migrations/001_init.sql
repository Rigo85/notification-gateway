-- Esquema inicial del notification-gateway.
-- La tabla deliveries ES la cola (FOR UPDATE SKIP LOCKED); ver propuesta D1.

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  channel text NOT NULL DEFAULT 'sms',
  message text NOT NULL,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  dedup_key text,
  suppressed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_dedup
  ON notifications (dedup_key, source, created_at DESC)
  WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_notifications_created ON notifications (created_at DESC);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications (id),
  channel text NOT NULL,
  recipient text NOT NULL,
  -- texto que realmente se envía; un mensaje largo se divide en varias deliveries
  payload text NOT NULL,
  part integer NOT NULL DEFAULT 1,
  parts integer NOT NULL DEFAULT 1,
  -- prioridad desnormalizada como entero para el ORDER BY del claim
  priority integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'retrying',
                      'failed', 'exhausted', 'suppressed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  provider_id text,
  provider_response jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX idx_deliveries_queue ON deliveries (channel, status, next_retry_at);
CREATE INDEX idx_deliveries_notification ON deliveries (notification_id);
CREATE INDEX idx_deliveries_recipient_time ON deliveries (recipient, created_at);
CREATE INDEX idx_deliveries_created ON deliveries (created_at);

CREATE TABLE api_keys (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  key_hash text NOT NULL UNIQUE,
  channels_allowed text[] NOT NULL DEFAULT '{sms}',
  rate_limit_per_hour integer NOT NULL DEFAULT 20,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('send_gap_ms',               '3000'),
  ('poll_ms',                   '2000'),
  ('max_attempts',              '3'),
  ('retry_backoff_s',           '[30, 120, 600]'),
  ('dedup_window_s',            '900'),
  ('global_hourly_limit',       '30'),
  ('per_recipient_hourly_limit','10');
