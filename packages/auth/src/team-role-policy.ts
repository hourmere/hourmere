import { AsyncLocalStorage } from 'node:async_hooks'
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import { isPublicTeamSlugFormat } from '@hourmere/core'
import type { Database, Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { advanceAffectedMembership } from '@hourmere/db/custom-role-authorization'
import { retirePendingOwnershipTransfer } from '@hourmere/db/ownership-transfer'
import { scimManagedMember, scimProvisioned, scimSuspended } from '@hourmere/db/scim-suspension'
import type { DBTransactionAdapter, Where } from 'better-auth/adapters'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { type Expression, type Insertable, type RawBuilder, sql, type Transaction } from 'kysely'
import type { AuthMiddlewareContext } from './api-keys.ts'
import type { Principal } from './caller.ts'
import {
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
} from './member-departure.ts'
import { recordTeamRoleChange } from './organization-operations.ts'
import { blockNullSlug, isMember, isUuid, mapOrganizationSlugConflict } from './organizations.ts'
import type { ScimClaimCompletion, ScimClaimFinish } from './scim-claims.ts'
import {
  checkSsoAdmissionBlocks,
  SCIM_MANAGED_RESOURCE_CODE,
  SCIM_MANAGED_RESOURCE_MESSAGE,
  type SsoAdmissionRemoval,
} from './sso-admission-blocks.ts'
import {
  removeSsoRecoveryOwner,
  SsoRecoveryRequiredError,
  soleOwnerDepartureFlags,
  ssoRecoveryOwner,
} from './sso-recovery-membership.ts'
import {
  checkTeamManagementAccess,
  checkTeamManagementMembership,
  TeamManagementError,
  teamRoles,
  teamSession,
  teamSessionUser,
} from './team-management.ts'
import { removeTeamMember, teamMemberRemovalTarget } from './team-member-removal.ts'
import { assertTeamOwnerRemains } from './team-owner-continuity.ts'
import { lockTeamSsoProof, ssoHardOff, type TeamSsoCapabilities } from './team-sso.ts'
import { nativeSsoRequired, trustedAddMember } from './team-sso-native.ts'

const changeRole = '/organization/update-member-role'
const updateUser = '/update-user'
const accept = '/organization/accept-invitation'
/** Pinned alongside the native organization plugin's membership limit. */
export const teamMembershipLimit = 100
const remove = '/organization/remove-member'
const updateOrganization = '/organization/update'
const rejectInvitation = '/organization/reject-invitation'
const createOrganization = '/organization/create'
const setActiveOrganization = '/organization/set-active'
const selfDeparturePaths = new Set(['/organization/leave', remove])
const protectedPaths = new Set([
  changeRole,
  accept,
  remove,
  updateOrganization,
  rejectInvitation,
  createOrganization,
  setActiveOrganization,
])
const nativeOwnerRequiredCodes = new Set([
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
  'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
])

export const teamRoleDenied = () =>
  new APIError('FORBIDDEN', {
    code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
    message: 'team_management_access_denied',
  })

export const recipientAlreadyMember = () =>
  new APIError('CONFLICT', {
    code: 'INVITATION_RECIPIENT_ALREADY_MEMBER',
    message: 'The recipient already belongs to this team.',
  })

const managedResource = () =>
  new APIError('CONFLICT', {
    code: SCIM_MANAGED_RESOURCE_CODE,
    message: SCIM_MANAGED_RESOURCE_MESSAGE,
  })

const teamSettingsChanged = () =>
  new APIError('CONFLICT', {
    code: 'TEAM_SETTINGS_CHANGED',
    message:
      'Team details changed since you opened this page. Reload team details before saving again.',
  })

function expectedTeamDetails(headers: Headers) {
  const name = headers.get('x-expected-team-name')
  const slug = headers.get('x-expected-team-slug')
  if (name === null && slug === null) return undefined
  if (name === null || slug === null) throw teamSettingsChanged()
  let decoded: { name: string; slug: string }
  try {
    decoded = { name: decodeURIComponent(name), slug: decodeURIComponent(slug) }
  } catch {
    throw teamSettingsChanged()
  }
  if (decoded.name.includes('\0') || decoded.slug.includes('\0')) throw teamSettingsChanged()
  return decoded
}

/** After the organization lock, find a live account or proven mailbox admission decision. */
function managedAdmissionBlock(
  organizationId: string,
  userId: string,
  mailbox: string | Expression<string>,
  invitationWithClaimCompletion?: string,
) {
  return sql<boolean>`CASE WHEN ${scimProvisioned(sql<string>`${organizationId}`)} THEN EXISTS (
    SELECT 1 FROM scim_membership_blocks AS block
    WHERE block.organization_id = ${organizationId}::uuid AND block.cleared_at IS NULL
      AND (block.user_id = ${userId}::uuid OR block.identity_email = ${mailbox})
  ) ${
    invitationWithClaimCompletion
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM scim_user_claims
          WHERE organization_id = ${organizationId}::uuid
            AND invitation_id = ${invitationWithClaimCompletion}::uuid
        )`
      : sql``
  } ELSE false END`
}

/** Requests can assign one fixed role; legacy actor/target role strings are parsed separately. */
export function fixedTeamRole(value: unknown): 'admin' | 'member' | undefined {
  const role = Array.isArray(value) && value.length === 1 ? value[0] : value
  return role === 'admin' || role === 'member' ? role : undefined
}

function body(ctx: AuthMiddlewareContext): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {}
}

/** Only the pinned native adapter selectors are supported by these narrow write mappings. */
function selects(where: Where[], expected: Record<string, unknown>) {
  const fields = Object.entries(expected)
  return (
    where.length === fields.length &&
    fields.every(([field, value]) =>
      where.some(
        (condition) =>
          condition.field === field &&
          condition.value === value &&
          (condition.operator === undefined || condition.operator === 'eq') &&
          (condition.connector === undefined || condition.connector === 'AND') &&
          (condition.mode === undefined || condition.mode === 'sensitive'),
      ),
    )
  )
}

async function principal(
  ctx: AuthMiddlewareContext,
): Promise<Extract<Principal, { kind: 'session' }> | null> {
  const session = await getSessionFromCtx(ctx)
  if (!session) return null
  const organizationId = body(ctx).organizationId ?? session.session.activeOrganizationId
  return {
    kind: 'session',
    user: session.user,
    sessionId: session.session.id,
    organization: {
      id: typeof organizationId === 'string' ? organizationId : '',
      name: '',
      slug: '',
      personal: false,
    },
  }
}

async function asAuthError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof MemberDepartureOwnerRequiredError) {
      throw new APIError('CONFLICT', {
        code: error.code,
        message: error.message,
        handling: error.handling,
      })
    }
    if (error instanceof SsoRecoveryRequiredError) {
      throw new APIError('CONFLICT', { code: error.code, message: error.message })
    }
    if (error instanceof TeamManagementError) {
      if (error.code === 'organization_context_changed') {
        throw new APIError('CONFLICT', {
          code: 'ORGANIZATION_CONTEXT_CHANGED',
          message: 'Your team context changed. Reload this page before trying again.',
        })
      }
      throw teamRoleDenied()
    }
    throw error
  }
}

/** The caller holds the organization write lock and has independently verified the recipient. */
export async function lockTeamInvitationAcceptance(
  trx: Db,
  {
    invitationId,
    organizationId,
    userId,
    email,
  }: {
    invitationId: string
    organizationId: string
    userId: string
    email: string
  },
  admissionBlock?: RawBuilder<boolean>,
) {
  const stored = await trx
    .selectFrom('auth.invitation')
    .selectAll()
    .$if(admissionBlock !== undefined, (query) =>
      query.select(sql<boolean>`${admissionBlock}`.as('managedBlock')),
    )
    .where('id', '=', invitationId)
    .where('organizationId', '=', organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (
    stored?.role !== 'member' ||
    stored.email.trim().toLowerCase() !== email.trim().toLowerCase() ||
    stored.status !== 'pending'
  ) {
    throw teamRoleDenied()
  }
  // Check wall time after every lock wait, on the database clock rather than the
  // process clock or transaction start time. A SCIM claim's expiry is checked at the
  // same instant, so the invitation and its claim never disagree about it.
  const validity = (
    await sql<{ active: boolean; now: string }>`SELECT
      ${stored.expiresAt}::timestamptz > clock.at AS active, clock.at::text AS now
      FROM (SELECT clock_timestamp() AS at) AS clock`.execute(trx)
  ).rows[0] as { active: boolean; now: string }
  if (!validity.active) throw teamRoleDenied()
  const personal = await trx
    .selectFrom('personal_organizations')
    .select('organization_id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (personal) throw teamRoleDenied()
  // Departures/removals hold this same organization lock. Read current membership
  // after waiting for it and retain the original inviter without requiring their
  // former management role: demotion alone does not invalidate an invitation.
  const inviter = await trx
    .selectFrom('auth.member')
    .select('id')
    .where('organizationId', '=', organizationId)
    .where('userId', '=', stored.inviterId)
    .executeTakeFirst()
  if (!inviter) {
    throw new APIError('BAD_REQUEST', {
      code: 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
      message: 'Inviter is no longer a member of the organization',
    })
  }
  const member = await trx
    .selectFrom('auth.member')
    .select('id')
    .where('organizationId', '=', organizationId)
    .where('userId', '=', userId)
    .executeTakeFirst()
  if (member) throw recipientAlreadyMember()
  // Native counts before taking the organization lock. Recheck under it so two
  // different recipients cannot consume the same last membership slot.
  const count = await trx
    .selectFrom('auth.member')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('organizationId', '=', organizationId)
    .executeTakeFirstOrThrow()
  if (Number(count.total) >= teamMembershipLimit) {
    throw new APIError('FORBIDDEN', {
      code: 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED',
      message: 'Organization membership limit reached',
    })
  }
  return {
    stored,
    checkedAt: validity.now,
    managedBlock: stored.managedBlock === true,
  }
}

/** Commit the invitation transition in the same transaction as membership and session. */
export async function writeTeamInvitationAcceptance(
  trx: Db,
  stored: { id: string; organizationId: string },
  actor: Parameters<typeof auditActor>[0],
) {
  await writeAuditEvent(trx, {
    organizationId: stored.organizationId,
    ...auditActor(actor),
    action: 'membership.accepted',
    targetType: 'invitation',
    targetId: stored.id,
  })
  return trx
    .updateTable('auth.invitation')
    .set({ status: 'accepted' })
    .where('id', '=', stored.id)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Keep Better Auth's handlers and hooks. Whenever a native adapter transaction is active,
 * this policy's locks and writes join it, including administrative member removal.
 * Creation and acceptance add an enclosing native transaction. Policy writes without a
 * native transaction use their own short transaction; invitation admission/delivery is separate.
 * SCIM claim completion joins acceptance when the caller enables `scimClaims`.
 */
export function createTeamRolePolicy(
  db: Db,
  leaveTeamMember?: (
    principal: Principal,
    teamId: string,
    expectedOrganizationId: string,
    transaction?: Db,
    ssoCapabilities?: TeamSsoCapabilities,
  ) => Promise<{ organizationId: string }>,
  scimClaims?: ScimClaimCompletion,
  recordAdmissionRemoval?: SsoAdmissionRemoval,
  ssoCapabilities = ssoHardOff,
  scimResourcesEnabled = false,
) {
  const requests = new AsyncLocalStorage<{ ctx?: AuthMiddlewareContext }>()
  const transactions = new AsyncLocalStorage<Transaction<Database>>()
  // A claim the acceptance decided to complete, finished once its member row exists.
  const claimFinishes = new WeakMap<Transaction<Database>, ScimClaimFinish>()

  const requireProof = (
    trx: Db,
    ctx: AuthMiddlewareContext,
    organizationId: string,
    admissionUserId?: string,
  ) => {
    const session = ctx.context.session
    return lockTeamSsoProof(
      { capabilities: ssoCapabilities },
      trx,
      session ? { sessionId: session.session.id, userId: session.user.id } : null,
      organizationId,
      nativeSsoRequired,
      {
        organizationLocked: true,
        ...(admissionUserId && {
          admission: {
            blocked: managedAdmissionBlock(
              organizationId,
              admissionUserId,
              sql<string>`(SELECT lower(btrim(email)) FROM auth."user"
                WHERE id = ${admissionUserId}::uuid AND "emailVerified" IS TRUE)`,
            ),
            denied: () => {
              throw teamRoleDenied()
            },
          },
        }),
      },
    )
  }

  function operationContext() {
    const current = requests.getStore()?.ctx
    if (current) return current
    // Server-side auth.api calls have the native endpoint context but do not pass
    // through the HTTP handler's request storage. Protect their membership writes too.
    const endpoint = tryGetCurrentAuthEndpointContext()
    if (endpoint && trustedAddMember(endpoint as { operationId?: string }))
      return endpoint as AuthMiddlewareContext
    if (
      !endpoint ||
      (!selfDeparturePaths.has(endpoint.path ?? '') &&
        !protectedPaths.has(endpoint.path ?? '') &&
        !(scimResourcesEnabled && endpoint.path === updateUser)) ||
      !endpoint.context.session?.session?.id ||
      (endpoint.path === remove && !endpoint.body?.memberIdOrEmail) ||
      (endpoint.path === changeRole && !endpoint.body?.memberId)
    )
      return undefined
    return endpoint as AuthMiddlewareContext
  }

  async function targetsSelf(ctx: AuthMiddlewareContext) {
    const actor = await principal(ctx)
    const idOrEmail = body(ctx).memberIdOrEmail
    if (!actor || typeof idOrEmail !== 'string') return false
    if (idOrEmail.includes('@')) return idOrEmail.toLowerCase() === actor.user.email.toLowerCase()
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', actor.organization.id)
      .where('userId', '=', actor.user.id)
      .executeTakeFirst()
    return member?.id.toLowerCase() === idOrEmail.toLowerCase()
  }

  async function removal(ctx: AuthMiddlewareContext, targetDb: Db, lock: boolean) {
    const actor = await principal(ctx)
    if (!actor) throw teamRoleDenied()
    const expectedOrganizationId =
      ctx.request?.headers.get('x-expected-organization-id') ??
      ctx.headers?.get('x-expected-organization-id') ??
      ''
    const facts = await checkTeamManagementAccess(targetDb, actor, actor.organization.id, lock, {
      expectedOrganizationId,
      allowPersonal: false,
    })
    if (facts.role === 'member') throw teamRoleDenied()
    const idOrEmail = body(ctx).memberIdOrEmail
    if (typeof idOrEmail !== 'string') throw teamRoleDenied()
    let targetQuery = targetDb
      .selectFrom('auth.member as member')
      .innerJoin('auth.user as user', 'user.id', 'member.userId')
      .select(['member.id', 'member.userId'])
      .where('member.organizationId', '=', facts.organizationId)
    if (idOrEmail.includes('@')) {
      targetQuery = targetQuery.where('user.email', '=', idOrEmail.toLowerCase())
    } else {
      if (!isUuid(idOrEmail)) throw teamRoleDenied()
      targetQuery = targetQuery.where('member.id', '=', idOrEmail)
    }
    const target = await targetQuery.executeTakeFirst()
    if (!target) throw teamRoleDenied()
    const manager = { ...facts, role: facts.role }
    const member = await teamMemberRemovalTarget(targetDb, manager, target.userId, lock)
    return { actor: manager, member, principal: actor, expectedOrganizationId }
  }

  async function manager(ctx: AuthMiddlewareContext, targetDb: Db, lock: boolean) {
    const actor = await principal(ctx)
    if (!actor) throw teamRoleDenied()
    const facts = await checkTeamManagementAccess(targetDb, actor, actor.organization.id, lock)
    return { actor, facts }
  }

  async function managementWrite(ctx: AuthMiddlewareContext, trx: Transaction<Database>) {
    const actor = await principal(ctx)
    if (!actor) throw teamRoleDenied()
    const expectedOrganizationId =
      ctx.request?.headers.get('x-expected-organization-id') ?? actor.organization.id
    const facts = await checkTeamManagementAccess(trx, actor, actor.organization.id, true, {
      expectedOrganizationId,
      allowPersonal: ctx.path === updateOrganization,
    })
    return facts
  }

  async function roleChange(
    ctx: AuthMiddlewareContext,
    targetDb: Db,
    lock: boolean,
    actualRole: unknown = body(ctx).role,
  ) {
    const { facts } = await manager(ctx, targetDb, lock)
    const role = fixedTeamRole(actualRole)
    if (facts.role !== 'owner' || !role) throw teamRoleDenied()
    const memberId = body(ctx).memberId
    if (typeof memberId !== 'string' || !isUuid(memberId)) throw teamRoleDenied()
    let targetQuery = targetDb
      .selectFrom('auth.member')
      .selectAll()
      .select(ssoRecoveryOwner)
      .select((eb) =>
        eb
          .selectFrom('team_member_authorizations')
          .select('generation')
          .whereRef('member_id', '=', 'auth.member.id')
          .as('authorizationGeneration'),
      )

      .where('id', '=', memberId)
      .where('organizationId', '=', facts.organizationId)
    if (lock) targetQuery = targetQuery.forUpdate()
    const target = await targetQuery
      .$if(lock && role === 'admin', (query) =>
        query.select(({ ref }) =>
          scimSuspended(facts.organizationId, ref('auth.member.userId'), true).as('scimBlocked'),
        ),
      )
      .executeTakeFirst()
    if (!target || target.userId === facts.userId || teamRoles(target.role).includes('owner'))
      throw teamRoleDenied()
    if (target.scimBlocked && !teamRoles(target.role).includes('admin')) throw managedResource()
    if (lock && teamRoles(target.role).includes('owner')) {
      await assertTeamOwnerRemains(targetDb, facts.organizationId, target.userId)
    }
    return { facts, target, role }
  }

  async function acceptance(ctx: AuthMiddlewareContext, trx: Transaction<Database>) {
    const actor = await principal(ctx)
    if (!actor) throw teamRoleDenied()
    const user = await teamSessionUser(trx, actor, true)
    const invitationId = body(ctx).invitationId
    if (typeof invitationId !== 'string' || !isUuid(invitationId)) throw teamRoleDenied()
    // This first read only discovers the parent lock. Re-read the invitation after it.
    const target = await trx
      .selectFrom('auth.invitation')
      .select('organizationId')
      .where('id', '=', invitationId)
      .executeTakeFirst()
    if (!target) throw teamRoleDenied()
    const organization = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', target.organizationId)
      .forUpdate()
      .executeTakeFirst()
    if (!organization) throw teamRoleDenied()
    // Native session activation writes this row before commit. Reserve that mode now
    // so concurrent trusted acceptances cannot both take SHARE and deadlock upgrading.
    await teamSession(trx, actor, 'no-key-update')
    const mailbox = user.email.trim().toLowerCase()
    const { stored, checkedAt, managedBlock } = await lockTeamInvitationAcceptance(
      trx,
      {
        invitationId,
        organizationId: organization.id,
        userId: actor.user.id,
        email: user.email,
      },
      // Stored blockers survive rollback. A bound SCIM invitation checks its own
      // blockers when claim completion is enabled.
      managedAdmissionBlock(
        organization.id,
        actor.user.id,
        mailbox,
        scimClaims ? invitationId : undefined,
      ),
    )
    await requireProof(trx, ctx, organization.id)
    if (
      managedBlock &&
      !(await checkSsoAdmissionBlocks(trx, {
        organizationId: organization.id,
        userId: actor.user.id,
        mailbox,
        invitationId: stored.id,
      }))
    )
      throw teamRoleDenied()
    // A SCIM-issued invitation's claim, after the organization and invitation locks: a live
    // admission blocker refuses, and a completable claim is finished with the member row.
    const claim = await scimClaims?.invitation(trx, {
      organizationId: organization.id,
      invitationId: stored.id,
      userId: actor.user.id,
      mailbox,
      checkedAt,
      audit: auditActor(actor),
    })
    if (claim?.refused) throw teamRoleDenied()
    if (claim?.finish) {
      // The link commits with the native member and session writes, or not at all.
      if (transactions.getStore() !== trx) throw teamRoleDenied()
      claimFinishes.set(trx, claim.finish)
    }
    return stored
  }

  const write = <T>(operation: (trx: Transaction<Database>) => Promise<T>) =>
    asAuthError(() => {
      const trx = transactions.getStore()
      return trx
        ? operation(trx)
        : db.transaction().setIsolationLevel('read committed').execute(operation)
    })

  return {
    /** The native adapter's transaction owns the policy locks and their writes too. */
    withTransaction<T>(trx: Transaction<Database>, operation: () => Promise<T>): Promise<T> {
      return transactions.run(trx, operation)
    },
    /**
     * The native auth transaction this code runs in, if any. Hooks called inside one read
     * through its connection: waiting for an application connection while holding an auth
     * connection could deadlock against the MCP OAuth broker, which holds an application
     * transaction while it waits for an auth connection.
     */
    transaction(): Transaction<Database> | undefined {
      return transactions.getStore()
    },
    /** Run before native lookups so denied targets never reveal whether they exist. */
    async before(ctx: AuthMiddlewareContext) {
      const state = requests.getStore()
      if (
        state &&
        (protectedPaths.has(ctx.path) ||
          selfDeparturePaths.has(ctx.path) ||
          (scimResourcesEnabled && ctx.path === updateUser))
      )
        state.ctx = ctx
      if (!protectedPaths.has(ctx.path)) return
      const input = body(ctx)
      if (ctx.path === createOrganization) blockNullSlug(input.slug)
      if (ctx.path === updateOrganization && input.data && typeof input.data === 'object') {
        blockNullSlug((input.data as Record<string, unknown>).slug)
      }
      if (!(await getSessionFromCtx(ctx))) return
      await asAuthError(async () => {
        // Self-removal keeps the safe leave policy, including member access and the
        // locked final-owner refusal. Other targets require administrative removal.
        if (ctx.path === remove && !(await targetsSelf(ctx))) await removal(ctx, db, false)
        if (ctx.path === changeRole) await roleChange(ctx, db, false)
        if (ctx.path === accept && typeof input.invitationId === 'string') {
          const session = await getSessionFromCtx(ctx)
          const stored = await db
            .selectFrom('auth.invitation')
            .select(['email', 'role'])
            .where('id', '=', input.invitationId)
            .where('status', '=', 'pending')
            .where('expiresAt', '>', new Date())
            .executeTakeFirst()
          // Preserve native expiry, recipient and email-proof errors; the new role denial
          // is visible only to the verified recipient, never as an invitation-id probe.
          if (
            session?.user.emailVerified &&
            stored?.email.toLowerCase() === session.user.email.toLowerCase() &&
            stored.role !== 'member'
          ) {
            throw teamRoleDenied()
          }
        }
      })
    },

    handler(handler: (request: Request) => Promise<Response>) {
      return (request: Request) =>
        requests.run({}, async () => {
          const response = await handler(request)
          if (response.status !== 400) return response
          let result: unknown
          try {
            result = await response.clone().json()
          } catch {
            return response
          }
          if (
            !result ||
            typeof result !== 'object' ||
            !('code' in result) ||
            typeof result.code !== 'string' ||
            !nativeOwnerRequiredCodes.has(result.code)
          )
            return response
          const ctx = requests.getStore()?.ctx
          const actor = ctx ? await principal(ctx) : null
          if (!actor) return response
          const flags = isUuid(actor.organization.id)
            ? await soleOwnerDepartureFlags(db, actor.organization.id, actor.user.id)
            : undefined
          if (flags?.personal) return response
          // Keep Better Auth's early sole-owner refusal intact. Its native 400 and our
          // locked write refusal describe the same conflict, including legacy roles.
          const error = flags?.recoveryRequired
            ? new SsoRecoveryRequiredError()
            : new MemberDepartureOwnerRequiredError()
          const handling =
            error instanceof MemberDepartureOwnerRequiredError ? error.handling : undefined
          const headers = new Headers(response.headers)
          headers.delete('content-length')
          return new Response(
            JSON.stringify({ code: error.code, message: error.message, handling }),
            { status: 409, headers },
          )
        })
    },

    adapter(adapter: DBTransactionAdapter): DBTransactionAdapter {
      const { create, update, findOne, findMany, incrementOne, delete: deleteOne } = adapter
      adapter.create = async <T extends Record<string, unknown>, R = T>(request: {
        model: string
        data: Omit<T, 'id'>
        select?: string[] | undefined
        forceAllowId?: boolean | undefined
      }) => {
        const ctx = operationContext()
        if (
          ctx &&
          trustedAddMember(ctx as { operationId?: string }) &&
          request.model === 'member'
        ) {
          const { organizationId, userId } = request.data as Record<string, unknown>
          if (
            typeof organizationId !== 'string' ||
            !isUuid(organizationId) ||
            typeof userId !== 'string' ||
            !isUuid(userId)
          )
            throw teamRoleDenied()
          return write(async (trx) => {
            await trx
              .selectFrom('auth.organization')
              .select('id')
              .where('id', '=', organizationId)
              .forUpdate()
              .executeTakeFirstOrThrow()
            const member = await create<T, R>(request)
            // The native insert and this fresh read use the same transaction. A blocker
            // committed while addMember waited for the organization rolls the insert back.
            await requireProof(trx, ctx, organizationId, userId)
            return member
          })
        }
        if (ctx?.request && ctx.path === createOrganization && request.model === 'organization') {
          return write(async (trx) => {
            const actor = await principal(ctx)
            if (!actor) throw teamRoleDenied()
            await teamSessionUser(trx, actor, true)
            await teamSession(trx, actor, true)
            if (
              Object.keys(request.data).some(
                (key) => !['id', 'name', 'slug', 'logo', 'metadata', 'createdAt'].includes(key),
              )
            )
              throw teamRoleDenied()
            const created = await trx
              .insertInto('auth.organization')
              .values(request.data as Insertable<Database['auth.organization']>)
              .returningAll()
              .executeTakeFirstOrThrow()
            await writeAuditEvent(trx, {
              organizationId: created.id,
              ...auditActor(actor),
              action: 'organization.created',
              targetType: 'organization',
              targetId: created.id,
            })
            return created as never
          })
        }
        if (ctx?.path === accept && request.model === 'member') {
          const trx = transactions.getStore()
          const finish = trx && claimFinishes.get(trx)
          if (trx && finish) {
            claimFinishes.delete(trx)
            const member = await create<
              Record<string, unknown>,
              { id: string; userId: string; organizationId: string }
            >(request)
            await finish(trx, member)
            return member as never
          }
        }
        return create<T, R>(request)
      }
      adapter.delete = async (request) => {
        const ctx = operationContext()
        if (!ctx || !selfDeparturePaths.has(ctx.path) || request.model !== 'member') {
          return deleteOne(request)
        }
        const actor = await principal(ctx)
        const target = await findOne<{
          id: string
          userId: string
          organizationId: string
        }>(request)
        if (!actor || !target || target.userId !== actor.user.id) {
          if (ctx.path !== remove) return deleteOne(request)
          return write(async (trx) => {
            const { actor, member, principal, expectedOrganizationId } = await removal(
              ctx,
              trx,
              true,
            )
            if (!selects(request.where, { id: member.id })) throw teamRoleDenied()
            // Bypass the native recorder here: this helper owns the member deletion,
            // dependent deactivation and one operation record on the same connection.
            await removeTeamMember(trx, principal, {
              teamId: actor.organizationId,
              memberUserId: member.userId,
              expectedOrganizationId,
              recordAdmissionRemoval,
              ssoCapabilities,
            })
          })
        }
        if (!leaveTeamMember) {
          throw new APIError('SERVICE_UNAVAILABLE', {
            code: 'TEAM_LEAVE_UNAVAILABLE',
            message: 'Safe team departure is unavailable. Try again later.',
          })
        }
        if (
          target.organizationId.toLowerCase() !== actor.organization.id.toLowerCase() ||
          !selects(request.where, { id: target.id })
        )
          throw teamRoleDenied()
        try {
          // Better Auth's deleteMember runs this inside its auth transaction: the departure
          // runs on that held connection and commits with it.
          const fallback = await leaveTeamMember(
            actor,
            target.organizationId,
            ctx.request?.headers.get('x-expected-organization-id') ?? target.organizationId,
            transactions.getStore(),
            ssoCapabilities,
          )
          // The native handler clears the old active organization after deleteMember.
          // Refresh its request snapshot so that cleanup cannot overwrite the personal
          // fallback written atomically with the membership revocation.
          const session = await getSessionFromCtx(ctx)
          if (session?.session.id === actor.sessionId) {
            session.session.activeOrganizationId = fallback.organizationId
          }
        } catch (error) {
          if (error instanceof MemberDepartureBlockedError) {
            throw new APIError('CONFLICT', {
              code: error.code,
              message: error.message,
              impact: error.impact,
              handling: error.handling,
            })
          }
          if (error instanceof MemberDepartureOwnerRequiredError) {
            throw new APIError('CONFLICT', {
              code: error.code,
              message: error.message,
              handling: error.handling,
            })
          }
          // The injected service uses domain errors; translate only the shared access
          // codes, without importing scheduling into auth or exposing arbitrary errors.
          const code = error instanceof Error && 'code' in error ? error.code : undefined
          if (code === 'organization_context_changed') {
            throw new APIError('CONFLICT', { code: 'ORGANIZATION_CONTEXT_CHANGED', message: code })
          }
          if (code === 'team_management_access_denied') throw teamRoleDenied()
          if (code === 'sso_required') nativeSsoRequired()
          if (code === 'sso_recovery_required') {
            throw new APIError('CONFLICT', { code, message: code })
          }
          throw error
        }
      }
      adapter.findOne = async <T>(request: Parameters<DBTransactionAdapter['findOne']>[0]) => {
        const result = await findOne<T>(request)
        const ctx = operationContext()
        if (
          ctx &&
          (ctx.path === changeRole || ctx.path === remove) &&
          request.model === 'member' &&
          result &&
          typeof result === 'object' &&
          'role' in result &&
          typeof result.role === 'string'
        ) {
          // Native permission checks split on commas without trimming. Match the shared
          // check for legitimate legacy multi-role rows without changing their stored role.
          return { ...result, role: teamRoles(result.role).join(',') } as never
        }
        return result
      }
      adapter.findMany = async <T>(request: Parameters<DBTransactionAdapter['findMany']>[0]) => {
        const result = await findMany<T>(request)
        const ctx = operationContext()
        if (
          !ctx ||
          (!selfDeparturePaths.has(ctx.path) && ctx.path !== changeRole) ||
          request.model !== 'member'
        )
          return result
        // Native early owner counts also split untrimmed role strings. Normalize their
        // snapshots so an actual second legacy owner is counted before our locked write.
        return result.map((member) =>
          member &&
          typeof member === 'object' &&
          'role' in member &&
          typeof member.role === 'string'
            ? { ...member, role: teamRoles(member.role).join(',') }
            : member,
        )
      }
      adapter.update = async <T>(request: Parameters<DBTransactionAdapter['update']>[0]) => {
        const ctx = operationContext()
        const name = request.update.name
        const profileSession =
          ctx?.path === updateUser
            ? (tryGetCurrentAuthEndpointContext()?.context.session ?? ctx.context.session)
            : null
        const organizationId = profileSession?.session.activeOrganizationId
        if (
          request.model === 'user' &&
          name !== undefined &&
          profileSession &&
          typeof organizationId === 'string' &&
          isUuid(organizationId) &&
          selects(request.where, { id: profileSession.user.id })
        ) {
          // Better Auth can validate new additionalFields before calling this adapter.
          // Refuse a mixed update until its new fields have an explicit write mapping.
          if (
            Object.keys(request.update).some((key) => !['name', 'image', 'updatedAt'].includes(key))
          ) {
            throw new APIError('BAD_REQUEST', {
              code: 'UNSUPPORTED_USER_UPDATE_FIELDS',
              message: 'This name update includes unsupported fields.',
            })
          }
          const { id: userId } = profileSession.user
          const currentDb = transactions.getStore() ?? db
          // The native name update and conflict check share one statement with the same
          // write lock as the ordinary account update. The managed profile itself is local.
          const result = await currentDb
            .with('managed', (db) =>
              db.selectNoFrom(scimManagedMember(organizationId, userId).as('blocked')),
            )
            .with('updated', (db) =>
              db
                .updateTable('auth.user')
                .set({
                  name: name as string,
                  image: request.update.image as string | null | undefined,
                  updatedAt: new Date(),
                })
                .where('id', '=', userId)
                .where((eb) => eb(eb.selectFrom('managed').select('blocked'), '=', false))
                .returningAll(),
            )
            .selectFrom('managed')
            .leftJoin('updated', (join) => join.onTrue())
            .select('managed.blocked')
            .selectAll('updated')
            .executeTakeFirstOrThrow()
          const { blocked, ...user } = result
          if (blocked) throw managedResource()
          return user.id === null ? null : (user as T)
        }
        if (
          ctx?.path === setActiveOrganization &&
          request.model === 'session' &&
          'activeOrganizationId' in request.update
        ) {
          const targetId = request.update.activeOrganizationId
          if (!ctx.request) {
            if (typeof targetId !== 'string' || !isUuid(targetId)) return update<T>(request)
            return write(async (trx) => {
              await trx
                .selectFrom('auth.organization')
                .select('id')
                .where('id', '=', targetId)
                .forShare()
                .executeTakeFirst()
              const updated = await update<T>(request)
              await requireProof(trx, ctx, targetId)
              return updated
            })
          }
          return write(async (trx) => {
            const actor = await principal(ctx)
            const session = await getSessionFromCtx(ctx)
            if (
              !actor ||
              !session ||
              !selects(request.where, { token: session.session.token }) ||
              Object.keys(request.update).some((key) => key !== 'activeOrganizationId')
            )
              throw teamRoleDenied()
            await teamSessionUser(trx, actor, true)
            if (targetId !== null) {
              if (typeof targetId !== 'string' || !isUuid(targetId)) throw teamRoleDenied()
              const organization = await trx
                .selectFrom('auth.organization')
                .select('id')
                .where('id', '=', targetId)
                .forShare()
                .executeTakeFirst()
              if (!organization) throw teamRoleDenied()
              await checkTeamManagementMembership(
                trx,
                actor.user.id,
                targetId,
                true,
                true,
                true,
                false,
                false,
                scimResourcesEnabled,
              )
            }
            const live = await teamSession(trx, actor, true)
            const expected = ctx.request?.headers.get('x-expected-organization-id') ?? null
            if (expected !== null) {
              const activeMember =
                live.activeOrganizationId &&
                (await isMember(
                  trx,
                  actor.user.id,
                  live.activeOrganizationId,
                  scimResourcesEnabled,
                ))
              const personal = activeMember
                ? undefined
                : await trx
                    .selectFrom('personal_organizations')
                    .select('organization_id')
                    .where('user_id', '=', actor.user.id)
                    .executeTakeFirst()
              const effective = activeMember ? live.activeOrganizationId : personal?.organization_id
              if (effective?.toLowerCase() !== expected.toLowerCase())
                throw new TeamManagementError('organization_context_changed')
            }
            const updated = await trx
              .updateTable('auth.session')
              .set({ activeOrganizationId: targetId as string | null, updatedAt: new Date() })
              .where('id', '=', actor.sessionId)
              .where('userId', '=', actor.user.id)
              .returningAll()
              .executeTakeFirstOrThrow()
            if (typeof targetId === 'string') await requireProof(trx, ctx, targetId)
            return updated as never
          })
        }
        if (ctx?.path === updateOrganization && request.model === 'organization') {
          return write(async (trx) => {
            // Native authorization happened before this persistence boundary. Keep its
            // actual update and fresh actor/context checks in the shared lock transaction.
            const facts = await managementWrite(ctx, trx)
            if (
              !selects(request.where, { id: facts.organizationId }) ||
              Object.keys(request.update).some(
                (key) => !['name', 'slug', 'logo', 'metadata'].includes(key),
              )
            )
              throw teamRoleDenied()
            const expected = ctx.request && expectedTeamDetails(ctx.request.headers)
            const patch = request.update as {
              name?: string
              slug?: string
              logo?: string | null
              metadata?: string | null
            }
            if (scimResourcesEnabled && patch.name !== undefined) {
              const managedName = await trx
                .selectFrom('scim_team_mappings as mapping')
                .innerJoin('scim_groups as group', 'group.mapping_id', 'mapping.id')
                .innerJoin(
                  'auth.organization as child',
                  'child.id',
                  'mapping.live_child_organization_id',
                )
                .select('group.id')
                .where('child.id', '=', facts.organizationId)
                .where('child.name', '!=', patch.name)
                .where('mapping.suspended_at', 'is', null)
                .executeTakeFirst()
              if (managedName) throw managedResource()
            }
            const previous = await trx
              .selectFrom('auth.organization')
              .select(['name', 'slug'])
              .where('id', '=', facts.organizationId)
              .executeTakeFirstOrThrow()
            let update = trx
              .updateTable('auth.organization')
              .set(patch)
              .where('id', '=', facts.organizationId)
            if (expected)
              update = update.where('name', '=', expected.name).where('slug', '=', expected.slug)
            const updated = await update.returningAll().executeTakeFirst()
            if (!updated) throw teamSettingsChanged()
            const actor = await principal(ctx)
            if (!actor) throw teamRoleDenied()
            await writeAuditEvent(trx, {
              organizationId: facts.organizationId,
              ...auditActor(actor),
              action: 'organization.updated',
              targetType: 'organization',
              targetId: facts.organizationId,
              details: {
                ...(previous.name !== updated.name && { nameChanged: true }),
                ...(previous.slug !== updated.slug && {
                  oldSlug: isPublicTeamSlugFormat(previous.slug) ? previous.slug : null,
                  newSlug: updated.slug,
                }),
              },
            })
            await requireProof(trx, ctx, facts.organizationId)
            return updated as never
          }).catch(mapOrganizationSlugConflict)
        }
        if (ctx?.path === changeRole && request.model === 'member') {
          return write(async (trx) => {
            const { facts, target, role } = await roleChange(ctx, trx, true, request.update.role)
            if (!selects(request.where, { id: target.id })) {
              throw teamRoleDenied()
            }
            if (target.recoveryOwner) {
              const actor = await principal(ctx)
              if (!actor) throw teamRoleDenied()
              await removeSsoRecoveryOwner(trx, actor, {
                organizationId: facts.organizationId,
                userId: target.userId,
                isOwner: teamRoles(target.role).includes('owner'),
                checkProof: () => requireProof(trx, ctx, facts.organizationId),
              })
            }
            const updated = await trx
              .updateTable('auth.member')
              .set({ role })
              .where('id', '=', target.id)
              .where('organizationId', '=', facts.organizationId)
              .returningAll()
              .executeTakeFirstOrThrow()
            await recordTeamRoleChange(trx, target, facts.userId, role)
            if (target.role !== role) {
              await advanceAffectedMembership(
                trx,
                facts.organizationId,
                target.id,
                target.authorizationGeneration,
              )

              await retirePendingOwnershipTransfer(trx, {
                organizationId: facts.organizationId,
                membershipId: target.id,
              })
              const actor = await principal(ctx)
              if (!actor) throw teamRoleDenied()
              await writeAuditEvent(trx, {
                organizationId: facts.organizationId,
                ...auditActor(actor),
                action: 'membership.role_changed',
                details: { oldRole: target.role, newRole: role },
                targetType: 'user',
                targetId: target.userId,
              })
            }
            await requireProof(trx, ctx, facts.organizationId)
            return updated as never
          })
        }
        return update<T>(request)
      }
      adapter.incrementOne = async (request) => {
        const ctx = operationContext()
        if (ctx?.path === rejectInvitation && request.model === 'invitation') {
          return write(async (trx) => {
            const actor = await principal(ctx)
            if (!actor) throw teamRoleDenied()
            const user = await teamSessionUser(trx, actor, true)
            const invitationId = body(ctx).invitationId
            if (
              typeof invitationId !== 'string' ||
              !isUuid(invitationId) ||
              !selects(request.where, { id: invitationId }) ||
              Object.keys(request.increment).length !== 0 ||
              Object.keys(request.set ?? {}).length !== 1 ||
              request.set?.status !== 'rejected'
            )
              throw teamRoleDenied()
            const target = await trx
              .selectFrom('auth.invitation')
              .select('organizationId')
              .where('id', '=', invitationId)
              .executeTakeFirst()
            if (!target) throw teamRoleDenied()
            const organization = await trx
              .selectFrom('auth.organization')
              .select('id')
              .where('id', '=', target.organizationId)
              .forUpdate()
              .executeTakeFirst()
            if (!organization) throw teamRoleDenied()
            await teamSession(trx, actor, true)
            const invitation = await trx
              .selectFrom('auth.invitation')
              .selectAll()
              .where('id', '=', invitationId)
              .where('organizationId', '=', organization.id)
              .forUpdate()
              .executeTakeFirst()
            if (invitation?.email.toLowerCase() !== user.email.toLowerCase()) throw teamRoleDenied()
            const clock = await trx
              .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
              .executeTakeFirstOrThrow()
            if (invitation.status !== 'pending' || invitation.expiresAt <= clock.now) {
              throw new APIError('CONFLICT', {
                code: 'INVITATION_INELIGIBLE',
                message: 'This invitation is no longer pending.',
              })
            }
            const rejected = await trx
              .updateTable('auth.invitation')
              .set({ status: 'rejected' })
              .where('id', '=', invitation.id)
              .where('organizationId', '=', organization.id)
              .where('status', '=', 'pending')
              .returningAll()
              .executeTakeFirstOrThrow()
            // The invitee never joined: the team's journal keeps no user or session ID of theirs.
            await writeAuditEvent(trx, {
              organizationId: organization.id,
              actor: { type: 'external_user' },
              credential: { type: 'none' },
              action: 'membership.invitation_rejected',
              targetType: 'invitation',
              targetId: invitation.id,
            })
            await requireProof(trx, ctx, organization.id)
            return rejected as never
          })
        }
        if (
          ctx?.path !== accept ||
          request.model !== 'invitation' ||
          request.set?.status !== 'accepted'
        ) {
          return incrementOne(request)
        }
        return write(async (trx) => {
          if (
            !selects(request.where, { id: body(ctx).invitationId, status: 'pending' }) ||
            Object.keys(request.increment).length !== 0
          ) {
            throw teamRoleDenied()
          }
          const stored = await acceptance(ctx, trx)
          const actor = await principal(ctx)
          if (!actor) throw teamRoleDenied()
          return (await writeTeamInvitationAcceptance(trx, stored, actor)) as never
        })
      }
      return adapter
    },
  }
}
