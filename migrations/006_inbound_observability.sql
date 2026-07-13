-- Observabilidad del poller e instante derivado sin perder la fecha cruda del GOIP.

ALTER TABLE inbound_messages
  ADD COLUMN device_received_at timestamptz;

CREATE TABLE service_health (
  component text PRIMARY KEY,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  detail jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO service_health (component) VALUES ('inbound_poller')
ON CONFLICT (component) DO NOTHING;
