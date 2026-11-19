import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelManagedBooking, rescheduleManagedBooking } from './bookings.ts'
import { getManagedBookingDetails } from './manage.ts'
import { resolveSeriesCapability, resolveSeriesMember } from './recurring-capabilities.ts'
import { createPublicBookingSeries } from './recurring-creation.ts'
import { expandRecurringRule, type RecurringRule } from './recurring-rules.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const timeZone = 'UTC'
const durationMinutes = 30
const rule = { pattern: 'weekly', count: 2 } satisfies RecurringRule
const invitee = { name: 'Booker', email: 'booker@example.test', timeZone }
const guest = { name: 'Guest', email: 'guest@example.test' }
const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest()

describe.skipIf(!serverUrl)('recurring capabilities on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_caps' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup() {
    const host = await fixtures.host({ timeZone })
    await fixtures.schedule(host.userId, { timeZone })
    const slug = 'series-capabilities'
    const eventId = await fixtures.eventType(host.organizationId, host.userId, {
      slug,
      allowGuests: true,
    })
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 2 }),
      })
      .where('id', '=', eventId)
      .execute()

    async function book(hour = '09') {
      const firstLocalStart = `2026-11-02T${hour}:00+00:00`
      const occurrences = expandRecurringRule({
        firstLocalStart,
        rule,
        timeZone,
        durationMinutes,
        now: now(),
      })
      const input = {
        handle: host.handle,
        slug,
        firstLocalStart,
        rule,
        invitee,
        guests: [guest, { name: 'Sibling', email: 'sibling@example.test' }],
        idempotencyKey: randomUUID(),
        expectedPreview: {
          eventRevision: '0',
          rule,
          durationMinutes,
          timeZone,
          occurrences: occurrences.map(({ ordinal, localStart, start, end, offset }) => ({
            ordinal,
            localStart,
            start: start?.toString() ?? null,
            end: end?.toString() ?? null,
            offset,
          })),
        },
      }
      const create = () =>
        createPublicBookingSeries({ db, now }, input, {
          actorDigest: hash('test actor'),
          recurringBookingsEnabled: true,
        })
      const result = await create()
      const { manageToken, seriesId } = result
      const [first, second] = result.occurrences
      if (!manageToken || !first || !second) throw new Error('Expected a new two-member series')
      return {
        organizationId: host.organizationId,
        manageToken,
        seriesId,
        first,
        second,
        replay: create,
      }
    }

    return { book }
  }

  async function attendeeId(bookingId: string, email: string) {
    const { id } = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
    return id
  }

  async function deliver(
    series: { organizationId: string; seriesId: string },
    recipientId: string,
    role: 'booker' | 'guest',
  ) {
    const token = randomBytes(32).toString('base64url')
    const { id } = await db
      .insertInto('booking_series_notifications')
      .values({
        organization_id: series.organizationId,
        series_id: series.seriesId,
        row_type: 'receipt',
        kind: 'confirmation',
        sequence: 1,
        recipient_id: recipientId,
        recipient_role: role,
        outcome: 'delivered',
        capability_scope: role === 'booker' ? 'manage' : 'read',
        manage_token_hash: hash(token),
        sent_at: now().toString(),
        reported_ordinals: [1, 2],
        reported_link_states: ['no_conference', 'no_conference'],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id, token }
  }

  it('resolves the returned token by its digest and never reissues it on replay', async () => {
    const { book } = await setup()
    const series = await book()
    const { id, manage_token_hash } = await db
      .selectFrom('booking_series')
      .select(['id', 'manage_token_hash'])
      .where('id', '=', series.seriesId)
      .executeTakeFirstOrThrow()
    expect(manage_token_hash).toEqual(hash(series.manageToken))
    await expect(
      resolveSeriesCapability(db, series.manageToken, { scope: 'manage' }),
    ).resolves.toEqual({
      seriesId: id,
      organizationId: series.organizationId,
      revision: '1',
    })
    await expect(series.replay()).resolves.toMatchObject({ replayed: true, manageToken: null })
    for (const invalid of [
      `${series.manageToken}\n`,
      'invalid',
      randomBytes(32).toString('base64url'),
      hash(series.manageToken).toString('base64url'),
    ]) {
      await expect(
        resolveSeriesCapability(db, invalid, { scope: 'manage' }),
      ).resolves.toBeUndefined()
    }
    await expect(
      resolveSeriesMember(
        db,
        { seriesManageToken: series.manageToken, ordinal: 3 },
        { scope: 'read' },
      ),
    ).resolves.toBeUndefined()
  })

  it('binds delivered hashes to booker and guest roles and stops resolving revoked authority', async () => {
    const { book } = await setup()
    const series = await book()
    const bookerId = await attendeeId(series.first.bookingId, invitee.email)
    const guestId = await attendeeId(series.first.bookingId, guest.email)
    const bookerMail = await deliver(series, bookerId, 'booker')
    const guestMail = await deliver(series, guestId, 'guest')
    const wrongRole = await deliver(series, guestId, 'booker')

    const resolve = (token: string, scope: 'read' | 'manage') =>
      resolveSeriesMember(db, { seriesManageToken: token, ordinal: 2 }, { scope })
    const second = {
      seriesId: series.seriesId,
      organizationId: series.organizationId,
      revision: '1',
      occurrenceId: series.second.id,
      bookingId: series.second.bookingId,
    }
    await expect(resolve(bookerMail.token, 'manage')).resolves.toEqual(second)
    await expect(resolve(guestMail.token, 'read')).resolves.toEqual({
      ...second,
      guestEmail: guest.email,
    })
    await expect(resolve(guestMail.token, 'manage')).resolves.toBeUndefined()
    await expect(resolve(wrongRole.token, 'read')).resolves.toBeUndefined()

    const responses = { privateAnswer: 'Visible to the booker' }
    const note = 'Private note for the booker'
    await db
      .updateTable('bookings')
      .set({ responses: JSON.stringify(responses) })
      .where('id', '=', second.bookingId)
      .execute()
    const request = await db
      .insertInto('booking_reschedule_requests')
      .values({
        booking_id: second.bookingId,
        idempotency_key: randomUUID(),
        note,
        created_at: now().toString(),
        expires_at: now().add({ hours: 24 }).toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ctx = { db, now }
    const selector = { seriesManageToken: guestMail.token, ordinal: 2, expectedRevision: '1' }
    const guestRead = await getManagedBookingDetails(ctx, selector)
    expect(guestRead.id).toBe(second.bookingId)
    expect(guestRead.attendees).toMatchObject([{ ...guest, isBooker: false }])
    expect(guestRead.responses).toEqual({})
    expect(guestRead).not.toHaveProperty('pendingReschedule')
    expect(guestRead).not.toHaveProperty('rescheduleRequest')
    await expect(
      getManagedBookingDetails(ctx, { ...selector, seriesManageToken: bookerMail.token }),
    ).resolves.toMatchObject({ responses, pendingReschedule: { note } })
    await expect(
      cancelManagedBooking(ctx, selector, { rescheduleRequestId: request.id }),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
    await expect(
      rescheduleManagedBooking(ctx, selector, {
        start: Temporal.Instant.from('2026-11-09T10:00Z'),
        rescheduleRequestId: request.id,
      }),
    ).rejects.toMatchObject({ code: 'booking_not_found' })

    await db
      .updateTable('booking_series_notifications')
      .set({ manage_token_hash: null, capability_scope: null })
      .where('id', '=', bookerMail.id)
      .execute()
    await expect(resolve(bookerMail.token, 'read')).resolves.toBeUndefined()
    await expect(resolve(series.manageToken, 'manage')).resolves.toEqual(second)

    // A receipt retains a digest after its original recipient row is removed.
    await db.deleteFrom('booking_attendees').where('id', '=', guestId).execute()
    await expect(resolve(guestMail.token, 'read')).resolves.toBeUndefined()

    await db
      .updateTable('booking_series')
      .set({ manage_token_hash: null })
      .where('id', '=', series.seriesId)
      .execute()
    await expect(resolve(series.manageToken, 'read')).resolves.toBeUndefined()
  })

  it('rejects a different series or organization, including a receipt claiming their attendee', async () => {
    const { book } = await setup()
    const series = await book()
    const sameOrg = await book('10')
    const other = await setup()
    const otherOrg = await other.book()
    const selector = { seriesManageToken: series.manageToken, ordinal: 1 }
    await expect(
      resolveSeriesMember(db, selector, { scope: 'read', seriesId: sameOrg.seriesId }),
    ).resolves.toBeUndefined()
    await expect(
      resolveSeriesMember(db, selector, { scope: 'read', organizationId: otherOrg.organizationId }),
    ).resolves.toBeUndefined()

    const sameOrgAttendee = await attendeeId(sameOrg.first.bookingId, invitee.email)
    const foreignAttendee = await attendeeId(otherOrg.first.bookingId, invitee.email)
    const wrongSeries = await deliver(series, sameOrgAttendee, 'booker')
    const wrongOrg = await deliver(series, foreignAttendee, 'booker')
    for (const { token } of [wrongSeries, wrongOrg]) {
      await expect(
        resolveSeriesMember(db, { seriesManageToken: token, ordinal: 1 }, { scope: 'manage' }),
      ).resolves.toBeUndefined()
    }
  })

  it('follows the stable ordinal across chained moves into cancelled history', async () => {
    const { book } = await setup()
    const series = await book()
    const guestMail = await deliver(
      series,
      await attendeeId(series.first.bookingId, guest.email),
      'guest',
    )
    const finalId = await db.transaction().execute(async (trx) => {
      let predecessor = series.first.bookingId
      for (const day of [16, 23]) {
        await trx
          .updateTable('bookings')
          .set({ status: 'cancelled', cancelled_at: now().toString() })
          .where('id', '=', predecessor)
          .execute()
        const { id } = await trx
          .insertInto('bookings')
          .values({
            organization_id: series.organizationId,
            series_occurrence_id: series.first.id,
            rescheduled_from_id: predecessor,
            start_at: `2026-11-${day}T09:00:00Z`,
            end_at: `2026-11-${day}T09:30:00Z`,
            title: 'Moved series member',
            source: 'web',
            status: day === 23 ? 'cancelled' : 'confirmed',
            cancelled_at: day === 23 ? now().toString() : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('booking_attendees')
          .values([
            {
              booking_id: id,
              name: invitee.name,
              email: invitee.email,
              time_zone: timeZone,
              is_booker: true,
            },
            { booking_id: id, name: guest.name, email: guest.email, time_zone: timeZone },
          ])
          .execute()
        predecessor = id
      }
      return predecessor
    })

    const { manageToken } = series
    await expect(
      resolveSeriesMember(db, { seriesManageToken: manageToken, ordinal: 1 }, { scope: 'read' }),
    ).resolves.toMatchObject({ occurrenceId: series.first.id, bookingId: finalId })
    await expect(
      resolveSeriesMember(
        db,
        { seriesManageToken: guestMail.token, ordinal: 1 },
        { scope: 'read' },
      ),
    ).resolves.toMatchObject({
      occurrenceId: series.first.id,
      bookingId: finalId,
      guestEmail: guest.email,
    })
    await expect(
      resolveSeriesMember(db, { seriesManageToken: manageToken, ordinal: 2 }, { scope: 'read' }),
    ).resolves.toMatchObject({ occurrenceId: series.second.id, bookingId: series.second.bookingId })
    await db
      .deleteFrom('booking_attendees')
      .where('booking_id', '=', finalId)
      .where('email', '=', guest.email)
      .execute()
    await expect(
      resolveSeriesMember(
        db,
        { seriesManageToken: guestMail.token, ordinal: 1 },
        { scope: 'read' },
      ),
    ).resolves.toBeUndefined()
  })
})
