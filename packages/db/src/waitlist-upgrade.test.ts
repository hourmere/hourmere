import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const migration = '0051_waitlist.sql'
const interveningMigration = '0050_booking_success_redirect.sql'
const newTables = [
  'waitlist_entries',
  'waitlist_capabilities',
  'waitlist_verification_outbox',
  'waitlist_verification_requests',
  'waitlist_key_state',
  'waitlist_scan_work',
  'waitlist_slots',
  'waitlist_cohorts',
  'waitlist_candidates',
  'waitlist_slot_tombstones',
]
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

async function predecessor(
  directory: string,
  includeInterveningMigration = true,
): Promise<TestDatabase> {
  // Mutation cases reuse their owned directory for a second database. Always seed
  // the required populated 0049 checkpoint before applying the published 0050.
  await rm(join(directory, interveningMigration), { force: true })
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= '0049')
    .sort()
  const early = files.filter((file) => file.slice(0, 4) <= '0012')
  for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
  const owned = await createTestDatabase(serverUrl as string, directory, { tag: 'waitlist_old' })
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
      INSERT INTO notification_email_sends(recipient_hash,sent_at) VALUES
        (decode(repeat('ab',32),'hex'),now()-interval '10 minutes'),
        (NULL,now()-interval '20 minutes');
      INSERT INTO invitation_email_requests(organization_id,user_id,recipient_hash,requested_at)
        SELECT "organizationId","inviterId",decode(repeat('cd',32),'hex'),now()-interval '15 minutes'
        FROM auth.invitation ORDER BY id LIMIT 1;
      UPDATE event_types SET is_hidden=true WHERE slug='upgrade-event-2';
      UPDATE bookings SET start_at='2025-01-01T09:00Z',end_at='2025-01-01T09:30Z'
        WHERE id=(SELECT id FROM bookings WHERE status='cancelled' ORDER BY id LIMIT 1);
      UPDATE booking_conferences SET state='pending',error_code=NULL,attempts=1,
        lease_id=gen_random_uuid(),lease_until='2030-01-01T00:01Z'
        WHERE state='failed';
      INSERT INTO booking_scheduled_messages(organization_id,booking_id,kind,rule_id,
        anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at)
        SELECT organization_id,id,'reminder','synthetic-pending',start_at,end_at,
          start_at-interval '24 hours',start_at,start_at-interval '24 hours'
        FROM bookings WHERE status='confirmed' ORDER BY id LIMIT 1;
    `)
    if (includeInterveningMigration) {
      await copyFile(
        join(migrationsDir, interveningMigration),
        join(directory, interveningMigration),
      )
      expect(await runMigrations(owned.pool, directory)).toEqual([interveningMigration])
    }
    return owned
  } catch (error) {
    await owned.drop()
    throw error
  }
}

async function createEntry(pool: pg.Pool, hash = '11') {
  return (
    await pool.query<{ id: string; event_type_id: string; organization_id: string }>(
      `
      INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,name,
        window_start,window_end,time_zone,locale,consent_version,consented_at,
        expires_at,pending_expires_at)
      SELECT organization_id,id,decode(repeat($1,32),'hex'),'invitee@example.test','Invitee 東京',
        now()+interval '1 day',now()+interval '5 days','America/Los_Angeles','zh-CN','1',now(),
        now()+interval '5 days',now()+interval '24 hours'
      FROM event_types WHERE slug='upgrade-event-1' RETURNING id,event_type_id,organization_id`,
      [hash],
    )
  ).rows[0] as { id: string; event_type_id: string; organization_id: string }
}

async function createWork(pool: pg.Pool, entryId: string) {
  await pool.query(
    `
    INSERT INTO waitlist_capabilities(entry_id,purpose,token_hash,expires_at)
      SELECT id,'management',decode(repeat('22',32),'hex'),expires_at FROM waitlist_entries WHERE id=$1;
  `,
    [entryId],
  )
  await pool.query(
    `INSERT INTO waitlist_verification_outbox(entry_id,generation,encrypted_payload,expires_at)
    SELECT id,1,decode('abcdef','hex'),now()+interval '30 minutes' FROM waitlist_entries WHERE id=$1`,
    [entryId],
  )
  await pool.query(
    `WITH cohort AS (
    INSERT INTO waitlist_cohorts(event_type_id) SELECT event_type_id FROM waitlist_entries WHERE id=$1 RETURNING id,event_type_id
  ) INSERT INTO waitlist_candidates(cohort_id,entry_id,event_type_id,slots,due_at,expires_at)
    SELECT id,$1,event_type_id,'[{"start":"2030-01-01T10:00Z","end":"2030-01-01T10:30Z"}]',
      now(),now()+interval '1 hour' FROM cohort`,
    [entryId],
  )
}

async function verifyGuard(pool: pg.Pool, guard: string) {
  if (guard === 'default disabled') {
    expect((await pool.query('SELECT id FROM event_types WHERE waitlist_enabled')).rows).toEqual([])
    return
  }
  const entry = await createEntry(pool)
  const update = (set: string) =>
    pool.query(`UPDATE waitlist_entries SET ${set} WHERE id=$1`, [entry.id])
  if (guard === 'tenant binding') {
    await expect(
      pool.query(
        `INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,
        window_start,window_end,time_zone,locale,consent_version,consented_at,created_at,expires_at,pending_expires_at)
        SELECT (SELECT id FROM auth.organization WHERE id<>e.organization_id LIMIT 1),event_type_id,
          decode(repeat('55',32),'hex'),email,window_start,window_end,time_zone,locale,consent_version,
          consented_at,created_at,expires_at,pending_expires_at FROM waitlist_entries e WHERE id=$1`,
        [entry.id],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  } else if (guard === 'live mailbox uniqueness') {
    await expect(createEntry(pool)).rejects.toMatchObject({ code: '23505' })
  } else if (guard === 'fixed deadline') {
    await expect(
      update(`expires_at=expires_at+interval '1 hour',window_end=window_end+interval '1 hour'`),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (guard === 'verification gate') {
    await expect(update(`status='active'`)).rejects.toMatchObject({ code: '23514' })
  } else if (guard === 'terminal lifecycle') {
    await update(`status='expired'`)
    await expect(
      update(`status='active',verified_at=now(),terminal_at=NULL`),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (
    guard === 'erasure' ||
    guard === 'capability revocation' ||
    guard === 'all ciphertext erasure' ||
    guard === 'stop candidates'
  ) {
    await createWork(pool, entry.id)
    if (guard === 'all ciphertext erasure') {
      await pool.query('DELETE FROM waitlist_verification_outbox WHERE entry_id=$1', [entry.id])
      await pool.query(
        `INSERT INTO waitlist_verification_outbox(entry_id,generation,state,encrypted_payload,expires_at)
        VALUES($1,1,'accepted',decode('abcdef','hex'),now()+interval '30 minutes')`,
        [entry.id],
      )
    }
    await update(`status='removed'`)
    if (guard === 'erasure')
      expect(
        (
          await pool.query(
            'SELECT email,name,window_start,window_end,time_zone,locale FROM waitlist_entries WHERE id=$1',
            [entry.id],
          )
        ).rows,
      ).toEqual([
        {
          email: null,
          name: null,
          window_start: null,
          window_end: null,
          time_zone: null,
          locale: null,
        },
      ])
    if (guard === 'capability revocation')
      expect(
        (
          await pool.query(
            'SELECT revoked_at IS NOT NULL AS revoked FROM waitlist_capabilities WHERE entry_id=$1',
            [entry.id],
          )
        ).rows,
      ).toEqual([{ revoked: true }])
    if (guard === 'all ciphertext erasure')
      expect(
        (
          await pool.query(
            'SELECT encrypted_payload FROM waitlist_verification_outbox WHERE entry_id=$1',
            [entry.id],
          )
        ).rows,
      ).toEqual([{ encrypted_payload: null }])
    if (guard === 'stop candidates')
      expect(
        (await pool.query('SELECT state FROM waitlist_candidates WHERE entry_id=$1', [entry.id]))
          .rows,
      ).toEqual([{ state: 'obsolete' }])
  } else if (guard === 'ciphertext erasure') {
    await createWork(pool, entry.id)
    await pool.query("UPDATE waitlist_verification_outbox SET state='accepted' WHERE entry_id=$1", [
      entry.id,
    ])
    expect(
      (
        await pool.query(
          'SELECT encrypted_payload FROM waitlist_verification_outbox WHERE entry_id=$1',
          [entry.id],
        )
      ).rows,
    ).toEqual([{ encrypted_payload: null }])
  } else if (guard === 'digest length') {
    await expect(
      pool.query(
        `INSERT INTO waitlist_capabilities(entry_id,purpose,token_hash,expires_at)
      VALUES($1,'management',decode('abcd','hex'),now()+interval '1 hour')`,
        [entry.id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (guard === 'purpose binding') {
    await expect(
      pool.query(
        `INSERT INTO waitlist_capabilities(entry_id,purpose,token_hash,expires_at)
      VALUES($1,'booking',decode(repeat('22',32),'hex'),now()+interval '1 hour')`,
        [entry.id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (guard === 'attempt bound') {
    await expect(
      pool.query(
        `INSERT INTO waitlist_verification_outbox(entry_id,generation,encrypted_payload,expires_at,attempts)
      VALUES($1,1,decode('abcdef','hex'),now()+interval '30 minutes',4)`,
        [entry.id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (
    guard === 'candidate identity' ||
    guard === 'candidate attempts' ||
    guard === 'candidate finality' ||
    guard === 'verification identity' ||
    guard === 'verification attempts' ||
    guard === 'verification finality'
  ) {
    await createWork(pool, entry.id)
    const table = guard.startsWith('candidate')
      ? 'waitlist_candidates'
      : 'waitlist_verification_outbox'
    if (guard.endsWith('identity')) {
      await expect(
        pool.query(
          `UPDATE ${table} SET expires_at=expires_at+interval '1 minute' WHERE entry_id=$1`,
          [entry.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } else if (guard.endsWith('attempts')) {
      await pool.query(`UPDATE ${table} SET attempts=2 WHERE entry_id=$1`, [entry.id])
      await expect(
        pool.query(`UPDATE ${table} SET attempts=0 WHERE entry_id=$1`, [entry.id]),
      ).rejects.toMatchObject({ code: '23514' })
    } else {
      await pool.query(`UPDATE ${table} SET state='failed' WHERE entry_id=$1`, [entry.id])
      await expect(
        pool.query(
          `UPDATE ${table} SET state='pending'${table === 'waitlist_verification_outbox' ? ",encrypted_payload=decode('abcdef','hex')" : ''} WHERE entry_id=$1`,
          [entry.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
  } else if (guard === 'elapsed retention') {
    await pool.query(`SET TIME ZONE 'America/Los_Angeles'`)
    await expect(
      pool.query(
        `INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,purge_at)
      VALUES($1,decode(repeat('11',32),'hex'),'2027-03-13T09:00Z','2027-03-13T10:00Z','2027-03-15T09:00Z')`,
        [entry.event_type_id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  } else if (guard === 'exact slot identity') {
    const values = [entry.event_type_id]
    await pool.query(
      `INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,purge_at)
      VALUES($1,decode(repeat('11',32),'hex'),'2027-01-01T09:00Z','2027-01-01T09:30Z','2027-01-03T09:30Z')`,
      values,
    )
    await expect(
      pool.query(
        `INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,purge_at)
      VALUES($1,decode(repeat('11',32),'hex'),'2027-01-01T09:00Z','2027-01-01T10:00Z','2027-01-03T10:00Z')`,
        values,
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  } else if (guard === 'independent admission ledger' || guard === 'independent slot ledger') {
    await pool.query(
      `INSERT INTO waitlist_verification_requests(event_type_id,email_hash,ip_hash,generation_id)
      VALUES($1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'),gen_random_uuid())`,
      [entry.event_type_id],
    )
    await pool.query(
      `INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,purge_at)
      VALUES($1,decode(repeat('11',32),'hex'),'2027-01-01T09:00Z','2027-01-01T09:30Z','2027-01-03T09:30Z')`,
      [entry.event_type_id],
    )
    await pool.query('DELETE FROM event_types WHERE id=$1', [entry.event_type_id])
    const table =
      guard === 'independent admission ledger'
        ? 'waitlist_verification_requests'
        : 'waitlist_slot_tombstones'
    expect(
      (
        await pool.query(`SELECT event_type_id FROM ${table} WHERE event_type_id=$1`, [
          entry.event_type_id,
        ])
      ).rows,
    ).toEqual([{ event_type_id: entry.event_type_id }])
  } else if (guard === 'disable cleanup') {
    await pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [
      entry.event_type_id,
    ])
    await pool.query('UPDATE event_types SET waitlist_enabled=false WHERE id=$1', [
      entry.event_type_id,
    ])
    expect(
      (await pool.query('SELECT status,email FROM waitlist_entries WHERE id=$1', [entry.id])).rows,
    ).toEqual([{ status: 'removed', email: null }])
  } else if (guard === 'supported replacement remains enabled') {
    const teamEvent = (
      await pool.query<{ id: string }>("SELECT id FROM event_types WHERE slug='upgrade-event-2'")
    ).rows[0]?.id as string
    await pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [teamEvent])
    const transaction = await pool.connect()
    try {
      await transaction.query('BEGIN')
      await transaction.query('DELETE FROM event_type_hosts WHERE event_type_id=$1', [teamEvent])
      await transaction.query(
        `INSERT INTO event_type_hosts(event_type_id,user_id)
        SELECT $1,id FROM auth."user" WHERE email='upgrade-host-3@example.test'`,
        [teamEvent],
      )
      await transaction.query('COMMIT')
    } catch (error) {
      await transaction.query('ROLLBACK')
      throw error
    } finally {
      transaction.release()
    }
    expect(
      (await pool.query('SELECT waitlist_enabled FROM event_types WHERE id=$1', [teamEvent])).rows,
    ).toEqual([{ waitlist_enabled: true }])
  } else if (guard === 'host wakeups') {
    await pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [
      entry.event_type_id,
    ])
    const work = (
      await pool.query<{ dirty_generation: number }>(
        'SELECT dirty_generation FROM waitlist_scan_work WHERE event_type_id=$1',
        [entry.event_type_id],
      )
    ).rows
    expect(work).toHaveLength(1)
    const before = work[0]?.dirty_generation as number
    await pool.query(
      `UPDATE schedules SET weekly_hours=weekly_hours WHERE user_id=(SELECT owner_user_id FROM event_types WHERE id=$1)`,
      [entry.event_type_id],
    )
    expect(
      (
        await pool.query<{ dirty_generation: number }>(
          'SELECT dirty_generation FROM waitlist_scan_work WHERE event_type_id=$1',
          [entry.event_type_id],
        )
      ).rows[0]?.dirty_generation,
    ).toBeGreaterThan(before)
  }
}

const guardMutations = [
  [
    'default disabled',
    'ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT false',
    'ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT true',
  ],
  [
    'tenant binding',
    'FOREIGN KEY (event_type_id,organization_id) REFERENCES event_types(id,organization_id)',
    'FOREIGN KEY (event_type_id) REFERENCES event_types(id)',
  ],
  [
    'live mailbox uniqueness',
    'CREATE UNIQUE INDEX waitlist_entries_live_recipient',
    'CREATE INDEX waitlist_entries_live_recipient',
  ],
  [
    'fixed deadline',
    'OR NEW.expires_at IS DISTINCT FROM OLD.expires_at\n    OR NEW.pending_expires_at',
    'OR NEW.pending_expires_at',
  ],
  [
    'verification gate',
    "CHECK (status NOT IN ('active','notified','booked') OR verified_at IS NOT NULL)",
    'CHECK (true)',
  ],
  [
    'terminal lifecycle',
    "IF OLD.status IN ('booked','expired','removed') AND NEW.status <> OLD.status THEN",
    'IF false THEN',
  ],
  ['erasure', "IF NEW.status='removed' THEN", "IF false AND NEW.status='removed' THEN"],
  [
    'capability revocation',
    'WHERE entry_id=NEW.id AND revoked_at IS NULL',
    'WHERE false AND entry_id=NEW.id AND revoked_at IS NULL',
  ],
  [
    'ciphertext erasure',
    "IF NEW.state NOT IN ('pending','processing') THEN NEW.encrypted_payload := NULL; END IF;",
    'NULL;',
  ],
  [
    'all ciphertext erasure',
    'WHERE entry_id=NEW.id AND encrypted_payload IS NOT NULL',
    'WHERE false AND entry_id=NEW.id AND encrypted_payload IS NOT NULL',
  ],
  [
    'stop candidates',
    "UPDATE waitlist_candidates SET state='obsolete'",
    'UPDATE waitlist_candidates SET state=state',
  ],
  [
    'digest length',
    'token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32)',
    'token_hash bytea NOT NULL UNIQUE',
  ],
  ['purpose binding', "CHECK (purpose IN ('verification','management'))", 'CHECK (true)'],
  ['attempt bound', 'CHECK (attempts BETWEEN 0 AND 3)', 'CHECK (attempts BETWEEN 0 AND 4)'],
  [
    'candidate identity',
    'OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at',
    'OR NEW.due_at IS DISTINCT FROM OLD.due_at',
  ],
  ['candidate attempts', 'IF NEW.attempts < OLD.attempts THEN', 'IF false THEN'],
  [
    'candidate finality',
    "IF OLD.state NOT IN ('pending','processing') AND NEW.state <> OLD.state THEN",
    'IF false THEN',
  ],
  [
    'verification identity',
    'OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN',
    'OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN',
  ],
  [
    'verification attempts',
    "IF NEW.attempts < OLD.attempts THEN\n    RAISE EXCEPTION 'waitlist verification attempts cannot decrease'",
    "IF false THEN\n    RAISE EXCEPTION 'waitlist verification attempts cannot decrease'",
  ],
  [
    'verification finality',
    "IF OLD.state NOT IN ('pending','processing') AND NEW.state <> OLD.state THEN\n    RAISE EXCEPTION 'waitlist verification outcome is final'",
    "IF false THEN\n    RAISE EXCEPTION 'waitlist verification outcome is final'",
  ],
  ['elapsed retention', "CHECK (purge_at = end_at + interval '48 hours')", 'CHECK (true)'],
  [
    'exact slot identity',
    'PRIMARY KEY (event_type_id,recipient_hash,start_at,end_at)',
    'PRIMARY KEY (event_type_id,recipient_hash,start_at)',
  ],
  [
    'disable cleanup',
    'WHERE event_type_id=NEW.id AND status',
    'WHERE false AND event_type_id=NEW.id AND status',
  ],
  ['host wakeups', 'PERFORM dirty_waitlist_event(event_id);', 'NULL;'],
  [
    'supported replacement remains enabled',
    'DEFERRABLE INITIALLY DEFERRED\n  FOR EACH ROW EXECUTE FUNCTION enforce_waitlist_host_shape()',
    'NOT DEFERRABLE\n  FOR EACH ROW EXECUTE FUNCTION enforce_waitlist_host_shape()',
  ],
  [
    'independent admission ledger',
    'CREATE TABLE waitlist_verification_requests (\n  id uuid PRIMARY KEY DEFAULT uuidv7(),\n  event_type_id uuid NOT NULL,',
    'CREATE TABLE waitlist_verification_requests (\n  id uuid PRIMARY KEY DEFAULT uuidv7(),\n  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,',
  ],
  [
    'independent slot ledger',
    'CREATE TABLE waitlist_slot_tombstones (\n  event_type_id uuid NOT NULL,',
    'CREATE TABLE waitlist_slot_tombstones (\n  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,',
  ],
] as const

describe.skipIf(!serverUrl)('waitlist migration', () => {
  it.each([
    ['historical rewrite', 'UPDATE bookings SET title=title;'],
    [
      'mail ledger reseed',
      'INSERT INTO notification_email_sends(recipient_hash,sent_at) VALUES(NULL,now());',
    ],
  ])(
    'detects source-copy %s during upgrade preservation',
    async (_guard, appended) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-preserve-mutation-'))
      let owned: TestDatabase | undefined
      try {
        owned = await predecessor(directory)
        const tables = await inventory(owned.pool)
        const before = await records(owned.pool, tables)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        await writeFile(join(directory, migration), `${source}\n${appended}\n`)
        expect(await runMigrations(owned.pool, directory)).toEqual([migration])
        await expect(
          (async () => {
            expect(await records(owned.pool, tables)).toEqual(before)
          })(),
        ).rejects.toMatchObject({ name: 'AssertionError' })
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

  it('persists every availability mutation only on commit and retires changed identities without resurrecting disabled entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-signals-'))
    let owned: TestDatabase | undefined
    try {
      owned = await predecessor(directory)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await runMigrations(owned.pool, directory)
      const pool = owned.pool
      const entry = await createEntry(pool)
      await pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [
        entry.event_type_id,
      ])
      const host = (
        await pool.query<{ owner_user_id: string }>(
          'SELECT owner_user_id FROM event_types WHERE id=$1',
          [entry.event_type_id],
        )
      ).rows[0]?.owner_user_id as string
      const generation = async () =>
        (
          await pool.query<{ dirty_generation: number }>(
            'SELECT dirty_generation FROM waitlist_scan_work WHERE event_type_id=$1',
            [entry.event_type_id],
          )
        ).rows[0]?.dirty_generation as number
      const sources = [
        `UPDATE profiles SET time_zone=time_zone WHERE user_id=$1`,
        `UPDATE schedules SET weekly_hours=weekly_hours WHERE user_id=$1`,
        `UPDATE schedule_overrides SET intervals=intervals WHERE schedule_id IN (SELECT id FROM schedules WHERE user_id=$1)`,
        `UPDATE calendar_connections SET status=status WHERE user_id=$1`,
        `UPDATE calendars SET check_conflicts=check_conflicts WHERE connection_id IN (SELECT id FROM calendar_connections WHERE user_id=$1)`,
        `UPDATE calendar_busy SET external_event_id=external_event_id WHERE calendar_id IN (SELECT c.id FROM calendars c JOIN calendar_connections cc ON cc.id=c.connection_id WHERE cc.user_id=$1)`,
        `UPDATE booking_hosts SET period=period WHERE user_id=$1`,
        `UPDATE event_type_hosts SET schedule_id=schedule_id WHERE user_id=$1`,
      ]
      for (const sql of sources) {
        const before = await generation()
        await pool.query(sql, [host])
        expect(await generation(), sql).toBeGreaterThan(before)
      }
      expect(
        (await pool.query('SELECT status FROM waitlist_entries WHERE id=$1', [entry.id])).rows,
      ).toEqual([{ status: 'pending_verification' }])
      const before = await generation()
      const transaction = await pool.connect()
      try {
        await transaction.query('BEGIN')
        await transaction.query('UPDATE schedules SET weekly_hours=weekly_hours WHERE user_id=$1', [
          host,
        ])
        await transaction.query('ROLLBACK')
      } finally {
        transaction.release()
      }
      expect(await generation()).toBe(before)
      await pool.query('UPDATE event_types SET waitlist_enabled=false WHERE id=$1', [
        entry.event_type_id,
      ])
      await pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [
        entry.event_type_id,
      ])
      expect(
        (await pool.query('SELECT status,email FROM waitlist_entries WHERE id=$1', [entry.id]))
          .rows,
      ).toEqual([{ status: 'removed', email: null }])
      const replacement = await createEntry(pool, '55')
      await pool.query('DELETE FROM event_type_hosts WHERE event_type_id=$1', [
        replacement.event_type_id,
      ])
      expect(
        (
          await pool.query('SELECT status,email FROM waitlist_entries WHERE id=$1', [
            replacement.id,
          ])
        ).rows,
      ).toEqual([{ status: 'removed', email: null }])
      expect(
        (
          await pool.query('SELECT waitlist_enabled FROM event_types WHERE id=$1', [
            replacement.event_type_id,
          ])
        ).rows,
      ).toEqual([{ waitlist_enabled: false }])
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it.each(guardMutations)(
    'enforces %s and detects its source-copy mutation',
    async (guard, original, broken) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-guard-'))
      let normal: TestDatabase | undefined
      let mutated: TestDatabase | undefined
      try {
        normal = await predecessor(directory)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        await writeFile(join(directory, migration), source)
        await runMigrations(normal.pool, directory)
        await verifyGuard(normal.pool, guard)
        await normal.drop()
        normal = undefined
        await rm(join(directory, migration))
        mutated = await predecessor(directory)
        expect(source.includes(original)).toBe(true)
        await writeFile(join(directory, migration), source.replace(original, broken))
        expect(await runMigrations(mutated.pool, directory)).toEqual([migration])
        await expect(verifyGuard(mutated.pool, guard)).rejects.toMatchObject({
          name: 'AssertionError',
        })
        expect(mutated.pool.totalCount).toBeLessThanOrEqual(1)
      } finally {
        try {
          await Promise.all([normal?.drop(), mutated?.drop()])
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )

  it('preserves populated 0049 history, tokens, calendars, conferences, jobs and accounting; fresh install matches and rerun writes nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    const definition = defineJob({
      name: 'booking-notification',
      payload: z.object({ bookingId: z.uuid(), kind: z.literal('reminder') }),
      policy: 'exclusive',
    })
    let jobs: ReturnType<typeof createJobs<readonly [typeof definition]>> | undefined
    try {
      upgraded = await predecessor(directory, false)
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
      const tables = await inventory(pool)
      const before = await records(pool, tables)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.notification_email_sends']).toHaveLength(2)
      expect(before['public.invitation_email_requests']).toHaveLength(1)
      expect(before['public.booking_notifications']).toHaveLength(13)
      expect(before['public.booking_conferences']).toHaveLength(2)
      expect(before['public.booking_scheduled_messages']).toHaveLength(1)
      expect(
        (await pool.query("SELECT state FROM booking_conferences WHERE state='pending'")).rows,
      ).toHaveLength(1)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0049_configurable_booking_messages.sql' })
      await copyFile(
        join(migrationsDir, interveningMigration),
        join(directory, interveningMigration),
      )
      expect(await runMigrations(pool, directory)).toEqual([interveningMigration])
      expect(await records(pool, tables), '0050 preserves all populated 0049 values').toEqual(
        before,
      )
      expect((await pool.query('SELECT DISTINCT success_redirect FROM event_types')).rows).toEqual([
        { success_redirect: null },
      ])
      expect((await pool.query('SELECT DISTINCT success_redirect FROM bookings')).rows).toEqual([
        { success_redirect: null },
      ])
      const currentPredecessorTables = await inventory(pool)
      const currentPredecessorRecords = await records(pool, currentPredecessorTables)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(
        await records(pool, tables),
        'all historical bytes and tuple identities are preserved',
      ).toEqual(before)
      expect(
        await records(pool, currentPredecessorTables),
        '0051 also preserves the complete published 0050 schema data',
      ).toEqual(currentPredecessorRecords)
      await verifyGuard(pool, 'default disabled')
      for (const table of newTables)
        expect((await pool.query(`SELECT * FROM ${quote(table)}`)).rows).toEqual([])
      expect((await pool.query('SELECT id FROM pgboss.job WHERE id=$1', [jobId])).rows).toEqual([
        { id: jobId },
      ])
      const schema = await snapshotSchema(pool)
      expect((await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()).toEqual(
        (await readdir(migrationsDir))
          .filter((file) => file.endsWith('.sql') && file <= migration)
          .sort(),
      )
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'waitlist_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const latest = await inventory(pool)
      const current = await records(pool, latest)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const acknowledgements = (await pool.query(ledger)).rows
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records(pool, latest)).toEqual(current)
      expect((await pool.query(ledger)).rows).toEqual(acknowledgements)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
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
})
