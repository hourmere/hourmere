import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import { updateEventType } from './event-types.ts'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import { createFinalizeFixture } from './meeting-poll-finalize-fixture.ts'
import { createOneTimeBookingLink, listOneTimeBookingLinks } from './one-time-links.ts'

const serverUrl = process.env.DATABASE_URL
type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>

describe.skipIf(!serverUrl)('meeting poll finalize refuses unsupported booking modes', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_mode_guard' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function pollAndBookings({ poll, organizationId }: Fixture) {
    return Promise.all([
      db
        .selectFrom('meeting_polls')
        .select(['status', 'host_revision', 'results_revision', 'booking_id', 'chosen_slot_id'])
        .where('id', '=', poll.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('bookings')
        .select(['id', 'status', 'group_slot_id'])
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
    ])
  }

  it('refuses to open a new group occurrence or take a seat in an existing one', async () => {
    const fixture = await createFinalizeFixture(db, {
      event: { slug: 'group-meeting', allowGuests: false },
    })
    const { ctx, eventTypeId, start, chosen, alternative } = fixture
    const booker = await fixture.addVoter()

    // Only a poll created before the mode change can reach the finalize guard.
    await updateEventType(ctx, eventTypeId, { bookingMode: 'group', groupCapacity: 2 })
    const seat = await createPublicTeamBooking(ctx, {
      handle: ctx.principal.organization.slug,
      slug: 'group-meeting',
      start,
      invitee: { name: 'Existing seat holder', email: 'seat@example.test', timeZone: 'UTC' },
    })
    const occurrences = () =>
      db
        .selectFrom('group_slots')
        .selectAll()
        .where('original_event_type_id', '=', eventTypeId)
        .orderBy('id')
        .execute()
    const originalOccurrences = await occurrences()
    expect(originalOccurrences).toEqual([expect.objectContaining({ capacity: 2, active_seats: 1 })])
    const before = await pollAndBookings(fixture)
    expect(before[1]).toEqual([
      { id: seat.booking.id, status: 'confirmed', group_slot_id: originalOccurrences[0]?.id },
    ])

    for (const { id: slotId } of [chosen, alternative]) {
      await expect(
        finalizeMeetingPoll(ctx, await fixture.input([booker], { slotId })),
      ).rejects.toMatchObject({ code: 'poll_event_unsupported' })
      expect(await occurrences()).toEqual(originalOccurrences)
      expect(await pollAndBookings(fixture)).toEqual(before)
    }
  })

  it('rejects a one-time booking token and leaves the attached link active', async () => {
    const fixture = await createFinalizeFixture(db)
    const { ctx, eventTypeId } = fixture
    const { id, token } = await createOneTimeBookingLink(ctx, { eventTypeId })
    const readLinks = async () => (await listOneTimeBookingLinks(ctx, { eventTypeId })).data
    const links = await readLinks()
    expect(links).toEqual([
      expect.objectContaining({
        id,
        state: 'active',
        bookingId: null,
        usedAt: null,
        revokedAt: null,
      }),
    ])

    const request = await fixture.input([await fixture.addVoter()])
    const before = await pollAndBookings(fixture)
    const tokenBearingRequest = { ...request, token }
    await expect(finalizeMeetingPoll(ctx, tokenBearingRequest)).rejects.toMatchObject({
      code: 'invalid_poll',
    })
    expect(await readLinks()).toEqual(links)
    expect(await pollAndBookings(fixture)).toEqual(before)

    // The host can still book the event by poll ID with the same untouched receipt key.
    await expect(finalizeMeetingPoll(ctx, request)).resolves.toMatchObject({
      poll: { status: 'scheduled' },
      replayed: false,
    })
    expect(await readLinks()).toEqual(links)
  })
})
