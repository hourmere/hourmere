import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { detailsCheck, detailsCheckMigrations } from './sso-audit-check-source.ts'
import { ssoAuditTestId } from './sso-audit-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0163_sso_recovery_audit.sql'
const action = 'sso_delegation.revoked'

it('strictly widens the newest earlier audit details constraint', () => {
  const migrations = detailsCheckMigrations()
  const predecessor = migrations[migrations.indexOf(migration) - 1] as string
  const previous = detailsCheck(predecessor)
  const current = detailsCheck(migration)
  const oldBranch = previous.branches.find((branch) => branch.when.includes(`'${action}'`))
  if (!oldBranch) throw new Error('The predecessor has no delegation revocation branch')
  const remaining = oldBranch.when.replace(`'${action}',`, '')
  const [, expression] = oldBranch.text.split(oldBranch.when)
  const widened = `    WHEN action = '${action}'${oldBranch.when.slice(oldBranch.when.indexOf(' THEN ')).replace("'correlationId'", "'correlationId','reason'")}`
  expect(current).toEqual({
    ...previous,
    branches: previous.branches.flatMap((branch) =>
      branch === oldBranch
        ? [
            { when: remaining, text: branch.text.replace(branch.when, remaining) },
            {
              when: widened,
              text: `    -- A key moving teams invalidates its old binding with a fixed reason code.\n${widened}${expression}\n      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'\n        AND details->>'reason' IN ('key_moved_team'), false))`,
            },
          ]
        : [branch],
    ),
  })
})

function record(pool: pg.Pool, action: string, details: object) {
  return pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('user', $1, 'session', $2, 'member', $3, $4)`,
    [randomUUID(), action, randomUUID(), details],
  )
}

async function assertDetails(pool: pg.Pool) {
  const refused = { code: '23514', constraint: 'audit_events_details_check' }
  const provider = { method: 'oidc', providerId: ssoAuditTestId(), revision: 3 }
  await expect(record(pool, action, provider)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    record(pool, action, { ...provider, reason: 'key_moved_team' }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    record(pool, action, { ...provider, reason: 'provider_error' }),
  ).rejects.toMatchObject(refused)
  await expect(record(pool, action, { ...provider, reason: null })).rejects.toMatchObject(refused)
  await expect(
    record(pool, 'sso_delegation.bound', { ...provider, reason: 'key_moved_team' }),
  ).rejects.toMatchObject(refused)
  await expect(record(pool, 'sso_recovery.removed', {})).resolves.toMatchObject({ rowCount: 1 })
  await expect(record(pool, 'sso_recovery.removed', { revision: 3 })).rejects.toMatchObject(refused)
}

describe.skipIf(!serverUrl)('SSO recovery audit migration', () => {
  it('fails an assertion when the replacement check is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertDetails,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      ['constraint public.audit_events.audit_events_details_check', 'covered'],
    ])
  }, 600_000)

  it('keeps existing journal entries and matches a fresh install after a no-op rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-recovery-audit-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, {
        tag: 'sso_recovery_up',
      })
      for (const [name, details] of [
        [action, { method: 'oidc', providerId: ssoAuditTestId(), revision: 4 }],
        ['scim_user.updated', { operations: ['replace', 'add'] }],
        ['webhook.updated', { events: ['booking.created', 'workflow.executed'] }],
        ['sso_recovery.enrolled', {}],
      ] as const)
        await record(upgraded.pool, name, details)
      const journal =
        'SELECT to_jsonb(a) AS event, xmin::text, ctid::text FROM audit_events a ORDER BY id'
      const before = (await upgraded.pool.query(journal)).rows
      expect(before).toHaveLength(4)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      expect((await upgraded.pool.query(journal)).rows).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_recovery_new' })
      expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(upgraded.pool))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect((await upgraded.pool.query(journal)).rows).toEqual(before)
      await assertDetails(upgraded.pool)
      await assertDetails(fresh.pool)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
