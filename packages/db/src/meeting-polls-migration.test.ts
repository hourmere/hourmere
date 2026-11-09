import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  attempts,
  digest,
  type Fixture,
  fixture,
  insert,
  meetingPollProtections,
  meetingPollSerializationChecks,
  transaction,
} from './meeting-poll-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  createTestDatabase,
  createTestDatabaseTemplate,
  type TestDatabase,
  type TestDatabaseTemplate,
} from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0071_meeting_polls.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const checkViolation = { code: '23514' }
const foreignKeyViolation = { code: '23503' }

async function predecessorFiles(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file < migration)
    .sort()
  expect(files.at(-1)).toBe('0070_attendee_no_show.sql')
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
      AND table_name <> 'schema_migrations' AND table_name NOT LIKE 'meeting_poll%'
    ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT to_jsonb(t)::text AS value,xmin::text,ctid::text FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows
  return result
}

// Real-database scenarios: allow for a loaded shared server, as CI and parallel agents produce.
describe.skipIf(!serverUrl)('meeting poll storage migration', { timeout: 60_000 }, () => {
  it('preserves populated predecessor rows, matches a fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-poll-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      expect(files.at(-1)).toBe('0070_attendee_no_show.sql')
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(upgraded.pool)
      await predecessorFiles(directory)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await upgraded.pool.query(
        `UPDATE booking_attendees SET no_show_marked_at=clock_timestamp(),no_show_marked_by=(SELECT id FROM auth."user" ORDER BY id LIMIT 1) WHERE id=(SELECT id FROM booking_attendees ORDER BY id LIMIT 1)`,
      )
      const before = await records(upgraded.pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'public.event_types',
        'public.bookings',
        'public.booking_attendees',
        'public.webhook_deliveries',
        'public.booking_conferences',
      ])
        expect(before[table]?.length).toBeGreaterThan(0)
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool)).toEqual(before)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [migration],
          )
        ).rows,
      ).toEqual(ledger)
      fresh = await createTestDatabase(serverUrl as string, directory)
      const schema = await snapshotSchema(upgraded.pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(
        (
          await upgraded.pool.query(
            "SELECT indexname,indexdef FROM pg_indexes WHERE indexname IN ('meeting_polls_creator_idx','meeting_poll_deliveries_host_idx') ORDER BY indexname",
          )
        ).rows,
      ).toEqual([
        {
          indexname: 'meeting_poll_deliveries_host_idx',
          indexdef:
            'CREATE INDEX meeting_poll_deliveries_host_idx ON public.meeting_poll_deliveries USING btree (host_user_id)',
        },
        {
          indexname: 'meeting_polls_creator_idx',
          indexdef:
            'CREATE INDEX meeting_polls_creator_idx ON public.meeting_polls USING btree (created_by_user_id)',
        },
      ])
      const finalLedger = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(upgraded.pool)).toEqual(before)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(finalLedger)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects cross-organization and cross-poll references throughout storage', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      await expect(f.makePoll({ event_type_id: f.otherEvent })).rejects.toMatchObject(
        foreignKeyViolation,
      )
      await expect(
        insert(f.pool, 'meeting_poll_voters', {
          ...f.voterValues,
          poll_id: f.foreign.poll,
          email_key: digest(),
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
      await expect(
        insert(f.pool, 'meeting_poll_mailbox_counters', {
          organization_id: f.organization,
          poll_id: f.foreign.poll,
          email_key: digest(),
          purge_at: f.deadline,
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
      for (const values of [
        { voter_id: f.otherVoter, slot_id: f.slots[0] },
        { voter_id: f.voter, slot_id: f.foreign.slots[0] },
        { voter_id: f.voter, slot_id: f.second.slots[0] },
        { voter_id: f.voter, slot_id: f.slots[0], poll_id: f.second.poll },
      ])
        await expect(
          insert(f.pool, 'meeting_poll_votes', {
            organization_id: f.organization,
            poll_id: f.poll,
            value: 'yes',
            ...values,
          }),
        ).rejects.toMatchObject(foreignKeyViolation)
      await expect(
        insert(f.pool, 'meeting_poll_capabilities', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: f.otherVoter,
          purpose: 'voting',
          token_digest: digest(),
          generation: 1,
          expires_at: f.deadline,
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
      await expect(
        f.pool.query(
          `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
          [f.second.slots[0], f.booking, f.poll],
        ),
      ).rejects.toMatchObject(foreignKeyViolation)
      const receipt = {
        organization_id: f.organization,
        poll_id: f.poll,
        operation: 'create',
        actor_scope_digest: digest(),
        idempotency_key_digest: digest(),
        request_fingerprint: digest(),
      }
      await expect(
        insert(f.pool, 'meeting_poll_operations', { ...receipt, poll_id: f.foreign.poll }),
      ).rejects.toMatchObject(foreignKeyViolation)
      await expect(
        insert(f.pool, 'meeting_poll_operations', {
          ...receipt,
          organization_id: f.otherOrganization,
          poll_id: f.foreign.poll,
          booking_id: f.booking,
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: f.otherVoter,
          kind: 'invitation',
          generation: 1,
          due_at: f.created,
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
    } finally {
      await owned.drop()
    }
  })

  it('enforces lifecycle pairs and preserves the scheduled historical booking link', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      for (const statement of [
        "status='closed'",
        'closed_at=clock_timestamp()',
        "status='canceled'",
        'canceled_at=clock_timestamp()',
        "status='scheduled',scheduled_at=clock_timestamp()",
        'scheduled_at=clock_timestamp()',
      ])
        await expect(
          f.pool.query(`UPDATE meeting_polls SET ${statement} WHERE id=$1`, [f.poll]),
        ).rejects.toMatchObject(checkViolation)
      await f.pool.query(
        `UPDATE meeting_polls SET status='closed',closed_at=clock_timestamp() WHERE id=$1`,
        [f.poll],
      )
      const mismatched = await insert(f.pool, 'bookings', {
        organization_id: f.organization,
        event_type_id: f.event,
        title: 'Wrong time',
        source: 'web',
        start_at: new Date(new Date(f.start).getTime() + 86400_000),
        end_at: new Date(new Date(f.end).getTime() + 86400_000),
      })
      await expect(
        f.pool.query(
          `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
          [f.slots[0], mismatched, f.poll],
        ),
      ).rejects.toMatchObject(checkViolation)
      await f.pool.query(
        `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
        [f.slots[0], f.booking, f.poll],
      )
      await f.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
        [f.booking],
      )
      expect(
        (await f.pool.query('SELECT status,booking_id FROM meeting_polls WHERE id=$1', [f.poll]))
          .rows,
      ).toEqual([{ status: 'scheduled', booking_id: f.booking }])
      await expect(
        f.pool.query('DELETE FROM meeting_polls WHERE id=$1', [f.poll]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect(
        (await f.pool.query('SELECT id FROM bookings WHERE id=$1', [f.booking])).rowCount,
      ).toBe(1)
    } finally {
      await owned.drop()
    }
  })

  it('bounds candidates, enrollments, pending reservations and mailbox counters', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      await expect(
        transaction(f.pool, (client) => insert(client, 'meeting_polls', f.pollValues)),
      ).rejects.toMatchObject(checkViolation)
      await expect(
        f.pool.query('DELETE FROM meeting_poll_slots WHERE id=$1', [f.slots[0]]),
      ).rejects.toMatchObject(checkViolation)
      for (let position = 2; position < 20; position++)
        await insert(f.pool, 'meeting_poll_slots', {
          organization_id: f.organization,
          poll_id: f.poll,
          position,
          start_at: new Date(new Date(f.start).getTime() + position * 3600_000),
          end_at: new Date(new Date(f.end).getTime() + position * 3600_000),
        })
      await expect(
        insert(f.pool, 'meeting_poll_slots', {
          organization_id: f.organization,
          poll_id: f.poll,
          position: 20,
          start_at: new Date(new Date(f.start).getTime() + 20 * 3600_000),
          end_at: new Date(new Date(f.end).getTime() + 20 * 3600_000),
        }),
      ).rejects.toMatchObject(checkViolation)
      for (let i = 1; i < 40; i++)
        await insert(f.pool, 'meeting_poll_voters', {
          ...f.voterValues,
          email_key: digest(),
          email: `voter-${i}@example.test`,
        })
      await expect(
        insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() }),
      ).rejects.toMatchObject(checkViolation)
      await f.pool.query(
        'UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1',
        [f.voter],
      )
      await insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() })
      const pending = {
        ...f.voterValues,
        poll_id: f.second.poll,
        invited_at: null,
        created_at: f.created,
        pending_expires_at: new Date(new Date(f.created).getTime() + 3600_000),
        admission_ip_digest: digest(),
      }
      for (let i = 0; i < 3; i++)
        await insert(f.pool, 'meeting_poll_voters', { ...pending, email_key: digest() })
      await expect(
        insert(f.pool, 'meeting_poll_voters', { ...pending, email_key: digest() }),
      ).rejects.toMatchObject(checkViolation)
      await expect(
        insert(f.pool, 'meeting_poll_voters', {
          ...pending,
          email_key: digest(),
          admission_ip_digest: digest(),
          pending_expires_at: new Date(new Date(f.created).getTime() + 3600_001),
        }),
      ).rejects.toMatchObject(checkViolation)
      const counter = {
        organization_id: f.organization,
        poll_id: f.poll,
        email_key: digest(),
        purge_at: f.deadline,
      }
      for (const field of ['resend_count', 'recovery_count'])
        for (const count of [-1, 4])
          await expect(
            insert(f.pool, 'meeting_poll_mailbox_counters', {
              ...counter,
              [field]: count,
              [field === 'resend_count' ? 'last_resend_at' : 'last_recovery_at']: f.created,
            }),
          ).rejects.toMatchObject({
            code: '23514',
            constraint:
              field === 'resend_count'
                ? 'meeting_poll_mailbox_counters_resend_cap'
                : 'meeting_poll_mailbox_counters_recovery_cap',
          })
      await insert(f.pool, 'meeting_poll_mailbox_counters', {
        ...counter,
        resend_count: 3,
        recovery_count: 3,
        last_resend_at: f.created,
        last_recovery_at: f.created,
      })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    } finally {
      await owned.drop()
    }
  })

  it('enforces recipient, lease and terminal delivery pairs with repeat-delivery ordinals', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      const delivery = {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        kind: 'invitation',
        generation: 1,
        due_at: f.created,
      }
      for (const overrides of [
        { voter_id: null },
        { host_user_id: f.user },
        { lease_id: randomUUID() },
        { lease_until: f.deadline },
        { state: 'processing' },
        { state: 'sent' },
        { terminal_at: f.created },
        {
          state: 'sent',
          terminal_at: f.created,
          capability_ciphertext: Buffer.from('synthetic encrypted capability'),
        },
        { attempts: 6 },
      ])
        await expect(
          insert(f.pool, 'meeting_poll_deliveries', { ...delivery, ...overrides }),
        ).rejects.toMatchObject(checkViolation)
      await insert(f.pool, 'meeting_poll_deliveries', delivery)
      await expect(insert(f.pool, 'meeting_poll_deliveries', delivery)).rejects.toMatchObject({
        code: '23505',
      })
      await insert(f.pool, 'meeting_poll_deliveries', { ...delivery, sequence: 1 })
      await insert(f.pool, 'meeting_poll_deliveries', {
        ...delivery,
        kind: 'recovery',
        state: 'processing',
        attempts: 1,
        lease_id: randomUUID(),
        lease_until: f.deadline,
      })
      const host = { ...delivery, voter_id: null, host_user_id: f.user, kind: 'deadline_closed' }
      await insert(f.pool, 'meeting_poll_deliveries', host)
      await expect(insert(f.pool, 'meeting_poll_deliveries', host)).rejects.toMatchObject({
        code: '23505',
      })
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', { ...host, sequence: 1 }),
      ).rejects.toMatchObject(checkViolation)
    } finally {
      await owned.drop()
    }
  })

  it('bounds purpose-specific capabilities and preserves mailbox accounting across voter removal', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      const capability = {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        purpose: 'voting',
        token_digest: digest(),
        generation: 1,
        expires_at: f.deadline,
      }
      for (const overrides of [
        { generation: 0 },
        { purpose: 'manage' },
        { expires_at: new Date(new Date(f.deadline).getTime() + 1) },
        {
          revoked_at: f.created,
          capability_ciphertext: Buffer.from('synthetic encrypted capability'),
        },
      ])
        await expect(
          insert(f.pool, 'meeting_poll_capabilities', { ...capability, ...overrides }),
        ).rejects.toMatchObject(checkViolation)
      await insert(f.pool, 'meeting_poll_capabilities', capability)
      await insert(f.pool, 'meeting_poll_votes', {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        slot_id: f.slots[0],
        value: 'if_need_be',
      })
      await insert(f.pool, 'meeting_poll_deliveries', {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        kind: 'invitation',
        due_at: f.created,
      })
      const counter = await insert(f.pool, 'meeting_poll_mailbox_counters', {
        organization_id: f.organization,
        poll_id: f.poll,
        email_key: f.voterValues.email_key,
        resend_count: 2,
        last_resend_at: f.created,
        recovery_count: 3,
        last_recovery_at: f.created,
        reminder_consumed_at: f.created,
        reminder_opted_out_at: f.created,
      })
      const before = (
        await f.pool.query(
          'SELECT to_jsonb(t) AS row FROM meeting_poll_mailbox_counters t WHERE id=$1',
          [counter],
        )
      ).rows
      await expect(
        f.pool.query('DELETE FROM meeting_poll_voters WHERE id=$1', [f.voter]),
      ).resolves.toMatchObject({ rowCount: 1 })
      for (const table of [
        'meeting_poll_votes',
        'meeting_poll_capabilities',
        'meeting_poll_deliveries',
      ])
        expect(
          (await f.pool.query(`SELECT id FROM ${table} WHERE voter_id=$1`, [f.voter])).rows,
        ).toEqual([])
      expect(
        (
          await f.pool.query(
            'SELECT to_jsonb(t) AS row FROM meeting_poll_mailbox_counters t WHERE id=$1',
            [counter],
          )
        ).rows,
      ).toEqual(before)
      await insert(f.pool, 'meeting_poll_voters', f.voterValues)
      expect(
        (
          await f.pool.query(
            'SELECT to_jsonb(t) AS row FROM meeting_poll_mailbox_counters t WHERE id=$1',
            [counter],
          )
        ).rows,
      ).toEqual(before)
      await expect(
        f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization]),
      ).resolves.toMatchObject({ rowCount: 1 })
      for (const table of [
        'meeting_polls',
        'meeting_poll_slots',
        'meeting_poll_voters',
        'meeting_poll_votes',
        'meeting_poll_capabilities',
        'meeting_poll_mailbox_counters',
        'meeting_poll_operations',
        'meeting_poll_deliveries',
      ])
        expect(
          (await f.pool.query(`SELECT id FROM ${table} WHERE organization_id=$1`, [f.organization]))
            .rows,
        ).toEqual([])
    } finally {
      await owned.drop()
    }
  })

  it('clears obsolete verification ciphertext after verification and retains only replay tombstones on deletion', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      const pending = await insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        email_key: digest(),
        invited_at: null,
        created_at: f.created,
        pending_expires_at: new Date(new Date(f.created).getTime() + 3600_000),
        admission_ip_digest: digest(),
      })
      const credential = await insert(f.pool, 'meeting_poll_capabilities', {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: pending,
        purpose: 'verification',
        token_digest: digest(),
        capability_ciphertext: Buffer.from('synthetic purpose-bound ciphertext'),
        created_at: f.created,
        expires_at: new Date(new Date(f.created).getTime() + 3600_000),
      })
      await f.pool.query(
        'UPDATE meeting_poll_voters SET verified_at=clock_timestamp(),pending_expires_at=NULL,admission_ip_digest=NULL WHERE id=$1',
        [pending],
      )
      await f.pool.query(
        'UPDATE meeting_poll_capabilities SET capability_ciphertext=NULL,consumed_at=clock_timestamp(),revoked_at=clock_timestamp() WHERE id=$1',
        [credential],
      )
      expect(
        (
          await f.pool.query(
            'SELECT capability_ciphertext FROM meeting_poll_capabilities WHERE id=$1',
            [credential],
          )
        ).rows,
      ).toEqual([{ capability_ciphertext: null }])
      await f.pool.query(
        `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
        [f.slots[0], f.booking, f.poll],
      )
      const receipt = {
        organization_id: f.organization,
        poll_id: f.poll,
        booking_id: f.booking,
        operation: 'finalize',
        actor_scope_digest: digest(),
        idempotency_key_digest: digest(),
        request_fingerprint: digest(),
      }
      const operation = await insert(f.pool, 'meeting_poll_operations', receipt)
      await expect(insert(f.pool, 'meeting_poll_operations', receipt)).rejects.toMatchObject({
        code: '23505',
      })
      await expect(
        f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect(
        (await f.pool.query('SELECT id FROM meeting_polls WHERE id=$1', [f.poll])).rows,
      ).toEqual([])
      expect(
        (await f.pool.query('SELECT id FROM meeting_poll_voters WHERE poll_id=$1', [f.poll])).rows,
      ).toEqual([])
      const retained = (
        await f.pool.query(
          `SELECT poll_id,booking_id,purge_at>clock_timestamp()+interval '89 days' AS retained,actor_scope_digest,idempotency_key_digest,request_fingerprint FROM meeting_poll_operations WHERE id=$1`,
          [operation],
        )
      ).rows
      expect(retained).toEqual([
        {
          poll_id: null,
          booking_id: null,
          retained: true,
          actor_scope_digest: receipt.actor_scope_digest,
          idempotency_key_digest: receipt.idempotency_key_digest,
          request_fingerprint: receipt.request_fingerprint,
        },
      ])
    } finally {
      await owned.drop()
    }
  })
})

const checks: Record<string, (f: Fixture) => Promise<void>> = {
  ...meetingPollProtections,
  ...meetingPollSerializationChecks,
}

describe.skipIf(!serverUrl)('meeting poll storage protections', { timeout: 60_000 }, () => {
  let database: TestDatabase | undefined
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string, undefined, { tag: 'pollchecks' })
  }, 60_000)
  afterAll(() => database?.drop())

  it('compares only integrity rejections in savepoint probes and rethrows anything else', async () => {
    const pool = (database as TestDatabase).pool
    const f = await fixture(pool)
    const [rejected, accepted] = await attempts(pool, [
      { sql: 'UPDATE meeting_polls SET title=NULL WHERE id=$1', params: [f.poll] },
      { sql: 'SELECT 1' },
    ])
    expect(rejected).toMatchObject({ code: '23502', column: 'title' })
    expect(accepted).toBeUndefined()
    await expect(
      attempts(pool, [{ sql: 'SELECT 1' }, { sql: 'SELECT * FROM missing_relation' }]),
    ).rejects.toMatchObject({ code: '42P01' })
    expect(pool.totalCount).toBeLessThanOrEqual(3)
  })

  // One database, one fixture (own organizations, users and polls) per protection.
  it.each(Object.keys(checks))('enforces %s', async (name) => {
    const pool = (database as TestDatabase).pool
    await (checks[name] as (f: Fixture) => Promise<void>)(await fixture(pool))
    expect(pool.totalCount).toBeLessThanOrEqual(3)
  })
})

type Mutation = string | ((source: string) => string)
const voterGuardLock =
  'DECLARE parent meeting_polls; checked_at timestamptz; total integer;\nBEGIN\n  SELECT * INTO parent FROM meeting_polls WHERE id=NEW.poll_id AND organization_id=NEW.organization_id FOR UPDATE;'
const slotGuardLock =
  'DECLARE parent meeting_polls;\nBEGIN\n  SELECT * INTO parent FROM meeting_polls WHERE id=NEW.poll_id AND organization_id=NEW.organization_id FOR UPDATE;'
const replace =
  (before: string, after = '') =>
  (source: string) =>
    source.replace(before, () => after)

/**
 * Source-copy mutations: each one weakens 0071 and must make its protection check fail.
 * Dropping a whole catalog object is covered by meeting-polls-coverage.test.ts; these also
 * relax predicates and trigger-function clauses, which dropping objects cannot reach.
 */
const mutations: Record<string, { check: string; mutation: Mutation }> = {
  'deadline lower bound': {
    check: 'deadline lower bound',
    mutation: replace(
      "deadline_at BETWEEN created_at+interval '1 hour'",
      "deadline_at BETWEEN created_at+interval '1 minute'",
    ),
  },
  'deadline upper bound': {
    check: 'deadline upper bound',
    mutation: replace("created_at+interval '720 hours'", "created_at+interval '1000 hours'"),
  },
  'voter mailbox uniqueness': {
    check: 'mailbox uniqueness',
    mutation:
      'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_poll_id_email_key_key;',
  },
  'withdrawn privacy': {
    check: 'withdrawn privacy',
    mutation: 'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_withdrawn_pair;',
  },
  'creator deletion cascades': {
    check: 'creator deletion preserves team polls',
    mutation: replace(
      'created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL',
      'created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE CASCADE',
    ),
  },
  // Without their search_path pin, the deferred triggers run at Better Auth's commit cannot
  // find the public tables, and user deletion fails.
  'booking match trigger without search_path pin': {
    check: 'auth-only user deletion',
    mutation: replace(
      'CREATE FUNCTION check_meeting_poll_booking() RETURNS trigger\nLANGUAGE plpgsql SET search_path=public,pg_temp AS $$',
      'CREATE FUNCTION check_meeting_poll_booking() RETURNS trigger\nLANGUAGE plpgsql AS $$',
    ),
  },
  'candidate count trigger without search_path pin': {
    check: 'auth-only user deletion',
    mutation: replace(
      'CREATE FUNCTION check_meeting_poll_slot_count() RETURNS trigger\nLANGUAGE plpgsql SET search_path=public,pg_temp AS $$',
      'CREATE FUNCTION check_meeting_poll_slot_count() RETURNS trigger\nLANGUAGE plpgsql AS $$',
    ),
  },
  'unscoped candidate poll': {
    check: 'scoped candidate foreign key',
    mutation: replace(
      'CONSTRAINT meeting_poll_slots_poll_fk FOREIGN KEY(organization_id,poll_id)\n    REFERENCES meeting_polls(organization_id,id)',
      'CONSTRAINT meeting_poll_slots_poll_fk FOREIGN KEY(poll_id)\n    REFERENCES meeting_polls(id)',
    ),
  },
  'pending IP arm': {
    check: 'pending IP pair',
    mutation: replace('AND (pending_expires_at IS NULL)=(admission_ip_digest IS NULL)'),
  },
  'ballot pair': {
    check: 'ballot verification and consent',
    mutation: 'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_ballot_pair;',
  },
  'invited token': {
    check: 'invited poll token privacy',
    mutation: replace(
      "CHECK (admission_mode<>'invited' OR public_token_digest IS NULL)",
      'CHECK (true)',
    ),
  },
  'booking link uniqueness': {
    check: 'unique booking link',
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_booking_id_key;',
  },
  'verification beyond pending expiry': {
    check: 'verification expiry respects pending expiry',
    mutation: replace('pending IS NULL OR NEW.expires_at>pending', 'pending IS NULL'),
  },
  'verification for an invitee': {
    check: 'verification expiry respects pending expiry',
    mutation: replace('pending IS NULL OR NEW.expires_at>pending', 'NEW.expires_at>pending'),
  },
  'vote value': {
    check: 'vote value',
    mutation: 'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_value_check;',
  },
  'vote cell uniqueness': {
    check: 'unique vote cell',
    mutation:
      'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_poll_id_voter_id_slot_id_key;',
  },
  'source API key attribution': {
    check: 'source API key attribution',
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_source_api_key_check;',
  },
  'voter guard lock (enrollment)': {
    check: 'enrollment serialization',
    mutation: replace(voterGuardLock, voterGuardLock.replace(' FOR UPDATE;', ';')),
  },
  'voter guard lock (pending IP)': {
    check: 'pending IP serialization',
    mutation: replace(voterGuardLock, voterGuardLock.replace(' FOR UPDATE;', ';')),
  },
  'candidate guard lock': {
    check: 'candidate insert serialization',
    mutation: replace(slotGuardLock, slotGuardLock.replace(' FOR UPDATE;', ';')),
  },
  'candidate count lock': {
    check: 'candidate deletion serialization',
    mutation: replace(
      'PERFORM 1 FROM meeting_polls WHERE id=target FOR UPDATE;',
      'PERFORM 1 FROM meeting_polls WHERE id=target;',
    ),
  },
  'pending IP cap 4': {
    check: 'pending IP cap',
    mutation: replace('IF total>=3 THEN', 'IF total>=4 THEN'),
  },
  'pending IP cap across polls': {
    check: 'pending IP cap',
    mutation: replace(
      'FROM meeting_poll_voters WHERE poll_id=NEW.poll_id AND id<>NEW.id\n      AND pending_expires_at>checked_at AND admission_ip_digest',
      'FROM meeting_poll_voters WHERE id<>NEW.id\n      AND pending_expires_at>checked_at AND admission_ip_digest',
    ),
  },
  'recovery cap': {
    check: 'resend and recovery caps',
    mutation:
      'ALTER TABLE meeting_poll_mailbox_counters DROP CONSTRAINT meeting_poll_mailbox_counters_recovery_cap;',
  },
  'resend cap': {
    check: 'resend and recovery caps',
    mutation:
      'ALTER TABLE meeting_poll_mailbox_counters DROP CONSTRAINT meeting_poll_mailbox_counters_resend_cap;',
  },
  'capability guard': {
    check: 'capability expiry',
    mutation:
      'ALTER TABLE meeting_poll_capabilities DISABLE TRIGGER meeting_poll_capabilities_guard;',
  },
  'credential beyond the deadline': {
    check: 'capability expiry',
    mutation: replace('IF NEW.expires_at>deadline OR ', 'IF '),
  },
  'voting credential before the deadline': {
    check: 'capability expiry',
    mutation: replace("\n    OR (NEW.purpose='voting' AND NEW.expires_at<>deadline)"),
  },
  'booking match trigger': {
    check: 'booking match',
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_booking_match;',
  },
  'booking of another event': {
    check: 'booking match',
    mutation: replace(' AND b.event_type_id=NEW.event_type_id'),
  },
  'unscoped booking link': {
    check: 'scoped booking link',
    mutation: replace(
      'CONSTRAINT meeting_polls_booking_fk FOREIGN KEY(organization_id,booking_id)\n    REFERENCES bookings(organization_id,id),',
      'CONSTRAINT meeting_polls_booking_fk FOREIGN KEY(booking_id)\n    REFERENCES bookings(id),',
    ),
  },
  'candidate guard': {
    check: 'candidate immutability',
    mutation: 'ALTER TABLE meeting_poll_slots DISABLE TRIGGER meeting_poll_slots_guard;',
  },
  'candidate duration clause': {
    check: 'candidate duration',
    mutation: replace('NEW.end_at-NEW.start_at<>make_interval(mins=>parent.duration_minutes) OR '),
  },
  'candidate before the deadline': {
    check: 'candidates start after the deadline',
    mutation: replace(' OR NEW.start_at<=parent.deadline_at'),
  },
  'enrollment cap 41': {
    check: 'enrollment cap',
    mutation: replace('IF total>=40 THEN', 'IF total>=41 THEN'),
  },
  'expired reservations hold places': {
    check: 'expired reservations free enrollment places',
    mutation: replace(
      'AND (verified_at IS NOT NULL OR invited_at IS NOT NULL OR pending_expires_at>checked_at);',
      'AND (verified_at IS NOT NULL OR invited_at IS NOT NULL OR pending_expires_at IS NOT NULL);',
    ),
  },
  'pending reservation beyond the deadline': {
    check: 'pending reservations end by the deadline',
    mutation: replace('IF NEW.pending_expires_at>parent.deadline_at THEN', 'IF false THEN'),
  },
  'poll without candidates': {
    check: 'minimum candidate cap',
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_slot_count;',
  },
  'single remaining candidate': {
    check: 'minimum candidate cap',
    mutation: replace('total NOT BETWEEN 2 AND 20', 'total NOT BETWEEN 1 AND 20'),
  },
  'scheduled history trigger': {
    check: 'scheduled history immutability',
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_history;',
  },
  'scheduled booking reassignment': {
    check: 'scheduled history immutability',
    mutation: (source) =>
      source
        .replace(
          'NEW.chosen_slot_id,NEW.booking_id,NEW.scheduled_at',
          'NEW.chosen_slot_id,NEW.scheduled_at',
        )
        .replace(
          'OLD.chosen_slot_id,OLD.booking_id,OLD.scheduled_at',
          'OLD.chosen_slot_id,OLD.scheduled_at',
        ),
  },
  'unscoped vote voter': {
    check: 'scoped vote voter and candidate',
    mutation: 'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_voter_fk;',
  },
  'scheduled pair': {
    check: 'scheduled pair',
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_scheduled_pair;',
  },
  'chosen slot outside scheduling': {
    check: 'scheduled pair',
    mutation: replace("(status='scheduled')=(chosen_slot_id IS NOT NULL) AND\n    "),
  },
  'capability digest uniqueness': {
    check: 'unique capability digest',
    mutation: replace(
      'token_digest bytea NOT NULL UNIQUE CHECK',
      'token_digest bytea NOT NULL CHECK',
    ),
  },
  'mailbox counter uniqueness': {
    check: 'unique mailbox counter',
    mutation: replace('  UNIQUE(poll_id,email_key),\n'),
  },
  'short receipt retention': {
    check: 'poll deletion keeps only replay tombstones',
    mutation: replace("interval '90 days'", "interval '30 days'"),
  },
  'tombstone keeps booking reference': {
    check: 'linked booking deletion erases poll history',
    mutation: replace('SET poll_id=NULL,booking_id=NULL,', 'SET poll_id=NULL,'),
  },
  'verified voters uncounted': {
    check: 'enrollment cap counts every active voter',
    mutation: replace(
      'AND (verified_at IS NOT NULL OR invited_at IS NOT NULL OR pending_expires_at>checked_at);',
      'AND (invited_at IS NOT NULL OR pending_expires_at>checked_at);',
    ),
  },
  'live reservations uncounted': {
    check: 'enrollment cap counts every active voter',
    mutation: replace(
      'AND (verified_at IS NOT NULL OR invited_at IS NOT NULL OR pending_expires_at>checked_at);',
      'AND (verified_at IS NOT NULL OR invited_at IS NOT NULL);',
    ),
  },
  'new reservations skip the cap': {
    check: 'enrollment cap counts every active voter',
    mutation: replace(
      'NEW.invited_at IS NOT NULL OR NEW.pending_expires_at>checked_at) THEN',
      'NEW.invited_at IS NOT NULL) THEN',
    ),
  },
  'enrollment counts the updated voter': {
    check: 'enrollment cap on updates',
    mutation: replace(
      'WHERE poll_id=NEW.poll_id AND id<>NEW.id AND withdrawn_at IS NULL',
      'WHERE poll_id=NEW.poll_id AND withdrawn_at IS NULL',
    ),
  },
  'voter guard on inserts only': {
    check: 'enrollment cap on updates',
    mutation: replace(
      'BEFORE INSERT OR UPDATE ON meeting_poll_voters',
      'BEFORE INSERT ON meeting_poll_voters',
    ),
  },
  'pending IP cap ignores the address': {
    check: 'pending IP cap',
    mutation: replace(' AND admission_ip_digest=NEW.admission_ip_digest'),
  },
  'pending IP cap counts expired reservations': {
    check: 'expired reservations free pending IP places',
    mutation: replace(
      '\n      AND pending_expires_at>checked_at AND admission_ip_digest',
      '\n      AND admission_ip_digest',
    ),
  },
  'withdrawn enrollee keeps a reservation': {
    check: 'pending state pair',
    mutation: replace(
      '(verified_at IS NULL AND invited_at IS NULL AND withdrawn_at IS NULL)=',
      '(verified_at IS NULL AND invited_at IS NULL)=',
    ),
  },
  'capability guard on inserts only': {
    check: 'capability expiry',
    mutation: replace(
      'BEFORE INSERT OR UPDATE ON meeting_poll_capabilities',
      'BEFORE INSERT ON meeting_poll_capabilities',
    ),
  },
  'capability expiry updates skip the guard': {
    check: 'capability expiry',
    mutation: (source) =>
      source
        .replace('NEW.purpose,NEW.expires_at)', 'NEW.purpose)')
        .replace('OLD.purpose,OLD.expires_at)', 'OLD.purpose)'),
  },
  'booking end ignored': {
    check: 'booking match',
    mutation: replace(' AND b.end_at=s.end_at'),
  },
  'booking start ignored': {
    check: 'booking match',
    mutation: replace(' AND b.start_at=s.start_at'),
  },
  'booking match on updates only': {
    check: 'booking match',
    mutation: replace(
      'meeting_polls_booking_match AFTER INSERT OR UPDATE ON meeting_polls',
      'meeting_polls_booking_match AFTER UPDATE ON meeting_polls',
    ),
  },
  'candidate position mutable': {
    check: 'candidate immutability',
    mutation: (source) =>
      source
        .replace('NEW.end_at,NEW.position)', 'NEW.end_at)')
        .replace('OLD.end_at,OLD.position)', 'OLD.end_at)'),
  },
  'candidate moves between polls': {
    check: 'candidate immutability',
    mutation: (source) =>
      source
        .replace(
          '(NEW.poll_id,NEW.organization_id,NEW.start_at',
          '(NEW.organization_id,NEW.start_at',
        )
        .replace(
          '(OLD.poll_id,OLD.organization_id,OLD.start_at',
          '(OLD.organization_id,OLD.start_at',
        ),
  },
  'longer candidates': {
    check: 'candidate duration',
    mutation: replace(
      '<>make_interval(mins=>parent.duration_minutes)',
      '<make_interval(mins=>parent.duration_minutes)',
    ),
  },
  'chosen candidate deletion cascades': {
    check: 'scoped chosen candidate',
    mutation: replace(
      'REFERENCES meeting_poll_slots(organization_id,poll_id,id) DEFERRABLE',
      'REFERENCES meeting_poll_slots(organization_id,poll_id,id) ON DELETE CASCADE DEFERRABLE',
    ),
  },
  'longer mailbox digest': {
    check: 'voter column checks',
    mutation: replace('CHECK (octet_length(email_key)=32)', 'CHECK (octet_length(email_key)>=32)'),
  },
  'longer replay digest': {
    check: 'receipt column checks',
    mutation: replace(
      'CHECK (octet_length(request_fingerprint)=32)',
      'CHECK (octet_length(request_fingerprint)>=32)',
    ),
  },
  'unsafe error class characters': {
    check: 'delivery column checks',
    mutation: replace("'^[a-z][a-z0-9_]{0,63}$'", "'^[a-z][a-z0-9_@. -]{0,63}$'"),
  },
  'skipped delivery keeps no terminal time': {
    check: 'delivery recipient, lease and terminal pairs',
    mutation: replace(
      "CHECK ((state IN ('sent','suppressed','skipped'))=",
      "CHECK ((state IN ('sent','suppressed'))=",
    ),
  },
  'selected role without consent': {
    check: 'selected booking role',
    mutation: replace(
      'CHECK (selected_booking_role IS NULL OR (verified_at IS NOT NULL AND withdrawn_at IS NULL AND join_consent_at IS NOT NULL))',
      'CHECK (selected_booking_role IS NULL OR (verified_at IS NOT NULL AND withdrawn_at IS NULL))',
    ),
  },
  'selected role without verification': {
    check: 'selected booking role',
    mutation: replace(
      'CHECK (selected_booking_role IS NULL OR (verified_at IS NOT NULL AND withdrawn_at IS NULL AND join_consent_at IS NOT NULL))',
      'CHECK (selected_booking_role IS NULL OR (withdrawn_at IS NULL AND join_consent_at IS NOT NULL))',
    ),
  },
  'replay key includes the request': {
    check: 'unique replay key',
    mutation: replace(
      'UNIQUE(organization_id,operation,actor_scope_digest,idempotency_key_digest)',
      'UNIQUE(organization_id,operation,actor_scope_digest,idempotency_key_digest,request_fingerprint)',
    ),
  },
  'sent voter deliveries leave the identity': {
    check: 'voter delivery identity',
    mutation: replace(
      '(poll_id,voter_id,kind,generation,sequence) WHERE voter_id IS NOT NULL',
      "(poll_id,voter_id,kind,generation,sequence) WHERE voter_id IS NOT NULL AND state<>'sent'",
    ),
  },
  'host identity includes due time': {
    check: 'host delivery identity',
    mutation: replace(
      '(poll_id,host_user_id,kind,generation) WHERE',
      '(poll_id,host_user_id,kind,generation,due_at) WHERE',
    ),
  },
  'aggregate visibility by default': {
    check: 'privacy and lifecycle defaults',
    mutation: replace("DEFAULT 'private'", "DEFAULT 'aggregate'"),
  },
  'receipt poll reference cascades': {
    check: 'receipt poll references without the tombstone trigger',
    mutation: replace('ON DELETE SET NULL (poll_id)', 'ON DELETE CASCADE'),
  },
  'infinite capability expiry': {
    check: 'checks without triggers',
    mutation: replace(
      'CHECK (isfinite(expires_at) AND expires_at>created_at)',
      'CHECK (expires_at>created_at)',
    ),
  },
  'voter mailbox key includes the address': {
    check: 'mailbox uniqueness',
    mutation: replace('  UNIQUE (poll_id,email_key),', '  UNIQUE (poll_id,email_key,email),'),
  },
  'mailbox counter key includes removal': {
    check: 'unique mailbox counter',
    mutation: replace('  UNIQUE(poll_id,email_key),', '  UNIQUE(poll_id,email_key,removed_at),'),
  },
  'rotate-link receipts rejected': {
    check: 'every enumerated value is accepted',
    mutation: replace(
      "('create','invite','resend','rotate_link','finalize')",
      "('create','invite','resend','finalize')",
    ),
  },
}

// Every copy starts from a 0070 template and applies its own 0071 source. Tests run one at a
// time (the protection checks use the global expect); each runs its two copies in parallel.
describe.skipIf(!serverUrl)('meeting poll source-copy mutations', () => {
  let template: TestDatabaseTemplate | undefined
  let source: string
  beforeAll(async () => {
    const predecessors = await mkdtemp(join(tmpdir(), 'hourmere-poll-predecessors-'))
    try {
      await predecessorFiles(predecessors)
      template = await createTestDatabaseTemplate(
        serverUrl as string,
        async (pool) => {
          await runMigrations(pool, predecessors)
        },
        { tag: 'pollmut' },
      )
    } finally {
      await rm(predecessors, { recursive: true, force: true })
    }
    source = await readFile(join(migrationsDir, migration), 'utf8')
  }, 60_000)
  afterAll(() => template?.drop())

  async function run(sql: string, protection: (f: Fixture) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-poll-mutation-'))
    try {
      await writeFile(join(directory, migration), sql)
      const owned = await (template as TestDatabaseTemplate).clone(directory, { tag: 'pollmut' })
      try {
        await protection(await fixture(owned.pool))
        expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
      } finally {
        await owned.drop()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it.each(Object.keys(mutations))(
    'kills the %s mutation',
    async (name) => {
      const { check, mutation } = mutations[name] as (typeof mutations)[string]
      const protection = checks[check] as (f: Fixture) => Promise<void>
      const mutant = typeof mutation === 'string' ? `${source}\n${mutation}` : mutation(source)
      expect(mutant).not.toBe(source)
      const [original, mutated] = await Promise.allSettled([
        run(source, protection),
        run(mutant, protection),
      ])
      expect(original).toEqual({ status: 'fulfilled', value: undefined })
      expect(mutated).toMatchObject({
        status: 'rejected',
        reason: { name: 'AssertionError' },
      })
    },
    60_000,
  )
})
