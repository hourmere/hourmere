import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createJobs, defineJob } from '@hourmere/jobs'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0046_configurable_booking_messages.sql'
const defaultSettings = {
  reminders: [
    {
      id: 'default-24h',
      offsetMinutes: 1440,
      recipients: { invitee: true, guests: true, host: true },
    },
  ],
  followUps: [],
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
interface Table {
  schema: string
  name: string
  columns: string[]
}
async function inventory(pool: pg.Pool) {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public','pgboss') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}
async function records(pool: pg.Pool, tables: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}

async function predecessor(directory: string): Promise<TestDatabase> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file < migration)
    .sort()
  const early = files.filter((file) => file.slice(0, 4) <= '0012')
  for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
  const owned = await createTestDatabase(serverUrl as string, directory, { tag: 'messages_old' })
  try {
    await seedEarly(owned.pool)
    for (const file of files.filter((file) => !early.includes(file)))
      await copyFile(join(migrationsDir, file), join(directory, file))
    await runMigrations(owned.pool, directory)
    await seedLater(owned.pool)
    await owned.pool.query(`
      INSERT INTO booking_notifications
        (booking_id,kind,recipient,outcome,suppression_reason,created_at)
        SELECT booking_id,'cancelled',recipient,'suppressed','recipient_hourly_limit',
          now()-interval '15 minutes'
        FROM booking_notifications WHERE kind='confirmed' ORDER BY booking_id LIMIT 1;
      UPDATE booking_notifications SET created_at=now()-interval '10 minutes'
        WHERE kind='confirmed';
      INSERT INTO notification_email_sends (recipient_hash,sent_at) VALUES
        (decode(repeat('ab',32),'hex'),now()-interval '10 minutes'),
        (NULL,now()-interval '20 minutes');
      UPDATE bookings SET start_at='2025-01-01T09:00Z',end_at='2025-01-01T09:30Z'
        WHERE id=(SELECT id FROM bookings WHERE status='cancelled' ORDER BY id LIMIT 1);
    `)
    return owned
  } catch (error) {
    await owned.drop()
    throw error
  }
}

async function verifyNoHistoricalMail(
  pool: pg.Pool,
  tables: Table[],
  before: Record<string, string[]>,
) {
  expect(
    await records(pool, tables),
    'every historical value, token, counter and job is preserved',
  ).toEqual(before)
  expect(
    (await pool.query('SELECT id FROM booking_scheduled_messages')).rows,
    'migration must not schedule historical mail',
  ).toEqual([])
}

async function verifyGuard(pool: pg.Pool, guard: string) {
  if (
    guard === 'setting shape' ||
    guard === 'setting count' ||
    guard === 'offset bound' ||
    guard === 'recipient selection'
  ) {
    const settings =
      guard === 'setting shape'
        ? {}
        : guard === 'setting count'
          ? { reminders: Array(6).fill(defaultSettings.reminders[0]), followUps: [] }
          : {
              reminders: [
                {
                  ...defaultSettings.reminders[0],
                  ...(guard === 'offset bound'
                    ? { offsetMinutes: 4 }
                    : { recipients: { invitee: false, guests: false, host: false } }),
                },
              ],
              followUps: [],
            }
    await expect(
      pool.query('UPDATE event_types SET notifications=$1::jsonb', [JSON.stringify(settings)]),
    ).rejects.toMatchObject({ code: '23514' })
    return
  }
  const selected = (
    await pool.query<{ id: string; organization_id: string }>(
      'SELECT id,organization_id FROM bookings ORDER BY id LIMIT 1',
    )
  ).rows[0] as { id: string; organization_id: string }
  if (guard === 'snapshot marker') {
    await expect(
      pool.query(`UPDATE bookings SET notification_snapshot='{}' WHERE id=$1`, [selected.id]),
    ).rejects.toMatchObject({ code: '23514' })
    return
  }
  if (guard === 'receipt identity') {
    const recipient = (
      await pool.query<{ recipient: string }>(
        'SELECT recipient FROM booking_notifications WHERE booking_id=$1 LIMIT 1',
        [selected.id],
      )
    ).rows[0]?.recipient
    for (const key of ['first', 'second'])
      await expect(
        pool.query(
          `INSERT INTO booking_notifications (booking_id,kind,message_key,recipient) VALUES ($1,'reminder',$2,$3)`,
          [selected.id, key, recipient],
        ),
      ).resolves.toMatchObject({ rowCount: 1 })
    return
  }
  const insert = (attempts = 0, state = 'pending', organization = selected.organization_id) =>
    pool.query(
      `INSERT INTO booking_scheduled_messages
    (organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at,attempts,state)
    SELECT $1,id,'reminder','first',start_at,end_at,start_at-interval '1 day',start_at,start_at-interval '1 day',$2,$3 FROM bookings WHERE id=$4`,
      [organization, attempts, state, selected.id],
    )
  if (guard === 'attempt bound') await expect(insert(14)).rejects.toMatchObject({ code: '23514' })
  else if (guard === 'exclusive claim')
    await expect(insert(0, 'processing')).rejects.toMatchObject({ code: '23514' })
  else if (guard === 'schedule identity') {
    await insert()
    await expect(insert()).rejects.toMatchObject({ code: '23505' })
  } else {
    const otherOrg = (
      await pool.query<{ id: string }>('SELECT id FROM auth.organization WHERE id<>$1 LIMIT 1', [
        selected.organization_id,
      ])
    ).rows[0]?.id as string
    await expect(insert(0, 'pending', otherOrg)).rejects.toMatchObject({ code: '23503' })
  }
}

const guardMutations = [
  [
    'setting shape',
    'RETURN false;\n  END IF;\n  IF jsonb_array_length',
    'RETURN true;\n  END IF;\n  IF jsonb_array_length',
  ],
  [
    'setting count',
    "jsonb_array_length(settings->'reminders') > 5",
    "jsonb_array_length(settings->'reminders') > 6",
  ],
  ['offset bound', 'NOT BETWEEN 5 AND 43200', 'NOT BETWEEN 4 AND 43200'],
  [
    'recipient selection',
    "OR NOT ((recipients->>'invitee')::boolean",
    "OR false AND NOT ((recipients->>'invitee')::boolean",
  ],
  [
    'snapshot marker',
    'ADD CONSTRAINT bookings_notification_snapshot_check CHECK (',
    'ADD CONSTRAINT bookings_notification_snapshot_check CHECK (true OR',
  ],
  [
    'receipt identity',
    'ADD PRIMARY KEY (booking_id,kind,message_key,recipient)',
    'ADD PRIMARY KEY (booking_id,kind,recipient)',
  ],
  ['attempt bound', 'CHECK (attempts BETWEEN 0 AND 13)', 'CHECK (true)'],
  [
    'exclusive claim',
    "(state='processing' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)",
    "state='processing'",
  ],
  ['schedule identity', 'UNIQUE (booking_id,kind,rule_id),', ''],
  [
    'organization binding',
    'FOREIGN KEY (booking_id,organization_id) REFERENCES bookings(id,organization_id)',
    'FOREIGN KEY (booking_id) REFERENCES bookings(id)',
  ],
] as const

describe.skipIf(!serverUrl)('configurable booking messages migration', () => {
  it.each(guardMutations)(
    'detects source-copy removal of %s',
    async (guard, original, broken) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-message-guard-mutation-'))
      let owned: TestDatabase | undefined
      try {
        owned = await predecessor(directory)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        expect(source.includes(original)).toBe(true)
        await writeFile(join(directory, migration), source.replace(original, broken))
        expect(await runMigrations(owned.pool, directory)).toEqual([migration])
        await expect(verifyGuard(owned.pool, guard)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      } finally {
        try {
          await owned?.drop()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )

  it('preserves predecessor data, default policy, tokens, queue and ledger; matches fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-message-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    const definition = defineJob({
      name: 'booking-notification',
      payload: z.object({ bookingId: z.uuid(), kind: z.literal('reminder') }),
      policy: 'exclusive',
    })
    let jobs: ReturnType<typeof createJobs<readonly [typeof definition]>> | undefined
    try {
      upgraded = await predecessor(directory)
      const pool = upgraded.pool
      jobs = createJobs({
        connectionString: upgraded.url,
        definitions: [definition] as const,
        work: false,
        migrate: true,
        maxConnections: 1,
      })
      await jobs.start()
      const bookingId = (
        await pool.query<{ id: string }>('SELECT id FROM bookings ORDER BY id LIMIT 1')
      ).rows[0]?.id as string
      const jobId = await jobs.enqueue(
        'booking-notification',
        { bookingId, kind: 'reminder' },
        {
          startAfter: new Date('2031-01-01T00:00Z'),
          singletonKey: `booking-notification:${bookingId}:reminder`,
        },
      )
      await jobs.stop()
      expect(jobId).toBeTypeOf('string')
      const tables = await inventory(pool)
      const before = await records(pool, tables)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.booking_notifications']).toHaveLength(13)
      expect(before['public.notification_email_sends']).toHaveLength(2)
      expect(before['public.booking_conference_notifications']).toHaveLength(4)
      expect(
        (await pool.query('SELECT DISTINCT ical_version FROM bookings ORDER BY ical_version')).rows,
      ).toEqual([{ ical_version: 1 }, { ical_version: 2 }])
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({
        name: '0045_invitation_generation_actor.sql',
      })
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      const started = performance.now()
      expect(await runMigrations(pool, directory)).toEqual([migration])
      console.info(
        `0046 synthetic predecessor migration: ${(performance.now() - started).toFixed(1)} ms`,
      )
      await verifyNoHistoricalMail(pool, tables, before)
      expect((await pool.query('SELECT notifications FROM event_types')).rows).toEqual(
        Array.from({ length: 7 }, () => ({ notifications: defaultSettings })),
      )
      expect((await pool.query('SELECT notification_snapshot FROM bookings')).rows).toEqual(
        Array.from({ length: 8 }, () => ({ notification_snapshot: null })),
      )
      expect(
        (await pool.query('SELECT DISTINCT message_key FROM booking_notifications')).rows,
      ).toEqual([{ message_key: '' }])
      expect(
        (
          await pool.query(`SELECT booking_id FROM booking_notifications
        WHERE manage_token_hash=sha256(convert_to('synthetic-email-manage-1','UTF8'))`)
        ).rows,
      ).toHaveLength(1)
      expect((await pool.query('SELECT id FROM pgboss.job WHERE id=$1', [jobId])).rows).toEqual([
        { id: jobId },
      ])

      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'messages_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect((await fresh.pool.query('SELECT * FROM booking_scheduled_messages')).rows).toEqual([])
      const latestTables = await inventory(pool)
      const current = await records(pool, latestTables)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const acknowledgements = (await pool.query(ledger)).rows
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records(pool, latestTables)).toEqual(current)
      expect((await pool.query(ledger)).rows).toEqual(acknowledgements)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(acknowledgements.map(({ name, checksum }) => ({ name, checksum })))
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await jobs?.stop()
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('enforces setting shape, bounded schedules, message identity and organization deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-message-constraints-'))
    let owned: TestDatabase | undefined
    try {
      owned = await predecessor(directory)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await runMigrations(owned.pool, directory)
      const pool = owned.pool
      const selected = (
        await pool.query<{ id: string; organization_id: string }>(
          'SELECT id,organization_id FROM bookings ORDER BY id LIMIT 1',
        )
      ).rows[0] as { id: string; organization_id: string }
      const eventId = (
        await pool.query<{ id: string }>('SELECT id FROM event_types ORDER BY id LIMIT 1')
      ).rows[0]?.id
      const settings = (value: unknown) =>
        pool.query('UPDATE event_types SET notifications=$1::jsonb WHERE id=$2', [
          JSON.stringify(value),
          eventId,
        ])
      for (const invalid of [
        null,
        {},
        { reminders: [], followUps: null },
        { reminders: Array(6).fill(defaultSettings.reminders[0]), followUps: [] },
        { reminders: [], followUps: Array(4).fill(defaultSettings.reminders[0]) },
        ...[4, 43201, 5.5].map((offsetMinutes) => ({
          reminders: [{ ...defaultSettings.reminders[0], offsetMinutes }],
          followUps: [],
        })),
        {
          reminders: [
            {
              ...defaultSettings.reminders[0],
              recipients: { invitee: false, guests: false, host: false },
            },
          ],
          followUps: [],
        },
      ]) {
        await expect(settings(invalid)).rejects.toMatchObject({ code: '23514' })
      }
      await settings({ reminders: [], followUps: [] })
      for (const invalid of [
        {},
        { version: 1, executionMode: 'other', notifications: defaultSettings },
        { version: 1, executionMode: 'configurable', notifications: null },
      ]) {
        await expect(
          pool.query('UPDATE bookings SET notification_snapshot=$1::jsonb WHERE id=$2', [
            JSON.stringify(invalid),
            selected.id,
          ]),
        ).rejects.toMatchObject({ code: '23514' })
      }
      await pool.query('UPDATE bookings SET notification_snapshot=$1::jsonb WHERE id=$2', [
        JSON.stringify({
          version: 1,
          executionMode: 'configurable',
          notifications: defaultSettings,
        }),
        selected.id,
      ])
      const insert = (
        ruleId: string,
        attempts = 0,
        state = 'pending',
        token: string | null = null,
        lease: string | null = null,
        organization = selected.organization_id,
      ) =>
        pool.query(
          `INSERT INTO booking_scheduled_messages
        (organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at,attempts,state,claim_token,lease_until)
        SELECT $1,id,'reminder',$2,start_at,end_at,start_at-interval '1 day',start_at,start_at-interval '1 day',$3,$4,$5,$6 FROM bookings WHERE id=$7 RETURNING id`,
          [organization, ruleId, attempts, state, token, lease, selected.id],
        )
      for (const attempts of [-1, 14])
        await expect(insert('bound', attempts)).rejects.toMatchObject({ code: '23514' })
      await expect(insert('__proto__')).rejects.toMatchObject({ code: '23514' })
      await expect(insert('claim', 0, 'processing')).rejects.toMatchObject({ code: '23514' })
      await expect(insert('claim', 0, 'pending', selected.id)).rejects.toMatchObject({
        code: '23514',
      })
      await expect(insert('claim', 0, 'pending', null, '2030-01-01T00:00Z')).rejects.toMatchObject({
        code: '23514',
      })
      const otherOrg = (
        await pool.query<{ id: string }>('SELECT id FROM auth.organization WHERE id<>$1 LIMIT 1', [
          selected.organization_id,
        ])
      ).rows[0]?.id as string
      await expect(insert('other', 0, 'pending', null, null, otherOrg)).rejects.toMatchObject({
        code: '23503',
      })
      await insert('first')
      await insert('second', 13, 'processing', selected.id, '2031-01-01T00:00Z')
      await expect(insert('first')).rejects.toMatchObject({ code: '23505' })
      const recipient = (
        await pool.query<{ recipient: string }>(
          'SELECT recipient FROM booking_notifications WHERE booking_id=$1 LIMIT 1',
          [selected.id],
        )
      ).rows[0]?.recipient
      const receipt = (key: string) =>
        pool.query(
          `INSERT INTO booking_notifications (booking_id,kind,message_key,recipient) VALUES ($1,'follow_up',$2,$3)`,
          [selected.id, key, recipient],
        )
      await receipt('first')
      await receipt('second')
      await expect(receipt('first')).rejects.toMatchObject({ code: '23505' })
      await expect(receipt('__proto__')).rejects.toMatchObject({ code: '23514' })
      const budget = (await pool.query('SELECT * FROM notification_email_sends ORDER BY sent_at'))
        .rows
      await pool.query('DELETE FROM auth.organization WHERE id=$1', [selected.organization_id])
      expect(
        (
          await pool.query('SELECT * FROM booking_scheduled_messages WHERE booking_id=$1', [
            selected.id,
          ])
        ).rows,
      ).toEqual([])
      expect(
        (await pool.query('SELECT * FROM booking_notifications WHERE booking_id=$1', [selected.id]))
          .rows,
      ).toEqual([])
      expect(
        (await pool.query('SELECT * FROM notification_email_sends ORDER BY sent_at')).rows,
      ).toEqual(budget)
      expect(pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it.each(['ledger reseed', 'historical schedule'] as const)(
    'detects source-copy %s mutation with the preservation assertions',
    async (mutation) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-message-mutation-'))
      let owned: TestDatabase | undefined
      try {
        owned = await predecessor(directory)
        const tables = await inventory(owned.pool)
        const before = await records(owned.pool, tables)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const broken =
          mutation === 'ledger reseed'
            ? `INSERT INTO notification_email_sends (recipient_hash,sent_at)
            SELECT NULL,created_at FROM booking_notifications WHERE outcome='sent';`
            : `INSERT INTO booking_scheduled_messages
            (organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at)
            SELECT organization_id,id,'reminder','default-24h',start_at,end_at,start_at-interval '1 day',start_at,start_at-interval '1 day' FROM bookings;`
        await writeFile(join(directory, migration), `${source}\n${broken}\n`)
        expect(await runMigrations(owned.pool, directory)).toEqual([migration])
        await expect(verifyNoHistoricalMail(owned.pool, tables, before)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      } finally {
        try {
          await owned?.drop()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )
})
