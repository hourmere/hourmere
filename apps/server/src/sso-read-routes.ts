import { API_KEY_REST_OPERATIONS } from '@hourmere/auth'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
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
// These previews require full API-key scope and only read team data.
postReads.add('POST /api/v1/routing-forms/{id}/preview')
postReads.add('POST /api/v1/workflows/preview')

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
  return 'active_team'
}

const checks = new WeakMap<Context, TeamReadCheck>()
const registered = new WeakSet<object>()

export function isTeamReadMiddleware(handler: object) {
  return registered.has(handler)
}

export function restTeamReadAccess(c: Context) {
  return checks.get(c)
}

export function teamReadMiddleware(
  deps: SsoTeamReadDeps,
  route: NonNullable<ReturnType<typeof teamReadRoute>>,
) {
  const middleware = createMiddleware<CallerEnv>(async (c, next) => {
    const principal = c.var.principal
    const check = teamReadAccess(deps, principal)
    checks.set(c, check)
    // The booking handoff first resolves its authorized target. The browser's own
    // summary uses the access decision to limit its projection during enrollment.
    if (route === 'active_team' || (route === 'own_summary' && principal.kind !== 'session'))
      requireTeamRead(await check())
    await next()
  })
  registered.add(middleware)
  return middleware
}
