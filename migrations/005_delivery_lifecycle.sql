-- Ciclo de vida seguro ante respuestas inciertas y caidas del GOIP.

ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_status_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'retrying',
                    'failed', 'exhausted', 'suppressed', 'cancelled',
                    'uncertain', 'expired'));

ALTER TABLE deliveries
  ADD COLUMN first_attempt_at timestamptz,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN last_reconciled_at timestamptz;

CREATE INDEX idx_deliveries_uncertain
  ON deliveries (channel, status, next_retry_at)
  WHERE status = 'uncertain';

INSERT INTO settings (key, value) VALUES
  ('retry_window_s',       '3600'),
  ('unavailable_retry_s',  '30'),
  ('uncertain_poll_s',     '10')
ON CONFLICT (key) DO NOTHING;
