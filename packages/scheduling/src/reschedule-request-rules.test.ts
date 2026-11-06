import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking, requestReschedule, rescheduleManagedBooking } from './bookings.ts'
import { activateRoundRobin, createEventType, updateEventType } from './event-types.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const instant = Temporal.Instant.from
const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error('Missing fixture')
  return value
}

describe.skipIf(!serverUrl)('pending reschedule picks use ordinary slot rules', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(mode: 'individual' | 'collective' | 'round_robin' = 'individual') {
    const first = await createTestUser(db, 'First host')
    const second = await createTestUser(db, 'Second host')
    const users = mode === 'individual' ? [first] : [first, second]
    const team = await createTestTeam(
      db,
      users.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    const ctx = testContext(db, team.as(first), now)
    const f = createFixtures(db)
    for (const user of users) await f.schedule(user.id, { timeZone: 'UTC' })
    let event = await createEventType(ctx, {
      slug: 'request-rules',
      title: 'Meeting',
      durationMinutes: 30,
      schedulingType: mode,
      hosts: users.map((user) => ({ userId: user.id })),
    })
    if (mode === 'round_robin') event = await activateRoundRobin(ctx, event.id)
    const pub = { db, now }
    const original = await createPublicTeamBooking(pub, {
      handle: ctx.principal.organization.slug,
      slug: event.slug,
      start: instant('2026-11-02T09:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'America/New_York' },
    })
    const assigned = await db
      .selectFrom('booking_hosts')
      .select('user_id')
      .where('booking_id', '=', original.booking.id)
      .executeTakeFirstOrThrow()
    const requesting = required(users.find((user) => user.id === assigned.user_id))
    const request = await requestReschedule(
      testContext(db, team.as(requesting), now),
      original.booking.id,
      { idempotencyKey: randomUUID() },
    )
    const requestId = required(request.pendingReschedule).id
    const pick = (start = '2026-11-02T10:00Z') =>
      rescheduleManagedBooking(pub, required(original.manageToken), {
        start: instant(start),
        rescheduleRequestId: requestId,
      })
    return { users, team, ctx, f, event, original, requestId, pick }
  }
  async function preserved(s: Awaited<ReturnType<typeof setup>>) {
    expect(
      await db
        .selectFrom('bookings')
        .select(['status', 'rescheduled_from_id'])
        .where('id', '=', s.original.booking.id)
        .executeTakeFirst(),
    ).toEqual({ status: 'confirmed', rescheduled_from_id: null })
    expect(
      await db
        .selectFrom('booking_reschedule_requests')
        .select('state')
        .where('id', '=', s.requestId)
        .executeTakeFirst(),
    ).toEqual({ state: 'pending' })
  }

  it.each(['notice', 'window', 'daily limit', 'weekly limit', 'monthly limit', 'buffers'] as const)(
    'refuses %s violations without consuming the request, then permits a valid pick',
    async (rule) => {
      const s = await setup()
      const host = required(s.users[0])
      if (rule === 'notice')
        await updateEventType(s.ctx, s.event.id, { minimumNoticeMinutes: 3000 })
      if (rule === 'window') await updateEventType(s.ctx, s.event.id, { bookingWindowDays: 1 })
      if (rule === 'daily limit' || rule === 'weekly limit' || rule === 'monthly limit') {
        await s.f.booking(s.team.id, [host.id], '2026-11-02T11:00Z', '2026-11-02T11:30Z', {
          eventTypeId: s.event.id,
        })
        await updateEventType(s.ctx, s.event.id, {
          [rule === 'daily limit'
            ? 'maxBookingsPerDay'
            : rule === 'weekly limit'
              ? 'maxBookingsPerWeek'
              : 'maxBookingsPerMonth']: 1,
        })
      }
      if (rule === 'buffers') {
        await s.f.booking(s.team.id, [host.id], '2026-11-02T10:30Z', '2026-11-02T11:00Z', {
          eventTypeId: s.event.id,
        })
        await updateEventType(s.ctx, s.event.id, { bufferAfterMinutes: 15 })
      }
      await expect(
        s.pick(rule === 'window' ? '2026-11-04T10:00Z' : undefined),
      ).rejects.toMatchObject({ code: 'slot_unavailable' })
      await preserved(s)
      await updateEventType(s.ctx, s.event.id, {
        minimumNoticeMinutes: 0,
        bookingWindowDays: null,
        maxBookingsPerDay: null,
        maxBookingsPerWeek: null,
        maxBookingsPerMonth: null,
        bufferAfterMinutes: 0,
      })
      const moved = await s.pick()
      expect(moved.booking.start).toBe('2026-11-02T10:00:00.000Z')
      expect(moved.booking.rescheduledFromId).toBe(s.original.booking.id)
    },
  )

  it.each(['collective', 'round_robin'] as const)(
    'rechecks %s host availability and retains the pending request when no eligible host exists',
    async (mode) => {
      const s = await setup(mode)
      const blocked = mode === 'collective' ? [required(s.users[1])] : s.users
      const blockers: string[] = []
      for (const user of blocked)
        blockers.push(
          await s.f.booking(s.team.id, [user.id], '2026-11-02T10:00Z', '2026-11-02T10:30Z'),
        )
      await expect(s.pick()).rejects.toMatchObject({ code: 'slot_unavailable' })
      await preserved(s)
      await db
        .updateTable('booking_hosts')
        .set({ active: false })
        .where('booking_id', 'in', blockers)
        .execute()
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: now().toString() })
        .where('id', 'in', blockers)
        .execute()
      const moved = await s.pick()
      const hosts = await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', moved.booking.id)
        .where('active', '=', true)
        .execute()
      expect(hosts).toHaveLength(mode === 'collective' ? 2 : 1)
      expect(hosts.every((host) => s.users.some((user) => user.id === host.user_id))).toBe(true)
    },
  )
})
