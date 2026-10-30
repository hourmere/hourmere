import { AsyncLocalStorage } from 'node:async_hooks'
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { Database, Db } from '@hourmere/db'
import type { DBTransactionAdapter, Where } from 'better-auth/adapters'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import type { Transaction } from 'kysely'
import type { AuthMiddlewareContext } from './api-keys.ts'
import type { Principal } from './caller.ts'
import {
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
} from './member-departure.ts'
import { recordTeamRoleChange } from './organization-operations.ts'
import { isUuid } from './organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  teamRoles,
  teamSession,
  teamSessionUser,
} from './team-management.ts'

const changeRole = '/organization/update-member-role'
const accept = '/organization/accept-invitation'
const selfDeparturePaths = new Set(['/organization/leave', '/organization/remove-member'])
const protectedPaths = new Set([changeRole, accept])

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
    if (error instanceof TeamManagementError) throw teamRoleDenied()
    throw error
  }
}

/**
 * Keep Better Auth's role-change and acceptance handlers and hooks. Their narrow persistence
 * calls use application transactions, so the shared actor locks and actual SQL write
 * use one connection. Holding those row locks around Better Auth's separate pool would
 * block its own FK checks; wrapping the whole handler would also change invitation hooks
 * that deliberately observe committed rows.
 */
export function createTeamRolePolicy(
  db: Db,
  leaveTeamMember?: (
    principal: Principal,
    teamId: string,
    expectedOrganizationId: string,
  ) => Promise<{ organizationId: string }>,
) {
  const requests = new AsyncLocalStorage<{ ctx?: AuthMiddlewareContext }>()

  async function manager(ctx: AuthMiddlewareContext, targetDb: Db, lock: boolean) {
    const actor = await principal(ctx)
    if (!actor) throw teamRoleDenied()
    const facts = await checkTeamManagementAccess(targetDb, actor, actor.organization.id, lock)
    return { actor, facts }
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
      .where('id', '=', memberId)
      .where('organizationId', '=', facts.organizationId)
    if (lock) targetQuery = targetQuery.forUpdate()
    const target = await targetQuery.executeTakeFirst()
    if (!target || teamRoles(target.role).includes('owner') || target.userId === facts.userId) {
      throw teamRoleDenied()
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
    await teamSession(trx, actor, true)
    const stored = await trx
      .selectFrom('auth.invitation')
      .selectAll()
      .where('id', '=', invitationId)
      .where('organizationId', '=', organization.id)
      .forUpdate()
      .executeTakeFirst()
    if (
      stored?.role !== 'member' ||
      stored.email.trim().toLowerCase() !== user.email.trim().toLowerCase() ||
      stored.status !== 'pending' ||
      new Date(stored.expiresAt).getTime() <= Date.now()
    ) {
      throw teamRoleDenied()
    }
    const personal = await trx
      .selectFrom('personal_organizations')
      .select('organization_id')
      .where('organization_id', '=', organization.id)
      .executeTakeFirst()
    if (personal) throw teamRoleDenied()
    const member = await trx
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organization.id)
      .where('userId', '=', actor.user.id)
      .executeTakeFirst()
    if (member) throw recipientAlreadyMember()
    return stored
  }

  const write = <T>(operation: (trx: Transaction<Database>) => Promise<T>) =>
    asAuthError(() => db.transaction().setIsolationLevel('read committed').execute(operation))

  return {
    /** Run before native lookups so denied targets never reveal whether they exist. */
    async before(ctx: AuthMiddlewareContext) {
      const state = requests.getStore()
      if (state && (protectedPaths.has(ctx.path) || selfDeparturePaths.has(ctx.path)))
        state.ctx = ctx
      if (!protectedPaths.has(ctx.path)) return
      if (!(await getSessionFromCtx(ctx))) return
      const input = body(ctx)
      await asAuthError(async () => {
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
      return (request: Request) => requests.run({}, () => handler(request))
    },

    adapter(adapter: DBTransactionAdapter): DBTransactionAdapter {
      const { update, findOne, incrementOne, delete: remove } = adapter
      adapter.delete = async (request) => {
        // Trusted auth.api calls use Better Auth's endpoint context without the HTTP
        // handler wrapper. They must share the same self-departure persistence guard.
        const endpoint = tryGetCurrentAuthEndpointContext()
        const ctx =
          requests.getStore()?.ctx ??
          (endpoint?.context.session?.session?.id ? (endpoint as AuthMiddlewareContext) : undefined)
        if (!ctx || !selfDeparturePaths.has(ctx.path) || request.model !== 'member') {
          return remove(request)
        }
        const actor = await principal(ctx)
        const target = await findOne<{
          id: string
          userId: string
          organizationId: string
        }>(request)
        // Administrative removal continues through the existing native recorder/path.
        if (!actor || !target || target.userId !== actor.user.id) return remove(request)
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
          const fallback = await leaveTeamMember(
            actor,
            target.organizationId,
            ctx.request?.headers.get('x-expected-organization-id') ?? target.organizationId,
          )
          // The native handler clears the old active organization after deleteMember.
          // Refresh its request snapshot so that cleanup cannot overwrite the personal
          // fallback already committed atomically with the membership revocation.
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
          throw error
        }
      }
      adapter.findOne = async <T>(request: Parameters<DBTransactionAdapter['findOne']>[0]) => {
        const result = await findOne<T>(request)
        const ctx = requests.getStore()?.ctx
        if (
          ctx &&
          ctx.path === changeRole &&
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
      adapter.update = async (request) => {
        const ctx = requests.getStore()?.ctx
        if (ctx?.path === changeRole && request.model === 'member') {
          return write(async (trx) => {
            const { facts, target, role } = await roleChange(ctx, trx, true, request.update.role)
            if (!selects(request.where, { id: target.id })) {
              throw teamRoleDenied()
            }
            const updated = await trx
              .updateTable('auth.member')
              .set({ role })
              .where('id', '=', target.id)
              .where('organizationId', '=', facts.organizationId)
              .returningAll()
              .executeTakeFirstOrThrow()
            await recordTeamRoleChange(trx, target, facts.userId, role)
            return updated as never
          })
        }
        return update(request)
      }
      adapter.incrementOne = async (request) => {
        const ctx = requests.getStore()?.ctx
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
          // Native acceptance uses this snapshot in its atomic member/session step.
          // The HTTP recipient lock spans that step, including distinct invitations.
          return trx
            .updateTable('auth.invitation')
            .set({ status: 'accepted' })
            .where('id', '=', stored.id)
            .where('status', '=', 'pending')
            .returningAll()
            .executeTakeFirstOrThrow() as never
        })
      }
      return adapter
    },
  }
}
