SET LOCAL lock_timeout = '5s';

ALTER TABLE webhook_deliveries ADD COLUMN workflow_run_id uuid;

-- Build the replacement before removing 0064's arbiter. The migration runner wraps
-- this file in a transaction, so CREATE INDEX CONCURRENTLY cannot be used here.
CREATE UNIQUE INDEX webhook_deliveries_identity_key ON webhook_deliveries
  (webhook_id, booking_id, event_type, request_id, workflow_run_id) NULLS NOT DISTINCT;

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_identity_key UNIQUE USING INDEX webhook_deliveries_identity_key,
  DROP CONSTRAINT webhook_deliveries_webhook_id_booking_id_event_type_request_key,
  DROP CONSTRAINT webhook_deliveries_event_type_check,
  ADD CONSTRAINT webhook_deliveries_event_type_check CHECK (
    event_type IN ('booking.created', 'booking.rescheduled', 'booking.cancelled',
      'booking.reschedule_requested', 'booking.reschedule_request_expired',
      'booking.attendee_no_show_changed', 'workflow.executed')
  ),
  ADD CONSTRAINT webhook_deliveries_workflow_run_kind CHECK (
    (event_type = 'workflow.executed') = (workflow_run_id IS NOT NULL)
  ),
  ADD CONSTRAINT webhook_deliveries_workflow_run_request_exclusive CHECK (
    workflow_run_id IS NULL OR request_id IS NULL
  );
