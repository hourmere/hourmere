-- Preserve historical delivery/budget data; obsolete notices are distinguished only
-- when a worker observes them after this upgrade.
ALTER TABLE booking_conference_notifications
  ADD COLUMN skipped_at timestamptz,
  ADD CONSTRAINT conference_notification_skipped_terminal CHECK (
    skipped_at IS NULL OR (NOT delivered AND exhausted_at IS NULL AND lease_id IS NULL)
  );

DROP INDEX booking_conference_notifications_due;
CREATE INDEX booking_conference_notifications_due
  ON booking_conference_notifications(due_at,booking_id)
  WHERE NOT delivered AND skipped_at IS NULL AND exhausted_at IS NULL AND attempts < 13;
