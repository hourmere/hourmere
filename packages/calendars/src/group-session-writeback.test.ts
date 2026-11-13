import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  cancelManagedBooking,
  createPublicBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calendarBookingNotifier } from './booking-events.ts'
import { conferenceBookingNotifier } from './conferences.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { writeGroupSlotConference } from './group-conferences.ts'
import { groupSlotCalendarUid, writeGroupSlotCalendar } from './group-slot-events.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

// External calendar write-back of a group session, driven by the real booking services:
// every request the provider fakes receive must be free of any invitee's identity, so no
// invitee ever appears in the host's calendar, in a shared event or in a meeting.

const NOW = Temporal.Instant.from('2027-11-01T08:00:00Z')
const START = Temporal.Instant.from('2027-11-03T10:00:00Z')
const MOVED = Temporal.Instant.from('2027-11-04T10:00:00Z')
const INVITEES = [
  { name: 'Ivy Alphaname', email: 'ivy.alphaaddr@people.example.test', timeZone: 'UTC' },
  { name: 'Oscar Bravoname', email: 'oscar.bravoaddr@people.example.test', timeZone: 'UTC' },
  { name: 'Pia Charliename', email: 'pia.charlieaddr@people.example.test', timeZone: 'UTC' },
]
const ZOOM_SCOPES = [
  'user:read:user',
  'meeting:write:meeting',
  'meeting:read:meeting',
  'meeting:update:meeting',
  'meeting:delete:meeting',
]

type Variant = 'link' | 'google_meet' | 'zoom'

describe.skipIf(!process.env.DATABASE_URL)('group session calendar write-back privacy', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function session(variant: Variant) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const account = `test-${host.userId}`
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: host.userId,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(host.userId, account),
          JSON.stringify({
            accessToken: 'fake',
            refreshToken: 'fake',
            expiresAt: NOW.epochMilliseconds + 7 * 86_400_000,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'private-calendar',
        name: 'Calendar',
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calendar.id })
      .where('user_id', '=', host.userId)
      .execute()
    const zoom =
      variant === 'zoom'
        ? await db
            .insertInto('conference_connections')
            .values({
              user_id: host.userId,
              provider: 'zoom',
              external_user_id: `zoom-${host.userId}`,
              mode: 'meetings',
              status: 'active',
              credentials: Buffer.from('synthetic'),
              scopes: ZOOM_SCOPES,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        : undefined
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'class',
      title: 'Evening class',
      location:
        variant === 'link'
          ? { kind: 'link', url: 'https://class.example.test/room' }
          : { kind: variant, autoCreate: true },
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3, zoom_connection_id: zoom?.id ?? null })
      .where('id', '=', eventId)
      .execute()
    const provider = fakeGoogle(() => NOW.epochMilliseconds)
    provider.controls.conferencePollsBeforeReady = 0
    const zoomWork: unknown[] = []
    let meeting = 0
    const deps: CalendarDeps = {
      db,
      now: () => NOW.epochMilliseconds,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      zoomConferenceWork: async (work) => {
        zoomWork.push(work)
        if (work.booking.status === 'cancelled') return { cancelled: true }
        meeting++
        const id = `9876543210${meeting}`
        return { meetingId: id, url: `https://zoom.us/j/${id}` }
      },
    }
    const calendarSlots = new Set<string>()
    const conferenceSlots = new Set<string>()
    const notifyCalendar = calendarBookingNotifier({
      async enqueue(_name, payload) {
        if ('groupSlotId' in payload) calendarSlots.add(payload.groupSlotId)
        return null
      },
    })
    const notifyConference = conferenceBookingNotifier({
      async enqueue(_name, payload) {
        if ('groupSlotId' in payload) conferenceSlots.add(payload.groupSlotId)
        return null
      },
    })
    const ctx: PublicContext = {
      db,
      now: () => NOW,
      automaticMeet: true,
      automaticZoom: true,
      notify: async (trx, event) => {
        if (event.type === 'reschedule_requested' || event.type === 'reschedule_request_expired')
          return
        await notifyCalendar(trx, event)
        await notifyConference(trx, event)
      },
    }
    /** Runs the queued provider work, conference first, the way the workers would. */
    async function work() {
      for (const slot of [...conferenceSlots].sort()) await writeGroupSlotConference(deps, slot)
      conferenceSlots.clear()
      for (const slot of [...calendarSlots].sort()) await writeGroupSlotCalendar(deps, slot)
      calendarSlots.clear()
    }
    const book = (index: number, start = START) =>
      createPublicBooking(ctx, {
        handle: host.handle,
        slug: 'class',
        start,
        invitee: INVITEES[index] as (typeof INVITEES)[number],
      })
    return { host, ctx, provider, zoomWork, work, book }
  }

  it.each<Variant>(['link', 'google_meet', 'zoom'])(
    'never shows one invitee to another or to the provider (%s)',
    async (variant) => {
      const s = await session(variant)
      const seats = []
      for (const index of [0, 1, 2]) {
        seats.push(await s.book(index))
        await s.work()
      }
      const source = await db
        .selectFrom('bookings')
        .select('group_slot_id')
        .where('id', '=', seats[0]?.booking.id as string)
        .executeTakeFirstOrThrow()
      const events = () => [...s.provider.controls.storedEvents.values()]
      const ofSlot = (slot: string) =>
        events().filter((e) => e.iCalUID === groupSlotCalendarUid(slot))
      expect(ofSlot(source.group_slot_id as string)).toHaveLength(1)
      expect(ofSlot(source.group_slot_id as string)[0]?.description).toBe('3')

      // One seat moves to another time, then the session empties seat by seat.
      const moved = await rescheduleManagedBooking(s.ctx, seats[0]?.manageToken as string, {
        start: MOVED,
        idempotencyKey: `move-${variant}`,
      })
      await s.work()
      await cancelManagedBooking(s.ctx, seats[1]?.manageToken as string)
      await s.work()
      expect(ofSlot(source.group_slot_id as string)[0]?.description).toBe('1')
      await cancelManagedBooking(s.ctx, seats[2]?.manageToken as string)
      await s.work()
      const destination = await db
        .selectFrom('bookings')
        .select('group_slot_id')
        .where('id', '=', moved.booking.id)
        .executeTakeFirstOrThrow()
      expect(destination.group_slot_id).not.toBe(source.group_slot_id)
      expect(ofSlot(destination.group_slot_id as string)).toHaveLength(1)
      expect(ofSlot(destination.group_slot_id as string)[0]?.description).toBe('1')
      // The last exit cancels the source occurrence's event, including its Meet.
      expect(ofSlot(source.group_slot_id as string)[0]?.status).toBe('cancelled')
      expect(ofSlot(destination.group_slot_id as string)[0]?.status).toBe('confirmed')

      // Every byte any provider received, and every event it stores.
      const wire = JSON.stringify([
        s.provider.calls.map((c) => ({ url: c.url.href, body: c.init.body ?? null })),
        events(),
        s.zoomWork,
      ]).toLowerCase()
      const ids = [...seats.map((seat) => seat.booking.id), moved.booking.id]
      const tokens = seats.map((seat) => seat.manageToken as string)
      for (const invitee of INVITEES)
        for (const secret of [
          invitee.email,
          invitee.email.split('@')[0] as string,
          ...invitee.name.toLowerCase().split(' '),
        ])
          expect(wire, `providers must not see ${secret}`).not.toContain(secret)
      for (const secret of [...ids, ...tokens.map((t) => t.toLowerCase())])
        expect(wire).not.toContain(secret)
      for (const event of events()) {
        expect(event.attendees).toBeUndefined()
        expect(event.visibility).toBe('private')
      }
      if (variant === 'zoom') expect(s.zoomWork.length).toBeGreaterThan(0)
      if (variant === 'google_meet')
        expect(events().some((e) => (e as { conferenceData?: unknown }).conferenceData)).toBe(true)
    },
  )
})
