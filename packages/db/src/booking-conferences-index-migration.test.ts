import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0032_booking_conferences_booking_id_index.sql'
const index = 'booking_conferences_booking_id'
const organizationId = '00000000-0000-4000-8000-000000000001'
const organizerId = '00000000-0000-4000-8000-000000000002'
const bookingId = (n: number) => `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`

async function predecessorDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-conference-index-predecessor-'))
  for (const file of await readdir(migrationsDir)) {
    if (file.endsWith('.sql') && file < migration) {
      await copyFile(join(migrationsDir, file), join(directory, file))
    }
  }
  return directory
}

async function seed(pool: pg.Pool, count = 4) {
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
     VALUES ($1,'Synthetic conference team','conference-index-team','2026-01-01T00:00Z')`,
    [organizationId],
  )
  await pool.query(
    `INSERT INTO bookings (id,organization_id,title,start_at,end_at,status,cancelled_at,
       cancel_reason,location,source,created_at,updated_at)
     SELECT ('00000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid,$1,
       'Synthetic conference ' || n,
       '2026-11-01T09:00Z'::timestamptz + n * interval '1 hour',
       '2026-11-01T09:30Z'::timestamptz + n * interval '1 hour',
       CASE WHEN n = 1 THEN 'cancelled' ELSE 'confirmed' END,
       CASE WHEN n = 1 THEN '2026-10-01T01:02:03.123456Z'::timestamptz END,
       CASE WHEN n = 1 THEN 'Rescheduled synthetic meeting' END,
       '{"kind":"google_meet"}'::jsonb,'api',
       '2026-09-01T01:02:03.123456Z','2026-10-01T01:02:03.654321Z'
     FROM generate_series(1,$2::int) AS n`,
    [organizationId, count],
  )
  await pool.query(
    `INSERT INTO booking_conferences (root_booking_id,organization_id,booking_id,
       organizer_user_id,revision,applied_revision,state,request_id,create_started,
       external_event_id,attempts,next_attempt_at,updated_at,
       invitation_organizer_name,invitation_organizer_email)
     SELECT id,organization_id,id,$1,2,2,'ready',
       ('00000000-0000-4000-8002-' || lpad(n::text,12,'0'))::uuid,true,
       'synthetic_event_' || n,1,'2026-10-01T01:02:03.123456Z',
       '2026-10-01T01:02:03.654321Z','Synthetic organizer','organizer@example.test'
     FROM bookings JOIN generate_series(1,$2::int) AS n
       ON id = ('00000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid`,
    [organizerId, count],
  )
}

// JSON stays in PostgreSQL so microsecond timestamps and every persisted value survive.
// Tuple identities also prove the index migration did not rewrite any data rows.
async function records(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT 'bookings' AS relation,id::text,to_jsonb(b)::text AS data,xmin::text,ctid::text
       FROM bookings b
       UNION ALL
       SELECT 'booking_conferences',root_booking_id::text,to_jsonb(c)::text,xmin::text,ctid::text
       FROM booking_conferences c ORDER BY relation,id`,
    )
  ).rows
}

async function schema(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT 'column' AS kind,table_name || '.' || column_name AS name,
         jsonb_build_object('position',ordinal_position,'type',udt_name,
           'nullable',is_nullable,'default',column_default)::text AS definition
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('bookings','booking_conferences')
       UNION ALL
       SELECT 'constraint',conrelid::regclass::text || '.' || conname,pg_get_constraintdef(oid)
       FROM pg_constraint WHERE conrelid IN ('bookings'::regclass,'booking_conferences'::regclass)
       UNION ALL
       SELECT 'index',indexname,indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('bookings','booking_conferences')
       ORDER BY kind,name`,
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
  Plans?: Plan[]
}

function planNodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans?.flatMap(planNodes) ?? [])]
}

async function explain(pool: pg.Pool) {
  return (
    await pool.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT c.*,b.status,b.cancelled_at,b.cancel_reason,b.location
       FROM booking_conferences c JOIN bookings b ON b.id = c.booking_id
       WHERE c.booking_id = $1`,
      [bookingId(50_000)],
    )
  ).rows[0]?.['QUERY PLAN'][0].Plan as Plan
}

describe.skipIf(!serverUrl)('booking conference booking index migration', () => {
  it('preserves predecessor records and target semantics, matches fresh schema and reruns without writes', async () => {
    const predecessor = await predecessorDirectory()
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0031_discard_sign_in_id_tokens.sql' })
      expect(await targetIndex(pool)).toEqual([])
      await seed(pool)
      // Distinct roots may share a current pointer in the predecessor schema. The new
      // performance index must not reject or silently discard those existing rows.
      await pool.query(
        'UPDATE booking_conferences SET booking_id = $1 WHERE root_booking_id = $2',
        [bookingId(4), bookingId(1)],
      )
      const before = await records(pool)
      const schemaBefore = await schema(pool)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      await expect(runMigrations(pool, predecessor)).resolves.toEqual([migration])
      expect(await records(pool)).toEqual(before)
      expect(await targetIndex(pool)).toEqual([
        {
          indisunique: false,
          indisvalid: true,
          indisready: true,
          amname: 'btree',
          column_name: 'booking_id',
          indnkeyatts: 1,
          predicate: null,
        },
      ])
      const upgradedSchema = await schema(pool)
      expect(upgradedSchema.filter((row) => row.name !== index)).toEqual(schemaBefore)
      const indexIdentity = 'SELECT oid,relfilenode FROM pg_class WHERE oid = to_regclass($1)'
      const beforeRerun = (await pool.query(indexIdentity, [index])).rows
      expect(await runMigrations(pool, predecessor)).toEqual([])
      // The runner skips recorded files; raw SQL repetition separately proves IF NOT EXISTS.
      await expect(
        pool.query(await readFile(join(predecessor, migration), 'utf8')),
      ).resolves.toMatchObject({ command: 'CREATE' })
      expect((await pool.query(indexIdentity, [index])).rows).toEqual(beforeRerun)
      expect(await records(pool)).toEqual(before)
      expect(await schema(pool)).toEqual(upgradedSchema)

      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await schema(fresh.pool)).toEqual(upgradedSchema)
      const ledger = 'SELECT name,checksum FROM schema_migrations ORDER BY name'
      expect((await fresh.pool.query(ledger)).rows).toEqual((await pool.query(ledger)).rows)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  })

  it('uses the new index for booking hydration with 100,000 conference rows', async () => {
    const predecessor = await predecessorDirectory()
    let database: TestDatabase | undefined
    try {
      database = await createTestDatabase(serverUrl as string, predecessor)
      const pool = database.pool
      await seed(pool, 100_000)
      await pool.query('ANALYZE bookings; ANALYZE booking_conferences')
      const before = planNodes(await explain(pool))
      expect(
        before.some(
          (node) =>
            node['Relation Name'] === 'booking_conferences' && node['Node Type'] === 'Seq Scan',
        ),
      ).toBe(true)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      const after = planNodes(await explain(pool))
      expect(
        after.some((node) => node['Index Name'] === index && node['Node Type'] === 'Index Scan'),
      ).toBe(true)
      expect(
        after.some(
          (node) =>
            node['Relation Name'] === 'booking_conferences' && node['Node Type'] === 'Seq Scan',
        ),
      ).toBe(false)
    } finally {
      await database?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  }, 30_000)
})
