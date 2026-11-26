import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import { assertScimIdentityProtections } from './scim-identity-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { MIGRATION_COVERAGE_TIMEOUT } from './testing/migration-replay.ts'

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
  it(
    'fails a protection assertion when any object created by 0073 is dropped',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-coverage-'))
      try {
        // Drop 0073's User primary key without its later Group source foreign key.
        // The release schema tests that foreign key in the Group migration's coverage suite.
        // The roster source index of 0184 needs the column that 0183 adds.
        const later = ['0183_scim_groups.sql', '0184_scim_group_members.sql']
        for (const file of await readdir(migrationsDir)) {
          if (file.endsWith('.sql') && !later.includes(file)) {
            await copyFile(join(migrationsDir, file), join(directory, file))
          }
        }
        const report = await checkConstraintCoverage({
          serverUrl: serverUrl as string,
          migration: '0073_scim_identity.sql',
          migrationsDirectory: directory,
          assertions: assertScimIdentityProtections,
          allowList,
        })
        expect(report.problems).toEqual([])
        expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(
          report.objects.length - Object.keys(allowList).length,
        )
      } finally {
        await rm(directory, { recursive: true })
      }
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
