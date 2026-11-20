import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { detailsCheckBranches, latestDetailsCheckMigration } from './audit-details-check-source.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0166_workflow_execution_audit.sql'
const constraint = 'audit_events_details_check'
const refused = { code: '23514', constraint }
const details = { revision: 3, trigger: 'before_start' }
const executionDetails = {
  'workflow.run_scheduled': details,
  'workflow.run_cancelled': details,
  'workflow.run_skipped': { ...details, reason: 'workflow_disabled' },
  'workflow.email_attempted': details,
  'workflow.email_sent': details,
  'workflow.email_rejected': details,
  'workflow.email_delivery_unknown': details,
  'workflow.webhook_queued': details,
  'workflow.webhook_completed': details,
  'workflow.webhook_failed': { ...details, reason: 'expired' },
}
const executionActions = Object.keys(executionDetails)

it('extends the latest predecessor details check only for workflow execution actions', () => {
  const source = latestDetailsCheckMigration(migration)
  const previous = detailsCheckBranches(source)
  const current = detailsCheckBranches(migration)
  const defaultIndex = previous.branches.length - 1
  const empty = "details = '{}'::jsonb"

  expect(current.head).toBe(previous.head)
  expect(current.tail).toBe(previous.tail)
  expect(current.branches.slice(0, defaultIndex), source).toEqual(previous.branches.slice(0, -1))
  expect(current.branches.at(-1)).toEqual(previous.branches.at(-1))
  expect(current.branches.at(-1)?.when).toBe(`    ELSE ${empty}`)
  expect(current.branches.slice(defaultIndex, -1).map(({ when }) => when)).toEqual([
    `    WHEN action IN (${executionActions.map((action) => `'${action}'`).join(',')}) THEN ${empty} OR (`,
  ])
})

function journalFixture(pool: pg.Pool, organizationId = randomUUID()) {
  const workflowId = randomUUID()
  return (action: string, value: unknown, targetType = 'workflow', targetId = workflowId) =>
    pool.query<{ details: unknown }>(
      `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
         action, target_type, target_id, details)
       VALUES ($1, 'system', 'workflow-dispatch', 'none', $2, $3, $4, $5::jsonb)
       RETURNING details`,
      [organizationId, action, targetType, targetId, JSON.stringify(value)],
    )
}

async function assertExecutionDetails(pool: pg.Pool) {
  const insert = journalFixture(pool)
  for (const [action, value] of Object.entries(executionDetails)) {
    await expect(insert(action, {})).resolves.toMatchObject({ rows: [{ details: {} }] })
    await expect(insert(action, value)).resolves.toMatchObject({ rows: [{ details: value }] })
  }
  await expect(insert('workflow.webhook_failed', details)).resolves.toMatchObject({
    rows: [{ details }],
  })

  for (const invalid of [
    [],
    { ...details, bookingId: randomUUID() },
    { ...details, revision: '3' },
    { ...details, revision: 0 },
    { ...details, revision: 1.5 },
    { ...details, revision: 2_147_483_648 },
    { ...details, trigger: 'unlisted' },
    { revision: 1 },
    { trigger: 'before_start' },
    { ...details, reason: 'expired' },
  ]) {
    await expect(insert('workflow.run_scheduled', invalid)).rejects.toMatchObject(refused)
  }
  await expect(insert('workflow.run_skipped', details)).rejects.toMatchObject(refused)
  await expect(
    insert('workflow.run_skipped', { ...details, reason: 'unlisted' }),
  ).rejects.toMatchObject(refused)
  await expect(
    insert('workflow.webhook_failed', { ...details, reason: 'workflow_disabled' }),
  ).rejects.toMatchObject(refused)
}

const journalRows = async (pool: pg.Pool, organizationId: string) =>
  (
    await pool.query(
      `SELECT to_jsonb(a) AS event, xmin::text, ctid::text FROM audit_events a
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

describe.skipIf(!serverUrl)('workflow execution audit details constraint', () => {
  it('fails a redaction assertion when the check is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertExecutionDetails,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`constraint public.audit_events.${constraint}`, 'covered'],
    ])
  }, 600_000)

  it('preserves the populated predecessor, matches a fresh install, and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-execution-audit-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_exec_aud_up' })
      const organizationId = randomUUID()
      const insert = journalFixture(upgraded.pool, organizationId)
      await insert('workflow.updated', details)
      await insert(
        'workflow.previewed',
        { trigger: 'after_end' },
        'workflow_preview',
        organizationId,
      )
      const providerId = '019b0000-0000-7000-8000-000000000001'
      await insert(
        'sso_provider.created',
        { method: 'oidc', providerId, revision: 1 },
        'sso_provider',
        providerId,
      )
      await insert('workflow.run_scheduled', {})
      const before = await journalRows(upgraded.pool, organizationId)
      expect(before).toHaveLength(4)
      for (const [action, value] of Object.entries(executionDetails)) {
        await expect(insert(action, value)).rejects.toMatchObject(refused)
      }

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_exec_aud_new' })
      const freshCheck = await checkDefinition(fresh.pool)
      expect(freshCheck).toEqual([{ definition: expect.any(String), validated: true }])
      expect(await checkDefinition(upgraded.pool)).toEqual(freshCheck)
      expect(await journalRows(upgraded.pool, organizationId)).toEqual(before)
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await journalRows(upgraded.pool, organizationId)).toEqual(before)
      await assertExecutionDetails(upgraded.pool)
      await assertExecutionDetails(fresh.pool)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
