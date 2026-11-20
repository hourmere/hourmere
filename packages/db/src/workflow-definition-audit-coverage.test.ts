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
const migration = '0164_workflow_definition_audit.sql'
const constraint = 'audit_events_details_check'
const refused = { code: '23514', constraint }
const changes = ['workflow.created', 'workflow.updated', 'workflow.enabled', 'workflow.disabled']
const validEvents = [
  ['workflow.created', { revision: 1, trigger: 'booking.created' }],
  ['workflow.updated', { revision: 2, trigger: 'booking.cancelled' }],
  ['workflow.enabled', { revision: 2_147_483_647, trigger: 'booking.rescheduled' }],
  ['workflow.disabled', { revision: 2, trigger: 'before_start' }],
  ['workflow.deleted', { revision: 2 }],
  ['workflow.previewed', { trigger: 'after_end', reason: 'condition_false' }],
] as const

it('extends the latest earlier details check with only the six workflow actions', () => {
  const source = latestDetailsCheckMigration(migration)
  const previous = detailsCheckBranches(source)
  const current = detailsCheckBranches(migration)
  const defaultIndex = previous.branches.length - 1
  const emptyDetails = "details = '{}'::jsonb"

  expect(current.head).toBe(previous.head)
  expect(current.tail).toBe(previous.tail)
  expect(current.branches.slice(0, defaultIndex), source).toEqual(previous.branches.slice(0, -1))
  expect(current.branches.at(-1)?.text).toBe(`    ELSE ${emptyDetails}`)
  expect(current.branches.at(-1)).toEqual(previous.branches.at(-1))
  expect(current.branches.slice(defaultIndex, -1).map(({ when }) => when)).toEqual([
    `    WHEN action IN (${changes.map((action) => `'${action}'`).join(',')}) THEN ${emptyDetails} OR (`,
    `    WHEN action = 'workflow.deleted' THEN ${emptyDetails} OR (`,
    `    WHEN action = 'workflow.previewed' THEN ${emptyDetails} OR (`,
  ])
})

function journalFixture(pool: pg.Pool, organization: string = randomUUID()) {
  const actor = randomUUID()
  const session = randomUUID()
  const workflowId = randomUUID()
  return (
    action: string,
    details: unknown,
    targetType = 'workflow',
    targetId: string = workflowId,
  ) =>
    pool.query<{ details: unknown }>(
      `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
         credential_id, action, target_type, target_id, details)
       VALUES ($1, 'user', $2, 'session', $3, $4, $5, $6, $7::jsonb) RETURNING details`,
      [organization, actor, session, action, targetType, targetId, JSON.stringify(details)],
    )
}

async function assertWorkflowAuditDetails(pool: pg.Pool) {
  const insert = journalFixture(pool)
  for (const [action, details] of validEvents) {
    await expect(insert(action, {})).resolves.toMatchObject({ rows: [{ details: {} }] })
    await expect(insert(action, details)).resolves.toMatchObject({ rows: [{ details }] })
  }
  const previewDetails = { trigger: 'after_end' }
  await expect(insert('workflow.previewed', previewDetails)).resolves.toMatchObject({
    rows: [{ details: previewDetails }],
  })

  const [created, details] = validEvents[0]
  for (const invalid of [
    null,
    [details],
    { ...details, name: 'private-workflow-name' },
    { ...details, trigger: 'synthetic-private-value' },
    { ...details, trigger: ['booking.created'] },
    { ...details, trigger: null },
    { trigger: details.trigger },
    { revision: 1 },
  ]) {
    await expect(insert(created, invalid)).rejects.toMatchObject(refused)
  }
  for (const revision of [null, -1, 0, 1.5, '2', 2_147_483_648, 1e20]) {
    await expect(insert(created, { ...details, revision })).rejects.toMatchObject(refused)
    await expect(insert('workflow.deleted', { revision })).rejects.toMatchObject(refused)
  }
  await expect(insert('workflow.deleted', details)).rejects.toMatchObject(refused)
  for (const invalid of [
    details,
    { ...previewDetails, reason: 'synthetic-private-value' },
    { ...previewDetails, reason: null },
    { ...previewDetails, example: 'synthetic-private-value' },
    { reason: 'condition_false' },
  ]) {
    await expect(insert('workflow.previewed', invalid)).rejects.toMatchObject(refused)
  }
  await expect(insert('workflow.unregistered', details)).rejects.toMatchObject(refused)
}

async function seedJournal(pool: pg.Pool, organization: string) {
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
     VALUES ($1, 'Workflow audit fixture', $2, now())`,
    [organization, `fixture-${organization}`],
  )
  const webhookEvents = ['booking.created', 'workflow.executed']
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO webhooks (organization_id, url, events, secret_ciphertext)
     VALUES ($1, 'https://example.test/audit-fixture', $2, $3) RETURNING id`,
    [organization, webhookEvents, Buffer.alloc(60, 0xa5)],
  )
  const insert = journalFixture(pool, organization)
  await insert('webhook.updated', { events: webhookEvents }, 'webhook', endpoint.rows[0]?.id)
  await insert('scim_user.updated', { operations: ['add', 'replace'] }, 'scim_user', randomUUID())
  for (const [action] of validEvents) await insert(action, {})
}

const journalRows = async (pool: pg.Pool, organization: string) =>
  (
    await pool.query(
      `SELECT to_jsonb(a) AS event, xmin::text, ctid::text FROM audit_events a
       WHERE organization_id = $1 ORDER BY id`,
      [organization],
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

describe.skipIf(!serverUrl)('workflow definition audit details constraint', () => {
  it('fails a redaction assertion when the check is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertWorkflowAuditDetails,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`constraint public.audit_events.${constraint}`, 'covered'],
    ])
  }, 600_000)

  it('preserves the predecessor journal, matches a fresh install, and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-audit-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_audit_up' })
      const organization = randomUUID()
      await seedJournal(upgraded.pool, organization)
      const before = await journalRows(upgraded.pool, organization)
      expect(before).toHaveLength(2 + validEvents.length)
      const predecessorInsert = journalFixture(upgraded.pool, organization)
      for (const [action, details] of validEvents) {
        await expect(predecessorInsert(action, details)).rejects.toMatchObject(refused)
      }

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_audit_new' })
      const freshCheck = await checkDefinition(fresh.pool)
      expect(freshCheck).toEqual([{ definition: expect.any(String), validated: true }])
      expect(await checkDefinition(upgraded.pool)).toEqual(freshCheck)
      expect(await journalRows(upgraded.pool, organization)).toEqual(before)
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await journalRows(upgraded.pool, organization)).toEqual(before)
      await assertWorkflowAuditDetails(upgraded.pool)
      await assertWorkflowAuditDetails(fresh.pool)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  }, 120_000)
})
