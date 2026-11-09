import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import {
  cancelHostBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  rescheduleHostBooking,
} from './bookings.ts'
import { listBookingAttendeeNoShows, setAttendeeNoShow } from './no-show.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const START = '2026-11-01T09:30:00Z' // Second 01:30 in Los Angeles, after the DST fold.
const AFTER = Temporal.Instant.from(START).add({ nanoseconds: 1 })
describe.skipIf(!serverUrl)('private attendee no-show', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(
    options: { source?: 'api' | 'import'; status?: 'confirmed' | 'cancelled' } = {},
  ) {
    const host = await createTestUser(db)
    const other = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: host, role: 'member' },
      { user: other, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const bookingId = await createFixtures(db).booking(
      team.id,
      [host.id],
      START,
      '2026-11-01T10:00:00Z',
      options,
    )
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    const guest = await db
      .insertInto('booking_attendees')
      .values({
        booking_id: bookingId,
        name: 'Guest',
        email: 'guest@example.com',
        time_zone: 'UTC',
        is_booker: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ctx = testContext(db, team.as(host), () => AFTER)
    return { host, other, admin, team, bookingId, attendeeId: attendee.id, guestId: guest.id, ctx }
  }
  it('marks independently, records actor, replays without rewriting or notifying, and clears idempotently', async () => {
    const s = await setup()
    const notify = vi.fn()
    const changed = vi.fn()
    s.ctx.notify = notify
    s.ctx.notifyAttendeeNoShow = changed
    const mark = await setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)
    expect(mark).toEqual({
      attendeeId: s.attendeeId,
      noShowMarkedAt: '2026-11-01T09:30:00.000Z',
      noShowMarkedBy: s.host.id,
    })
    const adminCtx = {
      ...s.ctx,
      principal: { ...s.team.as(s.admin), kind: 'session' as const, sessionId: 'test' },
    }
    expect(await setAttendeeNoShow(adminCtx, s.bookingId, s.attendeeId, true)).toEqual(mark)
    expect(changed).toHaveBeenCalledTimes(1)
    const guest = await db
      .selectFrom('booking_attendees')
      .selectAll()
      .where('id', '=', s.guestId)
      .executeTakeFirstOrThrow()
    expect(guest.no_show_marked_at).toBeNull()
    expect((await getHostBooking(s.ctx, s.bookingId)).attendees[0]).toMatchObject({
      id: s.attendeeId,
      noShowMarkedBy: s.host.id,
    })
    await setAttendeeNoShow(adminCtx, s.bookingId, s.attendeeId, false)
    expect(await setAttendeeNoShow(adminCtx, s.bookingId, s.attendeeId, false)).toEqual({
      attendeeId: s.attendeeId,
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(notify).not.toHaveBeenCalled()
  })
  it('refuses nonhosts, unrelated organizations, removed members and unrelated attendees', async () => {
    const s = await setup()
    for (const principal of [s.team.as(s.other), s.admin.principal])
      await expect(
        setAttendeeNoShow({ ...s.ctx, principal }, s.bookingId, s.attendeeId, true),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
    await expect(setAttendeeNoShow(s.ctx, s.bookingId, randomUUID(), true)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', s.host.id)
      .execute()
    await expect(setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
  })
  it('limits non-host manager access to sessions for reads and writes across the credential matrix', async () => {
    const s = await setup()
    for (const role of ['owner', 'admin', 'member']) {
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', s.team.id)
        .where('userId', '=', s.admin.id)
        .execute()
      for (const actor of [s.host, s.admin]) {
        for (const credential of [
          { kind: 'session', sessionId: 'test' },
          ...(['read', 'bookings', 'full'] as const).map((apiKeyScope) => ({
            kind: 'api_key' as const,
            apiKeyScope,
            apiKeyId: 'test',
          })),
          { kind: 'oauth', oauthConsentId: 'test', clientId: 'test', scopes: ['mcp:tools'] },
        ] as const) {
          const ctx = { ...s.ctx, principal: { ...s.team.as(actor), ...credential } }
          const allowed = actor === s.host || (credential.kind === 'session' && role !== 'member')
          if (allowed) {
            expect(await listBookingAttendeeNoShows(ctx, s.bookingId)).toHaveLength(2)
            expect(await setAttendeeNoShow(ctx, s.bookingId, s.attendeeId, true)).toMatchObject({
              attendeeId: s.attendeeId,
            })
          } else {
            await expect(listBookingAttendeeNoShows(ctx, s.bookingId)).rejects.toMatchObject({
              code: 'booking_not_found',
            })
            await expect(
              setAttendeeNoShow(ctx, s.bookingId, s.attendeeId, true),
            ).rejects.toMatchObject({ code: 'booking_not_found' })
          }
        }
      }
    }
  })
  it('hides bookings in another organization from its non-personal team administrator', async () => {
    const s = await setup()
    const unrelated = await createTestTeam(db, [{ user: s.admin, role: 'admin' }])
    const ctx = {
      ...s.ctx,
      principal: { ...unrelated.as(s.admin), kind: 'session' as const, sessionId: 'test' },
    }
    await expect(listBookingAttendeeNoShows(ctx, s.bookingId)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(setAttendeeNoShow(ctx, s.bookingId, s.attendeeId, true)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
  })
  it('reads attendees without waiting for a booking write lock', async () => {
    const s = await setup()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [s.bookingId])
    try {
      const reader = new pg.Pool({
        connectionString: owned.url,
        max: 1,
        options: '-c lock_timeout=300ms',
      })
      try {
        await expect(
          listBookingAttendeeNoShows({ ...s.ctx, db: createDb(reader) }, s.bookingId),
        ).resolves.toHaveLength(2)
      } finally {
        await reader.end()
      }
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  })
  it('uses instant boundaries across the repeated DST hour', async () => {
    const s = await setup()
    for (const now of ['2026-11-01T08:30:00Z', START])
      await expect(
        setAttendeeNoShow(
          { ...s.ctx, now: () => Temporal.Instant.from(now) },
          s.bookingId,
          s.attendeeId,
          true,
        ),
      ).rejects.toMatchObject({ code: 'booking_not_started' })
    await expect(setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)).resolves.toMatchObject({
      noShowMarkedBy: s.host.id,
    })
  })
  it('refuses cancelled and imported bookings including unmark', async () => {
    for (const [options, code] of [
      [{ status: 'cancelled' }, 'booking_cancelled'],
      [{ source: 'import' }, 'imported_booking_read_only'],
    ] as const) {
      const s = await setup(options)
      for (const marked of [true, false])
        await expect(
          setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, marked),
        ).rejects.toMatchObject({ code })
    }
  })
  it('hides unconfirmed payment holds and refuses paid bookings like other host actions', async () => {
    const holdExpiresAt = '2026-11-01T09:00:00Z'
    const unconfirmed = [
      ['pending_payment'],
      ['pending_payment', 'expired'],
      ['pending_payment', 'cancelled'],
    ] as const
    for (const states of unconfirmed) {
      const s = await setup()
      for (const status of states)
        await db
          .updateTable('bookings')
          .set({
            status,
            ...(status === 'pending_payment' ? { payment_hold_expires_at: holdExpiresAt } : {}),
            ...(status === 'cancelled' ? { cancelled_at: holdExpiresAt } : {}),
          })
          .where('id', '=', s.bookingId)
          .execute()
      await expect(listBookingAttendeeNoShows(s.ctx, s.bookingId)).rejects.toMatchObject({
        code: 'booking_not_found',
      })
      for (const marked of [true, false])
        await expect(
          setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, marked),
        ).rejects.toMatchObject({ code: 'booking_not_found' })
      // Host booking detail reads agree.
      await expect(getHostBooking(s.ctx, s.bookingId)).rejects.toMatchObject({
        code: 'booking_not_found',
      })
    }
    // A confirmed paid booking stays readable but, like cancel/reschedule, is not managed.
    const paid = await setup()
    await db
      .updateTable('bookings')
      .set({ payment_hold_expires_at: holdExpiresAt, payment_reference: 'pi_noshow_paid' })
      .where('id', '=', paid.bookingId)
      .execute()
    const row = await db
      .selectFrom('bookings')
      .select(['status', 'payment_confirmed_at'])
      .where('id', '=', paid.bookingId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('confirmed')
    expect(row.payment_confirmed_at).toBeInstanceOf(Date)
    expect(
      (await listBookingAttendeeNoShows(paid.ctx, paid.bookingId)).map((attendee) => attendee.id),
    ).toContain(paid.attendeeId)
    await expect(
      setAttendeeNoShow(paid.ctx, paid.bookingId, paid.attendeeId, true),
    ).rejects.toMatchObject({ code: 'paid_booking_management_unavailable' })
  })
  it('serializes concurrent marks and persists exactly one transition', async () => {
    const s = await setup()
    const changed = vi.fn()
    s.ctx.notifyAttendeeNoShow = changed
    const results = await Promise.all(
      Array.from({ length: 8 }, () => setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)),
    )
    expect(results.every((row) => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    await Promise.all([
      setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, false),
      setAttendeeNoShow(s.ctx, s.bookingId, s.guestId, true),
    ])
    const rows = await db
      .selectFrom('booking_attendees')
      .select(['id', 'no_show_marked_at'])
      .where('booking_id', '=', s.bookingId)
      .execute()
    expect(rows.find((row) => row.id === s.attendeeId)?.no_show_marked_at).toBeNull()
    expect(rows.find((row) => row.id === s.guestId)?.no_show_marked_at).toBeInstanceOf(Date)
    expect(owned.pool.totalCount).toBeLessThan(20)
  })
  it('rolls back when transactional webhook capture fails', async () => {
    const s = await setup()
    s.ctx.notifyAttendeeNoShow = async () => {
      throw new Error('capture failed')
    }
    await expect(setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)).rejects.toThrow(
      'capture failed',
    )
    const row = await db
      .selectFrom('booking_attendees')
      .select('no_show_marked_at')
      .where('id', '=', s.attendeeId)
      .executeTakeFirstOrThrow()
    expect(row.no_show_marked_at).toBeNull()
  })
  it('does not expose markers to manage links or change scheduled messages', async () => {
    const s = await setup()
    const token = 'a'.repeat(43)
    await db
      .updateTable('bookings')
      .set({ manage_token_hash: createHash('sha256').update(token).digest() })
      .where('id', '=', s.bookingId)
      .execute()
    await owned.pool.query(
      `INSERT INTO booking_scheduled_messages
      (organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at)
      SELECT organization_id,id,'follow_up','after',start_at,end_at,end_at+interval '1 hour',end_at+interval '25 hours',end_at+interval '1 hour' FROM bookings WHERE id=$1`,
      [s.bookingId],
    )
    const before = (
      await owned.pool.query(
        'SELECT to_jsonb(m) AS row FROM booking_scheduled_messages m WHERE booking_id=$1',
        [s.bookingId],
      )
    ).rows
    await setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)
    const publicBooking = await getManagedBooking({ db, now: () => AFTER }, token)
    expect(publicBooking).not.toHaveProperty('canManageNoShow')
    for (const attendee of publicBooking.attendees) {
      expect(attendee).not.toHaveProperty('id')
      expect(attendee).not.toHaveProperty('noShowMarkedAt')
      expect(attendee).not.toHaveProperty('noShowMarkedBy')
    }
    expect(
      (
        await owned.pool.query(
          'SELECT to_jsonb(m) AS row FROM booking_scheduled_messages m WHERE booking_id=$1',
          [s.bookingId],
        )
      ).rows,
    ).toEqual(before)
  })
  it('marks only one real group seat through its shared saved host', async () => {
    const fixture = await groupFixture(owned.pool)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.organization,
        userId: fixture.host,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const { bookings } = await occupiedSlot(fixture, 2)
    const actor = await createTestUser(db)
    const principal = {
      ...actor.principal,
      user: { ...actor.principal.user, id: fixture.host },
      organization: { ...actor.principal.organization, id: fixture.organization, personal: false },
    }
    const ctx = testContext(db, principal, () => Temporal.Instant.from(fixture.end))
    const attendees = await db
      .selectFrom('booking_attendees')
      .select(['id', 'booking_id'])
      .where('booking_id', 'in', bookings)
      .orderBy('booking_id')
      .execute()
    const first = attendees[0]
    const second = attendees[1]
    if (!first || !second) throw new Error('missing seat fixtures')
    expect((await getHostBooking(ctx, first.booking_id)).attendees[0]).toMatchObject({
      id: first.id,
    })
    expect((await listHostBookings(ctx)).data.map((row) => row.id)).toEqual(
      expect.arrayContaining(bookings),
    )
    await setAttendeeNoShow(ctx, first.booking_id, first.id, true)
    await expect(setAttendeeNoShow(ctx, first.booking_id, second.id, true)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    expect(
      (
        await db
          .selectFrom('booking_attendees')
          .select('no_show_marked_at')
          .where('id', '=', second.id)
          .executeTakeFirstOrThrow()
      ).no_show_marked_at,
    ).toBeNull()
  })
  it('uses the spring-forward instant without inventing a missing wall-clock hour', async () => {
    const s = await setup()
    await db
      .updateTable('bookings')
      .set({ start_at: '2026-03-08T10:00:00Z', end_at: '2026-03-08T10:30:00Z' })
      .where('id', '=', s.bookingId)
      .execute()
    for (const now of ['2026-03-08T09:59:59.999Z', '2026-03-08T10:00:00Z'])
      await expect(
        setAttendeeNoShow(
          { ...s.ctx, now: () => Temporal.Instant.from(now) },
          s.bookingId,
          s.attendeeId,
          true,
        ),
      ).rejects.toMatchObject({ code: 'booking_not_started' })
    await expect(
      setAttendeeNoShow(
        { ...s.ctx, now: () => Temporal.Instant.from('2026-03-08T10:00:00.001Z') },
        s.bookingId,
        s.attendeeId,
        true,
      ),
    ).resolves.toMatchObject({ noShowMarkedBy: s.host.id })
  })
  it('refuses reschedule and cancel after a mark and preserves historical metadata', async () => {
    const s = await setup()
    await setAttendeeNoShow(s.ctx, s.bookingId, s.attendeeId, true)
    await expect(cancelHostBooking(s.ctx, s.bookingId)).rejects.toMatchObject({
      code: 'booking_in_past',
    })
    await expect(
      rescheduleHostBooking(s.ctx, s.bookingId, {
        start: Temporal.Instant.from('2026-11-03T10:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(Error)
    expect((await getHostBooking(s.ctx, s.bookingId)).attendees[0]).toMatchObject({
      noShowMarkedBy: s.host.id,
    })
  })
  it('rechecks demotion and cancellation while waiting for existing transaction locks', async () => {
    for (const change of ['role', 'status']) {
      const s = await setup()
      const blocker = await owned.pool.connect()
      await blocker.query('BEGIN')
      if (change === 'role')
        await blocker.query(
          'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
          ['member', s.team.id, s.admin.id],
        )
      else
        await blocker.query(
          "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
          [s.bookingId],
        )
      const pending = setAttendeeNoShow(
        {
          ...s.ctx,
          principal: { ...s.team.as(s.admin), kind: 'session' as const, sessionId: 'test' },
        },
        s.bookingId,
        s.attendeeId,
        true,
      )
      pending.catch(() => {})
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const waits = await owned.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
          if (waits.rows.length) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } finally {
        await blocker.query('COMMIT')
        blocker.release()
      }
      await expect(pending).rejects.toMatchObject({
        code: change === 'role' ? 'booking_not_found' : 'booking_cancelled',
      })
    }
  })
})
