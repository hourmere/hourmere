-- Old rows have unknown delivery history. Preserve their due_at/delivered values and
-- grant one finite post-upgrade budget; never invent earlier attempts or sent receipts.
ALTER TABLE booking_conference_notifications
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 13),
  ADD COLUMN lease_id uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN last_error text CHECK (last_error IN ('recipient_retry','delivery_failed','interrupted','attempt_expired')),
  ADD COLUMN exhausted_at timestamptz,
  ADD CONSTRAINT conference_notification_lease_pair CHECK ((lease_id IS NULL) = (lease_until IS NULL));

DROP INDEX booking_conference_notifications_due;
CREATE INDEX booking_conference_notifications_due
  ON booking_conference_notifications(due_at,booking_id)
  WHERE NOT delivered AND exhausted_at IS NULL AND attempts < 13;
