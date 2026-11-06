-- A request overlays a confirmed booking; its existing host blocks remain authoritative.
CREATE TABLE booking_reschedule_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  note text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','replaced','picked','cancelled','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  UNIQUE (booking_id, idempotency_key),
  CHECK ((state = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX booking_reschedule_requests_pending ON booking_reschedule_requests(booking_id) WHERE state = 'pending';
CREATE INDEX booking_reschedule_requests_expiry ON booking_reschedule_requests(expires_at) WHERE state = 'pending';

ALTER TABLE booking_notifications
  DROP CONSTRAINT booking_notifications_kind_check,
  ADD CONSTRAINT booking_notifications_kind_check CHECK (kind IN ('confirmed','rescheduled','cancelled','reminder','conference_failed','follow_up','reschedule_requested','reschedule_request_expired')),
  DROP CONSTRAINT booking_notifications_message_key_check,
  ADD CONSTRAINT booking_notifications_message_key_check CHECK (
    message_key = '' OR (kind IN ('reminder','follow_up','reschedule_requested','reschedule_request_expired')
      AND message_key ~ '^[A-Za-z0-9_-]{1,64}$' AND message_key <> '__proto__')
  );
ALTER TABLE booking_reschedule_requests ADD COLUMN picked_booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE webhooks DROP CONSTRAINT webhooks_events_check;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_events_check CHECK (
  cardinality(events) BETWEEN 1 AND 5 AND events <@ ARRAY['booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired']::text[]
);
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check CHECK (event_type IN ('booking.created','booking.rescheduled','booking.cancelled','booking.reschedule_requested','booking.reschedule_request_expired'));
ALTER TABLE webhook_deliveries ADD COLUMN request_id uuid;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_webhook_id_booking_id_event_type_key;
ALTER TABLE webhook_deliveries ADD UNIQUE NULLS NOT DISTINCT (webhook_id, booking_id, event_type, request_id);
