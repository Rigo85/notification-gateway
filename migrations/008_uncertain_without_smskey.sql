-- Un resultado sin smskey no puede reconciliarse con el único slot del GOIP.
-- Se conserva como incierto, pero recibe un único reintento y no bloquea el canal después.

INSERT INTO settings (key, value) VALUES
  ('uncertain_without_smskey_retry_s', '60')
ON CONFLICT (key) DO NOTHING;
