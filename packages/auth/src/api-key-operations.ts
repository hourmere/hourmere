import type { ApiKeyScope } from './api-key-metadata.ts'

export type ApiKeyOperationClass =
  | 'booking_read'
  | 'booking_write'
  | 'other_read'
  | 'other_write'
  /** Reads of the audit journal: who did what. Full-scope keys only. */
  | 'audit_read'
  | 'diagnostic_read'
  | 'session_only'
  | 'public_metadata'

export interface ApiKeyOperation {
  readonly id: string
  readonly operationClass: ApiKeyOperationClass
  readonly allowedScopes: readonly ApiKeyScope[]
}

export interface ApiKeyRestOperation extends ApiKeyOperation {
  readonly method: string
  readonly path: string
  readonly authentication: 'key' | 'optional_key' | 'session_only' | 'public_metadata'
}

export interface ApiKeyMcpOperation extends ApiKeyOperation {
  readonly tool: string
  readonly mode?: string
  readonly rest: readonly string[]
}

export interface ApiKeyCliOperation extends ApiKeyOperation {
  readonly command: string
  readonly tool: string
}

/** Native protocols never gain API-key authentication through the product scope layer. */
export const API_KEY_NATIVE_REST_BOUNDARIES = Object.freeze([
  'GET /api/health',
  'GET /api/calendar/google/callback',
  'GET /api/calendar/microsoft/callback',
  'GET /api/conference/zoom/callback',
  'POST /api/conference/zoom/events',
])

const classScopes: Readonly<Record<ApiKeyOperationClass, readonly ApiKeyScope[]>> = Object.freeze({
  booking_read: Object.freeze(['full', 'read', 'bookings'] as const),
  booking_write: Object.freeze(['full', 'bookings'] as const),
  other_read: Object.freeze(['full', 'read'] as const),
  other_write: Object.freeze(['full'] as const),
  audit_read: Object.freeze(['full'] as const),
  // Read-only, but repeated diagnostics can reveal busy timings, so only full keys.
  diagnostic_read: Object.freeze(['full'] as const),
  session_only: Object.freeze([]),
  public_metadata: Object.freeze(['full', 'read', 'bookings'] as const),
})

function rest(
  method: string,
  path: string,
  operationClass: ApiKeyOperationClass,
  authentication: ApiKeyRestOperation['authentication'],
): ApiKeyRestOperation {
  return Object.freeze({
    id: `${method} ${path}`,
    method,
    path,
    operationClass,
    authentication,
    allowedScopes: classScopes[operationClass],
  })
}

/** Explicit accepted scope contract. New routes, tools, modes and aliases need a row. */
export const API_KEY_REST_OPERATIONS: readonly ApiKeyRestOperation[] = Object.freeze([
  rest('POST', '/api/v1/public/meeting-polls/read', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/enroll', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/recover', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/verify', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/vote', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/withdraw', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/meeting-polls/reminder-opt-out', 'booking_write', 'optional_key'),

  rest('GET', '/api/v1/analytics/bookings', 'other_read', 'key'),
  rest('GET', '/api/v1/routing-forms', 'other_read', 'key'),
  rest('GET', '/api/v1/routing-forms/{id}', 'other_read', 'key'),
  rest('POST', '/api/v1/routing-forms', 'other_write', 'key'),
  rest('PATCH', '/api/v1/routing-forms/{id}', 'other_write', 'key'),
  rest('DELETE', '/api/v1/routing-forms/{id}', 'other_write', 'key'),
  rest('POST', '/api/v1/routing-forms/{id}/publish', 'other_write', 'key'),
  rest('POST', '/api/v1/routing-forms/{id}/preview', 'other_write', 'key'),
  rest(
    'GET',
    '/api/v1/organizations/{organizationId}/provisioning-tokens',
    'session_only',
    'session_only',
  ),
  rest(
    'POST',
    '/api/v1/organizations/{organizationId}/provisioning-tokens',
    'session_only',
    'session_only',
  ),
  rest(
    'POST',
    '/api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate',
    'session_only',
    'session_only',
  ),
  rest(
    'DELETE',
    '/api/v1/organizations/{organizationId}/provisioning-tokens/{id}',
    'session_only',
    'session_only',
  ),

  rest('GET', '/api/v1/audit-events', 'audit_read', 'key'),
  rest('GET', '/api/v1/audit-log/settings', 'audit_read', 'key'),
  rest('PUT', '/api/v1/audit-log/settings', 'other_write', 'key'),
  rest('GET', '/api/v1/branding', 'other_read', 'key'),
  rest('GET', '/api/v1/branding/logo/{hash}', 'other_read', 'key'),
  rest('PATCH', '/api/v1/branding', 'other_write', 'key'),
  rest('POST', '/api/v1/branding/logo', 'other_write', 'key'),
  rest('GET', '/api/v1/book/{token}', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/book/{token}/slots', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/book/{token}/bookings', 'booking_write', 'optional_key'),
  rest('GET', '/api/v1/bookings/{id}/attendees', 'booking_read', 'key'),
  rest('GET', '/api/v1/group-occurrences/{id}/attendees', 'booking_read', 'key'),
  rest('POST', '/api/v1/group-occurrences/{id}/cancel', 'booking_write', 'key'),
  rest('GET', '/api/v1/bookings', 'booking_read', 'key'),
  rest('GET', '/api/v1/bookings/export.csv', 'other_read', 'key'),
  rest('GET', '/api/v1/bookings/{id}', 'booking_read', 'key'),
  rest('GET', '/api/v1/bookings/{id}/organization', 'session_only', 'session_only'),
  rest('POST', '/api/v1/bookings/{id}/calendar-copy/retry', 'booking_write', 'key'),
  rest('POST', '/api/v1/bookings/{id}/cancel', 'booking_write', 'key'),
  rest('PATCH', '/api/v1/bookings/{id}/attendees/{attendeeId}/no-show', 'booking_write', 'key'),
  rest('POST', '/api/v1/bookings/{id}/conference/retry', 'booking_write', 'key'),
  rest('POST', '/api/v1/bookings/{id}/reschedule', 'booking_write', 'key'),
  rest('POST', '/api/v1/bookings/{id}/request-reschedule', 'booking_write', 'key'),
  rest('GET', '/api/v1/bookings/{id}/slots', 'booking_read', 'key'),
  rest('GET', '/api/v1/bookings/manage', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/bookings/manage/cancel', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/bookings/manage/reschedule', 'booking_write', 'optional_key'),
  rest('GET', '/api/v1/bookings/manage/slots', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/calendar-connections', 'other_read', 'key'),
  rest('DELETE', '/api/v1/calendar-connections/{id}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/calendar-connections/{id}/refresh', 'other_write', 'key'),
  rest('POST', '/api/v1/calendar-connections/caldav/discover', 'session_only', 'session_only'),
  rest('POST', '/api/v1/calendar-connections/caldav', 'session_only', 'session_only'),
  rest('POST', '/api/v1/calendar-connections/google/authorize', 'session_only', 'session_only'),
  rest('POST', '/api/v1/calendar-connections/microsoft/authorize', 'session_only', 'session_only'),
  rest('PUT', '/api/v1/calendar-destination', 'other_write', 'key'),
  rest('PATCH', '/api/v1/calendars/{id}', 'other_write', 'key'),
  rest('POST', '/api/v1/calendars/{id}/sync', 'other_write', 'key'),
  rest('GET', '/api/v1/conference-connections', 'other_read', 'key'),
  rest('DELETE', '/api/v1/conference-connections/{id}', 'session_only', 'session_only'),
  rest(
    'POST',
    '/api/v1/conference-connections/{id}/authorize-meetings',
    'session_only',
    'session_only',
  ),
  rest('POST', '/api/v1/conference-connections/{id}/reconnect', 'session_only', 'session_only'),
  rest('POST', '/api/v1/conference-connections/{id}/refresh', 'session_only', 'session_only'),
  rest('POST', '/api/v1/conference-connections/zoom/authorize', 'session_only', 'session_only'),
  rest(
    'POST',
    '/api/v1/conference-connections/zoom/authorize-meetings',
    'session_only',
    'session_only',
  ),
  rest('GET', '/api/v1/event-type-hosts', 'other_read', 'key'),
  rest('GET', '/api/v1/event-types', 'booking_read', 'key'),
  rest('POST', '/api/v1/event-types', 'other_write', 'key'),
  rest('GET', '/api/v1/event-types/{id}', 'booking_read', 'key'),
  rest('DELETE', '/api/v1/event-types/{id}', 'other_write', 'key'),
  rest('PATCH', '/api/v1/event-types/{id}', 'other_write', 'key'),
  rest('PUT', '/api/v1/event-types/{id}/notifications', 'other_write', 'key'),
  rest('GET', '/api/v1/event-types/{id}/waitlist', 'other_read', 'key'),
  rest('PUT', '/api/v1/event-types/{id}/waitlist', 'other_write', 'key'),
  rest('GET', '/api/v1/event-types/{id}/waitlist/entries', 'other_read', 'key'),
  rest('DELETE', '/api/v1/event-types/{id}/waitlist/entries/{entryId}', 'other_write', 'key'),
  rest('POST', '/api/v1/open-time-snippets', 'booking_read', 'key'),
  rest('GET', '/api/v1/event-types/{id}/availability-troubleshooting', 'diagnostic_read', 'key'),
  rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links', 'other_read', 'key'),
  rest('POST', '/api/v1/event-types/{eventTypeId}/one-time-links', 'booking_write', 'key'),
  rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'other_read', 'key'),
  rest('DELETE', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'booking_write', 'key'),
  rest('POST', '/api/v1/event-types/{id}/duplicate', 'other_write', 'key'),
  rest('POST', '/api/v1/event-types/{id}/round-robin/activate', 'other_write', 'key'),
  rest('GET', '/api/v1/instance', 'public_metadata', 'public_metadata'),
  rest('GET', '/api/v1/instance/embed', 'session_only', 'session_only'),
  rest('GET', '/api/v1/mcp-oauth/connections', 'session_only', 'session_only'),
  rest('DELETE', '/api/v1/mcp-oauth/connections/{id}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/mcp-oauth/consent', 'session_only', 'session_only'),
  rest('POST', '/api/v1/mcp-oauth/request', 'session_only', 'session_only'),
  rest('POST', '/api/v1/mcp-oauth/select', 'session_only', 'session_only'),
  rest('GET', '/api/v1/me', 'booking_read', 'key'),
  rest('GET', '/api/v1/profile', 'booking_read', 'key'),
  rest('PUT', '/api/v1/profile', 'other_write', 'key'),
  rest('PATCH', '/api/v1/profile/name', 'other_write', 'key'),
  rest(
    'GET',
    '/api/v1/public/branding/{organizationId}/logo/{hash}',
    'public_metadata',
    'public_metadata',
  ),
  rest('GET', '/api/v1/public/{handle}', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/public/-/routing/{handle}/{slug}', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/public/-/routing/teams/{teamSlug}/{slug}', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/public/{handle}/{slug}', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/public/{handle}/{slug}/bookings', 'booking_write', 'optional_key'),
  rest('GET', '/api/v1/public/{handle}/{slug}/slots', 'booking_read', 'optional_key'),
  rest('GET', '/api/v1/public/teams/{handle}/{slug}', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/public/teams/{handle}/{slug}/bookings', 'booking_write', 'optional_key'),
  rest('GET', '/api/v1/public/teams/{handle}/{slug}/slots', 'booking_read', 'optional_key'),
  rest('POST', '/api/v1/public/{handle}/{slug}/waitlist', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/{handle}/{slug}/waitlist/resend', 'booking_write', 'optional_key'),
  rest('POST', '/api/v1/public/teams/{handle}/{slug}/waitlist', 'booking_write', 'optional_key'),
  rest(
    'POST',
    '/api/v1/public/teams/{handle}/{slug}/waitlist/resend',
    'booking_write',
    'optional_key',
  ),
  rest('GET', '/api/v1/readiness/self', 'session_only', 'session_only'),
  rest('GET', '/api/v1/schedules', 'other_read', 'key'),
  rest('POST', '/api/v1/schedules', 'other_write', 'key'),
  rest('GET', '/api/v1/schedules/{id}', 'other_read', 'key'),
  rest('GET', '/api/v1/schedules/{id}/availability', 'other_read', 'key'),
  rest('PUT', '/api/v1/schedules/{id}/availability', 'other_write', 'key'),
  rest('DELETE', '/api/v1/schedules/{id}', 'other_write', 'key'),
  rest('PATCH', '/api/v1/schedules/{id}', 'other_write', 'key'),
  rest('GET', '/api/v1/schedules/{id}/overrides', 'other_read', 'key'),
  rest('PUT', '/api/v1/schedules/{id}/overrides/{date}', 'other_write', 'key'),
  rest('DELETE', '/api/v1/schedules/{id}/overrides/{date}', 'other_write', 'key'),
  rest('POST', '/api/v1/schedules/default', 'other_write', 'key'),
  rest('GET', '/api/v1/team/bookings', 'session_only', 'session_only'),
  rest('GET', '/api/v1/team/bookings/{id}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/bookings/{id}/cancel', 'session_only', 'session_only'),
  rest('GET', '/api/v1/team/invitations', 'session_only', 'session_only'),
  rest('GET', '/api/v1/team/invitations/{invitationId}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/invitations/{invitationId}/cancel', 'session_only', 'session_only'),
  rest('GET', '/api/v1/team/member-removals/{operationId}', 'session_only', 'session_only'),
  rest(
    'GET',
    '/api/v1/team/members/{memberUserId}/departure-impact',
    'session_only',
    'session_only',
  ),
  rest('POST', '/api/v1/team/members/{memberUserId}/removal', 'session_only', 'session_only'),
  rest(
    'GET',
    '/api/v1/team/members/{memberUserId}/removal-handling',
    'session_only',
    'session_only',
  ),
  rest('POST', '/api/v1/teams/{teamId}/leave', 'session_only', 'session_only'),
  rest('GET', '/api/v1/teams/{teamId}/member-readiness', 'session_only', 'session_only'),
  rest('GET', '/api/v1/teams/{teamId}/readiness', 'session_only', 'session_only'),
  rest('GET', '/api/v1/slack-destinations', 'other_read', 'key'),
  rest('POST', '/api/v1/slack-destinations', 'other_write', 'key'),
  rest('PATCH', '/api/v1/slack-destinations/{id}', 'other_write', 'key'),
  rest('DELETE', '/api/v1/slack-destinations/{id}', 'other_write', 'key'),
  rest('POST', '/api/v1/slack-destinations/{id}/test', 'other_write', 'key'),
  rest('GET', '/api/v1/webhooks', 'other_read', 'key'),
  rest('POST', '/api/v1/webhooks', 'other_write', 'key'),
  rest('DELETE', '/api/v1/webhooks/{id}', 'other_write', 'key'),
  rest('PATCH', '/api/v1/webhooks/{id}', 'other_write', 'key'),
  rest('GET', '/api/v1/webhooks/{id}/deliveries', 'other_read', 'key'),
  rest('POST', '/api/v1/webhooks/{id}/rotate-secret', 'other_write', 'key'),
  rest('DELETE', '/api/v1/workflows/{id}', 'other_write', 'key'),
  rest('PATCH', '/api/v1/workflows/{id}', 'other_write', 'key'),
  rest('POST', '/api/v1/workflows', 'other_write', 'key'),
  rest('GET', '/api/v1/workflows', 'other_read', 'key'),
  rest('GET', '/api/v1/workflows/{id}', 'other_read', 'key'),
  rest('POST', '/api/v1/team/sso/domains', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/sso/domains/{domainId}/verify', 'session_only', 'session_only'),
  rest('DELETE', '/api/v1/team/sso/domains/{domainId}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/sso/providers', 'session_only', 'session_only'),
  rest('PATCH', '/api/v1/team/sso/providers/{providerId}', 'session_only', 'session_only'),
  rest('DELETE', '/api/v1/team/sso/providers/{providerId}', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/sso/providers/{providerId}/test', 'session_only', 'session_only'),
  rest('POST', '/api/v1/team/sso/providers/{providerId}/link', 'session_only', 'session_only'),
  rest('DELETE', '/api/v1/team/sso/providers/{providerId}/link', 'session_only', 'session_only'),
  rest(
    'DELETE',
    '/api/v1/team/sso/providers/{providerId}/links/{linkId}',
    'session_only',
    'session_only',
  ),
  rest('GET', '/api/v1/team/sso/providers', 'other_read', 'key'),
  rest('GET', '/api/v1/team/sso/policy', 'other_read', 'key'),
  rest('GET', '/api/v1/openapi.json', 'public_metadata', 'public_metadata'),
])

function mcp(
  tool: string,
  operationClass: ApiKeyOperationClass,
  equivalents: readonly string[],
  mode?: string,
): ApiKeyMcpOperation {
  return Object.freeze({
    id: `mcp:${tool}${mode === undefined ? '' : `:${mode}`}`,
    tool,
    ...(mode === undefined ? {} : { mode }),
    operationClass,
    allowedScopes: classScopes[operationClass],
    rest: Object.freeze([...equivalents]),
  })
}

export const API_KEY_MCP_OPERATIONS: readonly ApiKeyMcpOperation[] = Object.freeze([
  mcp('read_meeting_poll', 'booking_read', ['POST /api/v1/public/meeting-polls/read']),
  mcp('enroll_meeting_poll_voter', 'booking_write', ['POST /api/v1/public/meeting-polls/enroll']),
  mcp('recover_meeting_poll_voter', 'booking_write', ['POST /api/v1/public/meeting-polls/recover']),
  mcp('verify_meeting_poll_voter', 'booking_write', ['POST /api/v1/public/meeting-polls/verify']),
  mcp('submit_meeting_poll_vote', 'booking_write', ['POST /api/v1/public/meeting-polls/vote']),
  mcp('withdraw_meeting_poll_vote', 'booking_write', [
    'POST /api/v1/public/meeting-polls/withdraw',
  ]),
  mcp('opt_out_meeting_poll_reminder', 'booking_write', [
    'POST /api/v1/public/meeting-polls/reminder-opt-out',
  ]),

  mcp('list_routing_forms', 'other_read', ['GET /api/v1/routing-forms']),
  mcp('get_routing_form', 'other_read', ['GET /api/v1/routing-forms/{id}']),
  mcp('create_routing_form', 'other_write', ['POST /api/v1/routing-forms']),
  mcp('update_routing_form', 'other_write', ['PATCH /api/v1/routing-forms/{id}']),
  mcp('archive_routing_form', 'other_write', ['DELETE /api/v1/routing-forms/{id}']),
  mcp('publish_routing_form', 'other_write', ['POST /api/v1/routing-forms/{id}/publish']),
  mcp('preview_routing_form', 'other_write', ['POST /api/v1/routing-forms/{id}/preview']),
  mcp('get_public_routing_form', 'booking_read', [
    'GET /api/v1/public/-/routing/{handle}/{slug}',
    'GET /api/v1/public/-/routing/teams/{teamSlug}/{slug}',
  ]),
  mcp('list_audit_events', 'audit_read', ['GET /api/v1/audit-events']),
  mcp('get_audit_log_settings', 'audit_read', ['GET /api/v1/audit-log/settings']),
  mcp('set_audit_log_settings', 'other_write', ['PUT /api/v1/audit-log/settings']),
  mcp('get_branding', 'other_read', ['GET /api/v1/branding']),
  mcp('set_branding', 'other_write', ['PATCH /api/v1/branding']),
  mcp('list_slack_destinations', 'other_read', ['GET /api/v1/slack-destinations']),
  mcp('create_slack_destination', 'other_write', ['POST /api/v1/slack-destinations']),
  mcp('update_slack_destination', 'other_write', ['PATCH /api/v1/slack-destinations/{id}']),
  mcp('delete_slack_destination', 'other_write', ['DELETE /api/v1/slack-destinations/{id}']),
  mcp('test_slack_destination', 'other_write', ['POST /api/v1/slack-destinations/{id}/test']),
  mcp('list_webhooks', 'other_read', ['GET /api/v1/webhooks']),
  mcp('create_webhook', 'other_write', ['POST /api/v1/webhooks']),
  mcp('update_webhook', 'other_write', ['PATCH /api/v1/webhooks/{id}']),
  mcp('delete_webhook', 'other_write', ['DELETE /api/v1/webhooks/{id}']),
  mcp('whoami', 'booking_read', ['GET /api/v1/me']),
  mcp('find_available_slots', 'booking_read', [
    'GET /api/v1/public/{handle}/{slug}/slots',
    'GET /api/v1/public/teams/{handle}/{slug}/slots',
  ]),
  mcp(
    'find_available_slots',
    'booking_read',
    ['GET /api/v1/public/{handle}/{slug}/slots'],
    'personal',
  ),
  mcp(
    'find_available_slots',
    'booking_read',
    ['GET /api/v1/public/teams/{handle}/{slug}/slots'],
    'team',
  ),
  mcp('create_booking', 'booking_write', [
    'POST /api/v1/book/{token}/bookings',
    'POST /api/v1/public/{handle}/{slug}/bookings',
    'POST /api/v1/public/teams/{handle}/{slug}/bookings',
  ]),
  mcp(
    'create_booking',
    'booking_write',
    ['POST /api/v1/public/{handle}/{slug}/bookings'],
    'personal',
  ),
  mcp(
    'create_booking',
    'booking_write',
    ['POST /api/v1/public/teams/{handle}/{slug}/bookings'],
    'team',
  ),
  mcp('create_booking', 'booking_write', ['POST /api/v1/book/{token}/bookings'], 'oneTimeLink'),
  mcp('request_reschedule', 'booking_write', ['POST /api/v1/bookings/{id}/request-reschedule']),
  mcp('reschedule_booking', 'booking_write', [
    'POST /api/v1/bookings/{id}/reschedule',
    'POST /api/v1/bookings/manage/reschedule',
  ]),
  mcp('reschedule_booking', 'booking_write', ['POST /api/v1/bookings/{id}/reschedule'], 'host'),
  mcp(
    'reschedule_booking',
    'booking_write',
    ['POST /api/v1/bookings/manage/reschedule'],
    'manageToken',
  ),
  mcp('cancel_booking', 'booking_write', [
    'POST /api/v1/bookings/{id}/cancel',
    'POST /api/v1/bookings/manage/cancel',
  ]),
  mcp('cancel_booking', 'booking_write', ['POST /api/v1/bookings/{id}/cancel'], 'host'),
  mcp('cancel_booking', 'booking_write', ['POST /api/v1/bookings/manage/cancel'], 'manageToken'),
  mcp('list_bookings', 'booking_read', ['GET /api/v1/bookings']),
  mcp('set_attendee_no_show', 'booking_write', [
    'PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show',
  ]),
  mcp('get_booking_attendees', 'booking_read', ['GET /api/v1/bookings/{id}/attendees']),
  mcp('get_group_occurrence_attendees', 'booking_read', [
    'GET /api/v1/group-occurrences/{id}/attendees',
  ]),
  mcp('cancel_group_occurrence', 'booking_write', ['POST /api/v1/group-occurrences/{id}/cancel']),
  mcp('export_bookings', 'other_read', ['GET /api/v1/bookings/export.csv']),
  mcp('get_booking_activity', 'other_read', ['GET /api/v1/analytics/bookings']),
  mcp('retry_conference', 'booking_write', ['POST /api/v1/bookings/{id}/conference/retry']),
  mcp('retry_calendar_copy', 'booking_write', ['POST /api/v1/bookings/{id}/calendar-copy/retry']),
  mcp('get_profile', 'booking_read', ['GET /api/v1/profile']),
  mcp('list_event_types', 'booking_read', ['GET /api/v1/event-types']),
  mcp('get_event_type', 'booking_read', ['GET /api/v1/event-types/{id}']),
  mcp('set_event_type_notifications', 'other_write', [
    'PUT /api/v1/event-types/{id}/notifications',
  ]),
  mcp('list_schedules', 'other_read', ['GET /api/v1/schedules']),
  mcp('get_schedule', 'other_read', ['GET /api/v1/schedules/{id}']),
  mcp('get_schedule_availability', 'other_read', ['GET /api/v1/schedules/{id}/availability']),
  mcp('save_schedule_availability', 'other_write', ['PUT /api/v1/schedules/{id}/availability']),
  mcp('duplicate_event_type', 'other_write', ['POST /api/v1/event-types/{id}/duplicate']),
  mcp('create_event_type', 'other_write', ['POST /api/v1/event-types']),
  mcp('update_event_type', 'other_write', ['PATCH /api/v1/event-types/{id}']),
  mcp('generate_open_time_snippet', 'booking_read', ['POST /api/v1/open-time-snippets']),
  mcp('troubleshoot_availability', 'diagnostic_read', [
    'GET /api/v1/event-types/{id}/availability-troubleshooting',
  ]),
  mcp('create_one_time_link', 'booking_write', [
    'POST /api/v1/event-types/{eventTypeId}/one-time-links',
  ]),
  mcp('list_one_time_links', 'other_read', [
    'GET /api/v1/event-types/{eventTypeId}/one-time-links',
  ]),
  mcp('revoke_one_time_link', 'booking_write', [
    'DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
  ]),
  mcp('list_calendar_connections', 'other_read', ['GET /api/v1/calendar-connections']),
  mcp('list_conference_connections', 'other_read', ['GET /api/v1/conference-connections']),
  mcp('get_event_type_waitlist', 'other_read', ['GET /api/v1/event-types/{id}/waitlist']),
  mcp('set_event_type_waitlist', 'other_write', ['PUT /api/v1/event-types/{id}/waitlist']),
  mcp('list_waitlist_entries', 'other_read', ['GET /api/v1/event-types/{id}/waitlist/entries']),
  mcp('remove_waitlist_entry', 'other_write', [
    'DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}',
  ]),
  ...['join_waitlist', 'resend_waitlist_verification'].flatMap((tool) => {
    const suffix = tool === 'join_waitlist' ? '' : '/resend'
    const personal = `POST /api/v1/public/{handle}/{slug}/waitlist${suffix}`
    const team = `POST /api/v1/public/teams/{handle}/{slug}/waitlist${suffix}`
    return [
      mcp(tool, 'booking_write', [personal, team]),
      mcp(tool, 'booking_write', [personal], 'personal'),
      mcp(tool, 'booking_write', [team], 'team'),
    ]
  }),
  mcp('delete_workflow', 'other_write', ['DELETE /api/v1/workflows/{id}']),
  mcp('update_workflow', 'other_write', ['PATCH /api/v1/workflows/{id}']),
  mcp('create_workflow', 'other_write', ['POST /api/v1/workflows']),
  mcp('list_sso_providers', 'other_read', ['GET /api/v1/team/sso/providers']),
  mcp('get_sso_policy', 'other_read', ['GET /api/v1/team/sso/policy']),
  mcp('list_workflows', 'other_read', ['GET /api/v1/workflows']),
  mcp('get_workflow', 'other_read', ['GET /api/v1/workflows/{id}']),
])

function cli(command: string, tool: string): ApiKeyCliOperation {
  const policy = API_KEY_MCP_OPERATIONS.find(
    (operation) => operation.tool === tool && operation.mode === undefined,
  )
  if (!policy) throw new Error(`CLI scope policy references missing MCP tool: ${tool}`)
  return Object.freeze({
    id: `cli:${command}`,
    command,
    tool,
    operationClass: policy.operationClass,
    allowedScopes: policy.allowedScopes,
  })
}

export const API_KEY_CLI_OPERATIONS: readonly ApiKeyCliOperation[] = Object.freeze([
  cli('polls view', 'read_meeting_poll'),
  cli('polls join', 'enroll_meeting_poll_voter'),
  cli('polls recover', 'recover_meeting_poll_voter'),
  cli('polls verify', 'verify_meeting_poll_voter'),
  cli('polls vote', 'submit_meeting_poll_vote'),
  cli('polls withdraw', 'withdraw_meeting_poll_vote'),
  cli('polls reminder-opt-out', 'opt_out_meeting_poll_reminder'),

  cli('whoami', 'whoami'),
  cli('routing-forms list', 'list_routing_forms'),
  cli('routing-forms get', 'get_routing_form'),
  cli('routing-forms create', 'create_routing_form'),
  cli('routing-forms update', 'update_routing_form'),
  cli('routing-forms archive', 'archive_routing_form'),
  cli('routing-forms publish', 'publish_routing_form'),
  cli('routing-forms preview', 'preview_routing_form'),
  cli('routing-forms public', 'get_public_routing_form'),
  cli('audit-log list', 'list_audit_events'),
  cli('audit-log settings', 'get_audit_log_settings'),
  cli('audit-log set-retention', 'set_audit_log_settings'),
  cli('branding get', 'get_branding'),
  cli('branding set', 'set_branding'),
  cli('profile', 'get_profile'),
  cli('catalog', 'list_event_types'),
  cli('event', 'get_event_type'),
  cli('duplicate-event', 'duplicate_event_type'),
  cli('create-event', 'create_event_type'),
  cli('update-event', 'update_event_type'),
  cli('set-event-notifications', 'set_event_type_notifications'),
  cli('schedules', 'list_schedules'),
  cli('schedule', 'get_schedule'),
  cli('schedule-availability', 'get_schedule_availability'),
  cli('save-availability', 'save_schedule_availability'),
  cli('slots', 'find_available_slots'),
  cli('book', 'create_booking'),
  cli('list', 'list_bookings'),
  cli('export', 'export_bookings'),
  cli('reschedule', 'reschedule_booking'),
  cli('request-reschedule', 'request_reschedule'),
  cli('cancel', 'cancel_booking'),
  cli('booking-attendees', 'get_booking_attendees'),
  cli('group-attendees', 'get_group_occurrence_attendees'),
  cli('cancel-group', 'cancel_group_occurrence'),
  cli('set-no-show', 'set_attendee_no_show'),
  cli('booking-activity', 'get_booking_activity'),
  cli('retry-meeting', 'retry_conference'),
  cli('retry-calendar-copy', 'retry_calendar_copy'),
  cli('event-waitlist', 'get_event_type_waitlist'),
  cli('set-event-waitlist', 'set_event_type_waitlist'),
  cli('waitlist-entries', 'list_waitlist_entries'),
  cli('remove-waitlist-entry', 'remove_waitlist_entry'),
  cli('join-waitlist', 'join_waitlist'),
  cli('resend-waitlist-verification', 'resend_waitlist_verification'),
  cli('open-time-snippet', 'generate_open_time_snippet'),
  cli('troubleshoot-availability', 'troubleshoot_availability'),
  cli('slack list', 'list_slack_destinations'),
  cli('slack create', 'create_slack_destination'),
  cli('slack update', 'update_slack_destination'),
  cli('slack delete', 'delete_slack_destination'),
  cli('slack test', 'test_slack_destination'),
  cli('webhooks list', 'list_webhooks'),
  cli('webhooks create', 'create_webhook'),
  cli('webhooks update', 'update_webhook'),
  cli('webhooks delete', 'delete_webhook'),
  cli('one-time-links create', 'create_one_time_link'),
  cli('one-time-links list', 'list_one_time_links'),
  cli('one-time-links revoke', 'revoke_one_time_link'),
  cli('workflows delete', 'delete_workflow'),
  cli('workflows update', 'update_workflow'),
  cli('workflows create', 'create_workflow'),
  cli('sso providers list', 'list_sso_providers'),
  cli('sso policy', 'get_sso_policy'),
  cli('workflows list', 'list_workflows'),
  cli('workflows get', 'get_workflow'),
])

export type ClassifiedApiKeyOperation =
  | ApiKeyRestOperation
  | ApiKeyMcpOperation
  | ApiKeyCliOperation

export const API_KEY_OPERATIONS: readonly ClassifiedApiKeyOperation[] = Object.freeze([
  ...API_KEY_REST_OPERATIONS,
  ...API_KEY_MCP_OPERATIONS,
  ...API_KEY_CLI_OPERATIONS,
])

const operations = new Map(API_KEY_OPERATIONS.map((operation) => [operation.id, operation]))

/** Exact stable IDs only: HTTP verbs, prefixes and MCP hints never grant authority. */
export function apiKeyOperation(operationId: string): ClassifiedApiKeyOperation | undefined {
  return operations.get(operationId)
}
