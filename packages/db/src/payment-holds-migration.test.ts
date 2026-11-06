import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { groupFixture, occupiedSlot } from './group-seats-fixtures.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0062_payment_holds.sql'
const predecessor = '0061_group_slot_resources.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function inventory(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`SELECT c.table_schema AS schema,c.table_name AS name,
      array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
      FROM information_schema.columns c JOIN information_schema.tables t
        USING (table_schema,table_name)
      WHERE c.table_schema IN ('auth','public') AND t.table_type='BASE TABLE'
        AND c.table_name <> 'schema_migrations'
      GROUP BY c.table_schema,c.table_name ORDER BY c.table_schema,c.table_name`)
  ).rows
}

async function records(pool: pg.Pool, tables: Table[]) {
  const result: Record<string, unknown[]> = {}
  for (const table of tables) {
    const columns = table.columns.map((column) => `t.${quote(column)}`).join(',')
    result[`${table.schema}.${table.name}`] = (
      await pool.query(`SELECT row_to_json(saved)::text AS value,xmin::text,ctid::text
        FROM ${quote(table.schema)}.${quote(table.name)} t,
          LATERAL (SELECT ${columns}) saved
        ORDER BY row_to_json(saved)::text COLLATE "C"`)
    ).rows
  }
  return result
}

async function seedPredecessor(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= predecessor)
    .sort()
  expect(files.at(-1)).toBe(predecessor)
  const earlyDirectory = await mkdtemp(join(tmpdir(), 'hourmere-payment-early-'))
  let owned: TestDatabase | undefined
  try {
    for (const file of files) {
      await copyFile(join(migrationsDir, file), join(directory, file))
      if (file.slice(0, 4) <= '0012')
        await copyFile(join(migrationsDir, file), join(earlyDirectory, file))
    }
    owned = await createTestDatabase(serverUrl as string, earlyDirectory)
    await seedEarly(owned.pool)
    await runMigrations(owned.pool, directory)
    await seedLater(owned.pool)
    // Exercise 0060's local-only busy booking and immutable mapping, too.
    await owned.pool.query(`WITH imported AS (
      INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,
        import_questions,notification_snapshot)
      SELECT organization_id,id,'2040-06-01T10:00Z','2040-06-01T10:30Z',
        'Historical imported booking','import','[]',
        '{"version":1,"executionMode":"configurable","notifications":{"reminders":[],"followUps":[]}}' FROM event_types ORDER BY id LIMIT 1
      RETURNING id
    ), source AS (
      INSERT INTO import_sources (schema_fingerprint,source_version)
      VALUES (repeat('a',64),'synthetic-predecessor') RETURNING id
    ) INSERT INTO import_items (source_id,entity_kind,source_primary_key,target_id,
      source_fingerprint,target_fingerprint,policy,contract_version)
      SELECT source.id,'booking','101',imported.id,repeat('b',64),repeat('c',64),
        'local_only_read_only',1 FROM source,imported`)
    const group = await groupFixture(owned.pool)
    const { slot } = await occupiedSlot(group)
    await owned.pool.query(
      `WITH message AS (
      INSERT INTO group_slot_host_messages (group_slot_id,kind,rule_id,revision,due_at,expires_at,
        state,attempts,next_attempt_at)
      VALUES ($1,'calendar','calendar',2,'2030-01-01T01:02:03.123456Z',
        '2030-01-02T01:02:03.654321Z','sent',1,'2030-01-01T01:02:03.123456Z') RETURNING id
    ) INSERT INTO group_slot_host_mail_receipts (message_id,revision,outcome,created_at)
      SELECT id,2,'sent','2030-01-01T01:02:04.123456Z' FROM message`,
      [slot],
    )
    await owned.pool.query(
      `INSERT INTO group_slot_conferences
      (group_slot_id,organization_id,organizer_user_id,provider,invitation_organizer_name,
        invitation_organizer_email,state,attempts,next_attempt_at,updated_at)
      VALUES ($1,$2,$3,'google_meet','Shared organizer','shared@example.test','pending',1,
        '2030-01-01T01:02:03.123456Z','2030-01-01T01:02:03.654321Z')`,
      [slot, group.organization, group.host],
    )
    return owned
  } catch (error) {
    await owned?.drop()
    throw error
  } finally {
    await rm(earlyDirectory, { recursive: true, force: true })
  }
}

interface HoldFixture {
  pool: pg.Pool
  booking: string
  host: string
}

async function holdFixture(
  pool: pg.Pool,
  elapsed = false,
  deadline: string | null = null,
): Promise<HoldFixture> {
  const host = (
    await pool.query<{ id: string }>(`INSERT INTO auth."user" (name,email,"emailVerified")
    VALUES ('Hold host','hold-host@example.test',true) RETURNING id`)
  ).rows[0]?.id as string
  const organization = (
    await pool.query<{ id: string }>(`INSERT INTO auth.organization (name,slug,"createdAt")
    VALUES ('Hold team','hold-team',now()) RETURNING id`)
  ).rows[0]?.id as string
  const event = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types
    (organization_id,slug,title,duration_minutes) VALUES ($1,'hold','Hold',30) RETURNING id`,
      [organization],
    )
  ).rows[0]?.id as string
  const booking = (
    await pool.query<{ id: string }>(
      `INSERT INTO bookings
    (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at)
    VALUES ($1,$2,'2040-07-01T10:00Z','2040-07-01T10:30Z','Held booking','web',
      'pending_payment',COALESCE($4::timestamptz,clock_timestamp() + $3::interval)) RETURNING id`,
      [organization, event, elapsed ? '-1 minute' : '30 minutes', deadline],
    )
  ).rows[0]?.id as string
  await pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [booking, host])
  return { pool, booking, host }
}

interface Guard {
  name: string
  elapsed?: boolean
  deadline?: string
  prepare?: (source: string) => string
  mutate: (source: string) => string
  check: (fixture: HoldFixture) => Promise<void>
}

const guards: Guard[] = [
  {
    name: 'hold deadline cannot exceed meeting start',
    mutate: (source) => source.replace('payment_hold_expires_at <= start_at AND ', ''),
    check: async ({ pool, booking }) => {
      await expect(
        pool.query(
          `INSERT INTO bookings
        (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at)
        SELECT organization_id,event_type_id,start_at,end_at,title,source,'pending_payment',start_at+interval '1 microsecond'
        FROM bookings WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_hold_shape' })
      await expect(
        pool.query(
          `INSERT INTO bookings
        (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at)
        SELECT organization_id,event_type_id,start_at,end_at,title,source,'pending_payment',start_at
        FROM bookings WHERE id=$1`,
          [booking],
        ),
      ).resolves.toMatchObject({ rowCount: 1 })
    },
  },
  {
    name: 'paid confirmed insert requires payment reference',
    mutate: (source) =>
      source.replace(
        "(status <> 'confirmed' OR payment_hold_expires_at IS NULL OR payment_reference IS NOT NULL)",
        'true',
      ),
    check: async ({ pool, booking }) => {
      await expect(
        pool.query(
          `INSERT INTO bookings
        (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at)
        SELECT organization_id,event_type_id,start_at,end_at,title,source,'confirmed',payment_hold_expires_at
        FROM bookings WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_hold_shape' })
    },
  },
  {
    name: 'refund obligation only on released holds',
    mutate: (source) =>
      source.replace(
        "payment_reference IS NOT NULL AND status IN ('expired','cancelled')",
        'payment_reference IS NOT NULL',
      ),
    check: async ({ pool, booking }) => {
      await pool.query("UPDATE bookings SET payment_reference='pi_synthetic_refund' WHERE id=$1", [
        booking,
      ])
      await expect(
        pool.query('UPDATE bookings SET payment_refund_required=true WHERE id=$1', [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_hold_shape' })
      await pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [booking])
      await expect(
        pool.query('UPDATE bookings SET payment_refund_required=true WHERE id=$1', [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_hold_shape' })
    },
  },
  {
    name: 'pending hold blocks group mode conversion',
    mutate: (source) =>
      source.replace(
        "status IN ('confirmed','pending_payment') AND end_at>clock_timestamp()",
        "status='confirmed' AND end_at>clock_timestamp()",
      ),
    check: async ({ pool, booking }) => {
      await expect(
        pool.query(
          `UPDATE event_types SET booking_mode='group',group_capacity=2
        WHERE id=(SELECT event_type_id FROM bookings WHERE id=$1)`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'event_types_group_mode_work' })
    },
  },
  {
    name: 'exact expiry boundary rejects confirmation',
    deadline: '2039-07-01T10:00:00Z',
    prepare: (source) =>
      source.replace(
        'OLD.payment_hold_expires_at<=clock_timestamp()',
        "OLD.payment_hold_expires_at<='2039-07-01T10:00:00Z'::timestamptz",
      ),
    mutate: (source) =>
      source.replace('OLD.payment_hold_expires_at<=', 'OLD.payment_hold_expires_at<'),
    check: async ({ pool, booking }) => {
      expect(
        (
          await pool.query(
            `SELECT payment_hold_expires_at='2039-07-01T10:00:00Z'::timestamptz AS exact
        FROM bookings WHERE id=$1`,
            [booking],
          )
        ).rows,
      ).toEqual([{ exact: true }])
      await expect(
        pool.query(
          `UPDATE bookings SET status='confirmed',payment_reference='pi_synthetic_boundary'
        WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_confirmation' })
    },
  },
  {
    name: 'finite hold deadline',
    mutate: (source) => source.replace('isfinite(payment_hold_expires_at) AND ', ''),
    check: async ({ pool, booking }) => {
      for (const deadline of ['infinity', '-infinity'])
        await expect(
          pool.query(
            `INSERT INTO bookings
          (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at)
          SELECT organization_id,event_type_id,start_at,end_at,title,source,'pending_payment',$2::timestamptz
          FROM bookings WHERE id=$1`,
            [booking, deadline],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_hold_shape' })
    },
  },
  {
    name: 'confirmed paid booking cannot expire',
    mutate: (source) =>
      source.replace("NEW.status NOT IN ('confirmed','cancelled')", "NEW.status='pending_payment'"),
    check: async ({ pool, booking }) => {
      await pool.query(
        "UPDATE bookings SET payment_reference='pi_synthetic_confirmed',status='confirmed' WHERE id=$1",
        [booking],
      )
      await expect(
        pool.query("UPDATE bookings SET status='expired' WHERE id=$1", [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_transition' })
    },
  },
  {
    name: 'deadline shape',
    mutate: (source: string) =>
      `${source}\nALTER TABLE bookings DROP CONSTRAINT bookings_payment_hold_shape;`,
    check: async ({ pool, booking }: HoldFixture) => {
      await expect(
        pool.query(
          `INSERT INTO bookings
        (organization_id,event_type_id,start_at,end_at,title,source,status)
        SELECT organization_id,event_type_id,start_at,end_at,title,source,'pending_payment'
        FROM bookings WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    },
  },
  {
    name: 'immutable deadline',
    mutate: (source: string) =>
      source.replace(
        'NEW.payment_hold_expires_at IS DISTINCT FROM OLD.payment_hold_expires_at',
        'false',
      ),
    check: async ({ pool, booking }: HoldFixture) => {
      await expect(
        pool.query(
          `UPDATE bookings SET payment_hold_expires_at=
        payment_hold_expires_at+interval '1 minute' WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_transition' })
    },
  },
  {
    name: 'terminal hold finality',
    mutate: (source: string) =>
      source.replace(
        "OLD.status IN ('expired','cancelled') AND NEW.status IS DISTINCT FROM OLD.status",
        'false',
      ),
    check: async ({ pool, booking }: HoldFixture) => {
      await pool.query("UPDATE bookings SET status='expired' WHERE id=$1", [booking])
      await expect(
        pool.query("UPDATE bookings SET status='pending_payment' WHERE id=$1", [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_transition' })
    },
  },
  {
    name: 'paid confirmation requirement',
    mutate: (source: string) =>
      source
        .replace('NEW.payment_reference IS NULL OR ', '')
        .replace(
          "(status <> 'confirmed' OR payment_hold_expires_at IS NULL OR payment_reference IS NOT NULL)",
          'true',
        ),
    check: async ({ pool, booking }: HoldFixture) => {
      await expect(
        pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_confirmation' })
    },
  },
  {
    name: 'late confirmation refusal',
    elapsed: true,
    mutate: (source: string) =>
      source.replace('OLD.payment_hold_expires_at<=clock_timestamp()', 'false'),
    check: async ({ pool, booking }: HoldFixture) => {
      await expect(
        pool.query(
          `UPDATE bookings SET status='confirmed',payment_reference='pi_synthetic_late'
        WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_confirmation' })
    },
  },
  {
    name: 'immutable payment reference',
    mutate: (source: string) =>
      source.replace(
        'OLD.payment_reference IS NOT NULL AND NEW.payment_reference IS DISTINCT FROM OLD.payment_reference',
        'false',
      ),
    check: async ({ pool, booking }: HoldFixture) => {
      await pool.query(
        "UPDATE bookings SET payment_reference='pi_synthetic_original' WHERE id=$1",
        [booking],
      )
      await expect(
        pool.query("UPDATE bookings SET payment_reference='pi_synthetic_other' WHERE id=$1", [
          booking,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_transition' })
    },
  },
  {
    name: 'confirmed payment cannot become unpaid',
    mutate: (source: string) =>
      source.replace(
        "OLD.status='confirmed' AND NEW.status NOT IN ('confirmed','cancelled')",
        'false',
      ),
    check: async ({ pool, booking }: HoldFixture) => {
      await pool.query(
        "UPDATE bookings SET payment_reference='pi_synthetic_paid',status='confirmed' WHERE id=$1",
        [booking],
      )
      await expect(
        pool.query("UPDATE bookings SET status='pending_payment' WHERE id=$1", [booking]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'bookings_payment_transition' })
    },
  },
  {
    name: 'unique payment reference',
    mutate: (source: string) => `${source}\nDROP INDEX bookings_payment_reference;`,
    check: async ({ pool, booking }: HoldFixture) => {
      await pool.query("UPDATE bookings SET payment_reference='pi_synthetic_unique' WHERE id=$1", [
        booking,
      ])
      await expect(
        pool.query(
          `INSERT INTO bookings
        (organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at,payment_reference)
        SELECT organization_id,event_type_id,start_at,end_at,title,source,status,payment_hold_expires_at,payment_reference
        FROM bookings WHERE id=$1`,
          [booking],
        ),
      ).rejects.toMatchObject({ code: '23505' })
    },
  },
  {
    name: 'expired occupancy release',
    mutate: (source: string) =>
      source.replace("b.status IN ('confirmed','pending_payment')", "b.status <> 'cancelled'"),
    check: async ({ pool, booking }: HoldFixture) => {
      expect(
        (await pool.query('SELECT active FROM booking_hosts WHERE booking_id=$1', [booking])).rows,
      ).toEqual([{ active: true }])
      await pool.query("UPDATE bookings SET status='expired' WHERE id=$1", [booking])
      expect(
        (await pool.query('SELECT active FROM booking_hosts WHERE booking_id=$1', [booking])).rows,
      ).toEqual([{ active: false }])
    },
  },
]

describe.skipIf(!serverUrl)('pending-payment migration upgrade', () => {
  it.each(guards)(
    'enforces $name and detects its SQL source-copy mutation',
    async (guard) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-payment-guard-'))
      let owned: TestDatabase | undefined
      try {
        for (const file of (await readdir(migrationsDir)).filter(
          (file) => file.endsWith('.sql') && file <= predecessor,
        ))
          await copyFile(join(migrationsDir, file), join(directory, file))
        const original = await readFile(join(migrationsDir, migration), 'utf8')
        const source = guard.prepare ? guard.prepare(original) : original
        if (guard.prepare) expect(source).not.toBe(original)
        const check = async (sql: string) => {
          await writeFile(join(directory, migration), sql)
          owned = await createTestDatabase(serverUrl as string, directory)
          try {
            await guard.check(await holdFixture(owned.pool, guard.elapsed, guard.deadline))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        const mutated = guard.mutate(source)
        expect(mutated).not.toBe(source)
        await expect(check(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
        await check(source)
      } finally {
        await owned?.drop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it('preserves populated 0061 tuples, matches fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-payment-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await seedPredecessor(directory)
      const tables = await inventory(upgraded.pool)
      const before = await records(upgraded.pool, tables)
      expect(before['public.bookings']).toHaveLength(10)
      expect(before['public.group_slot_host_messages']).toHaveLength(1)
      expect(before['public.group_slot_host_mail_receipts']).toHaveLength(1)
      expect(before['public.group_slot_conferences']).toHaveLength(1)
      expect(before['public.booking_hosts']?.length).toBeGreaterThan(0)
      expect(before['public.booking_notifications']).toHaveLength(12)
      expect(before['public.import_items']).toHaveLength(1)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, tables)).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      const latest = await inventory(upgraded.pool)
      const after = await records(upgraded.pool, latest)
      const ledgerQuery =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const ledger = (await upgraded.pool.query(ledgerQuery)).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect((await upgraded.pool.query(ledgerQuery)).rows).toEqual(ledger)
      expect(await records(upgraded.pool, latest)).toEqual(after)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('detects a source-copy historical overwrite and passes again with restored SQL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-payment-preservation-'))
    let owned: TestDatabase | undefined
    try {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const check = async (sql: string) => {
        await rm(join(directory, migration), { force: true })
        owned = await seedPredecessor(directory)
        try {
          const tables = await inventory(owned.pool)
          const before = await records(owned.pool, tables)
          await writeFile(join(directory, migration), sql)
          expect(await runMigrations(owned.pool, directory)).toEqual([migration])
          expect(await records(owned.pool, tables)).toEqual(before)
        } finally {
          await owned.drop()
          owned = undefined
        }
      }
      await check(source)
      await expect(
        check(`${source}\nUPDATE bookings SET title='Overwritten history';`),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await check(source)
    } finally {
      await owned?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
