import { describe, expect, it } from 'vitest'
import { assertSsoProtections } from './sso-storage-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

const targetKey =
  'FK target of sso_provider_domains; the primary key already makes it unique, and it cannot be dropped while that FK exists'

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.sso_providers.sso_providers_organization_id_id': targetKey,
  'constraint public.sso_domains.sso_domains_organization_id_id': targetKey,
}

describe.skipIf(!serverUrl)('SSO configuration storage constraint coverage', () => {
  it('fails a protection assertion when any object created by 0074 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0074_sso_configuration.sql',
      assertions: assertSsoProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
