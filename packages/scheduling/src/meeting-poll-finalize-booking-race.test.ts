import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import {
  collideFinalizeWrites,
  createFinalizeFixture,
  waitAtFinalizeGate,
} from './meeting-poll-finalize-fixture.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('meeting poll and public booking contention', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'finalize_booking' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  it.each(['public booking', 'poll finalize'] as const)(
    'rechecks host availability when %s commits first',
    async (first) => {
      const fixture = await createFinalizeFixture(db)
      const voter = await fixture.addVoter()
      const request = await fixture.input([voter])
      const revisions = await fixture.revisions()
      const publicSlug = 'ordinary-booking'
      const publicEventId = await fixture.fixtures.eventType(fixture.organizationId, null, {
        slug: publicSlug,
        hosts: [{ userId: fixture.owner.id }],
      })
      const bookingInput = {
        handle: fixture.ctx.principal.organization.slug,
        slug: publicSlug,
        start: fixture.start,
        invitee: { name: 'Ordinary invitee', email: 'ordinary@example.com', timeZone: 'UTC' },
      }
      const finalize = (notify?: BookingNotifier) =>
        finalizeMeetingPoll({ ...fixture.ctx, notify }, request)
      const book = (notify?: BookingNotifier) =>
        createPublicTeamBooking({ db, now: fixture.ctx.now, notify }, bookingInput)
      const publicFirst = first === 'public booking'
      // The first booking pauses after insertion, while it still holds the host's booking lock.
      const [winner, loser] = await collideFinalizeWrites(
        db,
        async () => (publicFirst ? book(waitAtFinalizeGate) : finalize(waitAtFinalizeGate)),
        async () => (publicFirst ? finalize() : book()),
        'advisory',
      )

      if (!('value' in winner)) throw winner.error
      expect(winner.value.replayed).toBe(false)
      expect(loser).toMatchObject({ error: { code: 'slot_unavailable' } })
      const bookingId = winner.value.booking.id
      expect(
        await db
          .selectFrom('bookings')
          .select(['id', 'event_type_id', 'status'])
          .where('organization_id', '=', fixture.organizationId)
          .execute(),
      ).toEqual([
        {
          id: bookingId,
          event_type_id: publicFirst ? publicEventId : fixture.eventTypeId,
          status: 'confirmed',
        },
      ])
      expect(
        await db
          .selectFrom('meeting_polls')
          .select(['status', 'booking_id', 'chosen_slot_id', 'host_revision', 'results_revision'])
          .where('id', '=', fixture.poll.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        ...revisions,
        status: publicFirst ? 'open' : 'scheduled',
        booking_id: publicFirst ? null : bookingId,
        chosen_slot_id: publicFirst ? null : fixture.chosen.id,
        host_revision: revisions.host_revision + (publicFirst ? 0 : 1),
      })
      expect(
        await db
          .selectFrom('meeting_poll_operations')
          .select('booking_id')
          .where('poll_id', '=', fixture.poll.id)
          .where('operation', '=', 'finalize')
          .execute(),
      ).toEqual(publicFirst ? [] : [{ booking_id: bookingId }])
    },
    20000,
  )
})
