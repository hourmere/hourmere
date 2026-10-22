import { literal, type MessageKey, msg, type UiText } from '../i18n/translate.ts'
import type { components } from './schema.d.ts'

/** Documented aliases this client understands; unknown aliases fall back to `error`. */
const errorAliases: ReadonlySet<string> = new Set<components['schemas']['ErrorAlias']>([
  'zoom_operation_busy',
])
/** A request the server answered with an error status. `message` is safe to show. */
export class RequestError extends Error {
  readonly displayMessage: UiText | undefined
  readonly status: number
  /** The machine-readable code: `error` for /api/v1, `code` for Better Auth's /api/auth. */
  readonly code: string | undefined
  /** A recognized additive alias; `code` retains the original API error. */
  readonly codeAlias: string | undefined

  constructor(
    status: number,
    code: string | undefined,
    message: string,
    displayMessage?: UiText,
    codeAlias?: string,
  ) {
    super(message)
    this.name = 'RequestError'
    this.displayMessage = displayMessage
    this.status = status
    this.code = code
    this.codeAlias = codeAlias
  }
}

export const UNREACHABLE = "Can't reach Hourmere. Check your connection and try again."

function messageForStatus(status: number): MessageKey {
  if (status === 401) return 'Your session has ended. Sign in again.'
  if (status === 403) return "You don't have permission to do that."
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.'
  return 'That did not work. Try again.'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The error for a response with status `status` and parsed body `body`. Both APIs send
 * human-readable messages meant to be shown (https://hourmere.com/docs/api-conventions); without one, the
 * status decides.
 */
export function requestError(status: number, body: unknown): RequestError {
  const record = isRecord(body) ? body : {}
  const code =
    typeof record.error === 'string'
      ? record.error
      : typeof record.code === 'string'
        ? record.code
        : undefined
  const oauthMessages: Record<string, string> = {
    mcp_oauth_disabled: 'MCP OAuth is disabled on this Hourmere instance.',
    oauth_request_expired:
      'This connection attempt expired or was already used. Restart it from your AI app.',
    invalid_oauth_request:
      'This connection request is invalid or expired. Restart it from your AI app.',
    oauth_organization_forbidden: 'You no longer have access to the selected organization.',
  }
  const oauthMessage = code && Object.hasOwn(oauthMessages, code) ? oauthMessages[code] : undefined
  const message =
    oauthMessage ??
    (typeof record.message === 'string' && record.message.trim()
      ? record.message
      : messageForStatus(status))
  const codeAlias =
    typeof record.errorAlias === 'string' && errorAliases.has(record.errorAlias)
      ? record.errorAlias
      : undefined
  // Schema validation names the offending fields in server prose. Keep those details
  // literal instead of replacing them with the generic localized form guidance.
  const displayMessage =
    code === 'invalid_request' && typeof record.message === 'string' && record.message.trim()
      ? literal(record.message)
      : undefined
  return new RequestError(status, code, message, displayMessage, codeAlias)
}

export async function errorFromResponse(response: Response): Promise<RequestError> {
  const body: unknown = await response.json().catch(() => undefined)
  return requestError(response.status, body)
}

/** What to tell people about a failed request (or any other error). */
export function errorMessage(err: unknown): UiText {
  if (!(err instanceof RequestError)) return msg(UNREACHABLE)
  if (err.displayMessage) return err.displayMessage
  const known: Readonly<Record<string, MessageKey>> = {
    invalid_request: 'Check the form and try again.',
    invalid_calendar_settings: 'Check your calendar settings and try again.',
    invalid_calendar_access: 'Choose calendar-list access or calendar synchronization.',
    profile_not_found: 'Create your profile in Settings first.',
    session_required: 'Your session has ended. Sign in again.',
    invalid_oauth_state: 'This connection attempt expired or was already used. Start again.',
    calendar_connection_not_found: 'This calendar connection no longer exists.',
    calendar_not_found: 'This calendar is no longer available. Refresh the calendar list.',
    calendar_selection_limit: 'Select at most 20 conflict calendars.',
    calendar_events_unreadable: 'This calendar does not allow event synchronization.',
    calendar_sync_disabled: 'Select this calendar for conflict checks before synchronizing it.',
    calendar_not_writable: 'Choose an owned Google calendar and enable synchronization first.',
    google_calendar_disabled:
      'Google Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
    google_calendar_provider_unavailable:
      'Google Calendar could not be reached. Try again shortly.',
    microsoft_calendar_disabled:
      'Microsoft Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
    microsoft_calendar_provider_unavailable:
      'Microsoft Calendar could not be reached. Try again shortly.',
    microsoft_calendar_needs_reauth: 'Reconnect Microsoft Calendar to restore access.',
    microsoft_calendar_permissions_missing:
      'Reconnect Microsoft Calendar and allow the requested permissions.',
    automatic_zoom_disabled: 'Automatic Zoom meetings are disabled on this instance.',
    automatic_zoom_unavailable:
      'Automatic Zoom meetings are unavailable. Contact the host or choose another meeting type.',
    automatic_zoom_host_policy:
      'Automatic Zoom supports individual meetings with exactly one host.',
    zoom_host_session_required:
      'The assigned host must configure Zoom in their own signed-in session.',
    invalid_zoom_connection:
      'Choose your own active Zoom account with meeting permissions. Reconnect it in Conference accounts if needed.',
    conference_session_required: 'Sign in again to manage conference accounts.',
    zoom_meetings_disabled: 'Automatic Zoom meetings are disabled on this instance.',
    zoom_mode_conflict:
      'Identity-only authorization cannot replace meeting permissions. Reconnect this Zoom account with its existing meeting permissions.',
    zoom_disabled: 'Zoom connections are not configured on this instance.',
    zoom_connection_not_found: 'This Zoom connection is not available.',
    zoom_connection_limit: 'This account has reached its limit of five connected Zoom identities.',
    zoom_needs_reauth: 'Reconnect this Zoom account before refreshing it.',
    zoom_operation_busy: 'Zoom account operations are busy. Try again shortly.',
    zoom_refresh_in_progress: 'Zoom account operations are busy. Try again shortly.',
    zoom_permissions_missing:
      'Zoom did not return exactly the requested permissions. Check the app configuration and reconnect.',
    zoom_provider_unavailable:
      'Zoom could not be reached. Check the connection status before trying again.',
    zoom_identity_mismatch: 'Choose the same Zoom account when reconnecting this connection.',
    zoom_refresh_incomplete: 'This Zoom refresh could not be confirmed. Reconnect the account.',

    mcp_oauth_disabled: 'MCP OAuth is disabled on this Hourmere instance.',
    oauth_request_expired:
      'This connection attempt expired or was already used. Restart it from your AI app.',
    invalid_oauth_request:
      'This connection request is invalid or expired. Restart it from your AI app.',
    oauth_organization_forbidden: 'You no longer have access to the selected organization.',
    booking_cancelled: 'This booking was already cancelled.',
    booking_in_past: 'This meeting has already started, so it can’t be changed.',
    booking_reschedule_limit:
      'This booking has been rescheduled the maximum number of times. Contact the host to change it again.',
    slot_taken: 'Someone else just booked that time. Please pick another one.',
    slot_unavailable: 'That time is no longer available. Please pick another one.',
    EMAIL_NOT_VERIFIED:
      'Confirm your email address by signing in with an email link before using API keys',
    calendar_reauth_required: 'Reconnect Google Calendar',
    calendar_connection_needs_reauth: 'Reconnect Google Calendar',
    google_calendar_needs_reauth: 'Reconnect Google Calendar',
    google_calendar_permissions_missing: 'Reconnect before enabling busy times.',
    schedule_is_default: 'Make another schedule the default before deleting this one',
    default_schedule: 'Make another schedule the default before deleting this one',
    default_schedule_required: 'Make another schedule the default before deleting this one',
    invalid_hosts: 'Check the form and try again.',
    automatic_meet_disabled:
      'Automatic meeting links are unavailable. Contact the host or choose another meeting type.',
    automatic_meet_unavailable:
      'Automatic meeting links are unavailable. Contact the host or choose another meeting type.',
    automatic_meet_mode_unsupported:
      'Automatic Google Meet supports individual meetings with one host only.',
    booking_hosts_unavailable:
      'This booking can no longer be moved to another time. You can still cancel it, or contact your host.',
  }
  const code = err.codeAlias ?? err.code
  const key = code && Object.hasOwn(known, code) ? known[code] : undefined
  if (key) return msg(key)
  if (
    err.status === 401 ||
    err.status === 403 ||
    err.status === 429 ||
    err.status >= 500 ||
    !err.message
  )
    return msg(messageForStatus(err.status))
  // Unknown server prose stays verbatim. It is never treated as a translation key.
  return literal(err.message)
}
