import { randomUUID } from 'node:crypto'
import {
  lockTeamSsoProof,
  type Principal,
  removeSsoRecoveryOwner,
  SsoRecoveryRequiredError,
  TeamManagementError,
  teamRoles,
  teamSession,
  teamSsoAccess,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { retirePendingOwnershipTransfer } from '@hourmere/db/ownership-transfer'
import { scimManagedMember, scimSuspended } from '@hourmere/db/scim-suspension'
import { checkTeamWriteDeadline } from '@hourmere/db/team-write'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import {
  enqueueOwnershipTransferNotice,
  type OwnershipTransferNoticeQueue,
} from './ownership-transfer-notices.ts'
import { CONFIRM_OWNERSHIP_TRANSFER, CREATE_OWNERSHIP_TRANSFER } from './sso.ts'
import { type FreshProofDeps, type FreshProofResult, runWithFreshProof } from './sso-fresh-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextWriteLock } from './team-management.ts'

export interface OwnershipTransferDeps extends FreshProofDeps {
  notificationQueue: OwnershipTransferNoticeQueue
}

type Tx = Transaction<Database>
type SessionPrincipal = Extract<Principal, { kind: 'session' }>
type TransferOperation = typeof CREATE_OWNERSHIP_TRANSFER | typeof CONFIRM_OWNERSHIP_TRANSFER
const uuid = z.uuid().transform((id) => id.toLowerCase())
const transferState = z.enum(['pending', 'confirmed', 'revoked', 'expired', 'invalidated'])
const createInput = z.strictObject({ targetMembershipId: uuid })
const confirmInput = z.strictObject({ transferId: uuid })
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const unavailable = () => new DomainError('conflict', 'ownership_transfer_unavailable')
const pending = () => new DomainError('conflict', 'ownership_transfer_pending')
const contextChanged = () => new DomainError('conflict', 'organization_context_changed')
const retired = Symbol('retired ownership transfer')
function deny(): never {
  throw denied()
}

/** The migration's deadline trigger can win between the last clock read and the UPDATE. */
class TransferDeadlineReached extends Error {}

export class OwnershipTransferRateLimitError extends Error {
  readonly code = 'rate_limited'
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('rate_limited')
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function sessionPrincipal(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  write: boolean,
): SessionPrincipal {
  if (
    principal.kind !== 'session' ||
    !uuid.safeParse(principal.user.id).success ||
    !uuid.safeParse(principal.sessionId).success ||
    !uuid.safeParse(organizationId).success ||
    headers.has('authorization') ||
    (write && headers.get('origin') !== new URL(deps.publicUrl).origin)
  )
    throw denied()
  return principal
}

function findOffer(db: Db, organizationId: string, transferId?: string, lock = false) {
  let query = db
    .selectFrom('organization_ownership_transfers')
    .selectAll()
    .select(sql<boolean>`expires_at > clock_timestamp()`.as('unexpired'))
    .where('organization_id', '=', organizationId)
  query =
    transferId === undefined
      ? query.where('state', '=', 'pending')
      : query.where('id', '=', transferId)
  return (lock ? query.forUpdate() : query).executeTakeFirst()
}

async function teamMembers(db: Db, organizationId: string, userIds: string[], lock: boolean) {
  const query = db
    .selectFrom('auth.member as member')
    .innerJoin('auth.user as account', 'account.id', 'member.userId')
    .select(['member.id', 'member.userId', 'member.role', 'account.name', 'account.emailVerified'])
    .select((eb) => [
      scimSuspended(organizationId, eb.ref('member.userId'), true).as('suspended'),
      sql<boolean>`(
        ${scimManagedMember(organizationId, eb.ref('member.userId'))}
        OR EXISTS (
          SELECT 1 FROM scim_team_managed_memberships managed
          WHERE managed.child_organization_id = ${organizationId}::uuid
            AND managed.member_id = member.id
        )
      )`.as('managed'),
    ])
    .where('member.organizationId', '=', organizationId)
    .where('member.userId', 'in', userIds)
    .orderBy('member.id')
  return lock ? query.forUpdate('member').execute() : query.execute()
}

type Member = Awaited<ReturnType<typeof teamMembers>>[number]
type Offer = NonNullable<Awaited<ReturnType<typeof findOffer>>>

const owner = (member: Pick<Member, 'role'> | undefined) =>
  teamRoles(member?.role).includes('owner')
const eligibleRecipient = (member: Member | undefined) =>
  !owner(member) && teamRoles(member?.role).some((role) => role === 'admin' || role === 'member')
const effective = (member: Member | undefined): member is Member =>
  member?.emailVerified === true && !member.suspended

function participants(offer: Offer, members: Member[]) {
  const initiator = members.find(
    (m) => m.id === offer.initiator_membership_id && m.userId === offer.initiator_user_id,
  )
  const recipient = members.find(
    (m) => m.id === offer.target_membership_id && m.userId === offer.target_user_id,
  )
  return { initiator, recipient }
}

function structurallyEligible(initiator?: Member, recipient?: Member) {
  return (
    owner(initiator) && eligibleRecipient(recipient) && !initiator?.managed && !recipient?.managed
  )
}

async function authorizeActor(
  deps: OwnershipTransferDeps,
  db: Db,
  principal: SessionPrincipal,
  headers: Headers,
  organizationId: string,
  actor: Member | undefined,
  lock: boolean,
  requireOwner = false,
) {
  if (
    !effective(actor) ||
    (requireOwner ? !owner(actor) : !owner(actor) && !eligibleRecipient(actor))
  )
    throw denied()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('organization_id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (personal) throw denied()
  let session: Awaited<ReturnType<typeof teamSession>>
  try {
    session = await teamSession(db, principal, lock)
  } catch (error) {
    if (error instanceof TeamManagementError) throw denied()
    throw error
  }

  const identity = { userId: principal.user.id, sessionId: principal.sessionId }
  const deadline = lock
    ? await lockTeamSsoProof(deps, db, identity, organizationId, deny, { organizationLocked: true })
    : undefined
  if (!lock && !(await teamSsoAccess({ ...deps, db }, identity, organizationId)).allowed)
    throw denied()

  const expected = uuid.safeParse(headers.get(EXPECTED_ORGANIZATION_HEADER))
  if (
    !expected.success ||
    expected.data !== organizationId ||
    session.activeOrganizationId?.toLowerCase() !== organizationId
  )
    throw contextChanged()
  // For enforced teams the locked browser proof already includes the session deadline.
  return deadline ?? session.expiresAt.toISOString()
}

async function lockTeam(
  trx: Tx,
  principal: SessionPrincipal,
  organizationId: string,
  userIds: string[],
) {
  await organizationContextWriteLock(principal)(trx)
  await trx
    .selectFrom('auth.user')
    .select('id')
    .where('id', 'in', userIds)
    .orderBy('id')
    .forShare()
    .execute()
  const team = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (!team) throw denied()
}

function ensureActorDeadline(trx: Tx, deadline: string | undefined) {
  return checkTeamWriteDeadline(trx, deadline, deny)
}

function transferAudit(
  principal: SessionPrincipal,
  organizationId: string,
  action:
    | 'organization.ownership_transfer_offered'
    | 'organization.ownership_transfer_revoked'
    | 'organization.ownership_transferred',
  requestId?: string,
  details?: Record<string, unknown>,
) {
  return {
    ...auditActor(principal),
    organizationId,
    action,
    targetType: 'organization',
    targetId: organizationId,
    requestId,
    ...(details && { details }),
  }
}

async function debitBudget(trx: Tx, organizationId: string, operation: 'initiate' | 'revoke') {
  // Aligned one-hour windows give the revoke budget room for one carried-over offer.
  const limit = operation === 'initiate' ? 5 : 6
  const { rows } = await sql<{ debited: boolean; retry_after: number }>`
    WITH budget_window AS MATERIALIZED (
      SELECT date_bin(interval '1 hour', clock_timestamp(), timestamptz '2000-01-01 UTC') AS start
    ), debit AS (
      INSERT INTO organization_ownership_transfer_budgets
        (organization_id, operation, window_start, request_count)
      SELECT ${organizationId}::uuid, ${operation}, start, 1 FROM budget_window
      ON CONFLICT (organization_id, operation) DO UPDATE SET
        window_start = excluded.window_start,
        request_count = CASE WHEN organization_ownership_transfer_budgets.window_start = excluded.window_start
          THEN organization_ownership_transfer_budgets.request_count + 1 ELSE 1 END
      WHERE organization_ownership_transfer_budgets.window_start <> excluded.window_start
         OR organization_ownership_transfer_budgets.request_count < ${limit}
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM debit) AS debited,
      greatest(1, ceil(extract(epoch FROM start + interval '1 hour' - clock_timestamp())))::integer AS retry_after
    FROM budget_window`.execute(trx)
  const budget = rows[0]
  if (!budget) throw new Error('Ownership transfer budget could not be checked')
  if (!budget.debited) throw new OwnershipTransferRateLimitError(budget.retry_after)
}

async function transitionOffer(trx: Tx, offer: Offer, state: 'confirmed' | 'revoked') {
  const transition = await trx
    .updateTable('organization_ownership_transfers')
    .set({ state, terminal_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', offer.id)
    .where('organization_id', '=', offer.organization_id)
    .where('state', '=', 'pending')
    .where('expires_at', '>', sql<Date>`clock_timestamp()`)
    .returning('id')
    .executeTakeFirst()
  if (!transition) throw new TransferDeadlineReached()
}

async function retryAfterDeadline<T>(operation: () => Promise<T>) {
  try {
    return await operation()
  } catch (error) {
    // The first transaction rolled back, including proof consumption. Reauthorize and
    // retire using the same locked in-transaction path as any other expired offer.
    if (
      error instanceof TransferDeadlineReached ||
      (error instanceof Error &&
        'constraint' in error &&
        error.constraint === 'organization_ownership_transfers_expired')
    )
      return operation()
    throw error
  }
}

async function withTransferProof<T>(
  deps: OwnershipTransferDeps,
  principal: SessionPrincipal,
  headers: Headers,
  organizationId: string,
  operation: TransferOperation,
  affectedUserId: string,
  input: unknown,
  callbacks: {
    authorize: (trx: Tx) => Promise<void>
    beforeProof?: (trx: Tx) => Promise<typeof retired | undefined>
    mutate: (trx: Tx) => Promise<T>
  },
  recoveryUserIds?: string[],
): Promise<FreshProofResult<T>> {
  try {
    const result = await runWithFreshProof<T | typeof retired>(
      deps,
      {
        headers,
        userId: principal.user.id,
        sessionId: principal.sessionId,
        organizationId,
        operation,
        affectedUserId,
        ...(recoveryUserIds && { recoveryUserIds }),
        proofMode: 'administration',
        input,
        schema: operation === CREATE_OWNERSHIP_TRANSFER ? createInput : confirmInput,
      },
      {
        ...callbacks,
        beforeLocks: organizationContextWriteLock(principal),
      },
    )
    if (result.status === 'proof_required') return result
    if (result.value === retired) throw unavailable()
    return { ...result, value: result.value }
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    if (error instanceof SsoRecoveryRequiredError) throw new DomainError('conflict', error.code)
    throw error
  }
}

export async function createOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  input: { targetMembershipId: string; proofAttemptId?: string | undefined },
) {
  const actor = sessionPrincipal(deps, principal, headers, organizationId, true)
  organizationId = organizationId.toLowerCase()
  const targetId = uuid.safeParse(input.targetMembershipId)
  if (!targetId.success) throw new DomainError('invalid', 'invalid_request')
  const target = await deps.db
    .selectFrom('auth.member')
    .select('userId')
    .where('organizationId', '=', organizationId)
    .where('id', '=', targetId.data)
    .executeTakeFirst()
  if (!target) throw denied()
  let initiatorId: string
  let actorDeadline: string | undefined
  let previous: Offer | undefined

  return withTransferProof(
    deps,
    actor,
    headers,
    organizationId,
    CREATE_OWNERSHIP_TRANSFER,
    target.userId,
    input,
    {
      authorize: async (trx) => {
        const members = await teamMembers(trx, organizationId, [actor.user.id, target.userId], true)
        const initiator = members.find((m) => m.userId === actor.user.id)
        actorDeadline = await authorizeActor(
          deps,
          trx,
          actor,
          headers,
          organizationId,
          initiator,
          true,
          true,
        )
        if (!initiator) throw denied()
        if (initiator.managed) throw new DomainError('conflict', 'scim_managed_resource')
        const recipient = members.find((m) => m.id === targetId.data && m.userId === target.userId)
        if (!effective(recipient) || !eligibleRecipient(recipient) || recipient.managed)
          throw denied()
        initiatorId = initiator.id
        previous = await findOffer(trx, organizationId, undefined, true)
      },
      beforeProof: async (trx) => {
        await ensureActorDeadline(trx, actorDeadline)
        if (!previous) return
        const expired = await retirePendingOwnershipTransfer(trx, {
          organizationId,
          transferId: previous.id,
          expireOnly: true,
        })
        if (!expired) {
          const { initiator, recipient } = participants(
            previous,
            await teamMembers(
              trx,
              organizationId,
              [previous.initiator_user_id, previous.target_user_id],
              false,
            ),
          )
          if (structurallyEligible(initiator, recipient)) throw pending()
          await retirePendingOwnershipTransfer(trx, { organizationId, transferId: previous.id })
        }
      },
      mutate: async (trx) => {
        await debitBudget(trx, organizationId, 'initiate')
        const offer = await trx
          .insertInto('organization_ownership_transfers')
          .values({
            organization_id: organizationId,
            initiator_user_id: actor.user.id,
            initiator_membership_id: initiatorId,
            target_user_id: target.userId,
            target_membership_id: targetId.data,
            created_at: sql<Date>`clock_timestamp()`,
            expires_at: sql<Date>`clock_timestamp() + interval '24 hours'`,
          })
          .returning(['id', 'expires_at'])
          .executeTakeFirstOrThrow()
        await writeAuditEvent(
          trx,
          transferAudit(
            actor,
            organizationId,
            'organization.ownership_transfer_offered',
            undefined,
            { targetMembershipId: targetId.data },
          ),
        )
        await enqueueOwnershipTransferNotice(deps.notificationQueue, trx, {
          organizationId,
          kind: 'offered',
          transferId: offer.id,
          userIds: [target.userId],
        })
        await ensureActorDeadline(trx, actorDeadline)
        return { id: offer.id, expiresAt: offer.expires_at.toISOString() }
      },
    },
  )
}

async function clearRecovery(
  trx: Tx,
  actor: SessionPrincipal,
  initiator: Member,
  organizationId: string,
  policyEnforced: boolean,
  requestId: string,
  lockedRecoveryUserIds: string[],
) {
  const recovery = await trx
    .selectFrom('sso_recovery_owners')
    .select('member_id')
    .where('organization_id', '=', organizationId)
    .where('member_id', '=', initiator.id)
    .executeTakeFirst()
  if (recovery) {
    await removeSsoRecoveryOwner(
      trx,
      actor,
      {
        organizationId,
        userId: initiator.userId,
        isOwner: true,
        checkProof: async () => {
          if (!policyEnforced) return
          if (lockedRecoveryUserIds.length === 0) throw new SsoRecoveryRequiredError()
          const accepted = await trx
            .selectFrom('sso_recovery_owners')
            .select(['user_id', 'member_id'])
            .where('organization_id', '=', organizationId)
            .where('user_id', 'in', lockedRecoveryUserIds)
            .execute()
          const usable =
            accepted.length > 0 &&
            (
              await teamMembers(
                trx,
                organizationId,
                accepted.map(({ user_id }) => user_id),
                false,
              )
            ).some(
              (member) =>
                effective(member) &&
                owner(member) &&
                accepted.some(
                  (recovery) =>
                    recovery.user_id === member.userId && recovery.member_id === member.id,
                ),
            )
          if (!usable) throw new SsoRecoveryRequiredError()
        },
      },
      requestId,
    )
  }
  await trx
    .deleteFrom('sso_recovery_nominations')
    .where('organization_id', '=', organizationId)
    .where((eb) =>
      eb.or([
        eb('user_id', '=', initiator.userId),
        eb('nominated_by_user_id', '=', initiator.userId),
      ]),
    )
    .execute()
}

export async function confirmOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  transferId: string,
  input: { proofAttemptId?: string | undefined },
) {
  const actor = sessionPrincipal(deps, principal, headers, organizationId, true)
  organizationId = organizationId.toLowerCase()
  const id = uuid.safeParse(transferId)
  if (!id.success) throw denied()
  const binding = await findOffer(deps.db, organizationId, id.data)
  if (!binding || binding.target_user_id !== actor.user.id) throw denied()
  // Discover replacement accounts before taking the organization lock. Re-read their
  // accepted status and memberships under the team lock, using only these locked users.
  const recoveryUserIds = (
    await deps.db
      .selectFrom('sso_recovery_owners')
      .select('user_id')
      .where('organization_id', '=', organizationId)
      .where('user_id', '!=', binding.initiator_user_id)
      .execute()
  ).map(({ user_id }) => user_id)
  let offer: Offer
  let initiator: Member | undefined
  let recipient: Member | undefined
  let actorDeadline: string | undefined
  let policyEnforced = false

  return retryAfterDeadline(() =>
    withTransferProof(
      deps,
      actor,
      headers,
      organizationId,
      CONFIRM_OWNERSHIP_TRANSFER,
      binding.initiator_user_id,
      { ...input, transferId: id.data },
      {
        authorize: async (trx) => {
          const members = await teamMembers(
            trx,
            organizationId,
            [actor.user.id, binding.initiator_user_id],
            true,
          )
          const bound = participants(binding, members)
          initiator = bound.initiator
          recipient = bound.recipient
          // Acquire the write lock before the ordinary and fresh SSO proof checks can share-lock it.
          const policy = await trx
            .selectFrom('sso_policies')
            .select('require_sso')
            .where('organization_id', '=', organizationId)
            .forUpdate()
            .executeTakeFirst()
          policyEnforced = policy?.require_sso === true
          actorDeadline = await authorizeActor(
            deps,
            trx,
            actor,
            headers,
            organizationId,
            recipient,
            true,
          )
          const current = await findOffer(trx, organizationId, id.data, true)
          if (!current || current.target_membership_id !== recipient?.id) throw denied()
          offer = current
        },
        beforeProof: async (trx) => {
          await ensureActorDeadline(trx, actorDeadline)
          if (offer.state !== 'pending') return retired
          const terminal = await retirePendingOwnershipTransfer(trx, {
            organizationId,
            transferId: offer.id,
            expireOnly: structurallyEligible(initiator, recipient),
          })
          if (terminal) return retired
          if (!effective(initiator)) throw denied()
        },
        mutate: async (trx) => {
          if (!initiator || !recipient) throw denied()
          const requestId = randomUUID()
          await clearRecovery(
            trx,
            actor,
            initiator,
            organizationId,
            policyEnforced,
            requestId,
            recoveryUserIds,
          )
          await transitionOffer(trx, offer, 'confirmed')
          // Promote first, preserving owner continuity even for database-side observers of the writes.
          for (const [member, role] of [
            [recipient, 'owner'],
            [initiator, 'admin'],
          ] as const) {
            await trx
              .updateTable('auth.member')
              .set({ role })
              .where('id', '=', member.id)
              .where('organizationId', '=', organizationId)
              .returning('id')
              .executeTakeFirstOrThrow()
            await writeAuditEvent(trx, {
              ...auditActor(actor),
              organizationId,
              requestId,
              action: 'membership.role_changed',
              targetType: 'member',
              targetId: member.id,
              details: { oldRole: member.role, newRole: role },
            })
          }
          await writeAuditEvent(
            trx,
            transferAudit(actor, organizationId, 'organization.ownership_transferred', requestId),
          )
          const members = await trx
            .selectFrom('auth.member')
            .select(['userId', 'role'])
            .where('organizationId', '=', organizationId)
            .execute()
          await enqueueOwnershipTransferNotice(deps.notificationQueue, trx, {
            organizationId,
            kind: 'confirmed',
            userIds: [initiator.userId, ...members.filter(owner).map((m) => m.userId)],
          })
          await ensureActorDeadline(trx, actorDeadline)
          return {
            initiator: { membershipId: initiator.id, role: 'admin' as const },
            recipient: { membershipId: recipient.id, role: 'owner' as const },
          }
        },
      },
      recoveryUserIds,
    ),
  )
}

async function cancelOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  transferId: string,
  action: 'revoke' | 'decline',
) {
  const actor = sessionPrincipal(deps, principal, headers, organizationId, true)
  organizationId = organizationId.toLowerCase()
  const id = uuid.safeParse(transferId)
  if (!id.success) throw denied()
  const binding = await findOffer(deps.db, organizationId, id.data)
  if (!binding || (action === 'decline' && binding.target_user_id !== actor.user.id)) throw denied()
  const userIds = [actor.user.id, binding.initiator_user_id, binding.target_user_id]
  const result = await retryAfterDeadline(() =>
    deps.db.transaction().execute(async (trx) => {
      await lockTeam(trx, actor, organizationId, userIds)
      const members = await teamMembers(trx, organizationId, userIds, true)
      const member = members.find((m) => m.userId === actor.user.id)
      const deadline = await authorizeActor(
        deps,
        trx,
        actor,
        headers,
        organizationId,
        member,
        true,
        action === 'revoke',
      )
      const offer = await findOffer(trx, organizationId, id.data, true)
      await ensureActorDeadline(trx, deadline)
      if (action === 'decline' && offer?.target_membership_id !== member?.id) throw denied()
      if (offer?.state !== 'pending') return retired
      const { initiator, recipient } = participants(offer, members)
      const terminal = await retirePendingOwnershipTransfer(trx, {
        organizationId,
        transferId: offer.id,
        expireOnly: structurallyEligible(initiator, recipient),
      })
      if (terminal) return retired
      if (action === 'revoke') await debitBudget(trx, organizationId, 'revoke')
      await transitionOffer(trx, offer, 'revoked')
      await writeAuditEvent(
        trx,
        transferAudit(actor, organizationId, 'organization.ownership_transfer_revoked'),
      )
      await ensureActorDeadline(trx, deadline)
      return { state: 'revoked' as const }
    }),
  )
  if (result === retired) throw unavailable()
  return result
}

export function revokeOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  transferId: string,
) {
  return cancelOwnershipTransfer(deps, principal, headers, organizationId, transferId, 'revoke')
}

export function declineOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  transferId: string,
) {
  return cancelOwnershipTransfer(deps, principal, headers, organizationId, transferId, 'decline')
}

export async function viewOwnershipTransfer(
  deps: OwnershipTransferDeps,
  principal: Principal,
  headers: Headers,
  organizationId: string,
  transferId?: string,
) {
  const actor = sessionPrincipal(deps, principal, headers, organizationId, false)
  organizationId = organizationId.toLowerCase()
  const id = transferId === undefined ? undefined : uuid.safeParse(transferId)
  if (id && !id.success) throw denied()
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const offer = await findOffer(trx, organizationId, id?.data)
      const userIds = offer
        ? [actor.user.id, offer.initiator_user_id, offer.target_user_id]
        : [actor.user.id]
      const members = await teamMembers(trx, organizationId, userIds, false)
      const member = members.find((m) => m.userId === actor.user.id)
      await authorizeActor(deps, trx, actor, headers, organizationId, member, false)
      if (!offer) return null
      const { initiator, recipient } = participants(offer, members)
      const summary = { id: offer.id, expiresAt: offer.expires_at.toISOString() }
      const participant = member && (member.id === initiator?.id || member.id === recipient?.id)
      if (id && !participant) return null
      // A known offer may be checked by its original participants without changing its state.
      const storedState = transferState.parse(offer.state)
      const state =
        storedState !== 'pending'
          ? storedState
          : !offer.unexpired
            ? 'expired'
            : structurallyEligible(initiator, recipient)
              ? 'pending'
              : 'invalidated'
      if (state !== 'pending') return id ? { ...summary, state } : null
      if (!initiator || !recipient) return null
      const pendingSummary = { ...summary, state } as const
      if (member?.id === initiator.id || (member?.id === recipient.id && effective(initiator))) {
        return {
          ...pendingSummary,
          action: member.id === initiator.id ? ('revoke' as const) : ('confirm' as const),
          initiator: { displayName: initiator.name },
          recipient: { displayName: recipient.name },
        }
      }
      return owner(member) ? { ...pendingSummary, action: 'revoke' as const } : null
    })
}
