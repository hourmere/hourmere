import { withTeamWriteCheck } from '@hourmere/db/team-write'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import { hasSsoRecoveryAuthority } from './sso-recovery-use.ts'
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
  const machineWithPolicy =
    principal.kind !== 'session' &&
    principal.ssoDelegationStatus !== undefined &&
    principal.ssoDelegationStatus !== null
  return access.policy || machineWithPolicy
    ? withTeamWriteCheck(teamWriteCheck(deps, principal), write)
    : write()
}

const registered = new WeakSet<object>()
const recoveryWrites = new WeakSet<Context>()

export function isTeamWriteMiddleware(handler: object) {
  return registered.has(handler)
}

export function isSsoRecoveryWrite(c: Context) {
  return recoveryWrites.has(c)
}

export function teamWriteMiddleware(deps: SsoTeamReadDeps, recoveryPublicUrl?: string) {
  const middleware = createMiddleware<CallerEnv>(async (c, next) => {
    const principal = c.var.principal
    const check = teamReadAccess(deps, principal)
    if (recoveryPublicUrl !== undefined) {
      const access = await check()
      if (
        !access.allowed &&
        !access.suspended &&
        (await hasSsoRecoveryAuthority(deps.db, principal, c.req.raw.headers, recoveryPublicUrl))
      ) {
        // The policy service must consume the grant under lock before executing the write.
        recoveryWrites.add(c)
        return next()
      }
    }
    await withTeamWriteAccess(deps, principal, check, next)
  })
  registered.add(middleware)
  return middleware
}
