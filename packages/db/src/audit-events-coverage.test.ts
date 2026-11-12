import { describe, expect, it } from 'vitest'
import { assertAuditEventProtections } from './audit-events-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.audit_events.audit_events_credential_type_check':
    'Implied by audit_credential_shape, whose branches admit only the session, api_key, oauth and none credential types',
}

describe.skipIf(!serverUrl)('audit journal constraint coverage', () => {
  it('fails a protection assertion when any object created by 0067 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0067_audit_events.sql',
      assertions: assertAuditEventProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
