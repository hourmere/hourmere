-- Import namespaces are random, persistent identities for real source instances.
-- They are not derived from a connection string and are never execution credentials.
CREATE TABLE import_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 120),
  created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_sources_creator ON import_sources(created_by_user_id);

CREATE TABLE import_items (
  source_id uuid NOT NULL REFERENCES import_sources(id) ON DELETE RESTRICT,
  entity_kind text NOT NULL CHECK (entity_kind IN ('user','profile','schedule','event_type','booking')),
  -- Both supported source schemas use integer IDs. Restrict retained source identity
  -- to opaque primary keys, rather than accepting emails or other personal data.
  source_primary_key text NOT NULL CHECK (source_primary_key ~ '^[0-9]{1,20}$'),
  -- Per-owner atomic batches share a namespace without mixing their mappings.
  source_user_primary_key text CHECK (source_user_primary_key ~ '^[0-9]{1,20}$'),
  target_id uuid,
  source_fingerprint text CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  target_fingerprint text CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
  policy text CHECK (length(policy) BETWEEN 1 AND 80),
  contract_version integer NOT NULL CHECK (contract_version = 1),
  imported_at timestamptz NOT NULL DEFAULT now(),
  -- Stable source event/field/option -> target question/option IDs. Never rebuilt
  -- on a rerun, and cleared when its target is erased.
  question_crosswalk jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(question_crosswalk) = 'object'),
  deleted_at timestamptz,
  PRIMARY KEY (source_id,entity_kind,source_primary_key),
  CONSTRAINT import_items_live_or_tombstone CHECK (
    (deleted_at IS NULL AND target_id IS NOT NULL AND source_fingerprint IS NOT NULL
      AND target_fingerprint IS NOT NULL AND policy IS NOT NULL)
    OR (deleted_at IS NOT NULL AND target_id IS NULL AND source_fingerprint IS NULL
      AND target_fingerprint IS NULL AND policy IS NULL AND question_crosswalk = '{}')
  )
);
-- Independently authorized sources may match the same existing verified user.
-- Created target entities have exactly one source attribution.
CREATE UNIQUE INDEX import_items_target ON import_items(entity_kind,target_id)
  WHERE entity_kind <> 'user' AND target_id IS NOT NULL;
CREATE INDEX import_items_source_user ON import_items(source_id,source_user_primary_key);

CREATE FUNCTION immutable_import_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.schema_fingerprint IS DISTINCT FROM OLD.schema_fingerprint
    OR NEW.source_version IS DISTINCT FROM OLD.source_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      AND NOT (NEW.created_by_user_id IS NULL AND OLD.created_by_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM auth."user" WHERE id = OLD.created_by_user_id))) THEN
    RAISE EXCEPTION 'import source identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'import_sources_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_sources_immutable BEFORE UPDATE ON import_sources
  FOR EACH ROW EXECUTE FUNCTION immutable_import_source();

CREATE FUNCTION check_import_target() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_target uuid;
BEGIN
  -- Polymorphic target references still take the same key-share lock as a foreign
  -- key. Deletion cannot race between this check and committing its attribution.
  CASE NEW.entity_kind
    WHEN 'user' THEN SELECT id INTO found_target FROM auth."user" WHERE id = NEW.target_id FOR KEY SHARE;
    WHEN 'profile' THEN SELECT user_id INTO found_target FROM public.profiles WHERE user_id = NEW.target_id FOR KEY SHARE;
    WHEN 'schedule' THEN SELECT id INTO found_target FROM public.schedules WHERE id = NEW.target_id FOR KEY SHARE;
    WHEN 'event_type' THEN SELECT id INTO found_target FROM public.event_types WHERE id = NEW.target_id AND deleted_at IS NULL FOR KEY SHARE;
    WHEN 'booking' THEN SELECT id INTO found_target FROM public.bookings WHERE id = NEW.target_id AND source = 'import' FOR KEY SHARE;
    ELSE RETURN NEW; -- The entity-kind CHECK reports unknown kinds.
  END CASE;
  IF found_target IS NULL THEN
    RAISE EXCEPTION 'import target does not exist'
      USING ERRCODE = '23503', CONSTRAINT = 'import_items_target_exists';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_items_target_exists BEFORE INSERT ON import_items
  FOR EACH ROW EXECUTE FUNCTION check_import_target();

CREATE FUNCTION immutable_import_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Target deletion may only retire a live mapping into its minimal tombstone.
  -- A tombstone can never be relinked, and attribution cannot be deleted to rerun.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
      AND NEW.source_id = OLD.source_id AND NEW.entity_kind = OLD.entity_kind
      AND NEW.source_primary_key = OLD.source_primary_key
      AND NEW.source_user_primary_key IS NOT DISTINCT FROM OLD.source_user_primary_key
      AND NEW.contract_version = OLD.contract_version AND NEW.imported_at = OLD.imported_at
      AND NEW.target_id IS NULL AND NEW.source_fingerprint IS NULL
      AND NEW.target_fingerprint IS NULL AND NEW.policy IS NULL
      AND NEW.question_crosswalk = '{}' THEN
      RETURN NEW;
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'import attribution is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'import_items_immutable';
END $$;
CREATE TRIGGER import_items_immutable BEFORE UPDATE OR DELETE ON import_items
  FOR EACH ROW EXECUTE FUNCTION immutable_import_item();

CREATE FUNCTION retire_import_target() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN RETURN NULL; END IF;
  END IF;
  IF TG_ARGV[0] = 'profile' THEN target := OLD.user_id; ELSE target := OLD.id; END IF;
  UPDATE public.import_items
    SET target_id = NULL, source_fingerprint = NULL, target_fingerprint = NULL,
      policy = NULL, question_crosswalk = '{}', deleted_at = clock_timestamp()
    WHERE entity_kind = TG_ARGV[0] AND target_id = target AND deleted_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER import_user_deleted AFTER DELETE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('user');
CREATE TRIGGER import_profile_deleted AFTER DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('profile');
CREATE TRIGGER import_schedule_deleted AFTER DELETE ON schedules
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('schedule');
CREATE TRIGGER import_event_type_deleted AFTER DELETE ON event_types
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('event_type');
CREATE TRIGGER import_event_type_soft_deleted AFTER UPDATE OF deleted_at ON event_types
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('event_type');
CREATE TRIGGER import_booking_deleted AFTER DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION retire_import_target('booking');

ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('web','embed','api','mcp','import'));
CREATE INDEX bookings_import_source ON bookings(id) WHERE source = 'import';
ALTER TABLE bookings ADD COLUMN import_questions jsonb;
ALTER TABLE bookings ADD CONSTRAINT bookings_import_questions CHECK (
  (source = 'import' AND import_questions IS NOT NULL AND jsonb_typeof(import_questions) = 'array')
  OR (source <> 'import' AND import_questions IS NULL)
);
ALTER TABLE bookings ADD CONSTRAINT bookings_import_local_only CHECK (
  source <> 'import' OR (manage_token_hash IS NULL AND status = 'confirmed')
);
CREATE FUNCTION immutable_import_booking_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source AND (OLD.source = 'import' OR NEW.source = 'import') THEN
    RAISE EXCEPTION 'import booking policy is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_import_source_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_import_source_immutable BEFORE UPDATE OF source ON bookings
  FOR EACH ROW EXECUTE FUNCTION immutable_import_booking_source();
