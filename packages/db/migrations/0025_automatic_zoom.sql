-- Explicit Zoom grants. Published0022 identity rows/ciphertext/timestamps stay unchanged.
-- Old unfinished v1 states lack authenticated mode/expected-connection bindings. Retain
-- them verbatim, but only new binding_version=2 attempts may redeem a provider code.
ALTER TABLE conference_connections ADD COLUMN mode text NOT NULL DEFAULT 'identity'
  CHECK (mode IN ('identity','meetings'));
ALTER TABLE conference_oauth_states ADD COLUMN mode text NOT NULL DEFAULT 'identity'
  CHECK (mode IN ('identity','meetings'));
ALTER TABLE conference_oauth_states ADD COLUMN binding_version integer NOT NULL DEFAULT 1
  CHECK (binding_version IN (1,2));
-- Locate only the two original scope constraints by their exact expression, retaining
-- every unrelated status, owner, token, tombstone and session cleanup safeguard.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'conference_connections'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) IN (
        'CHECK (((status <> ''active''::text) OR (scopes = ARRAY[''user:read:user''::text])))',
        'CHECK (((scopes = ''{}''::text[]) OR (scopes = ARRAY[''user:read:user''::text])))'
      ) LOOP
    EXECUTE format('ALTER TABLE conference_connections DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE conference_connections ADD CONSTRAINT conference_connection_mode_scopes CHECK (
  scopes = '{}'::text[] OR
  (mode = 'identity' AND scopes = ARRAY['user:read:user']::text[]) OR
  (mode = 'meetings' AND scopes = ARRAY['user:read:user','meeting:write:meeting',
    'meeting:read:meeting','meeting:update:meeting','meeting:delete:meeting']::text[])
);
ALTER TABLE conference_connections ADD CONSTRAINT conference_connection_active_scopes
  CHECK (status <> 'active' OR cardinality(scopes) > 0);
ALTER TABLE conference_connections DROP CONSTRAINT conference_connections_last_error_check;
ALTER TABLE conference_connections ADD CONSTRAINT conference_connections_last_error_check
  CHECK (last_error IN ('provider_unavailable','needs_reauth','permissions_missing',
    'identity_mismatch','credentials_unavailable','mode_conflict'));

-- Provider pins are independent of calendar credentials. Old roots retain Google defaults;
-- no identity/email/history is fabricated and no old row is updated.
ALTER TABLE event_types ADD COLUMN zoom_connection_id uuid;
ALTER TABLE booking_conferences
  ADD COLUMN provider text NOT NULL DEFAULT 'google_meet' CHECK(provider IN ('google_meet','zoom')),
  ADD COLUMN zoom_connection_id uuid,
  ADD COLUMN zoom_user_id text,
  ADD COLUMN zoom_meeting_id text CHECK(zoom_meeting_id ~ '^[1-9][0-9]{0,14}$'),
  ADD CONSTRAINT booking_conference_provider_pins CHECK (
    (provider='google_meet' AND zoom_connection_id IS NULL AND zoom_user_id IS NULL AND zoom_meeting_id IS NULL) OR
    (provider='zoom' AND zoom_connection_id IS NOT NULL AND zoom_user_id IS NOT NULL AND zoom_user_id ~ '^[A-Za-z0-9_-]{1,128}$'
      AND calendar_id IS NULL AND connection_id IS NULL AND external_event_id IS NULL)
  );
CREATE OR REPLACE FUNCTION immutable_conference_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.root_booking_id,NEW.organization_id,NEW.organizer_user_id,NEW.calendar_id,NEW.connection_id,
        NEW.invitation_organizer_name,NEW.invitation_organizer_email,NEW.provider,NEW.zoom_connection_id,NEW.zoom_user_id) IS DISTINCT FROM
    ROW(OLD.root_booking_id,OLD.organization_id,OLD.organizer_user_id,OLD.calendar_id,OLD.connection_id,
        OLD.invitation_organizer_name,OLD.invitation_organizer_email,OLD.provider,OLD.zoom_connection_id,OLD.zoom_user_id) THEN
   RAISE EXCEPTION 'Conference identity is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW; END $$;
