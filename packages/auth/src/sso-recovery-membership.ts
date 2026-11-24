import type { Database, Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql, type Transaction } from 'kysely'
import { jsonArrayFrom } from 'kysely/helpers/postgres'
import type { Principal } from './caller.ts'

export class SsoRecoveryRequiredError extends Error {
  readonly code = 'sso_recovery_required'

  constructor() {
    super('sso_recovery_required')
  }
}

/** Project onto an existing auth.member read, without an extra query on ordinary teams. */
export const ssoRecoveryOwner = sql<boolean>`EXISTS (
  SELECT 1 FROM sso_recovery_owners WHERE member_id = "member".id
)`.as('recoveryOwner')

function currentRecoveryOwners(db: Db) {
  return db
    .selectFrom('sso_recovery_owners as recovery')
    .innerJoin('auth.member as member', (join) =>
      join
        .onRef('member.id', '=', 'recovery.member_id')
        .onRef('member.organizationId', '=', 'recovery.organization_id')
        .onRef('member.userId', '=', 'recovery.user_id'),
    )
    .where(sql<boolean>`'owner' = ANY (
      SELECT btrim(token) FROM unnest(string_to_array("member".role, ',')) AS roles(token)
    )`)
}

function recoveryOwnersInOrganization(db: Db, organizationId: string) {
  return currentRecoveryOwners(db)
    .select('recovery.member_id')
    .where('recovery.organization_id', '=', organizationId)
}

export interface SsoRecoveryTeam {
  id: string
  displayName: string
  policyRevision: number
}

/** Project the caller's recovery targets in the existing membership SELECT. */
export function ssoRecoveryTeamsFor(
  db: Db,
  userId: string,
  sessionId: string,
  scimResourcesEnabled = false,
) {
  return jsonArrayFrom(
    currentRecoveryOwners(db)
      .innerJoin('sso_policies as policy', 'policy.organization_id', 'recovery.organization_id')
      .innerJoin('auth.organization as team', 'team.id', 'recovery.organization_id')
      .select(['team.id', 'team.name as displayName', 'policy.policy_revision as policyRevision'])
      .where('recovery.user_id', '=', userId)
      .where('policy.require_sso', '=', true)
      .where((eb) => eb.not(scimSuspended(eb.ref('team.id'), userId, scimResourcesEnabled)))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('auth.session as session')
            .select('session.id')
            .where('session.id', '=', sessionId)
            .where('session.userId', '=', userId)
            .where('session.expiresAt', '>', sql<Date>`statement_timestamp()`),
        ),
      )
      .orderBy('team.id'),
  )
}

/** Use under the organization write lock, which also serializes changes to owner standing. */
export function currentSsoRecoveryOwner(db: Db, organizationId: string, userId?: string) {
  const owners = recoveryOwnersInOrganization(db, organizationId)
  return (userId === undefined ? owners : owners.where('recovery.user_id', '=', userId))
    .limit(1)
    .executeTakeFirst()
}

/** Better Auth has already refused the departure. Classify its early sole-owner response. */
export function soleOwnerDepartureFlags(db: Db, organizationId: string, userId: string) {
  const owners = recoveryOwnersInOrganization(db, organizationId)
  return db
    .selectNoFrom((eb) => [
      eb
        .exists(
          db
            .selectFrom('personal_organizations')
            .select('user_id')
            .where('organization_id', '=', organizationId),
        )
        .as('personal'),
      eb
        .and([
          eb.exists(
            db
              .selectFrom('sso_policies')
              .select('organization_id')
              .where('organization_id', '=', organizationId)
              .where('require_sso', '=', true),
          ),
          eb.exists(owners.where('recovery.user_id', '=', userId)),
          eb.not(eb.exists(owners.where('recovery.user_id', '!=', userId))),
        ])
        .as('recoveryRequired'),
    ])
    .executeTakeFirstOrThrow()
}

/** The caller holds the organization write lock. Recovery changes keep live proofs valid. */
export function advanceSsoRecoveryRevision(trx: Db, organizationId: string) {
  return trx
    .insertInto('sso_policies')
    .values({ organization_id: organizationId, policy_revision: 2 })
    .onConflict((conflict) =>
      conflict.column('organization_id').doUpdateSet({
        policy_revision: sql<number>`sso_policies.policy_revision + 1`,
      }),
    )
    .returning('policy_revision')
    .executeTakeFirstOrThrow()
}

/**
 * The organization write lock orders this check and deletion with recovery enrollment.
 * The policy row is locked FOR UPDATE before the caller's proof check takes it FOR SHARE,
 * so the revision advance below never upgrades a share lock (org -> policy order).
 */
export async function removeSsoRecoveryOwner(
  trx: Transaction<Database>,
  principal: Principal,
  {
    organizationId,
    userId,
    isOwner,
    checkProof,
  }: {
    organizationId: string
    userId: string
    isOwner: boolean
    checkProof: () => Promise<unknown>
  },
  requestId?: string,
) {
  if (!trx.isTransaction) throw new Error('Recovery membership writes require a transaction')
  const policy = await trx
    .selectFrom('sso_policies')
    .select('require_sso')
    .where('organization_id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst()
  await checkProof()
  if (isOwner && policy?.require_sso) {
    const replacement = await recoveryOwnersInOrganization(trx, organizationId)
      .where('recovery.user_id', '!=', userId)
      .limit(1)
      .executeTakeFirst()
    if (!replacement) throw new SsoRecoveryRequiredError()
  }
  const removed = await trx
    .deleteFrom('sso_recovery_owners')
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
    .returning('member_id')
    .executeTakeFirstOrThrow()
  await advanceSsoRecoveryRevision(trx, organizationId)
  await writeSsoAuditEvent(trx, {
    organizationId,
    ...auditActor(principal),
    action: 'sso_recovery.removed',
    targetType: 'member',
    targetId: removed.member_id,
    requestId,
    details: {},
  })
}
