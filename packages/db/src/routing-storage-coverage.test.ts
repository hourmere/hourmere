import { describe, expect, it } from 'vitest'
import { assertRoutingFormProtections } from './routing-storage-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

const targetKey = (references: string) =>
  `FK target of ${references}; it cannot be dropped while that FK exists`
const impliedOrganization = (via: string) =>
  `Redundant with ${via}, which pins the same organization and cascades from it; no write or deletion behaves differently without it`

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.routing_forms.routing_forms_organization_id_id_key': targetKey(
    'routing_form_versions_organization_id_form_id_fkey',
  ),
  'constraint public.routing_form_versions.routing_form_versions_organization_id_id_key': targetKey(
    'routing_target_dependencies_organization_id_version_id_fkey',
  ),
  'constraint public.routing_form_versions.routing_form_versions_organization_id_form_id_id_key':
    targetKey(
      'routing_forms_published_version_fk and routing_receipts_organization_id_form_id_version_id_fkey',
    ),
  'constraint public.routing_form_versions.routing_form_versions_organization_id_fkey':
    impliedOrganization(
      'routing_form_versions_organization_id_form_id_fkey (forms cascade from their organization)',
    ),
  'constraint public.routing_target_dependencies.routing_target_dependencies_organization_id_fkey':
    impliedOrganization(
      'routing_target_dependencies_organization_id_version_id_fkey (versions cascade from their form)',
    ),
  'constraint public.booking_routing.booking_routing_organization_id_fkey': impliedOrganization(
    'booking_routing_booking_id_organization_id_fkey (bookings cascade from their organization)',
  ),
}

describe.skipIf(!serverUrl)('routing form constraint coverage', () => {
  it('fails a protection assertion when any object created by 0072 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0072_routing_forms.sql',
      assertions: assertRoutingFormProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
