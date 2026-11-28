-- A new team's policy starts off. Personal-space creation inserts its marker
-- after the organization, so wait until the transaction can see that marker.
CREATE FUNCTION initialize_team_custom_role_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO team_custom_role_policies (organization_id)
  SELECT id FROM auth.organization WHERE id = NEW.id
    AND NOT EXISTS (SELECT FROM personal_organizations WHERE organization_id = NEW.id)
  ON CONFLICT (organization_id) DO NOTHING;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER team_custom_role_policy_initialize
  AFTER INSERT ON auth.organization DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION initialize_team_custom_role_policy();

CREATE FUNCTION clear_ineligible_custom_role_assignment(team_id uuid, membership_id uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  removed record;
  personal_permissions text[];
BEGIN
  WITH deleted AS (
    DELETE FROM custom_role_assignments
    WHERE organization_id = team_id AND member_id = membership_id
    RETURNING role_id
  )
  SELECT role.id AS role_id, role.active_revision, revision.permission_ids INTO removed
  FROM deleted
  JOIN custom_roles AS role ON role.organization_id = team_id AND role.id = deleted.role_id
  LEFT JOIN custom_role_revisions AS revision
    ON (revision.organization_id, revision.role_id, revision.revision) =
       (role.organization_id, role.id, role.active_revision);

  IF FOUND THEN
    -- The assignment DELETE trigger already advances the generation. Keep the
    -- automatic clearance journal entry in the same transaction as the role change.
    SELECT array_agg(permission ORDER BY permission) INTO personal_permissions
    FROM unnest(removed.permission_ids) AS p(permission)
    WHERE permission IN ('event_types.generate_open_time_snippet', 'team_bookings.read',
      'waitlists.read_settings', 'waitlists.update_settings');

    INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
      action, target_type, target_id, details)
    VALUES (team_id, 'system', 'system', 'none', 'membership.custom_role_cleared',
      'membership', membership_id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'roleId', removed.role_id,
        'oldRevision', removed.active_revision,
        'policyEpoch', coalesce((SELECT policy_epoch FROM team_custom_role_policies
          WHERE organization_id = team_id), 0),
        'masterEpoch', (SELECT policy_epoch FROM custom_role_master_policy WHERE singleton),
        'outcome', 'succeeded',
        'personalDataPermissionIds', personal_permissions
      )));
  END IF;
END
$$;

CREATE FUNCTION sync_team_member_authorization() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  tokens text[] := custom_role_fixed_tokens(NEW.role);
BEGIN
  IF TG_OP = 'UPDATE' AND tokens <> ARRAY['member'] THEN
    PERFORM clear_ineligible_custom_role_assignment(NEW."organizationId", NEW.id);
  END IF;

  INSERT INTO team_member_authorizations
    (organization_id, member_id, user_id, legacy_role_tokens, fixed_role)
  VALUES (NEW."organizationId", NEW.id, NEW."userId", tokens,
    CASE WHEN tokens IN (ARRAY['owner'], ARRAY['admin'], ARRAY['member']) THEN tokens[1] END)
  ON CONFLICT (member_id) DO UPDATE
    SET legacy_role_tokens = excluded.legacy_role_tokens, fixed_role = excluded.fixed_role
    WHERE (team_member_authorizations.legacy_role_tokens, team_member_authorizations.fixed_role)
      IS DISTINCT FROM (excluded.legacy_role_tokens, excluded.fixed_role);
  RETURN NULL;
END
$$;

CREATE TRIGGER team_member_authorization_sync
  AFTER INSERT OR UPDATE OF role ON auth.member
  FOR EACH ROW EXECUTE FUNCTION sync_team_member_authorization();

-- Reconcile rows created or changed after the storage migration without rewriting
-- native memberships, credentials, owner tokens or established generations.
INSERT INTO team_custom_role_policies (organization_id)
SELECT id FROM auth.organization AS org
WHERE NOT EXISTS (SELECT FROM personal_organizations WHERE organization_id = org.id)
ON CONFLICT (organization_id) DO NOTHING;

SELECT clear_ineligible_custom_role_assignment(member."organizationId", member.id)
FROM auth.member AS member
JOIN custom_role_assignments AS assignment
  ON assignment.organization_id = member."organizationId" AND assignment.member_id = member.id
WHERE custom_role_fixed_tokens(member.role) <> ARRAY['member'];

INSERT INTO team_member_authorizations
  (organization_id, member_id, user_id, legacy_role_tokens, fixed_role)
SELECT "organizationId", id, "userId", tokens,
  CASE WHEN tokens IN (ARRAY['owner'], ARRAY['admin'], ARRAY['member']) THEN tokens[1] END
FROM auth.member
CROSS JOIN LATERAL (SELECT custom_role_fixed_tokens(role) AS tokens) AS snapshot
ON CONFLICT (member_id) DO UPDATE
  SET legacy_role_tokens = excluded.legacy_role_tokens, fixed_role = excluded.fixed_role
  WHERE (team_member_authorizations.legacy_role_tokens, team_member_authorizations.fixed_role)
    IS DISTINCT FROM (excluded.legacy_role_tokens, excluded.fixed_role);
