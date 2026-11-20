import { API_KEY_REST_OPERATIONS } from '@hourmere/auth'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import { hasSsoRecoveryAuthority } from './sso-recovery-use.ts'
import {
  requireTeamRead,
  type SsoTeamReadDeps,
  type TeamReadCheck,
  teamReadAccess,
} from './sso-team-reads.ts'

const publicOperations = new Set(
  API_KEY_REST_OPERATIONS.filter(
    (op) => op.authentication === 'optional_key' || op.authentication === 'public_metadata',
  ).map((op) => op.id),
)

// These reads do not use the active team to scope their data.
const accountReads = new Set([
  'GET /api/v1/profile',
  'GET /api/v1/schedules',
  'GET /api/v1/schedules/{id}',
  'GET /api/v1/schedules/{id}/availability',
  'GET /api/v1/schedules/{id}/overrides',
  'GET /api/v1/calendar-connections',
  'GET /api/v1/conference-connections',
  'GET /api/v1/instance/embed',
  'GET /api/v1/mcp-oauth/connections',
])

const readClasses = new Set(['booking_read', 'other_read', 'audit_read', 'diagnostic_read'])
const postReads = new Set(
  API_KEY_REST_OPERATIONS.filter(
    (op) => op.method === 'POST' && readClasses.has(op.operationClass),
  ).map((op) => op.id),
)
// Preview requires full API-key scope and does not publish or save a draft.
postReads.add('POST /api/v1/routing-forms/{id}/preview')

export function teamReadRoute(operation: string) {
  const [method, path] = operation.split(' ')
  if (
    !path?.startsWith('/api/v1/') ||
    publicOperations.has(operation) ||
    accountReads.has(operation) ||
    (method !== 'GET' && method !== 'HEAD' && !postReads.has(operation))
  )
    return
  if (operation === 'GET /api/v1/bookings/{id}/organization') return 'resolved_target'
  if (operation === 'GET /api/v1/me') return 'own_summary'
  if (operation === 'GET /api/v1/team/sso/providers' || operation === 'GET /api/v1/team/sso/policy')
    return 'sso_configuration'
  return 'active_team'
}

const checks = new WeakMap<Context, TeamReadCheck>()
const recoveryReads = new WeakSet<Context>()
const registered = new WeakSet<object>()

export function isTeamReadMiddleware(handler: object) {
  return registered.has(handler)
}

export function restTeamReadAccess(c: Context) {
  return checks.get(c)
}

export function isSsoRecoveryRead(c: Context) {
  return recoveryReads.has(c)
}

export function teamReadMiddleware(
  deps: SsoTeamReadDeps & { publicUrl: string },
  route: NonNullable<ReturnType<typeof teamReadRoute>>,
) {
  const middleware = createMiddleware<CallerEnv>(async (c, next) => {
    const principal = c.var.principal
    const check = teamReadAccess(deps, principal)
    checks.set(c, check)
    // The booking handoff first resolves its authorized target. The browser's own
    // summary uses the access decision to limit its projection during enrollment.
    if (route === 'sso_configuration') {
      const access = await check()
      if (
        !access.allowed &&
        (await hasSsoRecoveryAuthority(deps.db, principal, c.req.raw.headers, deps.publicUrl))
      )
        recoveryReads.add(c)
      else requireTeamRead(access)
    } else if (
      route === 'active_team' ||
      (route === 'own_summary' && principal.kind !== 'session')
    ) {
      requireTeamRead(await check())
    }
    await next()
  })
  registered.add(middleware)
  return middleware
}
