-- Storage only: no routing execution or public surface is enabled by this migration.
CREATE TABLE routing_forms (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  slug text NOT NULL,
  created_by_user_id uuid NOT NULL,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_version_id uuid,
  last_version_number integer NOT NULL DEFAULT 0 CHECK (last_version_number >= 0),
  enabled boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id),
  CONSTRAINT routing_forms_enabled_shape CHECK (
    NOT enabled OR (published_version_id IS NOT NULL AND archived_at IS NULL)
  )
);
CREATE INDEX routing_forms_organization_created ON routing_forms (organization_id, created_at, id);

CREATE TABLE routing_form_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  form_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  fallback jsonb NOT NULL CHECK (jsonb_typeof(fallback) = 'object'),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid NOT NULL,
  UNIQUE (form_id, version_number),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, form_id, id),
  FOREIGN KEY (organization_id, form_id)
    REFERENCES routing_forms (organization_id, id) ON DELETE CASCADE
);
ALTER TABLE routing_forms ADD CONSTRAINT routing_forms_published_version_fk
  FOREIGN KEY (organization_id, id, published_version_id)
  REFERENCES routing_form_versions (organization_id, form_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE routing_target_dependencies (
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  version_id uuid NOT NULL,
  rule_id text NOT NULL CHECK (rule_id = 'fallback' OR rule_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- Historical UUID: deleting the target must not destroy immutable routing history.
  event_type_id uuid NOT NULL,
  health_code text NOT NULL DEFAULT 'unknown',
  health_checked_at timestamptz,
  PRIMARY KEY (version_id, rule_id),
  FOREIGN KEY (organization_id, version_id)
    REFERENCES routing_form_versions (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX routing_target_dependencies_event ON routing_target_dependencies (organization_id, event_type_id);

CREATE TABLE routing_receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  form_id uuid NOT NULL,
  version_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  answers_ciphertext bytea,
  matched_rule_id text NOT NULL CHECK (matched_rule_id = 'fallback' OR matched_rule_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  resolved_rule_id text NOT NULL CHECK (resolved_rule_id = 'fallback' OR resolved_rule_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  resolved_target jsonb NOT NULL CHECK (jsonb_typeof(resolved_target) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_booking_id uuid,
  CONSTRAINT routing_receipts_expiry CHECK (expires_at > created_at),
  CONSTRAINT routing_receipts_consumed_shape CHECK (
    consumed_booking_id IS NULL OR answers_ciphertext IS NULL
  ),
  -- NO ACTION preserves referenced versions, including consumed replay evidence.
  FOREIGN KEY (organization_id, form_id, version_id)
    REFERENCES routing_form_versions (organization_id, form_id, id),
  FOREIGN KEY (consumed_booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX routing_receipts_expiry ON routing_receipts (expires_at, id)
  WHERE consumed_booking_id IS NULL;
CREATE INDEX routing_receipts_form_admission ON routing_receipts (organization_id, form_id, expires_at)
  WHERE consumed_booking_id IS NULL;
CREATE INDEX routing_receipts_booking ON routing_receipts (consumed_booking_id);
CREATE INDEX routing_receipts_version ON routing_receipts (organization_id, form_id, version_id);

CREATE TABLE booking_routing (
  booking_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- Snapshot attribution deliberately survives physical form/version cleanup.
  form_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  matched_rule_id text NOT NULL CHECK (matched_rule_id = 'fallback' OR matched_rule_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  resolved_rule_id text NOT NULL CHECK (resolved_rule_id = 'fallback' OR resolved_rule_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  FOREIGN KEY (booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX booking_routing_organization ON booking_routing (organization_id, booking_id);
CREATE INDEX booking_routing_version ON booking_routing (form_id, version_id);

CREATE FUNCTION guard_routing_form() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.created_by_user_id, OLD.created_at) THEN
      RAISE EXCEPTION 'routing form ownership and identity are immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_forms_identity_immutable';
    END IF;
    IF NEW.last_version_number < OLD.last_version_number THEN
      RAISE EXCEPTION 'routing version sequence cannot decrease'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_forms_version_sequence';
    END IF;
  ELSE
    -- A real parent-row write serializes concurrent inserts, including at repeatable
    -- read (where a stale transaction must retry). Count archived forms as well.
    UPDATE auth.organization SET id = id WHERE id = NEW.organization_id;
    IF (SELECT count(*) FROM public.routing_forms WHERE organization_id = NEW.organization_id) >= 100 THEN
      RAISE EXCEPTION 'routing form quota exceeded'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_forms_quota';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routing_forms_guard BEFORE INSERT OR UPDATE ON routing_forms
  FOR EACH ROW EXECUTE FUNCTION guard_routing_form();
CREATE TRIGGER routing_forms_updated_at BEFORE UPDATE ON routing_forms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION guard_routing_form_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'published routing versions are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_form_versions_immutable';
  END IF;
  -- Services take organization/event locks before this form write. Old unreferenced
  -- versions may be deleted; the pointer and receipt FKs protect retained history.
  UPDATE public.routing_forms SET last_version_number = NEW.version_number
    WHERE organization_id = NEW.organization_id AND id = NEW.form_id
      AND last_version_number < NEW.version_number;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM public.routing_forms
      WHERE organization_id = NEW.organization_id AND id = NEW.form_id) THEN
    RAISE EXCEPTION 'routing version numbers must increase'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_form_versions_sequence';
  END IF;
  IF (SELECT count(*) FROM public.routing_form_versions
      WHERE organization_id = NEW.organization_id AND form_id = NEW.form_id) >= 1000 THEN
    RAISE EXCEPTION 'routing version quota exceeded'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_form_versions_quota';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routing_form_versions_guard BEFORE INSERT OR UPDATE ON routing_form_versions
  FOR EACH ROW EXECUTE FUNCTION guard_routing_form_version();

CREATE FUNCTION guard_booking_routing() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'booking routing snapshots are immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_routing_immutable';
END $$;
CREATE TRIGGER booking_routing_guard BEFORE UPDATE ON booking_routing
  FOR EACH ROW EXECUTE FUNCTION guard_booking_routing();

CREATE FUNCTION guard_routing_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.form_id, NEW.version_id, NEW.token_hash,
         NEW.matched_rule_id, NEW.resolved_rule_id, NEW.resolved_target, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.form_id, OLD.version_id, OLD.token_hash,
         OLD.matched_rule_id, OLD.resolved_rule_id, OLD.resolved_target, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'routing receipt issuance is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_receipts_issuance_immutable';
  END IF;
  IF OLD.answers_ciphertext IS NULL AND NEW.answers_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'purged routing answers cannot be restored'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_receipts_answers_purged';
  END IF;
  IF NEW.answers_ciphertext IS NOT NULL AND NEW.answers_ciphertext IS DISTINCT FROM OLD.answers_ciphertext THEN
    RAISE EXCEPTION 'routing receipt answers cannot be replaced'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_receipts_answers_immutable';
  END IF;
  IF OLD.consumed_booking_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'consumed routing receipt evidence is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_receipts_consumed_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routing_receipts_guard BEFORE UPDATE ON routing_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_routing_receipt();
