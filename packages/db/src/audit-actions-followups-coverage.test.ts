import { describe, expect, it } from 'vitest'
import { assertAuditDetailProtections } from './audit-actions-followups-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('audit action follow-ups constraint coverage', () => {
  it('fails a protection assertion when any object created by 0078 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0078_audit_actions_followups.sql',
      assertions: assertAuditDetailProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key)).toEqual([
      'constraint public.audit_events.audit_events_details_check',
    ])
    expect(report.results.map((result) => result.status)).toEqual(['covered'])
  }, 600_000)
})
