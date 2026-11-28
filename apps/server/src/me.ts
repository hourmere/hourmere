import { z } from '@hono/zod-openapi'
import { type Principal, resolveTeamPermissions, type TeamPermissionCheck } from '@hourmere/auth'
import type { customRoleCatalogueV1 } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { managedTeamPermissionChecks } from '@hourmere/scheduling'
import { renewalFacts } from './custom-role-mode.ts'
import { MeSso } from './sso-me.ts'

/** The base identity shared by GET /api/v1/me and the MCP `whoami` tool. */
export const CallerDescription = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  personalOrganizationId: z.uuid().nullable().openapi({
    description:
      "The caller's own personal organization, independent of the active organization; null when unavailable",
  }),
  organization: z
    .object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      personal: z.boolean().openapi({
        description: 'A personal organization (every user has one) rather than a team',
      }),
    })
    .openapi({ description: 'The organization the caller acts in' }),
  principal: z.object({
    kind: z.enum(['session', 'api_key', 'oauth']),
    oauthConsentId: z
      .uuid()
      .optional()
      .openapi({ description: 'The organization-bound consent used, for kind oauth' }),
    apiKeyId: z.uuid().nullable().openapi({ description: 'The key used, for kind api_key' }),
    apiKeyScope: z.enum(['full', 'read', 'bookings']).optional().openapi({
      description: 'The immutable API key scope, included only for kind api_key',
    }),
  }),
})

export const Me = CallerDescription.extend({
  teamManagementPermissions: z.array(z.string()).optional().openapi({
    description:
      'Allowed team-wide operation IDs for event types, routing forms and workflows for the active browser session with versioned team authority. Each operation independently enforces current feature, target and field checks.',
  }),
  teamPermissionRenewalRequired: z.literal(true).optional().openapi({
    description: 'This browser session needs explicit team permission renewal.',
  }),
  sso: MeSso.optional(),
  ssoRecoveryTeams: z
    .array(z.object({ id: z.uuid(), displayName: z.string(), policyRevision: z.int().positive() }))
    .optional()
    .openapi({
      description:
        'Teams requiring SSO for which this browser caller is an accepted, current recovery owner. Each revision is the expectedRevision for useSsoRecovery.',
    }),
}).openapi('Me', {
  description:
    'The enrollment view for a session without the required team proof keeps the active organization ID and omits its metadata by returning empty name and slug strings.',
})

type CatalogueOperation = (typeof customRoleCatalogueV1)[
  | 'fixed'
  | 'phaseOne'
  | 'phaseTwoPersonalData'][number]

const managementOperations = [
  'branding.read',
  'event_notifications.update',
  'event_types.activate_round_robin',
  'event_types.assign_hosts',
  'event_types.create',
  'event_types.delete',
  'event_types.diagnose_availability',
  'event_types.duplicate',
  'event_types.generate_open_time_snippet',
  'event_types.list_host_candidates',
  'event_types.update',
  'event_types.update_success_redirect',
  'one_time_links.create',
  'one_time_links.read',
  'one_time_links.revoke',
  'readiness.read_team',
  'routing_forms.archive',
  'routing_forms.create',
  'routing_forms.preview',
  'routing_forms.publish',
  'routing_forms.read',
  'routing_forms.update',
  'waitlists.list_entries',
  'waitlists.read_settings',
  'waitlists.remove_entry',
  'waitlists.update_settings',
  'webhooks.read',
  'workflows.create',
  'workflows.delete',
  'workflows.disable',
  'workflows.enable',
  'workflows.preview',
  'workflows.read',
  'workflows.read_runs',
  'workflows.update',
] as const satisfies readonly CatalogueOperation[]

const memberReadOperations = [
  'event_types.read',
  'event_notifications.read',
] as const satisfies readonly CatalogueOperation[]

export async function describeTeamManagementPermissions(
  db: Db,
  principal: Principal,
  ssoAccessAllowed: boolean,
) {
  const authorization = principal.customRoleAuthorization
  if (principal.kind !== 'session' || principal.organization.personal || !authorization) return
  const teamId = principal.organization.id
  const checks = managedTeamPermissionChecks(principal, managementOperations, true).map(
    (check): TeamPermissionCheck => ({
      ...check,
      fixed: (membership) => (membership.emailVerified ? check.fixed(membership) : 'denied'),
    }),
  )
  const result = await resolveTeamPermissions(
    db,
    principal,
    teamId,
    ssoAccessAllowed
      ? [
          ...memberReadOperations.map((operation) => ({ operation, fixed: () => 'base' as const })),
          ...checks,
        ]
      : [],
    authorization,
  )
  // An invalidated session or active-space switch must never restore fixed-role controls.
  if (!result) return { teamManagementPermissions: [] }
  if ((result.membershipGeneration ?? 1) <= 1) return
  if (!ssoAccessAllowed) return { teamManagementPermissions: [] }
  const renewal = authorization.available && (await renewalFacts(db, principal, teamId, true))
  return {
    teamManagementPermissions: result.decisions.filter((d) => d.allowed).map((d) => d.operation),
    ...(renewal && !renewal.current && { teamPermissionRenewalRequired: true as const }),
  }
}

export function describeCaller(p: Principal): z.infer<typeof CallerDescription> {
  return {
    user: p.user,
    personalOrganizationId: p.personalOrganizationId ?? null,
    organization: p.organization,
    principal: {
      kind: p.kind,
      apiKeyId: p.kind === 'api_key' ? p.apiKeyId : null,
      ...(p.kind === 'api_key' && { apiKeyScope: p.apiKeyScope }),
      ...(p.kind === 'oauth' && { oauthConsentId: p.oauthConsentId }),
    },
  }
}
