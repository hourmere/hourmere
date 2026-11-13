// The shared troubleshooting service behind REST, MCP and CLI, against real Postgres.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { explainEventAvailability, findSlots } from './availability.ts'
import {
  type TroubleshootAvailabilityInput,
  type TroubleshootAvailabilityResult,
  troubleshootEventAvailability,
} from './availability-troubleshooting.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { validTimeZone } from './internal.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  type Fixtures,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T00:00Z')
// Monday 2026-11-02 in UTC; hosts work 09:00–12:00 on Mondays.
const day = '2026-11-02'
const monday = { monday: [{ start: '09:00', end: '12:00' }] }
type Troubleshoot = typeof troubleshootEventAvailability

const at = (result: TroubleshootAvailabilityResult, time: string) =>
  result.slots.find((slot) => slot.start === `${day}T${time}:00Z`)
const codes = (result: TroubleshootAvailabilityResult, time: string) =>
  at(result, time)?.reasons.map((reason) => reason.code)

/** An isolated copy of the service module; production source stays untouched. */
function serviceCopy(change?: readonly [string, string]): Troubleshoot {
  let source = readFileSync('packages/scheduling/src/availability-troubleshooting.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { explainEventAvailability, DomainError, validTimeZone }
  return guardCopy(
    new Function(...Object.keys(bindings), `${source}; return troubleshootEventAvailability`)(
      ...Object.values(bindings),
    ) as Troubleshoot,
  )
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DomainError)
  const { kind, code, message } = error as DomainError
  return { kind, code, message }
}

describe.skipIf(!serverUrl)('availability troubleshooting service in Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'troubleshoot' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function principalOf(userId: string, organizationId: string, personal = true) {
    const user = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'name', 'slug'])
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow()
    return { user, organization: { ...organization, personal } }
  }

  async function personal(
    rules: EventTypeFixture = {},
    schedule: Parameters<Fixtures['schedule']>[1] = {},
  ) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC', weeklyHours: monday, ...schedule })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, rules)
    const identity = await principalOf(host.userId, host.organizationId)
    const principal: Principal = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'full',
      ...identity,
    }
    const ctx = testContext(db, principal, now)
    const input: TroubleshootAvailabilityInput = { eventTypeId, date: day, timeZone: 'UTC' }
    return { host, eventTypeId, ctx, input, identity }
  }

  async function team(mode: 'collective' | 'round_robin') {
    const owner = await createTestUser(db, 'Avery Owner')
    const member = await createTestUser(db, 'Blake Member')
    const admin = await createTestUser(db, 'Casey Admin')
    const t = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const ownerCtx = testContext(db, t.as(owner), now)
    for (const user of [owner, member])
      await f.schedule(user.id, { timeZone: 'UTC', weeklyHours: monday })
    let event = await createEventType(ownerCtx, {
      title: 'Team meeting',
      slug: `meeting-${mode.replace('_', '-')}`,
      durationMinutes: 30,
      schedulingType: mode,
      hosts: [owner, member].map((user) => ({ userId: user.id })),
    })
    if (mode === 'round_robin') event = await activateRoundRobin(ownerCtx, event.id)
    const input = { eventTypeId: event.id, date: day, timeZone: 'UTC' }
    return { owner, member, admin, t, ownerCtx, event, input }
  }

  describe('reports every reason kind the engine emits', () => {
    it('past', async () => {
      const s = await personal()
      const ctx = { ...s.ctx, now: () => instant(`${day}T10:00Z`) }
      const result = await troubleshootEventAvailability(ctx, s.input)
      expect(codes(result, '09:00')).toEqual(['past'])
      expect(at(result, '10:00')?.status).toBe('available')
    })

    it('duration_not_offered', async () => {
      const s = await personal()
      const result = await troubleshootEventAvailability(s.ctx, { ...s.input, durationMinutes: 45 })
      expect(result.durationMinutes).toBe(45)
      expect(result.slots.length).toBeGreaterThan(0)
      expect(result.slots.every((slot) => slot.status === 'unavailable')).toBe(true)
      expect(codes(result, '09:00')).toEqual(['duration_not_offered'])
    })

    it('outside_working_hours, for weekly hours and for a date override', async () => {
      const weekly = await personal()
      const result = await troubleshootEventAvailability(weekly.ctx, weekly.input)
      expect(codes(result, '08:00')).toEqual(['outside_working_hours'])
      expect(codes(result, '12:00')).toEqual(['outside_working_hours'])
      const override = await personal({}, { overrides: [{ date: day, intervals: [] }] })
      const closed = await troubleshootEventAvailability(override.ctx, override.input)
      expect(codes(closed, '09:00')).toEqual(['outside_working_hours'])
      expect(closed.slots.some((slot) => slot.status === 'available')).toBe(false)
    })

    it('off_slot_grid', async () => {
      const s = await personal({}, { weeklyHours: { monday: [{ start: '09:15', end: '12:00' }] } })
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(at(result, '09:15')?.status).toBe('available')
      expect(codes(result, '09:30')).toEqual(['off_slot_grid'])
    })

    it('minimum_notice', async () => {
      // now + 34 hours = 10:00 on the requested day.
      const s = await personal({ minimumNoticeMinutes: 34 * 60 })
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(codes(result, '09:00')).toEqual(['minimum_notice'])
      expect(at(result, '10:00')?.status).toBe('available')
    })

    it('booking_window', async () => {
      const s = await personal({ bookingWindowDays: 1 })
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(codes(result, '09:00')).toEqual(['booking_window'])
    })

    it('calendar_busy, without calendar or event details', async () => {
      const s = await personal()
      const busy = await f.calendarBusy(s.host.userId, [[`${day}T10:00Z`, `${day}T10:30Z`]])
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(at(result, '10:00')).toEqual({
        start: `${day}T10:00:00Z`,
        end: `${day}T10:30:00Z`,
        status: 'unavailable',
        reasons: [{ code: 'calendar_busy', start: `${day}T10:00:00Z`, end: `${day}T10:30:00Z` }],
      })
      const wire = JSON.stringify(result)
      for (const secret of [busy.calendarId, ...busy.externalEventIds, 'Work'])
        expect(wire).not.toContain(secret)
    })

    it('buffer_before, buffer_after and host_conflict, without booking details', async () => {
      const s = await personal({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 })
      const other = await f.eventType(s.host.organizationId, s.host.userId, {
        title: 'Private board review',
      })
      const bookingId = await f.booking(
        s.host.organizationId,
        [s.host.userId],
        `${day}T10:30Z`,
        `${day}T11:00Z`,
        {
          eventTypeId: other,
          attendee: { name: 'Secret Invitee', email: 'secret-invitee@example.com' },
        },
      )
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(codes(result, '10:00')).toEqual(['buffer_after'])
      expect(codes(result, '10:30')).toContain('host_conflict')
      expect(codes(result, '11:00')).toEqual(['buffer_before'])
      const wire = JSON.stringify(result)
      for (const secret of [
        bookingId,
        other,
        'Fixture booking',
        'Private board review',
        'Secret Invitee',
        'secret-invitee@example.com',
      ])
        expect(wire).not.toContain(secret)
      for (const slot of result.slots)
        for (const reason of slot.reasons)
          expect(Object.keys(reason).sort()).toEqual(['code', 'end', 'start'])
    })

    it.each([
      ['daily_limit', { maxBookingsPerDay: 1 }, `${day}T09:00Z`],
      ['weekly_limit', { maxBookingsPerWeek: 1 }, '2026-11-04T09:00Z'],
      ['monthly_limit', { maxBookingsPerMonth: 1 }, '2026-11-20T09:00Z'],
    ] as const)('%s', async (code, rules, booked) => {
      const s = await personal(rules)
      await f.booking(
        s.host.organizationId,
        [s.host.userId],
        booked,
        instant(booked).add({ minutes: 30 }).toString(),
        { eventTypeId: s.eventTypeId },
      )
      const result = await troubleshootEventAvailability(s.ctx, s.input)
      expect(codes(result, '11:00')).toEqual([code])
    })

    it('collective_member_unavailable, naming the member only for managers', async () => {
      const s = await team('collective')
      await f.calendarBusy(s.member.id, [[`${day}T10:00Z`, `${day}T10:30Z`]])
      const result = await troubleshootEventAvailability(s.ownerCtx, s.input)
      expect(result.hosts).toEqual([
        { userId: s.owner.id, name: 'Avery Owner' },
        { userId: s.member.id, name: 'Blake Member' },
      ])
      expect(at(result, '10:00')?.reasons).toEqual([
        {
          code: 'calendar_busy',
          start: `${day}T10:00:00Z`,
          end: `${day}T10:30:00Z`,
          hostUserId: s.member.id,
        },
        {
          code: 'collective_member_unavailable',
          start: `${day}T10:00:00Z`,
          end: `${day}T10:30:00Z`,
        },
      ])
      expect(at(result, '09:00')?.status).toBe('available')
    })

    it('no_eligible_round_robin_host', async () => {
      const s = await team('round_robin')
      await f.calendarBusy(s.owner.id, [[`${day}T10:00Z`, `${day}T10:30Z`]])
      const partly = await troubleshootEventAvailability(s.ownerCtx, s.input)
      // One free host is enough; the busy host's reason is then omitted.
      expect(at(partly, '10:00')).toMatchObject({ status: 'available', reasons: [] })
      await f.calendarBusy(s.member.id, [[`${day}T10:00Z`, `${day}T10:30Z`]])
      const result = await troubleshootEventAvailability(s.ownerCtx, s.input)
      expect(codes(result, '10:00')).toEqual([
        'calendar_busy',
        'calendar_busy',
        'no_eligible_round_robin_host',
      ])
    })
  })

  it('matches ordinary availability for the requested local day', async () => {
    const s = await personal({}, { timeZone: 'Asia/Tokyo' })
    const result = await troubleshootEventAvailability(s.ctx, {
      ...s.input,
      timeZone: 'Asia/Tokyo',
    })
    expect(result.rangeStart).toBe('2026-11-01T15:00:00Z')
    expect(result.rangeEnd).toBe('2026-11-02T15:00:00Z')
    const ordinary = await findSlots(db, {
      eventTypeId: s.eventTypeId,
      hostUserId: s.host.userId,
      rangeStart: instant(result.rangeStart),
      rangeEnd: instant(result.rangeEnd),
      now: now(),
    })
    expect(
      result.slots.filter((slot) => slot.status === 'available').map((slot) => slot.start),
    ).toEqual(ordinary.map((slot) => slot.start.toString()))
    expect(ordinary.length).toBeGreaterThan(0)
  })

  it('defaults the time zone to the caller profile, then UTC', async () => {
    const s = await personal()
    await db
      .updateTable('profiles')
      .set({ time_zone: 'America/Los_Angeles' })
      .where('user_id', '=', s.host.userId)
      .execute()
    const verify = async (run: Troubleshoot) => {
      const { timeZone: _omitted, ...input } = s.input
      const result = await run(s.ctx, input)
      expect(result.timeZone).toBe('America/Los_Angeles')
      expect(result.rangeStart).toBe('2026-11-02T08:00:00Z')
    }
    await verify(troubleshootEventAvailability)
    await verify(serviceCopy())
    await expectKilled(
      serviceCopy([
        "    timeZone = profile?.time_zone ?? 'UTC'",
        "    timeZone = 'UTC' // Mutation: ignore the profile.",
      ]),
      verify,
    )
    // Team managers need no profile; without one the day is read in UTC.
    const c = await team('collective')
    const { timeZone: _none, ...teamInput } = c.input
    const teamResult = await troubleshootEventAvailability(c.ownerCtx, teamInput)
    expect(teamResult.timeZone).toBe('UTC')
    expect(teamResult.rangeStart).toBe(`${day}T00:00:00Z`)
  })

  it.each([
    ['spring-forward', '2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23, 23],
    ['fall-back', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25, 24],
  ] as const)(
    'covers the whole %s DST day in America/New_York',
    async (_name, date, start, end, hours, starts) => {
      const host = await f.host({ timeZone: 'America/New_York' })
      await f.schedule(host.userId, {
        timeZone: 'America/New_York',
        weeklyHours: { sunday: [{ start: '00:00', end: '24:00' }] },
      })
      const eventTypeId = await f.eventType(host.organizationId, host.userId, {
        durationMinutes: 60,
      })
      const ctx = testContext(
        db,
        {
          kind: 'api_key',
          apiKeyId: randomUUID(),
          apiKeyScope: 'full',
          ...(await principalOf(host.userId, host.organizationId)),
        },
        () => instant('2026-02-01T00:00Z'),
      )
      const input = { eventTypeId, date, timeZone: 'America/New_York' }
      const verify = async (run: Troubleshoot) => {
        const result = await run(ctx, input)
        expect(result.rangeStart).toBe(start)
        expect(result.rangeEnd).toBe(end)
        expect(instant(end).since(instant(start)).total('hours')).toBe(hours)
        const available = result.slots.filter((slot) => slot.status === 'available')
        // One start per existing wall-clock hour: 02:00 does not exist in spring and the
        // repeated 01:00 in autumn uses its earlier occurrence, as ordinary availability does.
        expect(available).toHaveLength(starts)
        expect(available.at(-1)?.end).toBe(end)
        const ordinary = await findSlots(db, {
          eventTypeId,
          hostUserId: host.userId,
          rangeStart: instant(start),
          rangeEnd: instant(end),
          now: instant('2026-02-01T00:00Z'),
        })
        expect(available.map((slot) => slot.start)).toEqual(
          ordinary.map((slot) => slot.start.toString()),
        )
      }
      await verify(troubleshootEventAvailability)
      await verify(serviceCopy())
      await expectKilled(
        serviceCopy([
          '    rangeEnd = date.add({ days: 1 }).toZonedDateTime({ timeZone }).startOfDay().toInstant()',
          '    rangeEnd = rangeStart.add({ hours: 24 }) // Mutation: assume 24-hour days.',
        ]),
        verify,
      )
    },
  )

  it('serializes only allowlisted fields and host names only for team event types', async () => {
    const s = await personal()
    await f.calendarBusy(s.host.userId, [[`${day}T10:00Z`, `${day}T10:30Z`]])
    const verify = async (run: Troubleshoot) => {
      const result = await run(s.ctx, s.input)
      expect(Object.keys(result).sort()).toEqual([
        'date',
        'durationMinutes',
        'eventTypeId',
        'hosts',
        'rangeEnd',
        'rangeStart',
        'slots',
        'timeZone',
      ])
      expect(result.hosts).toEqual([])
      for (const slot of result.slots) {
        expect(Object.keys(slot).sort()).toEqual(['end', 'reasons', 'start', 'status'])
        for (const reason of slot.reasons)
          expect(Object.keys(reason).sort()).toEqual(['code', 'end', 'start'])
      }
    }
    await verify(troubleshootEventAvailability)
    await verify(serviceCopy())
    await expectKilled(
      serviceCopy([
        '      reasons: slot.reasons.map((reason) => ({\n',
        '      reasons: slot.reasons.map((reason) => ({\n        ...reason, // Mutation: copy engine fields.\n',
      ]),
      verify,
    )
    await expectKilled(serviceCopy(['    team && team.owner_user_id === null', '    team']), verify)
  })

  describe('authorization: every non-manager gets the missing-id answer', () => {
    it('denies other hosts, other organizations, team members and limited keys uniformly', async () => {
      const s = await personal()
      const c = await team('collective')
      const outsider = await createTestUser(db, 'Outside Owner')
      const otherTeam = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
      const missing = randomUUID()
      const ownerIdentity = s.identity
      const deniedCallers: [string, ServiceContext, string][] = [
        ['other host on a personal type', testContext(db, outsider.principal, now), s.eventTypeId],
        [
          'other organization owner on a team type',
          testContext(db, otherTeam.as(outsider), now),
          c.event.id,
        ],
        ['ordinary team member', testContext(db, c.t.as(c.member), now), c.event.id],
        [
          'team owner acting in personal space',
          testContext(db, c.owner.principal, now),
          c.event.id,
        ],
        ...(['read', 'bookings'] as const).map(
          (apiKeyScope) =>
            [
              `${apiKeyScope} API key of the owner`,
              testContext(
                db,
                { kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope, ...ownerIdentity },
                now,
              ),
              s.eventTypeId,
            ] as [string, ServiceContext, string],
        ),
      ]
      const verify = async (run: Troubleshoot) => {
        for (const [name, ctx, eventTypeId] of deniedCallers) {
          const denied = await rejection(run(ctx, { eventTypeId, date: day, timeZone: 'UTC' }))
          const absent = await rejection(
            run(ctx, { eventTypeId: missing, date: day, timeZone: 'UTC' }),
          )
          expect(denied, name).toMatchObject({ kind: 'not_found', code: 'event_type_not_found' })
          expect(denied, name).toEqual(absent)
        }
        expect(
          await rejection(run(s.ctx, { eventTypeId: 'not-a-uuid', date: day, timeZone: 'UTC' })),
        ).toEqual(await rejection(run(s.ctx, { eventTypeId: missing, date: day, timeZone: 'UTC' })))
      }
      await verify(troubleshootEventAvailability)
      await verify(serviceCopy())
      // A transport that widened the caller (here: any key treated as full) must be caught.
      await expectKilled(
        serviceCopy([
          '  const slots = await explainEventAvailability(ctx, {',
          "  const slots = await explainEventAvailability({ ...ctx, principal: { ...ctx.principal, apiKeyScope: 'full' } }, {",
        ]),
        verify,
      )
    })

    it('allows the personal owner by session and OAuth, and team owners and admins', async () => {
      const s = await personal()
      const c = await team('collective')
      const allowed: [string, ServiceContext, string][] = [
        [
          'owner session',
          testContext(db, { kind: 'session', sessionId: randomUUID(), ...s.identity }, now),
          s.eventTypeId,
        ],
        [
          'owner OAuth',
          testContext(
            db,
            {
              kind: 'oauth',
              oauthConsentId: randomUUID(),
              clientId: 'client',
              scopes: ['mcp:tools'],
              ...s.identity,
            },
            now,
          ),
          s.eventTypeId,
        ],
        ['team owner', c.ownerCtx, c.event.id],
        ['team admin', testContext(db, c.t.as(c.admin), now), c.event.id],
      ]
      for (const [name, ctx, eventTypeId] of allowed) {
        const result = await troubleshootEventAvailability(ctx, {
          eventTypeId,
          date: day,
          timeZone: 'UTC',
        })
        expect(
          result.slots.some((slot) => slot.status === 'available'),
          name,
        ).toBe(true)
      }
    })
  })

  it('rejects malformed dates and time zones with stable codes', async () => {
    const s = await personal()
    for (const date of ['2026-02-30', '2026-11-2', '0000-01-01', '2026-11-02T00:00Z', ''])
      expect(
        await rejection(troubleshootEventAvailability(s.ctx, { ...s.input, date })),
      ).toMatchObject({
        kind: 'invalid',
        code: 'invalid_date',
      })
    expect(
      await rejection(troubleshootEventAvailability(s.ctx, { ...s.input, timeZone: 'Mars/Base' })),
    ).toMatchObject({ kind: 'invalid', code: 'invalid_time_zone' })
    expect(
      await rejection(troubleshootEventAvailability(s.ctx, { ...s.input, durationMinutes: 0 })),
    ).toMatchObject({ kind: 'invalid', code: 'invalid_duration' })
  })

  it('keeps unreadable calendars an error rather than a reason', async () => {
    const s = await personal()
    // A Google connection without fresh sync coverage cannot vouch for free time.
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: s.host.userId,
        provider: 'google',
        external_account_id: `acct-${randomUUID()}`,
        credentials: Buffer.from('synthetic-never-used-credential'),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: `cal-${randomUUID()}`,
        name: 'Stale',
        check_conflicts: true,
      })
      .execute()
    expect(await rejection(troubleshootEventAvailability(s.ctx, s.input))).toMatchObject({
      kind: 'conflict',
      code: 'calendar_sync_unavailable',
    })
  })
})
