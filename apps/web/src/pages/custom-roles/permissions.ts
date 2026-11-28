import type { customRoleCatalogueV1 } from '@hourmere/core/custom-role-catalogue'
import type { ApiKeyScope } from '../../api/auth.ts'
import type { MessageKey } from '../../i18n/translate.ts'

type PhaseOne = (typeof customRoleCatalogueV1.phaseOne)[number]

export const permissionLabels = {
  'analytics.read': 'View aggregate booking activity',
  'branding.read': 'View team branding',
  'branding.update': 'Edit team branding',
  'branding.upload_logo': 'Upload the team logo',
  'event_notifications.update': 'Edit event notifications',
  'event_types.activate_round_robin': 'Activate round-robin events',
  'event_types.assign_hosts': 'Assign hosts',
  'event_types.create': 'Create event types',
  'event_types.delete': 'Delete event types',
  'event_types.duplicate': 'Duplicate event types',
  'event_types.list_host_candidates': 'View eligible hosts and their readiness',
  'event_types.update': 'Edit event types',
  'readiness.read_team': 'View team setup readiness',
  'routing_forms.preview': 'Preview routing with sample data',
  'routing_forms.read': 'View routing forms',
  'workflows.preview': 'Preview workflows with sample data',
  'workflows.read': 'View workflow definitions',
  'workflows.read_runs': 'View workflow run metadata',
} satisfies Record<PhaseOne, MessageKey>

export const permissionAreas: ReadonlyArray<{
  label: MessageKey
  permissions: readonly PhaseOne[]
  read: readonly PhaseOne[]
}> = [
  {
    label: 'Event types',
    permissions: [
      'event_types.list_host_candidates',
      'event_types.create',
      'event_types.duplicate',
      'event_types.update',
      'event_types.assign_hosts',
      'event_types.activate_round_robin',
      'event_types.delete',
      'event_notifications.update',
    ],
    read: ['event_types.list_host_candidates'],
  },
  {
    label: 'Team setup readiness',
    permissions: ['readiness.read_team'],
    read: ['readiness.read_team'],
  },
  {
    label: 'Branding',
    permissions: ['branding.read', 'branding.update', 'branding.upload_logo'],
    read: ['branding.read'],
  },
  {
    label: 'Booking activity',
    permissions: ['analytics.read'],
    read: ['analytics.read'],
  },
  {
    label: 'Routing forms',
    permissions: ['routing_forms.read', 'routing_forms.preview'],
    read: ['routing_forms.read'],
  },
  {
    label: 'Workflows',
    permissions: ['workflows.read', 'workflows.read_runs', 'workflows.preview'],
    read: ['workflows.read', 'workflows.read_runs'],
  },
]

export function phaseOnePermissions(ids: readonly string[]): PhaseOne[] {
  return ids.filter((id): id is PhaseOne => Object.hasOwn(permissionLabels, id))
}

// These sets mirror the API key scope registry. Readiness and the host picker
// use browser sessions, while the remaining phase-one actions have REST paths.
const keyReadPermissions: ReadonlySet<PhaseOne> = new Set([
  'analytics.read',
  'branding.read',
  'routing_forms.read',
  'workflows.read',
  'workflows.read_runs',
])

export function keyPermissions(ids: readonly string[], scope: ApiKeyScope) {
  return phaseOnePermissions(ids).filter((id) =>
    scope === 'full'
      ? id !== 'readiness.read_team' && id !== 'event_types.list_host_candidates'
      : scope === 'read' && keyReadPermissions.has(id),
  )
}

export function fixedRoleLabel(role?: string): MessageKey | undefined {
  if (role === 'owner') return 'Owner'
  if (role === 'admin') return 'Admin'
  if (role === 'member') return 'Member'
}
