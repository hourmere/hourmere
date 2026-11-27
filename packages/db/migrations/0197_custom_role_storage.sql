-- Freeze v1 permission IDs. New IDs and classifications require a new catalogue version.
CREATE FUNCTION public.custom_role_grantable_permissions_v1() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    -- Phase one
    'analytics.read',
    'branding.read',
    'branding.update',
    'branding.upload_logo',
    'event_notifications.update',
    'event_types.activate_round_robin',
    'event_types.assign_hosts',
    'event_types.create',
    'event_types.delete',
    'event_types.duplicate',
    'event_types.list_host_candidates',
    'event_types.update',
    'readiness.read_team',
    'routing_forms.preview',
    'routing_forms.read',
    'workflows.preview',
    'workflows.read',
    'workflows.read_runs',
    -- Phase two, personal data
    'event_types.generate_open_time_snippet',
    'team_bookings.read',
    'waitlists.read_settings',
    'waitlists.update_settings'
  ]::text[];
$$;

-- The broader set is available for explicit credential ceilings, never for custom grants.
CREATE FUNCTION public.custom_role_operation_ids_v1() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'attendance.mark_no_show',
    'attendance.read',
    'attendance.unmark_no_show',
    'audit.read',
    'audit.read_retention',
    'audit.update_retention',
    'credentials.manage_own_key',
    'credentials.manage_own_oauth_grant',
    'event_notifications.read',
    'event_types.diagnose_availability',
    'event_types.read',
    'event_types.update_success_redirect',
    'group_occurrences.cancel',
    'group_occurrences.read_attendees',
    'invitations.cancel',
    'invitations.create',
    'invitations.read',
    'invitations.replace',
    'invitations.resend',
    'invitations.respond_self',
    'members.add_trusted',
    'members.assign_role',
    'members.leave_self',
    'members.read',
    'members.read_departure',
    'members.read_own_departure',
    'members.read_private',
    'members.read_removal_handling',
    'members.remove',
    'one_time_links.create',
    'one_time_links.read',
    'one_time_links.revoke',
    'polls.cancel',
    'polls.close',
    'polls.create',
    'polls.delete',
    'polls.finalize',
    'polls.invite',
    'polls.read',
    'polls.read_results',
    'polls.remove_unverified',
    'polls.remove_voter',
    'polls.resend',
    'polls.rotate_link',
    'readiness.read_self',
    'routing_forms.archive',
    'routing_forms.create',
    'routing_forms.publish',
    'routing_forms.update',
    'scim.approve_mapping',
    'scim.create_token',
    'scim.link_team',
    'scim.provision_groups',
    'scim.provision_users',
    'scim.read_mappings',
    'scim.read_tokens',
    'scim.revoke_token',
    'scim.rotate_token',
    'scim.unlink_team',
    'slack_destinations.create',
    'slack_destinations.delete',
    'slack_destinations.read',
    'slack_destinations.test',
    'slack_destinations.update',
    'sso.accept_recovery',
    'sso.activate_provider',
    'sso.bind_credential_self',
    'sso.challenge_domain',
    'sso.create_provider',
    'sso.deactivate_provider',
    'sso.link_self',
    'sso.nominate_recovery',
    'sso.read_links',
    'sso.read_policy',
    'sso.read_providers',
    'sso.retire_domain',
    'sso.retire_member_link',
    'sso.retire_provider',
    'sso.revoke_binding_self',
    'sso.set_admission',
    'sso.set_enforcement',
    'sso.test_provider',
    'sso.unlink_self',
    'sso.update_provider',
    'sso.use_recovery',
    'sso.verify_domain',
    'team.create',
    'team.read_native_permission',
    'team.switch',
    'team.update',
    'team_bookings.cancel',
    'team_bookings.export',
    'waitlists.list_entries',
    'waitlists.remove_entry',
    'webhooks.create',
    'webhooks.delete',
    'webhooks.read',
    'webhooks.read_deliveries',
    'webhooks.rotate_secret',
    'webhooks.update',
    'workflows.create',
    'workflows.delete',
    'workflows.disable',
    'workflows.enable',
    'workflows.update'
  ]::text[] || public.custom_role_grantable_permissions_v1();
$$;

CREATE FUNCTION custom_role_permission_set_valid(version integer, ids text[], ceiling boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT version = 1
    AND ids <@ CASE WHEN ceiling THEN custom_role_operation_ids_v1()
                    ELSE custom_role_grantable_permissions_v1() END
    AND coalesce(array_ndims(ids) = 1 AND array_lower(ids, 1) = 1, cardinality(ids) = 0)
    AND cardinality(ids) = (SELECT count(DISTINCT id) FROM unnest(ids) AS p(id));
$$;

-- Match String.trim() in the existing fixed-role predicates, without discarding unknown
-- or repeated tokens or imposing a precedence that some legacy predicates do not use.
CREATE FUNCTION custom_role_fixed_tokens(role text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT ARRAY(
    SELECT btrim(token,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    FROM unnest(CASE WHEN role = '' THEN ARRAY[''] ELSE string_to_array(role, ',') END)
      WITH ORDINALITY AS t(token, position)
    ORDER BY position
  );
$$;

CREATE TABLE custom_role_master_policy (
  singleton boolean PRIMARY KEY DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  policy_epoch integer NOT NULL DEFAULT 0,
  CONSTRAINT custom_role_master_singleton CHECK (singleton),
  CONSTRAINT custom_role_master_epoch CHECK (policy_epoch >= 0)
);
INSERT INTO custom_role_master_policy DEFAULT VALUES;

CREATE TABLE team_custom_role_policies (
  organization_id uuid PRIMARY KEY REFERENCES auth.organization(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  policy_epoch integer NOT NULL DEFAULT 0,
  CONSTRAINT team_custom_role_policy_epoch CHECK (policy_epoch >= 0)
);
INSERT INTO team_custom_role_policies (organization_id)
SELECT org.id FROM auth.organization AS org
WHERE NOT EXISTS (SELECT FROM personal_organizations AS p WHERE p.organization_id = org.id);

CREATE FUNCTION guard_custom_role_policy_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'team_custom_role_policies' THEN
      IF NOT EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'a live custom role policy cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_policy_epoch_transition';
  END IF;
  IF NEW.policy_epoch < OLD.policy_epoch
    OR (NEW.enabled IS DISTINCT FROM OLD.enabled AND NEW.policy_epoch = OLD.policy_epoch) THEN
    RAISE EXCEPTION 'custom role policy epochs must advance on switch transitions'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_policy_epoch_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_role_master_epoch_guard BEFORE UPDATE OR DELETE ON custom_role_master_policy
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_policy_epoch();
CREATE TRIGGER team_custom_role_epoch_guard BEFORE UPDATE OR DELETE ON team_custom_role_policies
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_policy_epoch();

CREATE TABLE team_member_authorizations (
  organization_id uuid NOT NULL,
  member_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  fixed_policy_version integer NOT NULL DEFAULT 1,
  legacy_role_tokens text[],
  fixed_role text,
  CONSTRAINT team_member_authorization_scope UNIQUE (organization_id, member_id, user_id),
  CONSTRAINT team_member_authorization_membership FOREIGN KEY (organization_id, member_id, user_id)
    REFERENCES auth.member ("organizationId", id, "userId") ON DELETE CASCADE,
  CONSTRAINT team_member_authorization_generation CHECK (generation > 0),
  CONSTRAINT team_member_authorization_fixed_policy CHECK (fixed_policy_version = 1),
  CONSTRAINT team_member_authorization_fixed_role CHECK (
    fixed_role IS NOT DISTINCT FROM CASE
      WHEN legacy_role_tokens IN (ARRAY['owner'], ARRAY['admin'], ARRAY['member'])
        THEN legacy_role_tokens[1]
    END
  )
);

INSERT INTO team_member_authorizations (organization_id, member_id, user_id, legacy_role_tokens, fixed_role)
SELECT "organizationId", id, "userId", tokens,
  CASE WHEN tokens IN (ARRAY['owner'], ARRAY['admin'], ARRAY['member']) THEN tokens[1] END
FROM auth.member
CROSS JOIN LATERAL (SELECT custom_role_fixed_tokens(role) AS tokens) AS snapshot;

CREATE FUNCTION guard_team_member_authorization_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT FROM auth.member WHERE id = OLD.member_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a live membership authorization cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_member_authorization_generation_transition';
  END IF;
  IF (NEW.organization_id, NEW.member_id, NEW.user_id) IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.user_id) OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'a membership incarnation is stable and its authorization generation never decreases'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_member_authorization_generation_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_member_authorization_generation_guard BEFORE UPDATE OR DELETE ON team_member_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_team_member_authorization_generation();

CREATE TABLE custom_roles (
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  active_revision integer NOT NULL,
  archived_at timestamptz,
  CONSTRAINT custom_role_scope UNIQUE (organization_id, id)
);
CREATE TABLE custom_role_revisions (
  organization_id uuid,
  role_id uuid,
  revision integer,
  catalogue_version integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  permission_ids text[] NOT NULL,
  PRIMARY KEY (organization_id, role_id, revision),
  CONSTRAINT custom_role_revision_role FOREIGN KEY (organization_id, role_id)
    REFERENCES custom_roles (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_role_revision_number CHECK (revision > 0),
  CONSTRAINT custom_role_revision_name CHECK (char_length(btrim(name)) > 0 AND char_length(name) <= 100),
  CONSTRAINT custom_role_revision_permissions CHECK (
    custom_role_permission_set_valid(catalogue_version, permission_ids, false)
  )
);
ALTER TABLE custom_roles ADD CONSTRAINT custom_role_active_revision
  FOREIGN KEY (organization_id, id, active_revision)
  REFERENCES custom_role_revisions (organization_id, role_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_custom_role_organization_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Serialize role creation with personal marking on the same organization. Write a
  -- row version so a concurrent repeatable-read transaction cannot use a stale snapshot.
  UPDATE auth.organization SET "createdAt" = "createdAt" WHERE id = NEW.organization_id;
  IF TG_TABLE_NAME = 'custom_roles' THEN
    IF EXISTS (SELECT FROM personal_organizations WHERE organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'custom roles belong to team organizations'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_team_organization';
    END IF;
  ELSIF EXISTS (SELECT FROM custom_roles WHERE organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'an organization with custom roles cannot become personal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'personal_organization_has_custom_roles';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_role_team_guard BEFORE INSERT ON custom_roles
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_organization_kind();
CREATE TRIGGER personal_organization_custom_roles_guard
  BEFORE INSERT OR UPDATE OF organization_id ON personal_organizations
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_organization_kind();

CREATE FUNCTION guard_custom_role_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Deleting the parent during team cleanup can cascade through role history.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT FROM custom_roles WHERE organization_id = OLD.organization_id AND id = OLD.role_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'published role revision history is immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_revision_immutable';
END
$$;
CREATE TRIGGER custom_role_revision_guard BEFORE UPDATE OR DELETE ON custom_role_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_revision();

CREATE TABLE custom_role_assignments (
  organization_id uuid,
  member_id uuid,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  -- Historical actor ID survives their departure. Live actor/proof checks belong to the writer.
  assigned_by_user_id uuid NOT NULL,
  PRIMARY KEY (organization_id, member_id),
  CONSTRAINT custom_role_assignment_member FOREIGN KEY (organization_id, member_id, user_id)
    REFERENCES team_member_authorizations (organization_id, member_id, user_id) ON DELETE CASCADE,
  CONSTRAINT custom_role_assignment_role FOREIGN KEY (organization_id, role_id)
    REFERENCES custom_roles (organization_id, id),
  CONSTRAINT custom_role_assignment_other_user CHECK (user_id <> assigned_by_user_id)
);

CREATE FUNCTION guard_custom_role_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fixed_role text;
  role_archived_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.member_id, NEW.user_id)
    IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.user_id) THEN
    RAISE EXCEPTION 'a role assignment cannot change its membership incarnation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_assignment_incarnation';
  END IF;
  SELECT role INTO fixed_role FROM auth.member
  WHERE "organizationId" = NEW.organization_id AND id = NEW.member_id AND "userId" = NEW.user_id
  FOR SHARE;
  IF FOUND AND custom_role_fixed_tokens(fixed_role) <> ARRAY['member'] THEN
    RAISE EXCEPTION 'only a fixed Member can hold a custom role'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_assignment_base_member';
  END IF;
  SELECT archived_at INTO role_archived_at FROM custom_roles
  WHERE organization_id = NEW.organization_id AND id = NEW.role_id
  FOR SHARE;
  IF role_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'an archived role cannot be assigned'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_assignment_active_role';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_role_assignment_guard BEFORE INSERT OR UPDATE ON custom_role_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_assignment();

CREATE FUNCTION advance_custom_role_assignment_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role_id = OLD.role_id THEN
    RETURN NULL;
  END IF;
  UPDATE team_member_authorizations
  SET generation = generation + 1
  WHERE organization_id = coalesce(NEW.organization_id, OLD.organization_id)
    AND member_id = coalesce(NEW.member_id, OLD.member_id)
    AND user_id = coalesce(NEW.user_id, OLD.user_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER custom_role_assignment_generation AFTER INSERT OR UPDATE OR DELETE ON custom_role_assignments
  FOR EACH ROW EXECUTE FUNCTION advance_custom_role_assignment_generation();

CREATE FUNCTION guard_custom_role_publish() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'roles keep their identity and history when archived'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_revision_transition';
  END IF;
  IF (NEW.organization_id, NEW.id) IS DISTINCT FROM (OLD.organization_id, OLD.id)
    OR NEW.active_revision < OLD.active_revision THEN
    RAISE EXCEPTION 'role identity is stable and active revisions never go backward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_revision_transition';
  END IF;
  IF NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT FROM custom_role_assignments WHERE organization_id = NEW.organization_id AND role_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a role in use cannot be archived'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'custom_role_archive_in_use';
  END IF;
  IF NEW.active_revision > OLD.active_revision THEN
    UPDATE team_member_authorizations AS member
    SET generation = member.generation + 1
    FROM custom_role_assignments AS assignment
    WHERE assignment.organization_id = NEW.organization_id AND assignment.role_id = NEW.id
      AND (member.organization_id, member.member_id, member.user_id) =
          (assignment.organization_id, assignment.member_id, assignment.user_id);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER custom_role_publish_guard BEFORE UPDATE OR DELETE ON custom_roles
  FOR EACH ROW EXECUTE FUNCTION guard_custom_role_publish();

-- Start with no trustworthy per-credential ceiling records. Neither a current fixed role
-- nor an existing credential's scope can establish what it was originally issued to do.
CREATE TABLE team_credential_authorizations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  member_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid REFERENCES auth.session(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES auth.apikey(id) ON DELETE CASCADE,
  oauth_grant_id uuid REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  policy_epoch integer NOT NULL,
  master_epoch integer NOT NULL,
  member_generation integer NOT NULL,
  credential_generation integer NOT NULL DEFAULT 1,
  catalogue_version integer NOT NULL DEFAULT 1,
  permission_ids text[] NOT NULL,
  CONSTRAINT team_credential_authorization_member FOREIGN KEY (organization_id, member_id, user_id)
    REFERENCES team_member_authorizations (organization_id, member_id, user_id) ON DELETE CASCADE,
  CONSTRAINT team_credential_authorization_kind CHECK (num_nonnulls(session_id, api_key_id, oauth_grant_id) = 1),
  CONSTRAINT team_credential_authorization_versions CHECK (
    policy_epoch >= 0 AND master_epoch >= 0 AND member_generation > 0 AND credential_generation > 0
  ),
  CONSTRAINT team_credential_authorization_permissions CHECK (
    custom_role_permission_set_valid(catalogue_version, permission_ids, true)
  ),
  UNIQUE (organization_id, session_id),
  UNIQUE (api_key_id),
  UNIQUE (oauth_grant_id)
);

CREATE FUNCTION guard_team_credential_authorization() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'replace the issued ceiling record on explicit renewal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_credential_authorization_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A session can be explicitly renewed in place. A key or grant needs a new identity.
    -- The old ceiling can disappear when the credential or its membership is deleted.
    IF (
      EXISTS (SELECT FROM auth.apikey WHERE id = OLD.api_key_id)
      OR EXISTS (SELECT FROM mcp_oauth_grants WHERE id = OLD.oauth_grant_id)
    ) AND EXISTS (
      SELECT FROM team_member_authorizations
      WHERE member_id = OLD.member_id
    ) THEN
      RAISE EXCEPTION 'a live key or OAuth grant cannot exchange its issued ceiling'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'team_credential_authorization_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT FROM auth.session WHERE id = NEW.session_id AND "userId" <> NEW.user_id
  ) OR EXISTS (
    SELECT FROM auth.apikey WHERE id = NEW.api_key_id AND (
      "referenceId" <> NEW.user_id::text OR
      CASE WHEN pg_input_is_valid(metadata, 'jsonb')
        THEN lower(metadata::jsonb ->> 'organizationId')
      END IS DISTINCT FROM NEW.organization_id::text
    )
  ) OR EXISTS (
    SELECT FROM mcp_oauth_grants WHERE id = NEW.oauth_grant_id
      AND (user_id <> NEW.user_id OR organization_id <> NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'an issued ceiling binds the credential owner and its team when team-scoped'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'team_credential_authorization_owner';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_credential_authorization_guard BEFORE INSERT OR UPDATE OR DELETE ON team_credential_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_team_credential_authorization();

-- SCIM relies on its independent directory protocol. The existing connection association
-- already identifies the exact token, connection and team, including through secret rotation.
CREATE TABLE scim_token_protocol_versions (
  token_id uuid PRIMARY KEY REFERENCES scim_token_connections(token_id) ON DELETE CASCADE,
  protocol_version integer NOT NULL DEFAULT 1,
  CONSTRAINT scim_token_protocol_version CHECK (protocol_version = 1)
);
INSERT INTO scim_token_protocol_versions (token_id) SELECT token_id FROM scim_token_connections;
-- Extend the audit journal details allow-list for custom-role transitions.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_details_check CHECK (
  jsonb_typeof(details) = 'object' AND
  CASE
    -- Record changed public addresses and whether the name changed, without storing names.
    WHEN action = 'organization.updated' THEN details - ARRAY['oldSlug','newSlug','nameChanged'] = '{}'::jsonb
      AND (NOT details ? 'nameChanged' OR details->'nameChanged' = 'true'::jsonb)
      AND (details ? 'oldSlug') = (details ? 'newSlug')
      AND (NOT details ? 'newSlug' OR (
        jsonb_typeof(details->'newSlug') = 'string'
        AND (details->>'newSlug') COLLATE "C" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
        AND (details->'oldSlug' = 'null'::jsonb OR (
          jsonb_typeof(details->'oldSlug') = 'string'
          AND (details->>'oldSlug') COLLATE "C" ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$'
        ))
      ))
    WHEN action = 'membership.role_changed' THEN details - ARRAY['oldRole','newRole'] = '{}'::jsonb
    WHEN action IN ('api_key.created','api_key.rotated') THEN details - 'scope' = '{}'::jsonb
    -- Each catalogue name present adds one to the sum, so the sum equals the length only when
    -- every element is a catalogue string and none repeats.
    WHEN action IN ('webhook.created','webhook.updated','webhook.deleted','webhook.secret_rotated','webhook.paused','webhook.resumed') THEN details - 'events' = '{}'::jsonb
      AND (NOT details ? 'events' OR CASE WHEN jsonb_typeof(details->'events') = 'array' THEN
        jsonb_array_length(details->'events') BETWEEN 1 AND 7
        AND jsonb_array_length(details->'events') = (details->'events' ? 'booking.created')::int
          + (details->'events' ? 'booking.rescheduled')::int
          + (details->'events' ? 'booking.cancelled')::int
          + (details->'events' ? 'booking.reschedule_requested')::int
          + (details->'events' ? 'booking.reschedule_request_expired')::int
          + (details->'events' ? 'booking.attendee_no_show_changed')::int
          + (details->'events' ? 'workflow.executed')::int
        ELSE false END)
    -- Slack's catalogue leaves out the attendee no-show change.
    WHEN action IN ('slack_destination.created','slack_destination.updated','slack_destination.deleted','slack_destination.paused','slack_destination.resumed','slack_destination.tested') THEN details - 'events' = '{}'::jsonb
      AND (NOT details ? 'events' OR CASE WHEN jsonb_typeof(details->'events') = 'array' THEN
        jsonb_array_length(details->'events') BETWEEN 1 AND 5
        AND jsonb_array_length(details->'events') = (details->'events' ? 'booking.created')::int
          + (details->'events' ? 'booking.rescheduled')::int
          + (details->'events' ? 'booking.cancelled')::int
          + (details->'events' ? 'booking.reschedule_requested')::int
          + (details->'events' ? 'booking.reschedule_request_expired')::int
        ELSE false END)
    WHEN action = 'oauth.token_revoked' THEN details - 'familySize' = '{}'::jsonb
    -- Which branding settings changed and how; never the image or the colour itself.
    WHEN action = 'organization.branding_updated' THEN details - ARRAY['logo','primaryColor'] = '{}'::jsonb
      AND details <> '{}'::jsonb
      AND (NOT details ? 'logo' OR coalesce(details->>'logo' IN ('uploaded','selected','removed'), false))
      AND (NOT details ? 'primaryColor' OR coalesce(details->>'primaryColor' IN ('set','cleared'), false))
    -- Which attendee (a lowercase UUID) and whether the change marked or unmarked them.
    WHEN action = 'booking.attendee_no_show_changed' THEN details - ARRAY['attendeeId','noShow'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'attendeeId') = 'string'
        AND details->>'attendeeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'noShow') = 'string'
        AND details->>'noShow' IN ('marked','unmarked'), false)
    -- SSO provider changes and the operator's re-sealing: the protocol, the provider (a UUIDv7)
    -- and the configuration revision it now has; never an issuer, client ID, secret or certificate.
    WHEN action IN ('sso_provider.created','sso_provider.updated','sso_provider.enabled','sso_provider.disabled','sso_provider.deleted','sso_provider.secret_rotated','sso_provider.certificate_rotated','sso_maintenance.key_rotated') THEN details - ARRAY['method','providerId','revision'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
    -- An SSO provider test: the same, whether it passed, and a listed reason code and the test
    -- attempt (a UUIDv7) when known.
    WHEN action = 'sso_provider.tested' THEN details - ARRAY['method','providerId','revision','outcome','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'outcome') = 'string' AND details->>'outcome' IN ('passed','failed'), false)
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified'), false))
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- A domain renewal check: passed, failed or unknown; never the domain or a DNS answer.
    WHEN action = 'sso_domain.renewed' THEN details - 'outcome' = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'outcome') = 'string' AND details->>'outcome' IN ('passed','failed','unknown'), false)
    -- Links, sign-ins, replays, JIT admission, delegations and proofs: the protocol and the
    -- provider, and the revision and the attempt when known; never a subject, an email, a token
    -- or an assertion.
    WHEN action IN ('sso_link.linked','sso_link.unlinked','sso_link.conflicted','sso_authentication.succeeded','sso_authentication.replay_rejected','sso_jit.admitted','sso_delegation.bound','sso_proof.revoked') THEN details - ARRAY['method','providerId','revision','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- A key moving teams invalidates its old binding with a fixed reason code.
    WHEN action = 'sso_delegation.revoked' THEN details - ARRAY['method','providerId','revision','correlationId','reason'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('key_moved_team'), false))
    -- Failed SSO sign-ins can record a SCIM suspension, with the same redacted fields.
    WHEN action = 'sso_authentication.failed' THEN details - ARRAY['method','providerId','revision','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified','scim_suspended'), false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- JIT refusals keep their existing reason codes.
    WHEN action = 'sso_jit.refused' THEN details - ARRAY['method','providerId','revision','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified'), false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- Enforcement policy changes, including the operator's recovery command: the policy revision.
    WHEN action IN ('sso_enforcement.enabled','sso_enforcement.disabled','sso_enforcement.updated','sso_maintenance.enforcement_disabled') THEN details - 'revision' = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
    -- A recovery use: the mailbox ceremony's attempt when known, never its capability.
    WHEN action = 'sso_recovery.used' THEN details - 'correlationId' = '{}'::jsonb
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- PUT keeps empty details. PATCH stores only its ordered, normalized operation names.
    WHEN action = 'scim_user.updated' THEN
      CASE WHEN jsonb_typeof(details->'operations') = 'array' THEN
        details - 'operations' = '{}'::jsonb
        AND jsonb_array_length(details->'operations') BETWEEN 1 AND 100
        AND (details->'operations') <@ '["add","replace","remove"]'::jsonb
      ELSE details = '{}'::jsonb END
    -- Legacy empty details stay valid. New rows carry only the workflow revision and trigger.
    WHEN action IN ('workflow.created','workflow.updated','workflow.enabled','workflow.disabled') THEN details = '{}'::jsonb OR (
      details - ARRAY['revision','trigger'] = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false))
    -- Tombstones identify the last definition revision.
    WHEN action = 'workflow.deleted' THEN details = '{}'::jsonb OR (
      details - 'revision' = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
    -- A preview records the candidate's trigger and a fixed reason code when a condition fails.
    WHEN action = 'workflow.previewed' THEN details = '{}'::jsonb OR (
      details - ARRAY['trigger','reason'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false)
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' = 'condition_false', false)))
    -- Keep legacy empty details valid. Execution records carry only revision, trigger and fixed reasons.
    WHEN action IN ('workflow.run_scheduled','workflow.run_cancelled','workflow.run_skipped','workflow.email_attempted','workflow.email_sent','workflow.email_rejected','workflow.email_delivery_unknown','workflow.webhook_queued','workflow.webhook_completed','workflow.webhook_failed') THEN details = '{}'::jsonb OR (
      details - ARRAY['revision','trigger','reason'] = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false)
      AND CASE
        WHEN action = 'workflow.run_skipped' THEN coalesce(jsonb_typeof(details->'reason') = 'string'
          AND details->>'reason' IN ('condition_false','existing_notification','minimum_gap','offset_not_future',
            'expired','budget_suppressed','render_limit','workflow_disabled','instance_disabled'), false)
        WHEN action = 'workflow.webhook_failed' THEN NOT details ? 'reason' OR coalesce(
          jsonb_typeof(details->'reason') = 'string' AND details->>'reason' = 'expired', false)
        ELSE NOT details ? 'reason'
      END)
    WHEN action = 'organization.ownership_transfer_offered' THEN details - 'targetMembershipId' = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'targetMembershipId') = 'string'
        AND details->>'targetMembershipId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    -- Custom-role changes use the journal's actor, target and time columns. Keep session
    -- identifiers out of these rows and allow only fixed, typed detail values.
    WHEN action IN ('custom_role.created','custom_role.revised','custom_role.archived','membership.custom_role_assigned','membership.custom_role_cleared','team.custom_roles_enabled','team.custom_roles_disabled') THEN coalesce(
      organization_id IS NOT NULL
      AND credential_id IS NULL
      AND (
        (actor_type = 'user' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND credential_type = 'session')
        OR (action = 'membership.custom_role_cleared' AND credential_type = 'none' AND (
          (actor_type IN ('user', 'scim_token') AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          OR (actor_type = 'system' AND actor_id = 'system')
        ))
      )
      AND CASE
        WHEN action LIKE 'custom_role.%' THEN target_type = 'custom_role' AND target_id = details->>'roleId'
        WHEN action LIKE 'membership.%' THEN target_type = 'membership' AND target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ELSE target_type = 'organization' AND target_id = organization_id::text
      END
      AND details->'outcome' = '"succeeded"'::jsonb
      AND jsonb_typeof(details->'masterEpoch') = 'number'
      AND details->>'masterEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
      AND details->'masterEpoch' <= '2147483647'::jsonb
      AND (NOT details ? 'roleId' OR (
        jsonb_typeof(details->'roleId') = 'string'
        AND details->>'roleId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      AND (NOT details ? 'oldRoleId' OR (
        jsonb_typeof(details->'oldRoleId') = 'string'
        AND details->>'oldRoleId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      AND (NOT details ? 'oldRevision' OR (
        jsonb_typeof(details->'oldRevision') = 'number'
        AND details->>'oldRevision' ~ '^[1-9][0-9]{0,9}$'
        AND details->'oldRevision' <= '2147483647'::jsonb))
      AND (NOT details ? 'newRevision' OR (
        jsonb_typeof(details->'newRevision') = 'number'
        AND details->>'newRevision' ~ '^[1-9][0-9]{0,9}$'
        AND details->'newRevision' <= '2147483647'::jsonb))
      AND (NOT details ? 'policyEpoch' OR (
        jsonb_typeof(details->'policyEpoch') = 'number'
        AND details->>'policyEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
        AND details->'policyEpoch' <= '2147483647'::jsonb))
      AND (NOT details ? 'personalDataPermissionIds' OR CASE
        WHEN jsonb_typeof(details->'personalDataPermissionIds') = 'array' THEN
          jsonb_array_length(details->'personalDataPermissionIds') BETWEEN 1 AND 4
          AND jsonb_array_length(details->'personalDataPermissionIds') =
            (details->'personalDataPermissionIds' ? 'event_types.generate_open_time_snippet')::int
            + (details->'personalDataPermissionIds' ? 'team_bookings.read')::int
            + (details->'personalDataPermissionIds' ? 'waitlists.read_settings')::int
            + (details->'personalDataPermissionIds' ? 'waitlists.update_settings')::int
        ELSE false END)
      AND CASE action
        WHEN 'custom_role.created' THEN
          details - ARRAY['roleId','newRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','newRevision','policyEpoch']
        WHEN 'custom_role.revised' THEN
          details - ARRAY['roleId','oldRevision','newRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','newRevision','policyEpoch']
          AND details->'newRevision' > details->'oldRevision'
        WHEN 'custom_role.archived' THEN
          details - ARRAY['roleId','oldRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','policyEpoch']
        WHEN 'membership.custom_role_assigned' THEN
          details - ARRAY['roleId','oldRoleId','oldRevision','newRevision','policyEpoch','masterEpoch','outcome','personalDataPermissionIds'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','newRevision','policyEpoch']
          AND (details ? 'oldRoleId') = (details ? 'oldRevision')
        WHEN 'membership.custom_role_cleared' THEN
          details - ARRAY['roleId','oldRevision','policyEpoch','masterEpoch','outcome','personalDataPermissionIds'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','policyEpoch']
        ELSE details - ARRAY['oldPolicyEpoch','newPolicyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND jsonb_typeof(details->'oldPolicyEpoch') = 'number'
          AND jsonb_typeof(details->'newPolicyEpoch') = 'number'
          AND details->>'oldPolicyEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
          AND details->>'newPolicyEpoch' ~ '^[1-9][0-9]{0,9}$'
          AND details->'newPolicyEpoch' <= '2147483647'::jsonb
          AND details->'newPolicyEpoch' > details->'oldPolicyEpoch'
      END, false)
    ELSE details = '{}'::jsonb
  END
) NOT VALID;
-- The runner applies each file in one transaction, so the ACCESS EXCLUSIVE lock taken above is
-- still held while existing rows are validated.
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;
