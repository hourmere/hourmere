import type { Db } from '@hourmere/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { sql } from 'kysely'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { ensurePersonalOrganization, isMember, isUuid } from './organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  teamSession,
  teamSessionUser,
} from './team-management.ts'

const covered = new Set([
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
  '/organization/update',
])

const serialized = new Set([
  ...covered,
  '/organization/set-active',
  '/organization/create',
  '/organization/accept-invitation',
])
// Better Auth clears activeOrganizationId when these reads find a missing membership.
const serializedReads = new Set([
  '/organization/get-organization',
  '/organization/get-full-organization',
])

/**
 * Keep a web mutation and a switch of the same session in a single order across server
 * processes. Better Auth uses its own pool, so hold only an advisory lock here: holding a
 * session row lock would block the handler's own session updates. The original handler
 * runs inside the lock and resolves its session afresh; the pre-lock lookup identifies
 * only which lock to acquire. Transaction completion releases it on responses and errors.
 */
export function serializeOrganizationContext(
  lockDb: Db,
  handler: (request: Request) => Promise<Response>,
  readSession: (headers: Headers) => Promise<{ session: { id: string; userId: string } } | null>,
) {
  return async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, '').replace(/\/+$/, '')
    const needsLock =
      (request.method === 'POST' && serialized.has(path)) ||
      (request.method === 'GET' && serializedReads.has(path))
    if (!needsLock) return handler(request)
    const session = await readSession(request.headers)
    if (!session) return handler(request)
    return lockDb.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.organization-context:${session.session.id}`}, 0))`.execute(
        trx,
      )
      // Distinct legacy invitations can be accepted from different sessions of one user.
      // Hold the same recipient fence through native member/session commit or rollback;
      // row locks here would block Better Auth's own pool and break that transaction.
      if (path === '/organization/accept-invitation') {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.invitation-acceptance:${session.session.userId}`}, 0))`.execute(
          trx,
        )
      }
      return handler(request)
    })
  }
}

const changed = () =>
  new APIError('CONFLICT', {
    code: 'ORGANIZATION_CONTEXT_CHANGED',
    message: 'Your team context changed. Reload this page before trying again.',
  })

/**
 * A browser action belongs to the organization in which its form was opened. This is a
 * consistency check only: Better Auth still checks membership, roles and target rules.
 * Trusted server APIs and target-bound create/switch/accept/reject operations retain their
 * existing semantics, as do global profile, calendar and API-key operations.
 */
export async function organizationContext(ctx: AuthMiddlewareContext, db: Db) {
  // Launch limits also apply to trusted auth.api calls, before any native cascade.
  if (ctx.path === '/organization/delete') {
    throw new APIError('FORBIDDEN', {
      code: 'TEAM_OPERATION_NOT_SUPPORTED',
      message: 'Deleting a team is not supported.',
    })
  }
  if (!ctx.request) return
  // Creating or switching teams is target-bound, but still requires a proven identity.
  if (ctx.path === '/organization/create' || ctx.path === '/organization/set-active') {
    const session = await getSessionFromCtx(ctx)
    if (session) {
      const actor = {
        kind: 'session' as const,
        sessionId: session.session.id,
        user: session.user,
        organization: { id: '', name: '', slug: '', personal: false },
      }
      try {
        await teamSessionUser(db, actor, false)
        await teamSession(db, actor, false)
      } catch (error) {
        if (!(error instanceof TeamManagementError)) throw error
        throw new APIError('FORBIDDEN', {
          code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
          message: 'team_management_access_denied',
        })
      }
    }
  }
  const expected = ctx.request.headers.get('x-expected-organization-id')
  // Automatic follow-ups bind the source context; deliberate switching without an
  // expectation keeps its existing explicit-target contract.
  const boundSwitch = ctx.path === '/organization/set-active' && expected !== null
  if (!covered.has(ctx.path) && !boundSwitch) return
  const session = await getSessionFromCtx(ctx)
  if (!session) {
    if (boundSwitch) return
    throw new APIError('FORBIDDEN', {
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    })
  }
  if (expected !== null && !isUuid(expected)) {
    if (boundSwitch) throw changed()
    throw new APIError('FORBIDDEN', {
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    })
  }
  const body = ctx.body as Record<string, unknown> | undefined
  // Authorize before revealing context recovery, including legacy unverified sessions.
  if (!boundSwitch) {
    const targetId =
      expected && isUuid(expected)
        ? expected
        : typeof body?.organizationId === 'string'
          ? body.organizationId
          : session.session.activeOrganizationId
    if (typeof targetId !== 'string' || !isUuid(targetId)) {
      throw new APIError('FORBIDDEN', {
        code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
        message: 'team_management_access_denied',
      })
    }
    let selfRemoval = false
    if (ctx.path === '/organization/remove-member' && typeof body?.memberIdOrEmail === 'string') {
      selfRemoval = body.memberIdOrEmail.toLowerCase() === session.user.email.toLowerCase()
      if (!selfRemoval && isUuid(body.memberIdOrEmail)) {
        const self = await db
          .selectFrom('auth.member')
          .select('id')
          .where('organizationId', '=', targetId)
          .where('userId', '=', session.user.id)
          .where('id', '=', body.memberIdOrEmail)
          .executeTakeFirst()
        selfRemoval = Boolean(self)
      }
    }
    try {
      await checkTeamManagementAccess(
        db,
        {
          kind: 'session',
          sessionId: session.session.id,
          user: session.user,
          organization: { id: targetId, name: '', slug: '', personal: false },
        },
        targetId,
        false,
        {
          expectedOrganizationId: targetId,
          allowPersonal:
            ctx.path === '/organization/update' ||
            ctx.path === '/organization/leave' ||
            selfRemoval,
        },
        ctx.path === '/organization/leave' || selfRemoval,
      )
    } catch (error) {
      if (!(error instanceof TeamManagementError)) throw error
      if (error.code === 'organization_context_changed') throw changed()
      throw new APIError('FORBIDDEN', {
        code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
        message: 'team_management_access_denied',
      })
    }
  }
  if (expected === null) throw changed()
  const expectedId = expected.toLowerCase()
  // Read the live session, rather than trusting the organization cached while resolving
  // authentication. Removed members have the same personal fallback as REST callers.
  const live = await db
    .selectFrom('auth.session')
    .select('activeOrganizationId')
    .where('id', '=', session.session.id)
    .where('userId', '=', session.user.id)
    .where('expiresAt', '>', new Date())
    .executeTakeFirst()
  if (!live) throw changed()
  const active =
    live.activeOrganizationId && (await isMember(db, session.user.id, live.activeOrganizationId))
      ? live.activeOrganizationId
      : await ensurePersonalOrganization(db, session.user.id)
  if (expectedId !== active.toLowerCase()) {
    if (!boundSwitch) {
      try {
        await checkTeamManagementAccess(
          db,
          {
            kind: 'session',
            sessionId: session.session.id,
            user: session.user,
            organization: { id: active, name: '', slug: '', personal: false },
          },
          expectedId,
          false,
          { expectedOrganizationId: expectedId, allowPersonal: false },
          ctx.path === '/organization/leave',
        )
      } catch (error) {
        if (!(error instanceof TeamManagementError)) throw error
        if (error.code !== 'organization_context_changed') {
          throw new APIError('FORBIDDEN', {
            code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
            message: 'team_management_access_denied',
          })
        }
      }
    }
    throw changed()
  }
  if (boundSwitch) return

  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const requested = body.organizationId
  if (typeof requested === 'string' && requested.toLowerCase() !== expectedId) throw changed()
  // These endpoints default to the session object Better Auth already loaded, which can
  // differ from the live row after an overlapping switch. Check that actual target too.
  if (
    requested === undefined &&
    [
      '/organization/invite-member',
      '/organization/update-member-role',
      '/organization/remove-member',
      '/organization/update',
    ].includes(ctx.path)
  ) {
    const target = session.session as { activeOrganizationId?: string | null }
    if (target.activeOrganizationId?.toLowerCase() !== expectedId) throw changed()
  }

  // Invitation ids are independent targets: a matching request organization does
  // not prove that the object belongs to it. Scope lookups so missing and other-team ids
  // produce the same recoverable refusal without revealing object existence.
  // Role changes and removals instead use the shared policy's uniform target denial.
  if (ctx.path === '/organization/cancel-invitation' && typeof body.invitationId === 'string') {
    const invitation = await db
      .selectFrom('auth.invitation')
      .select('id')
      .where('id', '=', body.invitationId)
      .where('organizationId', '=', expectedId)
      .executeTakeFirst()
    if (!invitation) throw changed()
  }
}
