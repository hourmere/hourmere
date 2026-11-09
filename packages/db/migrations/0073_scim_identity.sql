-- Storage only: no SCIM resource handler is registered by this migration.
CREATE TABLE scim_connections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scim_connections_one_per_organization UNIQUE (organization_id),
  CONSTRAINT scim_connections_scope UNIQUE (organization_id, id)
);

-- Preserve every credential field, including revoked history and actor attribution.
INSERT INTO scim_connections (organization_id)
SELECT DISTINCT organization_id FROM scim_provisioning_tokens;
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
  CONSTRAINT scim_users_username_length CHECK (char_length(btrim(user_name)) BETWEEN 1 AND 256),
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
  CONSTRAINT scim_claims_email_length CHECK (char_length(btrim(work_email)) BETWEEN 1 AND 320),
  CONSTRAINT scim_claims_expiry CHECK (expires_at > created_at),
  CONSTRAINT scim_claims_terminal CHECK (completed_at IS NULL OR invalidated_at IS NULL)
);
CREATE UNIQUE INDEX scim_claims_pending_user ON scim_user_claims (scim_user_id)
  WHERE completed_at IS NULL AND invalidated_at IS NULL;
CREATE UNIQUE INDEX scim_claims_invitation ON scim_user_claims (invitation_id)
  WHERE invitation_id IS NOT NULL;

-- Account-scoped blockers survive membership deletion and a fresh resource's admission.
-- Each authority clears only its own blocker in the later lifecycle service.
CREATE TABLE scim_membership_blocks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  source text NOT NULL,
  kind text NOT NULL,
  connection_id uuid,
  scim_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_users_preserve_identity BEFORE UPDATE OR DELETE ON scim_users
  FOR EACH ROW EXECUTE FUNCTION scim_preserve_user_identity();

-- Account and membership FK actions have no guaranteed ordering. Clear both nullable
-- references before native account deletion so the paired-link check remains true.
CREATE FUNCTION scim_clear_deleted_account_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
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
