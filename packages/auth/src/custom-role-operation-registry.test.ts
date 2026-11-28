import { customRoleCatalogueV1 } from '@hourmere/core'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_CLI_OPERATIONS,
  API_KEY_MCP_OPERATIONS,
  API_KEY_REST_OPERATIONS,
  SCIM_MAPPING_SCOPE_OPERATIONS,
} from './api-key-operations.ts'

const catalogue: ReadonlySet<string> = new Set([
  ...customRoleCatalogueV1.fixed,
  ...customRoleCatalogueV1.phaseOne,
  ...customRoleCatalogueV1.phaseTwoPersonalData,
])

// Existing operations added after freezing the v1 catalogue remain Fixed.
const fixedOutsideV1: ReadonlySet<string> = new Set([
  'permissions.read_self',
  'custom_roles.read',
  'custom_roles.create',
  'custom_roles.revise',
  'custom_roles.archive',
  'custom_roles.assign',
  'ownership_transfer.read',
  'ownership_transfer.create',
  'ownership_transfer.confirm',
  'ownership_transfer.revoke',
  'ownership_transfer.decline',
  'team_bookings.preview_bulk_cancellation',
  'team_bookings.confirm_bulk_cancellation',
  'team_bookings.read_bulk_cancellation',
  'team_bookings.preview_handoff',
  'team_bookings.create_handoff_proposal',
  'team_bookings.read_handoff_proposal',
  'team_bookings.withdraw_handoff_proposal',
  'team_bookings.resend_handoff_proposal',
  'team_bookings.apply_handoff',
])

// These entry points have team-role checks. Mutations can perform multiple
// operations depending on the request; each must retain its own classification.
const teamRest = new Map<string, readonly string[]>([
  ['POST /api/v1/meeting-polls', ['polls.create']],
  ['POST /api/v1/meeting-polls/{id}/invitations', ['polls.invite']],
  ['POST /api/v1/meeting-polls/{id}/invitations/{voterId}/resend', ['polls.resend']],
  ['DELETE /api/v1/meeting-polls/{id}/voters/{voterId}', ['polls.remove_voter']],
  ['POST /api/v1/meeting-polls/{id}/remove-unverified', ['polls.remove_unverified']],
  ['POST /api/v1/meeting-polls/{id}/rotate-link', ['polls.rotate_link']],
  ['GET /api/v1/meeting-polls', ['polls.read']],
  ['GET /api/v1/meeting-polls/{id}', ['polls.read']],
  ['GET /api/v1/meeting-polls/{id}/results', ['polls.read_results']],
  ['POST /api/v1/meeting-polls/{id}/close', ['polls.close']],
  ['POST /api/v1/meeting-polls/{id}/cancel', ['polls.cancel']],
  ['DELETE /api/v1/meeting-polls/{id}', ['polls.delete']],
  ['POST /api/v1/meeting-polls/{id}/finalize', ['polls.finalize']],
  ['GET /api/v1/analytics/bookings', ['analytics.read']],
  ['GET /api/v1/routing-forms', ['routing_forms.read']],
  ['GET /api/v1/routing-forms/{id}', ['routing_forms.read']],
  ['POST /api/v1/routing-forms', ['routing_forms.create']],
  ['PATCH /api/v1/routing-forms/{id}', ['routing_forms.update']],
  ['DELETE /api/v1/routing-forms/{id}', ['routing_forms.archive']],
  ['POST /api/v1/routing-forms/{id}/publish', ['routing_forms.publish']],
  ['POST /api/v1/routing-forms/{id}/preview', ['routing_forms.preview']],
  ['GET /api/v1/organizations/{organizationId}/provisioning-tokens', ['scim.read_tokens']],
  ['POST /api/v1/organizations/{organizationId}/provisioning-tokens', ['scim.create_token']],
  [
    'POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate',
    ['scim.rotate_token'],
  ],
  ['DELETE /api/v1/organizations/{organizationId}/provisioning-tokens/{id}', ['scim.revoke_token']],
  ['GET /api/v1/teams/{teamId}/permissions', ['permissions.read_self']],
  ['GET /api/v1/teams/{teamId}/roles', ['custom_roles.read']],
  ['GET /api/v1/teams/{teamId}/roles/{roleId}', ['custom_roles.read']],
  ['POST /api/v1/teams/{teamId}/roles', ['custom_roles.create']],
  ['PATCH /api/v1/teams/{teamId}/roles/{roleId}', ['custom_roles.revise']],
  ['DELETE /api/v1/teams/{teamId}/roles/{roleId}', ['custom_roles.archive']],
  ['PUT /api/v1/teams/{teamId}/members/{memberId}/custom-role', ['custom_roles.assign']],
  ['GET /api/v1/audit-events', ['audit.read']],
  ['GET /api/v1/audit-log/settings', ['audit.read_retention']],
  ['PUT /api/v1/audit-log/settings', ['audit.update_retention']],
  ['GET /api/v1/branding', ['branding.read']],
  ['GET /api/v1/branding/logo/{hash}', ['branding.read']],
  ['PATCH /api/v1/branding', ['branding.update']],
  ['POST /api/v1/branding/logo', ['branding.upload_logo']],
  ['GET /api/v1/bookings/{id}/attendees', ['attendance.read']],
  ['GET /api/v1/bookings/{id}/organization', ['team_bookings.read']],
  ['GET /api/v1/group-occurrences/{id}/attendees', ['group_occurrences.read_attendees']],
  ['POST /api/v1/group-occurrences/{id}/cancel', ['group_occurrences.cancel']],
  ['GET /api/v1/bookings/export.csv', ['team_bookings.export']],
  [
    'PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show',
    ['attendance.mark_no_show', 'attendance.unmark_no_show'],
  ],
  ['GET /api/v1/event-type-hosts', ['event_types.list_host_candidates']],
  ['GET /api/v1/event-types', ['event_types.read']],
  [
    'POST /api/v1/event-types',
    [
      'event_types.create',
      'event_notifications.update',
      'event_types.assign_hosts',
      'event_types.update_success_redirect',
      'waitlists.update_settings',
    ],
  ],
  ['GET /api/v1/event-types/{id}', ['event_types.read']],
  ['DELETE /api/v1/event-types/{id}', ['event_types.delete']],
  [
    'PATCH /api/v1/event-types/{id}',
    [
      'event_types.update',
      'event_notifications.update',
      'event_types.assign_hosts',
      'event_types.update_success_redirect',
      'waitlists.update_settings',
    ],
  ],
  ['PUT /api/v1/event-types/{id}/notifications', ['event_notifications.update']],
  ['GET /api/v1/event-types/{id}/waitlist', ['waitlists.read_settings']],
  ['PUT /api/v1/event-types/{id}/waitlist', ['waitlists.update_settings']],
  ['GET /api/v1/event-types/{id}/waitlist/entries', ['waitlists.list_entries']],
  ['DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}', ['waitlists.remove_entry']],
  ['POST /api/v1/open-time-snippets', ['event_types.generate_open_time_snippet']],
  [
    'GET /api/v1/event-types/{id}/availability-troubleshooting',
    ['event_types.diagnose_availability'],
  ],
  ['GET /api/v1/event-types/{eventTypeId}/one-time-links', ['one_time_links.read']],
  ['POST /api/v1/event-types/{eventTypeId}/one-time-links', ['one_time_links.create']],
  ['GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}', ['one_time_links.read']],
  ['DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}', ['one_time_links.revoke']],
  [
    'POST /api/v1/event-types/{id}/duplicate',
    [
      'event_types.duplicate',
      'event_notifications.update',
      'event_types.assign_hosts',
      'event_types.update_success_redirect',
      'waitlists.update_settings',
    ],
  ],
  ['POST /api/v1/event-types/{id}/round-robin/activate', ['event_types.activate_round_robin']],
  ['GET /api/v1/mcp-oauth/connections', ['credentials.manage_own_oauth_grant']],
  ['DELETE /api/v1/mcp-oauth/connections/{id}', ['credentials.manage_own_oauth_grant']],
  ['POST /api/v1/mcp-oauth/consent', ['credentials.manage_own_oauth_grant']],
  ['POST /api/v1/mcp-oauth/request', ['credentials.manage_own_oauth_grant']],
  ['POST /api/v1/mcp-oauth/select', ['credentials.manage_own_oauth_grant']],
  ['GET /api/v1/readiness/self', ['readiness.read_self']],
  ['GET /api/v1/team/bookings', ['team_bookings.read']],
  ['GET /api/v1/team/bookings/{id}', ['team_bookings.read']],
  ['POST /api/v1/team/bookings/{id}/cancel', ['team_bookings.cancel']],
  ['GET /api/v1/team/bookings/{id}/handoff-preview', ['team_bookings.preview_handoff']],
  ['POST /api/v1/team/bookings/{id}/handoff-offers', ['team_bookings.create_handoff_proposal']],
  [
    'GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}',
    ['team_bookings.read_handoff_proposal'],
  ],
  [
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw',
    ['team_bookings.withdraw_handoff_proposal'],
  ],
  [
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend',
    ['team_bookings.resend_handoff_proposal'],
  ],
  [
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply',
    ['team_bookings.apply_handoff'],
  ],
  [
    'POST /api/v1/team/bookings/bulk-cancellations/preview',
    ['team_bookings.preview_bulk_cancellation'],
  ],
  [
    'POST /api/v1/team/bookings/bulk-cancellations/{id}/confirm',
    ['team_bookings.confirm_bulk_cancellation'],
  ],
  ['GET /api/v1/team/bookings/bulk-cancellations/{id}', ['team_bookings.read_bulk_cancellation']],
  ['GET /api/v1/team/invitations', ['invitations.read']],
  ['GET /api/v1/team/invitations/{invitationId}', ['invitations.read']],
  ['POST /api/v1/team/invitations/{invitationId}/cancel', ['invitations.cancel']],
  ['GET /api/v1/team/member-removals/{operationId}', ['members.read_departure']],
  ['GET /api/v1/team/members/{memberUserId}/departure-impact', ['members.read_departure']],
  ['POST /api/v1/team/members/{memberUserId}/removal', ['members.remove']],
  ['GET /api/v1/team/members/{memberUserId}/removal-handling', ['members.read_removal_handling']],
  ['POST /api/v1/teams/{teamId}/leave', ['members.leave_self']],
  ['GET /api/v1/teams/{teamId}/ownership-transfer', ['ownership_transfer.read']],
  ['POST /api/v1/teams/{teamId}/ownership-transfer', ['ownership_transfer.create']],
  [
    'POST /api/v1/teams/{teamId}/ownership-transfer/{transferId}/confirm',
    ['ownership_transfer.confirm'],
  ],
  [
    'POST /api/v1/teams/{teamId}/ownership-transfer/{transferId}/revoke',
    ['ownership_transfer.revoke'],
  ],
  [
    'POST /api/v1/teams/{teamId}/ownership-transfer/{transferId}/decline',
    ['ownership_transfer.decline'],
  ],
  ['GET /api/v1/teams/{teamId}/member-readiness', ['readiness.read_team']],
  ['GET /api/v1/teams/{teamId}/readiness', ['readiness.read_team']],
  ['GET /api/v1/slack-destinations', ['slack_destinations.read']],
  ['POST /api/v1/slack-destinations', ['slack_destinations.create']],
  ['PATCH /api/v1/slack-destinations/{id}', ['slack_destinations.update']],
  ['DELETE /api/v1/slack-destinations/{id}', ['slack_destinations.delete']],
  ['POST /api/v1/slack-destinations/{id}/test', ['slack_destinations.test']],
  ['GET /api/v1/webhooks', ['webhooks.read']],
  ['POST /api/v1/webhooks', ['webhooks.create']],
  ['DELETE /api/v1/webhooks/{id}', ['webhooks.delete']],
  ['PATCH /api/v1/webhooks/{id}', ['webhooks.update']],
  ['GET /api/v1/webhooks/{id}/deliveries', ['webhooks.read_deliveries']],
  ['POST /api/v1/webhooks/{id}/rotate-secret', ['webhooks.rotate_secret']],
  ['DELETE /api/v1/workflows/{id}', ['workflows.delete']],
  ['PATCH /api/v1/workflows/{id}', ['workflows.update', 'workflows.enable', 'workflows.disable']],
  ['POST /api/v1/workflows', ['workflows.create']],
  ['POST /api/v1/workflows/preview', ['workflows.preview']],
  ['GET /api/v1/workflows', ['workflows.read']],
  ['GET /api/v1/workflows/{id}', ['workflows.read']],
  ['GET /api/v1/workflows/{id}/runs', ['workflows.read_runs']],
  ['POST /api/v1/team/sso/domains', ['sso.challenge_domain']],
  ['POST /api/v1/team/sso/domains/{domainId}/verify', ['sso.verify_domain']],
  ['DELETE /api/v1/team/sso/domains/{domainId}', ['sso.retire_domain']],
  ['POST /api/v1/team/sso/providers', ['sso.create_provider']],
  ['PATCH /api/v1/team/sso/providers/{providerId}', ['sso.update_provider']],
  ['DELETE /api/v1/team/sso/providers/{providerId}', ['sso.retire_provider']],
  ['POST /api/v1/team/sso/providers/{providerId}/test', ['sso.test_provider']],
  [
    'POST /api/v1/team/sso/providers/{providerId}/activation',
    ['sso.activate_provider', 'sso.deactivate_provider'],
  ],
  ['POST /api/v1/team/sso/providers/{providerId}/link', ['sso.link_self']],
  ['DELETE /api/v1/team/sso/providers/{providerId}/link', ['sso.unlink_self']],
  ['DELETE /api/v1/team/sso/providers/{providerId}/links/{linkId}', ['sso.retire_member_link']],
  ['POST /api/v1/team/sso/delegations', ['sso.bind_credential_self']],
  ['DELETE /api/v1/team/sso/delegations/{bindingId}', ['sso.revoke_binding_self']],
  ['POST /api/v1/team/sso/recovery', ['sso.nominate_recovery']],
  ['POST /api/v1/team/sso/recovery/{enrollmentId}/accept', ['sso.accept_recovery']],
  ['POST /api/v1/team/sso/recovery/use', ['sso.use_recovery']],
  ['GET /api/v1/team/sso/providers', ['sso.read_providers', 'sso.read_links']],
  ['GET /api/v1/team/sso/policy', ['sso.read_policy']],
  ['PUT /api/v1/team/sso/policy', ['sso.set_admission', 'sso.set_enforcement']],
  ['GET /api/v1/scim/team-mappings', ['scim.read_mappings']],
  ['POST /api/v1/scim/team-mappings', ['scim.link_team']],
  ['DELETE /api/v1/scim/team-mappings/{id}', ['scim.unlink_team']],
  ['POST /api/v1/scim/team-mappings/consent', ['scim.approve_mapping']],
])

// A private endpoint may use an organization selector for isolation and still
// authorize exclusively by relationship to the account or hosted booking.
const independentRest: ReadonlySet<string> = new Set([
  'GET /api/v1/bookings',
  'GET /api/v1/bookings/{id}',
  'POST /api/v1/bookings/{id}/calendar-copy/retry',
  'POST /api/v1/bookings/{id}/cancel',
  'POST /api/v1/bookings/{id}/conference/retry',
  'POST /api/v1/bookings/{id}/reschedule',
  'POST /api/v1/bookings/{id}/request-reschedule',
  'GET /api/v1/bookings/{id}/slots',
  'GET /api/v1/calendar-connections',
  'DELETE /api/v1/calendar-connections/{id}',
  'POST /api/v1/calendar-connections/{id}/refresh',
  'POST /api/v1/calendar-connections/caldav/discover',
  'POST /api/v1/calendar-connections/caldav',
  'POST /api/v1/calendar-connections/google/authorize',
  'POST /api/v1/calendar-connections/microsoft/authorize',
  'PUT /api/v1/calendar-destination',
  'PATCH /api/v1/calendars/{id}',
  'POST /api/v1/calendars/{id}/sync',
  'GET /api/v1/conference-connections',
  'DELETE /api/v1/conference-connections/{id}',
  'POST /api/v1/conference-connections/{id}/authorize-meetings',
  'POST /api/v1/conference-connections/{id}/reconnect',
  'POST /api/v1/conference-connections/{id}/refresh',
  'POST /api/v1/conference-connections/zoom/authorize',
  'POST /api/v1/conference-connections/zoom/authorize-meetings',
  'GET /api/v1/instance/embed',
  'GET /api/v1/me',
  'GET /api/v1/profile',
  'PUT /api/v1/profile',
  'PATCH /api/v1/profile/name',
  'GET /api/v1/schedules',
  'POST /api/v1/schedules',
  'GET /api/v1/schedules/{id}',
  'GET /api/v1/schedules/{id}/availability',
  'PUT /api/v1/schedules/{id}/availability',
  'DELETE /api/v1/schedules/{id}',
  'PATCH /api/v1/schedules/{id}',
  'GET /api/v1/schedules/{id}/overrides',
  'PUT /api/v1/schedules/{id}/overrides/{date}',
  'DELETE /api/v1/schedules/{id}/overrides/{date}',
  'POST /api/v1/schedules/default',
])

const nativeTeam = new Map<string, readonly string[]>([
  ['organization/create', ['team.create']],
  ['organization/set-active', ['team.switch']],
  ['organization/update', ['team.update']],
  ['organization/has-permission', ['team.read_native_permission']],
  [
    'organization/get-full-organization',
    ['members.read', 'members.read_private', 'invitations.read'],
  ],
  ['organization/list-members', ['members.read', 'members.read_private']],
  ['organization/list-invitations', ['invitations.read']],
  [
    'organization/invite-member',
    ['invitations.create', 'invitations.resend', 'invitations.replace'],
  ],
  ['organization/cancel-invitation', ['invitations.cancel']],
  ['organization/accept-invitation', ['invitations.respond_self']],
  ['organization/reject-invitation', ['invitations.respond_self']],
  ['organization/update-member-role', ['members.assign_role']],
  ['organization/remove-member', ['members.remove', 'members.leave_self']],
  ['organization/leave', ['members.leave_self']],
  ['organization/add-member', ['members.add_trusted']],
  ['api-key/create', ['credentials.manage_own_key']],
  ['api-key/list', ['credentials.manage_own_key']],
  ['api-key/update', ['credentials.manage_own_key']],
  ['api-key/delete', ['credentials.manage_own_key']],
])

const rest = new Map(
  [...API_KEY_REST_OPERATIONS, ...SCIM_MAPPING_SCOPE_OPERATIONS.rest].map((row) => [row.id, row]),
)

function hasClassification(id: string) {
  const route = rest.get(id)
  return (
    route?.authentication === 'public_metadata' ||
    route?.authentication === 'optional_key' ||
    teamRest.has(id) ||
    independentRest.has(id)
  )
}

describe('team operation catalogue coverage', () => {
  it('classifies each authenticated REST and session-only entry point', () => {
    expect([...rest.keys()].filter((id) => !hasClassification(id))).toEqual([])
    expect([...teamRest.keys(), ...independentRest].filter((id) => !rest.has(id))).toEqual([])
    expect([...teamRest.keys()].filter((id) => independentRest.has(id))).toEqual([])
  })

  it('maps MCP tools and modes to the same classified service entry points', () => {
    const tools = [...API_KEY_MCP_OPERATIONS, ...SCIM_MAPPING_SCOPE_OPERATIONS.mcp]
    expect(tools.filter((tool) => tool.rest.length === 0).map((tool) => tool.id)).toEqual([])
    expect(
      tools.flatMap((tool) =>
        tool.rest.filter((route) => !rest.has(route) || !hasClassification(route)),
      ),
    ).toEqual([])
  })

  it('maps team gates to explicit Custom or Fixed actions, including native browser and trusted calls', () => {
    const routes = [...teamRest, ...nativeTeam]
    expect(routes.filter(([, actions]) => actions.length === 0)).toEqual([])
    expect(
      routes.flatMap(([route, actions]) =>
        actions
          .filter((action) => !catalogue.has(action) && !fixedOutsideV1.has(action))
          .map((action) => ({ route, action })),
      ),
    ).toEqual([])
    expect([...fixedOutsideV1].filter((action) => catalogue.has(action))).toEqual([])
  })

  it('keeps role management and permission discovery session-only without MCP or CLI aliases', () => {
    const roleRoutes = new Set(
      [...teamRest]
        .filter(([, actions]) =>
          actions.some((id) => id.startsWith('custom_roles.') || id === 'permissions.read_self'),
        )
        .map(([route]) => route),
    )
    expect(roleRoutes.size).toBe(7)
    for (const id of roleRoutes) {
      expect(rest.get(id)).toMatchObject({
        authentication: 'session_only',
        allowedScopes: [],
      })
    }
    const tools = [...API_KEY_MCP_OPERATIONS, ...SCIM_MAPPING_SCOPE_OPERATIONS.mcp]
    const cli = [...API_KEY_CLI_OPERATIONS, ...SCIM_MAPPING_SCOPE_OPERATIONS.cli]
    expect(tools.filter(({ rest }) => rest.some((route) => roleRoutes.has(route)))).toEqual([])
    expect(
      cli.filter(({ tool }) =>
        tools
          .find((row) => row.tool === tool && row.mode === undefined)
          ?.rest.some((route) => roleRoutes.has(route)),
      ),
    ).toEqual([])
  })
})
