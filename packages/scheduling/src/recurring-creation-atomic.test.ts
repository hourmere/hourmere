import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  createWebhook,
  WEBHOOK_DELIVERY_JOB,
  webhookBookingNotifier,
  webhookDeliveryJob,
} from '@hourmere/webhooks'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPublicBooking } from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { checkRecurringAvailability } from './recurring-availability.ts'
import {
  type CreateBookingSeriesInput,
  createPublicBookingSeries,
  createPublicTeamBookingSeries,
} from './recurring-creation.ts'
import { expandRecurringRule, type RecurringRule } from './recurring-rules.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const firstLocalStart = '2026-11-02T09:00+00:00'
const timeZone = 'UTC'
const durationMinutes = 30
const eventRevision = '7'
const invitee = { name: 'Series guest', email: 'series-guest@example.test', timeZone }
const recurring = {
  recurringBookingsEnabled: true,
  actorDigest: createHash('sha256').update('synthetic series actor').digest(),
}
const webhookSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }

function dates(count: number) {
  return expandRecurringRule({
    firstLocalStart,
    rule: { pattern: 'weekly', count },
    timeZone,
    durationMinutes,
    now: now(),
  })
}

function seriesRequest(
  page: { handle: string; slug: string },
  count = 3,
): CreateBookingSeriesInput {
  const rule: RecurringRule = { pattern: 'weekly', count }
  return {
    ...page,
    idempotencyKey: randomUUID(),
    firstLocalStart,
    rule,
    invitee,
    durationMinutes,
    expectedPreview: {
      eventRevision,
      timeZone,
      rule,
      durationMinutes,
      occurrences: dates(count).map(({ ordinal, localStart, start, end, offset }) => ({
        ordinal,
        localStart,
        start: start?.toString() ?? null,
        end: end?.toString() ?? null,
        offset,
      })),
    },
  }
}

const occurrenceTime = (ordinal: number) => {
  const start = dates(3)[ordinal - 1]?.start
  if (!start) throw new Error('Missing synthetic occurrence')
  return start
}

describe.skipIf(!serverUrl)('atomic recurring booking creation on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>
  const webhookTransport = vi.fn(async () => 204)

  function makeQueue() {
    return createJobs({
      connectionString: owned.url,
      definitions: [webhookDeliveryJob({ db, ...webhookSettings, transport: webhookTransport })],
      maxConnections: 2,
      work: false,
      migrate: true,
    })
  }

  let jobs: ReturnType<typeof makeQueue>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_atomic' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
    jobs = makeQueue()
    await jobs.start()
    await sql`
      CREATE TABLE test_series_insert_failures (event_type_id uuid PRIMARY KEY, start_at timestamptz);
      CREATE FUNCTION test_fail_series_booking_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.series_occurrence_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM test_series_insert_failures
          WHERE event_type_id = NEW.event_type_id AND start_at = NEW.start_at
        ) THEN
          RAISE EXCEPTION 'synthetic series booking insertion failed';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_series_booking_insert BEFORE INSERT ON bookings
        FOR EACH ROW EXECUTE FUNCTION test_fail_series_booking_insert()
    `.execute(db)
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function enableRecurrence(eventTypeId: string) {
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 3 }),
        recurrence_revision: eventRevision,
      })
      .where('id', '=', eventTypeId)
      .executeTakeFirstOrThrow()
  }

  async function personal(bufferAfterMinutes = 0) {
    const host = await fixtures.host({ timeZone })
    await fixtures.schedule(host.userId, { timeZone })
    const slug = 'weekly-call'
    const eventTypeId = await fixtures.eventType(host.organizationId, host.userId, {
      slug,
      bufferAfterMinutes,
    })
    await enableRecurrence(eventTypeId)
    return { ...host, eventTypeId, page: { handle: host.handle, slug } }
  }

  async function roundRobin() {
    const owner = await createTestUser(db, 'Series owner')
    const member = await createTestUser(db, 'Series member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const ctx = testContext(db, team.as(owner), now)
    const [firstHost, secondHost] =
      owner.id < member.id ? [owner.id, member.id] : [member.id, owner.id]
    for (const userId of [firstHost, secondHost]) await fixtures.schedule(userId, { timeZone })
    const event = await createEventType(ctx, {
      slug: 'weekly-team-call',
      title: 'Weekly team call',
      durationMinutes,
      schedulingType: 'round_robin',
      hosts: [{ userId: secondHost }, { userId: firstHost }],
    })
    await activateRoundRobin(ctx, event.id)
    await enableRecurrence(event.id)
    const { webhook } = await createWebhook(ctx, webhookSettings, {
      url: 'https://hooks.example.com/bookings',
      events: ['booking.created'],
    })
    return {
      organizationId: team.id,
      eventTypeId: event.id,
      firstHost,
      secondHost,
      page: { handle: ctx.principal.organization.slug, slug: event.slug },
      webhookId: webhook.id,
    }
  }

  async function counters() {
    const { rows } = await sql`SELECT
      (SELECT count(*) FROM bookings) AS bookings,
      (SELECT count(*) FROM booking_hosts) AS hosts,
      (SELECT count(*) FROM booking_attendees) AS attendees,
      (SELECT count(*) FROM booking_series) AS series,
      (SELECT count(*) FROM booking_series_occurrences) AS occurrences,
      (SELECT count(*) FROM booking_series_admissions) AS admissions,
      (SELECT count(*) FROM booking_series_receipts) AS receipts,
      (SELECT count(*) FROM booking_series_notifications) AS notifications,
      (SELECT count(*) FROM booking_conferences) AS conferences,
      (SELECT count(*) FROM audit_events) AS audits,
      (SELECT count(*) FROM webhook_deliveries) AS webhooks,
      (SELECT count(*) FROM pgboss.job) AS jobs`.execute(db)
    return rows[0]
  }

  async function roundRobinAssignment(eventTypeId: string) {
    const state = await db
      .selectFrom('round_robin_state')
      .select('next_sequence')
      .where('event_type_id', '=', eventTypeId)
      .executeTakeFirstOrThrow()
    const hosts = await db
      .selectFrom('event_type_hosts')
      .select(['user_id', 'last_assigned_sequence'])
      .where('event_type_id', '=', eventTypeId)
      .orderBy('user_id')
      .execute()
    return { ...state, hosts }
  }

  async function overdueHold(organizationId: string, userId: string, ordinal: number) {
    const start = occurrenceTime(ordinal)
    return db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('bookings')
        .values({
          organization_id: organizationId,
          status: 'pending_payment',
          payment_hold_expires_at: sql<Date>`least(clock_timestamp(), ${start.toString()}::timestamptz) - interval '1 minute'`,
          start_at: start.toString(),
          end_at: start.add({ minutes: durationMinutes }).toString(),
          source: 'web',
          title: 'Unexpired row for an overdue payment hold',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx.insertInto('booking_hosts').values({ booking_id: id, user_id: userId }).execute()
      return id
    })
  }

  async function holdStatus(id: string) {
    return db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()
  }

  it.each([1, 2, 3])('rolls back all writes when booking %i fails to insert', async (ordinal) => {
    const { organizationId, eventTypeId, firstHost, page } = await roundRobin()
    const hold = await overdueHold(organizationId, firstHost, 1)
    await sql`insert into test_series_insert_failures values
      (${eventTypeId}, ${occurrenceTime(ordinal).toString()})`.execute(db)
    const before = await counters()
    const fairnessBefore = await roundRobinAssignment(eventTypeId)
    const capture = webhookBookingNotifier(jobs, webhookSettings)
    const notifyWebhook = vi.fn(capture)

    await expect(
      createPublicTeamBookingSeries({ db, now }, seriesRequest(page), {
        ...recurring,
        notifyWebhook,
      }),
    ).rejects.toMatchObject({ code: 'P0001', message: 'synthetic series booking insertion failed' })
    expect(notifyWebhook).toHaveBeenCalledTimes(ordinal - 1)
    expect(await counters()).toEqual(before)
    expect(await roundRobinAssignment(eventTypeId)).toEqual(fairnessBefore)
    expect(await holdStatus(hold)).toEqual({ status: 'pending_payment' })
  })

  it.each(['single', 'series'] as const)(
    'serializes a %s winner with the other writer at a buffered, nonoverlapping slot',
    async (winnerKind) => {
      const { eventTypeId, page } = await personal(15)
      const request = seriesRequest(page)
      const singleInput = { ...page, invitee, start: occurrenceTime(2).add({ minutes: 30 }) }
      const winnerPid = Promise.withResolvers<number>()
      const releaseWinner = Promise.withResolvers<void>()
      const pauseWinner: BookingNotifier = async (trx) => {
        const { pid } = await trx
          .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
          .executeTakeFirstOrThrow()
        winnerPid.resolve(pid)
        await releaseWinner.promise
      }
      const single = (notify?: BookingNotifier) =>
        createPublicBooking({ db, now, notify }, singleInput)
      const series = (notifyWebhook?: BookingNotifier) =>
        createPublicBookingSeries({ db, now }, request, { ...recurring, notifyWebhook })
      const winner = winnerKind === 'single' ? single(pauseWinner) : series(pauseWinner)
      let completion: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        const pid = await Promise.race([
          winnerPid.promise,
          winner.then(() => {
            throw new Error('The winning writer did not pause inside its transaction')
          }),
        ])
        const contender = winnerKind === 'single' ? series() : single()
        completion = Promise.allSettled<unknown>([winner, contender])
        await expect
          .poll(
            async () => {
              const { rows } = await sql<{ waiting: boolean }>`
            SELECT EXISTS (
              SELECT FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event = 'advisory'
                AND ${pid} = ANY(pg_blocking_pids(pid))
            ) AS waiting
          `.execute(db)
              return rows[0]?.waiting
            },
            { timeout: 3000 },
          )
          .toBe(true)
      } finally {
        releaseWinner.resolve()
        await (completion ?? Promise.allSettled([winner]))
      }

      const [first, second] = await completion
      expect(first?.status).toBe('fulfilled')
      expect(second).toMatchObject({
        status: 'rejected',
        reason: { code: winnerKind === 'single' ? 'series_unavailable' : 'slot_unavailable' },
      })
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', eventTypeId)
          .execute(),
      ).toHaveLength(winnerKind === 'single' ? 1 : 3)
      expect(
        await db
          .selectFrom('booking_series_admissions')
          .select('id')
          .where('event_type_id', '=', eventTypeId)
          .execute(),
      ).toHaveLength(winnerKind === 'single' ? 0 : 1)
    },
  )

  it('assigns the common round-robin host once and queues an existing webhook per member', async () => {
    const { organizationId, eventTypeId, firstHost, secondHost, page, webhookId } =
      await roundRobin()
    const last = occurrenceTime(3)
    await fixtures.calendarBusy(firstHost, [
      [last.toString(), last.add({ minutes: durationMinutes }).toString()],
    ])
    // The other candidate's overdue hold must be drained even though it won't get the series.
    const hold = await overdueHold(organizationId, firstHost, 1)
    const ordinaryNotify = vi.fn(async () => {})
    const notifyWebhook = webhookBookingNotifier(jobs, webhookSettings)
    const request = seriesRequest(page)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected outbound fetch during series creation')
    })
    try {
      const created = await createPublicTeamBookingSeries(
        { db, now, notify: ordinaryNotify },
        request,
        { ...recurring, notifyWebhook },
      )
      const ids = created.occurrences.map(({ bookingId }) => bookingId).sort()
      expect(created.replayed).toBe(false)
      expect(ids).toHaveLength(3)
      expect(await holdStatus(hold)).toEqual({ status: 'expired' })
      expect(
        await db
          .selectFrom('booking_hosts')
          .select(['booking_id', 'user_id'])
          .where('booking_id', 'in', ids)
          .orderBy('booking_id')
          .execute(),
      ).toEqual(ids.map((booking_id) => ({ booking_id, user_id: secondHost })))
      const fairness = {
        next_sequence: '1',
        hosts: [
          { user_id: firstHost, last_assigned_sequence: '0' },
          { user_id: secondHost, last_assigned_sequence: '1' },
        ],
      }
      expect(await roundRobinAssignment(eventTypeId)).toEqual(fairness)

      const replay = await createPublicTeamBookingSeries(
        { db, now, notify: ordinaryNotify },
        request,
        {
          ...recurring,
          notifyWebhook,
        },
      )
      expect(replay.replayed).toBe(true)
      expect(await roundRobinAssignment(eventTypeId)).toEqual(fairness)
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .select(['id', 'event_type', 'booking_id', 'payload'])
        .where('webhook_id', '=', webhookId)
        .orderBy('booking_id')
        .execute()
      expect(deliveries.map(({ booking_id, event_type }) => ({ booking_id, event_type }))).toEqual(
        ids.map((booking_id) => ({ booking_id, event_type: 'booking.created' })),
      )
      for (const delivery of deliveries) {
        const payload = JSON.parse(delivery.payload)
        expect(payload.data).toMatchObject({ bookingId: delivery.booking_id, status: 'confirmed' })
        expect(delivery.payload).not.toContain(invitee.email)
      }
      const queued = await sql<{ delivery_id: string }>`select data->>'deliveryId' AS delivery_id
        from pgboss.job where name = ${WEBHOOK_DELIVERY_JOB}`.execute(db)
      expect(queued.rows.map(({ delivery_id }) => delivery_id).sort()).toEqual(
        deliveries.map(({ id }) => id).sort(),
      )
      expect(ordinaryNotify).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(webhookTransport).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('previews an overdue hold without writes and drains holds before series or single insertion', async () => {
    const series = await personal()
    const single = await personal()
    const seriesHold = await overdueHold(series.organizationId, series.userId, 2)
    const singleHold = await overdueHold(single.organizationId, single.userId, 2)
    const before = await counters()
    await expect(
      checkRecurringAvailability(db, {
        eventTypeId: series.eventTypeId,
        organizationId: series.organizationId,
        occurrences: dates(3),
        now: now(),
      }),
    ).resolves.toMatchObject({
      canBook: true,
      occurrences: [1, 2, 3].map((ordinal) => ({ ordinal, available: true })),
    })
    expect(await counters()).toEqual(before)
    expect(await holdStatus(seriesHold)).toEqual({ status: 'pending_payment' })

    const phases: string[] = []
    const loggedDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level !== 'query') return
        const { sql: statement, parameters } = event.query
        if (parameters.includes(`booking-host:${series.userId}`)) phases.push('host lock')
        if (statement.includes('for share of "et"')) phases.push('event lock')
        if (statement.includes("UPDATE bookings b SET status='expired'")) phases.push('drain')
        if (statement.startsWith('SAVEPOINT recurring_availability')) phases.push('recheck')
      },
    })
    const created = await createPublicBookingSeries(
      { db: loggedDb, now },
      seriesRequest(series.page),
      recurring,
    )
    expect(created.occurrences).toHaveLength(3)
    expect(phases).toEqual(['host lock', 'event lock', 'drain', 'recheck'])
    expect(await holdStatus(seriesHold)).toEqual({ status: 'expired' })

    await expect(
      createPublicBooking({ db, now }, { ...single.page, invitee, start: occurrenceTime(2) }),
    ).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    expect(await holdStatus(singleHold)).toEqual({ status: 'expired' })
  })
})
