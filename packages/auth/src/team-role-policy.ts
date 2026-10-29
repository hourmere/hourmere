import { AsyncLocalStorage } from 'node:async_hooks'
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { Database, Db } from '@hourmere/db'
import type { DBTransactionAdapter, Where } from 'better-auth/adapters'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import type { Transaction } from 'kysely'
import type { AuthMiddlewareContext } from './api-keys.ts'
import type { Principal } from './caller.ts'
import { recordTeamRoleChange } from './organization-operations.ts'
import { isUuid } from './organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  teamRoles,
  teamSession,
  teamSessionUser,
} from './team-management.ts'
import { removeTeamMemberInTransaction, teamMemberRemovalTarget } from './team-member-removal.ts'

const invite = '/organization/invite-member'
const changeRole = '/organization/update-member-role'
const accept = '/organization/accept-invitation'
const remove = '/organization/remove-member'
const protectedPaths = new Set([invite, changeRole, accept, remove])

export const teamRoleDenied = () =>
  new APIError('FORBIDDEN', {
    code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
    message: 'team_management_access_denied',
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

/**
 * Keep Better Auth's native handlers, hooks and commit order. Only their narrow persistence
 * calls use the application transaction, so the shared actor locks and actual SQL write
 * use one connection. Holding those row locks around Better Auth's separate pool would
 * block its own FK checks; wrapping the whole handler would also change invitation hooks
 * that deliberately observe committed rows.
 */
export function createTeamRolePolicy(db: Db) {
  const requests = new AsyncLocalStorage<{ ctx?: AuthMiddlewareContext }>()

  function removalContext() {
    const current = requests.getStore()?.ctx
    if (current) return current
    // Server-side auth.api calls have the native endpoint context but do not pass
    // through the HTTP handler's request storage. Protect their removal writes too.
    const endpoint = tryGetCurrentAuthEndpointContext()
    if (endpoint?.path !== remove || !endpoint.body?.memberIdOrEmail) return undefined
    return endpoint as AuthMiddlewareContext
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
    return { actor: manager, member }
  }

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

  async function invitation(
    ctx: AuthMiddlewareContext,
    targetDb: Db,
    lock: boolean,
    actualRole: unknown = body(ctx).role,
  ) {
    const { facts } = await manager(ctx, targetDb, lock)
    if (fixedTeamRole(actualRole) !== 'member') throw teamRoleDenied()
    // Native resend retains the stored role and skips beforeCreateInvitation entirely.
    if (body(ctx).resend === true && typeof body(ctx).email === 'string') {
      const pending = await targetDb
        .selectFrom('auth.invitation')
        .select('role')
        .where('organizationId', '=', facts.organizationId)
        .where('email', '=', (body(ctx).email as string).toLowerCase())
        .where('status', '=', 'pending')
        .where('expiresAt', '>', new Date())
        .execute()
      if (pending.some((stored) => stored.role !== 'member')) throw teamRoleDenied()
    }
    return facts
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
      stored.email.toLowerCase() !== user.email.toLowerCase() ||
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
    return stored
  }

  const write = <T>(operation: (trx: Transaction<Database>) => Promise<T>) =>
    asAuthError(() => db.transaction().setIsolationLevel('read committed').execute(operation))

  return {
    /** Run before native lookups so denied targets never reveal whether they exist. */
    async before(ctx: AuthMiddlewareContext) {
      if (!protectedPaths.has(ctx.path)) return
      const state = requests.getStore()
      if (state) state.ctx = ctx
      if (!(await getSessionFromCtx(ctx))) return
      const input = body(ctx)
      if (ctx.path === invite && input.role === undefined) input.role = 'member'
      await asAuthError(async () => {
        if (ctx.path === remove) await removal(ctx, db, false)
        if (ctx.path === changeRole) await roleChange(ctx, db, false)
        if (ctx.path === invite) await invitation(ctx, db, false)
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
      const { create, update, findOne, incrementOne, delete: deleteOne } = adapter
      adapter.findOne = async <T>(request: Parameters<DBTransactionAdapter['findOne']>[0]) => {
        const result = await findOne<T>(request)
        const ctx = requests.getStore()?.ctx ?? removalContext()
        if (
          ctx &&
          (ctx.path === invite || ctx.path === changeRole || ctx.path === remove) &&
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
      adapter.delete = async (request) => {
        const ctx = removalContext()
        if (ctx?.path !== remove || request.model !== 'member') return deleteOne(request)
        return write(async (trx) => {
          const { actor, member } = await removal(ctx, trx, true)
          if (!selects(request.where, { id: member.id })) throw teamRoleDenied()
          // Bypass the native recorder here: this helper owns the member deletion,
          // dependent deactivation and one operation record on the same connection.
          await removeTeamMemberInTransaction(trx, actor, { memberUserId: member.userId })
        })
      }
      adapter.create = async (request) => {
        const ctx = requests.getStore()?.ctx
        if (ctx?.path !== invite || request.model !== 'invitation') return create(request)
        return write(async (trx) => {
          const data: Record<string, unknown> = request.data
          const actor = await invitation(ctx, trx, true, data.role)
          if (data.organizationId !== actor.organizationId || data.inviterId !== actor.userId) {
            throw teamRoleDenied()
          }
          if (
            typeof data.email !== 'string' ||
            !(data.expiresAt instanceof Date) ||
            !(data.createdAt instanceof Date)
          ) {
            throw teamRoleDenied()
          }
          return trx
            .insertInto('auth.invitation')
            .values({
              organizationId: actor.organizationId,
              inviterId: actor.userId,
              email: data.email,
              role: 'member',
              status: 'pending',
              expiresAt: data.expiresAt,
              createdAt: data.createdAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow() as never
        })
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
        if (ctx?.path === invite && request.model === 'invitation') {
          return write(async (trx) => {
            const actor = await invitation(ctx, trx, true)
            const id = request.where.find((where) => where.field === 'id')?.value
            if (
              typeof id !== 'string' ||
              !isUuid(id) ||
              !selects(request.where, { id }) ||
              body(ctx).resend !== true ||
              !(request.update.expiresAt instanceof Date)
            ) {
              throw teamRoleDenied()
            }
            const stored = await trx
              .selectFrom('auth.invitation')
              .selectAll()
              .where('id', '=', id)
              .where('organizationId', '=', actor.organizationId)
              .forUpdate()
              .executeTakeFirst()
            if (stored?.role !== 'member') throw teamRoleDenied()
            return trx
              .updateTable('auth.invitation')
              .set({ expiresAt: request.update.expiresAt })
              .where('id', '=', stored.id)
              .returningAll()
              .executeTakeFirstOrThrow() as never
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
          // Native acceptance uses this returned snapshot to create the member inside its
          // own member/session transaction. Never change that transaction's composition.
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
