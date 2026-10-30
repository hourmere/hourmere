import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0044_invitation_delivery_attempt_time.sql'
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function tables(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

// Explicit predecessor columns and server-side JSON retain microseconds and prove
// that adding the nullable column does not rewrite any retained row or timestamp.
async function records(pool: pg.Pool, inventory: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of inventory)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}

async function files() {
  const result = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= migration)
    .sort()
  expect(result.at(-1)).toBe(migration)
  return result
}

async function invitation(pool: pg.Pool) {
  const userId = randomUUID()
  const organizationId = randomUUID()
  const invitationId = randomUUID()
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,'Attempt inviter',$2,true)`,
    [userId, `attempt-inviter-${userId}@example.test`],
  )
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
      VALUES ($1,'Attempt time team',$2,clock_timestamp())`,
    [organizationId, `attempt-time-${organizationId}`],
  )
  await pool.query(
    `INSERT INTO auth.invitation
      (id,"organizationId",email,role,status,"expiresAt","inviterId")
      VALUES ($1,$2,$3,'member','pending',clock_timestamp()+interval '2 days',$4)`,
    [invitationId, organizationId, `attempt-invitee-${invitationId}@example.test`, userId],
  )
  return invitationId
}

async function lastAttempt(pool: pg.Pool, id: string) {
  return (
    await pool.query<{ last_attempt_at: string | null }>(
      'SELECT last_attempt_at::text FROM invitation_deliveries WHERE invitation_id=$1',
      [id],
    )
  ).rows[0]?.last_attempt_at
}

async function verifyStamp(pool: pg.Pool) {
  const id = await invitation(pool)
  const before = (await pool.query<{ now: string }>('SELECT clock_timestamp()::text AS now'))
    .rows[0]?.now
  expect(
    (
      await pool.query(
        `INSERT INTO invitation_deliveries
          (invitation_id,state,attempts,last_attempt_at,updated_at)
          VALUES ($1,'queued',1,'2001-01-01T00:00:00Z','2099-01-01T00:00:00Z')
          RETURNING last_attempt_at >= $2::timestamptz
            AND last_attempt_at <= clock_timestamp() AS database_time`,
        [id, before],
      )
    ).rows,
  ).toEqual([{ database_time: true }])
  const prior = await lastAttempt(pool, id)
  expect(
    (
      await pool.query(
        `UPDATE invitation_deliveries SET attempts=2,last_attempt_at='2001-01-01T00:00:00Z',
          updated_at='2099-01-01T00:00:00Z' WHERE invitation_id=$1
          RETURNING last_attempt_at > $2::timestamptz
            AND last_attempt_at <= clock_timestamp() AS increased_attempt`,
        [id, prior],
      )
    ).rows,
  ).toEqual([{ increased_attempt: true }])
}

async function verifyPreserve(pool: pg.Pool) {
  const id = await invitation(pool)
  await pool.query(
    `INSERT INTO invitation_deliveries (invitation_id,state,attempts) VALUES ($1,'queued',1)`,
    [id],
  )
  const recorded = await lastAttempt(pool, id)
  expect(recorded).toBeTypeOf('string')
  for (const changes of [
    "updated_at='2099-01-01T00:00:00Z',due_at='2099-01-02T00:00:00Z'",
    "state='failed',last_error_code='smtp_temporary',last_attempt_at='2001-01-01T00:00:00Z'",
    "state='smtp_accepted',smtp_accepted_at=clock_timestamp(),last_error_code=NULL,last_attempt_at=NULL",
  ]) {
    await pool.query(`UPDATE invitation_deliveries SET ${changes} WHERE invitation_id=$1`, [id])
    expect(await lastAttempt(pool, id)).toBe(recorded)
  }
  // A caller cannot fabricate history for a legacy row with no known timestamp.
  const legacy = await invitation(pool)
  await pool.query(
    `INSERT INTO invitation_deliveries (invitation_id,state,attempts) VALUES ($1,'queued',0)`,
    [legacy],
  )
  await pool.query(
    `UPDATE invitation_deliveries SET last_attempt_at='2001-01-01T00:00:00Z' WHERE invitation_id=$1`,
    [legacy],
  )
  expect(await lastAttempt(pool, legacy)).toBeNull()
}

async function verifyReset(pool: pg.Pool) {
  const id = await invitation(pool)
  await pool.query(
    `INSERT INTO invitation_deliveries (invitation_id,state,attempts) VALUES ($1,'queued',2)`,
    [id],
  )
  expect(await lastAttempt(pool, id)).toBeTypeOf('string')
  await pool.query(
    `UPDATE invitation_deliveries SET generation=2,attempts=0,
      last_attempt_at='2099-01-01T00:00:00Z' WHERE invitation_id=$1`,
    [id],
  )
  expect(await lastAttempt(pool, id)).toBeNull()
  await pool.query('UPDATE invitation_deliveries SET attempts=1 WHERE invitation_id=$1', [id])
  const recorded = await lastAttempt(pool, id)
  expect(recorded).toBeTypeOf('string')
  await pool.query('UPDATE invitation_deliveries SET attempts=0 WHERE invitation_id=$1', [id])
  expect(await lastAttempt(pool, id)).toBeNull()
  await pool.query('UPDATE invitation_deliveries SET attempts=1 WHERE invitation_id=$1', [id])
  const previousGeneration = await lastAttempt(pool, id)
  expect(
    (
      await pool.query(
        `UPDATE invitation_deliveries SET generation=3,attempts=1,
          last_attempt_at='2001-01-01T00:00:00Z' WHERE invitation_id=$1
          RETURNING last_attempt_at > $2::timestamptz
            AND last_attempt_at <= clock_timestamp() AS new_generation_attempt`,
        [id, previousGeneration],
      )
    ).rows,
  ).toEqual([{ new_generation_attempt: true }])
  const zero = await invitation(pool)
  await pool.query(
    `INSERT INTO invitation_deliveries (invitation_id,state,attempts,last_attempt_at)
      VALUES ($1,'queued',0,'2099-01-01T00:00:00Z')`,
    [zero],
  )
  expect(await lastAttempt(pool, zero)).toBeNull()
}

async function verifyColumnOwnership(pool: pg.Pool) {
  const id = await invitation(pool)
  await pool.query(
    `INSERT INTO invitation_deliveries (invitation_id,state,attempts,last_attempt_at)
      VALUES ($1,'queued',0,'2001-01-01T00:00:00Z')`,
    [id],
  )
  expect(await lastAttempt(pool, id)).toBeNull()
  await pool.query('UPDATE invitation_deliveries SET attempts=1 WHERE invitation_id=$1', [id])
  const recorded = await lastAttempt(pool, id)
  expect(recorded).toBeTypeOf('string')
  // A direct column write cannot clear, backdate or move a recorded attempt forward.
  for (const supplied of [null, '2001-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    await pool.query('UPDATE invitation_deliveries SET last_attempt_at=$2 WHERE invitation_id=$1', [
      id,
      supplied,
    ])
    expect(await lastAttempt(pool, id)).toBe(recorded)
  }
  await pool.query(
    `UPDATE invitation_deliveries SET generation=2,attempts=0,
      last_attempt_at='2099-01-01T00:00:00Z' WHERE invitation_id=$1`,
    [id],
  )
  expect(await lastAttempt(pool, id)).toBeNull()
  await pool.query(
    `UPDATE invitation_deliveries SET last_attempt_at='2099-01-01T00:00:00Z'
      WHERE invitation_id=$1`,
    [id],
  )
  expect(await lastAttempt(pool, id)).toBeNull()
}

async function withSourceCopy(
  replace: (source: string) => string,
  verify: (pool: pg.Pool) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-attempt-time-source-'))
  let owned: TestDatabase | undefined
  try {
    for (const file of await files())
      await copyFile(join(migrationsDir, file), join(directory, file))
    const source = await readFile(join(directory, migration), 'utf8')
    await writeFile(join(directory, migration), replace(source))
    owned = await createTestDatabase(serverUrl as string, directory, { tag: 'attempt_mutant' })
    await verify(owned.pool)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  } finally {
    try {
      await owned?.drop()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe.skipIf(!serverUrl)('invitation delivery attempt time migration', () => {
  it('preserves populated predecessor values without inventing history, matches fresh schema and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-attempt-time-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const initial = (await files()).filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor, { tag: 'attempt_old' })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`INSERT INTO auth.invitation
        ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        SELECT "organizationId",'attempt-migration-'||fixture.name||'@example.test','member',
          fixture.status,fixture.expires,'2026-01-02T03:04:05.123456Z',"inviterId"
        FROM (SELECT * FROM auth.invitation ORDER BY id LIMIT 1) original
        CROSS JOIN (VALUES
          ('queued','pending',now()+interval '2 days'),
          ('sending','pending',now()+interval '2 days'),
          ('accepted','accepted',now()+interval '2 days'),
          ('failed','pending',now()+interval '2 days'),
          ('skipped','canceled',now()+interval '2 days'),
          ('expired','pending',now()-interval '2 days')
        ) AS fixture(name,status,expires);
        INSERT INTO invitation_deliveries
          (invitation_id,generation,state,attempts,due_at,lease_id,lease_until,last_job_id,
           resend_request_id,smtp_accepted_at,last_error_code,created_at,updated_at,
           generation_started_at,expiry_duration_ms)
        SELECT id,7,fixture.state,fixture.attempts,'2026-01-03T04:05:06.654321Z',
          CASE WHEN fixture.state='sending' THEN gen_random_uuid() END,
          CASE WHEN fixture.state='sending' THEN '2099-01-01T00:00:00Z'::timestamptz END,
          gen_random_uuid(),gen_random_uuid(),
          CASE WHEN fixture.state='smtp_accepted' THEN '2026-01-04T05:06:07.123456Z'::timestamptz END,
          fixture.error,'2026-01-02T03:04:05.123456Z','2026-01-04T05:06:07.123456Z',
          '2026-01-03T04:05:06.654321Z',259200000
        FROM auth.invitation JOIN (VALUES
          ('queued','queued',0::smallint,NULL),
          ('sending','sending',2::smallint,NULL),
          ('accepted','smtp_accepted',1::smallint,NULL),
          ('failed','failed',4::smallint,'smtp_permanent'),
          ('skipped','skipped',0::smallint,'invitation_ineligible'),
          ('expired','failed',2::smallint,'smtp_temporary')
        ) AS fixture(name,state,attempts,error)
          ON email='attempt-migration-'||fixture.name||'@example.test';
        INSERT INTO invitation_email_requests (user_id,organization_id,recipient_hash,requested_at)
          SELECT "inviterId","organizationId",sha256(convert_to('synthetic-attempt-recipient','UTF8')),
            '2026-01-04T05:06:07.654321Z' FROM auth.invitation ORDER BY id LIMIT 1;`)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.invitation_deliveries']).toHaveLength(7)
      expect(before['public.invitation_email_requests']).toHaveLength(1)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0043_invitation_mail_limits.sql' })

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (
          await pool.query(
            'SELECT last_attempt_at FROM invitation_deliveries ORDER BY invitation_id',
          )
        ).rows,
      ).toEqual(Array.from({ length: 7 }, () => ({ last_attempt_at: null })))
      expect(
        (
          await pool.query(`SELECT is_nullable,column_default,data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='invitation_deliveries'
            AND column_name='last_attempt_at'`)
        ).rows,
      ).toEqual([
        { is_nullable: 'YES', column_default: null, data_type: 'timestamp with time zone' },
      ])
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor, { tag: 'attempt_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect((await fresh.pool.query('SELECT * FROM invitation_deliveries')).rows).toEqual([])
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const acknowledged = (await pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(acknowledged.map(({ name, checksum }) => ({ name, checksum })))
      const latest = await tables(pool)
      const latestRecords = await records(pool, latest)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, latest)).toEqual(latestRecords)
      expect((await pool.query(ledger)).rows).toEqual(acknowledged)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
      // Existing positive counters still have unknown history after metadata updates.
      await pool.query(`UPDATE invitation_deliveries SET updated_at=updated_at,
        last_attempt_at='2099-01-01T00:00:00Z' WHERE attempts>0`)
      expect(
        (
          await pool.query(
            'SELECT last_attempt_at FROM invitation_deliveries ORDER BY invitation_id',
          )
        ).rows,
      ).toEqual(Array.from({ length: 7 }, () => ({ last_attempt_at: null })))
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('records database-clock attempts despite supplied application times, preserves outcomes and resets new generations', async () => {
    await withSourceCopy(
      (source) => source,
      async (pool) => {
        await verifyStamp(pool)
        await verifyPreserve(pool)
        await verifyReset(pool)
      },
    )
  }, 30_000)

  it('overwrites direct last_attempt_at writes on insert, update and generation reset', async () => {
    await withSourceCopy((source) => source, verifyColumnOwnership)
  }, 30_000)

  it.each([
    [
      'attempt stamp',
      'NEW.last_attempt_at := clock_timestamp();',
      'NEW.last_attempt_at := NULL;',
      verifyStamp,
    ],
    [
      'metadata preservation',
      'NEW.last_attempt_at := OLD.last_attempt_at;',
      'NEW.last_attempt_at := NULL;',
      verifyPreserve,
    ],
    [
      'generation reset',
      'ELSIF NEW.attempts = 0 THEN\n    NEW.last_attempt_at := NULL;',
      'ELSIF NEW.attempts = 0 THEN\n    NEW.last_attempt_at := OLD.last_attempt_at;',
      verifyReset,
    ],
    [
      'direct timestamp write ownership',
      'NEW.last_attempt_at := OLD.last_attempt_at;',
      'NULL;',
      verifyColumnOwnership,
    ],
  ] as const)(
    'detects a removed %s branch with the same real-database assertions',
    async (_name, before, after, verify) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      expect(source.includes(before), 'mutation matches the published migration source').toBe(true)
      await expect(
        withSourceCopy((copy) => copy.replaceAll(before, after), verify),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
    30_000,
  )
})
