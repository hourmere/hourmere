import { describe, expect, it } from 'vitest'
import { assertAuditLogRetentionProtections } from './audit-log-retention-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('audit log retention constraint coverage', () => {
  it('fails a protection assertion when any object created by 0090 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0090_audit_log_retention.sql',
      assertions: assertAuditLogRetentionProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.objects.map((object) => object.key).sort()).toEqual([
      'constraint public.audit_log_settings.audit_log_settings_organization_id_fkey',
      'constraint public.audit_log_settings.audit_log_settings_pkey',
      'constraint public.audit_log_settings.audit_log_settings_retention',
      'not_null public.audit_log_settings.retention',
      'not_null public.audit_log_settings.updated_at',
    ])
    expect(report.results.map((result) => result.status)).toEqual(Array(5).fill('covered'))
  }, 600_000)
})
