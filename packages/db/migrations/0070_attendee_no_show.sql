-- Attendance is private host metadata, independent for every guest and group seat.
-- Keep the actor UUID as an audit snapshot even if their account is later removed.
ALTER TABLE booking_attendees
  ADD COLUMN no_show_marked_at timestamptz,
  ADD COLUMN no_show_marked_by uuid,
  ADD CONSTRAINT booking_attendees_no_show_pair CHECK (
    (no_show_marked_at IS NULL) = (no_show_marked_by IS NULL)
  );

ALTER TABLE webhooks DROP CONSTRAINT webhooks_events_check;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_events_check CHECK (
  cardinality(events) BETWEEN 1 AND 6 AND
  events <@ ARRAY['booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired','booking.attendee_no_show_changed']::text[]
);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check CHECK (
  event_type IN ('booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired','booking.attendee_no_show_changed')
);
-- Lifecycle and reschedule-request receipts keep 0064's key (request_id included, NULLs
-- equal); every attendance transition is its own receipt, so it is outside the index.
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_webhook_id_booking_id_event_type_request_key;
CREATE UNIQUE INDEX webhook_deliveries_booking_lifecycle
  ON webhook_deliveries(webhook_id, booking_id, event_type, request_id) NULLS NOT DISTINCT
  WHERE event_type <> 'booking.attendee_no_show_changed';
