import { describe, expect, it } from 'vitest'
import { assertAuditEventListProtections } from './audit-event-details-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('audit event details constraint coverage', () => {
  it('fails a protection assertion when any object created by 0080 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0080_audit_event_details.sql',
      assertions: assertAuditEventListProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key)).toEqual([
      'constraint public.audit_events.audit_events_details_check',
    ])
    expect(report.results.map((result) => result.status)).toEqual(['covered'])
  }, 600_000)
})
