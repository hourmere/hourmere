-- Explicit opt-in only: old provider labels never trigger provider requests.
ALTER TABLE calendars ADD COLUMN supports_google_meet boolean NOT NULL DEFAULT false;

-- These identities intentionally survive connection/calendar/user removal. A disconnected
-- provider must not erase an ambiguous create or silently transfer it to another account.
CREATE TABLE booking_conferences (
  root_booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  organizer_user_id uuid NOT NULL,
  calendar_id uuid,
  connection_id uuid,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  applied_revision integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed')),
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  create_started boolean NOT NULL DEFAULT false,
  retry_conference boolean NOT NULL DEFAULT false,
  external_event_id text CHECK (external_event_id ~ '^[A-Za-z0-9_-]+$' AND octet_length(external_event_id) <= 1024),
  error_code text CHECK (error_code IN ('disabled','calendar_unavailable','needs_reauth','permissions_missing','provider_unavailable','ambiguous_create','conference_failed','invalid_response','meeting_started')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'ready' OR (applied_revision IS NOT NULL AND applied_revision = revision))
);
CREATE INDEX booking_conferences_due ON booking_conferences(next_attempt_at,root_booking_id) WHERE state='pending';

-- Durable release, independent of a pre-rollout generic notification job's exclusive key.
CREATE TABLE booking_conference_notifications (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('confirmed','rescheduled','reminder','conference_failed')),
  due_at timestamptz NOT NULL DEFAULT now(),
  delivered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (booking_id,kind)
);
CREATE INDEX booking_conference_notifications_due ON booking_conference_notifications(due_at,booking_id) WHERE NOT delivered;
ALTER TABLE booking_notifications DROP CONSTRAINT booking_notifications_kind_check;
ALTER TABLE booking_notifications ADD CONSTRAINT booking_notifications_kind_check CHECK (kind IN ('confirmed','rescheduled','cancelled','reminder','conference_failed'));
