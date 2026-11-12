import { describe, expect, it } from 'vitest'
import { assertScimIdentityProtections } from './scim-identity-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

const targetKey = (references: string) =>
  `FK target of ${references}; the primary key already makes it unique, and it cannot be dropped while that FK exists`

/** Objects that are not protections on their own; every other object must fail an assertion. */
const allowList: Record<string, string> = {
  'constraint auth.invitation.scim_invitation_scope': targetKey('scim_claims_invitation_scope'),
  'constraint auth.member.scim_member_scope': targetKey('scim_users_member_scope'),
  'constraint public.scim_connections.scim_connections_scope': targetKey(
    'scim_token_connections_connection_scope and scim_users_connection_scope',
  ),
  'constraint public.scim_provisioning_tokens.scim_tokens_scope': targetKey(
    'scim_token_connections_token_scope',
  ),
  'constraint public.scim_users.scim_users_scope': targetKey(
    'scim_users_manager_scope, scim_claims_user_scope and scim_blocks_user_scope',
  ),
}

describe.skipIf(!serverUrl)('SCIM identity constraint coverage', () => {
  it('fails a protection assertion when any object created by 0073 is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0073_scim_identity.sql',
      assertions: assertScimIdentityProtections,
      allowList,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
      report.objects.length - Object.keys(allowList).length,
    )
  }, 600_000)
})
