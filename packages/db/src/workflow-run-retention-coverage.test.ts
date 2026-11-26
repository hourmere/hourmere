import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'
import { executionFixture, executionTables } from './workflow-storage-execution-protections.ts'
import { refused } from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0177_workflow_run_retention.sql'
const retained = { code: '23514', constraint: 'workflow_runs_retained' }
const runIndex = 'workflow_runs_retention'
const webhookIndex = 'webhook_deliveries_workflow_run_pending'
const deleteRun = 'DELETE FROM workflow_runs WHERE id = $1'

async function retireRun(pool: pg.Pool, id: string) {
  await expect(
    pool.query(
      `UPDATE workflow_runs
       SET state = 'retired', finished_at = transaction_timestamp() - interval '744 hours',
           claim_token = NULL, lease_until = NULL
       WHERE id = $1`,
      [id],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
}

async function claimRun(pool: pg.Pool, id: string, token: string) {
  await expect(
    pool.query(
      `UPDATE workflow_runs SET state = 'claimed', claim_token = $2,
       lease_until = transaction_timestamp() + interval '60 seconds' WHERE id = $1`,
      [id, token],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
}

async function assertRetentionProtections(pool: pg.Pool) {
  const fixture = await executionFixture(pool)
  const pending = await fixture.capture()
  const claimed = await fixture.capture(fixture.otherTeam)
  const atCutoff = await fixture.capture()
  const old = await fixture.capture()

  await refused(pool, retained, (db) => db.query(deleteRun, [pending.run]), 'pending run')
  await claimRun(pool, claimed.run, randomUUID())
  await refused(pool, retained, (db) => db.query(deleteRun, [claimed.run]), 'claimed run')
  await refused(
    pool,
    retained,
    async (db) => {
      await db.query(
        `UPDATE workflow_runs
         SET state = 'retired', finished_at = transaction_timestamp() - interval '720 hours'
         WHERE id = $1`,
        [atCutoff.run],
      )
      return db.query(deleteRun, [atCutoff.run])
    },
    'finished exactly at the cutoff',
  )

  const attempt = randomUUID()
  await claimRun(pool, old.run, attempt)
  await expect(
    pool.query(
      `UPDATE workflow_recipient_claims SET state = 'dispatching', claim_token = $2, attempts = 1
       WHERE id = $1`,
      [old.claim, attempt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await retireRun(pool, old.run)
  await refused(pool, retained, (db) => db.query(deleteRun, [old.run]), 'dispatching claim')
  await expect(
    fixture.finish('workflow_recipient_claims', old.claim, 'delivery_unknown'),
  ).resolves.toMatchObject({ rowCount: 1 })

  await expect(
    pool.query(
      `WITH endpoint AS (
         INSERT INTO webhooks (organization_id, url, events, secret_ciphertext)
         VALUES ($1, 'https://example.test/webhook', ARRAY['workflow.executed'], '\\x01') RETURNING id
       )
       INSERT INTO webhook_deliveries (webhook_id, organization_id, booking_id, workflow_run_id,
         event_id, event_type, payload)
       SELECT id, $1, $2, $3, uuidv7(), 'workflow.executed', '{}' FROM endpoint`,
      [old.organization, old.booking, old.run],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await refused(pool, retained, (db) => db.query(deleteRun, [old.run]), 'pending webhook delivery')
  await expect(
    pool.query(`UPDATE webhook_deliveries SET status = 'failed' WHERE workflow_run_id = $1`, [
      old.run,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await refused(pool, { code: '23514', constraint: 'workflow_recipient_claims_retained' }, (db) =>
    db.query('DELETE FROM workflow_recipient_claims WHERE id = $1', [old.claim]),
  )
  await expect(pool.query(deleteRun, [old.run])).resolves.toMatchObject({ rowCount: 1 })
  await expect(fixture.one('workflow_recipient_claims', old.claim)).resolves.toBeUndefined()
  await expect(fixture.one('workflow_enrollments', old.enrollment)).resolves.toMatchObject({
    id: old.enrollment,
  })
  await expect(
    fixture.rows('webhook_deliveries', 'workflow_run_id = $1', [old.run]),
  ).resolves.toEqual([expect.objectContaining({ status: 'failed' })])

  await expect(
    pool.query('DELETE FROM bookings WHERE id = $1', [pending.booking]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(fixture.one('workflow_enrollments', pending.enrollment)).resolves.toBeUndefined()
  await expect(fixture.one('workflow_runs', pending.run)).resolves.toBeUndefined()
  await expect(fixture.one('workflow_recipient_claims', pending.claim)).resolves.toBeUndefined()
  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [claimed.organization]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(fixture.one('workflow_runs', claimed.run)).resolves.toBeUndefined()

  await expect(
    pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN ($1, $2) ORDER BY indexname`,
      [runIndex, webhookIndex],
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        indexdef:
          "CREATE INDEX webhook_deliveries_workflow_run_pending ON public.webhook_deliveries USING btree (workflow_run_id) WHERE ((status = 'pending'::text) AND (workflow_run_id IS NOT NULL))",
      },
      {
        indexdef:
          'CREATE INDEX workflow_runs_retention ON public.workflow_runs USING btree (finished_at, id) WHERE (finished_at IS NOT NULL)',
      },
    ],
  })
}

// PostgreSQL's JSON representation and tuple identity also catch physical rewrites or
// timestamp differences below the precision of JavaScript dates.
async function executionRecords(pool: pg.Pool) {
  return Promise.all(
    executionTables.map(
      async (table) =>
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS record, xmin::text, ctid::text
           FROM ${table} t ORDER BY record`,
          )
        ).rows,
    ),
  )
}

describe.skipIf(!serverUrl)('workflow run retention migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails a protection assertion if the updated guard or either retention index is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertRetentionProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ key, status }) => [key, status])).toEqual([
        [`index public.webhook_deliveries.${webhookIndex}`, 'covered'],
        [`index public.workflow_runs.${runIndex}`, 'covered'],
        ['trigger public.workflow_runs.workflow_runs_guard', 'covered'],
      ])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves existing execution rows, matches a fresh install, and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'wf_retention_up' })
        const pool = upgraded.pool
        const fixture = await executionFixture(pool)
        await fixture.capture()
        const old = await fixture.capture()
        await retireRun(pool, old.run)
        await pool.query(
          `INSERT INTO workflow_run_history (run_id, organization_id, workflow_id, revision,
           trigger, due_at, finished_at, outcome)
         SELECT id, organization_id, $2, 1, 'before_start', due_at, finished_at, 'retired'
         FROM workflow_runs WHERE id = $1`,
          [old.run, old.workflow],
        )
        await refused(pool, retained, (db) => db.query(deleteRun, [old.run]))
        const before = await executionRecords(pool)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(pool, directory)).resolves.toEqual([migration])
        await expect(runMigrations(pool, directory)).resolves.toEqual([])
        expect(await executionRecords(pool)).toEqual(before)

        fresh = await predecessor.clone(directory, { tag: 'wf_retention_new' })
        expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        await expect(pool.query(deleteRun, [old.run])).resolves.toMatchObject({ rowCount: 1 })
        await expect(fixture.one('workflow_recipient_claims', old.claim)).resolves.toBeUndefined()
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
