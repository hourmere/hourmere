import { describe, expect, it } from 'vitest'
import { assertIdentityProtections } from './sso-identity-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint public.sso_identity_links.sso_identity_links_owner':
    'FK target of the step-up, browser proof and delegation binding links; the primary key already makes it unique, and it cannot be dropped while those FKs exist',
  'constraint public.sso_attempts.sso_attempts_organization_id_id':
    'FK target of sso_mailbox_tokens; the primary key already makes it unique, and it cannot be dropped while that FK exists',
}

describe.skipIf(!serverUrl)('SSO identity storage constraint coverage', () => {
  it('fails a protection assertion when any object created by 0075 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0075_sso_identity.sql',
      assertions: assertIdentityProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
