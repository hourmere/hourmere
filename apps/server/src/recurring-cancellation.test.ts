import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { bookingNotificationJob, bookingNotifier } from '@hourmere/notifications'
import {
  type BookingNotifier,
  type CancelBookingSeriesInput,
  cancelHostBookingSeries,
  cancelManagedBooking,
  cancelManagedBookingSeries,
  createPublicTeamBookingSeries,
  expandRecurringRule,
  requestReschedule,
  rescheduleHostBooking,
  type ServiceContext,
} from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { createWebhook, webhookBookingNotifier, webhookDeliveryJob } from '@hourmere/webhooks'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const timeZone = 'UTC'
const firstLocalStart = '2026-11-02T09:00+00:00'
const durationMinutes = 30
const rule = { pattern: 'weekly', count: 3 } as const
const invitee = { name: 'Booker', email: 'booker@example.test', timeZone }
const guest = { name: 'Guest', email: 'guest@example.test' }
const webhookSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 17).toString('base64') }

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing series fixture value')
  return value
}

const all = (expectedRevision = '1'): CancelBookingSeriesInput => ({
  scope: 'all',
  expectedRevision,
  idempotencyKey: randomUUID(),
})

const following = (fromOrdinal: number, expectedRevision: string): CancelBookingSeriesInput => ({
  scope: 'following',
  fromOrdinal,
  expectedRevision,
  idempotencyKey: randomUUID(),
})

describe.skipIf(!serverUrl)('recurring series cancellation on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_cancel' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [
        bookingNotificationJob({
          db,
          now,
          publicUrl: 'http://localhost',
          secret: 'synthetic-test',
          mailer: {
            send: async () => {
              throw new Error('Unexpected mail delivery in outbox test')
            },
          },
        }),
        webhookDeliveryJob({ db, ...webhookSettings, transport: async () => 204 }),
      ],
      maxConnections: 2,
      work: false,
      migrate: true,
    })
    await jobs.start()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture(cancelCutoffMinutes?: number) {
    const f = createFixtures(db)
    const host = await createTestUser(db, 'Series host')
    const admin = await createTestUser(db, 'Team admin')
    const team = await createTestTeam(db, [
      { user: host, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const session = (user: typeof host): ServiceContext => {
      const { organization } = team.as(user)
      return {
        db,
        now,
        principal: { kind: 'session', sessionId: randomUUID(), user, organization },
      }
    }
    const hostCtx = session(host)
    const adminCtx = session(admin)
    const slug = 'series-cancel'
    await f.schedule(host.id, { timeZone })
    const eventTypeId = await f.eventType(team.id, null, {
      slug,
      allowGuests: true,
      hosts: [{ userId: host.id }],
      ...(cancelCutoffMinutes !== undefined && { cancelCutoffMinutes }),
    })
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 3 }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const result = await createPublicTeamBookingSeries(
      { db, now },
      {
        handle: hostCtx.principal.organization.slug,
        slug,
        firstLocalStart,
        rule,
        invitee,
        guests: [guest],
        idempotencyKey: randomUUID(),
        expectedPreview: {
          eventRevision: '0',
          timeZone,
          rule,
          durationMinutes,
          occurrences: expandRecurringRule({
            firstLocalStart,
            rule,
            timeZone,
            durationMinutes,
            now: now(),
          }).map(({ ordinal, localStart, start, end, offset }) => ({
            ordinal,
            localStart,
            start: start?.toString() ?? null,
            end: end?.toString() ?? null,
            offset,
          })),
        },
      },
      { recurringBookingsEnabled: true, actorDigest: randomBytes(32) },
    )
    return {
      host,
      hostCtx,
      adminCtx,
      organizationId: team.id,
      eventTypeId,
      seriesId: result.seriesId,
      token: required(result.manageToken),
      first: required(result.occurrences[0]),
      second: required(result.occurrences[1]),
      third: required(result.occurrences[2]),
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  const revision = async (f: Fixture) =>
    (
      await db
        .selectFrom('booking_series')
        .select('revision')
        .where('id', '=', f.seriesId)
        .executeTakeFirstOrThrow()
    ).revision
  const receipts = (f: Fixture) =>
    db
      .selectFrom('booking_series_receipts')
      .select(['affected_occurrence_ids', 'result_booking_ids'])
      .where('series_id', '=', f.seriesId)
      .where('operation_kind', '=', 'bulk_cancel')
      .orderBy('id')
      .execute()
  const outbox = (f: Fixture) =>
    db
      .selectFrom('booking_series_notifications')
      .select(['sequence', 'outbox_state', 'due_at', 'attempts'])
      .where('series_id', '=', f.seriesId)
      .where('row_type', '=', 'outbox')
      .where('kind', '=', 'cancellation')
      .orderBy('sequence')
      .execute()
  const statuses = (ids: string[]) =>
    db
      .selectFrom('bookings')
      .select(['id', 'status'])
      .where('id', 'in', ids)
      .orderBy('id')
      .execute()

  async function pendingRequest(f: Fixture, bookingId: string) {
    const { pendingReschedule } = await requestReschedule(f.hostCtx, bookingId, {
      idempotencyKey: randomUUID(),
    })
    return required(pendingReschedule).id
  }

  async function scheduledMessage(f: Fixture, bookingId: string, processing = false) {
    const booking = await db
      .selectFrom('bookings')
      .select(['start_at', 'end_at'])
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow()
    return db
      .insertInto('booking_scheduled_messages')
      .values({
        organization_id: f.organizationId,
        booking_id: bookingId,
        kind: 'reminder',
        rule_id: 'synthetic-reminder',
        anchor_start_at: booking.start_at,
        anchor_end_at: booking.end_at,
        due_at: now().toString(),
        expires_at: booking.start_at,
        next_attempt_at: now().toString(),
        ...(processing && {
          state: 'processing',
          claim_token: randomUUID(),
          lease_until: now().add({ minutes: 10 }).toString(),
        }),
      })
      .execute()
  }

  async function webhook(f: Fixture) {
    const { webhook } = await createWebhook(f.hostCtx, webhookSettings, {
      url: 'https://hooks.example.com/bookings',
      events: ['booking.cancelled'],
    })
    const deliveries = () =>
      db
        .selectFrom('webhook_deliveries')
        .select(['id', 'booking_id', 'event_type', 'payload'])
        .where('webhook_id', '=', webhook.id)
        .orderBy('booking_id')
        .execute()
    const email = bookingNotifier(jobs)
    const capture = webhookBookingNotifier(jobs, webhookSettings)
    const notify: BookingNotifier = async (trx, event, time) => {
      await email(trx, event, time)
      await capture(trx, event, time)
    }
    return { deliveries, notify }
  }

  it('cancels by current ordinal, resolves only affected requests and writes only their outboxes', async () => {
    const f = await fixture()
    // An earlier ordinal has been moved after both targets, and a target has moved
    // ahead of the other ordinal's original slot. The selector follows neither date.
    const movedFirst = await rescheduleHostBooking(f.hostCtx, f.first.bookingId, {
      start: Temporal.Instant.from('2026-11-16T11:00Z'),
    })
    const movedSecond = await rescheduleHostBooking(f.hostCtx, f.second.bookingId, {
      start: Temporal.Instant.from('2026-11-03T11:00Z'),
    })
    const unchangedId = movedFirst.booking.id
    const affectedIds = [movedSecond.booking.id, f.third.bookingId]
    const ids = [unchangedId, ...affectedIds]
    const unchangedRequest = await pendingRequest(f, unchangedId)
    const affectedRequest = await pendingRequest(f, movedSecond.booking.id)
    await scheduledMessage(f, unchangedId)
    await scheduledMessage(f, movedSecond.booking.id, true)
    await scheduledMessage(f, f.third.bookingId)
    const { deliveries, notify } = await webhook(f)
    const request = { ...following(2, '5'), reason: '  A change of plans  ' }
    const clock = vi.fn(now)
    const run = () => cancelManagedBookingSeries({ db, now: clock, notify }, f.token, request)

    const result = await run()
    expect(clock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      seriesId: f.seriesId,
      revision: '6',
      replayed: false,
      affected: [
        { id: f.second.id, ordinal: 2, bookingId: movedSecond.booking.id, status: 'cancelled' },
        { id: f.third.id, ordinal: 3, bookingId: f.third.bookingId, status: 'cancelled' },
      ],
      unchanged: [
        { id: f.first.id, ordinal: 1, bookingId: movedFirst.booking.id, status: 'confirmed' },
      ],
    })
    await expect(run()).resolves.toEqual({ ...result, replayed: true })
    expect(await receipts(f)).toEqual([
      { affected_occurrence_ids: [f.second.id, f.third.id], result_booking_ids: affectedIds },
    ])
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'cancel_reason'])
        .where('id', 'in', affectedIds)
        .orderBy('id')
        .execute(),
    ).toEqual(affectedIds.toSorted().map((id) => ({ id, cancel_reason: 'A change of plans' })))

    const requests = await db
      .selectFrom('booking_reschedule_requests')
      .select(['id', 'state', 'resolved_at'])
      .where('id', 'in', [affectedRequest, unchangedRequest])
      .execute()
    expect(requests).toHaveLength(2)
    expect(requests).toEqual(
      expect.arrayContaining([
        { id: affectedRequest, state: 'cancelled', resolved_at: new Date(now().epochMilliseconds) },
        { id: unchangedRequest, state: 'pending', resolved_at: null },
      ]),
    )
    const reminders = await db
      .selectFrom('booking_scheduled_messages')
      .select(['booking_id', 'state', 'skip_reason', 'claim_token', 'lease_until'])
      .where('booking_id', 'in', ids)
      .orderBy('booking_id')
      .execute()
    expect(reminders).toEqual(
      ids.toSorted().map((booking_id) => ({
        booking_id,
        state: booking_id === unchangedId ? 'pending' : 'skipped',
        skip_reason: booking_id === unchangedId ? null : 'booking_cancelled',
        claim_token: null,
        lease_until: null,
      })),
    )
    expect(await outbox(f)).toEqual([
      {
        sequence: '6',
        outbox_state: 'pending',
        due_at: new Date(now().epochMilliseconds),
        attempts: 0,
      },
    ])
    expect(
      await db
        .selectFrom('booking_series_notifications as n')
        .innerJoin('booking_series_receipts as r', (join) =>
          join
            .onRef('r.id', '=', 'n.id')
            .onRef('r.series_id', '=', 'n.series_id')
            .onRef('r.organization_id', '=', 'n.organization_id'),
        )
        .select('r.affected_occurrence_ids')
        .where('n.series_id', '=', f.seriesId)
        .where('n.kind', '=', 'cancellation')
        .where('n.sequence', '=', '6')
        .where('r.operation_kind', '=', 'bulk_cancel')
        .executeTakeFirstOrThrow(),
    ).toEqual({ affected_occurrence_ids: [f.second.id, f.third.id] })

    const rows = await deliveries()
    expect(rows.map(({ booking_id, event_type }) => ({ booking_id, event_type }))).toEqual(
      affectedIds.toSorted().map((booking_id) => ({ booking_id, event_type: 'booking.cancelled' })),
    )
    for (const delivery of rows) {
      expect(JSON.parse(delivery.payload).data).toMatchObject({
        bookingId: delivery.booking_id,
        status: 'cancelled',
      })
      expect(delivery.payload).not.toContain(invitee.email)
      expect(delivery.payload).not.toContain(f.token)
    }
    const queued = await sql<{ name: string; data: { deliveryId?: string; bookingId?: string } }>`
      SELECT name, data FROM pgboss.job
      WHERE data->>'deliveryId' IN (${sql.join(rows.map(({ id }) => id))})
         OR data->>'bookingId' IN (${sql.join(ids)})
      ORDER BY data->>'deliveryId'
    `.execute(db)
    expect(queued.rows).toEqual(
      rows
        .map(({ id }) => id)
        .sort()
        .map((deliveryId) => ({ name: 'webhook-delivery', data: { deliveryId } })),
    )
  })

  it('cancels one through the existing service, cancels all remaining future members and replays a no-op', async () => {
    const f = await fixture()
    const notify = vi.fn<BookingNotifier>(async () => {})
    const ctx = { db, now, notify }
    await expect(
      cancelManagedBooking(ctx, { seriesManageToken: f.token, ordinal: 2, expectedRevision: '1' }),
    ).resolves.toMatchObject({ id: f.second.bookingId, status: 'cancelled' })
    expect(notify.mock.calls.map(([, event]) => event)).toEqual([
      { type: 'cancelled', bookingId: f.second.bookingId },
    ])
    const allCtx = { ...f.hostCtx, now: () => Temporal.Instant.from(f.first.start), notify }
    await expect(cancelHostBookingSeries(allCtx, f.seriesId, all())).rejects.toMatchObject({
      code: 'series_changed',
    })
    expect(await receipts(f)).toEqual([])
    expect(await outbox(f)).toEqual([])
    const request = all('2')
    const result = await cancelHostBookingSeries(allCtx, f.seriesId, request)
    expect(result).toMatchObject({
      revision: '3',
      affected: [{ id: f.third.id, status: 'cancelled' }],
      unchanged: [
        { id: f.first.id, status: 'confirmed' },
        { id: f.second.id, status: 'cancelled' },
      ],
    })
    const noOp = all('3')
    const empty = await cancelHostBookingSeries(allCtx, f.seriesId, noOp)
    expect(empty).toMatchObject({
      revision: '4',
      replayed: false,
      affected: [],
      unchanged: [
        { id: f.first.id, status: 'confirmed' },
        { id: f.second.id, status: 'cancelled' },
        { id: f.third.id, status: 'cancelled' },
      ],
    })
    await expect(cancelHostBookingSeries(allCtx, f.seriesId, noOp)).resolves.toEqual({
      ...empty,
      replayed: true,
    })
    await expect(cancelHostBookingSeries(allCtx, f.seriesId, request)).resolves.toMatchObject({
      ...result,
      revision: '4',
      replayed: true,
    })
    await expect(
      cancelHostBookingSeries(allCtx, f.seriesId, { ...request, reason: 'Different body' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    expect(await revision(f)).toBe('4')
    expect(await receipts(f)).toHaveLength(2)
    expect(await outbox(f)).toHaveLength(1)
    expect(notify.mock.calls.map(([, event]) => event)).toEqual([
      { type: 'cancelled', bookingId: f.second.bookingId },
      { type: 'cancelled', bookingId: f.third.bookingId, seriesAction: 'bulk_cancel' },
    ])
  })

  it('enforces the invitee cutoff at the exact deadline, atomically; hosts may bypass it', async () => {
    const f = await fixture(60)
    const deadline = Temporal.Instant.from(f.first.start).subtract({ minutes: 60 })
    const clock = () => deadline
    const request = all()
    const ids = [f.first.bookingId, f.second.bookingId, f.third.bookingId]
    await expect(
      cancelManagedBookingSeries({ db, now: clock }, f.token, request),
    ).rejects.toMatchObject({ code: 'booking_cancel_deadline_passed' })
    expect(await statuses(ids)).toEqual(ids.toSorted().map((id) => ({ id, status: 'confirmed' })))
    expect(await revision(f)).toBe('1')
    expect(await receipts(f)).toEqual([])
    expect(await outbox(f)).toEqual([])
    await expect(
      cancelHostBookingSeries({ ...f.hostCtx, now: clock }, f.seriesId, request),
    ).resolves.toMatchObject({
      affected: ids.map((bookingId) => ({ bookingId, status: 'cancelled' })),
    })

    const earlier = await fixture(60)
    await expect(
      cancelManagedBookingSeries(
        { db, now: () => deadline.subtract({ milliseconds: 1 }) },
        earlier.token,
        all(),
      ),
    ).resolves.toMatchObject({
      affected: [earlier.first, earlier.second, earlier.third].map(({ id }) => ({
        id,
        status: 'cancelled',
      })),
      unchanged: [],
    })
  })

  it('preserves replay and current unchanged members after event deletion; organization deletion removes access and receipts', async () => {
    const f = await fixture()
    const request = following(2, '1')
    const first = await cancelManagedBookingSeries({ db, now }, f.token, request)
    const moved = await rescheduleHostBooking(f.hostCtx, f.first.bookingId, {
      start: Temporal.Instant.from('2026-11-02T10:00Z'),
    })
    await db.deleteFrom('event_types').where('id', '=', f.eventTypeId).execute()
    await expect(cancelManagedBookingSeries({ db, now }, f.token, request)).resolves.toMatchObject({
      revision: '3',
      replayed: true,
      affected: first.affected,
      unchanged: [{ bookingId: moved.booking.id, status: 'confirmed' }],
    })
    await expect(cancelManagedBookingSeries({ db, now }, f.token, all('3'))).resolves.toMatchObject(
      { affected: [{ bookingId: moved.booking.id, status: 'cancelled' }] },
    )
    await db.deleteFrom('auth.organization').where('id', '=', f.organizationId).execute()
    await expect(cancelManagedBookingSeries({ db, now }, f.token, request)).rejects.toMatchObject({
      code: 'series_not_found',
    })
    expect(await receipts(f)).toEqual([])
    expect(await outbox(f)).toEqual([])
  })

  it('requires a booker or a host authorized for every target, including on replay', async () => {
    const f = await fixture()
    const guestToken = randomBytes(32).toString('base64url')
    const guestAttendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', f.first.bookingId)
      .where('is_booker', '=', false)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_series_notifications')
      .values({
        organization_id: f.organizationId,
        series_id: f.seriesId,
        row_type: 'receipt',
        kind: 'confirmation',
        sequence: 1,
        recipient_id: guestAttendee.id,
        recipient_role: 'guest',
        outcome: 'delivered',
        capability_scope: 'read',
        manage_token_hash: createHash('sha256').update(guestToken).digest(),
        sent_at: now().toString(),
        reported_ordinals: [1, 2, 3],
        reported_link_states: ['no_conference', 'no_conference', 'no_conference'],
      })
      .execute()
    const request = following(2, '1')
    await expect(
      cancelManagedBookingSeries({ db, now }, guestToken, request),
    ).rejects.toMatchObject({ code: 'series_not_found' })
    await expect(cancelHostBookingSeries(f.adminCtx, f.seriesId, request)).rejects.toMatchObject({
      code: 'series_not_found',
    })
    const other = await fixture()
    await expect(cancelHostBookingSeries(other.hostCtx, f.seriesId, request)).rejects.toMatchObject(
      {
        code: 'series_not_found',
      },
    )

    const changeBookerEmail = (email: string) =>
      db
        .updateTable('booking_attendees')
        .set({ email })
        .where('booking_id', '=', f.third.bookingId)
        .where('is_booker', '=', true)
        .execute()
    await changeBookerEmail('different-booker@example.test')
    await expect(cancelManagedBookingSeries({ db, now }, f.token, request)).rejects.toMatchObject({
      code: 'series_not_found',
    })
    await changeBookerEmail(invitee.email)

    const removeHost = (bookingId: string) =>
      db
        .deleteFrom('booking_hosts')
        .where('booking_id', '=', bookingId)
        .where('user_id', '=', f.host.id)
        .execute()
    await removeHost(f.third.bookingId)
    await expect(cancelHostBookingSeries(f.hostCtx, f.seriesId, request)).rejects.toMatchObject({
      code: 'series_not_found',
    })
    expect(await revision(f)).toBe('1')
    expect(await receipts(f)).toEqual([])
    expect(await outbox(f)).toEqual([])
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: f.third.bookingId, user_id: f.host.id })
      .execute()
    await cancelHostBookingSeries(f.hostCtx, f.seriesId, request)
    await removeHost(f.third.bookingId)
    await expect(cancelHostBookingSeries(f.hostCtx, f.seriesId, request)).rejects.toMatchObject({
      code: 'series_not_found',
    })
    expect(await revision(f)).toBe('2')
    expect(await receipts(f)).toHaveLength(1)
  })

  it('rolls back every target when a later webhook enqueue fails', async () => {
    const f = await fixture()
    const original = await pendingRequest(f, f.second.bookingId)
    await scheduledMessage(f, f.second.bookingId)
    const { deliveries, notify } = await webhook(f)
    const failingNotify: BookingNotifier = async (trx, event, time) => {
      await notify(trx, event, time)
      if (event.bookingId === f.third.bookingId) throw new Error('Synthetic enqueue failure')
    }

    await expect(
      cancelHostBookingSeries(
        { ...f.hostCtx, notify: failingNotify },
        f.seriesId,
        following(2, '2'),
      ),
    ).rejects.toThrow('Synthetic enqueue failure')
    const ids = [f.second.bookingId, f.third.bookingId]
    expect(await statuses(ids)).toEqual(ids.toSorted().map((id) => ({ id, status: 'confirmed' })))
    expect(await revision(f)).toBe('2')
    expect(await receipts(f)).toEqual([])
    expect(await outbox(f)).toEqual([])
    expect(await deliveries()).toEqual([])
    expect(
      await db
        .selectFrom('booking_reschedule_requests')
        .select('state')
        .where('id', '=', original)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'pending' })
    expect(
      await db
        .selectFrom('booking_scheduled_messages')
        .select('state')
        .where('booking_id', '=', f.second.bookingId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'pending' })
    expect(
      (
        await sql`SELECT id FROM pgboss.job WHERE data->>'bookingId' IN (${sql.join(ids)})`.execute(
          db,
        )
      ).rows,
    ).toEqual([])
  })
})
