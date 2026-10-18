-- Existing0021 roots deliberately retain null snapshots: no historical identity guess.
ALTER TABLE event_types ADD COLUMN conference_organizer_user_id uuid;
ALTER TABLE booking_conferences
  ADD COLUMN invitation_organizer_name text,
  ADD COLUMN invitation_organizer_email text,
  ADD CONSTRAINT booking_conferences_invitation_identity CHECK (
    (invitation_organizer_name IS NULL AND invitation_organizer_email IS NULL) OR
    (invitation_organizer_name IS NOT NULL AND char_length(invitation_organizer_name) BETWEEN 1 AND 200
      AND invitation_organizer_name !~ '[[:cntrl:]]'
      AND invitation_organizer_email IS NOT NULL AND char_length(invitation_organizer_email) BETWEEN 3 AND 320
      AND invitation_organizer_email !~ '[[:space:][:cntrl:]]'));
ALTER TABLE booking_conferences DROP CONSTRAINT booking_conferences_error_code_check;
ALTER TABLE booking_conferences ADD CONSTRAINT booking_conferences_error_code_check CHECK
 (error_code IN ('disabled','calendar_unavailable','needs_reauth','permissions_missing','provider_unavailable','ambiguous_create','conference_failed','invalid_response','meeting_started','organizer_unavailable'));
CREATE FUNCTION immutable_conference_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.root_booking_id,NEW.organization_id,NEW.organizer_user_id,NEW.calendar_id,NEW.connection_id,
        NEW.invitation_organizer_name,NEW.invitation_organizer_email) IS DISTINCT FROM
    ROW(OLD.root_booking_id,OLD.organization_id,OLD.organizer_user_id,OLD.calendar_id,OLD.connection_id,
        OLD.invitation_organizer_name,OLD.invitation_organizer_email) THEN
   RAISE EXCEPTION 'Conference identity is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER conference_identity_immutable BEFORE UPDATE ON booking_conferences
 FOR EACH ROW EXECUTE FUNCTION immutable_conference_identity();
-- No user/calendar/connection FK: disconnect/deletion must retain unknown operation evidence.
CREATE TABLE booking_conference_mirrors (
 root_booking_id uuid NOT NULL REFERENCES booking_conferences(root_booking_id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 calendar_id uuid,
 connection_id uuid,
 operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
 applied_revision integer,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed','not_configured')),
 error_code text CHECK (error_code IN ('not_configured','unsupported_provider','calendar_unavailable','needs_reauth','permissions_missing','provider_unavailable','ambiguous_create','invalid_response','meeting_started','organizer_unavailable')),
 create_started boolean NOT NULL DEFAULT false,
 external_event_id text CHECK (external_event_id ~ '^[A-Za-z0-9_-]+$' AND octet_length(external_event_id)<=1024),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(root_booking_id,user_id),
 CHECK ((calendar_id IS NULL)=(connection_id IS NULL)),
 CHECK (state <> 'ready' OR (applied_revision IS NOT NULL AND applied_revision=revision)),
 CHECK (calendar_id IS NOT NULL OR state IN ('not_configured','failed'))
);
CREATE INDEX booking_conference_mirrors_due ON booking_conference_mirrors(next_attempt_at,root_booking_id) WHERE state='pending';
CREATE FUNCTION immutable_conference_mirror_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.root_booking_id,NEW.user_id,NEW.calendar_id,NEW.connection_id,NEW.operation_id) IS DISTINCT FROM
    ROW(OLD.root_booking_id,OLD.user_id,OLD.calendar_id,OLD.connection_id,OLD.operation_id) THEN
   RAISE EXCEPTION 'Conference mirror identity is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER conference_mirror_identity_immutable BEFORE UPDATE ON booking_conference_mirrors
 FOR EACH ROW EXECUTE FUNCTION immutable_conference_mirror_identity();
