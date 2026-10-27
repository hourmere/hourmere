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

/** Current database facts only: principal organization metadata and client roles are not authority. */
async function check(
  db: Db,
  principal: Principal,
  teamId: string,
  lock = false,
): Promise<TeamManager> {
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
  if (personal) throw denied()

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
    .select('expiresAt')
    .where('id', '=', principal.sessionId)
    .where('userId', '=', principal.user.id)
  if (lock) sessionQuery = sessionQuery.forShare()
  const session = await sessionQuery.executeTakeFirst()
  if (!session) throw denied()
  const validity = await db
    .selectNoFrom(sql<boolean>`${session.expiresAt}::timestamptz > clock_timestamp()`.as('active'))
    .executeTakeFirstOrThrow()
  if (!validity.active) throw denied()

  return { userId: principal.user.id, organizationId: organization.id, role }
}

/**
 * Shared entry for new team-management web routes (TS04).
 *
 * In a RouteModule, create `const access = teamManagementAccess(db, caller)` and declare
 * `middleware: access.middleware`. This preserves requireCaller's Origin/Referer checks,
 * then applies the existing sessionOnly pattern with fresh verified team owner/admin facts.
 * Read and validate the request body before calling `access.write(principal, teamId, ...)`.
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
 * context drift checks belong to CTX-SERVER; teamId must come from the bound operation/target,
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
