-- Explicit opt-in: existing connections remain list-only until reauthorized.
ALTER TABLE calendar_oauth_states ADD COLUMN access text NOT NULL DEFAULT 'list'
  CHECK (access IN ('list', 'sync'));
ALTER TABLE calendars ADD COLUMN access_role text NOT NULL DEFAULT 'reader'
  CHECK (access_role IN ('freeBusyReader', 'reader', 'writer', 'owner'));
ALTER TABLE calendars ADD COLUMN time_zone text;

-- A failed refresh must not make stale busy data look current.
ALTER TABLE calendars ADD COLUMN sync_error text
  CHECK (sync_error IN ('needs_reauth', 'permissions_missing', 'provider_unavailable'));

-- Snapshot the selected destination in the booking transaction, before any provider call.
-- A lost response or a changed profile must never send a retry to another calendar.
CREATE TABLE booking_calendar_targets (
  root_booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  PRIMARY KEY (root_booking_id,user_id)
);
CREATE INDEX booking_calendar_targets_calendar ON booking_calendar_targets(calendar_id);
