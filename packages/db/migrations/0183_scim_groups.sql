SET LOCAL lock_timeout = '2s';

-- Activation gives the approved mapping a distinct, retained SCIM identity.
-- The mapping still controls directory authority, including after retirement.
CREATE TABLE scim_groups (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mapping_id uuid NOT NULL UNIQUE REFERENCES scim_team_mappings(id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT scim_groups_timestamp_order CHECK (updated_at >= created_at)
);

CREATE FUNCTION scim_guard_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  authority_stopped boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialize direct inserts with changes to the mapping. The foreign key
    -- rejects missing mappings separately.
    SELECT retired_at IS NOT NULL OR suspended_at IS NOT NULL INTO authority_stopped
      FROM scim_team_mappings WHERE id = NEW.mapping_id FOR SHARE;
    IF authority_stopped THEN
      RAISE EXCEPTION 'SCIM Group activation requires directory authority'
        USING ERRCODE = '23514', CONSTRAINT = 'scim_groups_mapping_authority';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR
    (NEW.id, NEW.mapping_id, NEW.created_at) IS DISTINCT FROM
    (OLD.id, OLD.mapping_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SCIM Group identity must be retained'
      USING ERRCODE = '23514', CONSTRAINT = 'scim_groups_identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER scim_groups_guard
  BEFORE INSERT OR UPDATE OR DELETE ON scim_groups
  FOR EACH ROW EXECUTE FUNCTION scim_guard_group();

-- A new directory entry for the same account does not inherit an old roster source.
-- Keep predecessor rows without an exact source as they are.
ALTER TABLE scim_team_managed_memberships
  ADD COLUMN scim_user_id uuid CONSTRAINT scim_team_managed_memberships_scim_user_fkey
    REFERENCES scim_users(id);
