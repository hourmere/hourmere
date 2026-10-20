// Explicit local-only benchmark; all fixture/query operations use a disposable database.
// DATABASE_URL is used only by createTestDatabase to create/drop that database.
// Example: DATABASE_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
//   node scripts/webhook-reconciliation-benchmark.ts --output=/tmp/webhook-reconciliation.json
// Defaults: 300k and 1M jobs, 5k pending deliveries, mixed queues and an all-webhook stress case.
// Use --pending=1000,50000,200000 for the scale matrix; three measured samples per variant.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createDb, type Database } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import {
  WEBHOOK_DELIVERY_JOB,
  webhookCleanupJob,
  webhookDeliveryJob,
} from '../packages/webhooks/src/delivery.ts'

// PR #21 / migration 0034 baseline: two retained-job scans. Keep this snapshot so the
// production handler's compiled SQL can be compared on exactly the same fixture/indexes.
const baselineReconciliation = sql`
  WITH orphaned AS MATERIALIZED (
    SELECT d.id FROM webhook_deliveries d
    WHERE d.status = 'pending' AND NOT EXISTS (
      SELECT 1 FROM pgboss.job j
      WHERE j.name = ${WEBHOOK_DELIVERY_JOB} AND j.singleton_key = d.id::text
        AND j.state IN ('created', 'retry', 'active')
    )
    ORDER BY d.id LIMIT 1000 FOR UPDATE OF d SKIP LOCKED
  ), job_attempts AS MATERIALIZED (
    SELECT j.singleton_key,
      MAX(CASE WHEN j.started_on IS NULL THEN 0 ELSE j.retry_count + 1 END) AS attempts
    FROM pgboss.job j JOIN orphaned o ON j.singleton_key = o.id::text
    WHERE j.name = ${WEBHOOK_DELIVERY_JOB}
    GROUP BY j.singleton_key
  )
  UPDATE webhook_deliveries d SET status = 'failed', last_error = 'job_missing',
    attempts = LEAST(13, GREATEST(d.attempts, COALESCE(a.attempts, 0)))
  FROM orphaned o LEFT JOIN job_attempts a ON a.singleton_key = o.id::text
  WHERE d.id = o.id AND d.status = 'pending'
`

const args = new Map<string, string>(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=')
    if (!key || value === undefined) throw new Error('Arguments must use --key=value')
    return [key, value]
  }),
)
for (const key of args.keys()) {
  if (!['jobs', 'pending', 'layouts', 'samples', 'mode', 'output'].includes(key))
    throw new Error(`Unknown argument: ${key}`)
}
const serverUrl = process.env.DATABASE_URL
if (!serverUrl) throw new Error('DATABASE_URL must name an admin URL for disposable databases')
const mode = args.get('mode') ?? 'compare'
if (!['baseline', 'current', 'inline', 'compare'].includes(mode))
  throw new Error('mode must be baseline, current, inline or compare')
const jobCounts = (args.get('jobs') ?? '300000,1000000').split(',').map(Number)
if (jobCounts.some((count) => !Number.isSafeInteger(count) || count < 10_000 || count > 1_000_000))
  throw new Error('jobs must be integers between 10000 and 1000000')
const pendingCounts = (args.get('pending') ?? '5000').split(',').map(Number)
const smallestJobsCount = Math.min(...jobCounts)
if (
  pendingCounts.some(
    (count) => !Number.isSafeInteger(count) || count < 1 || count > smallestJobsCount,
  )
)
  throw new Error(
    `pending must be integers between 1 and the smallest jobs count (${smallestJobsCount})`,
  )
// A partial group ending in kinds 4–7 has an extra history job before its missing kind 0.
if (pendingCounts.some((count) => count + Number(count % 8 >= 4) > smallestJobsCount))
  throw new Error('jobs must also accommodate the extra history row in a partial pending group')
const layouts = (args.get('layouts') ?? 'mixed,webhook').split(',')
if (layouts.some((layout) => !['mixed', 'webhook'].includes(layout)))
  throw new Error('layouts must be mixed or webhook')
const samples = Number(args.get('samples') ?? 3)
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10)
  throw new Error('samples must be an integer between 1 and 10')
const output = args.get('output')
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
const otherQueues = [
  'booking-notification',
  'calendar-sync',
  'conference-dispatch',
  'sign-in-email',
]
const results: unknown[] = []

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Loops': number
  'Actual Rows': number
  'Rows Removed by Filter'?: number
  'Shared Hit Blocks'?: number
  'Shared Read Blocks'?: number
  'Temp Read Blocks'?: number
  'Temp Written Blocks'?: number
  'Hash Batches'?: number
  'Peak Memory Usage'?: number
  'Sort Method'?: string
  Plans?: PlanNode[]
}
interface ExplainResult {
  'Execution Time': number
  'Planning Time': number
  Plan: PlanNode
}
interface DeliveryResult {
  id: string
  status: string
  attempts: number
  last_error: string | null
}
interface Query {
  sql: string
  parameters: readonly unknown[]
}
function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)]
}
function summarize(plan: ExplainResult, wallMs: number) {
  const nodes = planNodes(plan.Plan)
  return {
    wallMs,
    executionMs: plan['Execution Time'],
    planningMs: plan['Planning Time'],
    sharedHitBlocks: plan.Plan['Shared Hit Blocks'] ?? 0,
    sharedReadBlocks: plan.Plan['Shared Read Blocks'] ?? 0,
    tempReadBlocks: plan.Plan['Temp Read Blocks'] ?? 0,
    tempWrittenBlocks: plan.Plan['Temp Written Blocks'] ?? 0,
    jobScans: nodes
      .filter((node) => node['Relation Name']?.startsWith('job'))
      .map((node) => ({
        type: node['Node Type'],
        relation: node['Relation Name'],
        index: node['Index Name'],
        loops: node['Actual Loops'],
        rowsPerLoop: node['Actual Rows'],
        filteredPerLoop: node['Rows Removed by Filter'] ?? 0,
      })),
    hashes: nodes
      .filter((node) => node['Node Type'] === 'Hash')
      .map((node) => ({
        rows: node['Actual Rows'],
        batches: node['Hash Batches'],
        peakMemoryKb: node['Peak Memory Usage'],
      })),
    sorts: nodes
      .filter((node) => node['Node Type'].includes('Sort'))
      .map((node) => ({ rows: node['Actual Rows'], method: node['Sort Method'] })),
  }
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
function expectedRows(pendingCount: number): DeliveryResult[] {
  let failed = 0
  return Array.from({ length: pendingCount }, (_, index) => {
    const n = index + 1
    const kind = n % 8
    const orphan = kind < 5 && failed < 1000
    if (orphan) failed++
    const historyAttempts = [0, 13, 3, 0, 9][kind] ?? 0
    return {
      id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      status: orphan ? 'failed' : 'pending',
      attempts: orphan ? Math.min(13, Math.max(n % 4, historyAttempts)) : n % 4,
      last_error: orphan ? 'job_missing' : null,
    }
  })
}

const scales = jobCounts.flatMap((jobsCount) =>
  pendingCounts.map((pendingCount) => ({ jobsCount, pendingCount })),
)
for (const { jobsCount, pendingCount } of scales) {
  for (const layout of layouts) {
    const testDb = await createTestDatabase(serverUrl)
    const databaseName = new URL(testDb.url).pathname.slice(1)
    const db = createDb(testDb.pool)
    const deliveryDefinition = webhookDeliveryJob({ db, enabled: false })
    const jobs = createJobs({
      connectionString: testDb.url,
      definitions: [
        deliveryDefinition,
        ...otherQueues.map((name) => ({ ...deliveryDefinition, name })),
      ],
      work: false,
      migrate: true,
      maxConnections: 1,
      log: () => {},
    })
    try {
      const environment = (
        await testDb.pool.query(`SELECT version() AS postgres,
          current_setting('server_version_num')::integer AS server_version_num,
          current_setting('work_mem') AS work_mem,
          current_setting('max_connections') AS max_connections`)
      ).rows[0]
      assert.equal(
        Math.floor(environment.server_version_num / 10_000),
        18,
        'benchmark fixtures require PostgreSQL 18',
      )
      await jobs.start()
      const organization = await db
        .insertInto('auth.organization')
        .values({ name: 'Synthetic benchmark', slug: 'benchmark', createdAt: new Date() })
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
      await testDb.pool.query(
        `WITH synthetic_bookings AS (
          INSERT INTO bookings (id, organization_id, start_at, end_at, title, source, created_at)
          SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
            $1, $3::timestamptz + n * interval '1 minute',
            $3::timestamptz + n * interval '1 minute' + interval '30 minutes',
            'Synthetic benchmark', 'api', $3 FROM generate_series(1, $4::integer) n
          RETURNING id
        )
        INSERT INTO webhook_deliveries
          (id, webhook_id, organization_id, booking_id, event_id, event_type, payload, created_at, attempts)
        SELECT id, $2, $1, id, id, 'booking.created', '{}', $3,
          right(id::text, 12)::integer % 4 FROM synthetic_bookings`,
        [organization.id, endpoint.id, now.toString(), pendingCount],
      )
      // Each group of eight deliveries includes missing, failed, completed, never-started
      // cancelled, multiple terminal attempts, created, delayed retry and active jobs.
      // Older matching history and old live jobs deliberately prevent an unsafe time cutoff.
      await testDb.pool.query(
        `INSERT INTO pgboss.job
          (id, name, singleton_key, data, state, policy, retry_count,
           created_on, started_on, completed_on, start_after)
        SELECT md5('matching-' || n)::uuid, $1, d.id::text,
          jsonb_build_object('deliveryId', d.id),
          (CASE n % 8 WHEN 1 THEN 'failed' WHEN 2 THEN 'completed' WHEN 3 THEN 'cancelled'
            WHEN 4 THEN 'failed' WHEN 5 THEN 'created' WHEN 6 THEN 'retry' ELSE 'active' END)::pgboss.job_state,
          'exclusive',
          CASE n % 8 WHEN 1 THEN 12 WHEN 2 THEN 2 WHEN 4 THEN 3 WHEN 6 THEN 6 WHEN 7 THEN 7 ELSE 0 END,
          $2::timestamptz - CASE WHEN n % 8 IN (2, 6, 7) THEN interval '90 days' ELSE interval '1 day' END,
          CASE WHEN n % 8 IN (3, 5) THEN NULL ELSE $2::timestamptz - interval '1 day' END,
          CASE WHEN n % 8 < 5 THEN $2::timestamptz - interval '1 hour' ELSE NULL END,
          $2::timestamptz + CASE WHEN n % 8 = 6 THEN interval '1 day' ELSE interval '0' END
        FROM webhook_deliveries d CROSS JOIN LATERAL (SELECT right(d.id::text, 12)::integer AS n) s
        WHERE n % 8 <> 0
        UNION ALL
        SELECT md5('extra-' || n)::uuid, $1, d.id::text, jsonb_build_object('deliveryId', d.id),
          'failed'::pgboss.job_state, 'exclusive', 8,
          $2::timestamptz - interval '90 days', $2::timestamptz - interval '89 days',
          $2::timestamptz - interval '89 days', $2::timestamptz - interval '90 days'
        FROM webhook_deliveries d CROSS JOIN LATERAL (SELECT right(d.id::text, 12)::integer AS n) s
        WHERE n % 8 = 4`,
        [WEBHOOK_DELIVERY_JOB, now.toString()],
      )
      // Complete groups have pendingCount matching jobs: an extra terminal history row
      // offsets each missing job. Count partial groups too before adding unrelated history.
      const matchingJobsCount = Number(
        (await testDb.pool.query('SELECT count(*) AS count FROM pgboss.job')).rows[0].count,
      )
      await testDb.pool.query(
        `INSERT INTO pgboss.job
          (id, name, singleton_key, data, state, policy, retry_count,
           created_on, started_on, completed_on, start_after)
        SELECT md5('retained-' || n)::uuid,
          CASE WHEN $3 = 'webhook' OR n % 10 < 6 THEN $1 ELSE ($4::text[])[1 + n % 4] END,
          md5('retained-key-' || n)::uuid::text,
          jsonb_build_object('synthetic', n),
          (CASE n % 101 WHEN 0 THEN 'created' WHEN 1 THEN 'retry' WHEN 2 THEN 'active'
            WHEN 3 THEN 'cancelled' ELSE CASE WHEN n % 101 < 16 THEN 'failed' ELSE 'completed' END END)::pgboss.job_state,
          'exclusive', CASE WHEN n % 101 = 0 THEN 0 ELSE n % 13 END,
          $5::timestamptz - (1 + n % 7) * interval '1 day',
          CASE WHEN n % 101 IN (0, 3) THEN NULL
            ELSE $5::timestamptz - (1 + n % 7) * interval '1 day' + interval '1 minute' END,
          CASE WHEN n % 101 < 3 THEN NULL
            ELSE $5::timestamptz - (n % 7) * interval '1 day' - interval '1 hour' END,
          $5::timestamptz + CASE WHEN n % 101 = 1 THEN interval '1 day' ELSE interval '0' END
        FROM generate_series(1, $2::integer) n`,
        [WEBHOOK_DELIVERY_JOB, jobsCount - matchingJobsCount, layout, otherQueues, now.toString()],
      )
      await testDb.pool.query('ANALYZE webhook_deliveries')
      await testDb.pool.query('ANALYZE pgboss.job')
      const distribution = (
        await testDb.pool.query(`SELECT name, state, count(*)::integer AS count FROM pgboss.job
          GROUP BY name, state ORDER BY name, state`)
      ).rows
      assert.equal(
        distribution.reduce((sum, row) => sum + row.count, 0),
        jobsCount,
      )
      // Capture the actual production handler SQL, rather than maintaining a second copy.
      const queries: Query[] = []
      const measuredDb = new Kysely<Database>({
        dialect: new PostgresDialect({ pool: testDb.pool }),
        log: (event) => {
          if (event.level === 'query')
            queries.push({ sql: event.query.sql, parameters: event.query.parameters })
        },
      })
      const expected = expectedRows(pendingCount)
      const processedRows = expected.filter((row) => row.status === 'failed').length
      await webhookCleanupJob(measuredDb, () => now).handler(
        {},
        { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
      )
      assert.deepEqual(
        (
          await testDb.pool.query(
            'SELECT id, status, attempts, last_error FROM webhook_deliveries ORDER BY id',
          )
        ).rows,
        expected,
      )
      const current = queries.find((query) => /UPDATE\s+webhook_deliveries/i.test(query.sql))
      assert.ok(current, 'production handler must issue reconciliation SQL')
      await testDb.pool.query(
        `UPDATE webhook_deliveries SET status='pending',
          attempts=right(id::text, 12)::integer % 4, last_error=NULL`,
      )
      await testDb.pool.query('ANALYZE webhook_deliveries')
      const baseline = baselineReconciliation.compile(db)
      const materializedHistory = /WITH\s+job_history\s+AS\s+MATERIALIZED/i
      assert.match(current.sql, materializedHistory)
      // Second and final alternative shape: permit the same job-history CTE to inline.
      const inline: Query = {
        sql: current.sql.replace(materializedHistory, 'WITH job_history AS NOT MATERIALIZED'),
        parameters: current.parameters,
      }
      const variants = mode === 'compare' ? ['baseline', 'current', 'inline'] : [mode]
      const variantQueries: Record<string, Query> = { baseline, current, inline }
      const plans: Record<string, ExplainResult[]> = { baseline: [], current: [], inline: [] }
      const wallTimes: Record<string, number[]> = { baseline: [], current: [], inline: [] }
      const client = await testDb.pool.connect()
      try {
        // One warmup per variant; alternate sample ordering to reduce cache/order bias.
        for (let sample = -1; sample < samples; sample++) {
          for (const variant of sample % 2 === 0 ? [...variants].reverse() : variants) {
            const query = variantQueries[variant]
            assert.ok(query)
            await client.query('BEGIN')
            try {
              await client.query("SET LOCAL work_mem = '4MB'")
              await client.query("SET LOCAL statement_timeout = '30s'")
              const started = performance.now()
              const explained = await client.query(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
                [...query.parameters],
              )
              const wallMs = performance.now() - started
              assert.deepEqual(
                (
                  await client.query(
                    'SELECT id, status, attempts, last_error FROM webhook_deliveries ORDER BY id',
                  )
                ).rows,
                expected,
              )
              const plan = (explained.rows[0]?.['QUERY PLAN'] as ExplainResult[] | undefined)?.[0]
              assert.ok(plan)
              if (sample >= 0) {
                plans[variant]?.push(plan)
                wallTimes[variant]?.push(wallMs)
              }
            } finally {
              // EXPLAIN ANALYZE executes the UPDATE. Always restore the same input fixture.
              await client.query('ROLLBACK')
            }
          }
        }
      } finally {
        client.release()
      }
      const comparisons = variants.map((variant) => {
        const variantPlans = plans[variant] ?? []
        return {
          variant,
          medianExecutionMs: median(variantPlans.map((plan) => plan['Execution Time'])),
          medianWallMs: median(wallTimes[variant] ?? []),
          samples: variantPlans.map((plan, index) =>
            summarize(plan, (wallTimes[variant] ?? [])[index] as number),
          ),
        }
      })
      results.push({
        jobsCount,
        layout,
        pendingCount,
        processedRows,
        database: databaseName,
        environment: { ...environment, benchmark_work_mem: '4MB' },
        distribution,
        comparisons,
        queries: variantQueries,
        plans,
        wallTimes,
      })
      console.log(JSON.stringify({ jobsCount, layout, pendingCount, processedRows, comparisons }))
      if (output) await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
    } finally {
      try {
        await jobs.stop()
      } finally {
        await testDb.drop()
        console.log(JSON.stringify({ droppedDatabase: databaseName }))
      }
    }
  }
}
