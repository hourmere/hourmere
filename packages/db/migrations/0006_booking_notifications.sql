-- Emails sent about bookings (docs/notifications.md). One row per email: a notification job
-- that runs again (retry, crash, duplicate) finds the row and does not send it twice, nor
-- try again an address the mail server refused for good. Invitee
-- emails carry a manage-link secret of their own, minted when the email is sent; only its
-- SHA-256 is kept here, so no raw secret is ever stored, in the job queue or anywhere else.

CREATE TABLE booking_notifications (
  -- Deferred: checked at commit. The worker keeps the row's transaction open while the mail
  -- server accepts the email (so a concurrent attempt waits instead of sending again); an
  -- immediate check would hold a key-share lock on the booking all that time and block a
  -- cancel or reschedule (FOR UPDATE) behind the mail server.
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('confirmed', 'rescheduled', 'cancelled', 'reminder')),
  -- 'host:<auth.user id>' or 'attendee:<booking_attendees id>': a person and their role, so
  -- someone who books their own event type still gets both emails.
  recipient text NOT NULL
    CHECK (recipient ~ '^(host|attendee):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- SHA-256 of the manage-link secret in this email (invitee emails only). It opens the
  -- booking like bookings.manage_token_hash does, for as long as the booking exists.
  manage_token_hash bytea UNIQUE,
  -- 'sent', or 'rejected': the mail server refused it for good (SMTP 5xx), so it is not
  -- tried again, and no secret went out with it.
  outcome text NOT NULL DEFAULT 'sent' CHECK (outcome IN ('sent', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, kind, recipient),
  CHECK (outcome = 'sent' OR manage_token_hash IS NULL)
);
