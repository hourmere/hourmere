-- A suppressed notification is a durable terminal receipt, just like a sent or
-- permanently rejected email. No manage-link capability is issued for it.
ALTER TABLE booking_notifications
  DROP CONSTRAINT booking_notifications_outcome_check,
  ADD CONSTRAINT booking_notifications_outcome_check
    CHECK (outcome IN ('sent', 'rejected', 'suppressed')),
  ADD COLUMN suppression_reason text,
  ADD CONSTRAINT booking_notifications_suppression_check CHECK (
    (outcome = 'suppressed' AND suppression_reason IS NOT NULL AND suppression_reason IN
      ('recipient_hourly_limit', 'recipient_daily_limit', 'instance_hourly_limit'))
    OR (outcome <> 'suppressed' AND suppression_reason IS NULL)
  );

-- Only delivery accounting needed for rolling limits. Invitee/guest addresses are
-- normalized and SHA-256 hashed; host rows need only the timestamp. No booking FK:
-- deleting a booking must not reset the recipient's or instance's mail budget.
-- Rows older than two days are removed by notification-email-cleanup.
CREATE TABLE notification_email_sends (
  recipient_hash bytea CHECK (recipient_hash IS NULL OR octet_length(recipient_hash) = 32),
  sent_at timestamptz NOT NULL
);
CREATE INDEX notification_email_sends_recipient_time
  ON notification_email_sends (recipient_hash, sent_at);
CREATE INDEX notification_email_sends_time ON notification_email_sends (sent_at);

-- Preserve the rolling budget on upgrade wherever retained receipts still exist.
-- A deleted attendee has no recoverable address, but its receipt still counts globally.
INSERT INTO notification_email_sends (recipient_hash, sent_at)
SELECT CASE WHEN a.email IS NOT NULL
         THEN sha256(convert_to(lower(btrim(a.email)), 'UTF8')) END,
       n.created_at
  FROM booking_notifications n
  LEFT JOIN booking_attendees a ON n.recipient = 'attendee:' || a.id::text
 WHERE n.outcome = 'sent' AND n.created_at >= now() - interval '2 days';
