// Explicit local-only benchmark; every data/query operation uses its own disposable DB.
// DATABASE_URL is used only by createTestDatabase to create/drop that database.
// Example: DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
//   node scripts/webhook-reconciliation-benchmark.ts --scales=1,5 --mode=current
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDb, type Database } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import {
  WEBHOOK_DELIVERY_JOB,
  webhookCleanupJob,
  webhookDeliveryJob,
} from '../packages/webhooks/src/delivery.ts'

// Historical handler from 8760eafc: retained so the same fixture can reproduce Board #153.
// Only synthetic data enters these queries. Do not point queries at the admin database.
const baselineReconciliation = sql`
  WITH orphaned AS (
    SELECT d.id FROM webhook_deliveries d
    WHERE d.status = 'pending' AND NOT EXISTS (
      SELECT 1 FROM pgboss.job j
      WHERE j.name = ${WEBHOOK_DELIVERY_JOB} AND j.singleton_key = d.id::text
        AND j.state IN ('created', 'retry', 'active')
    )
    ORDER BY d.id LIMIT 1000 FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE webhook_deliveries d SET status = 'failed', last_error = 'job_missing',
    attempts = LEAST(13, GREATEST(d.attempts, COALESCE((
      SELECT MAX(CASE WHEN j.started_on IS NULL THEN 0 ELSE j.retry_count + 1 END)
      FROM pgboss.job j
      WHERE j.name = ${WEBHOOK_DELIVERY_JOB} AND j.singleton_key = d.id::text
    ), 0)))
  FROM orphaned o WHERE d.id = o.id AND d.status = 'pending'
`

const args = new Map<string, string>(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=')
    if (!key || value === undefined) throw new Error('Arguments must use --key=value')
    return [key, value]
  }),
)
const serverUrl = process.env.DATABASE_URL
if (!serverUrl) throw new Error('DATABASE_URL must name an admin URL for disposable databases')
const mode = args.get('mode') ?? 'current'
if (!['baseline', 'current'].includes(mode)) throw new Error('mode must be baseline or current')
const scales = (args.get('scales') ?? '1,5').split(',').map(Number)
if (scales.some((scale) => !Number.isSafeInteger(scale) || scale < 1 || scale > 5))
  throw new Error('scales must be integers between 1 and 5')
const output = args.get('output')
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
const results: unknown[] = []

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Actual Loops': number
  'Actual Rows': number
  'Rows Removed by Filter'?: number
  Plans?: PlanNode[]
}
interface ExplainResult {
  'Execution Time': number
  Plan: PlanNode
}
function jobScanMetrics(node: PlanNode): object[] {
  const scans = node['Relation Name']?.startsWith('job')
    ? [
        {
          type: node['Node Type'],
          relation: node['Relation Name'],
          loops: node['Actual Loops'],
          rowsPerLoop: node['Actual Rows'],
          filteredPerLoop: node['Rows Removed by Filter'] ?? 0,
        },
      ]
    : []
  return [...scans, ...(node.Plans ?? []).flatMap(jobScanMetrics)]
}

for (const scale of scales) {
  const testDb = await createTestDatabase(serverUrl)
  const db = createDb(testDb.pool)
  const jobs = createJobs({
    connectionString: testDb.url,
    definitions: [webhookDeliveryJob({ db, enabled: false })],
    work: false,
    migrate: true,
    maxConnections: 1,
    log: () => {},
  })
  try {
    await jobs.start()
    const organization = await db
      .insertInto('auth.organization')
      .values({
        name: 'Synthetic benchmark',
        slug: `benchmark-${randomUUID()}`,
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const endpoint = await db
      .insertInto('webhooks')
      .values({
        organization_id: organization.id,
        url: 'https://hooks.example.com/synthetic',
        events: ['booking.created'],
        secret_ciphertext: Buffer.from('synthetic unused fixture'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const orphanCount = 1000 * scale
    const jobsCount = 200_000 * scale
    await testDb.pool.query(
      `WITH synthetic_bookings AS (
        INSERT INTO bookings (organization_id, start_at, end_at, title, source, created_at)
        SELECT $1, $3::timestamptz + n * interval '1 minute',
          $3::timestamptz + n * interval '1 minute' + interval '30 minutes',
          'Synthetic benchmark', 'api', $3 FROM generate_series(1, $4::integer) n
        RETURNING id
      )
      INSERT INTO webhook_deliveries
        (webhook_id, organization_id, booking_id, event_id, event_type, payload, created_at)
      SELECT $2, $1, id, uuidv7(), 'booking.created', '{}', $3 FROM synthetic_bookings`,
      [organization.id, endpoint.id, now.toString(), orphanCount],
    )
    // Include terminal history for every orphan, so MAX(attempt) needs real matching rows.
    // Remaining terminal jobs model the unrelated retained history in this same queue.
    await testDb.pool.query(
      `INSERT INTO pgboss.job (name, singleton_key, data, state, policy, retry_count, started_on)
       SELECT $1, id::text, jsonb_build_object('deliveryId', id), 'failed'::pgboss.job_state, 'exclusive', 12, now()
       FROM webhook_deliveries
       UNION ALL
       SELECT $1, synthetic_id::text, jsonb_build_object('deliveryId', synthetic_id),
         'failed'::pgboss.job_state, 'exclusive', 12, now()
       FROM (SELECT uuidv7() AS synthetic_id
         FROM generate_series(1, $2::integer)) synthetic`,
      [WEBHOOK_DELIVERY_JOB, jobsCount - orphanCount],
    )
    await testDb.pool.query('ANALYZE webhook_deliveries')
    await testDb.pool.query('ANALYZE pgboss.job')
    // Capture the actual handler's SQL and durations; no production SQL is reconstructed.
    const queries: { sql: string; parameters: readonly unknown[]; durationMs: number }[] = []
    const measuredDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: testDb.pool }),
      log: (event) => {
        if (event.level === 'query')
          queries.push({
            sql: event.query.sql,
            parameters: event.query.parameters,
            durationMs: event.queryDurationMillis,
          })
      },
    })
    const started = performance.now()
    if (mode === 'baseline') {
      await baselineReconciliation.execute(measuredDb)
      const expired = await measuredDb
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('created_at', '<', new Date(now.subtract({ hours: 24 * 30 }).epochMilliseconds))
        .orderBy('id')
        .limit(1000)
        .execute()
      if (expired.length)
        await measuredDb
          .deleteFrom('webhook_deliveries')
          .where(
            'id',
            'in',
            expired.map((row) => row.id),
          )
          .execute()
    } else {
      await webhookCleanupJob(measuredDb, () => now).handler(
        {},
        { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
      )
    }
    const handlerMs = performance.now() - started
    const statuses = (
      await testDb.pool.query(
        'SELECT status, count(*)::integer AS count FROM webhook_deliveries GROUP BY status ORDER BY status',
      )
    ).rows
    assert.deepEqual(
      statuses,
      orphanCount === 1000
        ? [{ status: 'failed', count: 1000 }]
        : [
            { status: 'failed', count: 1000 },
            { status: 'pending', count: orphanCount - 1000 },
          ],
    )
    await testDb.pool.query(
      "UPDATE webhook_deliveries SET status='pending', attempts=0, last_error=NULL",
    )
    const client = await testDb.pool.connect()
    const plans = []
    try {
      await client.query('BEGIN')
      for (const query of queries) {
        if (!/^\s*(WITH|SELECT|UPDATE|DELETE)/i.test(query.sql)) continue
        const explained = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
          [...query.parameters],
        )
        plans.push({
          sql: query.sql,
          plan: explained.rows[0]?.['QUERY PLAN'] as ExplainResult[] | undefined,
        })
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    const result = { mode, scale, orphanCount, jobsCount, handlerMs, statuses, queries, plans }
    results.push(result)
    console.log(
      JSON.stringify({
        mode,
        scale,
        orphanCount,
        jobsCount,
        handlerMs,
        statuses,
        planCount: plans.length,
        jobScans: plans.flatMap(
          ({ plan }) => plan?.flatMap((entry) => jobScanMetrics(entry.Plan)) ?? [],
        ),
        queries: queries.map(({ sql, durationMs }) => ({
          sql: sql.trim().split('\n')[0],
          durationMs,
        })),
      }),
    )
    if (output) await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
  } finally {
    await jobs.stop()
    await testDb.drop()
  }
}
