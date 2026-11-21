import { withTeamWriteCheck } from '@hourmere/db/team-write'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import { hasSsoRecoveryAuthority, otherSsoRecoveryTeam } from './sso-recovery-use.ts'
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
    !principal.organization.personal &&
    (principal.scimProvisioned === true || deps.scimResourcesEnabled === true)
  return access.policy || machineWithPolicy || scimTeam
    ? withTeamWriteCheck(teamWriteCheck(deps, principal, scimTeam), write)
    : write()
}

const registered = new WeakSet<object>()
const recoveryWrites = new WeakMap<Context, CallerEnv['Variables']['principal']>()

export function isTeamWriteMiddleware(handler: object) {
  return registered.has(handler)
}

export function ssoRecoveryWritePrincipal(c: Context) {
  return recoveryWrites.get(c)
}

export function teamWriteMiddleware(deps: SsoTeamReadDeps, recoveryPublicUrl?: string) {
  const middleware = createMiddleware<CallerEnv>(async (c, next) => {
    const principal = c.var.principal
    const check = teamReadAccess(deps, principal)
    if (recoveryPublicUrl !== undefined) {
      const headers = c.req.raw.headers
      const target = otherSsoRecoveryTeam(principal, headers)
      if (target && (await hasSsoRecoveryAuthority(deps.db, target, headers, recoveryPublicUrl))) {
        // The route's service must consume the grant under lock before executing the write.
        recoveryWrites.set(c, target)
        return next()
      }
      const access = await check()
      if (
        !access.allowed &&
        !access.suspended &&
        !target &&
        (await hasSsoRecoveryAuthority(deps.db, principal, headers, recoveryPublicUrl))
      ) {
        recoveryWrites.set(c, principal)
        return next()
      }
    }
    await withTeamWriteAccess(deps, principal, check, next)
  })
  registered.add(middleware)
  return middleware
}
