import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0071_meeting_polls.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const digest = () => randomBytes(32)
type Connection = pg.Pool | pg.PoolClient

async function insert(db: Connection, table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return (
    await db.query<{ id: string }>(
      `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

async function transaction<T>(pool: pg.Pool, action: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

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

async function fixture(pool: pg.Pool) {
  const user = (
    await pool.query(
      `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ('Poll host',$1,true) RETURNING id`,
      [`${randomUUID()}@example.test`],
    )
  ).rows[0].id as string
  const organizations = (
    await pool.query(
      `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ('Poll team',$1,now()),('Other team',$2,now()) RETURNING id`,
      [randomUUID(), randomUUID()],
    )
  ).rows
  const organization = organizations[0].id as string
  const otherOrganization = organizations[1].id as string
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,'owner',now())`,
    [organization, user],
  )
  const event = await insert(pool, 'event_types', {
    organization_id: organization,
    slug: 'poll',
    title: 'Poll meeting',
    duration_minutes: 30,
  })
  const otherEvent = await insert(pool, 'event_types', {
    organization_id: otherOrganization,
    slug: 'other',
    title: 'Other meeting',
    duration_minutes: 30,
  })
  const clock = (
    await pool.query(
      `SELECT clock_timestamp() AS created,clock_timestamp()+interval '2 days' AS deadline,clock_timestamp()+interval '3 days' AS start`,
    )
  ).rows[0]
  const created = (clock.created as Date).toISOString()
  const deadline = (clock.deadline as Date).toISOString()
  const start = (clock.start as Date).toISOString()
  const end = new Date(new Date(start).getTime() + 30 * 60_000).toISOString()
  const pollValues = {
    organization_id: organization,
    event_type_id: event,
    created_by_user_id: user,
    title: 'Choose a time',
    duration_minutes: 30,
    display_time_zone: 'UTC',
    settings_snapshot: { title: 'Poll meeting' },
    settings_fingerprint: digest(),
    admission_mode: 'public_link',
    created_at: created,
    deadline_at: deadline,
  }
  const makePoll = (overrides: Record<string, unknown> = {}) =>
    transaction(pool, async (client) => {
      const poll = await insert(client, 'meeting_polls', { ...pollValues, ...overrides })
      const org = overrides.organization_id ?? organization
      const slots: string[] = []
      for (let position = 0; position < 2; position++)
        slots.push(
          await insert(client, 'meeting_poll_slots', {
            organization_id: org,
            poll_id: poll,
            start_at: new Date(new Date(start).getTime() + position * 3600_000),
            end_at: new Date(new Date(end).getTime() + position * 3600_000),
            position,
          }),
        )
      return { poll, slots }
    })
  const first = await makePoll()
  const second = await makePoll()
  const foreign = await makePoll({
    organization_id: otherOrganization,
    event_type_id: otherEvent,
    created_by_user_id: null,
  })
  const voterValues = {
    organization_id: organization,
    poll_id: first.poll,
    name: 'Voter',
    email: 'voter@example.test',
    email_key: digest(),
    time_zone: 'UTC',
    locale: 'en',
    invited_at: created,
  }
  const voter = await insert(pool, 'meeting_poll_voters', voterValues)
  const otherVoter = await insert(pool, 'meeting_poll_voters', {
    ...voterValues,
    organization_id: otherOrganization,
    poll_id: foreign.poll,
    email_key: digest(),
  })
  const booking = await insert(pool, 'bookings', {
    organization_id: organization,
    event_type_id: event,
    title: 'Selected meeting',
    source: 'web',
    start_at: start,
    end_at: end,
  })
  return {
    pool,
    user,
    organization,
    otherOrganization,
    event,
    otherEvent,
    created,
    deadline,
    start,
    end,
    pollValues,
    makePoll,
    ...first,
    second,
    foreign,
    voter,
    otherVoter,
    voterValues,
    booking,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function raceAtCapacity(f: Fixture, pending: boolean) {
  const poll = pending ? f.second.poll : f.poll
  const values = pending
    ? {
        ...f.voterValues,
        poll_id: poll,
        invited_at: null,
        created_at: f.created,
        pending_expires_at: new Date(new Date(f.created).getTime() + 3600_000),
        admission_ip_digest: digest(),
      }
    : f.voterValues
  for (let i = pending ? 0 : 1; i < (pending ? 2 : 39); i++)
    await insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() })
  const first = await f.pool.connect()
  const second = await f.pool.connect()
  try {
    await first.query('BEGIN')
    await second.query('BEGIN')
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    await insert(first, 'meeting_poll_voters', { ...values, email_key: digest() })
    let settled = false
    const contender = insert(second, 'meeting_poll_voters', {
      ...values,
      email_key: digest(),
    }).then(
      (id) => {
        settled = true
        return { status: 'fulfilled', id }
      },
      (reason) => {
        settled = true
        return { status: 'rejected', reason }
      },
    )
    let blocked = false
    for (let attempt = 0; attempt < 1_000 && !settled; attempt++) {
      await first.query('SELECT pg_stat_clear_snapshot()')
      blocked =
        (
          await first.query(
            "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.blocked === true
      if (blocked) break
      await setTimeout(5)
    }
    // Commit even if the lock disappears, so a mutation produces a real assertion
    // failure rather than leaking a client with a pending query.
    await first.query('COMMIT')
    const result = await contender
    expect(blocked).toBe(true)
    expect(result).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({
        code: '23514',
        constraint: pending ? 'meeting_poll_voters_ip_cap' : 'meeting_poll_voters_enrollment_cap',
      }),
    })
    await second.query('ROLLBACK')
    expect(
      (
        await first.query('SELECT count(*)::int AS n FROM meeting_poll_voters WHERE poll_id=$1', [
          poll,
        ])
      ).rows,
    ).toEqual([{ n: pending ? 3 : 40 }])
    expect(f.pool.totalCount).toBeLessThanOrEqual(2)
  } finally {
    await first.query('ROLLBACK')
    await second.query('ROLLBACK')
    first.release()
    second.release()
  }
}

const checkViolation = { code: '23514' }
const foreignKeyViolation = { code: '23503' }

const protections: Record<
  string,
  { assert: (f: Fixture) => Promise<void>; mutation: string | ((source: string) => string) }
> = {
  'deadline lower bound': {
    assert: async (f) => {
      await f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '1 hour' WHERE id=$1",
        [f.poll],
      )
      await expect(
        f.pool.query(
          "UPDATE meeting_polls SET deadline_at=created_at+interval '1 hour'-interval '1 millisecond' WHERE id=$1",
          [f.poll],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_deadline_cap' })
    },
    mutation: (source) =>
      source.replace(
        "deadline_at BETWEEN created_at+interval '1 hour'",
        "deadline_at BETWEEN created_at+interval '1 minute'",
      ),
  },
  'deadline upper bound': {
    assert: async (f) => {
      await f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '720 hours' WHERE id=$1",
        [f.poll],
      )
      await expect(
        f.pool.query(
          "UPDATE meeting_polls SET deadline_at=created_at+interval '720 hours'+interval '1 millisecond' WHERE id=$1",
          [f.poll],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_deadline_cap' })
    },
    mutation: (source) =>
      source.replace("created_at+interval '720 hours'", "created_at+interval '1000 hours'"),
  },
  'mailbox uniqueness': {
    assert: async (f) => {
      await insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, poll_id: f.second.poll })
      await expect(insert(f.pool, 'meeting_poll_voters', f.voterValues)).rejects.toMatchObject({
        code: '23505',
      })
    },
    mutation:
      'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_poll_id_email_key_key;',
  },
  'withdrawn privacy': {
    assert: async (f) => {
      for (const fields of [
        'responses=\'{"answer":"private"}\'::jsonb',
        'join_consent_at=clock_timestamp()',
      ])
        await expect(
          f.pool.query(
            `UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp(),${fields} WHERE id=$1`,
            [f.voter],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_withdrawn_pair' })
      // The pending/IP pair also forbids retaining a digest after withdrawal.
      await expect(
        f.pool.query(
          'UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp(),admission_ip_digest=$1 WHERE id=$2',
          [digest(), f.voter],
        ),
      ).rejects.toMatchObject(checkViolation)
      await f.pool.query(
        'UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1',
        [f.voter],
      )
      expect(
        (
          await f.pool.query(
            'SELECT responses,join_consent_at,admission_ip_digest,ballot_submitted_at FROM meeting_poll_voters WHERE id=$1',
            [f.voter],
          )
        ).rows,
      ).toEqual([
        {
          responses: {},
          join_consent_at: null,
          admission_ip_digest: null,
          ballot_submitted_at: null,
        },
      ])
    },
    mutation: 'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_withdrawn_pair;',
  },
  'creator deletion preserves team polls': {
    assert: async (f) => {
      await f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user])
      expect(
        (await f.pool.query('SELECT created_by_user_id FROM meeting_polls WHERE id=$1', [f.poll]))
          .rows,
      ).toEqual([{ created_by_user_id: null }])
      expect(
        (await f.pool.query('SELECT id FROM meeting_poll_slots WHERE poll_id=$1', [f.poll]))
          .rowCount,
      ).toBe(2)
    },
    mutation: (source) =>
      source.replace(
        'created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL',
        'created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE CASCADE',
      ),
  },
  'scoped candidate foreign key': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_slots', {
          organization_id: f.otherOrganization,
          poll_id: f.poll,
          position: 2,
          start_at: new Date(new Date(f.start).getTime() + 7200_000),
          end_at: new Date(new Date(f.end).getTime() + 7200_000),
        }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_poll_slots_poll_fk' })
    },
    mutation: (source) =>
      source.replace(
        'CONSTRAINT meeting_poll_slots_poll_fk FOREIGN KEY(organization_id,poll_id)\n    REFERENCES meeting_polls(organization_id,id)',
        'CONSTRAINT meeting_poll_slots_poll_fk FOREIGN KEY(poll_id)\n    REFERENCES meeting_polls(id)',
      ),
  },
  'pending IP pair': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_voters', {
          ...f.voterValues,
          email_key: digest(),
          invited_at: null,
          created_at: f.created,
          pending_expires_at: new Date(new Date(f.created).getTime() + 3600_000),
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
      await expect(
        f.pool.query(
          'UPDATE meeting_poll_voters SET verified_at=clock_timestamp(),admission_ip_digest=$1 WHERE id=$2',
          [digest(), f.voter],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
    },
    mutation: (source) =>
      source.replace('AND (pending_expires_at IS NULL)=(admission_ip_digest IS NULL)', ''),
  },
  'ballot verification and consent': {
    assert: async (f) => {
      for (const fields of ['join_consent_at=clock_timestamp()', 'verified_at=clock_timestamp()'])
        await expect(
          f.pool.query(
            `UPDATE meeting_poll_voters SET ballot_submitted_at=clock_timestamp(),${fields} WHERE id=$1`,
            [f.voter],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_ballot_pair' })
      await f.pool.query(
        'UPDATE meeting_poll_voters SET ballot_submitted_at=clock_timestamp(),verified_at=clock_timestamp(),join_consent_at=clock_timestamp() WHERE id=$1',
        [f.voter],
      )
    },
    mutation: 'ALTER TABLE meeting_poll_voters DROP CONSTRAINT meeting_poll_voters_ballot_pair;',
  },
  'invited poll token privacy': {
    assert: async (f) => {
      await f.makePoll({ admission_mode: 'invited' })
      await expect(
        f.makePoll({ admission_mode: 'invited', public_token_digest: digest() }),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation: (source) =>
      source.replace(
        "CHECK (admission_mode<>'invited' OR public_token_digest IS NULL)",
        'CHECK (true)',
      ),
  },
  'unique booking link': {
    assert: async (f) => {
      const schedule = (poll: string, slot: string) =>
        f.pool.query(
          "UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3",
          [slot, f.booking, poll],
        )
      await schedule(f.poll, f.slots[0] as string)
      await expect(schedule(f.second.poll, f.second.slots[0] as string)).rejects.toMatchObject({
        code: '23505',
      })
    },
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_booking_id_key;',
  },
  'verification expiry respects pending expiry': {
    assert: async (f) => {
      const expiry = new Date(new Date(f.created).getTime() + 3600_000)
      const voter = await insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        email_key: digest(),
        invited_at: null,
        created_at: f.created,
        pending_expires_at: expiry,
        admission_ip_digest: digest(),
      })
      const values = {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: voter,
        purpose: 'verification',
        created_at: f.created,
      }
      await insert(f.pool, 'meeting_poll_capabilities', {
        ...values,
        token_digest: digest(),
        expires_at: expiry,
      })
      await expect(
        insert(f.pool, 'meeting_poll_capabilities', {
          ...values,
          token_digest: digest(),
          expires_at: new Date(expiry.getTime() + 1),
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
    },
    mutation: (source) =>
      source.replace('pending IS NULL OR NEW.expires_at>pending', 'pending IS NULL'),
  },
  'vote value': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_votes', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: f.voter,
          slot_id: f.slots[0],
          value: 'maybe',
        }),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation: 'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_value_check;',
  },
  'unique vote cell': {
    assert: async (f) => {
      const vote = {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        slot_id: f.slots[0],
        value: 'yes',
      }
      await insert(f.pool, 'meeting_poll_votes', vote)
      await expect(
        insert(f.pool, 'meeting_poll_votes', { ...vote, value: 'no' }),
      ).rejects.toMatchObject({ code: '23505' })
    },
    mutation:
      'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_poll_id_voter_id_slot_id_key;',
  },
  'source API key attribution': {
    assert: async (f) => {
      for (const source of ['web', 'api', 'mcp']) await f.makePoll({ source })
      for (const source of ['api', 'mcp']) await f.makePoll({ source, api_key_id: randomUUID() })
      await expect(f.makePoll({ source: 'web', api_key_id: randomUUID() })).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_polls_source_api_key_check',
      })
    },
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_source_api_key_check;',
  },
  'enrollment serialization': {
    assert: (f) => raceAtCapacity(f, false),
    mutation: (source) =>
      source.replaceAll(
        'AND organization_id=NEW.organization_id FOR UPDATE;',
        'AND organization_id=NEW.organization_id;',
      ),
  },
  'pending IP serialization': {
    assert: (f) => raceAtCapacity(f, true),
    mutation: (source) =>
      source.replaceAll(
        'AND organization_id=NEW.organization_id FOR UPDATE;',
        'AND organization_id=NEW.organization_id;',
      ),
  },
  'pending IP cap': {
    assert: async (f) => {
      const values = {
        ...f.voterValues,
        invited_at: null,
        created_at: f.created,
        pending_expires_at: new Date(new Date(f.created).getTime() + 3600_000),
        admission_ip_digest: digest(),
      }
      for (let i = 0; i < 3; i++)
        await insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() })
      await expect(
        insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_ip_cap' })
    },
    mutation: 'ALTER TABLE meeting_poll_voters DISABLE TRIGGER meeting_poll_voters_guard;',
  },
  'recovery cap': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_mailbox_counters', {
          organization_id: f.organization,
          poll_id: f.poll,
          email_key: digest(),
          recovery_count: 4,
          last_recovery_at: f.created,
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_poll_mailbox_counters_recovery_cap',
      })
    },
    mutation:
      'ALTER TABLE meeting_poll_mailbox_counters DROP CONSTRAINT meeting_poll_mailbox_counters_recovery_cap;',
  },
  'capability expiry': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_capabilities', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: f.voter,
          purpose: 'voting',
          token_digest: digest(),
          expires_at: new Date(new Date(f.deadline).getTime() + 1),
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
    },
    mutation:
      'ALTER TABLE meeting_poll_capabilities DISABLE TRIGGER meeting_poll_capabilities_guard;',
  },
  'booking interval match': {
    assert: async (f) => {
      await expect(
        f.pool.query(
          `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
          [f.slots[1], f.booking, f.poll],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_booking_match' })
    },
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_booking_match;',
  },
  'candidate immutability': {
    assert: async (f) => {
      await expect(
        f.pool.query(
          `UPDATE meeting_poll_slots SET start_at=start_at+interval '1 minute',end_at=end_at+interval '1 minute' WHERE id=$1`,
          [f.slots[0]],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_immutable' })
    },
    mutation: 'ALTER TABLE meeting_poll_slots DISABLE TRIGGER meeting_poll_slots_guard;',
  },
  'candidate duration': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_slots', {
          organization_id: f.organization,
          poll_id: f.poll,
          position: 2,
          start_at: new Date(new Date(f.start).getTime() + 7200_000),
          end_at: new Date(new Date(f.start).getTime() + 7200_000 + 60_000),
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_interval' })
    },
    mutation: 'ALTER TABLE meeting_poll_slots DISABLE TRIGGER meeting_poll_slots_guard;',
  },
  'enrollment cap': {
    assert: async (f) => {
      for (let i = 1; i < 40; i++)
        await insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() })
      await expect(
        insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
    },
    mutation: 'ALTER TABLE meeting_poll_voters DISABLE TRIGGER meeting_poll_voters_guard;',
  },
  'minimum candidate cap': {
    assert: async (f) => {
      await expect(
        transaction(f.pool, (client) => insert(client, 'meeting_polls', f.pollValues)),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_slot_count;',
  },
  'scheduled history immutability': {
    assert: async (f) => {
      await f.pool.query(
        `UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3`,
        [f.slots[0], f.booking, f.poll],
      )
      await expect(
        f.pool.query('UPDATE meeting_polls SET chosen_slot_id=$1 WHERE id=$2', [
          f.slots[1],
          f.poll,
        ]),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation: 'ALTER TABLE meeting_polls DISABLE TRIGGER meeting_polls_history;',
  },
  'scoped voter foreign key': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_votes', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: f.otherVoter,
          slot_id: f.slots[0],
          value: 'yes',
        }),
      ).rejects.toMatchObject(foreignKeyViolation)
    },
    mutation: 'ALTER TABLE meeting_poll_votes DROP CONSTRAINT meeting_poll_votes_voter_fk;',
  },
  'scheduled pair': {
    assert: async (f) => {
      await expect(
        f.pool.query('UPDATE meeting_polls SET booking_id=$1 WHERE id=$2', [f.booking, f.poll]),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation: 'ALTER TABLE meeting_polls DROP CONSTRAINT meeting_polls_scheduled_pair;',
  },
  'resend cap': {
    assert: async (f) => {
      await expect(
        insert(f.pool, 'meeting_poll_mailbox_counters', {
          organization_id: f.organization,
          poll_id: f.poll,
          email_key: digest(),
          resend_count: 4,
          last_resend_at: f.created,
          purge_at: new Date(new Date(f.deadline).getTime() + 86400_000),
        }),
      ).rejects.toMatchObject(checkViolation)
    },
    mutation:
      'ALTER TABLE meeting_poll_mailbox_counters DROP CONSTRAINT meeting_poll_mailbox_counters_resend_cap;',
  },
}

describe.skipIf(!serverUrl)('meeting poll storage migration', () => {
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

  it.each(Object.keys(protections))(
    'enforces %s and kills its source-copy mutation',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-poll-mutation-'))
      try {
        await predecessorFiles(directory)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const protection = protections[name] as (typeof protections)[string]
        const check = async (sql: string) => {
          await writeFile(join(directory, migration), sql)
          const owned = await createTestDatabase(serverUrl as string, directory)
          try {
            await protection.assert(await fixture(owned.pool))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
          } finally {
            await owned.drop()
          }
        }
        await check(source)
        const mutant =
          typeof protection.mutation === 'string'
            ? `${source}\n${protection.mutation}`
            : protection.mutation(source)
        expect(mutant).not.toBe(source)
        await expect(check(mutant)).rejects.toMatchObject({
          name: 'AssertionError',
        })
        await check(source)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
