-- Interrupted attempts and lost/exhausted jobs must remain inspectable without
-- retaining external error text, payloads or destination credentials.
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_last_error_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_last_error_check
    CHECK (last_error IN (
        'transport_error', 'http_error', 'disabled', 'expired',
        'secret_unavailable', 'interrupted', 'job_missing'
    ));
