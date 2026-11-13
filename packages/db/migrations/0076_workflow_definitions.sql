-- Booking workflow definitions and their immutable revisions (docs/workflows.md, step 2 of
-- the implementation plan). Storage only: no route, worker, read path or setting uses these
-- tables yet, and workflows stay hard-off behind WORKFLOWS_IMPLEMENTED = false.

-- A definition's identity and owner never change. A personal definition belongs to a user
-- in that user's personal organization; a team definition belongs to the team organization,
-- never to the member who created it. `revision` is the current revision, which is always
-- the latest one, and `enabled` is the live switch, which no revision carries. Deleting a
-- definition tombstones it (`deleted_at`): a tombstone is disabled, final and takes no new
-- revision. The row itself goes only with its organization, its personal owner or a later
-- purge of the tombstone, and its revisions go with it.
CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workflow_definitions_organization_id_id UNIQUE (organization_id, id),
  CONSTRAINT workflow_definitions_deleted_disabled CHECK (deleted_at IS NULL OR NOT enabled)
);
CREATE INDEX workflow_definitions_owner_user_id ON workflow_definitions (owner_user_id);

-- One immutable revision per change of a definition, numbered 1, 2, 3… within it. It stores
-- the definition the contract in packages/workflows validated (its canonical output without
-- `enabled`). These checks mirror the contract's envelope and limits, and a test binds each
-- one to the contract; the service validates everything else before it writes.
CREATE TABLE workflow_revisions (
  organization_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workflow_id, revision),
  CONSTRAINT workflow_revisions_workflow FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_revisions_shape CHECK ((
    CASE WHEN jsonb_typeof(definition) = 'object' THEN
      definition ?& ARRAY['name', 'scope', 'trigger', 'conditions', 'actions']
      AND definition - ARRAY['name', 'scope', 'trigger', 'conditions', 'actions'] = '{}'::jsonb
    ELSE false END
  ) IS TRUE),
  CONSTRAINT workflow_revisions_name CHECK ((
    jsonb_typeof(definition->'name') = 'string'
    AND octet_length(definition->>'name') BETWEEN 1 AND 200
  ) IS TRUE),
  CONSTRAINT workflow_revisions_scope CHECK ((
    jsonb_typeof(definition->'scope') = 'object'
    AND definition->'scope'->>'type' IN ('all_event_types', 'event_type')
  ) IS TRUE),
  -- Lifecycle triggers take a delay, timer triggers an offset, and none takes both.
  CONSTRAINT workflow_revisions_trigger CHECK ((
    CASE WHEN jsonb_typeof(definition->'trigger') = 'object' THEN
      CASE
        WHEN definition->'trigger'->>'type' IN ('booking.created', 'booking.cancelled', 'booking.rescheduled')
          AND (definition->'trigger') - ARRAY['type', 'delayMinutes'] = '{}'::jsonb
          AND jsonb_typeof(definition->'trigger'->'delayMinutes') = 'number' THEN
          (definition->'trigger'->>'delayMinutes')::numeric BETWEEN 0 AND 43200
          AND (definition->'trigger'->>'delayMinutes')::numeric
            = trunc((definition->'trigger'->>'delayMinutes')::numeric)
        WHEN definition->'trigger'->>'type' IN ('before_start', 'after_end')
          AND (definition->'trigger') - ARRAY['type', 'offsetMinutes'] = '{}'::jsonb
          AND jsonb_typeof(definition->'trigger'->'offsetMinutes') = 'number' THEN
          (definition->'trigger'->>'offsetMinutes')::numeric BETWEEN 5 AND 43200
          AND (definition->'trigger'->>'offsetMinutes')::numeric
            = trunc((definition->'trigger'->>'offsetMinutes')::numeric)
        ELSE false
      END
    ELSE false END
  ) IS TRUE),
  -- At most five conditions, each naming a known field (positions past the end are NULL).
  CONSTRAINT workflow_revisions_conditions CHECK ((
    CASE WHEN jsonb_typeof(definition->'conditions') = 'array' THEN
      jsonb_array_length(definition->'conditions') <= 5
      AND (definition->'conditions'->0 IS NULL OR definition->'conditions'->0->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
      AND (definition->'conditions'->1 IS NULL OR definition->'conditions'->1->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
      AND (definition->'conditions'->2 IS NULL OR definition->'conditions'->2->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
      AND (definition->'conditions'->3 IS NULL OR definition->'conditions'->3->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
      AND (definition->'conditions'->4 IS NULL OR definition->'conditions'->4->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
    ELSE false END
  ) IS TRUE),
  -- Exactly one action, email or webhook.
  CONSTRAINT workflow_revisions_actions CHECK ((
    CASE WHEN jsonb_typeof(definition->'actions') = 'array' THEN
      jsonb_array_length(definition->'actions') BETWEEN 1 AND 1
      AND definition->'actions'->0->>'type' IN ('email', 'webhook')
    ELSE false END
  ) IS TRUE)
);

-- The current revision always exists. Deferred, so a definition and its first revision are
-- written in one transaction.
ALTER TABLE workflow_definitions ADD CONSTRAINT workflow_definitions_current_revision
  FOREIGN KEY (organization_id, id, revision)
  REFERENCES workflow_revisions (organization_id, workflow_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_workflow_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.owner_user_id IS NULL AND EXISTS (SELECT FROM public.personal_organizations
          WHERE organization_id = NEW.organization_id))
       OR (NEW.owner_user_id IS NOT NULL AND NOT EXISTS (SELECT FROM public.personal_organizations
          WHERE user_id = NEW.owner_user_id AND organization_id = NEW.organization_id)) THEN
      RAISE EXCEPTION 'a workflow belongs to a team or to its owner''s personal organization'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_owner';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Allowed for a tombstone, and with the organization or the personal owner.
    IF OLD.deleted_at IS NULL
       AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND (OLD.owner_user_id IS NULL
         OR EXISTS (SELECT FROM auth."user" WHERE id = OLD.owner_user_id)) THEN
      RAISE EXCEPTION 'a workflow is tombstoned before it is removed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_tombstone_first';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted workflow is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_deleted_final';
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.owner_user_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.owner_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow identity and ownership are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_identity_immutable';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'a workflow''s current revision never goes back'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_revision_monotonic';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_definitions_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_definition();
CREATE TRIGGER workflow_definitions_updated_at BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Revisions are never updated, and are deleted only with their definition. A new revision
-- takes the organization lock and then the definition lock, in the order other organization
-- writers use, is numbered right after the latest one and becomes the current revision.
CREATE FUNCTION guard_workflow_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  parent public.workflow_definitions;
  latest integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workflow revisions are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_revisions_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM public.workflow_definitions
        WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id) THEN
      RAISE EXCEPTION 'workflow revisions are removed only with their workflow'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_revisions_retained';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
  SELECT * INTO parent FROM public.workflow_definitions
    WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing workflow
  END IF;
  IF parent.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted workflow takes no new revision'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_revisions_deleted';
  END IF;
  SELECT max(revision) INTO latest FROM public.workflow_revisions
    WHERE organization_id = NEW.organization_id AND workflow_id = NEW.workflow_id;
  IF NEW.revision IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'workflow revisions are numbered in sequence'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_revisions_sequence';
  END IF;
  IF NEW.revision > parent.revision THEN
    UPDATE public.workflow_definitions SET revision = NEW.revision
      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_revision();
