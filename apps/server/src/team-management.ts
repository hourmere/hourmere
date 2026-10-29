import type { Principal } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { createMiddleware } from 'hono/factory'
import { sql, type Transaction } from 'kysely'
import type { CallerEnv } from './caller.ts'
import type { CallerMiddleware } from './openapi.ts'

interface TeamManager {
  userId: string
  organizationId: string
  role: 'owner' | 'admin'
}

const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
export const EXPECTED_ORGANIZATION_HEADER = 'X-Expected-Organization-Id'
export const ORGANIZATION_CONTEXT_CHANGED =
  'organization_context_changed: reload the page before trying this team write again'
const contextChanged = () =>
  new DomainError(
    'conflict',
    'organization_context_changed',
    'Your team context changed. Reload the page before trying again.',
  )

/** Current database facts only: principal organization metadata and client roles are not authority. */
async function check(
  db: Db,
  principal: Principal,
  teamId: string,
  lock = false,
  context?: { expectedOrganizationId: string; allowPersonal: boolean },
): Promise<TeamManager> {
  if (
    context &&
    (!uuid(context.expectedOrganizationId) ||
      context.expectedOrganizationId.toLowerCase() !== teamId.toLowerCase())
  )
    throw contextChanged()
  if (
    principal.kind !== 'session' ||
    !uuid(principal.user.id) ||
    !uuid(principal.sessionId) ||
    !uuid(teamId) ||
    teamId.toLowerCase() !== principal.organization.id.toLowerCase()
  )
    throw denied()

  let userQuery = db
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', principal.user.id)
  if (lock) userQuery = userQuery.forShare()
  const user = await userQuery.executeTakeFirst()
  if (!user?.emailVerified) throw denied()

  let organizationQuery = db.selectFrom('auth.organization').select('id').where('id', '=', teamId)
  // Serialize team-management writes, including organization edits and self role changes,
  // without competing SHARE → UPDATE upgrades in their callbacks.
  if (lock) organizationQuery = organizationQuery.forUpdate()
  const organization = await organizationQuery.executeTakeFirst()
  if (!organization) throw denied()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('organization_id')
    .where('organization_id', '=', teamId)
    .executeTakeFirst()
  if (personal && !context?.allowPersonal) throw denied()

  // Re-read AFTER acquiring the parent locks: a revocation committed while waiting wins.
  let memberQuery = db
    .selectFrom('auth.member')
    .select('role')
    .where('userId', '=', principal.user.id)
    .where('organizationId', '=', teamId)
  if (lock) memberQuery = memberQuery.forShare()
  const member = await memberQuery.executeTakeFirst()
  // Better Auth can store multiple roles. Only these exact known tokens grant management.
  const roles = member?.role.split(',').map((role) => role.trim()) ?? []
  const role = roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : undefined
  if (!role) throw denied()

  // Also refuse a session invalidated since requireCaller (including email-proof rotation).
  // Check expiry AFTER acquiring the session lock too: a WHERE predicate can have been
  // evaluated before waiting for an unchanged locked row. Use wall time, not BEGIN time.
  let sessionQuery = db
    .selectFrom('auth.session')
    .select(['expiresAt', 'activeOrganizationId'])
    .where('id', '=', principal.sessionId)
    .where('userId', '=', principal.user.id)
  if (lock) sessionQuery = sessionQuery.forShare()
  const session = await sessionQuery.executeTakeFirst()
  if (!session) throw denied()
  const validity = await db
    .selectNoFrom(sql<boolean>`${session.expiresAt}::timestamptz > clock_timestamp()`.as('active'))
    .executeTakeFirstOrThrow()
  if (!validity.active) throw denied()

  if (context && session.activeOrganizationId?.toLowerCase() !== organization.id.toLowerCase()) {
    // The caller resolver falls back to the personal organization when the active team's
    // membership has gone. Recompute that effective context from current database facts.
    const activeMembership =
      session.activeOrganizationId && uuid(session.activeOrganizationId)
        ? await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', session.activeOrganizationId)
            .where('userId', '=', principal.user.id)
            .executeTakeFirst()
        : undefined
    if (activeMembership || !personal) throw contextChanged()
  }

  return { userId: principal.user.id, organizationId: organization.id, role }
}

/**
 * Bind existing event-type web writes to their draft's organization. Scheduling calls this
 * inside its write transaction, before taking any locks. Reuse the shared management
 * check and its user → organization → member → session locks; never trust the header as
 * membership or role authority. API-key/OAuth bindings remain independent of web context.
 */
export function organizationWriteAccess(principal: Principal, expectedOrganizationId?: string) {
  return async (db: Db, organizationId: string, targetId?: string): Promise<void> => {
    if (principal.kind !== 'session') return
    // A missing header cannot distinguish a personal form from an old team form whose
    // session has since switched or fallen back to personal after membership removal.
    if (expectedOrganizationId === undefined) throw contextChanged()
    await check(db, principal, organizationId, true, {
      expectedOrganizationId,
      allowPersonal: true,
    })
    if (targetId !== undefined) {
      // Do not distinguish another organization's object from a missing object. The same
      // recoverable refusal also prevents an expected=current forgery targeting another team.
      if (!uuid(targetId)) throw contextChanged()
      const target = await db
        .selectFrom('event_types')
        .select('id')
        .where('id', '=', targetId)
        .where('organization_id', '=', organizationId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([eb('owner_user_id', 'is', null), eb('owner_user_id', '=', principal.user.id)]),
        )
        .executeTakeFirst()
      if (!target) throw contextChanged()
    }
  }
}

/**
 * Host booking actions keep their existing explicit-ID authority. Browser callers may
 * additionally bind the action to its opening organization; older clients and credentials
 * retain their existing contract. Run first inside the service's write transaction so the
 * live context and membership remain valid through commit, without granting management roles.
 */
export function bookingWriteAccess(principal: Principal, expectedOrganizationId?: string) {
  return async (db: Db, organizationId: string): Promise<void> => {
    if (principal.kind !== 'session' || expectedOrganizationId === undefined) return
    if (
      !uuid(expectedOrganizationId) ||
      !uuid(principal.user.id) ||
      !uuid(principal.sessionId) ||
      expectedOrganizationId.toLowerCase() !== organizationId.toLowerCase() ||
      organizationId.toLowerCase() !== principal.organization.id.toLowerCase()
    )
      throw contextChanged()

    // A context transition uses its dedicated lock pool and then reads the app database.
    // Booking writes may overlap; only an exclusive context transition should conflict.
    // Refuse that contention promptly so waiting transactions cannot fill the lock pool.
    const lock = await sql<{
      locked: boolean
    }>`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${`hourmere.organization-context:${principal.sessionId}`}, 0)) AS locked`.execute(
      db,
    )
    if (!lock.rows[0]?.locked) throw contextChanged()
    const user = await db
      .selectFrom('auth.user')
      .select('emailVerified')
      .where('id', '=', principal.user.id)
      .forShare()
      .executeTakeFirst()
    const organization = await db
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', organizationId)
      .forShare()
      .executeTakeFirst()
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', principal.user.id)
      .where('organizationId', '=', organizationId)
      .forShare()
      .executeTakeFirst()
    const session = await db
      .selectFrom('auth.session')
      .select(['expiresAt', 'activeOrganizationId'])
      .where('id', '=', principal.sessionId)
      .where('userId', '=', principal.user.id)
      .forShare()
      .executeTakeFirst()
    if (!user?.emailVerified || !organization || !member || !session) throw contextChanged()
    const validity = await db
      .selectNoFrom(
        sql<boolean>`${session.expiresAt}::timestamptz > clock_timestamp()`.as('active'),
      )
      .executeTakeFirstOrThrow()
    if (!validity.active) throw contextChanged()

    const activeMember =
      session.activeOrganizationId && uuid(session.activeOrganizationId)
        ? await db
            .selectFrom('auth.member')
            .select('id')
            .where('userId', '=', principal.user.id)
            .where('organizationId', '=', session.activeOrganizationId)
            .executeTakeFirst()
        : undefined
    const personal = activeMember
      ? undefined
      : await db
          .selectFrom('personal_organizations')
          .select('organization_id')
          .where('user_id', '=', principal.user.id)
          .executeTakeFirst()
    const effectiveOrganizationId = activeMember
      ? session.activeOrganizationId
      : personal?.organization_id
    if (effectiveOrganizationId?.toLowerCase() !== organizationId.toLowerCase())
      throw contextChanged()
  }
}

/**
 * Shared entry for new team-management web routes.
 *
 * In a RouteModule, create `const access = teamManagementAccess(db, caller)` and declare
 * `middleware: access.middleware`. This preserves requireCaller's Origin/Referer checks,
 * then applies the existing sessionOnly pattern with fresh verified team owner/admin facts.
 * Bind read targets with `access.read(principal, teamId, ...)`. Read and validate the
 * request body before calling `access.write(principal, teamId, ...)`.
 *
 * `write` owns a READ COMMITTED transaction. All database writes must use its `trx` and
 * returned actor, with target objects scoped to actor.organizationId. It rechecks eligibility
 * under user → organization → member locks (then the session), held through callback commit.
 * Do not acquire these locks before calling it, nest another transaction, or do provider I/O
 * in the callback. Callback failures roll back the entire write.
 *
 * Every eligibility denial is the same 403 team_management_access_denied, including missing
 * teams: this check reveals no target existence. It grants management entry only; consumers
 * must enforce operation/target rules (e.g. owner-only role changes). Expected-organization
 * context drift checks are a separate layer; teamId must come from the bound operation/target,
 * never be silently replaced by the active organization. Existing API-key/OAuth routes keep
 * their own authorization and organization bindings.
 */
export function teamManagementAccess(db: Db, caller: CallerMiddleware) {
  const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
    await check(db, c.var.principal, c.var.principal.organization.id)
    await next()
  })
  return {
    middleware: [caller, sessionOnly] as [CallerMiddleware, typeof sessionOnly],
    /** Recheck the bound team before loading any read data; no provider I/O. */
    async read<T>(
      principal: Principal,
      teamId: string,
      operation: (db: Db, actor: TeamManager) => Promise<T>,
    ): Promise<T> {
      return operation(db, await check(db, principal, teamId))
    },
    write<T>(
      principal: Principal,
      teamId: string,
      operation: (trx: Transaction<Database>, actor: TeamManager) => Promise<T>,
    ): Promise<T> {
      return db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => operation(trx, await check(trx, principal, teamId, true)))
    },
  }
}
