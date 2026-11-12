import { describe, expect, it } from 'vitest'
import { assertSsoAuditDetailProtections } from './sso-audit-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('SSO audit actions constraint coverage', () => {
  it('fails a protection assertion when any object created by 0085 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0085_sso_audit_actions.sql',
      assertions: assertSsoAuditDetailProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key)).toEqual([
      'constraint public.audit_events.audit_events_details_check',
    ])
    expect(report.results.map((result) => result.status)).toEqual(['covered'])
  }, 600_000)
})
