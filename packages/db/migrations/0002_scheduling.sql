-- Scheduling domain. See docs/data-model.md for the reasoning behind each table.
--
-- Ownership: identity-level data belongs to a user (profiles, schedules, calendar
-- connections) and follows them across organizations; business data belongs to an
-- organization (event types, bookings). Every user also gets a personal organization,
-- so a solo user and a team use the same tables.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Calendar accounts a user connected (one row per external account) ----------------------
CREATE TABLE calendar_connections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft', 'caldav')),
  external_account_id text NOT NULL,
  account_email text,
  -- AES-256-GCM ciphertext (key from the environment) of the provider credentials:
  -- OAuth tokens, or CalDAV URL + password. Never stored in plain text.
  credentials bytea NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'revoked')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, external_account_id)
);
CREATE TRIGGER calendar_connections_updated_at BEFORE UPDATE ON calendar_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Individual calendars inside a connection --------------------------------------------------
CREATE TABLE calendars (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  connection_id uuid NOT NULL REFERENCES calendar_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  -- Whether events here make the user busy.
  check_conflicts boolean NOT NULL DEFAULT true,
  -- Provider sync cursor (Google syncToken / Graph deltaLink) and push channel + expiry.
  sync_state jsonb,
  last_synced_at timestamptz,
  UNIQUE (connection_id, external_id)
);

-- Busy intervals mirrored from calendars by incremental sync (recurring events expanded) ---
CREATE TABLE calendar_busy (
  calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  period tstzrange NOT NULL CHECK (NOT isempty(period)),
  PRIMARY KEY (calendar_id, external_event_id)
);
CREATE INDEX calendar_busy_calendar_period ON calendar_busy USING gist (calendar_id, period);

-- Public profile: the handle forms booking URLs (hourmere.com/{handle}/{event}) -----------
CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE
    CHECK (handle ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  time_zone text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  -- Where new bookings are written unless an event type says otherwise.
  destination_calendar_id uuid REFERENCES calendars (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Working hours ----------------------------------------------------------------------------
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  name text NOT NULL,
  time_zone text NOT NULL,
  -- ISO weekday ("1" = Monday … "7" = Sunday) → local wall-clock intervals, e.g.
  -- {"1": [{"start": "09:00", "end": "12:00"}, {"start": "13:00", "end": "17:00"}], "6": []}.
  -- Shape is validated by the application (it is the availability engine's input).
  weekly_hours jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX schedules_one_default_per_user ON schedules (user_id) WHERE is_default;
CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-date exceptions: [] = unavailable all day, otherwise replacement intervals.
CREATE TABLE schedule_overrides (
  schedule_id uuid NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  date date NOT NULL,
  intervals jsonb NOT NULL,
  PRIMARY KEY (schedule_id, date)
);

-- Event types ------------------------------------------------------------------------------
CREATE TABLE event_types (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- Set for a personal page (/{handle}/{slug}); NULL for a team page (/t/{org-slug}/{slug}).
  owner_user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  title text NOT NULL,
  description text,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  slot_step_minutes integer CHECK (slot_step_minutes > 0),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  minimum_notice_minutes integer NOT NULL DEFAULT 0 CHECK (minimum_notice_minutes >= 0),
  booking_window_days integer CHECK (booking_window_days > 0),
  max_bookings_per_day integer CHECK (max_bookings_per_day > 0),
  scheduling_type text NOT NULL DEFAULT 'individual'
    CHECK (scheduling_type IN ('individual', 'round_robin', 'collective')),
  -- {"kind": "google_meet"} | {"kind": "zoom"} | {"kind": "phone", "number": …}
  -- | {"kind": "in_person", "address": …} | {"kind": "link", "url": …}
  location jsonb,
  -- Extra booking-form fields beyond name and email.
  questions jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: past bookings keep pointing at the event type they were made with.
  deleted_at timestamptz
);
CREATE UNIQUE INDEX event_types_personal_slug ON event_types (owner_user_id, slug)
  WHERE owner_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX event_types_team_slug ON event_types (organization_id, slug)
  WHERE owner_user_id IS NULL AND deleted_at IS NULL;
CREATE INDEX event_types_organization ON event_types (organization_id);
CREATE TRIGGER event_types_updated_at BEFORE UPDATE ON event_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who hosts an event type. Individual event types have exactly one row; round-robin and
-- collective types have several, so team scheduling needs no schema change later.
CREATE TABLE event_type_hosts (
  event_type_id uuid NOT NULL REFERENCES event_types (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  -- NULL = the host's default schedule.
  schedule_id uuid REFERENCES schedules (id) ON DELETE SET NULL,
  -- NULL = the host's profile default.
  destination_calendar_id uuid REFERENCES calendars (id) ON DELETE SET NULL,
  -- Relative share for round-robin assignment.
  weight integer NOT NULL DEFAULT 100 CHECK (weight > 0),
  PRIMARY KEY (event_type_id, user_id)
);
CREATE INDEX event_type_hosts_user ON event_type_hosts (user_id);

-- Bookings ---------------------------------------------------------------------------------
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  event_type_id uuid REFERENCES event_types (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  title text NOT NULL,
  -- Resolved location, e.g. the generated Meet link.
  location jsonb,
  -- Answers to event_types.questions.
  responses jsonb NOT NULL DEFAULT '{}',
  -- SHA-256 of the secret in the invitee's reschedule/cancel links; the secret itself is
  -- only ever in the email.
  manage_token_hash bytea NOT NULL UNIQUE,
  rescheduled_from_id uuid REFERENCES bookings (id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  -- How the booking was made; 'api' and 'mcp' are agents.
  source text NOT NULL CHECK (source IN ('web', 'embed', 'api', 'mcp')),
  -- The API key (auth.apikey) an agent used, kept for the audit trail.
  api_key_id uuid,
  -- Lets an agent retry "create booking" safely: the same key returns the same booking.
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX bookings_idempotency ON bookings (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_organization_start ON bookings (organization_id, start_at);
CREATE INDEX bookings_event_type_start ON bookings (event_type_id, start_at);
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Hosts of a booking. The exclusion constraint makes double-booking impossible at the
-- database level, even when two invitees submit the same slot at the same moment.
-- period/active mirror the booking (kept in sync by the trigger below).
CREATE TABLE booking_hosts (
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  period tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (booking_id, user_id),
  CONSTRAINT booking_hosts_no_overlap EXCLUDE USING gist (user_id WITH =, period WITH &&)
    WHERE (active)
);

CREATE FUNCTION sync_booking_hosts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE booking_hosts
     SET period = tstzrange(NEW.start_at, NEW.end_at),
         active = (NEW.status = 'confirmed')
   WHERE booking_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER bookings_sync_hosts AFTER UPDATE OF start_at, end_at, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_booking_hosts();

-- People attending: the invitee who booked plus any guests they added.
CREATE TABLE booking_attendees (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  time_zone text NOT NULL,
  locale text,
  is_booker boolean NOT NULL DEFAULT false
);
CREATE INDEX booking_attendees_booking ON booking_attendees (booking_id);
CREATE UNIQUE INDEX booking_attendees_one_booker ON booking_attendees (booking_id) WHERE is_booker;

-- The event each booking created in a host's calendar, so updates and cancellations are
-- written to the same event (idempotent sync).
CREATE TABLE booking_calendar_events (
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  etag text,
  PRIMARY KEY (booking_id, calendar_id)
);
