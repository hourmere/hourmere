-- All referenced tables already exist. Foreign keys take short table locks while
-- the new tables are empty. Bound any wait on an existing writer.
SET LOCAL lock_timeout = '2s';

CREATE TABLE scim_team_link_generations (
  child_organization_id uuid PRIMARY KEY REFERENCES auth.organization(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 0,
  CONSTRAINT scim_team_link_generation_nonnegative CHECK (generation >= 0)
);

-- A live mapping is its hierarchy edge, including before Group activation and
-- after directory authority is suspended. Retirement releases both reservations,
-- keeps the mapping ID and endpoints, and lets either former endpoint be deleted.
CREATE TABLE scim_team_mappings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  parent_organization_id uuid NOT NULL,
  child_organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  suspended_at timestamptz,
  retired_at timestamptz,
  live_parent_organization_id uuid GENERATED ALWAYS AS
    (CASE WHEN retired_at IS NULL THEN parent_organization_id END) STORED,
  live_child_organization_id uuid GENERATED ALWAYS AS
    (CASE WHEN retired_at IS NULL THEN child_organization_id END) STORED,
  live_connection_id uuid GENERATED ALWAYS AS
    (CASE WHEN retired_at IS NULL THEN connection_id END) STORED,
  CONSTRAINT scim_team_mappings_distinct_teams CHECK (parent_organization_id <> child_organization_id),
  CONSTRAINT scim_team_mappings_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 256),
  CONSTRAINT scim_team_mappings_lifetime CHECK (
    (retired_at IS NULL OR retired_at >= created_at) AND
    (suspended_at IS NULL OR (suspended_at >= created_at AND
      (retired_at IS NULL OR retired_at >= suspended_at)))
  ),
  CONSTRAINT scim_team_mappings_live_connection_scope
    FOREIGN KEY (live_parent_organization_id, live_connection_id)
    REFERENCES scim_connections (organization_id, id),
  CONSTRAINT scim_team_mappings_live_child_fkey
    FOREIGN KEY (live_child_organization_id) REFERENCES auth.organization (id),
  CONSTRAINT scim_team_mappings_one_live_parent UNIQUE (live_child_organization_id),
  CONSTRAINT scim_team_mappings_live_child_scope UNIQUE (id, live_child_organization_id),
  CONSTRAINT scim_team_mappings_one_live_external_id UNIQUE (live_connection_id, external_id)
);
CREATE INDEX scim_team_mappings_live_connection_idx
  ON scim_team_mappings (live_parent_organization_id, live_connection_id);

-- The synchronization trigger is this table's writer. Exclusion allows many
-- parent entries per organization but never opposite roles, even for concurrent
-- inserts with different mappings and snapshots.
CREATE TABLE scim_team_link_roles (
  mapping_id uuid REFERENCES scim_team_mappings(id),
  organization_id uuid NOT NULL,
  side text NOT NULL,
  CONSTRAINT scim_team_link_roles_pkey PRIMARY KEY (mapping_id, side),
  CONSTRAINT scim_team_link_roles_side CHECK (side IN ('parent', 'child')),
  CONSTRAINT scim_team_link_roles_depth EXCLUDE USING gist (organization_id WITH =, side WITH <>)
);

CREATE FUNCTION scim_guard_team_mapping() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.retired_at IS NOT NULL OR NEW.suspended_at IS NOT NULL THEN
      RAISE EXCEPTION 'A SCIM team mapping must start live'
        USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mappings_starts_live';
    END IF;
    -- Internal writers pre-lock both teams in this order before dependent rows.
    -- This also serializes a standalone INSERT with organization deletion.
    PERFORM id FROM auth.organization
      WHERE id IN (NEW.parent_organization_id, NEW.child_organization_id)
      ORDER BY id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM personal_organizations
      WHERE organization_id IN (NEW.parent_organization_id, NEW.child_organization_id)) THEN
      RAISE EXCEPTION 'A personal organization cannot be linked'
        USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mappings_nonpersonal';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SCIM team mapping identity must be retained'
      USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mappings_identity';
  END IF;
  IF (NEW.id, NEW.parent_organization_id, NEW.child_organization_id, NEW.connection_id,
      NEW.external_id COLLATE "C", NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.parent_organization_id, OLD.child_organization_id, OLD.connection_id,
      OLD.external_id COLLATE "C", OLD.created_at) OR
     (OLD.retired_at IS NOT NULL AND
      (NEW.retired_at, NEW.suspended_at) IS DISTINCT FROM (OLD.retired_at, OLD.suspended_at)) OR
     (OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS DISTINCT FROM OLD.suspended_at) THEN
    RAISE EXCEPTION 'SCIM team mapping identity and terminal state are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mappings_identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_team_mappings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON scim_team_mappings
  FOR EACH ROW EXECUTE FUNCTION scim_guard_team_mapping();

CREATE FUNCTION scim_sync_team_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO scim_team_link_roles (mapping_id, organization_id, side)
    SELECT NEW.id, endpoint.id, endpoint.side
      FROM (VALUES (NEW.parent_organization_id, 'parent'), (NEW.child_organization_id, 'child'))
        AS endpoint (id, side)
      ORDER BY endpoint.id;
  ELSIF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    DELETE FROM scim_team_link_roles WHERE mapping_id = NEW.id;
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO scim_team_link_generations (child_organization_id, generation)
    VALUES (NEW.child_organization_id, 1)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    UPDATE scim_team_link_generations SET generation = generation + 1
      WHERE child_organization_id = NEW.child_organization_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_team_mappings_sync_link
  AFTER INSERT OR UPDATE OF retired_at ON scim_team_mappings
  FOR EACH ROW EXECUTE FUNCTION scim_sync_team_link();

-- A fresh-proof approval can exist before the other owner has authorized looking
-- up their team. Keep opaque input IDs here without foreign existence checks.
CREATE TABLE scim_team_mapping_intents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  parent_organization_id uuid NOT NULL,
  child_organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  action text NOT NULL,
  external_id text COLLATE "C",
  link_generation integer,
  allow_group_retirement boolean,
  mapping_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  CONSTRAINT scim_team_mapping_intents_distinct_teams CHECK (parent_organization_id <> child_organization_id),
  CONSTRAINT scim_team_mapping_intents_input CHECK (
    (action = 'link' AND external_id IS NOT NULL AND char_length(external_id) BETWEEN 1 AND 256
      AND link_generation IS NOT NULL AND link_generation >= 0
      AND allow_group_retirement IS TRUE AND mapping_id IS NULL)
    OR (action = 'unlink' AND external_id IS NULL AND link_generation IS NULL
      AND allow_group_retirement IS NULL AND mapping_id IS NOT NULL)
  ),
  CONSTRAINT scim_team_mapping_intents_lifetime CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE FUNCTION scim_freeze_team_mapping_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') OR
     (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'SCIM team mapping intent and consumption are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mapping_intents_identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_team_mapping_intents_freeze
  BEFORE UPDATE ON scim_team_mapping_intents
  FOR EACH ROW EXECUTE FUNCTION scim_freeze_team_mapping_intent();

-- Owner, membership and browser session IDs are snapshots. Recheck them at use;
-- recording consent does not extend their lifetime or store a reusable proof.
CREATE TABLE scim_team_mapping_consents (
  intent_id uuid REFERENCES scim_team_mapping_intents(id) ON DELETE CASCADE,
  organization_id uuid,
  owner_id uuid NOT NULL,
  member_id uuid NOT NULL,
  session_id uuid NOT NULL,
  proof_kind text NOT NULL,
  proof_context jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT scim_team_mapping_consents_pkey PRIMARY KEY (intent_id, organization_id),
  CONSTRAINT scim_team_mapping_consents_proof CHECK (
    proof_kind IN ('mailbox', 'sso') AND jsonb_typeof(proof_context) = 'object'
  ),
  CONSTRAINT scim_team_mapping_consents_lifetime CHECK (expires_at > approved_at)
);

CREATE FUNCTION scim_check_team_mapping_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  -- The internal service locks the organizations before updating an approval.
  IF NOT EXISTS (SELECT 1 FROM scim_team_mapping_intents
    WHERE id = NEW.intent_id AND consumed_at IS NULL
      AND NEW.organization_id IN (parent_organization_id, child_organization_id)
    FOR SHARE) THEN
    RAISE EXCEPTION 'SCIM team mapping consent needs an open intent for its organization'
      USING ERRCODE = '23514', CONSTRAINT = 'scim_team_mapping_consents_intent_side';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_team_mapping_consents_check_scope
  BEFORE INSERT OR UPDATE ON scim_team_mapping_consents
  FOR EACH ROW EXECUTE FUNCTION scim_check_team_mapping_consent();

-- Provenance for a directory-managed child membership. Local departure clears
-- it with the membership; retiring a mapping requires clearing its roster first.
CREATE TABLE scim_team_managed_memberships (
  member_id uuid PRIMARY KEY,
  mapping_id uuid NOT NULL,
  child_organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT scim_team_managed_memberships_mapping_scope FOREIGN KEY (mapping_id, child_organization_id)
    REFERENCES scim_team_mappings (id, live_child_organization_id),
  CONSTRAINT scim_team_managed_memberships_member_scope
    FOREIGN KEY (child_organization_id, member_id, user_id)
    REFERENCES auth.member ("organizationId", id, "userId") ON DELETE CASCADE
);
CREATE INDEX scim_team_managed_memberships_mapping_idx
  ON scim_team_managed_memberships (mapping_id, child_organization_id);
