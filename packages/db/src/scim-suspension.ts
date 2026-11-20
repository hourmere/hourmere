import { type Expression, sql } from 'kysely'

/** Embed the account's live team suspension in an existing authorization statement. */
export function scimSuspended(
  organizationId: Expression<string> | string,
  userId: Expression<string> | string,
) {
  return sql<boolean>`CASE WHEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = ${organizationId}::uuid AND block.user_id = ${userId}::uuid
      AND block.source = 'scim' AND block.kind = 'suspension' AND block.cleared_at IS NULL
  ) THEN NOT EXISTS (
    SELECT 1 FROM personal_organizations AS personal
    WHERE personal.organization_id = ${organizationId}::uuid
  ) ELSE false END`
}
