-- The runner applies each migration in a transaction, so the index builds take
-- write-blocking locks. Bound both the wait for the lock and the builds.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

-- Deactivating the source User suspends the child membership it sourced. The
-- suspension lives on the provenance row, so it ends when that membership does.
ALTER TABLE scim_team_managed_memberships ADD COLUMN suspended_at timestamptz;

-- Source User lifecycle writes and deletion checks on scim_users find their roster rows.
CREATE INDEX scim_team_managed_memberships_scim_user_idx
  ON scim_team_managed_memberships (scim_user_id);

-- Authorization checks whether the account's membership in this team is suspended.
CREATE INDEX scim_team_managed_memberships_suspended_idx
  ON scim_team_managed_memberships (child_organization_id, user_id)
  WHERE suspended_at IS NOT NULL;
