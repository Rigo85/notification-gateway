-- Marca el límite previo a invocar el provider para recuperar crashes sin duplicar SMS.

ALTER TABLE deliveries
  ADD COLUMN send_started_at timestamptz;
