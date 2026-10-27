import {
  checkTeamManagementAccess,
  type Principal,
  TeamManagementError,
  type TeamManager,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { createMiddleware } from 'hono/factory'
import type { Transaction } from 'kysely'
import type { CallerEnv } from './caller.ts'
import type { CallerMiddleware } from './openapi.ts'

export const EXPECTED_ORGANIZATION_HEADER = 'X-Expected-Organization-Id'
export const ORGANIZATION_CONTEXT_CHANGED =
  'organization_context_changed: reload the page before trying this team write again'
const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const contextChanged = () =>
  new DomainError(
    'conflict',
    'organization_context_changed',
    'Your team context changed. Reload the page before trying again.',
  )

async function check(...args: Parameters<typeof checkTeamManagementAccess>): Promise<TeamManager> {
  try {
    return await checkTeamManagementAccess(...args)
  } catch (error) {
    if (!(error instanceof TeamManagementError)) throw error
    if (error.code === 'organization_context_changed') throw contextChanged()
    throw new DomainError('forbidden', error.code)
  }
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
