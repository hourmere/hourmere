import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db, importedBookingIds } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookAttendeeNoShowNotifier } from '../../webhooks/src/delivery.ts'
import { createWebhook } from '../../webhooks/src/service.ts'
import { findPublicEventType, findPublicTeamEventType } from './availability.ts'
import { bookingPageQuery, encodeBookingCursor } from './booking-page.ts'
import { getHostBooking } from './bookings.ts'
import { DomainError } from './errors.ts'
import { resolvedBookingHosts } from './hosts.ts'
import { isUuid } from './internal.ts'
import { listBookingAttendeeNoShows, setAttendeeNoShow } from './no-show.ts'
import { toTeamAdminBooking } from './team-admin-booking.ts'
import { getTeamAdminBooking, listTeamAdminBookings } from './team-bookings.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const now = () => Temporal.Instant.from('2030-11-03T12:00Z')
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }

function emailIdentityMutant(): typeof getTeamAdminBooking {
  let source = readFileSync(new URL('./team-bookings.ts', import.meta.url), 'utf8')
  const original = 'id: attendee.id,'
  expect(source).toContain(original)
  source = source.replace(
    original,
    'id: attendanceByBooking.get(booking.id).find((row) => row.email === attendee.email).id,',
  )
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    sql,
    bookingPageQuery,
    encodeBookingCursor,
    DomainError,
    isUuid,
    resolvedBookingHosts,
    importedBookingIds,
    toTeamAdminBooking,
    findPublicEventType,
    findPublicTeamEventType,
  }
  return new Function(...Object.keys(bindings), `${source}; return getTeamAdminBooking`)(
    ...Object.values(bindings),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('attendee identity with a shared mailbox', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  async function fixture(personal = false) {
    const host = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: host, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const { id: sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: admin.id,
        token: randomUUID(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        activeOrganizationId: team.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const adminCtx = testContext(db, { ...team.as(admin), kind: 'session', sessionId }, now)
    const hostCtx = testContext(db, personal ? host.principal : team.as(host), now)
    const bookingId = await createFixtures(db).booking(
      hostCtx.principal.organization.id,
      [host.id],
      '2030-11-03T09:00Z',
      '2030-11-03T09:30Z',
      { attendee: { name: 'Booker', email: 'shared@example.com' } },
    )
    const booker = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    const guest = await db
      .insertInto('booking_attendees')
      .values({
        booking_id: bookingId,
        name: 'Guest',
        email: 'shared@example.com',
        time_zone: 'UTC',
        is_booker: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { host, admin, adminCtx, hostCtx, bookingId, booker, guest }
  }

  it.each([false, true])(
    'keeps separate rows, marks and webhook identities (personal=%s)',
    async (personal) => {
      const s = await fixture(personal)
      const ctx = personal ? s.hostCtx : s.adminCtx
      const { webhook } = await createWebhook(ctx, settings, {
        url: 'https://hooks.example.com/attendance',
        events: ['booking.attendee_no_show_changed'],
      })
      ctx.notifyAttendeeNoShow = webhookAttendeeNoShowNotifier(
        { enqueue: async () => randomUUID() },
        settings,
      )
      const read = async () =>
        personal ? getHostBooking(ctx, s.bookingId) : getTeamAdminBooking(ctx, s.bookingId)
      const detail = await read()
      expect(detail.attendees.map((a) => a.id)).toEqual([s.booker.id, s.guest.id])
      if (!personal) {
        const page = await listTeamAdminBookings(ctx)
        expect(page.data[0]?.attendees.map((a) => a.id)).toEqual([s.booker.id, s.guest.id])
      }
      const guestId = detail.attendees.find((a) => !a.isBooker)?.id
      const bookerId = detail.attendees.find((a) => a.isBooker)?.id
      if (!guestId || !bookerId) throw new Error('Missing attendee IDs')
      await setAttendeeNoShow(ctx, s.bookingId, guestId, true)
      expect((await read()).attendees.map((a) => a.noShowMarkedBy)).toEqual([
        null,
        ctx.principal.user.id,
      ])
      expect((await getHostBooking(s.hostCtx, s.bookingId)).attendees.map((a) => a.id)).toEqual([
        s.booker.id,
        s.guest.id,
      ])
      const agentRead = await listBookingAttendeeNoShows(s.hostCtx, s.bookingId)
      expect(agentRead.map((a) => [a.id, a.noShowMarkedBy])).toEqual([
        [s.booker.id, null],
        [s.guest.id, ctx.principal.user.id],
      ])
      await setAttendeeNoShow(ctx, s.bookingId, bookerId, true)
      await setAttendeeNoShow(ctx, s.bookingId, guestId, false)
      expect((await read()).attendees.map((a) => a.noShowMarkedBy)).toEqual([
        ctx.principal.user.id,
        null,
      ])
      const rows = await db
        .selectFrom('webhook_deliveries')
        .select('payload')
        .where('webhook_id', '=', webhook.id)
        .execute()
      expect(rows.map((row) => JSON.parse(row.payload).data)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attendeeId: s.guest.id,
            noShowMarkedBy: ctx.principal.user.id,
          }),
          expect.objectContaining({
            attendeeId: s.booker.id,
            noShowMarkedBy: ctx.principal.user.id,
          }),
          expect.objectContaining({ attendeeId: s.guest.id, noShowMarkedBy: null }),
        ]),
      )
      expect(rows).toHaveLength(3)
      expect(owned.pool.totalCount).toBeLessThan(20)
    },
  )

  it('kills a source copy that assigns IDs by email', async () => {
    const s = await fixture()
    const verify = async (read: typeof getTeamAdminBooking) => {
      const detail = await read(s.adminCtx, s.bookingId)
      expect(detail.attendees.map((a) => a.id)).toEqual([s.booker.id, s.guest.id])
    }
    await verify(getTeamAdminBooking)
    await expect(verify(emailIdentityMutant())).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(getTeamAdminBooking)
  })
})
