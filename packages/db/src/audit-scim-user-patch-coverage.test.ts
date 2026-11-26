import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { detailsCheckBranches } from './audit-details-check-source.ts'
import { runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0125_scim_user_patch_audit.sql'
const constraint = 'audit_events_details_check'
const refused = { code: '23514', constraint }
const validDetails = { operations: ['remove', 'add', 'replace', 'replace'] }

const insert = (pool: pg.Pool, details: unknown, action = 'scim_user.updated') =>
  pool.query<{ details: unknown }>(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('scim_token', $1, 'none', $2, 'scim_user', $3, $4::jsonb) RETURNING details`,
    [randomUUID(), action, randomUUID(), JSON.stringify(details)],
  )

async function assertPatchAuditProtections(pool: pg.Pool) {
  const accepted = [{}, validDetails, { operations: Array.from({ length: 100 }, () => 'add') }]
  for (const details of accepted)
    await expect(insert(pool, details)).resolves.toMatchObject({ rows: [{ details }] })

  for (const details of [
    null,
    [validDetails],
    { ...validDetails, attribute: 'synthetic-private-value' },
    { operations: null },
    { operations: 'replace' },
    { operations: { op: 'replace' } },
    { operations: [] },
    { operations: ['Replace'] },
    { operations: ['replace', 'synthetic-private-value'] },
    { operations: [null] },
    { operations: [false] },
    { operations: [{ op: 'replace' }] },
    { operations: [['add']] },
    { operations: Array.from({ length: 101 }, () => 'add') },
  ])
    await expect(insert(pool, details), JSON.stringify(details)).rejects.toMatchObject(refused)
  await expect(insert(pool, validDetails, 'scim_user.created')).rejects.toMatchObject(refused)
}

async function seedJournal(pool: pg.Pool) {
  const organization = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
     VALUES ($1, 'SCIM Directory Fixture', $2, now())`,
    [organization, `fixture-${organization}`],
  )
  const token = randomUUID()
  await pool.query(
    `INSERT INTO scim_provisioning_tokens (id, organization_id, name, token_hash)
     VALUES ($1, $2, 'Directory Fixture', $3)`,
    [token, organization, 'a'.repeat(43)],
  )
  const user = randomUUID()
  await pool.query(
    `INSERT INTO scim_users (id, organization_id, connection_id, user_name, external_id, work_email)
     SELECT $1, organization_id, connection_id, 'managed@directory.example', 'directory-42',
       'managed@directory.example' FROM scim_token_connections WHERE token_id = $2`,
    [user, token],
  )
  await pool.query(
    `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type, action,
       target_type, target_id, details)
     VALUES
       ($1, 'scim_token', $2, 'none', 'scim_user.created', 'scim_user', $3, '{}'),
       ($1, 'scim_token', $2, 'none', 'scim_user.updated', 'scim_user', $3, '{}'),
       ($1, 'user', $4, 'none', 'organization.branding_updated', 'organization', $5,
         '{"logo":"selected","primaryColor":"set"}')`,
    [organization, token, user, randomUUID(), organization],
  )
  return organization
}

const journal = (pool: pg.Pool, scope: string) =>
  pool.query(
    `SELECT to_jsonb(audit_events) AS event, xmin::text, ctid::text FROM audit_events
     WHERE organization_id = $1 ORDER BY id`,
    [scope],
  )

it('preserves all predecessor audit details branches', () => {
  const previous = detailsCheckBranches('0085_sso_audit_actions.sql')
  const current = detailsCheckBranches(migration)
  const isPatchBranch = ({ when }: { when: string }) =>
    when === "    WHEN action = 'scim_user.updated' THEN"
  expect(current.head).toBe(previous.head)
  expect(current.tail).toBe(previous.tail)
  expect(current.branches.filter(isPatchBranch)).toHaveLength(1)
  expect(current.branches.filter((branch) => !isPatchBranch(branch))).toEqual(previous.branches)
})

describe.skipIf(!serverUrl)('SCIM User PATCH audit details migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails an assertion when the audit details check is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertPatchAuditProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ key, status }) => [key, status])).toEqual([
        [`constraint public.audit_events.${constraint}`, 'covered'],
      ])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves the populated predecessor journal and reruns as a no-op after upgrade or fresh install',
    async () => {
      const { predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'scim_patch_up' })
        const pool = upgraded.pool
        const scope = await seedJournal(pool)
        const before = (await journal(pool, scope)).rows
        expect(before).toHaveLength(3)
        await expect(insert(pool, validDetails)).rejects.toMatchObject(refused)
        expect(await runMigrations(pool)).toContain(migration)
        expect((await journal(pool, scope)).rows).toEqual(before)
        expect(await runMigrations(pool)).toEqual([])
        expect((await journal(pool, scope)).rows).toEqual(before)
        await assertPatchAuditProtections(pool)

        fresh = await createTestDatabase(serverUrl as string, undefined, { tag: 'scim_patch_new' })
        expect(await runMigrations(fresh.pool)).toEqual([])
        await assertPatchAuditProtections(fresh.pool)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
