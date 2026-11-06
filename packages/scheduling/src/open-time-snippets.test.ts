import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { formatSlotSnippet } from '@hourmere/core/slot-snippet'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listPublicSlots } from './availability.ts'
import { cancelHostBooking, rescheduleHostBooking } from './bookings.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import * as Snippets from './open-time-snippets.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const options = { publicUrl: 'https://hourmere.example.com', slotSnippetsEnabled: true }
const range = { from: '2030-03-04T00:00:00Z', to: '2030-03-05T00:00:00Z' }
async function sourceCopy(replacement: readonly [string, string]): Promise<typeof Snippets> {
  const location = new URL('./open-time-snippets.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(original.includes(replacement[0]), 'mutation must match').toBe(true)
  const source = stripTypeScriptTypes(original.replace(...replacement)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('agent open-time snippets', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'open_snippets' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup() {
    const user = await createTestUser(db)
    const handle = `snippet-${user.id.slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'UTC', locale: 'zh-CN' })
      .execute()
    await fixtures.schedule(user.id, { timeZone: 'UTC' })
    const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id, {
      slug: 'intro',
    })
    const ctx = testContext(db, user.principal, () => Temporal.Instant.from('2030-03-01T00:00:00Z'))
    return { user, handle, eventTypeId, ctx, input: { eventTypeId, ...range } }
  }
  it('matches the admin formatter exactly and returns the earliest real slots by id or slug', async () => {
    const s = await setup()
    const actual = await Snippets.generateOpenTimeSnippet(s.ctx, s.input, options)
    const slots = await listPublicSlots(s.ctx, {
      handle: s.handle,
      slug: 'intro',
      start: Temporal.Instant.from(range.from),
      end: Temporal.Instant.from(range.to),
    })
    expect(actual).toEqual(
      formatSlotSnippet({
        publicUrl: options.publicUrl,
        address: { kind: 'personal', handle: s.handle, slug: 'intro' },
        title: 'Intro call',
        durationMinutes: 30,
        starts: slots.slice(0, 3).map((slot) => slot.start),
        locale: 'zh-CN',
        displayTimeZone: 'UTC',
      }),
    )
    expect(
      await Snippets.generateOpenTimeSnippet(s.ctx, { slug: 'intro', ...range }, options),
    ).toEqual(actual)
    for (const scope of ['read', 'bookings', 'full'] as const) {
      expect(
        await Snippets.generateOpenTimeSnippet(
          {
            ...s.ctx,
            principal: {
              ...s.user.principal,
              kind: 'api_key',
              apiKeyId: 'transport-checked',
              apiKeyScope: scope,
            },
          },
          s.input,
          options,
        ),
      ).toEqual(actual)
    }
  })
  async function verifyFlag(module = Snippets) {
    const s = await setup()
    await expect(
      module.generateOpenTimeSnippet(s.ctx, s.input, { ...options, slotSnippetsEnabled: false }),
    ).rejects.toMatchObject({ code: 'slot_snippets_disabled' })
  }
  it('requires the explicit instance flag', () => verifyFlag())
  async function verifyOwner(module = Snippets) {
    const s = await setup()
    const other = await createTestUser(db)
    await expect(
      module.generateOpenTimeSnippet(
        {
          ...s.ctx,
          principal: { ...other.principal, organization: s.user.principal.organization },
        },
        s.input,
        options,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    await expect(
      module.generateOpenTimeSnippet(testContext(db, other.principal, s.ctx.now), s.input, options),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
  }
  it('rejects other owners and forged organization membership', () => verifyOwner())
  async function verifyTeam(module = Snippets) {
    const s = await setup()
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: s.user, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(team.id, null, { hosts: [{ userId: s.user.id }] })
    const input = { ...range, eventTypeId }
    for (const user of [s.user, admin]) {
      const result = await module.generateOpenTimeSnippet(
        testContext(db, team.as(user), s.ctx.now),
        input,
        options,
      )
      expect(new URL(result.bookingUrl).pathname.startsWith('/team/')).toBe(true)
    }
    await expect(
      module.generateOpenTimeSnippet(testContext(db, team.as(member), s.ctx.now), input, options),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
  }
  it('permits team owners/admins but rejects ordinary members', () => verifyTeam())
  it('rejects unknown roles even alongside admin and ambiguous team slugs', async () => {
    const s = await setup()
    const team = await createTestTeam(db, [{ user: s.user, role: 'admin,unknown' }])
    const eventTypeId = await fixtures.eventType(team.id, null, {
      slug: 'same',
      hosts: [{ userId: s.user.id }],
    })
    const ctx = testContext(db, team.as(s.user), s.ctx.now)
    await expect(
      Snippets.generateOpenTimeSnippet(ctx, { ...range, eventTypeId }, options),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', team.id)
      .execute()
    await fixtures.eventType(team.id, s.user.id, { slug: 'same' })
    await expect(
      Snippets.generateOpenTimeSnippet(ctx, { ...range, slug: 'same' }, options),
    ).rejects.toMatchObject({ code: 'ambiguous_event_type_slug' })
    expect(
      (await Snippets.generateOpenTimeSnippet(ctx, { ...range, eventTypeId }, options)).slots,
    ).toHaveLength(3)
  })
  async function verifyActive(module = Snippets) {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(module.generateOpenTimeSnippet(s.ctx, s.input, options)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
  }
  it('rejects inactive events', () => verifyActive())
  async function verifyRange(module = Snippets) {
    const s = await setup()
    await expect(
      module.generateOpenTimeSnippet(s.ctx, { ...s.input, to: '2030-04-05T00:00:00Z' }, options),
    ).rejects.toMatchObject({ code: 'range_too_long' })
    await expect(
      module.generateOpenTimeSnippet(s.ctx, { ...s.input, count: 0 }, options),
    ).rejects.toMatchObject({ code: 'invalid_count' })
    await expect(
      module.generateOpenTimeSnippet(s.ctx, { ...s.input, count: 11 }, options),
    ).rejects.toMatchObject({ code: 'invalid_count' })
  }
  it('bounds range and selection count', () => verifyRange())
  it('rejects bad selectors, dates, zones, locales and unsupported durations', async () => {
    const s = await setup()
    for (const [change, code] of [
      [{ slug: 'intro' }, 'invalid_event_type_selector'],
      [{ from: '2030-03-04' }, 'invalid_range'],
      [{ to: range.from }, 'invalid_range'],
      [{ displayTimeZone: 'bad zone' }, 'invalid_time_zone'],
      [{ locale: 'invalid' }, 'invalid_locale'],
      [{ durationMinutes: 31 }, 'invalid_duration'],
    ] as const) {
      await expect(
        Snippets.generateOpenTimeSnippet(
          s.ctx,
          { ...s.input, ...change } as Snippets.GenerateOpenTimeSnippetInput,
          options,
        ),
      ).rejects.toMatchObject({ code })
    }
  })
  async function verifyLimits(module = Snippets) {
    for (const field of [
      'max_bookings_per_day',
      'max_bookings_per_week',
      'max_bookings_per_month',
    ] as const) {
      const s = await setup()
      await db
        .updateTable('event_types')
        .set({ [field]: 1 })
        .where('id', '=', s.eventTypeId)
        .execute()
      await fixtures.booking(
        s.user.principal.organization.id,
        [s.user.id],
        '2030-03-04T15:00:00Z',
        '2030-03-04T15:30:00Z',
        { eventTypeId: s.eventTypeId },
      )
      await expect(module.generateOpenTimeSnippet(s.ctx, s.input, options)).rejects.toMatchObject({
        code: 'no_available_slots',
      })
    }
  }
  it('enforces daily, weekly and monthly booking limits', () => verifyLimits())
  it('respects notice, window, buffers and currently taken links without reserving alternatives', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({
        buffer_before_minutes: 30,
        buffer_after_minutes: 30,
        minimum_notice_minutes: 60,
        booking_window_days: 1,
      })
      .where('id', '=', s.eventTypeId)
      .execute()
    const ctx = { ...s.ctx, now: () => Temporal.Instant.from('2030-03-04T08:30:00Z') }
    const first = await Snippets.generateOpenTimeSnippet(ctx, s.input, options)
    expect(first.slots[0]?.start).toBe('2030-03-04T09:30:00.000Z')
    expect(await Snippets.generateOpenTimeSnippet(ctx, s.input, options)).toEqual(first)
    await fixtures.booking(
      s.user.principal.organization.id,
      [s.user.id],
      '2030-03-04T09:30:00Z',
      '2030-03-04T10:00:00Z',
      { eventTypeId: s.eventTypeId },
    )
    const next = await Snippets.generateOpenTimeSnippet(ctx, s.input, options)
    expect(next.slots[0]?.start).toBe('2030-03-04T11:00:00.000Z')
    const link = new URL(first.slots[0]?.url ?? '')
    expect(link.searchParams.get('start')).toBe(first.slots[0]?.start)
    expect(link.searchParams.get('durationMinutes')).toBe('30')
    await expect(
      Snippets.generateOpenTimeSnippet(
        ctx,
        { ...s.input, from: '2030-03-06T00:00:00Z', to: '2030-03-07T00:00:00Z' },
        options,
      ),
    ).rejects.toMatchObject({ code: 'no_available_slots' })
  })
  it('uses the real engine across a DST repeated hour', async () => {
    const s = await setup()
    await db
      .updateTable('schedules')
      .set({
        time_zone: 'America/New_York',
        weekly_hours: JSON.stringify({ sunday: [{ start: '01:00', end: '03:00' }] }),
      })
      .where('user_id', '=', s.user.id)
      .execute()
    const result = await Snippets.generateOpenTimeSnippet(
      s.ctx,
      {
        ...s.input,
        from: '2030-11-03T00:00:00-04:00',
        to: '2030-11-04T00:00:00-05:00',
        count: 10,
        displayTimeZone: 'America/New_York',
        locale: 'en',
      },
      options,
    )
    expect(result.slots.map((slot) => slot.start)).toContain('2030-11-03T05:00:00.000Z')
    expect(result.slots.map((slot) => slot.start)).toContain('2030-11-03T07:00:00.000Z')
    expect(result.text).toContain('UTC-04:00')
    expect(result.text).toContain('UTC-05:00')
  })
  it('supports hidden links and concurrent replay without writing or reserving', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', s.eventTypeId)
      .execute()
    const before = await db.selectFrom('bookings').selectAll().execute()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => Snippets.generateOpenTimeSnippet(s.ctx, s.input, options)),
    )
    for (const result of results) expect(result).toEqual(results[0])
    expect(await db.selectFrom('bookings').selectAll().execute()).toEqual(before)
  })
  it('refreshes offers after reschedule and cancellation', async () => {
    const s = await setup()
    const id = await fixtures.booking(
      s.user.principal.organization.id,
      [s.user.id],
      '2030-03-04T09:00:00Z',
      '2030-03-04T09:30:00Z',
      { eventTypeId: s.eventTypeId },
    )
    const taken = await Snippets.generateOpenTimeSnippet(s.ctx, s.input, options)
    expect(taken.slots[0]?.start).toBe('2030-03-04T09:30:00.000Z')
    const moved = await rescheduleHostBooking(
      s.ctx,
      id,
      { start: Temporal.Instant.from('2030-03-04T10:00:00Z') },
      { source: 'web', apiKeyId: null },
    )
    const afterMove = await Snippets.generateOpenTimeSnippet(
      s.ctx,
      { ...s.input, count: 5 },
      options,
    )
    expect(afterMove.slots[0]?.start).toBe('2030-03-04T09:00:00.000Z')
    expect(afterMove.slots.map((slot) => slot.start)).not.toContain('2030-03-04T10:00:00.000Z')
    await cancelHostBooking(s.ctx, moved.booking.id)
    const afterCancel = await Snippets.generateOpenTimeSnippet(
      s.ctx,
      { ...s.input, count: 5 },
      options,
    )
    expect(afterCancel.slots.map((slot) => slot.start)).toContain('2030-03-04T10:00:00.000Z')
  })
  it('uses collective intersection and only activated round-robin union without advancing fairness', async () => {
    const s = await setup()
    const second = await createTestUser(db)
    await fixtures.schedule(second.id, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '10:00', end: '11:00' }] },
    })
    const team = await createTestTeam(db, [
      { user: s.user, role: 'owner' },
      { user: second, role: 'member' },
    ])
    const ctx = testContext(db, team.as(s.user), s.ctx.now)
    const hosts = [{ userId: s.user.id }, { userId: second.id }]
    const collective = await createEventType(ctx, {
      slug: 'collective',
      title: 'Together',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts,
    })
    const intersection = await Snippets.generateOpenTimeSnippet(
      ctx,
      { ...range, eventTypeId: collective.id },
      options,
    )
    expect(intersection.slots.map((slot) => slot.start)).toEqual([
      '2030-03-04T10:00:00.000Z',
      '2030-03-04T10:30:00.000Z',
    ])
    const round = await createEventType(ctx, {
      slug: 'round',
      title: 'Either host',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts,
    })
    await expect(
      Snippets.generateOpenTimeSnippet(ctx, { ...range, eventTypeId: round.id }, options),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
    await activateRoundRobin(ctx, round.id)
    const state = await db
      .selectFrom('round_robin_state')
      .selectAll()
      .where('event_type_id', '=', round.id)
      .executeTakeFirst()
    const union = await Snippets.generateOpenTimeSnippet(
      ctx,
      { ...range, eventTypeId: round.id },
      options,
    )
    expect(union.slots[0]?.start).toBe('2030-03-04T09:00:00.000Z')
    expect(
      await db
        .selectFrom('round_robin_state')
        .selectAll()
        .where('event_type_id', '=', round.id)
        .executeTakeFirst(),
    ).toEqual(state)
  })
  it('source-copy mutations fail real protection assertions', async () => {
    for (const [replacement, verify] of [
      [['!options.slotSnippetsEnabled', 'false'], verifyFlag],
      [['if (!membership)', 'if (false)'], verifyOwner],
      [["!roles.includes('owner') && !roles.includes('admin')", 'false'], verifyTeam],
      [['MAX_OPEN_TIME_SNIPPET_RANGE_DAYS * 24', '100 * 24'], verifyRange],
      [['count < 1 || count > 10', 'count < 0 || count > 11'], verifyRange],
      [
        [
          `const slots = await (address.kind === 'personal' ? listPublicSlots : listPublicTeamSlots)(
        { ...ctx, db },
        query,
      )`,
          `const slots = [{start: '2030-03-04T09:00:00Z', end: '2030-03-04T09:30:00Z'}]`,
        ],
        verifyLimits,
      ],
    ] as const) {
      const mutant = await sourceCopy(replacement)
      await expect(verify(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    }
  })
})
