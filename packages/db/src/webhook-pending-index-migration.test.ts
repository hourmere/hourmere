import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0034_webhook_pending_delivery_index.sql'
const index = 'webhook_deliveries_pending'
const organizationId = '00000000-0000-4000-8000-000000000001'
const webhookId = '00000000-0000-4000-8000-000000000002'

async function predecessorDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-webhook-index-predecessor-'))
  for (const file of await readdir(migrationsDir)) {
    if (file.endsWith('.sql') && file < migration) {
      await copyFile(join(migrationsDir, file), join(directory, file))
    }
  }
  return directory
}

async function seed(pool: pg.Pool, terminalCount = 4, pendingCount = 4) {
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
     VALUES ($1,'Synthetic webhook team','webhook-index-team','2026-01-01T00:00Z')`,
    [organizationId],
  )
  await pool.query(
    `INSERT INTO webhooks (id,organization_id,url,events,secret_ciphertext,created_at,updated_at)
     VALUES ($1,$2,'https://hooks.example.test/synthetic',
       ARRAY['booking.created','booking.rescheduled'],decode('0011223344556677','hex'),
       '2026-09-01T01:02:03.123456Z','2026-10-01T01:02:03.654321Z')`,
    [webhookId, organizationId],
  )
  await pool.query(
    `WITH synthetic_bookings AS (
       INSERT INTO bookings (id,organization_id,title,start_at,end_at,source,created_at)
       SELECT ('00000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid,$1,
         'Synthetic webhook ' || n,'2026-11-01T09:00Z'::timestamptz + n * interval '1 minute',
         '2026-11-01T09:30Z'::timestamptz + n * interval '1 minute','api',
         '2026-10-01T01:02:03.123456Z'
       FROM generate_series(1,$3::int + $4::int) AS n RETURNING id
     )
     INSERT INTO webhook_deliveries (id,webhook_id,organization_id,booking_id,event_id,
       event_type,payload,status,attempts,http_status,last_error,created_at,last_attempt_at,delivered_at)
     SELECT ('00000000-0000-4000-8002-' || lpad(n::text,12,'0'))::uuid,$2,$1,id,
       ('00000000-0000-4000-8003-' || lpad(n::text,12,'0'))::uuid,'booking.created',
       jsonb_build_object('id',id,'type','booking.created')::text,
       CASE WHEN n > $3::int THEN 'pending'
         WHEN n % 3 = 0 THEN 'delivered' WHEN n % 3 = 1 THEN 'failed' ELSE 'skipped' END,
       CASE WHEN n > $3::int THEN 2 WHEN n % 3 = 1 THEN 13 ELSE 1 END,
       CASE WHEN n <= $3::int AND n % 3 = 0 THEN 204 END,
       CASE WHEN n > $3::int THEN CASE WHEN n % 2 = 0 THEN 'interrupted' END
         WHEN n % 3 = 1 THEN 'secret_unavailable' WHEN n % 3 = 2 THEN 'disabled' END,
       '2026-10-01T01:02:03.123456Z','2026-10-01T01:02:03.654321Z',
       CASE WHEN n <= $3::int AND n % 3 = 0 THEN '2026-10-01T01:02:03.654321Z'::timestamptz END
     FROM synthetic_bookings JOIN generate_series(1,$3::int + $4::int) AS n
       ON id = ('00000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid`,
    [organizationId, webhookId, terminalCount, pendingCount],
  )
}

// PostgreSQL JSON preserves microsecond timestamps; tuple identities detect row rewrites.
async function records(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT 'organization' AS relation,id::text,to_jsonb(o)::text AS data,xmin::text,ctid::text
       FROM auth.organization o
       UNION ALL
       SELECT 'bookings',id::text,to_jsonb(b)::text,xmin::text,ctid::text FROM bookings b
       UNION ALL
       SELECT 'webhooks',id::text,to_jsonb(w)::text,xmin::text,ctid::text FROM webhooks w
       UNION ALL
       SELECT 'webhook_deliveries',id::text,to_jsonb(d)::text,xmin::text,ctid::text
       FROM webhook_deliveries d ORDER BY relation,id`,
    )
  ).rows
}

async function targetIndex(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT i.indisunique,i.indisvalid,i.indisready,am.amname,
         pg_get_indexdef(i.indexrelid,1,true) AS column_name,
         i.indnkeyatts,pg_get_expr(i.indpred,i.indrelid) AS predicate
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am am ON am.oid = c.relam
       WHERE i.indexrelid = to_regclass($1)`,
      [index],
    )
  ).rows
}

interface Plan {
  'Node Type': string
  'Index Name'?: string
  'Relation Name'?: string
  'Actual Rows': number
  'Rows Removed by Filter'?: number
  Plans?: Plan[]
}

function planNodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans?.flatMap(planNodes) ?? [])]
}

async function explain(pool: pg.Pool) {
  // This is reconciliation's ordered/locking delivery scan. The pg-boss anti-join
  // and update operate on its output; no production query filters any other status.
  return (
    await pool.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT id FROM webhook_deliveries WHERE status = 'pending'
       ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED`,
    )
  ).rows[0]?.['QUERY PLAN'][0].Plan as Plan
}

describe.skipIf(!serverUrl)('webhook pending delivery index migration', () => {
  it('preserves populated predecessor tuples, matches fresh schema and reruns without writes', async () => {
    const predecessor = await predecessorDirectory()
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0033_conference_authorization_time.sql' })
      expect(await targetIndex(pool)).toEqual([])
      await seed(pool)
      const before = await records(pool)
      const schemaBefore = await snapshotSchema(pool)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      expect(await targetIndex(pool)).toEqual([
        {
          indisunique: false,
          indisvalid: true,
          indisready: true,
          amname: 'btree',
          column_name: 'id',
          indnkeyatts: 1,
          predicate: "(status = 'pending'::text)",
        },
      ])
      const upgradedSchema = await snapshotSchema(pool)
      expect({
        ...upgradedSchema,
        indexes: upgradedSchema.indexes.filter((row) => row.name !== index),
      }).toEqual(schemaBefore)
      const identity = 'SELECT oid,relfilenode FROM pg_class WHERE oid = to_regclass($1)'
      const beforeRerun = (await pool.query(identity, [index])).rows
      expect(await runMigrations(pool, predecessor)).toEqual([])
      // The ledger skips applied files; also repeat SQL to prove IF NOT EXISTS.
      await expect(
        pool.query(await readFile(join(predecessor, migration), 'utf8')),
      ).resolves.toMatchObject({ command: 'CREATE' })
      expect((await pool.query(identity, [index])).rows).toEqual(beforeRerun)
      expect(await records(pool)).toEqual(before)
      expect(await snapshotSchema(pool)).toEqual(upgradedSchema)

      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(upgradedSchema)
      const ledger = 'SELECT name,checksum FROM schema_migrations ORDER BY name'
      expect((await fresh.pool.query(ledger)).rows).toEqual((await pool.query(ledger)).rows)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  })

  it('scans only pending rows in ID order behind 100,000 terminal deliveries', async () => {
    const predecessor = await predecessorDirectory()
    let database: TestDatabase | undefined
    try {
      database = await createTestDatabase(serverUrl as string, predecessor)
      const pool = database.pool
      // Older terminal IDs precede all pending rows, as they do in retained history.
      await seed(pool, 100_000, 32)
      await pool.query('ANALYZE webhook_deliveries')
      const before = planNodes(await explain(pool))
      expect(
        before.some(
          (node) =>
            node['Relation Name'] === 'webhook_deliveries' &&
            (node['Rows Removed by Filter'] ?? 0) === 100_000,
        ),
      ).toBe(true)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      const after = planNodes(await explain(pool))
      expect(
        after.some(
          (node) =>
            node['Node Type'] === 'Index Scan' &&
            node['Index Name'] === index &&
            node['Actual Rows'] === 32 &&
            (node['Rows Removed by Filter'] ?? 0) === 0,
        ),
      ).toBe(true)
      expect(after.some((node) => ['Seq Scan', 'Sort'].includes(node['Node Type']))).toBe(false)
    } finally {
      await database?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  }, 30_000)
})
