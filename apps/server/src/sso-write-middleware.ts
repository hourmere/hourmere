import { withTeamWriteCheck } from '@hourmere/db/team-write'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import {
  requireTeamRead,
  type SsoTeamReadDeps,
  type TeamReadCheck,
  teamReadAccess,
  teamWriteCheck,
} from './sso-team-reads.ts'

export async function withTeamWriteAccess<T>(
  deps: SsoTeamReadDeps,
  principal: CallerEnv['Variables']['principal'],
  check: TeamReadCheck,
  write: () => Promise<T>,
): Promise<T> {
  const access = await check()
  requireTeamRead(access)
  const machineWithPolicy = principal.kind !== 'session' && principal.ssoDelegationStatus != null
  // An enabled resource handler can provision and suspend during the request,
  // even when resolution found no existing SCIM connection.
  const scimTeam =
    !principal.organization.personal && (principal.scimProvisioned || deps.scimResourcesEnabled)
  return access.policy || machineWithPolicy || scimTeam
    ? withTeamWriteCheck(teamWriteCheck(deps, principal), write)
    : write()
}

const registered = new WeakSet<object>()

export function isTeamWriteMiddleware(handler: object) {
  return registered.has(handler)
}

export function teamWriteMiddleware(deps: SsoTeamReadDeps) {
  const middleware = createMiddleware<CallerEnv>(async (c, next) => {
    const principal = c.var.principal
    await withTeamWriteAccess(deps, principal, teamReadAccess(deps, principal), next)
  })
  registered.add(middleware)
  return middleware
}
