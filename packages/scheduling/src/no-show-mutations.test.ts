import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertBookingLocallyManaged } from './bookings.ts'
import { DomainError } from './errors.ts'
import { lockOrganization, resolvedBookingHosts } from './hosts.ts'
import { isUuid } from './internal.ts'
import { setAttendeeNoShow } from './no-show.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
function sourceCopy(
  from: string,
  to: string,
  barrier?: () => Promise<void>,
): typeof setAttendeeNoShow {
  const original = readFileSync(new URL('./no-show.ts', import.meta.url), 'utf8')
  let source = original.slice(original.indexOf('export async function setAttendeeNoShow('))
  expect(source.includes(from)).toBe(true)
  if (barrier)
    source = source
      .replaceAll('.forUpdate()', '')
      .replace('await lockOrganization(trx, ctx.principal.organization.id)', '')
      .replace('    const current:', '    await barrier(); const current:')
  source = stripTypeScriptTypes(source.replace(from, to)).replace(/\bexport /g, '')
  const bindings = {
    barrier,
    assertBookingLocallyManaged,
    DomainError,
    lockOrganization,
    resolvedBookingHosts,
    isUuid,
  }
  return new Function(...Object.keys(bindings), `${source};return setAttendeeNoShow`)(
    ...Object.values(bindings),
  )
}
describe.skipIf(!serverUrl)('no-show source-copy mutations', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const mutations = [
    ['verification', 'if (!actor?.emailVerified) throw missing()', '', 'verification'],
    ['membership', ".where('member.userId', '=', ctx.principal.user.id)", '', 'membership'],
    [
      'organization scope',
      ".where('organization_id', '=', ctx.principal.organization.id)",
      '',
      'organization',
    ],
    ['host authorization', 'if (!isHost && !manager) throw missing()', '', 'member'],
    ['cancelled refusal', "if (booking.status !== 'confirmed')", 'if (false)', 'cancelled'],
    ['import read-only', 'await assertBookingLocallyManaged(trx, bookingId)', '', 'import'],
    ['start boundary', '<= 0)', '< 0)', 'boundary'],
    [
      'idempotence',
      'if ((current.noShowMarkedAt !== null) === noShow) return current',
      '',
      'replay',
    ],
    [
      'attendee isolation',
      ".where('booking_id', '=', bookingId)\n      .where('id', '=', attendeeId)",
      ".where('id', '=', attendeeId)",
      'attendee',
    ],
  ] as const
  for (const [name, from, to, scenario] of mutations)
    it(`kills ${name}`, async () => {
      const host = await createTestUser(db)
      const other = await createTestUser(db)
      const team = await createTestTeam(db, [
        { user: host, role: 'member' },
        { user: other, role: 'member' },
      ])
      const start = Temporal.Instant.from('2026-11-01T09:30:00Z')
      const booking = await createFixtures(db).booking(
        team.id,
        [host.id],
        start.toString(),
        '2026-11-01T10:00:00Z',
        {
          ...(scenario === 'cancelled' ? { status: 'cancelled' } : {}),
          ...(scenario === 'import' ? { source: 'import' } : {}),
        },
      )
      let attendee = (
        await db
          .selectFrom('booking_attendees')
          .select('id')
          .where('booking_id', '=', booking)
          .executeTakeFirstOrThrow()
      ).id
      if (scenario === 'attendee') {
        const second = await createFixtures(db).booking(
          team.id,
          [other.id],
          '2026-11-02T09:30:00Z',
          '2026-11-02T10:00:00Z',
        )
        attendee = (
          await db
            .selectFrom('booking_attendees')
            .select('id')
            .where('booking_id', '=', second)
            .executeTakeFirstOrThrow()
        ).id
      }
      if (scenario === 'verification')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', host.id)
          .execute()
      if (scenario === 'membership')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', team.id)
          .where('userId', '=', host.id)
          .execute()
      const ctx = testContext(
        db,
        scenario === 'organization'
          ? host.principal
          : team.as(scenario === 'member' ? other : host),
        () => (scenario === 'boundary' ? start : start.add({ minutes: 1 })),
      )
      let captures = 0
      ctx.notifyAttendeeNoShow = async () => {
        captures++
      }
      const verify = async (fn: typeof setAttendeeNoShow) => {
        if (scenario === 'replay') {
          captures = 0
          await fn(ctx, booking, attendee, true)
          await fn(ctx, booking, attendee, true)
          expect(captures).toBe(1)
        } else await expect(fn(ctx, booking, attendee, true)).rejects.toBeInstanceOf(DomainError)
      }
      await verify(setAttendeeNoShow)
      await expect(verify(sourceCopy(from, to))).rejects.toMatchObject({ name: 'AssertionError' })
      if (scenario === 'replay') await setAttendeeNoShow(ctx, booking, attendee, false)
      else
        await db
          .updateTable('booking_attendees')
          .set({ no_show_marked_at: null, no_show_marked_by: null })
          .where('id', '=', attendee)
          .execute()
      await verify(setAttendeeNoShow)
    })
  it('kills public attendee metadata disclosure', () => {
    const original = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
    const start = original.indexOf(
      '    list.push({',
      original.indexOf('async function toBookings('),
    )
    const end = original.indexOf('    byBooking.set', start)
    const source = original.slice(start, end)
    const run = (text: string) =>
      new Function('host', 'a', `const list=[];${text};return list[0]`)(undefined, {
        id: 'private-id',
        name: 'Invitee',
        email: 'i@example.com',
        time_zone: 'UTC',
        locale: null,
        is_booker: true,
        no_show_marked_at: new Date(),
        no_show_marked_by: 'private-actor',
      })
    const verify = (text: string) => {
      const dto = run(text)
      expect(dto).not.toHaveProperty('id')
      expect(dto).not.toHaveProperty('noShowMarkedAt')
      expect(dto).not.toHaveProperty('noShowMarkedBy')
    }
    verify(source)
    expect(source.includes('...(host')).toBe(true)
    expect(() => verify(source.replace('...(host', '...(true'))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verify(source)
  })
  it('kills removal of write serialization with two readers held before their updates', async () => {
    const host = await createTestUser(db)
    const booking = await createFixtures(db).booking(
      host.principal.organization.id,
      [host.id],
      '2026-11-01T09:30:00Z',
      '2026-11-01T10:00:00Z',
    )
    const attendee = (
      await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', booking)
        .executeTakeFirstOrThrow()
    ).id
    const ctx = testContext(db, host.principal, () => Temporal.Instant.from('2026-11-01T10:00:00Z'))
    let captures = 0
    ctx.notifyAttendeeNoShow = async () => {
      captures++
    }
    const verify = async (fn: typeof setAttendeeNoShow) => {
      captures = 0
      await Promise.all([fn(ctx, booking, attendee, true), fn(ctx, booking, attendee, true)])
      expect(captures).toBe(1)
    }
    await verify(setAttendeeNoShow)
    await setAttendeeNoShow(ctx, booking, attendee, false)
    let arrivals = 0
    let release = () => {}
    const rendezvous = new Promise<void>((resolve) => {
      release = resolve
    })
    const barrier = async () => {
      if (++arrivals === 2) release()
      await rendezvous
    }
    const broken = sourceCopy('const missing =', 'const missing =', barrier)
    await expect(verify(broken)).rejects.toMatchObject({ name: 'AssertionError' })
    await setAttendeeNoShow(ctx, booking, attendee, false)
    await verify(setAttendeeNoShow)
  })
})
