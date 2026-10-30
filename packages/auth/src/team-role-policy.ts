import { AsyncLocalStorage } from 'node:async_hooks'
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { Database, Db } from '@hourmere/db'
import type { DBTransactionAdapter, Where } from 'better-auth/adapters'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { type Insertable, sql, type Transaction } from 'kysely'
import type { AuthMiddlewareContext } from './api-keys.ts'
import type { Principal } from './caller.ts'
import {
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
} from './member-departure.ts'
import { recordTeamRoleChange } from './organization-operations.ts'
import { isUuid, personalOwner } from './organizations.ts'
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

const changeRole = '/organization/update-member-role'
const accept = '/organization/accept-invitation'
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

  function operationContext() {
    const current = requests.getStore()?.ctx
    if (current) return current
    // Server-side auth.api calls have the native endpoint context but do not pass
    // through the HTTP handler's request storage. Protect their membership writes too.
    const endpoint = tryGetCurrentAuthEndpointContext()
    if (
      !endpoint ||
      (!selfDeparturePaths.has(endpoint.path ?? '') && !protectedPaths.has(endpoint.path ?? '')) ||
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
      .where('id', '=', memberId)
      .where('organizationId', '=', facts.organizationId)
    if (lock) targetQuery = targetQuery.forUpdate()
    const target = await targetQuery.executeTakeFirst()
    if (!target || target.userId === facts.userId || teamRoles(target.role).includes('owner'))
      throw teamRoleDenied()
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
          if (!actor || (await personalOwner(db, actor.organization.id))) return response
          // Keep Better Auth's early sole-owner refusal intact. Its native 400 and our
          // locked write refusal describe the same conflict, including legacy roles.
          const error = new MemberDepartureOwnerRequiredError()
          const headers = new Headers(response.headers)
          headers.delete('content-length')
          return new Response(
            JSON.stringify({ code: error.code, message: error.message, handling: error.handling }),
            { status: 409, headers },
          )
        })
    },

    adapter(adapter: DBTransactionAdapter): DBTransactionAdapter {
      const { create, update, findOne, findMany, incrementOne, delete: deleteOne } = adapter
      adapter.create = async (request) => {
        const ctx = operationContext()
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
            return trx
              .insertInto('auth.organization')
              .values(request.data as Insertable<Database['auth.organization']>)
              .returningAll()
              .executeTakeFirstOrThrow() as never
          })
        }
        return create(request)
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
      adapter.update = async (request) => {
        const ctx = operationContext()
        if (
          ctx?.request &&
          ctx.path === setActiveOrganization &&
          request.model === 'session' &&
          'activeOrganizationId' in request.update
        ) {
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
            const targetId = request.update.activeOrganizationId
            if (targetId !== null) {
              if (typeof targetId !== 'string' || !isUuid(targetId)) throw teamRoleDenied()
              const organization = await trx
                .selectFrom('auth.organization')
                .select('id')
                .where('id', '=', targetId)
                .forShare()
                .executeTakeFirst()
              if (!organization) throw teamRoleDenied()
              await checkTeamManagementMembership(trx, actor.user.id, targetId, true, true, true)
            }
            const live = await teamSession(trx, actor, true)
            const expected = ctx.request?.headers.get('x-expected-organization-id') ?? null
            if (expected !== null) {
              const activeMember =
                live.activeOrganizationId && isUuid(live.activeOrganizationId)
                  ? await trx
                      .selectFrom('auth.member')
                      .select('id')
                      .where('organizationId', '=', live.activeOrganizationId)
                      .where('userId', '=', actor.user.id)
                      .executeTakeFirst()
                  : undefined
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
            return trx
              .updateTable('auth.session')
              .set({ activeOrganizationId: targetId as string | null, updatedAt: new Date() })
              .where('id', '=', actor.sessionId)
              .where('userId', '=', actor.user.id)
              .returningAll()
              .executeTakeFirstOrThrow() as never
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
            const patch = request.update as {
              name?: string
              slug?: string
              logo?: string | null
              metadata?: string | null
            }
            return trx
              .updateTable('auth.organization')
              .set(patch)
              .where('id', '=', facts.organizationId)
              .returningAll()
              .executeTakeFirstOrThrow() as never
          })
        }
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
            return trx
              .updateTable('auth.invitation')
              .set({ status: 'rejected' })
              .where('id', '=', invitationId)
              .where('organizationId', '=', organization.id)
              .where('status', '=', 'pending')
              .returningAll()
              .executeTakeFirstOrThrow() as never
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
