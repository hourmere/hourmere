import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listPublicSlots } from './availability.ts'
import {
  cancelHostBooking,
  cancelManagedBooking,
  createOneTimeBooking,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = Temporal.Instant.from('2027-11-01T09:00:00Z')
describe.skipIf(!process.env.DATABASE_URL)('group seat booking services', () => {
  let t: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext
  beforeAll(async () => {
    t = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(t.pool)
    f = createFixtures(db)
    ctx = {
      db,
      now: () => NOW,
      notify: async (trx, event) => {
        await trx
          .insertInto('booking_notifications')
          .values({
            booking_id: event.bookingId,
            kind: event.type === 'created' ? 'confirmed' : event.type,
            recipient: 'host:00000000-0000-4000-8000-000000000001',
          })
          .execute()
      },
    }
  })
  afterAll(async () => {
    await t?.drop()
  })
  async function setup(capacity = 2) {
    const host = await f.host()
    await f.schedule(host.userId)
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'group',
      title: 'Class',
      durationMinutes: 30,
      location: { kind: 'link', url: 'https://example.test/class' },
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: capacity })
      .where('id', '=', eventId)
      .execute()
    const book = (email: string, start = START, key = randomUUID(), c = ctx) =>
      createPublicBooking(c, {
        handle: host.handle,
        slug: 'group',
        start,
        invitee: { name: email, email, timeZone: 'UTC' },
        idempotencyKey: key,
      })
    return { ...host, eventId, book }
  }
  async function state(eventId: string) {
    return db
      .selectFrom('group_slots')
      .selectAll()
      .where('original_event_type_id', '=', eventId)
      .orderBy('created_at')
      .execute()
  }
  it('keeps seats on the shared default and rejects per-seat choices before creating a slot', async () => {
    const s = await setup(3)
    const locations = [
      { id: 'shared', kind: 'link', url: 'https://example.test', isDefault: true },
      { id: 'office', kind: 'in_person', address: 'Other room' },
      { id: 'call', kind: 'phone', askInvitee: true },
    ]
    await db
      .updateTable('event_types')
      .set({
        locations: JSON.stringify(locations),
        location: JSON.stringify({ kind: 'link', url: 'https://example.test' }),
      })
      .where('id', '=', s.eventId)
      .execute()
    const query = { handle: s.handle, slug: 'group', start: START, end: START.add({ hours: 1 }) }
    for (const locationOptionId of ['office', 'call']) {
      await expect(listPublicSlots(ctx, { ...query, locationOptionId })).rejects.toMatchObject({
        code: 'location_unavailable',
      })
      await expect(
        createPublicBooking(ctx, {
          ...query,
          locationOptionId,
          inviteePhone: '+14155550123',
          invitee: { name: 'Guest', email: 'guest@example.test', timeZone: 'UTC' },
        }),
      ).rejects.toMatchObject({ code: 'location_unavailable' })
      expect(await state(s.eventId)).toEqual([])
    }
    const a = await createPublicBooking(ctx, {
      ...query,
      locationOptionId: 'shared',
      invitee: { name: 'A', email: 'a@example.test', timeZone: 'UTC' },
    })
    const b = await s.book('b@example.test')
    const slot = (await state(s.eventId))[0]!
    expect(slot.active_seats).toBe(2)
    const seats = await db
      .selectFrom('bookings')
      .select(['location', 'location_option'])
      .where('id', 'in', [a.booking.id, b.booking.id])
      .execute()
    for (const seat of seats) {
      expect(seat.location).toEqual(slot.location)
      expect(seat.location_option).toEqual(slot.location_option)
    }
  })
  it('refuses invitee-phone collection even when it is the group default', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({
        location: JSON.stringify({ kind: 'phone', askInvitee: true }),
        locations: JSON.stringify([{ id: 'call', kind: 'phone', askInvitee: true }]),
      })
      .where('id', '=', s.eventId)
      .execute()
    const query = { handle: s.handle, slug: 'group', start: START, end: START.add({ hours: 1 }) }
    await expect(listPublicSlots(ctx, query)).rejects.toMatchObject({
      code: 'location_unavailable',
    })
    await expect(
      createPublicBooking(ctx, {
        ...query,
        inviteePhone: '+14155550123',
        invitee: { name: 'A', email: 'a@example.test', timeZone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'location_unavailable' })
    expect(await state(s.eventId)).toEqual([])
  })
  it('shares occupancy, isolates managed payloads, releases only the last seat and replays without side effects', async () => {
    const s = await setup()
    const key = randomUUID()
    const a = await s.book('alice@example.test', START, key)
    const b = await s.book('bob@example.test')
    expect((await state(s.eventId)).map((s) => s.active_seats)).toEqual([2])
    expect(
      await db
        .selectFrom('booking_hosts')
        .selectAll()
        .where('group_slot_id', '=', (await state(s.eventId))[0]!.id)
        .execute(),
    ).toHaveLength(1)
    expect(JSON.stringify(await getManagedBooking(ctx, a.manageToken!))).not.toContain(
      'bob@example.test',
    )
    expect(JSON.stringify(await getManagedBooking(ctx, b.manageToken!))).not.toContain(
      'alice@example.test',
    )
    await expect(s.book('ALICE@example.test')).rejects.toMatchObject({ code: 'slot_unavailable' })
    const replay = await s.book('alice@example.test', START, key)
    expect(replay.booking.id).toBe(a.booking.id)
    expect(replay.manageToken).toBeNull()
    await cancelManagedBooking(ctx, a.manageToken!)
    expect((await state(s.eventId))[0]!.active_seats).toBe(1)
    await cancelManagedBooking(ctx, a.manageToken!)
    expect((await state(s.eventId))[0]!.active_seats).toBe(1)
    await cancelManagedBooking(ctx, b.manageToken!)
    expect((await state(s.eventId))[0]!.state).toBe('retired')
    expect((await s.book('alice@example.test', START, key)).booking.status).toBe('cancelled')
    await s.book('carol@example.test')
    expect((await state(s.eventId)).map((s) => s.active_seats)).toEqual([0, 1])
    expect(
      await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', a.booking.id)
        .execute(),
    ).toHaveLength(2)
  })
  it('rolls back source when destination is full, supports no-op and lost-response move replay', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    const target = START.add({ hours: 1 })
    await s.book('b@example.test', target)
    await s.book('c@example.test', target)
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, {
        start: target,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'slot_taken' })
    expect((await getManagedBooking(ctx, a.manageToken!)).status).toBe('confirmed')
    const noopKey = randomUUID()
    const noop = await rescheduleManagedBooking(ctx, a.manageToken!, {
      start: START,
      idempotencyKey: noopKey,
    })
    expect(noop.booking.id).toBe(a.booking.id)
    const key = randomUUID()
    const moved = await rescheduleManagedBooking(ctx, a.manageToken!, {
      start: START.add({ hours: 2 }),
      idempotencyKey: key,
    })
    const replay = await rescheduleManagedBooking(ctx, a.manageToken!, {
      start: START.add({ hours: 2 }),
      idempotencyKey: key,
    })
    expect(replay.booking.id).toBe(moved.booking.id)
    expect(replay.manageToken).toBeNull()
    expect(
      (
        await rescheduleManagedBooking(ctx, a.manageToken!, {
          start: START,
          idempotencyKey: noopKey,
        })
      ).booking.id,
    ).toBe(a.booking.id)
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, {
        start: START.add({ hours: 3 }),
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    expect((await state(s.eventId)).reduce((n, s) => n + s.active_seats, 0)).toBe(3)
  })
  it('serializes the last seat for twenty rounds on separate pooled connections', async () => {
    for (let round = 0; round < 20; round++) {
      const s = await setup()
      await s.book('first@example.test')
      const outcomes = await Promise.allSettled([
        s.book('a@example.test'),
        s.book('b@example.test'),
      ])
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await state(s.eventId))[0]!.active_seats).toBe(2)
      const rows = await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.eventId)
        .where('status', '=', 'confirmed')
        .execute()
      expect(rows).toHaveLength(2)
      expect(
        await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where(
            'booking_id',
            'in',
            rows.map((r) => r.id),
          )
          .execute(),
      ).toHaveLength(2)
    }
  }, 60000)
  it('serializes cancel/rebook for twenty rounds without reviving retired slots', async () => {
    for (let round = 0; round < 20; round++) {
      const s = await setup()
      const a = await s.book('a@example.test')
      await Promise.all([cancelManagedBooking(ctx, a.manageToken!), s.book('b@example.test')])
      const slots = await state(s.eventId)
      expect(slots.reduce((n, s) => n + s.active_seats, 0)).toBe(1)
      expect(slots.filter((s) => s.state === 'open')).toHaveLength(1)
    }
  }, 60000)
  it('moves across slots under contention for twenty rounds without losing source seats', async () => {
    for (let round = 0; round < 20; round++) {
      const s = await setup()
      const a = await s.book('a@example.test')
      const b = await s.book('b@example.test')
      const target = START.add({ hours: 1 })
      await s.book('c@example.test', target)
      const outcomes = await Promise.allSettled([
        rescheduleManagedBooking(ctx, a.manageToken!, {
          start: target,
          idempotencyKey: randomUUID(),
        }),
        rescheduleManagedBooking(ctx, b.manageToken!, {
          start: target,
          idempotencyKey: randomUUID(),
        }),
      ])
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await state(s.eventId)).map((s) => s.active_seats).sort()).toEqual([1, 2])
    }
  }, 60000)
  it('hosts see every seat and transfer only their moved seat token', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    const b = await s.book('b@example.test')
    const user = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', s.userId)
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'slug', 'name'])
      .where('id', '=', s.organizationId)
      .executeTakeFirstOrThrow()
    const host: ServiceContext = {
      ...ctx,
      principal: {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: randomUUID(),
        user,
        organization: { ...organization, personal: true },
      },
    }
    expect((await listHostBookings(host)).data.map((b) => b.id).sort()).toEqual(
      [a.booking.id, b.booking.id].sort(),
    )
    expect((await getHostBooking(host, b.booking.id)).attendees[0]?.email).toBe('b@example.test')
    const key = randomUUID()
    const moved = await rescheduleHostBooking(host, a.booking.id, {
      start: START.add({ hours: 1 }),
      idempotencyKey: key,
    })
    expect(moved.manageToken).toBeNull()
    expect((await getManagedBooking(ctx, a.manageToken!)).id).toBe(moved.booking.id)
    expect(
      (
        await rescheduleHostBooking(host, a.booking.id, {
          start: START.add({ hours: 1 }),
          idempotencyKey: key,
        })
      ).booking.id,
    ).toBe(moved.booking.id)
    expect((await getManagedBooking(ctx, b.manageToken!)).status).toBe('confirmed')
    await cancelHostBooking(host, b.booking.id)
    expect((await state(s.eventId))[0]!.state).toBe('retired')
  })
  it('rejects incompatible shared locations and preserves full/disabled creation replay', async () => {
    const s = await setup(3)
    const key = randomUUID()
    const a = await s.book('a@example.test', START, key)
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'link', url: 'https://example.test/changed' }) })
      .where('id', '=', s.eventId)
      .execute()
    await expect(s.book('b@example.test')).rejects.toMatchObject({ code: 'slot_unavailable' })
    expect((await s.book('a@example.test', START, key)).booking.id).toBe(a.booking.id)
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventId)
      .execute()
    expect((await s.book('a@example.test', START, key)).booking.id).toBe(a.booking.id)
  })
  it('rolls back first slot and capacity when transactional notifications fail', async () => {
    const s = await setup()
    await expect(
      s.book('a@example.test', START, randomUUID(), {
        ...ctx,
        notify: async () => {
          throw new Error('outbox failed')
        },
      }),
    ).rejects.toThrow('outbox failed')
    expect(await state(s.eventId)).toEqual([])
    expect(
      await db.selectFrom('bookings').select('id').where('event_type_id', '=', s.eventId).execute(),
    ).toEqual([])
  })
  it('keeps survivors blocking overlap but permits a final seat overlapping move', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ slot_step_minutes: 15 })
      .where('id', '=', s.eventId)
      .execute()
    const a = await s.book('a@example.test')
    const b = await s.book('b@example.test')
    const target = START.add({ minutes: 15 })
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, {
        start: target,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    await cancelManagedBooking(ctx, b.manageToken!)
    expect(
      (
        await rescheduleManagedBooking(ctx, a.manageToken!, {
          start: target,
          idempotencyKey: randomUUID(),
        })
      ).booking.start,
    ).toBe(target.toString({ smallestUnit: 'millisecond' }))
  })
  it('probes no-op receipts before following a moved email capability', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    const token = randomBytes(32).toString('base64url')
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', a.booking.id)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: a.booking.id,
        kind: 'confirmed',
        recipient: `attendee:${attendee.id}`,
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .execute()
    const noopKey = randomUUID()
    await rescheduleManagedBooking(ctx, token, { start: START, idempotencyKey: noopKey })
    const target = START.add({ hours: 1 })
    const moved = await rescheduleManagedBooking(ctx, token, {
      start: target,
      idempotencyKey: randomUUID(),
    })
    expect(
      (await rescheduleManagedBooking(ctx, token, { start: START, idempotencyKey: noopKey }))
        .booking.id,
    ).toBe(a.booking.id)
    expect((await getManagedBooking(ctx, token)).id).toBe(moved.booking.id)
  })
  it('preserves removed durations only for authorized moves and requires a move retry key', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60] })
      .where('id', '=', s.eventId)
      .execute()
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, { start: START.add({ hours: 1 }) }),
    ).rejects.toMatchObject({ code: 'invalid_idempotency_key' })
    const moved = await rescheduleManagedBooking(ctx, a.manageToken!, {
      start: START.add({ hours: 1 }),
      idempotencyKey: randomUUID(),
    })
    expect(
      Temporal.Instant.from(moved.booking.end)
        .since(Temporal.Instant.from(moved.booking.start))
        .total('minutes'),
    ).toBe(30)
    await expect(
      createPublicBooking(ctx, {
        handle: s.handle,
        slug: 'group',
        start: START.add({ hours: 1 }),
        durationMinutes: 30,
        invitee: { name: 'B', email: 'b@example.test', timeZone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
  })
  it('binds expected generation and rolls back one-time claims with failed seat outboxes', async () => {
    const s = await setup()
    const token = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: s.organizationId,
        event_type_id: s.eventId,
        creator_user_id: s.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
      })
      .execute()
    const input = {
      token,
      start: START,
      invitee: { name: 'A', email: 'a@example.test', timeZone: 'UTC' },
      idempotencyKey: randomUUID(),
    }
    await expect(
      createOneTimeBooking(
        {
          ...ctx,
          notify: async () => {
            throw new Error('failed outbox')
          },
        },
        input,
      ),
    ).rejects.toThrow('failed outbox')
    expect(
      (
        await db
          .selectFrom('one_time_booking_links')
          .select('state')
          .where('event_type_id', '=', s.eventId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('active')
    expect(await state(s.eventId)).toEqual([])
    const a = await createOneTimeBooking(ctx, input)
    await s.book('b@example.test')
    expect((await createOneTimeBooking(ctx, input)).booking.id).toBe(a.booking.id)
    await expect(
      createPublicBooking(ctx, {
        handle: s.handle,
        slug: 'group',
        start: START,
        expectedGroupSlotId: randomUUID(),
        invitee: { name: 'C', email: 'c@example.test', timeZone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'group_slot_changed' })
  })
  it('uses current host policy for a new destination and retains the moving seat policy', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    const original = await db
      .selectFrom('bookings')
      .select('notification_snapshot')
      .where('id', '=', a.booking.id)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
      .where('id', '=', s.eventId)
      .execute()
    const moved = await rescheduleManagedBooking(ctx, a.manageToken!, {
      start: START.add({ hours: 1 }),
      idempotencyKey: randomUUID(),
    })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('notification_snapshot')
          .where('id', '=', moved.booking.id)
          .executeTakeFirstOrThrow()
      ).notification_snapshot,
    ).toEqual(original.notification_snapshot)
    expect(
      (await state(s.eventId)).find((s) => s.state === 'open')?.host_notification_settings,
    ).toMatchObject({ notifications: { reminders: [], followUps: [] } })
  })
  it('fences expected move generations and includes them in capability replay identity', async () => {
    const s = await setup()
    const a = await s.book('a@example.test')
    const target = START.add({ hours: 1 })
    await s.book('b@example.test', target)
    const destination = (await state(s.eventId)).find(
      (s) => s.start_at.getTime() === target.epochMilliseconds,
    )!
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, {
        start: target,
        idempotencyKey: randomUUID(),
        expectedGroupSlotId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'group_slot_changed' })
    expect((await getManagedBooking(ctx, a.manageToken!)).status).toBe('confirmed')
    const key = randomUUID(),
      input = { start: target, idempotencyKey: key, expectedGroupSlotId: destination.id }
    const moved = await rescheduleManagedBooking(ctx, a.manageToken!, input)
    expect((await rescheduleManagedBooking(ctx, a.manageToken!, input)).booking.id).toBe(
      moved.booking.id,
    )
    await expect(
      rescheduleManagedBooking(ctx, a.manageToken!, {
        ...input,
        expectedGroupSlotId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
  })
})
