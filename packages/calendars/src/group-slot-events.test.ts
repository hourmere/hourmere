import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertSeat,
  insertSlot,
  occupiedSlot,
  transaction,
} from '../../db/src/group-seats-fixtures.ts'
import { calendarBookingNotifier } from './booking-events.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { groupSlotCalendarUid, writeGroupSlotCalendar } from './group-slot-events.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2031-12-30T10:00:00Z')
describe.skipIf(!serverUrl)('slot-owned private calendar copy', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it('coalesces seat changes, preserves survivors and cancels only after the final exit', async () => {
    const f = await groupFixture(owned.pool)
    const account = `test-${f.host}`
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: f.host,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(f.host, account),
          JSON.stringify({
            accessToken: 'fake',
            refreshToken: 'fake',
            expiresAt: now.epochMilliseconds + 86_400_000,
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
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { slot, bookings } = await occupiedSlot(f, 2, { destination_calendar_id: calendar.id })
    const provider = fakeGoogle(() => now.epochMilliseconds)
    const deps: CalendarDeps = {
      db,
      now: () => now.epochMilliseconds,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    const queue: unknown[] = []
    await db.transaction().execute(async (trx) => {
      for (const bookingId of bookings)
        await calendarBookingNotifier({
          async enqueue(_name, payload, options) {
            queue.push({ payload, key: options?.singletonKey })
            return null
          },
        })(trx, { bookingId, type: 'created' })
    })
    expect(queue).toEqual(
      bookings.map(() => ({ payload: { groupSlotId: slot }, key: `group:${slot}` })),
    )
    await writeGroupSlotCalendar(deps, slot)
    await writeGroupSlotCalendar(deps, slot)
    expect(provider.controls.storedEvents.size).toBe(1)
    let event = [...provider.controls.storedEvents.values()][0]
    expect(event?.iCalUID).toBe(groupSlotCalendarUid(slot))
    expect(event?.description).toBe('2')
    expect(event?.attendees).toBeUndefined()
    expect(event?.visibility).toBe('private')
    for (const booking of bookings) expect(JSON.stringify(event)).not.toContain(booking)
    const id = event?.id
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[0]],
    )
    await writeGroupSlotCalendar(deps, slot)
    event = [...provider.controls.storedEvents.values()][0]
    expect(event?.id).toBe(id)
    expect(event?.status).toBe('confirmed')
    expect(event?.description).toBe('1')
    expect(
      (
        await owned.pool.query(
          'SELECT count(*)::int AS n FROM calendar_busy WHERE calendar_id=$1',
          [calendar.id],
        )
      ).rows,
    ).toEqual([{ n: 1 }])
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [bookings[1]],
    )
    await writeGroupSlotCalendar(deps, slot)
    event = [...provider.controls.storedEvents.values()][0]
    expect(event?.id).toBe(id)
    expect(event?.status).toBe('cancelled')
    expect(
      (
        await owned.pool.query(
          'SELECT count(*)::int AS n FROM calendar_busy WHERE calendar_id=$1',
          [calendar.id],
        )
      ).rows,
    ).toEqual([{ n: 0 }])
    expect(
      (
        await owned.pool.query(
          'SELECT group_slot_id,calendar_id,external_event_id FROM group_slot_calendar_events',
        )
      ).rows,
    ).toEqual([{ group_slot_id: slot, calendar_id: calendar.id, external_event_id: id }])
  })
  it('dispatches both slot owners when a seat moves without transferring source resources', async () => {
    const f = await groupFixture(owned.pool)
    const original = await occupiedSlot(f, 2)
    const moved = await transaction(owned.pool, async (client) => {
      await client.query("UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1", [
        original.bookings[0],
      ])
      const destination = { ...f, start: '2032-01-03T10:00:00Z', end: '2032-01-03T10:30:00Z' }
      const slot = await insertSlot(client, destination)
      await client.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
        slot,
        f.host,
      ])
      const booking = await insertSeat(client, destination, slot, 'moved@example.test', {
        rescheduled_from_id: original.bookings[0],
      })
      return { slot, booking }
    })
    const queued: unknown[] = []
    await db.transaction().execute((trx) =>
      calendarBookingNotifier({
        async enqueue(_name, payload) {
          queued.push(payload)
          return null
        },
      })(trx, { type: 'rescheduled', bookingId: moved.booking }),
    )
    expect(queued).toEqual(
      [original.slot, moved.slot].sort().map((groupSlotId) => ({ groupSlotId })),
    )
  })
  it('updates only the known ready Meet copy count without changing conference metadata or readiness', async () => {
    const f = await groupFixture(owned.pool)
    const account = `meet-${f.host}`
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: f.host,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(f.host, account),
          JSON.stringify({
            accessToken: 'fake',
            refreshToken: 'fake',
            expiresAt: now.epochMilliseconds + 86_400_000,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'meet-calendar',
        name: 'Calendar',
        access_role: 'owner',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { slot } = await occupiedSlot(f, 2, { destination_calendar_id: calendar.id })
    await db
      .insertInto('group_slot_conferences')
      .values({
        group_slot_id: slot,
        organization_id: f.organization,
        organizer_user_id: f.host,
        provider: 'google_meet',
        invitation_organizer_name: 'Host',
        invitation_organizer_email: 'host@example.test',
        calendar_id: calendar.id,
        connection_id: connection.id,
        state: 'ready',
        applied_revision: 1,
        external_event_id: 'shared-event',
        join_url: 'https://meet.google.com/shared',
      })
      .execute()
    const provider = fakeGoogle(() => now.epochMilliseconds)
    const data = {
      conferenceSolution: { key: { type: 'hangoutsMeet' } },
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/shared' }],
    }
    provider.controls.storedEvents.set('shared-event', {
      id: 'shared-event',
      iCalUID: groupSlotCalendarUid(slot),
      etag: '"v1"',
      status: 'confirmed',
      conferenceData: data,
    })
    const deps: CalendarDeps = {
      db,
      now: () => now.epochMilliseconds,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    await writeGroupSlotCalendar(deps, slot)
    expect(provider.controls.storedEvents.get('shared-event')?.description).toBeUndefined()
    await db
      .insertInto('group_slot_calendar_events')
      .values({
        group_slot_id: slot,
        calendar_id: calendar.id,
        external_event_id: 'shared-event',
        count_revision: 1,
      })
      .execute()
    await writeGroupSlotCalendar(deps, slot)
    expect(provider.controls.storedEvents.size).toBe(1)
    expect(provider.controls.storedEvents.get('shared-event')?.description).toBe('2')
    expect(provider.controls.storedEvents.get('shared-event')?.conferenceData).toEqual(data)
    expect(
      await db
        .selectFrom('group_slot_conferences')
        .select(['state', 'revision', 'applied_revision', 'join_url'])
        .where('group_slot_id', '=', slot)
        .executeTakeFirst(),
    ).toEqual({
      state: 'ready',
      revision: 1,
      applied_revision: 1,
      join_url: 'https://meet.google.com/shared',
    })
    provider.controls.eventPatchStatus = 503
    await expect(writeGroupSlotCalendar(deps, slot)).rejects.toThrow()
    expect(
      (
        await db
          .selectFrom('group_slot_conferences')
          .select('state')
          .where('group_slot_id', '=', slot)
          .executeTakeFirst()
      )?.state,
    ).toBe('ready')
  })
})
