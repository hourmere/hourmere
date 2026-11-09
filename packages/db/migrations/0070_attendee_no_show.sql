-- Attendance is private host metadata, independent for every guest and group seat.
-- Keep the actor UUID as an audit snapshot even if their account is later removed.
ALTER TABLE booking_attendees
  ADD COLUMN no_show_marked_at timestamptz,
  ADD COLUMN no_show_marked_by uuid,
  ADD CONSTRAINT booking_attendees_no_show_pair CHECK (
    (no_show_marked_at IS NULL) = (no_show_marked_by IS NULL)
  );

-- Only widened: previous application versions keep writing the five older events.
ALTER TABLE webhooks DROP CONSTRAINT webhooks_events_check;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_events_check CHECK (
  cardinality(events) BETWEEN 1 AND 6 AND
  events <@ ARRAY['booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired','booking.attendee_no_show_changed']::text[]
);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check CHECK (
  event_type IN ('booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired','booking.attendee_no_show_changed')
);
-- 0064's unique key (webhook_id, booking_id, event_type, request_id) is unchanged.
-- Attendance deliveries store their per-change event ID in request_id; see the .md notes.
