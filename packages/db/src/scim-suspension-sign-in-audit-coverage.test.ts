import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { detailsCheckBranches, latestDetailsCheckMigration } from './audit-details-check-source.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0171_scim_suspension_sign_in_audit.sql'
const constraint = 'audit_events_details_check'
const refused = { code: '23514', constraint }
const authenticationFailure = 'sso_authentication.failed'
const jitRefusal = 'sso_jit.refused'
const suspension = 'scim_suspended'
const providerId = '019b0000-0000-7000-8000-000000000001'
const details = { method: 'oidc', providerId, revision: 1 }

it('extends only the SSO sign-in failure branch of the latest predecessor', () => {
  const source = latestDetailsCheckMigration(migration)
  const previous = detailsCheckBranches(source)
  const current = detailsCheckBranches(migration)
  const oldAction = `action IN ('${authenticationFailure}','${jitRefusal}')`
  const index = previous.branches.findIndex(({ when }) => when.includes(oldAction))
  expect(index, source).toBeGreaterThanOrEqual(0)
  const old = previous.branches[index]
  const updated = current.branches.slice(index, index + 2)
  const branchBody = (text: string | undefined) => text?.slice(text.indexOf('    WHEN '))

  expect(current.head).toBe(previous.head)
  expect(current.tail).toBe(previous.tail)
  expect(current.branches.slice(0, index)).toEqual(previous.branches.slice(0, index))
  expect(current.branches.slice(index + 2)).toEqual(previous.branches.slice(index + 1))
  expect(updated.map(({ text }) => branchBody(text))).toEqual([
    branchBody(old?.text)
      ?.replace(oldAction, `action = '${authenticationFailure}'`)
      .replace("'unclassified'), false)", `'unclassified','${suspension}'), false)`),
    branchBody(old?.text)?.replace(oldAction, `action = '${jitRefusal}'`),
  ])
})

function journalFixture(pool: pg.Pool, organizationId = randomUUID()) {
  return (action: string, value: Record<string, unknown>) =>
    pool.query<{ details: unknown }>(
      `INSERT INTO audit_events (organization_id, actor_type, credential_type, action,
         target_type, target_id, details)
       VALUES ($1, 'anonymous', 'none', $2, 'sso_provider', $3, $4::jsonb)
       RETURNING details`,
      [organizationId, action, providerId, JSON.stringify(value)],
    )
}

async function assertSuspensionDetails(pool: pg.Pool) {
  const insert = journalFixture(pool)
  const denied = { ...details, reason: suspension }
  await expect(insert(authenticationFailure, denied)).resolves.toEqual(
    expect.objectContaining({ rows: [{ details: denied }] }),
  )
  await expect(insert(jitRefusal, denied)).rejects.toMatchObject(refused)
  await expect(
    insert(authenticationFailure, { ...denied, email: 'private@example.test' }),
  ).rejects.toMatchObject(refused)
}

const journalRows = async (pool: pg.Pool, organizationId: string) =>
  (
    await pool.query(
      `SELECT to_jsonb(event) AS event, xmin::text, ctid::text FROM audit_events event
       WHERE organization_id = $1 ORDER BY id`,
      [organizationId],
    )
  ).rows

const checkDefinition = async (pool: pg.Pool) =>
  (
    await pool.query<{ definition: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated FROM pg_constraint
       WHERE conrelid = 'audit_events'::regclass AND conname = $1`,
      [constraint],
    )
  ).rows

describe.skipIf(!serverUrl)('SCIM suspension sign-in audit details', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails a redaction assertion when the details check is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertSuspensionDetails,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ key, status }) => [key, status])).toEqual([
        [`constraint public.audit_events.${constraint}`, 'covered'],
      ])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves a populated audit journal and matches a fresh install on no-op rerun',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'scim_audit_up' })
        const organizationId = randomUUID()
        const insert = journalFixture(upgraded.pool, organizationId)
        await insert(authenticationFailure, { ...details, reason: 'mailbox_unproven' })
        await insert(jitRefusal, { ...details, reason: 'jit_disabled' })
        await insert('sso_authentication.succeeded', details)
        const before = await journalRows(upgraded.pool, organizationId)
        expect(before).toHaveLength(3)
        await expect(
          insert(authenticationFailure, { ...details, reason: suspension }),
        ).rejects.toMatchObject(refused)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        fresh = await predecessor.clone(directory, { tag: 'scim_audit_new' })
        const freshCheck = await checkDefinition(fresh.pool)
        expect(freshCheck).toEqual([{ definition: expect.any(String), validated: true }])
        expect(await checkDefinition(upgraded.pool)).toEqual(freshCheck)
        expect(await journalRows(upgraded.pool, organizationId)).toEqual(before)
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await journalRows(upgraded.pool, organizationId)).toEqual(before)
        await assertSuspensionDetails(upgraded.pool)
        await assertSuspensionDetails(fresh.pool)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
