import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPublicEventType, getPublicHost, listPublicSlots } from './availability.ts'
import { createPublicBooking } from './bookings.ts'
import {
  createEventType,
  deleteEventType,
  getEventType,
  listEventTypeCatalog,
  listEventTypes,
  updateEventType,
} from './event-types.ts'
import { putProfile } from './profile.ts'
import { createSchedule } from './schedules.ts'
import { createTestTeam, createTestUser, domainError, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
const range = {
  start: Temporal.Instant.from('2026-11-02T00:00Z'),
  end: Temporal.Instant.from('2026-11-03T00:00Z'),
}

describe.skipIf(!serverUrl)('unlisted event types', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const publicContext = () => ({ db, now })

  async function setup(isHidden = false) {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, now)
    const handle = `host-${randomUUID().slice(0, 8)}`
    await putProfile(ctx, { handle, timeZone: 'UTC', locale: 'en' })
    await createSchedule(ctx, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '12:00' }),
    })
    const event = await createEventType(ctx, {
      title: 'Consultation',
      slug: 'consultation',
      durationMinutes: 30,
      isHidden,
    })
    return { ctx, user, handle, event }
  }

  it('keeps existing/default configurations listed', async () => {
    const { ctx, handle } = await setup()
    const event = await createEventType(ctx, {
      title: 'Default',
      slug: 'default',
      durationMinutes: 15,
    })
    expect(event.isHidden).toBe(false)
    expect(
      (await getPublicHost(publicContext(), { handle })).eventTypes.map((e) => e.slug),
    ).toEqual(expect.arrayContaining(['consultation', 'default']))
    const { rows } = await owned.pool.query<{ is_hidden: boolean }>(
      'SELECT is_hidden FROM event_types WHERE id = $1',
      [event.id],
    )
    expect(rows[0]?.is_hidden).toBe(false)
  })

  it('omits hidden details from the public host page while keeping direct bookings and idempotency', async () => {
    const { ctx, user, handle, event } = await setup(true)
    await createEventType(ctx, { title: 'Listed', slug: 'listed', durationMinutes: 15 })
    const page = await getPublicHost(publicContext(), { handle })
    expect(page.eventTypes.map((e) => e.slug)).toEqual(['listed'])
    expect(JSON.stringify(page)).not.toContain('Consultation')
    const target = { handle, slug: event.slug }
    expect(await getPublicEventType(publicContext(), target)).toMatchObject({
      title: 'Consultation',
    })
    const slots = await listPublicSlots(publicContext(), { ...target, ...range })
    expect(slots.length).toBeGreaterThan(0)
    const start = Temporal.Instant.from(slots[0]?.start as string)
    const input = {
      ...target,
      start,
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
      idempotencyKey: randomUUID(),
    }
    const booked = await createPublicBooking(publicContext(), input)
    expect(booked.replayed).toBe(false)
    const replay = await createPublicBooking(publicContext(), input)
    expect(replay.replayed).toBe(true)
    expect(replay.booking.id).toBe(booked.booking.id)
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', booked.booking.id)
        .execute(),
    ).toEqual([{ user_id: user.id }])
    expect(
      (await listPublicSlots(publicContext(), { ...target, ...range })).some(
        (slot) => slot.start === slots[0]?.start,
      ),
    ).toBe(false)
    expect((await listEventTypes(ctx)).find((e) => e.id === event.id)?.isHidden).toBe(true)
    expect((await listEventTypeCatalog(ctx)).data.find((e) => e.id === event.id)?.isHidden).toBe(
      true,
    )
  })

  it('preserves hidden state on unrelated edits, and lets the owner restore listing', async () => {
    const { ctx, handle, event } = await setup(true)
    expect((await updateEventType(ctx, event.id, { title: 'Renamed' })).isHidden).toBe(true)
    expect((await getPublicHost(publicContext(), { handle })).eventTypes).toEqual([])
    expect((await updateEventType(ctx, event.id, { isHidden: false })).isHidden).toBe(false)
    expect((await getPublicHost(publicContext(), { handle })).eventTypes).toMatchObject([
      { slug: event.slug, title: 'Renamed' },
    ])
  })

  it('does not make inactive, deleted or departed-owner event types bookable', async () => {
    const { ctx, user, handle, event } = await setup(true)
    const target = { handle, slug: event.slug }
    const refused = async () => {
      expect((await domainError(() => getPublicEventType(publicContext(), target))).code).toBe(
        'event_type_not_found',
      )
      expect(
        (await domainError(() => listPublicSlots(publicContext(), { ...target, ...range }))).code,
      ).toBe('event_type_not_found')
      expect(
        (
          await domainError(() =>
            createPublicBooking(publicContext(), {
              ...target,
              start: range.start,
              invitee: { name: 'Invitee', email: 'i@example.com', timeZone: 'UTC' },
            }),
          )
        ).code,
      ).toBe('event_type_not_found')
    }
    await updateEventType(ctx, event.id, { isActive: false })
    await refused()
    await updateEventType(ctx, event.id, { isActive: true })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', event.organizationId)
      .where('userId', '=', user.id)
      .execute()
    await refused()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: event.organizationId,
        userId: user.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    await deleteEventType(ctx, event.id)
    await refused()
  })

  it('retains existing team permissions and caller organization isolation', async () => {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const admin = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const ctx = (user: typeof owner) => testContext(db, team.as(user), now)
    const event = await createEventType(ctx(owner), {
      title: 'Team call',
      slug: 'team-call',
      durationMinutes: 30,
      isHidden: true,
    })
    expect((await getEventType(ctx(member), event.id)).isHidden).toBe(true)
    expect((await listEventTypeCatalog(ctx(member))).data[0]?.isHidden).toBe(true)
    expect(
      (await domainError(() => updateEventType(ctx(member), event.id, { isHidden: false }))).code,
    ).toBe('insufficient_role')
    expect(
      (await domainError(() => getEventType(testContext(db, outsider.principal), event.id))).code,
    ).toBe('event_type_not_found')
    expect(
      (
        await domainError(() =>
          updateEventType(testContext(db, outsider.principal), event.id, { isHidden: false }),
        )
      ).code,
    ).toBe('event_type_not_found')
    expect((await updateEventType(ctx(admin), event.id, { isHidden: false })).isHidden).toBe(false)
  })

  it.each([null, 'true', 0, {}, []].map((value) => [value]))(
    'refuses nonboolean isHidden in the shared service: %j',
    async (value) => {
      const { ctx, event } = await setup(true)
      const isHidden = value as unknown as boolean
      expect((await domainError(() => updateEventType(ctx, event.id, { isHidden }))).code).toBe(
        'invalid_event_type',
      )
      expect(
        (
          await domainError(() =>
            createEventType(ctx, { title: 'Bad', slug: 'bad', durationMinutes: 30, isHidden }),
          )
        ).code,
      ).toBe('invalid_event_type')
      expect((await getEventType(ctx, event.id)).isHidden).toBe(true)
    },
  )
})
