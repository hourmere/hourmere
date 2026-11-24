import { type Expression, sql, type Transaction } from 'kysely'
import { writeAuditEvent } from './audit.ts'
import type { Database } from './index.ts'

interface ScimMembershipSuspension {
  organizationId: string
  userId: string
  connectionId: string
  scimUserId: string
}

/** Persist a suspension and revoke team credentials in the caller's READ COMMITTED transaction. */
export async function suspendScimMembership(
  trx: Transaction<Database>,
  { organizationId, userId, connectionId, scimUserId }: ScimMembershipSuspension,
  actor: { type: 'scim_token'; id: string } | { type: 'system' },
  { reuseExistingBlock = false } = {},
) {
  // Team selection and proof issuance take the corresponding team lock before
  // checking suspension. They can finish before revocation or see the committed block.
  await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('personal_organizations')
            .select('organization_id')
            .where('organization_id', '=', organizationId),
        ),
      ),
    )
    .forUpdate()
    .executeTakeFirstOrThrow()

  // Sessions can carry proofs for several teams. Serialize suspensions of this account
  // so two teams cannot each delete a session whose proofs the other needs to remove.
  await lockScimCredentialRevocation(trx, userId)

  // Retirement also revokes credentials for a User that was already suspended, keeping
  // that User's original blocker and its attribution intact.
  const existingBlock = reuseExistingBlock
    ? await trx
        .selectFrom('scim_membership_blocks')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('user_id', '=', userId)
        .where('source', '=', 'scim')
        .where('kind', '=', 'suspension')
        .where('connection_id', '=', connectionId)
        .where('scim_user_id', '=', scimUserId)
        .where('cleared_at', 'is', null)
        .executeTakeFirst()
    : undefined
  const block =
    existingBlock ??
    (await trx
      .insertInto('scim_membership_blocks')
      .columns(['organization_id', 'user_id', 'source', 'kind', 'connection_id', 'scim_user_id'])
      .expression((eb) =>
        eb
          .selectFrom('scim_users')
          .select([
            'organization_id',
            'linked_user_id',
            eb.val('scim').as('source'),
            eb.val('suspension').as('kind'),
            'connection_id',
            'id',
          ])
          .where('organization_id', '=', organizationId)
          .where('connection_id', '=', connectionId)
          .where('id', '=', scimUserId)
          .where('linked_user_id', '=', userId)
          .where('retired_at', 'is', null),
      )
      .returning('id')
      .executeTakeFirstOrThrow())

  await revokeScimTeamCredentials(trx, organizationId, userId)
  await writeAuditEvent(trx, {
    organizationId,
    actor: actor.type === 'system' ? { type: 'system', id: 'scim' } : actor,
    credential: { type: 'none' },
    action: 'scim_user.credentials_revoked',
    targetType: 'scim_user',
    targetId: scimUserId,
  })
  return block
}

export async function lockScimCredentialRevocation(trx: Transaction<Database>, userId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.scim-session-revocation:${userId.toLowerCase()}`}, 0))`.execute(
    trx,
  )
}

/** The caller holds the organization write lock and the account revocation advisory lock. */
export async function revokeScimTeamCredentials(
  trx: Transaction<Database>,
  organizationId: string,
  userId: string,
) {
  // Delete by indexed account ID in one batch. A simultaneous rolling refresh only
  // updates the existing row, so it either completes before deletion or finds no session.
  await trx
    .deleteFrom('auth.session')
    .where('userId', '=', userId)
    .where(sql<string>`lower("activeOrganizationId")`, '=', organizationId.toLowerCase())
    .execute()

  // Deleting a session cascades its proofs. Remove the team's proofs on surviving
  // sessions through the member index, keeping their other team proofs usable.
  await trx
    .deleteFrom('sso_browser_proofs')
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .where('member_id', 'in', (eb) =>
      eb
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', userId),
    )
    .execute()

  // Match 0178's index, including mixed-case IDs. Missing organization metadata
  // falls back to personal space and does not match this team.
  const keyOrganization = sql<string>`auth.scim_api_key_organization_id(metadata)`
  await trx
    .deleteFrom('auth.apikey')
    .where(sql<boolean>`length("referenceId") = 36 AND length(${keyOrganization}) = 36`)
    .where(sql<string>`lower("referenceId")`, '=', userId.toLowerCase())
    .where(keyOrganization, '=', organizationId.toLowerCase())
    .execute()

  const grantReferences = trx
    .selectFrom('mcp_oauth_grants')
    .select(sql<string>`id::text`.as('referenceId'))
    .where('user_id', '=', userId)
    .where('organization_id', '=', organizationId)

  // Scope the provider rows by grant, since one client may have consent in several spaces.
  await trx
    .deleteFrom('auth.oauthAccessToken')
    .where('userId', '=', userId)
    .where('referenceId', 'in', grantReferences)
    .execute()
  await trx
    .deleteFrom('auth.oauthRefreshToken')
    .where('userId', '=', userId)
    .where('referenceId', 'in', grantReferences)
    .execute()
  await trx
    .deleteFrom('auth.oauthConsent')
    .where('userId', '=', userId)
    .where('referenceId', 'in', grantReferences)
    .execute()
  // Deleting the key or grant cascades to its SSO delegation binding. Codes, intents
  // and JWTs issued against the deleted grant cannot authorize against a new grant ID.
  await trx
    .deleteFrom('mcp_oauth_grants')
    .where('user_id', '=', userId)
    .where('organization_id', '=', organizationId)
    .execute()
}

/** Project whether the team already has SCIM storage without a separate lookup. */
export function scimProvisioned(organizationId: Expression<string>) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM scim_connections WHERE organization_id = ${organizationId}::uuid
  )`
}

/** Match a live directory link to a current member, including after local readmission. */
export function scimManagedMember(
  organizationId: Expression<string> | string,
  userId: Expression<string> | string,
) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM scim_users AS managed
    JOIN auth.member AS membership ON membership."organizationId" = managed.organization_id
      AND membership."userId" = managed.linked_user_id
    WHERE managed.organization_id = ${organizationId}::uuid
      AND managed.linked_user_id = ${userId}::uuid AND managed.retired_at IS NULL
  )`
}

/**
 * Embed the account's live team suspension in an existing authorization statement.
 *
 * `managedChildren` is the SCIM resource capability, passed by callers that hold it. Only
 * then does the statement also read the suspension of a membership a Group sourced; without
 * it the statement is unchanged and reads nothing that the Group storage added.
 */
export function scimSuspended(
  organizationId: Expression<string> | string,
  userId: Expression<string> | string,
  managedChildren = false,
) {
  const suspended = sql<boolean>`CASE WHEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = ${organizationId}::uuid AND block.user_id = ${userId}::uuid
      AND block.source = 'scim' AND block.kind = 'suspension' AND block.cleared_at IS NULL
  ) THEN NOT EXISTS (
    SELECT 1 FROM personal_organizations AS personal
    WHERE personal.organization_id = ${organizationId}::uuid
  ) ELSE false END`
  if (!managedChildren) return suspended
  // A mapped child has no connection of its own. Its suspension follows the roster
  // source, so it is stored with the managed membership and ends with it.
  return sql<boolean>`(${suspended} OR EXISTS (
    SELECT 1 FROM scim_team_managed_memberships AS managed_source
    WHERE managed_source.child_organization_id = ${organizationId}::uuid
      AND managed_source.user_id = ${userId}::uuid AND managed_source.suspended_at IS NOT NULL
  ))`
}
