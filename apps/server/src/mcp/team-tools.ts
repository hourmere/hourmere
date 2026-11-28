import {
  customOperationTransportAllows,
  type Principal,
  resolveTeamPermissions,
  teamRoles,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'

// Each array describes one available form of the tool. Compound writes still check
// the actual effects and target in the service after taking the write locks. Tools
// with independent booking or event ownership branches are filtered by their services.
const toolOperations: Readonly<Record<string, readonly (readonly string[])[]>> = {
  archive_routing_form: [['routing_forms.archive']],
  cancel_meeting_poll: [['polls.cancel']],
  close_meeting_poll: [['polls.close']],
  create_event_type: [['event_types.create']],
  create_meeting_poll: [['polls.create']],
  create_routing_form: [['routing_forms.create']],
  create_scim_team_mapping: [['scim.link_team']],
  create_slack_destination: [['slack_destinations.create']],
  create_webhook: [['webhooks.create']],
  create_workflow: [['workflows.create']],
  delete_meeting_poll: [['polls.delete']],
  delete_scim_team_mapping: [['scim.unlink_team']],
  delete_slack_destination: [['slack_destinations.delete']],
  delete_webhook: [['webhooks.delete']],
  delete_workflow: [['workflows.delete']],
  duplicate_event_type: [
    ['event_types.duplicate', 'event_types.assign_hosts', 'event_notifications.update'],
  ],
  finalize_meeting_poll: [['polls.finalize']],
  generate_open_time_snippet: [['event_types.generate_open_time_snippet']],
  get_audit_log_settings: [['audit.read_retention']],
  get_booking_activity: [['analytics.read']],
  get_branding: [['branding.read']],
  get_event_type_waitlist: [['waitlists.read_settings']],
  get_meeting_poll: [['polls.read']],
  get_meeting_poll_results: [['polls.read_results']],
  get_routing_form: [['routing_forms.read']],
  get_sso_policy: [['sso.read_policy']],
  get_workflow: [['workflows.read']],
  invite_meeting_poll_voters: [['polls.invite']],
  list_audit_events: [['audit.read']],
  list_meeting_polls: [['polls.read']],
  list_routing_forms: [['routing_forms.read']],
  list_slack_destinations: [['slack_destinations.read']],
  list_sso_providers: [['sso.read_providers']],
  list_waitlist_entries: [['waitlists.list_entries']],
  list_webhook_deliveries: [['webhooks.read_deliveries']],
  list_webhooks: [['webhooks.read']],
  list_workflow_runs: [['workflows.read_runs']],
  list_workflows: [['workflows.read']],
  preview_routing_form: [['routing_forms.preview']],
  preview_workflow: [['workflows.preview']],
  publish_routing_form: [['routing_forms.publish']],
  remove_meeting_poll_voter: [['polls.remove_voter']],
  remove_unverified_meeting_poll_voters: [['polls.remove_unverified']],
  remove_waitlist_entry: [['waitlists.remove_entry']],
  resend_meeting_poll_invitation: [['polls.resend']],
  rotate_meeting_poll_link: [['polls.rotate_link']],
  rotate_webhook_secret: [['webhooks.rotate_secret']],
  set_audit_log_settings: [['audit.update_retention']],
  set_branding: [['branding.update']],
  set_event_type_notifications: [['event_notifications.update']],
  set_event_type_waitlist: [['waitlists.update_settings']],
  test_slack_destination: [['slack_destinations.test']],
  troubleshoot_availability: [['event_types.diagnose_availability']],
  update_event_type: [
    ['event_types.update'],
    ['event_types.assign_hosts'],
    ['event_notifications.update'],
    ['event_types.update_success_redirect'],
  ],
  update_routing_form: [['routing_forms.update']],
  update_slack_destination: [['slack_destinations.update']],
  update_webhook: [['webhooks.update']],
  update_workflow: [['workflows.update'], ['workflows.enable'], ['workflows.disable']],
}

const ownerOnly = new Set(['audit.update_retention', 'scim.link_team', 'scim.unlink_team'])

const operations = [...new Set(Object.values(toolOperations).flat(2))]

/** Omit unavailable operations for a credential with a custom-assignment boundary. */
export async function hiddenVersionedTools(
  db: Db,
  principal: Principal,
): Promise<Set<string> | undefined> {
  if (!principal.customRoleAuthorization || principal.organization.personal) return undefined
  const result = await resolveTeamPermissions(
    db,
    principal,
    principal.organization.id,
    operations.map((operation) => ({
      operation,
      fixed: ({ role }) =>
        teamRoles(role).some(
          (token) => token === 'owner' || (token === 'admin' && !ownerOnly.has(operation)),
        )
          ? 'elevated'
          : 'denied',
      versionedFixed: true,
      custom: customOperationTransportAllows(
        operation,
        principal.kind === 'api_key' ? principal.apiKeyScope : principal.kind,
      ),
    })),
    principal.customRoleAuthorization,
  )
  // Unaffected credentials keep their established discovery behavior.
  if (result && (result.membershipGeneration === null || result.membershipGeneration === 1))
    return undefined
  const hasDelegation = principal.kind === 'session' || principal.ssoDelegationStatus !== 'required'
  const allowed = new Set(
    hasDelegation
      ? result?.decisions
          .filter((decision) => decision.allowed)
          .map((decision) => decision.operation)
      : [],
  )
  return new Set(
    Object.entries(toolOperations)
      .filter(
        ([, branches]) =>
          !branches.some((branch) => branch.every((operation) => allowed.has(operation))),
      )
      .map(([tool]) => tool),
  )
}
