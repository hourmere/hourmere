import { randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activityRange, getBookingActivity } from './analytics.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  domainError,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const filters = { startDate: '2026-10-01', endDate: '2026-10-03', timeZone: 'UTC' }

describe('activity date bins', () => {
  it.each([
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25],
  ])('uses real IANA midnight boundaries on %s', (date, from, to, hours) => {
    const bin = activityRange({ startDate: date, endDate: date, timeZone: 'Europe/Berlin' }).bins[0]
    expect(bin?.from.toISOString()).toBe(from)
    expect(bin?.to.toISOString()).toBe(to)
    expect(((bin?.to.getTime() ?? 0) - (bin?.from.getTime() ?? 0)) / 3_600_000).toBe(hours)
  })
  it('accepts exactly 90 calendar dates and represents skipped dates with zero duration', () => {
    expect(
      activityRange({ startDate: '2026-01-01', endDate: '2026-03-31', timeZone: 'UTC' }).bins,
    ).toHaveLength(90)
    expect(() =>
      activityRange({ startDate: '2026-01-01', endDate: '2026-04-01', timeZone: 'UTC' }),
    ).toThrow('Choose at most 90 calendar days')
    const skipped = activityRange({
      startDate: '2011-12-29',
      endDate: '2011-12-31',
      timeZone: 'Pacific/Apia',
    }).bins[1]
    expect(skipped?.from.getTime()).toBe(skipped?.to.getTime())
  })
  it.each([
    { startDate: '2026-10-04' },
    { endDate: '2026-09-30' },
    { endDate: '2027-01-01' },
    { startDate: '2026-02-30' },
    { endDate: '2026-02-30' },
    { startDate: '2026-10-01T00:00:00Z' },
    { startDate: 'x'.repeat(100_000) },
    { endDate: null },
  ])('refuses invalid service-level date input without echo', (overrides) => {
    expect(() => activityRange({ ...filters, ...overrides })).toThrow(
      'Choose at most 90 calendar days',
    )
  })
  it.each(['+01:00', 'Mars/Olympus', ''])('refuses non-IANA zones: %s', (timeZone) => {
    expect(() => activityRange({ ...filters, timeZone })).toThrow()
  })
})

describe.skipIf(!serverUrl)('booking activity with retained PostgreSQL records', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function record(
    org: string,
    at: string,
    options: { from?: string; cancelledAt?: string } = {},
  ) {
    const id = await createFixtures(db).booking(
      org,
      [],
      '2030-01-01T09:00:00Z',
      '2030-01-01T09:30:00Z',
      { attendee: null },
    )
    await db
      .updateTable('bookings')
      .set({
        created_at: at,
        rescheduled_from_id: options.from ?? null,
        ...(options.cancelledAt && { status: 'cancelled', cancelled_at: options.cancelledAt }),
      })
      .where('id', '=', id)
      .execute()
    return id
  }

  it('counts root creations, each move and only terminal cancellations by operation date', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const org = user.principal.organization.id
    const initial = await record(org, '2026-09-30T12:00:00Z', {
      cancelledAt: '2026-10-01T01:00:00Z',
    })
    const moved = await record(org, '2026-10-01T01:00:00Z', {
      from: initial,
      cancelledAt: '2026-10-02T01:00:00Z',
    })
    const latest = await record(org, '2026-10-02T01:00:00Z', {
      from: moved,
      cancelledAt: '2026-10-03T01:00:00Z',
    })
    await record(org, '2026-10-01T00:00:00Z')
    await record(org, '2026-10-03T23:59:59.999999Z')
    await record(org, '2026-10-04T00:00:00Z')
    const other = await createTestUser(db)
    await record(other.principal.organization.id, '2026-10-01T12:00:00Z', {
      cancelledAt: '2026-10-01T13:00:00Z',
    })
    expect(await getBookingActivity(ctx, filters)).toEqual({
      ...filters,
      totals: { created: 2, rescheduled: 2, cancelled: 1 },
      data: [
        { date: '2026-10-01', created: 1, rescheduled: 1, cancelled: 0 },
        { date: '2026-10-02', created: 0, rescheduled: 1, cancelled: 0 },
        { date: '2026-10-03', created: 1, rescheduled: 0, cancelled: 1 },
      ],
    })
    // A successor outside this narrow report still excludes a withdrawal from cancellations.
    expect(
      (await getBookingActivity(ctx, { ...filters, endDate: '2026-10-01' })).totals.cancelled,
    ).toBe(0)
    expect(
      (await getBookingActivity(ctx, { ...filters, startDate: '2026-10-03' })).totals.cancelled,
    ).toBe(1)
    expect(latest).toBeTruthy()
  })

  it('zero-fills empty dates and applies DST UTC boundaries in the SQL aggregate', async () => {
    const user = await createTestUser(db)
    const org = user.principal.organization.id
    const ctx = testContext(db, user.principal)
    await record(org, '2026-03-28T22:59:59.999999Z')
    await record(org, '2026-03-28T23:00:00Z')
    await record(org, '2026-03-29T21:59:59.999999Z')
    await record(org, '2026-03-29T22:00:00Z')
    const report = await getBookingActivity(ctx, {
      startDate: '2026-03-29',
      endDate: '2026-03-30',
      timeZone: 'Europe/Berlin',
    })
    expect(report.data).toEqual([
      { date: '2026-03-29', created: 2, rescheduled: 0, cancelled: 0 },
      { date: '2026-03-30', created: 1, rescheduled: 0, cancelled: 0 },
    ])
    const empty = await getBookingActivity(ctx, filters)
    expect(empty.data).toHaveLength(3)
    expect(empty.totals).toEqual({ created: 0, rescheduled: 0, cancelled: 0 })
    await record(org, '2026-10-24T21:59:59.999999Z')
    await record(org, '2026-10-24T22:00:00Z')
    await record(org, '2026-10-25T22:59:59.999999Z')
    await record(org, '2026-10-25T23:00:00Z')
    expect(
      (
        await getBookingActivity(ctx, {
          startDate: '2026-10-25',
          endDate: '2026-10-25',
          timeZone: 'Europe/Berlin',
        })
      ).totals.created,
    ).toBe(2)
    await record(org, '2011-12-30T09:59:59Z')
    await record(org, '2011-12-30T10:00:00Z')
    expect(
      (
        await getBookingActivity(ctx, {
          startDate: '2011-12-29',
          endDate: '2011-12-31',
          timeZone: 'Pacific/Apia',
        })
      ).data.map((day) => day.created),
    ).toEqual([1, 0, 1])
  })

  it('requires current team owner/admin standing and the real personal owner', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'member, admin' },
      { user: member, role: 'member' },
    ])
    await record(team.id, '2026-10-01T00:00:00Z')
    for (const user of [owner, admin])
      expect(
        (await getBookingActivity(testContext(db, team.as(user)), filters)).totals.created,
      ).toBe(1)
    expect(
      (await domainError(() => getBookingActivity(testContext(db, team.as(member)), filters))).code,
    ).toBe('insufficient_role')
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    expect(
      (await domainError(() => getBookingActivity(testContext(db, team.as(admin)), filters))).code,
    ).toBe('insufficient_role')
    const forged = { ...member.principal, organization: owner.principal.organization }
    expect(
      (await domainError(() => getBookingActivity(testContext(db, forged), filters))).code,
    ).toBe('insufficient_role')
    expect(
      (await getBookingActivity(testContext(db, owner.principal), filters)).totals.created,
    ).toBe(0)
  })

  it('does not observe half of an uncommitted transactional reschedule', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const org = user.principal.organization.id
    const root = await record(org, '2026-10-01T00:00:00Z')
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: '2026-10-02T00:00:00Z' })
        .where('id', '=', root)
        .execute()
      await trx
        .insertInto('bookings')
        .values({
          organization_id: org,
          start_at: '2030-01-02T09:00:00Z',
          end_at: '2030-01-02T09:30:00Z',
          title: 'Private title',
          source: 'web',
          manage_token_hash: randomBytes(32),
          rescheduled_from_id: root,
          created_at: '2026-10-02T00:00:00Z',
        })
        .execute()
      expect((await getBookingActivity(ctx, filters)).totals).toEqual({
        created: 1,
        rescheduled: 0,
        cancelled: 0,
      })
    })
    expect((await getBookingActivity(ctx, filters)).totals).toEqual({
      created: 1,
      rescheduled: 1,
      cancelled: 0,
    })
  })
})
