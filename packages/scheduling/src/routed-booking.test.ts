import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { bookingNotificationJob, bookingNotifier } from '@hourmere/notifications'
import { type CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cancelManagedBooking, createPublicTeamBooking, createRoutedBooking } from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import type { RoutingQuestion } from './routing-form-config.ts'
import {
  archiveRoutingForm,
  createRoutingForm,
  publishRoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from './routing-form-service.ts'
import { routingTokenDigest } from './routing-receipt-crypto.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2030-10-07T08:00:00Z')
const start = now.add({ hours: 6 })
const routingSecret = randomBytes(32).toString('base64url')
const redirect = 'https://example.test/thanks'
const originalAnswer = 'Original routing note'
const responses = { details: 'Edited booking note' }
const invitee = { name: 'Synthetic invitee', email: 'invitee@example.test', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('routed booking creation', () => {
  let owned: TestDatabase
  let db: Db
  let notify: BookingNotifier
  let jobs: ReturnType<typeof makeJobs>

  function makeJobs() {
    return createJobs({
      connectionString: owned.url,
      definitions: [
        bookingNotificationJob({
          db,
          mailer: { send: async () => {} },
          publicUrl: 'https://hourmere.example',
          secret: routingSecret,
        }),
      ],
      maxConnections: 2,
      work: false,
      migrate: true,
    })
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routed_booking' })
    db = createDb(owned.pool)
    jobs = makeJobs()
    await jobs.start()
    notify = bookingNotifier(jobs)
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  function context(connection = db, at = now) {
    return {
      db: connection,
      now: () => at,
      receiptNow: () => at,
      routingFormsEnabled: true,
      routingSecret,
      notify,
    }
  }

  async function fixture(roundRobin = false) {
    const owner = await createTestUser(db, 'Routing test host')
    const member = roundRobin ? await createTestUser(db, 'Second routing test host') : undefined
    const team = member
      ? await createTestTeam(db, [
          { user: owner, role: 'owner' },
          { user: member, role: 'member' },
        ])
      : undefined
    const { user, organization } = team?.as(owner) ?? owner.principal
    const author = testContext(
      db,
      { kind: 'session', sessionId: randomUUID(), user, organization },
      () => now,
    )
    const hosts = member ? [owner.id, member.id].sort() : [owner.id]
    const create = createFixtures(db)
    for (const userId of hosts) {
      await db
        .insertInto('profiles')
        .values({ user_id: userId, handle: `host-${userId.slice(0, 8)}`, time_zone: 'UTC' })
        .execute()
      await create.schedule(userId, { timeZone: 'UTC' })
    }
    const event = await createEventType(author, {
      title: 'Synthetic appointment',
      slug: 'hidden-appointment',
      durationMinutes: 30,
      isHidden: true,
      successRedirect: { url: redirect },
      questions: [{ id: 'details', label: 'Booking details', type: 'short_text', required: true }],
      ...(member && {
        schedulingType: 'round_robin',
        hosts: [...hosts].reverse().map((userId) => ({ userId })),
      }),
    })
    if (member) await activateRoundRobin(author, event.id)

    const noteId = randomUUID()
    const selectId = randomUUID()
    const optionId = randomUUID()
    const questions: RoutingQuestion[] = [
      { id: noteId, type: 'short_text', label: 'Routing details', required: true },
      {
        id: selectId,
        type: 'select',
        label: 'Routing topic',
        required: true,
        options: [{ id: optionId, label: 'Original topic' }],
      },
    ]
    const answers = { [noteId]: originalAnswer, [selectId]: optionId }
    const matchedRuleId = randomUUID()
    const target = {
      kind: 'event',
      eventTypeId: event.id,
      mappings: [{ questionId: noteId, destination: { kind: 'question', questionId: 'details' } }],
    }
    // The round-robin case records both a matching rule and a different resolved fallback.
    const retiring = member
      ? await createEventType(author, {
          title: 'Retired target',
          slug: 'retired',
          durationMinutes: 30,
        })
      : undefined
    const { id } = await createRoutingForm(author, {
      slug: 'qualification',
      title: 'Synthetic qualification',
      questions,
      rules: retiring
        ? [
            {
              id: matchedRuleId,
              conditions: [{ questionId: selectId, operator: 'equals', value: optionId }],
              target: { kind: 'event', eventTypeId: retiring.id, mappings: [] },
            },
          ]
        : [],
      fallback: target,
    })
    const publication = await publishRoutingForm(author, id, { expectedRevision: 1 })
    const form = await updateRoutingForm(author, id, {
      expectedRevision: publication.form.draftRevision,
      enabled: true,
    })
    if (retiring)
      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', retiring.id)
        .execute()

    async function issue() {
      const outcome = await submitRoutingForm(
        context(),
        { organizationId: organization.id, formId: id },
        {
          versionId: publication.version.id,
          answers: { ...answers, [noteId]: ` ${originalAnswer} ` },
        },
      )
      if (outcome.kind !== 'continuation') throw new Error('Expected a routing receipt')
      return {
        routeToken: outcome.routeToken,
        start,
        invitee,
        responses,
        idempotencyKey: randomUUID(),
      }
    }
    return {
      author,
      organization,
      event,
      form,
      version: publication.version,
      hosts,
      questions,
      answers,
      matchedRuleId,
      issue,
    }
  }

  function receipt(routeToken: string, connection = db) {
    return connection
      .selectFrom('routing_receipts')
      .selectAll()
      .where('token_hash', '=', routingTokenDigest(routingSecret, 'continuation', routeToken))
      .executeTakeFirstOrThrow()
  }

  function trackQueries(queries: CompiledQuery[]) {
    return new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') queries.push(event.query)
      },
    })
  }

  function locks(queries: CompiledQuery[]) {
    return queries.flatMap(({ sql: statement, parameters }) => {
      if (
        statement.includes('pg_advisory_xact_lock') &&
        String(parameters[0]).startsWith('booking-host:')
      )
        return [['host', parameters[0]]]
      if (!/for (?:share|update|key share|no key update)/.test(statement)) return []
      if (statement.includes('for share of "et"')) return [['event']]
      if (statement.includes('from "auth"."organization"')) return [['organization']]
      if (statement.includes('from "auth"."user"')) return [['users', ...parameters]]
      if (statement.includes('from "auth"."member"')) return [['members', ...parameters.slice(1)]]
      if (statement.includes('from "round_robin_state"')) return [['round-robin']]
      if (statement.includes('from "routing_forms"')) return [['form']]
      if (statement.includes('from "routing_receipts"')) return [['receipt']]
      return []
    })
  }

  async function queued(bookingId: string, connection = db) {
    const { rows } = await sql<{ data: unknown }>`select data from pgboss.job
      where name = 'booking-notification' and data->>'bookingId' = ${bookingId}`.execute(connection)
    return rows.map(({ data }) => data)
  }

  it('writes the pinned labels and final booking separately under the ordinary locks, with no redirect snapshot', async () => {
    const f = await fixture(true)
    const input = await f.issue()
    const revised = await updateRoutingForm(f.author, f.form.id, {
      expectedRevision: f.form.draftRevision,
      questions: f.questions.map((question) => ({ ...question, label: `New ${question.label}` })),
      rules: [],
    })
    await publishRoutingForm(f.author, f.form.id, { expectedRevision: revised.draftRevision })
    const routedQueries: CompiledQuery[] = []
    const routed = await createRoutedBooking(context(trackQueries(routedQueries)), input)
    const bookingId = routed.booking.id
    expect(routed.booking).toMatchObject({
      eventTypeId: f.event.id,
      status: 'confirmed',
      responses,
    })
    expect(routed.successRedirect).toBeUndefined()
    expect(routed.booking).not.toHaveProperty('routing')
    const snapshot = await db
      .selectFrom('booking_routing')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    expect(snapshot).toEqual({
      booking_id: bookingId,
      organization_id: f.organization.id,
      form_id: f.form.id,
      version_id: f.version.id,
      version_number: f.version.versionNumber,
      matched_rule_id: f.matchedRuleId,
      resolved_rule_id: 'fallback',
      questions: f.questions,
      answers: f.answers,
      replay_fingerprint: expect.any(Buffer),
    })
    const consumed = await receipt(input.routeToken)
    expect(consumed).toMatchObject({
      consumed_booking_id: bookingId,
      token_hash: routingTokenDigest(routingSecret, 'continuation', input.routeToken),
      answers_ciphertext: null,
    })
    expect(JSON.stringify([consumed, snapshot]).includes(input.routeToken)).toBe(false)
    const row = await db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow()
    expect(row.success_redirect).toBeNull()
    for (const privateValue of [input.routeToken, originalAnswer]) {
      expect(JSON.stringify(row).includes(privateValue)).toBe(false)
    }
    expect(await queued(bookingId)).toEqual([{ bookingId, kind: 'confirmed' }])

    const ordinaryQueries: CompiledQuery[] = []
    const ordinary = await createPublicTeamBooking(context(trackQueries(ordinaryQueries)), {
      handle: f.organization.slug,
      slug: f.event.slug,
      start: start.add({ hours: 1 }),
      invitee,
      responses,
    })
    expect(ordinary.booking.responses).toEqual(routed.booking.responses)
    expect(ordinary.successRedirect).toMatchObject({ url: redirect })
    const routedLocks = locks(routedQueries)
    expect(routedLocks.filter(([name]) => name !== 'form' && name !== 'receipt')).toEqual(
      locks(ordinaryQueries),
    )
    expect(routedLocks).toEqual([
      ['organization'],
      ...f.hosts.map((id) => ['host', `booking-host:${id}`]),
      ['event'],
      ['users', ...f.hosts],
      ['members', ...f.hosts],
      ['round-robin'],
      ['form'],
      ['receipt'],
    ])
  })

  it('commits only one booking when concurrent transactions use one receipt for two available times', async () => {
    const f = await fixture()
    const input = await f.issue()
    const other = { ...input, idempotencyKey: randomUUID(), start: start.add({ hours: 1 }) }
    const blocker = await owned.pool.connect()
    let pending:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof createRoutedBooking>>>[]>
      | undefined
    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = rows[0]?.pid
      expect(pid).toEqual(expect.any(Number))
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `booking-host:${f.hosts[0]}`,
      ])
      pending = Promise.allSettled(
        [input, input, other, other].map((request) => createRoutedBooking(context(), request)),
      )
      await expect
        .poll(
          async () => {
            const { rows } = await owned.pool.query<{ direct: number; waiting: number }>(
              `SELECT count(*) FILTER (WHERE $1 = ANY(pg_blocking_pids(pid)))::int AS direct,
                  count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS waiting
             FROM pg_stat_activity WHERE datname = current_database()`,
              [pid],
            )
            const result = rows[0]
            return { blockedByHost: (result?.direct ?? 0) > 0, waiting: result?.waiting }
          },
          { timeout: 5000 },
        )
        .toEqual({ blockedByHost: true, waiting: 4 })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
    const results = await pending
    const successful = results.filter((result) => result.status === 'fulfilled')
    const created = successful.filter(({ value }) => !value.replayed)
    expect(created.length).toBe(1)
    expect(successful.length).toBe(2)
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected.map(({ reason }) => reason?.code)).toEqual([
      'routing_unavailable',
      'routing_unavailable',
    ])
    const bookingId = created[0]?.value.booking.id as string
    expect(successful.map(({ value }) => value.booking.id)).toEqual([bookingId, bookingId])
    expect(await receipt(input.routeToken)).toMatchObject({ consumed_booking_id: bookingId })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', f.event.id)
        .execute(),
    ).toEqual([{ id: bookingId }])
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', bookingId)
        .execute(),
    ).toEqual([{ user_id: f.hosts[0] }])
    expect(await queued(bookingId)).toEqual([{ bookingId, kind: 'confirmed' }])
  })

  it('rolls back receipt consumption, provenance, hosts and outbox when the final notifier fails', async () => {
    const f = await fixture()
    const input = await f.issue()
    const before = await receipt(input.routeToken)
    expect(before.answers_ciphertext).toBeInstanceOf(Buffer)
    const stop = new Error('Synthetic failure after queueing')
    let attemptedBookingId = ''
    const outcome = await createRoutedBooking(
      {
        ...context(),
        async notify(trx, change, at) {
          attemptedBookingId = change.bookingId
          await notify(trx, change, at)
          expect(await queued(attemptedBookingId, trx)).toEqual([
            { bookingId: attemptedBookingId, kind: 'confirmed' },
          ])
          throw stop
        },
      },
      input,
    ).catch((error: unknown) => error)
    const after = await receipt(input.routeToken)
    expect(after.consumed_booking_id).toBeNull()
    expect(after).toEqual(before)
    expect(outcome).toBe(stop)
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', attemptedBookingId).execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('id')
        .where('booking_id', '=', attemptedBookingId)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('booking_routing')
        .select('booking_id')
        .where('booking_id', '=', attemptedBookingId)
        .execute(),
    ).toEqual([])
    expect(await queued(attemptedBookingId)).toEqual([])
    const committed = await createRoutedBooking(context(), input)
    expect(committed.booking.status).toBe('confirmed')
    expect(await receipt(input.routeToken)).toMatchObject({
      consumed_booking_id: committed.booking.id,
      answers_ciphertext: null,
    })
  })

  it('allows only exact authority-scoped committed replays while off, without a receipt read', async () => {
    const f = await fixture()
    const input = await f.issue()
    const pending = await f.issue()
    const before = await receipt(pending.routeToken)
    const origin = { source: 'mcp', apiKeyId: randomUUID() } as const
    const queries: CompiledQuery[] = []
    const observed = trackQueries(queries)
    const skipped = vi.fn(async () => {})
    const disabled = { code: 'routing_forms_disabled' }
    const activeOff = { ...context(observed), routingFormsEnabled: false, notify: skipped }
    await expect(createRoutedBooking(activeOff, pending, origin)).rejects.toMatchObject(disabled)
    const committed = await createRoutedBooking(context(), input, origin)
    expect(committed.manageToken).toEqual(expect.any(String))
    await cancelManagedBooking(context(), committed.manageToken as string)
    await archiveRoutingForm(f.author, f.form.id, { expectedRevision: f.form.draftRevision })
    const expired = { ...context(observed, now.add({ minutes: 31 })), notify: skipped }
    const off = { ...expired, routingFormsEnabled: false }
    for (const current of [off, expired]) {
      const result = await createRoutedBooking(current, input, origin)
      expect(result).toMatchObject({
        booking: { id: committed.booking.id, status: 'cancelled' },
        manageToken: null,
        replayed: true,
      })
      expect(result.successRedirect).toBeUndefined()
    }
    for (const changed of [
      { ...input, responses: { details: 'Different final response' } },
      { ...input, idempotencyKey: randomUUID() },
      { ...input, routeToken: pending.routeToken },
      { ...input, routeToken: randomBytes(32).toString('base64url') },
      pending,
    ]) {
      await expect(createRoutedBooking(off, changed, origin)).rejects.toMatchObject(disabled)
    }
    await expect(
      createRoutedBooking(off, input, { ...origin, apiKeyId: randomUUID() }),
    ).rejects.toMatchObject(disabled)
    await expect(createRoutedBooking(off, input)).rejects.toMatchObject(disabled)
    expect(queries.some(({ sql: statement }) => statement.includes('"routing_receipts"'))).toBe(
      false,
    )
    expect(skipped).not.toHaveBeenCalled()
    await expect(createRoutedBooking(context(), pending, origin)).rejects.toMatchObject({
      code: 'routing_unavailable',
    })
    expect(await receipt(pending.routeToken)).toEqual(before)
  })
})
