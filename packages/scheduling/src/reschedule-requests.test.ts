import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  expireRescheduleRequest,
  getHostBooking,
  getManagedBooking,
  requestReschedule,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import {
  assertManageRequestIsolation,
  assertOrganizationIsolation,
} from './reschedule-request-isolation-testing.ts'
import { createFixtures } from './testing.ts'

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing fixture')
  return value
}
const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
describe.skipIf(!serverUrl)('reschedule requests', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(start = '2026-11-02T09:00:00Z', clock = now) {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const events: BookingEvent[] = []
    const pub: PublicContext = {
      db,
      now: () => clock,
      notify: async (_trx, event) => {
        events.push(event)
      },
    }
    const ctx: ServiceContext = {
      ...pub,
      principal: {
        kind: 'session',
        sessionId: 'test',
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const created = await createPublicBooking(pub, {
      handle: host.handle,
      slug: 'intro',
      start: Temporal.Instant.from(start),
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'Europe/Berlin' },
    })
    return { ctx, pub, created, events }
  }
  it.each(['session', 'api_key'] as const)(
    'refuses requests for another organization even when the %s caller hosts the booking',
    async (kind) => {
      await assertOrganizationIsolation(
        db,
        { requestReschedule, cancelManagedBooking, rescheduleManagedBooking },
        kind,
      )
    },
  )
  it.each(['pending', 'picked', 'cancelled'] as const)(
    'scopes picking and cancellation to the manage token booking with a %s request',
    async (state) => {
      for (const action of ['pick', 'cancel'] as const) {
        await assertManageRequestIsolation(
          db,
          { requestReschedule, cancelManagedBooking, rescheduleManagedBooking },
          setup,
          state,
          action,
        )
      }
    },
  )
  it('keeps the original block, sanitizes body note, replaces requests and replays without notifications', async () => {
    const { ctx, created, events } = await setup()
    const key = randomUUID()
    const requested = await requestReschedule(
      { ...ctx, followUpHostNotesEnabled: false },
      created.booking.id,
      {
        idempotencyKey: key,
        note: 'First\r\n\u202anote',
      },
    )
    expect(requested.status).toBe('confirmed')
    expect(requested.isGroupSeat).toBeUndefined()
    expect(requested.pendingReschedule?.note).toBe('First\nnote')
    expect(requested.pendingReschedule?.expiresAt).toBe(created.booking.start)
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('active')
        .where('booking_id', '=', created.booking.id)
        .executeTakeFirst(),
    ).toEqual({ active: true })
    expect((await getHostBooking(ctx, created.booking.id)).pendingReschedule).toEqual(
      requested.pendingReschedule,
    )
    await requestReschedule(ctx, created.booking.id, {
      idempotencyKey: key,
      note: 'First\r\n\u202anote',
    })
    expect(events.filter((e) => e.type === 'reschedule_requested')).toHaveLength(1)
    await expect(
      requestReschedule(ctx, created.booking.id, { idempotencyKey: key, note: 'different' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await requestReschedule(ctx, created.booking.id, { idempotencyKey: randomUUID() })
    expect(
      (
        await db
          .selectFrom('booking_reschedule_requests')
          .select('state')
          .where('id', '=', required(requested.pendingReschedule).id)
          .executeTakeFirst()
      )?.state,
    ).toBe('replaced')
  })
  it.each([
    [
      'control character',
      'bad\tcontrol',
      'note: must not contain control characters other than LF',
    ],
    [
      'overlong',
      'a'.repeat(2001),
      'note: Too big: expected string to have <=2000 characters; note: must contain at most 2000 UTF-16 code units',
    ],
  ])(
    'rejects an invalid note through the service with a typed client error: %s',
    async (_label, note, message) => {
      const { ctx, created, events } = await setup()
      const request = requestReschedule(ctx, created.booking.id, {
        idempotencyKey: randomUUID(),
        note,
      })
      await expect(request).rejects.toBeInstanceOf(DomainError)
      await expect(request).rejects.toMatchObject({
        kind: 'invalid',
        code: 'invalid_request',
        message,
        detail: message,
      })
      expect((await getHostBooking(ctx, created.booking.id)).pendingReschedule).toBeUndefined()
      expect(events.filter((event) => event.type === 'reschedule_requested')).toHaveLength(0)
    },
  )
  it('expires once and preserves booking, ignores stale expiry and unauthorized hosts', async () => {
    const { ctx, pub, created, events } = await setup()
    const request = await requestReschedule(ctx, created.booking.id, {
      idempotencyKey: randomUUID(),
    })
    const id = required(request.pendingReschedule).id
    await expireRescheduleRequest(pub, id)
    expect(events.filter((e) => e.type === 'reschedule_request_expired')).toHaveLength(0)
    const later = { ...pub, now: () => Temporal.Instant.from(created.booking.start) }
    expect(
      (await getHostBooking({ ...ctx, now: later.now }, created.booking.id)).pendingReschedule,
    ).toBeUndefined()
    expect(
      (await getManagedBooking(later, required(created.manageToken))).pendingReschedule,
    ).toBeUndefined()
    await expect(
      cancelManagedBooking(later, required(created.manageToken), { rescheduleRequestId: id }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    await expect(
      rescheduleManagedBooking(later, required(created.manageToken), {
        rescheduleRequestId: id,
        start: Temporal.Instant.from('2026-11-03T10:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })

    await Promise.all([expireRescheduleRequest(later, id), expireRescheduleRequest(later, id)])
    expect(events.filter((e) => e.type === 'reschedule_request_expired')).toHaveLength(1)
    expect((await getHostBooking(ctx, created.booking.id)).status).toBe('confirmed')
    expect((await getHostBooking(ctx, created.booking.id)).pendingReschedule).toBeUndefined()
    await expect(
      requestReschedule(
        {
          ...ctx,
          principal: { ...ctx.principal, user: { ...ctx.principal.user, id: randomUUID() } },
        },
        created.booking.id,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
  })
  it('serializes two picks and pick versus host cancel for twenty rounds each', async () => {
    for (let i = 0; i < 20; i++) {
      const { ctx, pub, created } = await setup()
      const requested = await requestReschedule(ctx, created.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const rescheduleRequestId = required(requested.pendingReschedule).id
      const start = Temporal.Instant.from('2026-11-02T10:00:00Z')
      const results = await Promise.all([
        rescheduleManagedBooking(pub, required(created.manageToken), {
          start,
          rescheduleRequestId,
        }),
        rescheduleManagedBooking(pub, required(created.manageToken), {
          start,
          rescheduleRequestId,
        }),
      ])
      expect(results[0].booking.id).toBe(results[1].booking.id)
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('rescheduled_from_id', '=', created.booking.id)
          .execute(),
      ).toHaveLength(1)
      await expect(
        rescheduleManagedBooking(pub, required(created.manageToken), {
          start: Temporal.Instant.from('2026-11-02T11:00:00Z'),
          rescheduleRequestId,
        }),
      ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
      const second = await setup()
      const req = await requestReschedule(second.ctx, second.created.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const race = await Promise.allSettled([
        rescheduleManagedBooking(second.pub, required(second.created.manageToken), {
          start,
          rescheduleRequestId: required(req.pendingReschedule).id,
        }),
        cancelHostBooking(second.ctx, second.created.booking.id),
      ])
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(
        (
          await db
            .selectFrom('booking_reschedule_requests')
            .select('state')
            .where('id', '=', required(req.pendingReschedule).id)
            .executeTakeFirst()
        )?.state,
      ).toMatch(/picked|cancelled/)
    }
  }, 60000)
  it('request cancellation replays and refuses picking afterwards', async () => {
    const { ctx, pub, created } = await setup()
    const request = await requestReschedule(ctx, created.booking.id, {
      idempotencyKey: randomUUID(),
    })
    const rescheduleRequestId = required(request.pendingReschedule).id
    await cancelManagedBooking(pub, required(created.manageToken), { rescheduleRequestId })
    expect(
      (await cancelManagedBooking(pub, required(created.manageToken), { rescheduleRequestId }))
        .status,
    ).toBe('cancelled')
    await expect(
      rescheduleManagedBooking(pub, required(created.manageToken), {
        rescheduleRequestId,
        start: Temporal.Instant.from('2026-11-02T10:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
  })
  it('refuses imported and group-seat requests clearly', async () => {
    const { ctx } = await setup()
    const imported = await db
      .insertInto('bookings')
      .values({
        organization_id: ctx.principal.organization.id,
        start_at: '2026-11-03T09:00Z',
        end_at: '2026-11-03T09:30Z',
        title: 'Imported',
        source: 'import',
        import_questions: '[]',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: imported.id, user_id: ctx.principal.user.id })
      .execute()
    await expect(
      requestReschedule(ctx, imported.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'imported_booking_read_only' })
    const { groupFixture, occupiedSlot } = await import('../../db/src/group-seats-fixtures.ts')
    const group = await groupFixture(owned.pool)
    const occupied = await occupiedSlot(group)
    const groupCtx: ServiceContext = {
      ...ctx,
      principal: {
        ...ctx.principal,
        user: { ...ctx.principal.user, id: group.host },
        organization: { ...ctx.principal.organization, id: group.organization },
      },
    }
    expect((await getHostBooking(groupCtx, required(occupied.bookings[0]))).isGroupSeat).toBe(true)
    await expect(
      requestReschedule(groupCtx, required(occupied.bookings[0]), { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'booking_group_seat_unsupported' })
  })
  it('bounds distant requests to 48 hours and keeps normal availability validation', async () => {
    const { ctx, pub, created } = await setup('2026-11-06T09:00Z')
    const request = await requestReschedule(ctx, created.booking.id, {
      idempotencyKey: randomUUID(),
    })
    expect(request.pendingReschedule?.expiresAt).toBe('2026-11-03T12:00:00.000Z')
    await expect(
      rescheduleManagedBooking(pub, required(created.manageToken), {
        rescheduleRequestId: required(request.pendingReschedule).id,
        start: Temporal.Instant.from('2026-11-02T03:00Z'),
      }),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect((await getHostBooking(ctx, created.booking.id)).pendingReschedule?.id).toBe(
      request.pendingReschedule?.id,
    )
  })
  it('uses elapsed hours across the Berlin fall-back transition', async () => {
    const clock = Temporal.Instant.from('2026-10-24T12:00Z')
    const { ctx, created } = await setup('2026-10-27T09:00Z', clock)
    const request = await requestReschedule(ctx, created.booking.id, {
      idempotencyKey: randomUUID(),
    })
    expect(request.pendingReschedule?.expiresAt).toBe('2026-10-26T12:00:00.000Z')
    expect(
      Temporal.Instant.from(required(request.pendingReschedule).expiresAt)
        .since(clock)
        .total('hours'),
    ).toBe(48)
  })
  it('serializes expiry/pick and replacement/pick for twenty rounds each', async () => {
    for (let i = 0; i < 20; i++) {
      const { ctx, pub, created } = await setup('2026-11-06T09:00Z')
      const request = await requestReschedule(ctx, created.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const id = required(request.pendingReschedule).id
      const outcomes = await Promise.allSettled([
        rescheduleManagedBooking(pub, required(created.manageToken), {
          start: Temporal.Instant.from('2026-11-06T10:00Z'),
          rescheduleRequestId: id,
        }),
        expireRescheduleRequest(
          { ...pub, now: () => Temporal.Instant.from('2026-11-03T12:00Z') },
          id,
        ),
      ])
      const terminal = await db
        .selectFrom('booking_reschedule_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(terminal.state).toMatch(/picked|expired/)
      expect(outcomes[1].status).toBe('fulfilled')
      expect(outcomes[0].status).toBe(terminal.state === 'picked' ? 'fulfilled' : 'rejected')
      const second = await setup()
      const first = await requestReschedule(second.ctx, second.created.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const race = await Promise.allSettled([
        requestReschedule(second.ctx, second.created.booking.id, { idempotencyKey: randomUUID() }),
        rescheduleManagedBooking(second.pub, required(second.created.manageToken), {
          start: Temporal.Instant.from('2026-11-02T10:00Z'),
          rescheduleRequestId: required(first.pendingReschedule).id,
        }),
      ])
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const state = await db
        .selectFrom('booking_reschedule_requests')
        .select('state')
        .where('id', '=', required(first.pendingReschedule).id)
        .executeTakeFirstOrThrow()
      expect(state.state).toMatch(/replaced|picked/)
    }
  }, 60000)
  it('email tokens follow the successor without allowing a second pick from stale tabs', async () => {
    for (let i = 0; i < 20; i++) {
      const { ctx, pub, created } = await setup()
      const request = await requestReschedule(ctx, created.booking.id, {
        idempotencyKey: randomUUID(),
      })
      const rescheduleRequestId = required(request.pendingReschedule).id
      const token = randomBytes(32).toString('base64url')
      const attendee = await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', created.booking.id)
        .where('is_booker', '=', true)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('booking_notifications')
        .values({
          booking_id: created.booking.id,
          kind: 'confirmed',
          recipient: `attendee:${attendee.id}`,
          manage_token_hash: createHash('sha256').update(token).digest(),
        })
        .execute()
      const starts = ['2026-11-02T10:00Z', '2026-11-02T11:00Z'].map(Temporal.Instant.from)
      const results = await Promise.allSettled(
        starts.map((start) => rescheduleManagedBooking(pub, token, { start, rescheduleRequestId })),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const index = results.findIndex((r) => r.status === 'fulfilled')
      const selected = await rescheduleManagedBooking(pub, token, {
        start: required(starts[index]),
        rescheduleRequestId,
      })
      expect(selected.manageToken).toBeNull()
      expect((await getManagedBooking(pub, token)).id).toBe(selected.booking.id)
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('organization_id', '=', ctx.principal.organization.id)
          .where('status', '=', 'confirmed')
          .execute(),
      ).toHaveLength(1)
    }
  }, 60000)
})
