-- Shared resources belong to a slot generation, never to an attendee booking.
ALTER TABLE group_slots ADD COLUMN location_option jsonb;
ALTER TABLE group_slots DISABLE TRIGGER group_slots_updated_at;
UPDATE group_slots SET location_option = jsonb_build_object('id','legacy') || location
  WHERE location IS NOT NULL;
-- Drain deferred slot invariants before adding constraints/triggers to populated tables.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE group_slots ENABLE TRIGGER group_slots_updated_at;
ALTER TABLE group_slots ADD CONSTRAINT group_slots_location_option_valid
  CHECK (location_option IS NULL OR valid_location_option(location_option,false) IS TRUE);
CREATE FUNCTION guard_group_location_option() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='group_slots' THEN
    IF NEW.location_option IS DISTINCT FROM OLD.location_option THEN
      RAISE EXCEPTION 'group slot location option is immutable'
        USING ERRCODE='check_violation',CONSTRAINT='group_slot_location_option_immutable';
    END IF;
  ELSIF NEW.group_slot_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM group_slots s WHERE s.id=NEW.group_slot_id
      AND s.location_option IS NOT DISTINCT FROM NEW.location_option
  ) THEN
    RAISE EXCEPTION 'group seat must use the shared location option'
      USING ERRCODE='check_violation',CONSTRAINT='group_seat_location_option';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_slots_location_option_guard BEFORE UPDATE OF location_option ON group_slots
  FOR EACH ROW EXECUTE FUNCTION guard_group_location_option();
-- Alphabetical order follows bookings_location_option_defaults.
CREATE TRIGGER bookings_shared_location_option_guard BEFORE INSERT OR UPDATE OF location_option ON bookings
  FOR EACH ROW EXECUTE FUNCTION guard_group_location_option();
CREATE TABLE group_slot_calendar_events (
  group_slot_id uuid PRIMARY KEY REFERENCES group_slots(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  etag text,
  count_revision bigint NOT NULL CHECK (count_revision>0),
  UNIQUE(calendar_id,external_event_id)
);

-- Host policy is slot-owned; no first attendee booking is used as a receipt proxy.
ALTER TABLE group_slots ADD COLUMN ical_organizer_name text;
ALTER TABLE group_slots ADD COLUMN ical_organizer_email text;
CREATE TABLE group_slot_host_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_slot_id uuid NOT NULL REFERENCES group_slots(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('calendar','reminder','follow_up')),
  rule_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','skipped','suppressed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 13),
  next_attempt_at timestamptz NOT NULL,
  claim_token uuid,
  lease_until timestamptz,
  UNIQUE(group_slot_id,kind,rule_id)
);
CREATE INDEX group_slot_host_messages_due ON group_slot_host_messages(next_attempt_at,id)
  WHERE state IN ('pending','processing');
CREATE TABLE group_slot_host_mail_receipts (
  message_id uuid NOT NULL REFERENCES group_slot_host_messages(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('sent','suppressed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,revision)
);

-- Separate logistics state: count-only changes never reset readiness or invitation gates.
CREATE TABLE group_slot_conferences (
  group_slot_id uuid PRIMARY KEY REFERENCES group_slots(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  organizer_user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google_meet','zoom')),
  invitation_organizer_name text NOT NULL,
  invitation_organizer_email text NOT NULL,
  calendar_id uuid,
  connection_id uuid,
  zoom_connection_id uuid,
  zoom_user_id text,
  zoom_meeting_id text,
  join_url text,
  external_event_id text,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  conference_patch_request_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  applied_revision integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed')),
  error_code text,
  create_started boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 13),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (group_slot_id,organization_id) REFERENCES group_slots(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX group_slot_conferences_due ON group_slot_conferences(next_attempt_at,group_slot_id)
  WHERE state='pending';

-- Recipient context only: resource ownership remains the slot, never the first seat.
CREATE VIEW booking_notification_conference_context AS
  SELECT booking_id,organization_id,organizer_user_id,invitation_organizer_name,
    invitation_organizer_email,provider,calendar_id,state,revision,applied_revision,NULL::text AS join_url
  FROM booking_conferences
  UNION ALL
  SELECT b.id,c.organization_id,c.organizer_user_id,c.invitation_organizer_name,
    c.invitation_organizer_email,c.provider,c.calendar_id,c.state,c.revision,c.applied_revision,c.join_url
  FROM group_slot_conferences c JOIN bookings b ON b.group_slot_id=c.group_slot_id;
