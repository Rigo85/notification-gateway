-- Resultado terminal cuya entrega no puede verificarse sin arriesgar un SMS duplicado.
ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_status_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'retrying',
                    'failed', 'exhausted', 'suppressed', 'cancelled',
                    'uncertain', 'expired', 'unresolved'));
