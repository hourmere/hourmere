// Real services and an isolated database, including source-copy controls for the adapters.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import * as calendars from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createFixtures, type Fixtures, weekdays } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as rateLimits from '../rate-limit.ts'
import * as bookingSchemas from '../routes/bookings.ts'
import * as publicSchemas from '../routes/public.ts'
import { bookingTools } from './bookings.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

const bootstrap = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
const invitee = { name: 'Duration invitee', email: 'duration@example.test', timeZone: 'UTC' }
type Factory = typeof bookingTools
type Change = readonly [string, string]
type Booked = { booking: { id: string; start: string; end: string }; manageToken: string | null }

/** Compile a changed copy in memory; never modify the implementation being exercised. */
function sourceCopy(change?: Change): Factory {
  let source = readFileSync('apps/server/src/mcp/bookings.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    z,
    ...calendars,
    ...scheduling,
    ...rateLimits,
    ...bookingSchemas,
    ...publicSchemas,
    defineTool,
  }
  return new Function(...Object.keys(bindings), `${source}; return bookingTools`)(
    ...Object.values(bindings),
  ) as Factory
}

describe.skipIf(!bootstrap)('MCP selected meeting lengths', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(factory = bookingTools, team = false) {
    const host = await fixtures.host({ timeZone: 'UTC' })
    await fixtures.schedule(host.userId, {
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '11:00' }),
    })
    const organizationId = team ? await fixtures.organization() : host.organizationId
    if (team) await fixtures.member(host.userId, organizationId, 'owner')
    const eventId = await fixtures.eventType(organizationId, team ? null : host.userId, {
      slug: 'durations',
      durationMinutes: 30,
      hosts: [{ userId: host.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [15, 30, 45, 60] })
      .where('id', '=', eventId)
      .execute()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow()
    const caller: McpCaller = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'full',
      user: { id: host.userId, name: 'Duration host', email: 'host@example.test' },
      organization: { id: organizationId, ...organization, personal: !team },
    }
    const tools = factory({ db, now })
    const page = team
      ? { teamSlug: organization.slug, slug: 'durations' }
      : { handle: host.handle, slug: 'durations' }
    async function call(name: string, args: Record<string, unknown>) {
      const result = await runTool(
        tools.find((tool) => tool.name === name) as Tool,
        args,
        { caller, rateLimit: () => {} },
        () => {
          throw new Error('Unexpected MCP tool failure')
        },
      )
      return result
    }
    return {
      eventId,
      page,
      call,
      slots: { ...page, timeZone: 'UTC', startDate: '2026-11-02', endDate: '2026-11-02' },
      book: { ...page, start: '2026-11-02T09:00:00Z', invitee },
    }
  }

  function ok<T>(result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>): T {
    // Do not serialize booking results or capabilities into assertion diagnostics.
    expect(result.isError).toBeFalsy()
    return result.structuredContent as T
  }
  function error(result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>) {
    expect(result.isError).toBe(true)
    const first = result.content[0]
    if (first?.type !== 'text') throw new Error('Expected MCP error text')
    return JSON.parse(first.text).error as string
  }
  function length(booking: Booked['booking']) {
    return Temporal.Instant.from(booking.end)
      .since(Temporal.Instant.from(booking.start))
      .total('minutes')
  }

  async function verifySlots(factory: Factory, team = false) {
    const s = await setup(factory, team)
    type Found = {
      eventType: { durationMinutes: number; allowedDurationsMinutes: number[] }
      slots: { start: string; end: string }[]
    }
    const defaults = ok<Found>(await s.call('find_available_slots', s.slots))
    expect(defaults.eventType).toMatchObject({
      durationMinutes: 30,
      allowedDurationsMinutes: [15, 30, 45, 60],
    })
    expect(defaults.slots).toHaveLength(4)
    for (const [durationMinutes, count] of [
      [15, 8],
      [60, 2],
    ] as const) {
      const found = ok<Found>(await s.call('find_available_slots', { ...s.slots, durationMinutes }))
      expect(found.slots).toHaveLength(count)
      expect(found.slots.every((slot) => length({ ...slot, id: '' }) === durationMinutes)).toBe(
        true,
      )
    }
  }

  async function verifyBooking(factory: Factory, team = false) {
    const s = await setup(factory, team)
    const result = ok<Booked>(await s.call('create_booking', { ...s.book, durationMinutes: 45 }))
    expect(length(result.booking)).toBe(45)
    expect(error(await s.call('create_booking', { ...s.book, durationMinutes: 20 }))).toBe(
      'invalid_duration',
    )
  }

  async function verifyMove(factory: Factory, hostMove = false) {
    const s = await setup(factory)
    const created = ok<Booked>(await s.call('create_booking', { ...s.book, durationMinutes: 45 }))
    // Removing the old length must not change an existing booking when selection is omitted.
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', s.eventId)
      .execute()
    const authority = (booked: Booked) =>
      hostMove ? { bookingId: booked.booking.id } : { manageToken: booked.manageToken }
    const kept = ok<Booked>(
      await s.call('reschedule_booking', {
        ...authority(created),
        start: '2026-11-02T09:45:00Z',
      }),
    )
    expect(length(kept.booking)).toBe(45)
    expect(
      error(
        await s.call('reschedule_booking', {
          ...authority(kept),
          start: '2026-11-02T09:30:00Z',
          durationMinutes: 20,
        }),
      ),
    ).toBe('invalid_duration')
    const changed = ok<Booked>(
      await s.call('reschedule_booking', {
        ...authority(kept),
        start: '2026-11-02T09:30:00Z',
        durationMinutes: 15,
      }),
    )
    expect(length(changed.booking)).toBe(15)
  }

  it.each([false, true])('uses selected slots for personal/team=%s', async (team) => {
    await verifySlots(bookingTools, team)
  })
  it.each([false, true])('books the selected personal/team=%s duration', async (team) => {
    await verifyBooking(bookingTools, team)
  })
  it.each([false, true])('keeps or changes the duration for host move=%s', async (hostMove) => {
    await verifyMove(bookingTools, hostMove)
  })

  it('rejects unsupported and malformed selections on every tool before booking', async () => {
    const s = await setup()
    expect(error(await s.call('find_available_slots', { ...s.slots, durationMinutes: 20 }))).toBe(
      'invalid_duration',
    )
    const created = ok<Booked>(await s.call('create_booking', s.book))
    for (const durationMinutes of [0, -1, 1.5, 1441, '30', null]) {
      for (const [name, args] of [
        ['find_available_slots', s.slots],
        ['create_booking', s.book],
        ['reschedule_booking', { manageToken: created.manageToken, start: '2026-11-02T10:00:00Z' }],
        ['reschedule_booking', { bookingId: created.booking.id, start: '2026-11-02T10:00:00Z' }],
      ] as const) {
        expect(error(await s.call(name, { ...args, durationMinutes }))).toBe('invalid_request')
      }
    }
  })

  it('exercises an unchanged source copy before its negative controls', async () => {
    const copy = sourceCopy()
    await verifySlots(copy)
    await verifyBooking(copy)
    await verifyMove(copy)
    await verifyMove(copy, true)
  })

  it.each<[string, Change, (factory: Factory) => Promise<void>]>([
    [
      'selected slot forwarding',
      [
        '{ ...pageInput, start, end, durationMinutes: args.durationMinutes }',
        '{ ...pageInput, start, end }',
      ],
      verifySlots,
    ],
    [
      'selected booking forwarding',
      [
        '          durationMinutes: args.durationMinutes,\n          invitee:',
        '          invitee:',
      ],
      verifyBooking,
    ],
    [
      'invitee reschedule forwarding',
      [
        '        args.manageToken,\n        { start: Temporal.Instant.from(args.start), durationMinutes: args.durationMinutes },',
        '        args.manageToken,\n        { start: Temporal.Instant.from(args.start) },',
      ],
      verifyMove,
    ],
    [
      'host reschedule forwarding',
      [
        '          args.bookingId,\n          { start: Temporal.Instant.from(args.start), durationMinutes: args.durationMinutes },',
        '          args.bookingId,\n          { start: Temporal.Instant.from(args.start) },',
      ],
      (factory) => verifyMove(factory, true),
    ],
  ])('detects removal of %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['find_available_slots', 'reschedule_booking'])(
    'detects weakened %s duration input validation',
    async (name) => {
      const prefix =
        name === 'find_available_slots' ? 'const FindSlotsInput' : 'const RescheduleInput'
      const source = readFileSync('apps/server/src/mcp/bookings.ts', 'utf8')
      const start = source.indexOf(prefix)
      const tail = source.slice(start)
      const original = tail.slice(
        0,
        tail.indexOf('SelectedDurationMinutes.optional()') +
          'SelectedDurationMinutes.optional()'.length,
      )
      const factory = sourceCopy([
        original,
        original.replace('SelectedDurationMinutes.optional()', 'z.any().optional()'),
      ])
      const s = await setup(factory)
      const args =
        name === 'find_available_slots'
          ? s.slots
          : {
              manageToken: ok<Booked>(await s.call('create_booking', s.book)).manageToken,
              start: '2026-11-02T10:00:00Z',
            }
      await expect(
        (async () => {
          expect(error(await s.call(name, { ...args, durationMinutes: 1.5 }))).toBe(
            'invalid_request',
          )
        })(),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
