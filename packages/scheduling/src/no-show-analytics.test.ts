import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import { activityRange, getBookingActivity } from './analytics.ts'
import { DomainError } from './errors.ts'
import { setAttendeeNoShow } from './no-show.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  domainError,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const later = () => Temporal.Instant.from('2026-12-01T00:00:00Z')
const october = { startDate: '2026-10-01', endDate: '2026-10-03', timeZone: 'UTC' }

function activityCopy(before: string, after: string): typeof getBookingActivity {
  const source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export async function getBookingActivity(')
  expect(source.slice(start)).toContain(before)
  const mutant = stripTypeScriptTypes(
    source.slice(start).replace('export async function', 'async function').replace(before, after),
  )
  return new Function(
    'sql',
    'activityRange',
    'DomainError',
    'count',
    `${mutant}; return getBookingActivity`,
  )(sql, activityRange, DomainError, (value: string) => Number(value)) as typeof getBookingActivity
}

describe.skipIf(!serverUrl)('no-show activity count with PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'noshow_stats' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function meeting(
    org: string,
    hosts: string[],
    start: string,
    options: { guests?: number; createdAt?: string; from?: string } = {},
  ) {
    // One-second meetings let boundary instants one second apart share a host.
    const end = Temporal.Instant.from(start).add({ seconds: 1 }).toString()
    const id = await createFixtures(db).booking(org, hosts, start, end)
    for (let guest = 0; guest < (options.guests ?? 0); guest++)
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: id,
          name: `Guest ${guest}`,
          email: `guest${guest}@example.com`,
          time_zone: 'UTC',
          is_booker: false,
        })
        .execute()
    await db
      .updateTable('bookings')
      .set({
        created_at: options.createdAt ?? '2026-09-01T00:00:00Z',
        rescheduled_from_id: options.from ?? null,
      })
      .where('id', '=', id)
      .execute()
    const attendees = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', id)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute()
    return { id, attendees: attendees.map((row) => row.id) }
  }
  const mark = (user: TestUser, bookingId: string, attendeeId: string, noShow = true) =>
    setAttendeeNoShow(testContext(db, user.principal, later), bookingId, attendeeId, noShow)
  const noShows = async (user: TestUser, filters = october) =>
    (await getBookingActivity(testContext(db, user.principal), filters)).data.map(
      (day) => day.noShows,
    )

  it('counts each marked attendee once, including guests and every group seat', async () => {
    const host = await createTestUser(db)
    const org = host.principal.organization.id
    // A booker and two guests on one booking: two marks count two.
    const guests = await meeting(org, [host.id], '2026-10-01T09:00:00Z', { guests: 2 })
    await mark(host, guests.id, guests.attendees[0] as string)
    await mark(host, guests.id, guests.attendees[2] as string)
    // A replayed mark keeps one stored mark and one count.
    await mark(host, guests.id, guests.attendees[2] as string)
    expect(await noShows(host)).toEqual([2, 0, 0])
    // Creations stay on their own operation dates; marks do not move them.
    expect((await getBookingActivity(testContext(db, host.principal), october)).totals).toEqual({
      created: 0,
      rescheduled: 0,
      cancelled: 0,
      noShows: 2,
    })
    // Unmarking removes the attendee from the count; replaying it does not subtract twice.
    await mark(host, guests.id, guests.attendees[0] as string, false)
    expect(await noShows(host)).toEqual([1, 0, 0])
    await mark(host, guests.id, guests.attendees[0] as string, false)
    expect(await noShows(host)).toEqual([1, 0, 0])
  })

  it('counts independent group seats of one slot separately', async () => {
    const fixture = await groupFixture(owned.pool)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.organization,
        userId: fixture.host,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const { bookings } = await occupiedSlot(fixture, 3)
    const template = await createTestUser(db)
    const host: TestUser = {
      ...template,
      id: fixture.host,
      principal: {
        ...template.principal,
        user: { ...template.principal.user, id: fixture.host },
        organization: { id: fixture.organization, name: 'Group team', slug: '', personal: false },
      },
    }
    for (const seat of bookings.slice(0, 2)) {
      const attendee = await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', seat)
        .executeTakeFirstOrThrow()
      await setAttendeeNoShow(
        testContext(db, host.principal, () => Temporal.Instant.from(fixture.end)),
        seat,
        attendee.id,
        true,
      )
    }
    const date = fixture.start.slice(0, 10)
    const report = await getBookingActivity(testContext(db, host.principal), {
      startDate: date,
      endDate: date,
      timeZone: 'UTC',
    })
    expect(bookings).toHaveLength(3)
    expect(report.totals.noShows).toBe(2)
  })

  it('excludes cancelled bookings and moved predecessors, and counts a successor by its own start', async () => {
    const host = await createTestUser(db)
    const org = host.principal.organization.id
    // Marked, then cancelled: the historical marker stays stored but no longer counts.
    const cancelled = await meeting(org, [host.id], '2026-10-01T09:00:00Z')
    await mark(host, cancelled.id, cancelled.attendees[0] as string)
    expect(await noShows(host)).toEqual([1, 0, 0])
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-01T10:00:00Z' })
      .where('id', '=', cancelled.id)
      .execute()
    expect(await noShows(host)).toEqual([0, 0, 0])
    expect(
      await db
        .selectFrom('booking_attendees')
        .select('no_show_marked_at')
        .where('booking_id', '=', cancelled.id)
        .executeTakeFirstOrThrow(),
    ).not.toEqual({ no_show_marked_at: null })
    // Marked, then moved: the withdrawn predecessor is cancelled, and the successor's fresh
    // attendee counts only when it is marked itself, on the successor's start date.
    const original = await meeting(org, [host.id], '2026-10-01T12:00:00Z')
    await mark(host, original.id, original.attendees[0] as string)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-01T13:00:00Z' })
      .where('id', '=', original.id)
      .execute()
    const moved = await meeting(org, [host.id], '2026-10-03T12:00:00Z', {
      from: original.id,
      createdAt: '2026-10-01T13:00:00Z',
    })
    expect(await noShows(host)).toEqual([0, 0, 0])
    await mark(host, moved.id, moved.attendees[0] as string)
    const report = await getBookingActivity(testContext(db, host.principal), october)
    expect(report.data.map((day) => day.noShows)).toEqual([0, 0, 1])
    expect(report.totals).toMatchObject({ rescheduled: 1, noShows: 1 })
    // The service refuses changes on cancelled bookings, so no unmark path can resurrect them.
    expect(
      (await domainError(() => mark(host, cancelled.id, cancelled.attendees[0] as string))).code,
    ).toBe('booking_cancelled')
  })

  it('excludes payment holds with stray markers and other organizations', async () => {
    const host = await createTestUser(db)
    const other = await createTestUser(db)
    const org = host.principal.organization.id
    for (const status of ['pending_payment', 'expired']) {
      const [hold] = await sql<{ id: string }>`INSERT INTO bookings (organization_id, title,
          start_at, end_at, source, status, payment_hold_expires_at)
        VALUES (${org}::uuid, 'Synthetic hold', '2026-10-01T09:00Z', '2026-10-01T09:30Z', 'web',
          ${status}, '2026-10-01T08:00Z')
        RETURNING id`
        .execute(db)
        .then((result) => result.rows)
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: hold?.id as string,
          name: 'Hold',
          email: 'hold@example.com',
          time_zone: 'UTC',
          is_booker: true,
          no_show_marked_at: '2026-10-01T10:00:00Z',
          no_show_marked_by: host.id,
        })
        .execute()
    }
    const foreign = await meeting(other.principal.organization.id, [other.id], '2026-10-01T09:00Z')
    await mark(other, foreign.id, foreign.attendees[0] as string)
    expect(await noShows(host)).toEqual([0, 0, 0])
    expect(await noShows(other)).toEqual([1, 0, 0])
  })

  it.each([
    // Berlin spring forward: 2026-03-29 has 23 hours, starting 2026-03-28T23:00Z.
    [
      'Europe/Berlin',
      '2026-03-29',
      '2026-03-30',
      [
        '2026-03-28T22:59:59Z',
        '2026-03-28T23:00:00Z',
        '2026-03-29T21:59:59Z',
        '2026-03-29T22:00:00Z',
      ],
      [2, 1],
    ],
    // Berlin fall back: 2026-10-25 has 25 hours, ending 2026-10-25T23:00Z.
    [
      'Europe/Berlin',
      '2026-10-25',
      '2026-10-26',
      [
        '2026-10-24T21:59:59Z',
        '2026-10-24T22:00:00Z',
        '2026-10-25T22:59:59Z',
        '2026-10-25T23:00:00Z',
      ],
      [2, 1],
    ],
    // Los Angeles fall back: 2026-11-01 runs from 07:00Z to 08:00Z the next day.
    [
      'America/Los_Angeles',
      '2026-11-01',
      '2026-11-02',
      [
        '2026-11-01T06:59:59Z',
        '2026-11-01T07:00:00Z',
        '2026-11-02T07:59:59Z',
        '2026-11-02T08:00:00Z',
      ],
      [2, 1],
    ],
  ] as const)(
    'bins by the local date of the scheduled start in %s across %s',
    async (timeZone, startDate, endDate, starts, expected) => {
      const host = await createTestUser(db)
      const org = host.principal.organization.id
      for (const start of starts) {
        const booking = await meeting(org, [host.id], start)
        await mark(host, booking.id, booking.attendees[0] as string)
      }
      expect(await noShows(host, { startDate, endDate, timeZone })).toEqual(expected)
      // The same instants in UTC fall on different dates: the report zone decides the bins.
      expect(
        (
          await getBookingActivity(testContext(db, host.principal), {
            startDate: starts[0].slice(0, 10),
            endDate: starts[3].slice(0, 10),
            timeZone: 'UTC',
          })
        ).totals.noShows,
      ).toBe(4)
    },
  )

  it('applies the report permissions uniformly to no-show counts', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'member, admin' },
      { user: member, role: 'member' },
    ])
    // The ordinary member hosts and marks the team booking; hosting does not grant the report.
    const booking = await meeting(team.id, [member.id], '2026-10-02T09:00:00Z')
    await setAttendeeNoShow(
      testContext(db, team.as(member), later),
      booking.id,
      booking.attendees[0] as string,
      true,
    )
    for (const user of [owner, admin])
      expect(
        (await getBookingActivity(testContext(db, team.as(user)), october)).totals.noShows,
      ).toBe(1)
    const forged = { ...outsider.principal, organization: team.as(owner).organization }
    for (const principal of [team.as(member), forged]) {
      const error = await domainError(() => getBookingActivity(testContext(db, principal), october))
      expect([error.code, error.kind]).toEqual(['insufficient_role', 'forbidden'])
    }
    // The member's personal report does not include the team booking they host.
    expect((await getBookingActivity(testContext(db, member.principal), october)).totals).toEqual({
      created: 0,
      rescheduled: 0,
      cancelled: 0,
      noShows: 0,
    })
  })

  it('source-copy negative control detects removal of the activity role guard', async () => {
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [{ user: member, role: 'member' }])
    const booking = await meeting(team.id, [member.id], '2026-10-02T09:00:00Z')
    const ctx = testContext(db, team.as(member), later)
    await setAttendeeNoShow(ctx, booking.id, booking.attendees[0] as string, true)
    const checkDenied = async (read: typeof getBookingActivity) =>
      expect(read(ctx, october)).rejects.toMatchObject({ code: 'insufficient_role' })
    await checkDenied(getBookingActivity)
    const mutant = activityCopy("WHERE btrim(role) IN ('owner', 'admin')", 'WHERE true')
    // The same assertion rejects the source copy after removing the role check.
    await expect(checkDenied(mutant)).rejects.toThrow()
  })

  it('source-copy negative controls detect each exclusion in the no-show branch', async () => {
    const host = await createTestUser(db)
    const org = host.principal.organization.id
    const kept = await meeting(org, [host.id], '2026-10-02T09:00:00Z')
    await mark(host, kept.id, kept.attendees[0] as string)
    const cancelled = await meeting(org, [host.id], '2026-10-02T10:00:00Z')
    await mark(host, cancelled.id, cancelled.attendees[0] as string)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-02T11:00:00Z' })
      .where('id', '=', cancelled.id)
      .execute()
    const unmarked = await meeting(org, [host.id], '2026-10-02T11:00:00Z', { guests: 1 })
    expect(unmarked.attendees).toHaveLength(2)
    const ctx = testContext(db, host.principal)
    expect((await getBookingActivity(ctx, october)).totals.noShows).toBe(1)
    const status = "AND b.status = 'confirmed'\n        AND (b.payment_hold_expires_at IS NULL"
    for (const [before, after] of [
      [status, 'AND (b.payment_hold_expires_at IS NULL'],
      ['AND a.no_show_marked_at IS NOT NULL', ''],
      ['SELECT b.start_at AS at, 0, 0, 0, 1', 'SELECT a.no_show_marked_at AS at, 0, 0, 0, 1'],
    ] as const) {
      const mutant = activityCopy(before, after)
      const totals = (await mutant(ctx, october)).totals
      expect(() => expect(totals.noShows).toBe(1)).toThrow()
    }
  })
})
