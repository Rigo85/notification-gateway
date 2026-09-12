-- Limita el bloqueo del canal por resultados que el GOIP ya no permite confirmar.

ALTER TABLE deliveries
  ADD COLUMN first_uncertain_at timestamptz,
  ADD COLUMN first_uncertain_error text,
  ADD COLUMN first_uncertain_response jsonb,
  ADD COLUMN reconcile_count integer NOT NULL DEFAULT 0;

UPDATE deliveries
SET first_uncertain_at = COALESCE(submitted_at, send_started_at, first_attempt_at, created_at),
    first_uncertain_error = last_error,
    first_uncertain_response = provider_response
WHERE status = 'uncertain';

-- La versión anterior dejaba estos casos fuera del worker y de la cola sin un
-- estado terminal. Se conserva el registro para resolución manual.
UPDATE deliveries
SET status = 'unresolved', finished_at = COALESCE(finished_at, now()),
    last_error = COALESCE(last_error, 'segundo resultado incierto sin smskey; resultado final desconocido')
WHERE status = 'uncertain' AND provider_id IS NULL AND attempts >= 2;

INSERT INTO settings (key, value) VALUES
  ('uncertain_max_block_s', '300')
ON CONFLICT (key) DO NOTHING;

INSERT INTO service_health (component, detail)
VALUES ('sms_worker', '{"state":"starting"}')
ON CONFLICT (component) DO NOTHING;
