import { API_KEY_MCP_OPERATIONS, API_KEY_REST_OPERATIONS } from '@hourmere/auth'
import { teamReadRoute } from './sso-read-routes.ts'

const publicOperations = new Set(
  API_KEY_REST_OPERATIONS.filter(
    (op) => op.authentication === 'optional_key' || op.authentication === 'public_metadata',
  ).map((op) => op.id),
)

const writeExceptions = new Set([
  // The caller owns these settings independently of the active organization.
  'PATCH /api/v1/profile/name',
  'PUT /api/v1/profile',
  'POST /api/v1/schedules/default',
  'POST /api/v1/schedules',
  'PUT /api/v1/schedules/{id}/availability',
  'PATCH /api/v1/schedules/{id}',
  'DELETE /api/v1/schedules/{id}',
  'PUT /api/v1/schedules/{id}/overrides/{date}',
  'DELETE /api/v1/schedules/{id}/overrides/{date}',
  'POST /api/v1/calendar-connections/google/authorize',
  'POST /api/v1/calendar-connections/microsoft/authorize',
  'PATCH /api/v1/calendars/{id}',
  'POST /api/v1/calendars/{id}/sync',
  'PUT /api/v1/calendar-destination',
  'DELETE /api/v1/calendar-connections/{id}',
  'POST /api/v1/calendar-connections/{id}/refresh',
  'POST /api/v1/calendar-connections/caldav/discover',
  'POST /api/v1/calendar-connections/caldav',
  'POST /api/v1/conference-connections/zoom/authorize',
  'POST /api/v1/conference-connections/{id}/reconnect',
  'POST /api/v1/conference-connections/zoom/authorize-meetings',
  'POST /api/v1/conference-connections/{id}/authorize-meetings',
  'POST /api/v1/conference-connections/{id}/refresh',
  'DELETE /api/v1/conference-connections/{id}',
  // OAuth request only reads the ceremony; delegation enforcement owns consent.
  'POST /api/v1/mcp-oauth/request',
  'POST /api/v1/mcp-oauth/select',
  'POST /api/v1/mcp-oauth/consent',
  'DELETE /api/v1/mcp-oauth/connections/{id}',
  // Independent proof permits the caller to enroll or withdraw their own link.
  'POST /api/v1/team/sso/providers/{providerId}/link',
  'DELETE /api/v1/team/sso/providers/{providerId}/link',
  // A current member can withdraw their own delegated authority without a live proof.
  'DELETE /api/v1/team/sso/delegations/{bindingId}',
])

/** New versioned writes inherit enforcement unless their operation has an exact exception. */
export function teamWriteRoute(operation: string): boolean {
  const [method, path] = operation.split(' ')
  return (
    (path === '/api/v1' || !!path?.startsWith('/api/v1/')) &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'OPTIONS' &&
    !publicOperations.has(operation) &&
    !writeExceptions.has(operation) &&
    !teamReadRoute(operation)
  )
}

const teamWrites = new Set(
  API_KEY_MCP_OPERATIONS.filter((op) => op.rest.some(teamWriteRoute)).map((op) => op.id),
)

/** Use the tool's selected scope mode for tools with both host and capability paths. */
export function teamWriteTool(toolName: string, mode: string | undefined): boolean {
  return teamWrites.has(mode === undefined ? `mcp:${toolName}` : `mcp:${toolName}:${mode}`)
}
