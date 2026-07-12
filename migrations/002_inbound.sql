-- SMS entrantes ingeridos del inbox del GOIP por polling (goip-validacion §3.3).
-- No se borra nada del equipo: la deduplicación es por hash del contenido.

CREATE TABLE inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'sms',
  sender text NOT NULL,
  body text NOT NULL,
  -- hora que reporta el equipo (sin año: "MM-DD HH:MM:SS"); referencial
  device_time text,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- fase 5: marcado cuando el mensaje se interprete como comando
  parsed_as_command boolean NOT NULL DEFAULT false,
  dedup_hash text NOT NULL UNIQUE
);

CREATE INDEX idx_inbound_received ON inbound_messages (received_at DESC);

INSERT INTO settings (key, value) VALUES ('inbound_poll_ms', '10000')
ON CONFLICT (key) DO NOTHING;
