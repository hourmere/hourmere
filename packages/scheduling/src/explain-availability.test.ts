import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as core from '@hourmere/core'
import { publicAvatarImage } from '@hourmere/core/public-avatar'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explainEventAvailability, findSlots, listPublicTeamSlots } from './availability.ts'
import * as conferences from './conferences.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { activateRoundRobin, assertCanExplainEventType, createEventType } from './event-types.ts'
import { assertHosts, hasValidHostShape } from './hosts.ts'
import { LOCATION_KINDS } from './location-kinds.ts'
import { parseQuestions } from './questions.ts'
import { eligibleRoundRobinHosts } from './round-robin.ts'
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
const range = { rangeStart: instant('2026-11-02T08:00Z'), rangeEnd: instant('2026-11-02T13:00Z') }
type Explain = typeof explainEventAvailability
const views = (slots: readonly core.Slot[]) =>
  slots.map((slot) => ({ start: slot.start.toString(), end: slot.end.toString() }))
const codes = (slot: core.ExplainedSlot | undefined) => slot?.reasons.map((reason) => reason.code)
const at = (slots: core.ExplainedSlot[], time: string) =>
  slots.find((slot) => slot.start.equals(instant(`2026-11-02T${time}Z`)))

/** All mutations execute isolated source; production imports and source stay untouched. */
function sourceCopy(
  replacement?: readonly [string, string],
  coreOverrides: Record<string, unknown> = {},
) {
  let source = readFileSync('packages/scheduling/src/availability.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(
    source.replace(/^(?:import|export \{)[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    ...core,
    ...conferences,
    ...coreOverrides,
    sql,
    publicAvatarImage,
    DomainError,
    LOCATION_KINDS,
    assertHosts,
    hasValidHostShape,
    parseQuestions,
    eligibleRoundRobinHosts,
    assertCanExplainEventType,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { explainEventAvailability, findSlots }`,
  )(...Object.values(bindings)) as {
    explainEventAvailability: Explain
    findSlots: typeof findSlots
  }
}

describe.skipIf(!serverUrl)('availability explanations in Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'slot_explain' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function personal(rules: EventTypeFixture = {}) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, rules)
    const user = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', host.userId)
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'name', 'slug'])
      .where('id', '=', host.organizationId)
      .executeTakeFirstOrThrow()
    const ctx = testContext(
      db,
      {
        kind: 'api_key',
        apiKeyId: 'fixture',
        apiKeyScope: 'full',
        user,
        organization: { ...organization, personal: true },
      },
      now,
    )
    return { host, eventTypeId, ctx, query: { eventTypeId, ...range } }
  }

  async function team(mode: 'individual' | 'collective' | 'round_robin') {
    const owner = await createTestUser(db, 'Private first host')
    const member = await createTestUser(db, 'Private second host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const ctx = testContext(db, team.as(owner), now)
    for (const user of [owner, member])
      await f.schedule(user.id, {
        timeZone: 'UTC',
        weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
      })
    let event = await createEventType(ctx, {
      title: 'Team meeting',
      slug: 'meeting',
      durationMinutes: 30,
      schedulingType: mode,
      hosts: (mode === 'individual' ? [owner] : [owner, member]).map((user) => ({
        userId: user.id,
      })),
    })
    if (mode === 'round_robin') event = await activateRoundRobin(ctx, event.id)
    return { owner, member, team, ctx, event, query: { eventTypeId: event.id, ...range } }
  }

  it.each([
    ['individual', 'zoom'],
    ['individual', 'google_meet'],
    ['round_robin', 'google_meet'],
  ] as const)(
    'keeps %s explanation aligned when an unavailable default %s has an office alternative',
    async (mode, kind) => {
      const s = await team(mode)
      await db
        .updateTable('event_types')
        .set({
          locations: JSON.stringify([
            { id: 'video', kind, autoCreate: true, isDefault: true },
            { id: 'office', kind: 'in_person', address: 'Private office' },
          ]),
        })
        .where('id', '=', s.event.id)
        .execute()
      const ordinary = await listPublicTeamSlots(
        { db, now },
        {
          handle: s.ctx.principal.organization.slug,
          slug: s.event.slug,
          start: range.rangeStart,
          end: range.rangeEnd,
        },
      )
      expect(ordinary.length).toBeGreaterThan(0)
      const expected = ordinary.map((slot) => ({
        start: instant(slot.start).toString(),
        end: instant(slot.end).toString(),
      }))
      const verify = async (read: Explain) => {
        await expect(
          read(s.ctx, s.query).then((slots) =>
            views(slots.filter((slot) => slot.status === 'available')),
          ),
        ).resolves.toEqual(expected)
      }
      await verify(explainEventAvailability)
      await verify(sourceCopy().explainEventAvailability)
      const source = readFileSync('packages/scheduling/src/availability.ts', 'utf8')
      const explanation = source.slice(
        source.indexOf('export async function explainEventAvailability('),
      )
      const before = `(et.locations?.length ?? 0) <= 1 && ${kind === 'zoom' ? 'automaticZoom' : 'automaticMeet'}(et.location)`
      expect(explanation).toContain(before)
      await expect(
        verify(
          sourceCopy([
            explanation,
            explanation.replace(before, before.replace('(et.locations?.length ?? 0) <= 1 && ', '')),
          ]).explainEventAvailability,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(explainEventAvailability)
    },
  )

  it('keeps cross-event bookings distinct from calendars and excludes them from this event daily count', async () => {
    const s = await personal({ maxBookingsPerDay: 1 })
    const otherEvent = await f.eventType(s.host.organizationId, s.host.userId)
    await f.booking(
      s.host.organizationId,
      [s.host.userId],
      '2026-11-02T09:00Z',
      '2026-11-02T09:30Z',
      {
        eventTypeId: otherEvent,
      },
    )
    await f.calendarBusy(s.host.userId, [['2026-11-02T10:10Z', '2026-11-02T10:20Z']])
    const slots = await explainEventAvailability(s.ctx, s.query)
    expect(codes(at(slots, '09:00'))).toEqual(['host_conflict'])
    expect(codes(at(slots, '10:00'))).toEqual(['calendar_busy'])
    expect(at(slots, '11:00')?.status).toBe('available')
    expect(
      slots.flatMap((slot) => slot.reasons).some((reason) => reason.code === 'daily_limit'),
    ).toBe(false)
    expect(views(slots.filter((slot) => slot.status === 'available'))).toEqual(
      views(await findSlots(db, { ...s.query, hostUserId: s.host.userId, now: now() })),
    )
  })

  it.each([
    ['weekly_limit', 'max_bookings_per_week', '2026-11-02T04:00Z', '2026-11-08T04:00Z'],
    ['monthly_limit', 'max_bookings_per_month', '2026-11-01T03:00Z', '2026-11-29T04:00Z'],
  ] as const)(
    'counts the full host-local period for %s',
    async (reason, field, outside, inside) => {
      const s = await personal()
      await db
        .updateTable('event_types')
        .set({ [field]: 1 })
        .where('id', '=', s.eventTypeId)
        .execute()
      await db
        .updateTable('schedules')
        .set({
          time_zone: 'America/New_York',
          weekly_hours: JSON.stringify({ wednesday: [{ start: '09:00', end: '10:00' }] }),
        })
        .where('user_id', '=', s.host.userId)
        .execute()
      const query = {
        eventTypeId: s.eventTypeId,
        rangeStart: instant('2026-11-04T14:00Z'),
        rangeEnd: instant('2026-11-04T15:00Z'),
      }
      const book = (start: string) =>
        f.booking(
          s.host.organizationId,
          [s.host.userId],
          start,
          instant(start).add({ minutes: 30 }).toString(),
          { eventTypeId: s.eventTypeId },
        )
      await book(outside)
      expect(
        (await explainEventAvailability(s.ctx, query)).every((slot) => slot.status === 'available'),
      ).toBe(true)
      expect(
        (await findSlots(db, { ...query, hostUserId: s.host.userId, now: now() })).length,
      ).toBeGreaterThan(0)
      // These bookings are beyond the short busy-time window but inside the host's period.
      await book(inside)
      expect(await findSlots(db, { ...query, hostUserId: s.host.userId, now: now() })).toEqual([])
      const verify = async (read: Explain) => {
        const slots = await read(s.ctx, query)
        expect(slots.length).toBeGreaterThan(0)
        expect(slots.every((slot) => slot.status === 'unavailable')).toBe(true)
        expect(slots.every((slot) => codes(slot)?.includes(reason))).toBe(true)
      }
      await verify(explainEventAvailability)
      await expect(
        verify(
          sourceCopy([`if (eventType.${field} !== null) {`, 'if (false) {'])
            .explainEventAvailability,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(explainEventAvailability)
    },
  )

  it('authorizes before validating a malformed explanation range', async () => {
    const s = await personal()
    const invalid = { ...s.query, rangeEnd: s.query.rangeStart }
    const unauthorized = { db, now } as PublicContext as ServiceContext
    const verify = async (read: Explain) => {
      await expect(read(unauthorized, invalid)).rejects.toMatchObject({
        code: 'event_type_not_found',
      })
    }
    await verify(explainEventAvailability)
    await expect(explainEventAvailability(s.ctx, invalid)).rejects.toMatchObject({
      code: 'invalid_range',
    })
    await expect(
      verify(
        sourceCopy([
          '  await assertCanExplainEventType(ctx, query.eventTypeId)\n  checkSlotRange(query.rangeStart, query.rangeEnd)',
          '  checkSlotRange(query.rangeStart, query.rangeEnd)\n  await assertCanExplainEventType(ctx, query.eventTypeId)',
        ]).explainEventAvailability,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(explainEventAvailability)
  })

  it('returns unoffered duration and missing-schedule reasons without changing normal validation', async () => {
    const s = await personal({ maxBookingsPerWeek: 1, maxBookingsPerMonth: 1 })
    const slots = await explainEventAvailability(s.ctx, { ...s.query, durationMinutes: 45 })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => codes(slot)?.includes('duration_not_offered'))).toBe(true)
    await expect(
      findSlots(db, { ...s.query, hostUserId: s.host.userId, now: now(), durationMinutes: 45 }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
    await db.deleteFrom('schedules').where('user_id', '=', s.host.userId).execute()
    const verifyMissingSchedule = async (read: Explain) => {
      await expect(read(s.ctx, s.query)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'unavailable' })]),
      )
    }
    await verifyMissingSchedule(explainEventAvailability)
    await expect(
      verifyMissingSchedule(
        sourceCopy(["schedule?.time_zone ?? 'UTC'", 'schedule.time_zone']).explainEventAvailability,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    // Guard every newly merged period calculation against absent schedules.
    const source = readFileSync('packages/scheduling/src/availability.ts', 'utf8')
    const periodSource = source.slice(
      source.indexOf('  const firstDate = rangeStart'),
      source.indexOf('  const bookingWindow ='),
    )
    expect(periodSource.match(/\btimeZone\b/g)).toHaveLength(6)
    for (let target = 0; target < 6; target++) {
      let index = 0
      const mutant = periodSource.replace(/\btimeZone\b/g, (value) =>
        index++ === target ? 'schedule.time_zone' : value,
      )
      await expect(
        verifyMissingSchedule(sourceCopy([periodSource, mutant]).explainEventAvailability),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    }
    await verifyMissingSchedule(explainEventAvailability)
    const missing = await explainEventAvailability(s.ctx, s.query)
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.every((slot) => codes(slot)?.includes('outside_working_hours'))).toBe(true)
    expect(await findSlots(db, { ...s.query, hostUserId: s.host.userId, now: now() })).toEqual([])
    await expect(
      explainEventAvailability(s.ctx, { ...s.query, durationMinutes: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
  })

  it.each(['individual', 'collective', 'round_robin'] as const)(
    'matches normal %s slots and suppresses irrelevant host failures when a round-robin host is free',
    async (mode) => {
      const s = await team(mode)
      await f.calendarBusy(s.owner.id, [['2026-11-02T09:00Z', '2026-11-02T09:30Z']])
      await f.calendarBusy(s.member.id, [['2026-11-02T09:30Z', '2026-11-02T10:00Z']])
      const slots = await explainEventAvailability(s.ctx, s.query)
      const ordinary = await listPublicTeamSlots(
        { db, now },
        {
          handle: s.ctx.principal.organization.slug,
          slug: s.event.slug,
          start: range.rangeStart,
          end: range.rangeEnd,
        },
      )
      expect(views(slots.filter((slot) => slot.status === 'available'))).toEqual(
        ordinary.map((slot) => ({
          start: instant(slot.start).toString(),
          end: instant(slot.end).toString(),
        })),
      )
      if (mode === 'round_robin') {
        expect(codes(at(slots, '09:00'))).toEqual([])
        expect(codes(at(slots, '08:00'))).toContain('no_eligible_round_robin_host')
      } else if (mode === 'collective') {
        expect(codes(at(slots, '09:00'))).toEqual([
          'calendar_busy',
          'collective_member_unavailable',
        ])
      } else expect(codes(at(slots, '09:00'))).toEqual(['calendar_busy'])
    },
  )

  it('clips blocking intervals and projects only safe fields for managers', async () => {
    const s = await team('collective')
    const busy = await f.calendarBusy(s.owner.id, [['2026-11-02T08:00Z', '2026-11-02T09:10Z']])
    const booking = await f.booking(
      s.team.id,
      [s.member.id],
      '2026-11-02T10:10Z',
      '2026-11-02T10:20Z',
      {
        eventTypeId: s.event.id,
        attendee: { name: 'Secret attendee', email: 'secret@example.com' },
      },
    )
    await db
      .updateTable('bookings')
      .set({
        title: 'Secret title',
        location: JSON.stringify({ kind: 'in_person', address: 'Secret address' }),
      })
      .where('id', '=', booking)
      .execute()
    const verify = async (read: Explain, ctx: ServiceContext, expose: boolean) => {
      const slots = await read(ctx, s.query)
      for (const slot of slots) {
        expect(Object.keys(slot).sort()).toEqual(['end', 'reasons', 'start', 'status'])
        for (const reason of slot.reasons) {
          expect(Object.keys(reason.interval).sort()).toEqual(['end', 'start'])
          expect(Object.keys(reason).sort()).toEqual(
            reason.hostUserId ? ['code', 'hostUserId', 'interval'] : ['code', 'interval'],
          )
          expect(
            Temporal.Instant.compare(reason.interval.start, slot.start),
          ).toBeGreaterThanOrEqual(0)
          expect(Temporal.Instant.compare(reason.interval.end, slot.end)).toBeLessThanOrEqual(0)
          expect(Temporal.Instant.compare(reason.interval.start, reason.interval.end)).toBeLessThan(
            0,
          )
        }
      }
      const blocked = at(slots, '09:00')?.reasons.find((reason) => reason.code === 'calendar_busy')
      expect(blocked?.interval.start.equals(instant('2026-11-02T09:00Z'))).toBe(true)
      expect(blocked?.interval.end.equals(instant('2026-11-02T09:10Z'))).toBe(true)
      expect(blocked?.hostUserId).toBe(expose ? s.owner.id : undefined)
      const serialized = JSON.stringify(slots)
      for (const value of [
        'Secret',
        'secret@example.com',
        booking,
        busy.calendarId,
        ...busy.externalEventIds,
      ])
        expect(serialized).not.toContain(value)
      if (!expose) {
        expect(serialized).not.toContain(s.owner.id)
        expect(serialized).not.toContain(s.member.id)
      }
    }
    await verify(explainEventAvailability, s.ctx, true)
    await expect(
      explainEventAvailability(testContext(db, s.owner.principal, now), s.query),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', s.owner.id)
      .execute()
    await expect(explainEventAvailability(s.ctx, s.query)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', s.owner.id)
      .execute()
    // Removing a required host makes the public collective type invalid, as on normal path.
    await expect(explainEventAvailability(s.ctx, s.query)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
  })

  it('requires full API key scope for owner and admin explanations', async () => {
    const s = await team('collective')
    const principal = s.ctx.principal
    if (principal.kind !== 'api_key') throw new Error('Expected API key fixture')
    for (const role of ['owner', 'admin']) {
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', s.team.id)
        .where('userId', '=', s.owner.id)
        .execute()
      for (const apiKeyScope of ['full', 'read', 'bookings'] as const) {
        const read = explainEventAvailability(
          { ...s.ctx, principal: { ...principal, apiKeyScope } },
          s.query,
        )
        if (apiKeyScope === 'full') expect(JSON.stringify(await read)).toContain(s.owner.id)
        else
          await expect(read).rejects.toMatchObject({
            kind: 'not_found',
            code: 'event_type_not_found',
          })
      }
    }
  })

  it('denies public, other-organization, non-owner and member callers exactly like missing types', async () => {
    const s = await team('collective')
    const p = await personal()
    const missing = await explainEventAvailability(s.ctx, {
      ...s.query,
      eventTypeId: '00000000-0000-4000-8000-000000000000',
    }).catch((error: DomainError) => ({
      kind: error.kind,
      code: error.code,
      message: error.message,
    }))
    for (const [ctx, query] of [
      [{ db, now } as PublicContext as ServiceContext, s.query],
      [testContext(db, s.owner.principal, now), s.query],
      [testContext(db, s.team.as(s.member), now), s.query],
      [
        { ...p.ctx, principal: { ...p.ctx.principal, organization: s.ctx.principal.organization } },
        p.query,
      ],
      [{ ...p.ctx, principal: { ...p.ctx.principal, user: s.ctx.principal.user } }, p.query],
    ] as const) {
      await expect(
        explainEventAvailability(ctx, query).catch((error: DomainError) => ({
          kind: error.kind,
          code: error.code,
          message: error.message,
        })),
      ).resolves.toEqual(missing)
    }
  })

  it('excludes team types placed in a personal organization in the shared permission helper', async () => {
    const s = await personal()
    await db
      .updateTable('event_types')
      .set({ owner_user_id: null })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(assertCanExplainEventType(s.ctx, s.eventTypeId)).rejects.toMatchObject({
      kind: 'not_found',
      code: 'event_type_not_found',
    })
    await expect(explainEventAvailability(s.ctx, s.query)).rejects.toMatchObject({
      kind: 'not_found',
      code: 'event_type_not_found',
    })
  })

  it('keeps a stale round-robin member neutral and matches the normal failure when no fresh slot is offered', async () => {
    const s = await team('round_robin')
    const busy = await f.calendarBusy(s.owner.id, [])
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('id', 'in', (eb) =>
        eb.selectFrom('calendars').select('connection_id').where('id', '=', busy.calendarId),
      )
      .execute()
    const slots = await explainEventAvailability(s.ctx, s.query)
    expect(at(slots, '09:00')?.status).toBe('available')
    expect(
      slots.flatMap((slot) => slot.reasons).some((reason) => reason.hostUserId === s.owner.id),
    ).toBe(false)
    await f.calendarBusy(s.member.id, [['2026-11-02T08:00Z', '2026-11-02T13:00Z']])
    await expect(explainEventAvailability(s.ctx, s.query)).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
    await expect(
      listPublicTeamSlots(
        { db, now },
        {
          handle: s.ctx.principal.organization.slug,
          slug: s.event.slug,
          start: range.rangeStart,
          end: range.rangeEnd,
        },
      ),
    ).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('explains an activated round-robin pool with no remaining eligible hosts', async () => {
    const s = await team('round_robin')
    const manager = await createTestUser(db, 'Non-host owner')
    await db
      .insertInto('auth.member')
      .values({
        userId: manager.id,
        organizationId: s.team.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const managerCtx = testContext(
      db,
      { ...manager.principal, organization: s.ctx.principal.organization },
      now,
    )
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', 'in', [s.owner.id, s.member.id])
      .execute()
    const slots = await explainEventAvailability(managerCtx, s.query)
    await expect(explainEventAvailability(s.ctx, s.query)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => codes(slot)?.includes('no_eligible_round_robin_host'))).toBe(true)
    expect(slots.every((slot) => slot.status === 'unavailable')).toBe(true)
    await db
      .updateTable('event_types')
      .set({ minimum_notice_minutes: 120 })
      .where('id', '=', s.event.id)
      .execute()
    const verifyCombined = async (read: Explain) => {
      const combined = await read(
        { ...managerCtx, now: () => instant('2026-11-03T00:00Z') },
        { ...s.query, durationMinutes: 45 },
      )
      expect(
        combined.every(
          (slot) =>
            codes(slot)?.join() ===
            'past,duration_not_offered,minimum_notice,no_eligible_round_robin_host',
        ),
      ).toBe(true)
    }
    await verifyCombined(explainEventAvailability)
    await expect(
      verifyCombined(
        sourceCopy(["reason.code === 'minimum_notice'", 'false']).explainEventAvailability,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyCombined(explainEventAvailability)
    await expect(
      listPublicTeamSlots(
        { db, now },
        {
          handle: s.ctx.principal.organization.slug,
          slug: s.event.slug,
          start: range.rangeStart,
          end: range.rangeEnd,
        },
      ),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
  })

  it('preserves bidirectional parity over seeded team schedules, overrides, limits, buffers, notices, and DST', async () => {
    let seed = 0x45a09
    const random = (maximum: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % maximum
    }
    const dates = [
      ['America/Los_Angeles', '2026-03-08'],
      ['America/Los_Angeles', '2026-11-01'],
      ['Europe/Berlin', '2026-03-29'],
      ['Europe/Berlin', '2026-10-25'],
      ['UTC', '2026-11-02'],
      ['Pacific/Auckland', '2026-09-27'],
    ] as const
    for (const mode of ['individual', 'collective', 'round_robin'] as const) {
      for (const [timeZone, date] of dates) {
        const s = await team(mode)
        const start = Temporal.PlainDate.from(date).toZonedDateTime(timeZone).toInstant()
        const end = Temporal.PlainDate.from(date)
          .add({ days: 1 })
          .toZonedDateTime(timeZone)
          .toInstant()
        const clock = start.add({ minutes: random(2) === 0 ? -1440 : 75 })
        const durationMinutes = [15, 30, 60][random(3)] as number
        const step = [15, 30, 45][random(3)] as number
        await db
          .updateTable('event_types')
          .set({
            allowed_durations_minutes: [15, 30, 60],
            slot_step_minutes: step,
            buffer_before_minutes: random(3) * 10,
            buffer_after_minutes: random(3) * 10,
            minimum_notice_minutes: random(3) * 30,
            max_bookings_per_day: random(3) === 0 ? 1 : null,
            max_bookings_per_week: random(3) === 0 ? 1 : null,
            max_bookings_per_month: random(3) === 0 ? 1 : null,
            booking_window_days: random(2) === 0 ? 1 : null,
          })
          .where('id', '=', s.event.id)
          .execute()
        for (const host of [s.owner, s.member]) {
          const offset = random(3) * 15
          const interval = { start: `00:${String(offset).padStart(2, '0')}`, end: '05:00' }
          const hostTimeZone =
            host.id === s.owner.id
              ? timeZone
              : (['UTC', 'Asia/Kathmandu', timeZone][random(3)] as string)
          await db
            .updateTable('schedules')
            .set({
              time_zone: hostTimeZone,
              weekly_hours: JSON.stringify({ sunday: [interval], monday: [interval] }),
            })
            .where('user_id', '=', host.id)
            .execute()
          if (random(2) === 0) {
            const schedule = await db
              .selectFrom('schedules')
              .select('id')
              .where('user_id', '=', host.id)
              .executeTakeFirstOrThrow()
            await db
              .insertInto('schedule_overrides')
              .values({
                schedule_id: schedule.id,
                date,
                intervals: JSON.stringify(
                  random(2) === 0 ? [] : [{ start: '01:15', end: '04:30' }],
                ),
              })
              .execute()
          }
          const busyStart = start.add({ minutes: 60 + random(4) * 30 })
          await f.calendarBusy(host.id, [
            [busyStart.toString(), busyStart.add({ minutes: 25 }).toString()],
          ])
          if (random(2) === 0)
            await f.booking(
              s.team.id,
              [host.id],
              start.add({ hours: 12 }).toString(),
              start.add({ hours: 12, minutes: 15 }).toString(),
              { eventTypeId: s.event.id },
            )
        }
        const query = { eventTypeId: s.event.id, rangeStart: start, rangeEnd: end, durationMinutes }
        const explained = await explainEventAvailability({ ...s.ctx, now: () => clock }, query)
        const normal = await listPublicTeamSlots(
          { db, now: () => clock },
          {
            handle: s.ctx.principal.organization.slug,
            slug: s.event.slug,
            start,
            end,
            durationMinutes,
          },
        )
        expect(
          views(explained.filter((slot) => slot.status === 'available')),
          `${mode} ${timeZone} ${date}`,
        ).toEqual(
          normal.map((slot) => ({
            start: instant(slot.start).toString(),
            end: instant(slot.end).toString(),
          })),
        )
        expect(
          explained.every((slot) => (slot.status === 'available') === (slot.reasons.length === 0)),
        ).toBe(true)
      }
    }
  })

  it('checks exact live role tokens and verified membership before disclosing team host IDs', async () => {
    const s = await team('collective')
    const manager = await createTestUser(db, 'Non-host manager')
    await db
      .insertInto('auth.member')
      .values({
        userId: manager.id,
        organizationId: s.team.id,
        role: 'member, admin',
        createdAt: new Date(),
      })
      .execute()
    const ctx = testContext(
      db,
      { ...manager.principal, organization: s.ctx.principal.organization },
      now,
    )
    const read = async () => JSON.stringify(await explainEventAvailability(ctx, s.query))
    expect(await read()).toContain(s.owner.id)
    await db
      .updateTable('auth.member')
      .set({ role: 'administrator' })
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', manager.id)
      .execute()
    await expect(read()).rejects.toMatchObject({ code: 'event_type_not_found' })
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', manager.id)
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', manager.id)
      .execute()
    await expect(read()).rejects.toMatchObject({ code: 'event_type_not_found' })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', manager.id)
      .execute()
    await expect(read()).rejects.toMatchObject({ code: 'event_type_not_found' })
  })

  it('rejects explain ranges beyond the normal service upper bound', async () => {
    const s = await personal()
    await expect(
      explainEventAvailability(s.ctx, {
        ...s.query,
        rangeStart: instant('9999-12-01T00:00Z'),
        rangeEnd: instant('9999-12-02T00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_range' })
    expect(
      await findSlots(db, {
        ...s.query,
        hostUserId: s.host.userId,
        now: now(),
        rangeStart: instant('9999-12-01T00:00Z'),
        rangeEnd: instant('9999-12-02T00:00Z'),
      }),
    ).toEqual([])
  })

  it('bounds candidates when many disjoint working intervals restart a large step', async () => {
    const s = await personal({ durationMinutes: 1, slotStepMinutes: 1440 })
    const clock = (minute: number) =>
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    const intervals = Array.from({ length: 720 }, (_, index) => ({
      start: clock(index * 2),
      end: clock(index * 2 + 1),
    }))
    await db
      .updateTable('schedules')
      .set({
        weekly_hours: JSON.stringify({
          monday: intervals,
          tuesday: intervals,
          wednesday: intervals,
          thursday: intervals,
          friday: intervals,
          saturday: intervals,
          sunday: intervals,
        }),
      })
      .where('user_id', '=', s.host.userId)
      .execute()
    await expect(
      explainEventAvailability(s.ctx, {
        eventTypeId: s.eventTypeId,
        rangeStart: instant('2026-11-02T00:00Z'),
        rangeEnd: instant('2027-01-03T00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'range_too_long' })
  })

  it('detects source-copy mutation leaking extra aggregate interval fields', async () => {
    const s = await team('collective')
    const verify = async (read: Explain) => {
      const result = await read(s.ctx, s.query)
      for (const slot of result)
        for (const reason of slot.reasons)
          expect(Object.keys(reason.interval).sort()).toEqual(['end', 'start'])
    }
    await verify(sourceCopy().explainEventAvailability)
    await expect(
      verify(
        sourceCopy(['interval: { start: slot.start, end: slot.end },', 'interval: slot,'])
          .explainEventAvailability,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(sourceCopy().explainEventAvailability)
  })

  it('keeps the default six-query plan and does not execute diagnostic computation', async () => {
    const s = await personal()
    let count = 0
    const observed = db.withPlugin({
      transformQuery: ({ node }) => {
        count++
        return node
      },
      transformResult: async ({ result }) => result,
    })
    const result = await findSlots(observed, { ...s.query, hostUserId: s.host.userId, now: now() })
    expect(result).toHaveLength(6)
    expect(count).toBe(6)
    const verify = async (read: typeof findSlots) => {
      count = 0
      expect(
        views(await read(observed, { ...s.query, hostUserId: s.host.userId, now: now() })),
      ).toEqual(views(result))
      expect(count).toBe(6)
    }
    await verify(
      sourceCopy(undefined, {
        explainAvailability: () => {
          throw new Error('default path ran explanations')
        },
      }).findSlots,
    )
    await expect(
      verify(
        sourceCopy([
          'return buildAvailabilityInputForMode(db, query, false)',
          "await db.selectFrom('event_types').select('id').limit(1).execute(); return buildAvailabilityInputForMode(db, query, false)",
        ]).findSlots,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each([
    [
      'collective aggregate',
      "code: 'collective_member_unavailable',",
      "code: 'no_eligible_round_robin_host',",
      'collective',
      'collective_member_unavailable',
    ],
    [
      'round-robin aggregate',
      "code: 'no_eligible_round_robin_host',",
      "code: 'collective_member_unavailable',",
      'round_robin',
      'no_eligible_round_robin_host',
    ],
    [
      'booking provenance',
      'blockingBookings.push(booking)',
      'busyIntervals.push(booking)',
      'collective',
      'host_conflict',
    ],
  ] as const)(
    'detects source-copy mutation of %s',
    async (_, before, after, mode, expectedCode) => {
      const s = await team(mode)
      await f.booking(s.team.id, [s.owner.id], '2026-11-02T09:00Z', '2026-11-02T09:30Z', {
        eventTypeId: await f.eventType(s.team.id, null),
      })
      const verify = async (read: Explain) => {
        expect(
          codes(at(await read(s.ctx, s.query), mode === 'round_robin' ? '08:00' : '09:00')),
        ).toContain(expectedCode)
      }
      await verify(sourceCopy().explainEventAvailability)
      await expect(
        verify(sourceCopy([before, after]).explainEventAvailability),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(sourceCopy().explainEventAvailability)
    },
  )

  it('detects source-copy mutation removing manager authorization', async () => {
    const s = await team('collective')
    const ctx = testContext(db, s.team.as(s.member), now)
    const verify = async (read: Explain) => {
      await expect(read(ctx, s.query)).rejects.toMatchObject({ code: 'event_type_not_found' })
    }
    await verify(sourceCopy().explainEventAvailability)
    await expect(
      verify(
        sourceCopy(['await assertCanExplainEventType(ctx, query.eventTypeId)', ''])
          .explainEventAvailability,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(sourceCopy().explainEventAvailability)
  })
})
