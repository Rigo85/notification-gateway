-- Guarda de admisión basada en profundidad y antigüedad de la cola SMS.

ALTER TABLE rate_limit_events
  DROP CONSTRAINT rate_limit_events_scope_check;

ALTER TABLE rate_limit_events
  ADD CONSTRAINT rate_limit_events_scope_check
  CHECK (scope IN ('api_key', 'global', 'recipient', 'queue'));

INSERT INTO settings (key, value) VALUES
  ('queue_warning_depth',       '20'),
  ('queue_normal_limit',        '60'),
  ('queue_critical_reserve',    '20'),
  ('queue_warning_oldest_s',    '300'),
  ('queue_hard_oldest_s',       '900')
ON CONFLICT (key) DO NOTHING;
