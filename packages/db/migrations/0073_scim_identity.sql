-- Storage only: no SCIM resource handler is registered by this migration.
-- Lock order follows docs/data-model.md: account and organization tables before member
-- and invitation tables, then the provisioning-token resource. Every table lock is taken
-- directly in its final mode (no upgrade) and held to commit, so concurrent sign-up, team
-- creation, team administration and token administration either run before the migration
-- or after it, never interleaved with the backfill. SHARE ROW EXCLUSIVE lets row share
-- locks (FOR UPDATE/FOR SHARE) and reads continue while writes to those tables wait.
LOCK TABLE auth."user" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE auth.organization IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE auth.member, auth.invitation IN ACCESS EXCLUSIVE MODE;
LOCK TABLE scim_provisioning_tokens IN ACCESS EXCLUSIVE MODE;

CREATE TABLE scim_connections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scim_connections_one_per_organization UNIQUE (organization_id),
  CONSTRAINT scim_connections_scope UNIQUE (organization_id, id)
);

-- Preserve every credential field, including revoked history and actor attribution.
-- The organization FK is added after the backfill: FK checks on existing rows would take
-- row locks on organizations that team administration may hold FOR UPDATE while it waits
-- for the member lock above. The organization table lock already excludes deletions.
INSERT INTO scim_connections (organization_id)
SELECT DISTINCT organization_id FROM scim_provisioning_tokens;
ALTER TABLE scim_connections ADD CONSTRAINT scim_connections_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;
ALTER TABLE scim_provisioning_tokens ADD CONSTRAINT scim_tokens_scope
  UNIQUE (organization_id, id);
CREATE TABLE scim_token_connections (
  token_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  CONSTRAINT scim_token_connections_token_scope FOREIGN KEY (organization_id, token_id)
    REFERENCES scim_provisioning_tokens (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT scim_token_connections_connection_scope FOREIGN KEY (organization_id, connection_id)
    REFERENCES scim_connections (organization_id, id)
);
INSERT INTO scim_token_connections (token_id, organization_id, connection_id)
SELECT t.id, t.organization_id, c.id FROM scim_provisioning_tokens t
JOIN scim_connections c ON c.organization_id = t.organization_id;

-- Existing token creation remains compatible; rotation never rewrites this binding.
CREATE FUNCTION scim_assign_token_connection() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO scim_connections (organization_id) VALUES (NEW.organization_id)
    ON CONFLICT (organization_id) DO NOTHING;
  INSERT INTO scim_token_connections (token_id, organization_id, connection_id)
    SELECT NEW.id, NEW.organization_id, id FROM scim_connections
    WHERE organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_token_connection_insert AFTER INSERT ON scim_provisioning_tokens
  FOR EACH ROW EXECUTE FUNCTION scim_assign_token_connection();

ALTER TABLE auth.member ADD CONSTRAINT scim_member_scope
  UNIQUE ("organizationId", id, "userId");
ALTER TABLE auth.invitation ADD CONSTRAINT scim_invitation_scope
  UNIQUE ("organizationId", id);

CREATE TABLE scim_users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id text,
  user_name text NOT NULL,
  normalized_user_name text GENERATED ALWAYS AS (lower(btrim(user_name))) STORED,
  active boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  linked_user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL,
  linked_member_id uuid,
  given_name text,
  family_name text,
  formatted_name text,
  display_name text,
  nick_name text,
  work_email text,
  locale text,
  timezone text,
  title text,
  user_type text,
  employee_number text,
  cost_center text,
  enterprise_organization text,
  division text,
  department text,
  manager_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scim_users_scope UNIQUE (organization_id, connection_id, id),
  CONSTRAINT scim_users_connection_scope FOREIGN KEY (organization_id, connection_id)
    REFERENCES scim_connections (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT scim_users_member_scope FOREIGN KEY (organization_id, linked_member_id, linked_user_id)
    REFERENCES auth.member ("organizationId", id, "userId")
    ON DELETE SET NULL (linked_member_id),
  CONSTRAINT scim_users_manager_scope FOREIGN KEY (organization_id, connection_id, manager_id)
    REFERENCES scim_users (organization_id, connection_id, id),
  CONSTRAINT scim_users_username_length CHECK (char_length(btrim(user_name)) BETWEEN 1 AND 256 AND char_length(user_name) <= 256),
  CONSTRAINT scim_users_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  CONSTRAINT scim_users_member_account CHECK (linked_member_id IS NULL OR linked_user_id IS NOT NULL),
  CONSTRAINT scim_users_retired_inactive CHECK (retired_at IS NULL OR NOT active),
  CONSTRAINT scim_users_profile_bounds CHECK (
    char_length(coalesce(given_name, '')) <= 256 AND
    char_length(coalesce(family_name, '')) <= 256 AND
    char_length(coalesce(formatted_name, '')) <= 256 AND
    char_length(coalesce(display_name, '')) <= 256 AND
    char_length(coalesce(nick_name, '')) <= 256 AND
    char_length(coalesce(work_email, '')) <= 320 AND
    char_length(coalesce(locale, '')) <= 64 AND
    char_length(coalesce(timezone, '')) <= 128 AND
    char_length(coalesce(title, '')) <= 256 AND
    char_length(coalesce(user_type, '')) <= 256 AND
    char_length(coalesce(employee_number, '')) <= 256 AND
    char_length(coalesce(cost_center, '')) <= 256 AND
    char_length(coalesce(enterprise_organization, '')) <= 256 AND
    char_length(coalesce(division, '')) <= 256 AND
    char_length(coalesce(department, '')) <= 256)
);
CREATE UNIQUE INDEX scim_users_live_username ON scim_users (connection_id, normalized_user_name)
  WHERE retired_at IS NULL;
CREATE UNIQUE INDEX scim_users_live_external_id ON scim_users (connection_id, external_id)
  WHERE retired_at IS NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX scim_users_live_account ON scim_users (connection_id, linked_user_id)
  WHERE retired_at IS NULL AND linked_user_id IS NOT NULL;

CREATE TABLE scim_user_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  scim_user_id uuid NOT NULL,
  invitation_id uuid,
  work_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  invalidated_at timestamptz,
  CONSTRAINT scim_claims_user_scope FOREIGN KEY (organization_id, connection_id, scim_user_id)
    REFERENCES scim_users (organization_id, connection_id, id) ON DELETE CASCADE,
  CONSTRAINT scim_claims_invitation_scope FOREIGN KEY (organization_id, invitation_id)
    REFERENCES auth.invitation ("organizationId", id) ON DELETE SET NULL (invitation_id),
  CONSTRAINT scim_claims_email_length CHECK (char_length(btrim(work_email)) BETWEEN 1 AND 320 AND char_length(work_email) <= 320),
  CONSTRAINT scim_claims_expiry CHECK (expires_at > created_at),
  CONSTRAINT scim_claims_terminal CHECK (completed_at IS NULL OR invalidated_at IS NULL)
);
CREATE UNIQUE INDEX scim_claims_pending_user ON scim_user_claims (scim_user_id)
  WHERE completed_at IS NULL AND invalidated_at IS NULL;
CREATE UNIQUE INDEX scim_claims_invitation ON scim_user_claims (invitation_id)
  WHERE invitation_id IS NOT NULL;

-- Admission blockers survive membership and account deletion. On account deletion,
-- the cleanup trigger retains the normalized mailbox as a team-local identity tombstone.
-- Each authority clears only its own blocker in the later lifecycle service.
CREATE TABLE scim_membership_blocks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL,
  identity_email text,
  source text NOT NULL,
  kind text NOT NULL,
  connection_id uuid,
  scim_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  CONSTRAINT scim_blocks_identity CHECK (user_id IS NOT NULL OR identity_email IS NOT NULL),
  CONSTRAINT scim_blocks_identity_email CHECK (identity_email IS NULL OR
    (identity_email = lower(btrim(identity_email)) AND char_length(identity_email) BETWEEN 1 AND 320)),
  CONSTRAINT scim_blocks_source CHECK (source IN ('local', 'scim')),
  CONSTRAINT scim_blocks_kind CHECK (kind IN ('suspension', 'removal')),
  CONSTRAINT scim_blocks_resource CHECK (
    (source <> 'scim' AND connection_id IS NULL AND scim_user_id IS NULL) OR
    (source = 'scim' AND connection_id IS NOT NULL AND scim_user_id IS NOT NULL)),
  CONSTRAINT scim_blocks_user_scope FOREIGN KEY (organization_id, connection_id, scim_user_id)
    REFERENCES scim_users (organization_id, connection_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX scim_blocks_live_authority ON scim_membership_blocks (organization_id, user_id, source, kind)
  WHERE cleared_at IS NULL;
CREATE UNIQUE INDEX scim_blocks_live_identity ON scim_membership_blocks (organization_id, identity_email, source, kind)
  WHERE cleared_at IS NULL;

-- Index referencing columns for FK checks and deletion cleanup, including history.
CREATE INDEX scim_token_connections_connection_idx ON scim_token_connections (organization_id, connection_id);
CREATE INDEX scim_users_member_idx ON scim_users (organization_id, linked_member_id, linked_user_id);
CREATE INDEX scim_users_account_idx ON scim_users (linked_user_id);
CREATE INDEX scim_users_manager_idx ON scim_users (organization_id, connection_id, manager_id);
CREATE INDEX scim_claims_user_idx ON scim_user_claims (organization_id, connection_id, scim_user_id);
CREATE INDEX scim_claims_invitation_idx ON scim_user_claims (organization_id, invitation_id);
CREATE INDEX scim_blocks_user_idx ON scim_membership_blocks (user_id);
CREATE INDEX scim_blocks_resource_idx ON scim_membership_blocks (organization_id, connection_id, scim_user_id);
CREATE INDEX scim_blocks_identity_idx ON scim_membership_blocks (organization_id, identity_email);

-- A captured identity cannot be redirected to a different mailbox or account, and the
-- captured decision itself is frozen: authority, kind, resource reference and creation
-- time are immutable, clearing happens once, the row survives while its organization
-- exists, and the account reference may only disappear once the account itself is gone.
CREATE FUNCTION scim_preserve_block_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.identity_email IS NOT NULL AND
       EXISTS (SELECT 1 FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'Admission tombstone must be retained' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND
     EXISTS (SELECT 1 FROM auth."user" WHERE id = OLD.user_id) THEN
    RAISE EXCEPTION 'Admission blocker detaches only from a deleted account' USING ERRCODE = '23514';
  END IF;
  IF OLD.identity_email IS NOT NULL AND (
    NEW.identity_email IS DISTINCT FROM OLD.identity_email OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) OR
    (NEW.id, NEW.source, NEW.kind, NEW.connection_id, NEW.scim_user_id, NEW.created_at) IS DISTINCT FROM
    (OLD.id, OLD.source, OLD.kind, OLD.connection_id, OLD.scim_user_id, OLD.created_at) OR
    (OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS DISTINCT FROM OLD.cleared_at)
  ) THEN
    RAISE EXCEPTION 'Admission tombstone identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_blocks_preserve_identity BEFORE UPDATE OR DELETE ON scim_membership_blocks
  FOR EACH ROW EXECUTE FUNCTION scim_preserve_block_identity();

-- Keep resource identity and retirement durable. Whole-organization deletion may cascade;
-- an IdP deletion instead sets retired_at and keeps the opaque ID reserved forever.
CREATE FUNCTION scim_preserve_user_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'SCIM resource identity must be retained' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.connection_id) IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.connection_id) OR
     (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'SCIM resource identity and retirement are immutable' USING ERRCODE = '23514';
  END IF;
  -- Generated values are unavailable in BEFORE triggers. Compare every stored field
  -- except nullable links; those may only clear to support native deletion cleanup.
  IF OLD.retired_at IS NOT NULL AND (
    (to_jsonb(NEW) - ARRAY['normalized_user_name', 'linked_user_id', 'linked_member_id']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['normalized_user_name', 'linked_user_id', 'linked_member_id']) OR
    (NEW.linked_user_id IS DISTINCT FROM OLD.linked_user_id AND NEW.linked_user_id IS NOT NULL) OR
    (NEW.linked_member_id IS DISTINCT FROM OLD.linked_member_id AND NEW.linked_member_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Retired SCIM resources are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_users_preserve_identity BEFORE UPDATE OR DELETE ON scim_users
  FOR EACH ROW EXECUTE FUNCTION scim_preserve_user_identity();

-- Account and membership FK actions have no guaranteed ordering. Clear both nullable
-- references before native account deletion so the paired-link check remains true.
CREATE FUNCTION scim_clear_deleted_account_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  mailbox text := lower(btrim(OLD.email));
BEGIN
  -- Preserve admission decisions without retaining a foreign key to the deleted account.
  -- A mailbox is captured only when it is storable (1-320 normalized characters) and no
  -- live tombstone already records the same organization, mailbox, authority and kind.
  IF char_length(mailbox) BETWEEN 1 AND 320 THEN
    UPDATE scim_membership_blocks b SET identity_email = mailbox
      WHERE b.user_id = OLD.id AND b.identity_email IS NULL AND (b.cleared_at IS NOT NULL OR
        NOT EXISTS (SELECT 1 FROM scim_membership_blocks t
          WHERE t.organization_id = b.organization_id AND t.identity_email = mailbox AND
            t.source = b.source AND t.kind = b.kind AND t.cleared_at IS NULL));
  END IF;
  -- Account deletion is the privacy path and is never refused: a blocker left without a
  -- mailbox would identify nobody (or duplicate a live tombstone), so it is dropped.
  DELETE FROM scim_membership_blocks WHERE user_id = OLD.id AND identity_email IS NULL;
  UPDATE scim_users SET linked_user_id = NULL, linked_member_id = NULL
    WHERE linked_user_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER scim_account_delete_links BEFORE DELETE ON auth.user
  FOR EACH ROW EXECUTE FUNCTION scim_clear_deleted_account_links();

-- Invitations and resources both cascade from an organization. Remove claim rows
-- first so invitation SET NULL cannot recheck a resource already being deleted.
-- Ordinary invitation deletion still retains its claim intent and history.
CREATE FUNCTION scim_clear_deleted_organization_claims() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  DELETE FROM scim_user_claims WHERE organization_id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER scim_organization_delete_claims BEFORE DELETE ON auth.organization
  FOR EACH ROW EXECUTE FUNCTION scim_clear_deleted_organization_claims();
