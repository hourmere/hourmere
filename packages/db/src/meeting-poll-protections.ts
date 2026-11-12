// Behavioural assertions for every protection in 0071_meeting_polls.sql. The migration test
// runs them one by one; the constraint-coverage test drops each catalog object in turn and
// requires one of them to fail. Each check builds its own fixture and touches only its rows.
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type pg from 'pg'
import { expect } from 'vitest'
import { openRelatedPool } from './testing/constraint-coverage.ts'
import { reuseConnectionsAfterErrors } from './testing.ts'

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
export const digest = (bytes = 32) => randomBytes(bytes)
type Connection = pg.Pool | pg.PoolClient
const hour = 3600_000
const checkViolation = { code: '23514' }

export async function insert(db: Connection, table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return (
    await db.query<{ id: string }>(
      `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

export async function transaction<T>(pool: pg.Pool, action: (client: pg.PoolClient) => Promise<T>) {
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

/**
 * Runs each statement in its own savepoint of one rolled-back transaction and returns the
 * integrity rejections; any other error (syntax, timeout, lost connection) is rethrown.
 */
export async function attempts(
  pool: pg.Pool,
  statements: { sql: string; params?: unknown[] }[],
  setup?: string,
): Promise<(pg.DatabaseError | undefined)[]> {
  const client = await pool.connect()
  const errors: (pg.DatabaseError | undefined)[] = []
  try {
    await client.query('BEGIN')
    if (setup) await client.query(setup)
    for (const statement of statements) {
      await client.query('SAVEPOINT attempt')
      try {
        await client.query(statement.sql, statement.params)
        errors.push(undefined)
      } catch (error) {
        // Only integrity rejections are outcomes to compare; anything else is a broken run.
        const code = (error as { code?: unknown }).code
        if (typeof code !== 'string' || !/^(23|22|P0)/.test(code)) throw error
        errors.push(error as pg.DatabaseError)
      }
      await client.query('ROLLBACK TO SAVEPOINT attempt')
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  return errors
}

function insertStatement(table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return {
    sql: `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    params: Object.values(values),
  }
}

const later = (instant: string | Date, milliseconds: number) =>
  new Date(new Date(instant).getTime() + milliseconds)

async function databaseNow(pool: pg.Pool) {
  return (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now as Date
}

export async function fixture(database: pg.Pool) {
  // Checks expect many failed statements; keep one connection instead of one per failure.
  const pool = reuseConnectionsAfterErrors(database)
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
  const end = later(start, 30 * 60_000).toISOString()
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
            start_at: later(start, position * hour),
            end_at: later(end, position * hour),
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
export type Fixture = Awaited<ReturnType<typeof fixture>>

const pendingVoter = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  ...f.voterValues,
  email_key: digest(),
  invited_at: null,
  created_at: f.created,
  pending_expires_at: later(f.created, hour),
  admission_ip_digest: digest(),
  ...overrides,
})

const schedule = (f: Fixture, poll: string, slot: string, booking: string) =>
  f.pool.query(
    "UPDATE meeting_polls SET status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1,booking_id=$2 WHERE id=$3",
    [slot, booking, poll],
  )

const receipt = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  organization_id: f.organization,
  poll_id: f.poll,
  operation: 'create',
  actor_scope_digest: digest(),
  idempotency_key_digest: digest(),
  request_fingerprint: digest(),
  ...overrides,
})

const voterDelivery = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  organization_id: f.organization,
  poll_id: f.poll,
  voter_id: f.voter,
  kind: 'invitation',
  generation: 1,
  due_at: f.created,
  ...overrides,
})

const hostDelivery = (f: Fixture, overrides: Record<string, unknown> = {}) =>
  voterDelivery(f, { voter_id: null, host_user_id: f.user, kind: 'deadline_closed', ...overrides })

const votingCapability = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  organization_id: f.organization,
  poll_id: f.poll,
  voter_id: f.voter,
  purpose: 'voting',
  token_digest: digest(),
  generation: 1,
  created_at: f.created,
  expires_at: f.deadline,
  ...overrides,
})

const counter = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  organization_id: f.organization,
  poll_id: f.poll,
  email_key: digest(),
  ...overrides,
})

async function bookingAt(f: Fixture, organization: string, event: string, start = f.start) {
  return insert(f.pool, 'bookings', {
    organization_id: organization,
    event_type_id: event,
    title: 'Another meeting',
    source: 'web',
    start_at: start,
    end_at: later(start, 30 * 60_000),
  })
}

/** A boundary that must stay accepted: a relaxation or a stray rejection fails an assertion. */
const accept = (operation: Promise<unknown>, label?: string) =>
  expect(operation, label).resolves.toBeDefined()

/** Each statement must fail with the named CHECK; the accepted ones must then succeed. */
async function expectChecks(
  f: Fixture,
  table: string,
  id: string,
  rejected: [assignment: string, constraint: string, params?: unknown[]][],
  accepted: [assignment: string, params?: unknown[]][] = [],
) {
  for (const [assignment, constraint, params = []] of rejected)
    await expect(
      f.pool.query(`UPDATE ${quote(table)} SET ${assignment} WHERE id=$${params.length + 1}`, [
        ...params,
        id,
      ]),
      assignment,
    ).rejects.toMatchObject({ code: '23514', constraint })
  for (const [assignment, params = []] of accepted)
    await accept(
      f.pool.query(`UPDATE ${quote(table)} SET ${assignment} WHERE id=$${params.length + 1}`, [
        ...params,
        id,
      ]),
    )
}

/** Columns 0071 declares NOT NULL, outside primary keys. */
const requiredColumns: Record<string, string[]> = {
  meeting_polls: [
    'organization_id',
    'event_type_id',
    'source',
    'title',
    'duration_minutes',
    'display_time_zone',
    'settings_snapshot',
    'settings_fingerprint',
    'admission_mode',
    'visibility',
    'deadline_at',
    'status',
    'host_revision',
    'results_revision',
    'created_at',
    'updated_at',
  ],
  meeting_poll_slots: [
    'organization_id',
    'poll_id',
    'start_at',
    'end_at',
    'position',
    'created_at',
    'updated_at',
  ],
  meeting_poll_voters: [
    'organization_id',
    'poll_id',
    'name',
    'email',
    'email_key',
    'time_zone',
    'locale',
    'responses',
    'ballot_revision',
    'created_at',
    'updated_at',
  ],
  meeting_poll_votes: [
    'organization_id',
    'poll_id',
    'voter_id',
    'slot_id',
    'value',
    'created_at',
    'updated_at',
  ],
  meeting_poll_capabilities: [
    'organization_id',
    'poll_id',
    'voter_id',
    'purpose',
    'token_digest',
    'generation',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  meeting_poll_mailbox_counters: [
    'organization_id',
    'poll_id',
    'email_key',
    'resend_count',
    'recovery_count',
    'created_at',
    'updated_at',
  ],
  meeting_poll_operations: [
    'organization_id',
    'operation',
    'actor_scope_digest',
    'idempotency_key_digest',
    'request_fingerprint',
    'created_at',
    'updated_at',
  ],
  meeting_poll_deliveries: [
    'organization_id',
    'poll_id',
    'kind',
    'generation',
    'sequence',
    'due_at',
    'state',
    'attempts',
    'created_at',
    'updated_at',
  ],
}

/** Index shapes from the design: supporting indexes have no other behaviour to assert. */
const designIndexes: Record<string, string> = {
  meeting_poll_capabilities_expiry:
    'CREATE INDEX meeting_poll_capabilities_expiry ON public.meeting_poll_capabilities USING btree (expires_at, id) WHERE (capability_ciphertext IS NOT NULL)',
  meeting_poll_capabilities_voter:
    'CREATE INDEX meeting_poll_capabilities_voter ON public.meeting_poll_capabilities USING btree (poll_id, voter_id)',
  meeting_poll_deliveries_claims:
    "CREATE INDEX meeting_poll_deliveries_claims ON public.meeting_poll_deliveries USING btree (lease_until, id) WHERE (state = 'processing'::text)",
  meeting_poll_deliveries_due:
    "CREATE INDEX meeting_poll_deliveries_due ON public.meeting_poll_deliveries USING btree (due_at, id) WHERE (state = 'pending'::text)",
  meeting_poll_deliveries_host_identity:
    'CREATE UNIQUE INDEX meeting_poll_deliveries_host_identity ON public.meeting_poll_deliveries USING btree (poll_id, host_user_id, kind, generation) WHERE (host_user_id IS NOT NULL)',
  meeting_poll_deliveries_host_idx:
    'CREATE INDEX meeting_poll_deliveries_host_idx ON public.meeting_poll_deliveries USING btree (host_user_id)',
  meeting_poll_deliveries_voter_identity:
    'CREATE UNIQUE INDEX meeting_poll_deliveries_voter_identity ON public.meeting_poll_deliveries USING btree (poll_id, voter_id, kind, generation, sequence) WHERE (voter_id IS NOT NULL)',
  meeting_poll_operations_cleanup:
    'CREATE INDEX meeting_poll_operations_cleanup ON public.meeting_poll_operations USING btree (purge_at, id) WHERE (purge_at IS NOT NULL)',
  meeting_poll_operations_poll:
    'CREATE INDEX meeting_poll_operations_poll ON public.meeting_poll_operations USING btree (poll_id)',
  meeting_poll_slots_start:
    'CREATE INDEX meeting_poll_slots_start ON public.meeting_poll_slots USING btree (poll_id, start_at)',
  meeting_poll_voters_expiry:
    'CREATE INDEX meeting_poll_voters_expiry ON public.meeting_poll_voters USING btree (poll_id, pending_expires_at)',
  meeting_poll_voters_roster:
    'CREATE INDEX meeting_poll_voters_roster ON public.meeting_poll_voters USING btree (poll_id, verified_at)',
  meeting_poll_votes_tally:
    'CREATE INDEX meeting_poll_votes_tally ON public.meeting_poll_votes USING btree (poll_id, slot_id, value)',
  meeting_polls_creator_idx:
    'CREATE INDEX meeting_polls_creator_idx ON public.meeting_polls USING btree (created_by_user_id)',
  meeting_polls_deadline:
    "CREATE INDEX meeting_polls_deadline ON public.meeting_polls USING btree (deadline_at, id) WHERE (status = 'open'::text)",
  meeting_polls_page:
    'CREATE INDEX meeting_polls_page ON public.meeting_polls USING btree (organization_id, created_at, id)',
}

export async function raceAtCapacity(f: Fixture, pending: boolean) {
  const poll = pending ? f.second.poll : f.poll
  const values = pending ? pendingVoter(f, { poll_id: poll }) : f.voterValues
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

/** Starts `second` while `first` holds its transaction open and reports whether it waited. */
async function contend(
  f: Fixture,
  first: (client: pg.PoolClient) => Promise<unknown>,
  second: (client: pg.PoolClient) => Promise<unknown>,
) {
  const holder = await f.pool.connect()
  const waiter = await f.pool.connect()
  try {
    await holder.query('BEGIN')
    await waiter.query('BEGIN')
    const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    await first(holder)
    let settled = false
    const outcome = second(waiter).then(
      () => {
        settled = true
        return { status: 'fulfilled' as const, reason: undefined }
      },
      (reason: unknown) => {
        settled = true
        return { status: 'rejected' as const, reason }
      },
    )
    let blocked = false
    for (let attempt = 0; attempt < 1_000 && !settled; attempt++) {
      await holder.query('SELECT pg_stat_clear_snapshot()')
      blocked =
        (
          await holder.query(
            "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.blocked === true
      if (blocked) break
      await setTimeout(5)
    }
    if (settled) {
      // The second transaction did not wait. Commit both at once: without the expected lock,
      // each commit can need a row lock the other holds, and PostgreSQL then aborts one.
      const result = await outcome
      await Promise.allSettled([
        holder.query('COMMIT'),
        result.status === 'fulfilled' ? waiter.query('COMMIT') : Promise.resolve(),
      ])
      return { blocked, ...result }
    }
    await holder.query('COMMIT')
    const result = await outcome
    if (result.status === 'fulfilled') await waiter.query('COMMIT')
    return { blocked, ...result }
  } finally {
    await holder.query('ROLLBACK')
    await waiter.query('ROLLBACK')
    holder.release()
    waiter.release()
  }
}

/** Lock-order checks; slower, so the coverage suite (which drops catalog objects) omits them. */
export const meetingPollSerializationChecks: Record<string, (f: Fixture) => Promise<void>> = {
  'enrollment serialization': (f) => raceAtCapacity(f, false),
  'pending IP serialization': (f) => raceAtCapacity(f, true),
  'candidate insert serialization': async (f) => {
    const slot = (position: number) => (client: pg.PoolClient) =>
      insert(client, 'meeting_poll_slots', {
        organization_id: f.organization,
        poll_id: f.poll,
        position,
        start_at: later(f.start, position * hour),
        end_at: later(f.end, position * hour),
      })
    const result = await contend(f, slot(2), slot(3))
    expect(result).toMatchObject({ blocked: true, status: 'fulfilled' })
  },
  'candidate deletion serialization': async (f) => {
    await insert(f.pool, 'meeting_poll_slots', {
      organization_id: f.organization,
      poll_id: f.poll,
      position: 2,
      start_at: later(f.start, 2 * hour),
      end_at: later(f.end, 2 * hour),
    })
    const slots = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM meeting_poll_slots WHERE poll_id=$1 ORDER BY position',
        [f.poll],
      )
    ).rows.map((row) => row.id)
    // Each deletion leaves two candidates on its own; the poll lock makes the second see both.
    const remove = (id: string | undefined) => async (client: pg.PoolClient) => {
      await client.query('DELETE FROM meeting_poll_slots WHERE id=$1', [id])
      await client.query('SET CONSTRAINTS meeting_poll_slots_count IMMEDIATE')
    }
    const result = await contend(f, remove(slots[0]), remove(slots[1]))
    expect(result).toMatchObject({
      blocked: true,
      status: 'rejected',
      reason: expect.objectContaining({
        code: '23514',
        constraint: 'meeting_poll_slots_count_cap',
      }),
    })
    expect(
      (
        await f.pool.query('SELECT count(*)::int AS n FROM meeting_poll_slots WHERE poll_id=$1', [
          f.poll,
        ])
      ).rows,
    ).toEqual([{ n: 2 }])
  },
}

export const meetingPollProtections: Record<string, (f: Fixture) => Promise<void>> = {
  // Broad structural checks first: they fail fastest when a column or index is dropped.
  'required columns': async (f) => {
    const rows: Record<string, Record<string, unknown>> = {
      meeting_polls: {
        ...f.pollValues,
        source: 'web',
        visibility: 'private',
        status: 'open',
        host_revision: 1,
        results_revision: 1,
      },
      meeting_poll_slots: {
        organization_id: f.organization,
        poll_id: f.poll,
        start_at: later(f.start, 10 * hour),
        end_at: later(f.end, 10 * hour),
        position: 5,
      },
      meeting_poll_voters: {
        ...f.voterValues,
        email_key: digest(),
        responses: {},
        ballot_revision: 0,
      },
      meeting_poll_votes: {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        slot_id: f.slots[0],
        value: 'yes',
      },
      meeting_poll_capabilities: votingCapability(f),
      meeting_poll_mailbox_counters: counter(f, { resend_count: 0, recovery_count: 0 }),
      meeting_poll_operations: receipt(f),
      meeting_poll_deliveries: voterDelivery(f, { sequence: 0, state: 'pending', attempts: 0 }),
    }
    const probes = Object.entries(requiredColumns).flatMap(([table, columns]) =>
      columns.map((column) => ({ table, column })),
    )
    const errors = await attempts(
      f.pool,
      probes.map(({ table, column }) =>
        insertStatement(table, {
          ...rows[table],
          created_at: f.created,
          updated_at: f.created,
          [column]: null,
        }),
      ),
    )
    expect(
      probes.flatMap(({ table, column }, i) =>
        errors[i]?.code === '23502' && errors[i]?.column === column
          ? []
          : [`${table}.${column}: ${errors[i]?.code ?? 'accepted'}`],
      ),
    ).toEqual([])
  },
  'design indexes': async (f) => {
    const rows = (
      await f.pool.query<{ indexname: string; indexdef: string }>(
        'SELECT indexname,indexdef FROM pg_indexes WHERE indexname=ANY($1) ORDER BY indexname',
        [Object.keys(designIndexes)],
      )
    ).rows
    expect(Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]))).toEqual(
      designIndexes,
    )
  },

  // Polls.
  'poll identity': async (f) => {
    await expect(
      f.makePoll({
        id: f.poll,
        organization_id: f.otherOrganization,
        event_type_id: f.otherEvent,
        created_by_user_id: null,
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_polls_pkey' })
  },
  'poll column checks': async (f) => {
    await expectChecks(
      f,
      'meeting_polls',
      f.poll,
      [
        ["source='cli'", 'meeting_polls_source_check'],
        ['duration_minutes=0', 'meeting_polls_duration_minutes_check'],
        ['duration_minutes=1441', 'meeting_polls_duration_minutes_check'],
        ["settings_snapshot='[]'::jsonb", 'meeting_polls_settings_snapshot_check'],
        ['settings_fingerprint=$1', 'meeting_polls_settings_fingerprint_check', [digest(31)]],
        ['settings_fingerprint=$1', 'meeting_polls_settings_fingerprint_check', [digest(33)]],
        ["admission_mode='open'", 'meeting_polls_admission_mode_check'],
        ["visibility='public'", 'meeting_polls_visibility_check'],
        ["status='draft'", 'meeting_polls_status_check'],
        ['public_token_digest=$1', 'meeting_polls_public_token_digest_check', [digest(16)]],
        ['public_token_digest=$1', 'meeting_polls_public_token_digest_check', [digest(33)]],
        ['host_revision=0', 'meeting_polls_host_revision_check'],
        ['results_revision=0', 'meeting_polls_results_revision_check'],
      ],
      [
        ['duration_minutes=1440'],
        ['duration_minutes=1'],
        ["visibility='aggregate'"],
        ["settings_snapshot='{}'::jsonb"],
        ['host_revision=2,results_revision=3'],
        ['public_token_digest=$1', [digest()]],
      ],
    )
  },
  'privacy and lifecycle defaults': async (f) => {
    expect(
      (
        await f.pool.query(
          'SELECT source,visibility,status,host_revision,results_revision,api_key_id,public_token_digest FROM meeting_polls WHERE id=$1',
          [f.poll],
        )
      ).rows,
    ).toEqual([
      {
        source: 'web',
        visibility: 'private',
        status: 'open',
        host_revision: 1,
        results_revision: 1,
        api_key_id: null,
        public_token_digest: null,
      },
    ])
    expect(
      (
        await f.pool.query(
          'SELECT responses,ballot_revision,selected_booking_role,verified_at FROM meeting_poll_voters WHERE id=$1',
          [f.voter],
        )
      ).rows,
    ).toEqual([
      { responses: {}, ballot_revision: 0, selected_booking_role: null, verified_at: null },
    ])
    const delivery = await insert(f.pool, 'meeting_poll_deliveries', {
      organization_id: f.organization,
      poll_id: f.poll,
      voter_id: f.voter,
      kind: 'invitation',
    })
    expect(
      (
        await f.pool.query(
          'SELECT generation,sequence,state,attempts,due_at<=clock_timestamp() AS due FROM meeting_poll_deliveries WHERE id=$1',
          [delivery],
        )
      ).rows,
    ).toEqual([{ generation: 1, sequence: 0, state: 'pending', attempts: 0, due: true }])
    const capability = await insert(f.pool, 'meeting_poll_capabilities', {
      organization_id: f.organization,
      poll_id: f.poll,
      voter_id: f.voter,
      purpose: 'voting',
      token_digest: digest(),
      expires_at: f.deadline,
    })
    const mailbox = await insert(f.pool, 'meeting_poll_mailbox_counters', counter(f))
    expect(
      (
        await f.pool.query(
          'SELECT c.generation,m.resend_count,m.recovery_count FROM meeting_poll_capabilities c,meeting_poll_mailbox_counters m WHERE c.id=$1 AND m.id=$2',
          [capability, mailbox],
        )
      ).rows,
    ).toEqual([{ generation: 1, resend_count: 0, recovery_count: 0 }])
  },
  'deadline lower bound': async (f) => {
    await accept(
      f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '1 hour' WHERE id=$1",
        [f.poll],
      ),
    )
    await expect(
      f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '1 hour'-interval '1 millisecond' WHERE id=$1",
        [f.poll],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_deadline_cap' })
  },
  'deadline upper bound': async (f) => {
    await accept(
      f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '720 hours' WHERE id=$1",
        [f.poll],
      ),
    )
    await expect(
      f.pool.query(
        "UPDATE meeting_polls SET deadline_at=created_at+interval '720 hours'+interval '1 millisecond' WHERE id=$1",
        [f.poll],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_deadline_cap' })
    await expect(
      f.pool.query("UPDATE meeting_polls SET deadline_at='infinity' WHERE id=$1", [f.poll]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_deadline_cap' })
  },
  'creator deletion preserves team polls': async (f) => {
    await expect(f.makePoll({ created_by_user_id: randomUUID() })).rejects.toMatchObject({
      code: '23503',
      constraint: 'meeting_polls_created_by_user_id_fkey',
    })
    const notice = await insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f))
    await accept(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.user]))
    expect(
      (await f.pool.query('SELECT created_by_user_id FROM meeting_polls WHERE id=$1', [f.poll]))
        .rows,
    ).toEqual([{ created_by_user_id: null }])
    expect(
      (await f.pool.query('SELECT id FROM meeting_poll_slots WHERE poll_id=$1', [f.poll])).rowCount,
    ).toBe(2)
    expect(
      (await f.pool.query('SELECT id FROM meeting_poll_deliveries WHERE id=$1', [notice])).rows,
    ).toEqual([])
  },
  'auth-only user deletion': async (f) => {
    // Better Auth deletes users over a pool whose search_path is only `auth`
    // (docs/data-model.md). The deferred constraint triggers that its commit runs must still
    // find the public tables, which is what the functions' own `SET search_path` provides.
    const personalUser = (
      await f.pool.query(
        `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ('Personal host',$1,true) RETURNING id`,
        [`${randomUUID()}@example.test`],
      )
    ).rows[0].id as string
    const personalOrganization = (
      await f.pool.query(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ('Personal space',$1,now()) RETURNING id`,
        [randomUUID()],
      )
    ).rows[0].id as string
    await f.pool.query(
      `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,'owner',now())`,
      [personalOrganization, personalUser],
    )
    await f.pool.query(
      'INSERT INTO personal_organizations (user_id,organization_id) VALUES ($1,$2)',
      [personalUser, personalOrganization],
    )
    const personalEvent = await insert(f.pool, 'event_types', {
      organization_id: personalOrganization,
      slug: 'personal-poll',
      title: 'Personal poll',
      duration_minutes: 30,
    })
    const personal = await f.makePoll({
      organization_id: personalOrganization,
      event_type_id: personalEvent,
      created_by_user_id: personalUser,
    })
    const personalReceipt = await insert(
      f.pool,
      'meeting_poll_operations',
      receipt(f, { organization_id: personalOrganization, poll_id: personal.poll }),
    )
    await bookingAt(f, personalOrganization, personalEvent)
    const teamReceipt = await insert(f.pool, 'meeting_poll_operations', receipt(f))
    const notice = await insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f))

    const authUrl = new URL(f.pool.options.connectionString as string)
    authUrl.searchParams.set('options', '-c search_path=auth')
    // Opened through the coverage helper, so its query errors take part in the verdict.
    const authOnly = openRelatedPool(f.pool, authUrl.toString())
    try {
      // (a) The creator of a team poll: the poll stays, attributed to nobody.
      await accept(authOnly.query('DELETE FROM "user" WHERE id=$1', [f.user]), 'team poll creator')
      // (b) The owner of a personal space: the space and its poll go with the user.
      await accept(
        authOnly.query('DELETE FROM "user" WHERE id=$1', [personalUser]),
        'personal-space poll owner',
      )
    } finally {
      await authOnly.end()
    }
    expect(
      (
        await f.pool.query(
          `SELECT (SELECT count(*)::int FROM auth."user" WHERE id=ANY($1)) AS users,
                  (SELECT count(*)::int FROM auth.organization WHERE id=$2) AS spaces,
                  (SELECT count(*)::int FROM meeting_polls WHERE id=$3) AS personal_polls,
                  (SELECT count(*)::int FROM meeting_poll_slots WHERE poll_id=$3) AS personal_slots,
                  (SELECT count(*)::int FROM meeting_poll_slots WHERE poll_id=$4) AS team_slots,
                  (SELECT count(*)::int FROM meeting_poll_deliveries WHERE id=$5) AS notices`,
          [[f.user, personalUser], personalOrganization, personal.poll, f.poll, notice],
        )
      ).rows,
    ).toEqual([
      { users: 0, spaces: 0, personal_polls: 0, personal_slots: 0, team_slots: 2, notices: 0 },
    ])
    expect(
      (await f.pool.query('SELECT created_by_user_id FROM meeting_polls WHERE id=$1', [f.poll]))
        .rows,
    ).toEqual([{ created_by_user_id: null }])
    // The team receipt keeps its poll; the personal space's receipt went with the organization.
    expect(
      (
        await f.pool.query(
          'SELECT id,poll_id,booking_id FROM meeting_poll_operations WHERE id=ANY($1)',
          [[teamReceipt, personalReceipt]],
        )
      ).rows,
    ).toEqual([{ id: teamReceipt, poll_id: f.poll, booking_id: null }])
  },
  'unique public link': async (f) => {
    const token = digest()
    await accept(f.makePoll({ public_token_digest: token }))
    // Only the digest is shared: another title, visibility and event still collide.
    const event = await insert(f.pool, 'event_types', {
      organization_id: f.organization,
      slug: 'linked',
      title: 'Linked meeting',
      duration_minutes: 30,
    })
    await expect(
      f.makePoll({
        public_token_digest: token,
        title: 'Another poll',
        visibility: 'aggregate',
        event_type_id: event,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_polls_public_token_digest_key',
    })
  },
  'invited poll token privacy': async (f) => {
    await accept(f.makePoll({ admission_mode: 'invited' }))
    await expect(
      f.makePoll({ admission_mode: 'invited', public_token_digest: digest() }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_check' })
  },
  'source API key attribution': async (f) => {
    for (const source of ['web', 'api', 'mcp']) await accept(f.makePoll({ source }), source)
    for (const source of ['api', 'mcp'])
      await accept(f.makePoll({ source, api_key_id: randomUUID() }), source)
    await expect(f.makePoll({ source: 'web', api_key_id: randomUUID() })).rejects.toMatchObject({
      code: '23514',
      constraint: 'meeting_polls_source_api_key_check',
    })
  },
  'event scope and deletion': async (f) => {
    await expect(f.makePoll({ event_type_id: f.otherEvent })).rejects.toMatchObject({
      code: '23503',
      constraint: 'meeting_polls_event_fk',
    })
    const event = await insert(f.pool, 'event_types', {
      organization_id: f.organization,
      slug: 'retired',
      title: 'Retired meeting',
      duration_minutes: 30,
    })
    const { poll } = await f.makePoll({ event_type_id: event })
    await accept(f.pool.query('DELETE FROM event_types WHERE id=$1', [event]))
    expect((await f.pool.query('SELECT id FROM meeting_polls WHERE id=$1', [poll])).rows).toEqual(
      [],
    )
  },
  'lifecycle pairs': async (f) => {
    for (const assignment of [
      "status='closed'",
      'closed_at=clock_timestamp()',
      "status='canceled'",
      'canceled_at=clock_timestamp()',
    ])
      await expect(
        f.pool.query(`UPDATE meeting_polls SET ${assignment} WHERE id=$1`, [f.poll]),
        assignment,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_lifecycle_pair' })
    await accept(
      f.pool.query(
        "UPDATE meeting_polls SET status='closed',closed_at=clock_timestamp() WHERE id=$1",
        [f.poll],
      ),
    )
    await accept(
      f.pool.query(
        "UPDATE meeting_polls SET status='canceled',canceled_at=clock_timestamp() WHERE id=$1",
        [f.second.poll],
      ),
    )
  },
  'scheduled pair': async (f) => {
    for (const [assignment, params] of [
      ['booking_id=$1', [f.booking]],
      ['chosen_slot_id=$1', [f.slots[0]]],
      ['scheduled_at=clock_timestamp()', []],
      ["status='scheduled'", []],
      ["status='scheduled',scheduled_at=clock_timestamp(),booking_id=$1", [f.booking]],
      ["status='scheduled',scheduled_at=clock_timestamp(),chosen_slot_id=$1", [f.slots[0]]],
    ] as const)
      await expect(
        f.pool.query(`UPDATE meeting_polls SET ${assignment} WHERE id=$${params.length + 1}`, [
          ...params,
          f.poll,
        ]),
        assignment,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_scheduled_pair' })
    await accept(schedule(f, f.poll, f.slots[0] as string, f.booking))
  },
  'unique booking link': async (f) => {
    await accept(schedule(f, f.poll, f.slots[0] as string, f.booking))
    await expect(
      schedule(f, f.second.poll, f.second.slots[0] as string, f.booking),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_polls_booking_id_key' })
  },
  'scoped booking link': async (f) => {
    const foreignBooking = await bookingAt(f, f.otherOrganization, f.otherEvent)
    await expect(schedule(f, f.poll, f.slots[0] as string, foreignBooking)).rejects.toMatchObject({
      code: '23503',
      constraint: 'meeting_polls_booking_fk',
    })
  },
  'scoped chosen candidate': async (f) => {
    await expect(schedule(f, f.poll, f.second.slots[0] as string, f.booking)).rejects.toMatchObject(
      { code: '23503', constraint: 'meeting_polls_chosen_slot_fk' },
    )
    // The chosen candidate cannot be deleted from under a scheduled poll, even above the minimum.
    await accept(schedule(f, f.poll, f.slots[0] as string, f.booking))
    await insert(f.pool, 'meeting_poll_slots', {
      organization_id: f.organization,
      poll_id: f.poll,
      position: 2,
      start_at: later(f.start, 2 * hour),
      end_at: later(f.end, 2 * hour),
    })
    await expect(
      f.pool.query('DELETE FROM meeting_poll_slots WHERE id=$1', [f.slots[0]]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_polls_chosen_slot_fk' })
    expect(
      (await f.pool.query('SELECT status FROM meeting_polls WHERE id=$1', [f.poll])).rows,
    ).toEqual([{ status: 'scheduled' }])
  },
  'booking match': async (f) => {
    const otherEvent = await insert(f.pool, 'event_types', {
      organization_id: f.organization,
      slug: 'sibling',
      title: 'Sibling meeting',
      duration_minutes: 30,
    })
    const booking = (start: string | Date, end: string | Date, event = f.event) =>
      insert(f.pool, 'bookings', {
        organization_id: f.organization,
        event_type_id: event,
        title: 'Another meeting',
        source: 'web',
        start_at: start,
        end_at: end,
      })
    for (const mismatch of [
      await booking(f.start, f.end, otherEvent),
      await booking(later(f.start, 24 * hour), later(f.end, 24 * hour)),
      await booking(f.start, later(f.end, 30 * 60_000)),
      await booking(later(f.start, -30 * 60_000), f.end),
    ])
      await expect(schedule(f, f.poll, f.slots[0] as string, mismatch)).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_polls_booking_match',
      })
    // A poll may also be inserted already scheduled; the same check applies.
    const insertScheduled = (linked: string) =>
      transaction(f.pool, async (client) => {
        const slots = [randomUUID(), randomUUID()]
        const poll = await insert(client, 'meeting_polls', {
          ...f.pollValues,
          status: 'scheduled',
          scheduled_at: f.created,
          chosen_slot_id: slots[0],
          booking_id: linked,
        })
        for (const [position, id] of slots.entries())
          await insert(client, 'meeting_poll_slots', {
            id,
            organization_id: f.organization,
            poll_id: poll,
            position,
            start_at: later(f.start, position * hour),
            end_at: later(f.end, position * hour),
          })
        return poll
      })
    await expect(
      insertScheduled(await booking(f.start, later(f.end, 30 * 60_000))),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_booking_match' })
    await accept(insertScheduled(await booking(f.start, f.end)))
    await expect(schedule(f, f.poll, f.slots[1] as string, f.booking)).rejects.toMatchObject({
      code: '23514',
      constraint: 'meeting_polls_booking_match',
    })
    await accept(schedule(f, f.poll, f.slots[0] as string, f.booking))
  },
  'scheduled history immutability': async (f) => {
    await accept(schedule(f, f.poll, f.slots[0] as string, f.booking))
    const otherEvent = await insert(f.pool, 'event_types', {
      organization_id: f.organization,
      slug: 'moved',
      title: 'Moved meeting',
      duration_minutes: 30,
    })
    const otherBooking = await bookingAt(
      f,
      f.organization,
      f.event,
      later(f.start, hour).toISOString(),
    )
    for (const [assignment, params] of [
      ["status='canceled',canceled_at=clock_timestamp()", []],
      ['event_type_id=$1', [otherEvent]],
      ['chosen_slot_id=$1', [f.slots[1]]],
      ['booking_id=$1', [otherBooking]],
      ["scheduled_at=scheduled_at+interval '1 second'", []],
    ] as const)
      await expect(
        f.pool.query(`UPDATE meeting_polls SET ${assignment} WHERE id=$${params.length + 1}`, [
          ...params,
          f.poll,
        ]),
        assignment,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_polls_history_immutable' })
    await accept(
      f.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
        [f.booking],
      ),
    )
    await accept(
      f.pool.query('UPDATE meeting_polls SET results_revision=results_revision+1 WHERE id=$1', [
        f.poll,
      ]),
    )
    expect(
      (await f.pool.query('SELECT status,booking_id FROM meeting_polls WHERE id=$1', [f.poll]))
        .rows,
    ).toEqual([{ status: 'scheduled', booking_id: f.booking }])
  },
  'minimum candidate cap': async (f) => {
    await expect(
      transaction(f.pool, (client) => insert(client, 'meeting_polls', f.pollValues)),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_count_cap' })
    await expect(
      f.pool.query('DELETE FROM meeting_poll_slots WHERE id=$1', [f.slots[0]]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_count_cap' })
  },
  'poll deletion keeps only replay tombstones': async (f) => {
    const values = receipt(f)
    const operation = await insert(f.pool, 'meeting_poll_operations', values)
    await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f))
    await insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f))
    await insert(f.pool, 'meeting_poll_mailbox_counters', counter(f))
    await insert(f.pool, 'meeting_poll_votes', {
      organization_id: f.organization,
      poll_id: f.poll,
      voter_id: f.voter,
      slot_id: f.slots[0],
      value: 'yes',
    })
    await accept(f.pool.query('DELETE FROM meeting_polls WHERE id=$1', [f.poll]))
    for (const table of [
      'meeting_poll_slots',
      'meeting_poll_voters',
      'meeting_poll_votes',
      'meeting_poll_capabilities',
      'meeting_poll_mailbox_counters',
      'meeting_poll_deliveries',
    ])
      expect(
        (await f.pool.query(`SELECT id FROM ${table} WHERE poll_id=$1`, [f.poll])).rows,
        table,
      ).toEqual([])
    expect(
      (
        await f.pool.query(
          `SELECT poll_id,booking_id,purge_at BETWEEN clock_timestamp()+interval '89 days' AND clock_timestamp()+interval '90 days' AS retained,actor_scope_digest,idempotency_key_digest,request_fingerprint FROM meeting_poll_operations WHERE id=$1`,
          [operation],
        )
      ).rows,
    ).toEqual([
      {
        poll_id: null,
        booking_id: null,
        retained: true,
        actor_scope_digest: values.actor_scope_digest,
        idempotency_key_digest: values.idempotency_key_digest,
        request_fingerprint: values.request_fingerprint,
      },
    ])
  },
  'receipt poll references without the tombstone trigger': async (f) => {
    // The tombstone trigger normally detaches receipts first; the FK action must also only
    // clear poll_id (not cascade, block or clear the organization).
    const operation = await insert(
      f.pool,
      'meeting_poll_operations',
      receipt(f, { purge_at: f.deadline }),
    )
    const client = await f.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE meeting_polls DISABLE TRIGGER USER')
      await accept(client.query('DELETE FROM meeting_polls WHERE id=$1', [f.poll]))
      expect(
        (
          await client.query(
            'SELECT organization_id,poll_id FROM meeting_poll_operations WHERE id=$1',
            [operation],
          )
        ).rows,
      ).toEqual([{ organization_id: f.organization, poll_id: null }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  },
  'linked booking deletion erases poll history': async (f) => {
    await schedule(f, f.poll, f.slots[0] as string, f.booking)
    const operation = await insert(
      f.pool,
      'meeting_poll_operations',
      receipt(f, { operation: 'finalize', booking_id: f.booking }),
    )
    await expect(
      f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect((await f.pool.query('SELECT id FROM meeting_polls WHERE id=$1', [f.poll])).rows).toEqual(
      [],
    )
    expect(
      (await f.pool.query('SELECT id FROM meeting_poll_voters WHERE poll_id=$1', [f.poll])).rows,
    ).toEqual([])
    expect(
      (
        await f.pool.query(
          'SELECT poll_id,booking_id,purge_at IS NOT NULL AS purge FROM meeting_poll_operations WHERE id=$1',
          [operation],
        )
      ).rows,
    ).toEqual([{ poll_id: null, booking_id: null, purge: true }])
  },
  'organization deletion': async (f) => {
    await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f))
    await insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f))
    await insert(f.pool, 'meeting_poll_mailbox_counters', counter(f))
    await insert(f.pool, 'meeting_poll_operations', receipt(f))
    await insert(
      f.pool,
      'meeting_poll_operations',
      receipt(f, { poll_id: null, purge_at: f.deadline }),
    )
    await accept(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization]))
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
        table,
      ).toEqual([])
  },

  // Candidates.
  'candidate identity': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_slots', {
        id: f.slots[0],
        organization_id: f.organization,
        poll_id: f.second.poll,
        position: 2,
        start_at: later(f.start, 5 * hour),
        end_at: later(f.end, 5 * hour),
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_slots_pkey' })
  },
  'candidate position': async (f) => {
    const slot = (position: number) =>
      insert(f.pool, 'meeting_poll_slots', {
        organization_id: f.organization,
        poll_id: f.poll,
        position,
        start_at: later(f.start, 5 * hour),
        end_at: later(f.end, 5 * hour),
      })
    for (const position of [-1, 20])
      await expect(slot(position), `position ${position}`).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_poll_slots_position_check',
      })
    await accept(slot(19))
  },
  'unique candidate position': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_slots', {
        organization_id: f.organization,
        poll_id: f.poll,
        position: 0,
        start_at: later(f.start, 5 * hour),
        end_at: later(f.end, 5 * hour),
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_slots_poll_id_position_key',
    })
  },
  'unique candidate interval': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_slots', {
        organization_id: f.organization,
        poll_id: f.poll,
        position: 5,
        start_at: f.start,
        end_at: f.end,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_slots_poll_id_start_at_end_at_key',
    })
  },
  'scoped candidate foreign key': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_slots', {
        organization_id: f.otherOrganization,
        poll_id: f.poll,
        position: 2,
        start_at: later(f.start, 2 * hour),
        end_at: later(f.end, 2 * hour),
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_poll_slots_poll_fk' })
  },
  'checks without triggers': async (f) => {
    // Replication and trigger-disabled restores skip the guard trigger; the CHECK still holds.
    const intervals = [
      [f.start, f.start],
      [f.end, f.start],
      [f.start, 'infinity'],
      ['-infinity', f.end],
    ]
    const errors = await attempts(
      f.pool,
      intervals.map(([start_at, end_at], position) =>
        insertStatement('meeting_poll_slots', {
          organization_id: f.organization,
          poll_id: f.poll,
          position: 10 + position,
          start_at,
          end_at,
        }),
      ),
      'SET LOCAL session_replication_role=replica',
    )
    expect(errors.map((error) => [error?.code, error?.constraint])).toEqual(
      intervals.map(() => ['23514', 'meeting_poll_slots_check']),
    )
    // The capability guard rejects an infinite expiry first; without it the CHECK still does.
    const [capability] = await attempts(
      f.pool,
      [
        insertStatement(
          'meeting_poll_capabilities',
          votingCapability(f, { purpose: 'reminder_opt_out', expires_at: 'infinity' }),
        ),
      ],
      'SET LOCAL session_replication_role=replica',
    )
    expect([capability?.code, capability?.constraint]).toEqual([
      '23514',
      'meeting_poll_capabilities_check',
    ])
  },
  'candidate immutability': async (f) => {
    for (const [assignment, params] of [
      ["start_at=start_at+interval '1 minute',end_at=end_at+interval '1 minute'", []],
      ["start_at=start_at-interval '30 minutes'", []],
      ["end_at=end_at+interval '30 minutes'", []],
      ['position=7', []],
      ['poll_id=$1', [f.second.poll]],
    ] as const)
      await expect(
        f.pool.query(`UPDATE meeting_poll_slots SET ${assignment} WHERE id=$${params.length + 1}`, [
          ...params,
          f.slots[0],
        ]),
        assignment,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_immutable' })
    await accept(
      f.pool.query('UPDATE meeting_poll_slots SET updated_at=clock_timestamp() WHERE id=$1', [
        f.slots[0],
      ]),
    )
  },
  'candidate duration': async (f) => {
    for (const minutes of [1, 29, 31, 60])
      await expect(
        insert(f.pool, 'meeting_poll_slots', {
          organization_id: f.organization,
          poll_id: f.poll,
          position: 2,
          start_at: later(f.start, 2 * hour),
          end_at: later(f.start, 2 * hour + minutes * 60_000),
        }),
        `${minutes} minutes`,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_slots_interval' })
  },
  'candidates start after the deadline': async (f) => {
    const slot = (start: Date, position: number) =>
      insert(f.pool, 'meeting_poll_slots', {
        organization_id: f.organization,
        poll_id: f.poll,
        position,
        start_at: start,
        end_at: later(start, 30 * 60_000),
      })
    await expect(slot(new Date(f.deadline), 2)).rejects.toMatchObject({
      code: '23514',
      constraint: 'meeting_poll_slots_interval',
    })
    await accept(slot(later(f.deadline, 1), 2))
  },

  // Voters.
  'voter identity': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        id: f.voter,
        poll_id: f.second.poll,
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_voters_pkey' })
  },
  'voter column checks': async (f) => {
    await expectChecks(
      f,
      'meeting_poll_voters',
      f.voter,
      [
        ['email_key=$1', 'meeting_poll_voters_email_key_check', [digest(31)]],
        ['email_key=$1', 'meeting_poll_voters_email_key_check', [digest(33)]],
        ["responses='[]'::jsonb", 'meeting_poll_voters_responses_check'],
        ['ballot_revision=-1', 'meeting_poll_voters_ballot_revision_check'],
        [
          "verified_at=clock_timestamp(),join_consent_at=clock_timestamp(),selected_booking_role='host'",
          'meeting_poll_voters_selected_booking_role_check',
        ],
      ],
      [['responses=\'{"team":"design"}\'::jsonb,ballot_revision=1']],
    )
    for (const bytes of [16, 33])
      await expect(
        insert(
          f.pool,
          'meeting_poll_voters',
          pendingVoter(f, { admission_ip_digest: digest(bytes) }),
        ),
        `${bytes} bytes`,
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_poll_voters_admission_ip_digest_check',
      })
  },
  'mailbox uniqueness': async (f) => {
    await accept(
      insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, poll_id: f.second.poll }),
    )
    // Same mailbox digest, different presentation of the address and voter details.
    await expect(
      insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        name: 'Another name',
        email: 'Voter@Example.Test',
        time_zone: 'Asia/Shanghai',
        locale: 'zh-CN',
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_voters_poll_id_email_key_key',
    })
  },
  'scoped voter poll': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        poll_id: f.foreign.poll,
        email_key: digest(),
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_poll_voters_poll_fk' })
  },
  'pending state pair': async (f) => {
    for (const overrides of [
      { invited_at: f.created },
      { invited_at: null, pending_expires_at: null, admission_ip_digest: null },
      { verified_at: f.created, admission_ip_digest: null },
    ])
      await expect(
        insert(f.pool, 'meeting_poll_voters', pendingVoter(f, overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
    // A public enrollee who withdraws before verifying keeps no reservation or IP digest.
    const pending = await insert(f.pool, 'meeting_poll_voters', pendingVoter(f))
    await expect(
      f.pool.query('UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1', [
        pending,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
    await accept(
      f.pool.query(
        'UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp(),pending_expires_at=NULL,admission_ip_digest=NULL WHERE id=$1',
        [pending],
      ),
    )
  },
  'pending IP pair': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_voters', pendingVoter(f, { admission_ip_digest: null })),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
    await expect(
      f.pool.query(
        'UPDATE meeting_poll_voters SET verified_at=clock_timestamp(),admission_ip_digest=$1 WHERE id=$2',
        [digest(), f.voter],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_pair' })
  },
  'pending expiry cap': async (f) => {
    for (const expiry of [f.created, later(f.created, hour + 1)])
      await expect(
        insert(f.pool, 'meeting_poll_voters', pendingVoter(f, { pending_expires_at: expiry })),
        String(expiry),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_cap' })
    await accept(insert(f.pool, 'meeting_poll_voters', pendingVoter(f)))
  },
  'pending reservations end by the deadline': async (f) => {
    const now = await databaseNow(f.pool)
    const deadline = later(now, 30 * 60_000)
    const { poll } = await f.makePoll({ created_at: later(now, -2 * hour), deadline_at: deadline })
    await expect(
      insert(
        f.pool,
        'meeting_poll_voters',
        pendingVoter(f, { poll_id: poll, created_at: now, pending_expires_at: later(now, hour) }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_deadline' })
    const voter = await insert(
      f.pool,
      'meeting_poll_voters',
      pendingVoter(f, { poll_id: poll, created_at: now, pending_expires_at: deadline }),
    )
    await expect(
      f.pool.query(
        "UPDATE meeting_poll_voters SET pending_expires_at=pending_expires_at+interval '1 millisecond' WHERE id=$1",
        [voter],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_pending_deadline' })
  },
  'ballot verification and consent': async (f) => {
    for (const fields of ['join_consent_at=clock_timestamp()', 'verified_at=clock_timestamp()'])
      await expect(
        f.pool.query(
          `UPDATE meeting_poll_voters SET ballot_submitted_at=clock_timestamp(),${fields} WHERE id=$1`,
          [f.voter],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_ballot_pair' })
    await accept(
      f.pool.query(
        'UPDATE meeting_poll_voters SET ballot_submitted_at=clock_timestamp(),verified_at=clock_timestamp(),join_consent_at=clock_timestamp() WHERE id=$1',
        [f.voter],
      ),
    )
  },
  'withdrawn privacy': async (f) => {
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
    await accept(
      f.pool.query('UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1', [
        f.voter,
      ]),
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
  'selected booking role': async (f) => {
    await expect(
      f.pool.query("UPDATE meeting_poll_voters SET selected_booking_role='guest' WHERE id=$1", [
        f.voter,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_check' })
    for (const fields of ['join_consent_at=clock_timestamp()', 'verified_at=clock_timestamp()'])
      await expect(
        f.pool.query(
          `UPDATE meeting_poll_voters SET ${fields},selected_booking_role='guest' WHERE id=$1`,
          [f.voter],
        ),
        fields,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_check' })
    await accept(
      f.pool.query(
        "UPDATE meeting_poll_voters SET verified_at=clock_timestamp(),join_consent_at=clock_timestamp(),selected_booking_role='booker' WHERE id=$1",
        [f.voter],
      ),
    )
    await accept(
      f.pool.query("UPDATE meeting_poll_voters SET selected_booking_role='guest' WHERE id=$1", [
        f.voter,
      ]),
    )
    await expect(
      f.pool.query(
        'UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp(),join_consent_at=NULL WHERE id=$1',
        [f.voter],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_check' })
  },
  'enrollment cap': async (f) => {
    for (let i = 1; i < 40; i++)
      await insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() })
    await expect(
      insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
    await accept(
      f.pool.query('UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1', [
        f.voter,
      ]),
    )
    await accept(insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() }))
  },
  'enrollment cap counts every active voter': async (f) => {
    const verified = { ...f.voterValues, poll_id: f.second.poll, invited_at: null }
    for (let i = 0; i < 40; i++)
      await insert(f.pool, 'meeting_poll_voters', {
        ...verified,
        verified_at: f.created,
        email_key: digest(),
      })
    await expect(
      insert(f.pool, 'meeting_poll_voters', {
        ...verified,
        verified_at: f.created,
        email_key: digest(),
      }),
      'verified',
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
    const { poll } = await f.makePoll()
    for (let i = 0; i < 39; i++)
      await insert(f.pool, 'meeting_poll_voters', {
        ...f.voterValues,
        poll_id: poll,
        email_key: digest(),
      })
    await accept(insert(f.pool, 'meeting_poll_voters', pendingVoter(f, { poll_id: poll })))
    for (const [label, values] of [
      ['pending', pendingVoter(f, { poll_id: poll })],
      ['invited', { ...f.voterValues, poll_id: poll, email_key: digest() }],
    ] as const)
      await expect(insert(f.pool, 'meeting_poll_voters', values), label).rejects.toMatchObject({
        code: '23514',
        constraint: 'meeting_poll_voters_enrollment_cap',
      })
  },
  'enrollment cap on updates': async (f) => {
    const now = await databaseNow(f.pool)
    for (let i = 1; i < 40; i++)
      await insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() })
    // A full poll still accepts ordinary updates of its active voters.
    await accept(
      f.pool.query("UPDATE meeting_poll_voters SET name='Renamed' WHERE id=$1", [f.voter]),
    )
    await accept(
      f.pool.query('UPDATE meeting_poll_voters SET withdrawn_at=clock_timestamp() WHERE id=$1', [
        f.voter,
      ]),
    )
    await accept(insert(f.pool, 'meeting_poll_voters', { ...f.voterValues, email_key: digest() }))
    await expect(
      f.pool.query('UPDATE meeting_poll_voters SET withdrawn_at=NULL WHERE id=$1', [f.voter]),
      'reactivation',
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
    const expired = await insert(
      f.pool,
      'meeting_poll_voters',
      pendingVoter(f, { created_at: later(now, -2 * hour), pending_expires_at: later(now, -hour) }),
    )
    await expect(
      f.pool.query(
        'UPDATE meeting_poll_voters SET verified_at=clock_timestamp(),pending_expires_at=NULL,admission_ip_digest=NULL WHERE id=$1',
        [expired],
      ),
      'verification',
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
  },
  'expired reservations free enrollment places': async (f) => {
    const now = await databaseNow(f.pool)
    const values = { ...f.voterValues, poll_id: f.second.poll }
    for (let i = 0; i < 39; i++)
      await insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() })
    await insert(
      f.pool,
      'meeting_poll_voters',
      pendingVoter(f, {
        poll_id: f.second.poll,
        created_at: later(now, -2 * hour),
        pending_expires_at: later(now, -hour),
      }),
    )
    await accept(insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() }))
    await expect(
      insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_enrollment_cap' })
  },
  'pending IP cap': async (f) => {
    const values = pendingVoter(f)
    for (let i = 0; i < 3; i++)
      await insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() })
    await expect(
      insert(f.pool, 'meeting_poll_voters', { ...values, email_key: digest() }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_ip_cap' })
    // The cap is per IP and poll: the same address may still reserve a place elsewhere.
    await accept(
      insert(f.pool, 'meeting_poll_voters', {
        ...values,
        poll_id: f.second.poll,
        email_key: digest(),
      }),
    )
    // Other addresses are unaffected, and a reservation at the cap may still be updated.
    await accept(insert(f.pool, 'meeting_poll_voters', pendingVoter(f)))
    await accept(
      f.pool.query(
        "UPDATE meeting_poll_voters SET name='Renamed' WHERE poll_id=$1 AND admission_ip_digest=$2",
        [f.poll, values.admission_ip_digest],
      ),
    )
  },
  'expired reservations free pending IP places': async (f) => {
    const now = await databaseNow(f.pool)
    const address = digest()
    for (let i = 0; i < 3; i++)
      await insert(
        f.pool,
        'meeting_poll_voters',
        pendingVoter(f, {
          admission_ip_digest: address,
          created_at: later(now, -2 * hour),
          pending_expires_at: later(now, -hour),
        }),
      )
    for (let i = 0; i < 3; i++)
      await accept(
        insert(f.pool, 'meeting_poll_voters', pendingVoter(f, { admission_ip_digest: address })),
      )
    await expect(
      insert(f.pool, 'meeting_poll_voters', pendingVoter(f, { admission_ip_digest: address })),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_voters_ip_cap' })
  },

  // Votes.
  'vote identity': async (f) => {
    const vote = {
      organization_id: f.organization,
      poll_id: f.poll,
      voter_id: f.voter,
      value: 'yes',
    }
    const id = await insert(f.pool, 'meeting_poll_votes', { ...vote, slot_id: f.slots[0] })
    await expect(
      insert(f.pool, 'meeting_poll_votes', { ...vote, id, slot_id: f.slots[1] }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_votes_pkey' })
  },
  'vote value': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_votes', {
        organization_id: f.organization,
        poll_id: f.poll,
        voter_id: f.voter,
        slot_id: f.slots[0],
        value: 'maybe',
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_votes_value_check' })
  },
  'unique vote cell': async (f) => {
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
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_votes_poll_id_voter_id_slot_id_key',
    })
  },
  'scoped vote voter and candidate': async (f) => {
    for (const [values, constraint] of [
      [{ voter_id: f.otherVoter, slot_id: f.slots[0] }, 'meeting_poll_votes_voter_fk'],
      [{ voter_id: f.voter, slot_id: f.foreign.slots[0] }, 'meeting_poll_votes_slot_fk'],
      [{ voter_id: f.voter, slot_id: f.second.slots[0] }, 'meeting_poll_votes_slot_fk'],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_votes', {
          organization_id: f.organization,
          poll_id: f.poll,
          value: 'yes',
          ...values,
        }),
        constraint,
      ).rejects.toMatchObject({ code: '23503', constraint })
  },
  'voter removal cascades and keeps mailbox counters': async (f) => {
    await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f))
    await insert(f.pool, 'meeting_poll_votes', {
      organization_id: f.organization,
      poll_id: f.poll,
      voter_id: f.voter,
      slot_id: f.slots[0],
      value: 'if_need_be',
    })
    await insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f))
    const kept = await insert(
      f.pool,
      'meeting_poll_mailbox_counters',
      counter(f, {
        email_key: f.voterValues.email_key,
        resend_count: 2,
        last_resend_at: f.created,
        reminder_opted_out_at: f.created,
      }),
    )
    const before = (
      await f.pool.query(
        'SELECT to_jsonb(t) AS row FROM meeting_poll_mailbox_counters t WHERE id=$1',
        [kept],
      )
    ).rows
    await accept(f.pool.query('DELETE FROM meeting_poll_voters WHERE id=$1', [f.voter]))
    for (const table of [
      'meeting_poll_votes',
      'meeting_poll_capabilities',
      'meeting_poll_deliveries',
    ])
      expect(
        (await f.pool.query(`SELECT id FROM ${table} WHERE voter_id=$1`, [f.voter])).rows,
        table,
      ).toEqual([])
    expect(
      (
        await f.pool.query(
          'SELECT to_jsonb(t) AS row FROM meeting_poll_mailbox_counters t WHERE id=$1',
          [kept],
        )
      ).rows,
    ).toEqual(before)
  },

  // Capabilities.
  'capability identity': async (f) => {
    const id = await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f))
    await expect(
      insert(f.pool, 'meeting_poll_capabilities', votingCapability(f, { id })),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_capabilities_pkey' })
  },
  'capability column checks': async (f) => {
    for (const [overrides, constraint] of [
      [{ purpose: 'manage' }, 'meeting_poll_capabilities_purpose_check'],
      [{ token_digest: digest(31) }, 'meeting_poll_capabilities_token_digest_check'],
      [{ token_digest: digest(33) }, 'meeting_poll_capabilities_token_digest_check'],
      [{ generation: 0 }, 'meeting_poll_capabilities_generation_check'],
      [{ purpose: 'reminder_opt_out', expires_at: f.created }, 'meeting_poll_capabilities_check'],
      [
        { revoked_at: f.created, capability_ciphertext: Buffer.from('synthetic ciphertext') },
        'meeting_poll_capabilities_check1',
      ],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_capabilities', votingCapability(f, overrides)),
        constraint,
      ).rejects.toMatchObject({ code: '23514', constraint })
    await accept(
      insert(
        f.pool,
        'meeting_poll_capabilities',
        votingCapability(f, { revoked_at: f.created, generation: 2 }),
      ),
    )
  },
  'unique capability digest': async (f) => {
    const token = digest()
    await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f, { token_digest: token }))
    await expect(
      insert(
        f.pool,
        'meeting_poll_capabilities',
        votingCapability(f, {
          token_digest: token,
          purpose: 'reminder_opt_out',
          voter_id: await insert(f.pool, 'meeting_poll_voters', {
            ...f.voterValues,
            email_key: digest(),
          }),
          generation: 2,
        }),
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_capabilities_token_digest_key',
    })
  },
  'scoped capability voter': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_capabilities', votingCapability(f, { voter_id: f.otherVoter })),
    ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_poll_capabilities_voter_fk' })
  },
  'capability expiry': async (f) => {
    for (const overrides of [
      { expires_at: later(f.deadline, 1) },
      { expires_at: later(f.deadline, -1) },
      { purpose: 'reminder_opt_out', expires_at: later(f.deadline, 1) },
    ])
      await expect(
        insert(f.pool, 'meeting_poll_capabilities', votingCapability(f, overrides)),
        JSON.stringify(overrides),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
    const voting = await insert(f.pool, 'meeting_poll_capabilities', votingCapability(f))
    const optOut = await insert(
      f.pool,
      'meeting_poll_capabilities',
      votingCapability(f, { purpose: 'reminder_opt_out', expires_at: later(f.deadline, -1) }),
    )
    for (const [assignment, id] of [
      ["expires_at=expires_at+interval '1 day'", voting],
      ["purpose='voting'", optOut],
    ] as const)
      await expect(
        f.pool.query(`UPDATE meeting_poll_capabilities SET ${assignment} WHERE id=$1`, [id]),
        assignment,
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
    await accept(
      f.pool.query(
        'UPDATE meeting_poll_capabilities SET consumed_at=clock_timestamp() WHERE id=$1',
        [voting],
      ),
    )
  },
  'verification expiry respects pending expiry': async (f) => {
    const expiry = later(f.created, hour)
    const voter = await insert(f.pool, 'meeting_poll_voters', pendingVoter(f))
    const values = votingCapability(f, { voter_id: voter, purpose: 'verification' })
    await accept(insert(f.pool, 'meeting_poll_capabilities', { ...values, expires_at: expiry }))
    await expect(
      insert(f.pool, 'meeting_poll_capabilities', {
        ...values,
        token_digest: digest(),
        expires_at: later(expiry, 1),
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
    // An invited (never pending) voter has no verification credential at all.
    await expect(
      insert(f.pool, 'meeting_poll_capabilities', {
        ...values,
        voter_id: f.voter,
        token_digest: digest(),
        expires_at: expiry,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_capabilities_expiry_cap' })
  },

  // Mailbox counters.
  'mailbox counter identity': async (f) => {
    const id = await insert(f.pool, 'meeting_poll_mailbox_counters', counter(f))
    await expect(
      insert(f.pool, 'meeting_poll_mailbox_counters', counter(f, { id })),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_mailbox_counters_pkey' })
  },
  'mailbox counter checks': async (f) => {
    for (const [overrides, constraint] of [
      [{ email_key: digest(31) }, 'meeting_poll_mailbox_counters_email_key_check'],
      [{ email_key: digest(33) }, 'meeting_poll_mailbox_counters_email_key_check'],
      [{ resend_count: 1 }, 'meeting_poll_mailbox_counters_check'],
      [{ last_resend_at: f.created }, 'meeting_poll_mailbox_counters_check'],
      [{ recovery_count: 1 }, 'meeting_poll_mailbox_counters_check1'],
      [{ last_recovery_at: f.created }, 'meeting_poll_mailbox_counters_check1'],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_mailbox_counters', counter(f, overrides)),
        constraint,
      ).rejects.toMatchObject({ code: '23514', constraint })
  },
  'resend and recovery caps': async (f) => {
    for (const [field, time, constraint] of [
      ['resend_count', 'last_resend_at', 'meeting_poll_mailbox_counters_resend_cap'],
      ['recovery_count', 'last_recovery_at', 'meeting_poll_mailbox_counters_recovery_cap'],
    ] as const)
      for (const count of [-1, 4])
        await expect(
          insert(
            f.pool,
            'meeting_poll_mailbox_counters',
            counter(f, { [field]: count, [time]: f.created }),
          ),
          `${field} ${count}`,
        ).rejects.toMatchObject({ code: '23514', constraint })
    await accept(
      insert(
        f.pool,
        'meeting_poll_mailbox_counters',
        counter(f, {
          resend_count: 3,
          recovery_count: 3,
          last_resend_at: f.created,
          last_recovery_at: f.created,
        }),
      ),
    )
  },
  'unique mailbox counter': async (f) => {
    const values = counter(f)
    await accept(insert(f.pool, 'meeting_poll_mailbox_counters', values))
    await accept(
      insert(f.pool, 'meeting_poll_mailbox_counters', { ...values, poll_id: f.second.poll }),
    )
    await expect(
      insert(f.pool, 'meeting_poll_mailbox_counters', {
        ...values,
        resend_count: 1,
        last_resend_at: f.created,
        removed_at: f.created,
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_mailbox_counters_poll_id_email_key_key',
    })
  },
  'scoped mailbox counter': async (f) => {
    await expect(
      insert(f.pool, 'meeting_poll_mailbox_counters', counter(f, { poll_id: f.foreign.poll })),
    ).rejects.toMatchObject({ code: '23503', constraint: 'meeting_poll_mailbox_counters_poll_fk' })
  },

  // Operation receipts.
  'receipt identity': async (f) => {
    const id = await insert(f.pool, 'meeting_poll_operations', receipt(f))
    await expect(
      insert(f.pool, 'meeting_poll_operations', receipt(f, { id })),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_operations_pkey' })
  },
  'receipt column checks': async (f) => {
    for (const [overrides, constraint] of [
      [{ operation: 'update' }, 'meeting_poll_operations_operation_check'],
      [{ actor_scope_digest: digest(31) }, 'meeting_poll_operations_actor_scope_digest_check'],
      [
        { idempotency_key_digest: digest(31) },
        'meeting_poll_operations_idempotency_key_digest_check',
      ],
      [{ request_fingerprint: digest(31) }, 'meeting_poll_operations_request_fingerprint_check'],
      [{ actor_scope_digest: digest(33) }, 'meeting_poll_operations_actor_scope_digest_check'],
      [
        { idempotency_key_digest: digest(33) },
        'meeting_poll_operations_idempotency_key_digest_check',
      ],
      [{ request_fingerprint: digest(33) }, 'meeting_poll_operations_request_fingerprint_check'],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_operations', receipt(f, overrides)),
        constraint,
      ).rejects.toMatchObject({ code: '23514', constraint })
  },
  'unique replay key': async (f) => {
    const values = receipt(f)
    await accept(insert(f.pool, 'meeting_poll_operations', values))
    await accept(insert(f.pool, 'meeting_poll_operations', { ...values, operation: 'invite' }))
    // A replay with another request (or for another poll) is still the same receipt key.
    await expect(
      insert(f.pool, 'meeting_poll_operations', {
        ...values,
        poll_id: f.second.poll,
        request_fingerprint: digest(),
      }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'meeting_poll_operations_organization_id_operation_actor_sco_key',
    })
  },
  'receipt tombstone shape': async (f) => {
    for (const overrides of [
      { poll_id: null },
      { poll_id: null, booking_id: f.booking, purge_at: f.deadline },
    ])
      await expect(
        insert(f.pool, 'meeting_poll_operations', receipt(f, overrides)),
        JSON.stringify(overrides),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_operations_check' })
    await accept(
      insert(
        f.pool,
        'meeting_poll_operations',
        receipt(f, { poll_id: null, purge_at: f.deadline }),
      ),
    )
  },
  'scoped receipts': async (f) => {
    const foreignBooking = await bookingAt(f, f.otherOrganization, f.otherEvent)
    for (const [overrides, constraint] of [
      [{ poll_id: f.foreign.poll }, 'meeting_poll_operations_poll_fk'],
      [{ booking_id: foreignBooking }, 'meeting_poll_operations_booking_fk'],
      [
        { organization_id: randomUUID(), poll_id: null, purge_at: f.deadline },
        'meeting_poll_operations_organization_id_fkey',
      ],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_operations', receipt(f, overrides)),
        constraint,
      ).rejects.toMatchObject({ code: '23503', constraint })
  },
  'booking deletion clears receipt references': async (f) => {
    const unlinked = await bookingAt(f, f.organization, f.event, later(f.start, hour).toISOString())
    const operation = await insert(
      f.pool,
      'meeting_poll_operations',
      receipt(f, { operation: 'finalize', booking_id: unlinked }),
    )
    await accept(f.pool.query('DELETE FROM bookings WHERE id=$1', [unlinked]))
    expect(
      (
        await f.pool.query('SELECT poll_id,booking_id FROM meeting_poll_operations WHERE id=$1', [
          operation,
        ])
      ).rows,
    ).toEqual([{ poll_id: f.poll, booking_id: null }])
  },

  // Deliveries.
  'delivery identity': async (f) => {
    const id = await insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f))
    await expect(
      insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, { id, kind: 'recovery' })),
    ).rejects.toMatchObject({ code: '23505', constraint: 'meeting_poll_deliveries_pkey' })
  },
  'delivery column checks': async (f) => {
    for (const [overrides, constraint] of [
      [{ kind: 'digest' }, 'meeting_poll_deliveries_kind_check'],
      [{ generation: 0 }, 'meeting_poll_deliveries_generation_check'],
      [{ sequence: -1 }, 'meeting_poll_deliveries_sequence_check'],
      [{ state: 'failed' }, 'meeting_poll_deliveries_state_check'],
      [{ attempts: -1 }, 'meeting_poll_deliveries_attempts_check'],
      [{ attempts: 6 }, 'meeting_poll_deliveries_attempts_check'],
      [{ error_class: 'SMTP 550 voter@example.test' }, 'meeting_poll_deliveries_error_class_check'],
      [{ error_class: 'x'.repeat(65) }, 'meeting_poll_deliveries_error_class_check'],
      [{ error_class: 'smtp 550 voter@example.test' }, 'meeting_poll_deliveries_error_class_check'],
      [{ error_class: 'smtp-rejected' }, 'meeting_poll_deliveries_error_class_check'],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, overrides)),
        constraint,
      ).rejects.toMatchObject({ code: '23514', constraint })
    await accept(
      insert(
        f.pool,
        'meeting_poll_deliveries',
        voterDelivery(f, { attempts: 5, error_class: 'smtp_rejected' }),
      ),
    )
  },
  'delivery recipient, lease and terminal pairs': async (f) => {
    for (const [overrides, constraint] of [
      [{ voter_id: null }, 'meeting_poll_deliveries_recipient_pair'],
      [{ host_user_id: f.user, kind: 'deadline_closed' }, 'meeting_poll_deliveries_recipient_pair'],
      [{ lease_id: randomUUID() }, 'meeting_poll_deliveries_lease_pair'],
      [{ lease_until: f.deadline }, 'meeting_poll_deliveries_lease_pair'],
      [{ state: 'processing' }, 'meeting_poll_deliveries_lease_pair'],
      [{ terminal_at: f.created }, 'meeting_poll_deliveries_terminal_pair'],
      ...['sent', 'suppressed', 'skipped'].flatMap((state) => [
        [{ state }, 'meeting_poll_deliveries_terminal_pair'] as const,
        [
          {
            state,
            terminal_at: f.created,
            capability_ciphertext: Buffer.from('synthetic encrypted capability'),
          },
          'meeting_poll_deliveries_terminal_pair',
        ] as const,
      ]),
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toMatchObject({ code: '23514', constraint })
    await accept(
      insert(
        f.pool,
        'meeting_poll_deliveries',
        voterDelivery(f, {
          kind: 'recovery',
          state: 'processing',
          attempts: 1,
          lease_id: randomUUID(),
          lease_until: f.deadline,
        }),
      ),
    )
    for (const [kind, state] of [
      ['reminder', 'sent'],
      ['selected', 'suppressed'],
      ['canceled', 'skipped'],
    ])
      await accept(
        insert(
          f.pool,
          'meeting_poll_deliveries',
          voterDelivery(f, { kind, state, terminal_at: f.created }),
        ),
        `${kind} ${state}`,
      )
  },
  'voter delivery identity': async (f) => {
    await insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f))
    for (const overrides of [{}, { due_at: f.deadline, state: 'sent', terminal_at: f.created }])
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'meeting_poll_deliveries_voter_identity',
      })
    await accept(insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, { sequence: 1 })))
  },
  'host delivery identity': async (f) => {
    await insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f))
    for (const overrides of [{}, { due_at: f.deadline, state: 'skipped', terminal_at: f.created }])
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f, overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'meeting_poll_deliveries_host_identity',
      })
    await accept(insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f, { generation: 2 })))
  },
  'host-only deadline notice': async (f) => {
    for (const values of [
      voterDelivery(f, { kind: 'deadline_closed' }),
      hostDelivery(f, { kind: 'invitation' }),
    ])
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', values),
        String(values.kind),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_deliveries_check' })
  },
  'host deliveries carry no credential': async (f) => {
    for (const overrides of [
      { sequence: 1 },
      { capability_ciphertext: Buffer.from('synthetic encrypted capability') },
    ])
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f, overrides)),
        JSON.stringify(Object.keys(overrides)),
      ).rejects.toMatchObject({ code: '23514', constraint: 'meeting_poll_deliveries_check1' })
  },
  'every enumerated value is accepted': async (f) => {
    for (const operation of ['create', 'invite', 'resend', 'rotate_link', 'finalize'])
      await accept(insert(f.pool, 'meeting_poll_operations', receipt(f, { operation })), operation)
    for (const kind of [
      'verification',
      'invitation',
      'recovery',
      'reminder',
      'selected',
      'canceled',
      'booking_update',
    ])
      await accept(insert(f.pool, 'meeting_poll_deliveries', voterDelivery(f, { kind })), kind)
    await accept(insert(f.pool, 'meeting_poll_deliveries', hostDelivery(f)), 'deadline_closed')
    const pending = await insert(f.pool, 'meeting_poll_voters', pendingVoter(f))
    for (const [purpose, voter, expires] of [
      ['verification', pending, later(f.created, hour)],
      ['voting', f.voter, new Date(f.deadline)],
      ['reminder_opt_out', f.voter, later(f.deadline, -hour)],
    ] as const)
      await accept(
        insert(
          f.pool,
          'meeting_poll_capabilities',
          votingCapability(f, { purpose, voter_id: voter, expires_at: expires }),
        ),
        purpose,
      )
    for (const value of ['yes', 'if_need_be', 'no'])
      await accept(
        insert(f.pool, 'meeting_poll_votes', {
          organization_id: f.organization,
          poll_id: f.poll,
          voter_id: await insert(f.pool, 'meeting_poll_voters', {
            ...f.voterValues,
            email_key: digest(),
          }),
          slot_id: f.slots[0],
          value,
        }),
        value,
      )
    for (const [admission_mode, visibility] of [
      ['invited', 'aggregate'],
      ['public_link', 'private'],
    ])
      await accept(f.makePoll({ admission_mode, visibility }), `${admission_mode} ${visibility}`)
  },
  'scoped deliveries': async (f) => {
    for (const [values, constraint] of [
      [voterDelivery(f, { voter_id: f.otherVoter }), 'meeting_poll_deliveries_voter_fk'],
      [hostDelivery(f, { poll_id: f.foreign.poll }), 'meeting_poll_deliveries_poll_fk'],
      [
        hostDelivery(f, { host_user_id: randomUUID() }),
        'meeting_poll_deliveries_host_user_id_fkey',
      ],
    ] as const)
      await expect(
        insert(f.pool, 'meeting_poll_deliveries', values),
        constraint,
      ).rejects.toMatchObject({ code: '23503', constraint })
  },
}

/**
 * Tables whose organization FK repeats the organization of a scoped composite FK. It also makes
 * an insert lock the organization row (FOR KEY SHARE), so an organization deletion that starts
 * during the inserting transaction waits for it. Without that lock the deletion removes the
 * organization row and waits in its cascade on the parent row, and the transaction's next
 * write that checks the organization deadlocks with it (40P01).
 */
export const organizationLockedInserts: Record<string, (f: Fixture) => Record<string, unknown>> = {
  meeting_polls: (f) => f.pollValues,
  meeting_poll_slots: (f) => ({
    organization_id: f.organization,
    poll_id: f.poll,
    position: 2,
    start_at: later(f.start, 2 * hour),
    end_at: later(f.end, 2 * hour),
  }),
  meeting_poll_voters: (f) => ({ ...f.voterValues, email_key: digest() }),
  meeting_poll_votes: (f) => ({
    organization_id: f.organization,
    poll_id: f.poll,
    voter_id: f.voter,
    slot_id: f.slots[0],
    value: 'yes',
  }),
  meeting_poll_capabilities: (f) => votingCapability(f),
  meeting_poll_mailbox_counters: (f) => counter(f),
  meeting_poll_deliveries: (f) => voterDelivery(f),
}
for (const [table, row] of Object.entries(organizationLockedInserts))
  meetingPollProtections[`${table} insert locks its organization`] = async (f) => {
    const writer = await f.pool.connect()
    try {
      await writer.query('BEGIN')
      await insert(writer, table, row(f))
      // FOR UPDATE conflicts with FOR KEY SHARE, and SKIP LOCKED returns no row instead of
      // waiting, so a missing lock is a plain value mismatch.
      expect(
        (
          await f.pool.query(
            'SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [f.organization],
          )
        ).rows,
        `${table} insert leaves its organization row unlocked`,
      ).toEqual([])
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      writer.release()
    }
  }

// Checks that guard many objects run first, so a dropped object usually fails fast.
const broadChecks = [
  'required columns',
  'design indexes',
  'poll column checks',
  'delivery column checks',
  'capability column checks',
  'voter column checks',
  'receipt column checks',
  'delivery recipient, lease and terminal pairs',
  'mailbox counter checks',
  'poll deletion keeps only replay tombstones',
]

/** Runs every protection on its own fixture; the error names the first failing check. */
export async function assertMeetingPollProtections(pool: pg.Pool): Promise<void> {
  const names = [
    ...broadChecks,
    ...Object.keys(meetingPollProtections).filter((name) => !broadChecks.includes(name)),
  ]
  for (const name of names) {
    const check = meetingPollProtections[name] as (f: Fixture) => Promise<void>
    try {
      await check(await fixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
