import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../packages/db/src/index.ts'
import { createTestDatabase, type TestDatabase } from '../packages/db/src/testing.ts'
import { createFixtures } from '../packages/scheduling/src/testing.ts'
import { AUDIT_NOW } from '../tools/e2e/audit-data.ts'
import {
  SCREENSHOT_BOOKINGS,
  SCREENSHOT_EVENT_TYPES,
  SCREENSHOT_NOW,
  seedScreenshotData,
} from '../tools/e2e/screenshot-data.ts'

type Seed = typeof seedScreenshotData
function sourceCopy(replacement?: [string, string]): Seed {
  let source = readFileSync('tools/e2e/screenshot-data.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function('AUDIT_NOW', `${source}; return seedScreenshotData`)(AUDIT_NOW) as Seed
}

function fixtureStateMethod(
  auditState: unknown,
  automaticMeet: boolean,
  mutate?: 'guard' | 'cache',
) {
  const source = readFileSync('tools/e2e/fixtures.ts', 'utf8')
  const start = source.indexOf('        screenshotState: async () => {')
  const end = source.indexOf('\n        auditState: async () => {', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let method = source.slice(start, end).replace('        screenshotState:', '')
  if (mutate === 'guard') method = method.replace('if (auditState || automaticMeet)', 'if (false)')
  if (mutate === 'cache') method = method.replace('screenshotState ??=', 'screenshotState =')
  return new Function(
    'auditState',
    'automaticMeet',
    `let screenshotState;
     const db = {}, f = {}, host = {};
     const seedScreenshotData = async () => ({ bookingPath: '/avery/product-discovery' });
     return (${method.trim().replace(/,$/, '')})`,
  )(auditState, automaticMeet) as () => Promise<unknown>
}

function fixtureSessionExpiry(screenshotState: unknown, mutate = false): number {
  let source = readFileSync('tools/e2e/fixtures.ts', 'utf8')
  if (mutate) source = source.replace('uiAudit || screenshotState', 'uiAudit')
  const expression = source.match(/expiresAt: new Date\(\s+(Math\.max[\s\S]*?)\n\s+\),/)
  const value = expression?.[1]
  if (!value) throw new Error('Fixture session expiry expression must exist')
  return new Function(
    'uiAudit',
    'screenshotState',
    'AUDIT_NOW',
    'Date',
    `return ${value.replace(/,\s*$/, '')}`,
  )(false, screenshotState, AUDIT_NOW, {
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    parse: Date.parse,
  }) as number
}

describe('product screenshot fixture isolation', () => {
  it('returns the cached synthetic state for a fresh fixture', async () => {
    const state = fixtureStateMethod(undefined, false)
    expect(await state()).toBe(await state())
  })
  it.each([
    ['audit data', {}, false],
    ['Meet data', undefined, true],
  ] as const)('refuses to replace existing %s', async (_name, auditState, automaticMeet) => {
    await expect(fixtureStateMethod(auditState, automaticMeet)()).rejects.toThrow(
      'Product screenshots require a fresh fixture',
    )
  })
  it('detects removal of the fresh-fixture protection', async () => {
    await expect(
      expect(fixtureStateMethod({}, false, 'guard')()).rejects.toThrow(
        'Product screenshots require a fresh fixture',
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects removal of cached fixture seeding', async () => {
    const state = fixtureStateMethod(undefined, false, 'cache')
    const first = await state()
    const second = await state()
    expect(() => expect(first).toBe(second)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('keeps browser sessions valid at the pinned screenshot clock', () => {
    expect(fixtureSessionExpiry({})).toBe(Date.parse(AUDIT_NOW) + 86_400_000)
  })
  it('detects omission of the screenshot session clock', () => {
    expect(() =>
      expect(fixtureSessionExpiry({}, true)).toBe(Date.parse(AUDIT_NOW) + 86_400_000),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('deterministic product screenshot seed', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'screenshot' })
    db = createDb(owned.pool)
  })
  afterEach(async () => {
    if (!db) return
    await db.deleteFrom('auth.user').execute()
    await db.deleteFrom('auth.organization').execute()
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verify(seed: Seed = seedScreenshotData) {
    const f = createFixtures(db)
    const host = await f.host({ name: 'Fixture Host', handle: 'fixture-host', timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    await f.eventType(host.organizationId, host.userId, { slug: 'call', title: 'Fixture call' })
    const unrelatedTeam = await f.organization('fixture-team')
    const unrelatedType = await f.eventType(unrelatedTeam, null, { slug: 'team-call' })
    const state = await seed(db, f, host)
    expect(state.bookingPath).toBe('/avery/product-discovery')
    const user = await db
      .selectFrom('auth.user')
      .select(['name', 'email', 'image'])
      .where('id', '=', host.userId)
      .executeTakeFirstOrThrow()
    expect(user).toEqual({ name: 'Avery Morgan', email: 'avery@hourmere.invalid', image: null })
    const organization = await db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', host.organizationId)
      .executeTakeFirstOrThrow()
    expect(organization).toEqual({ name: 'Avery Morgan', slug: 'avery' })
    const profile = await db
      .selectFrom('profiles')
      .select(['handle', 'time_zone', 'locale', 'destination_calendar_id'])
      .where('user_id', '=', host.userId)
      .executeTakeFirstOrThrow()
    expect(profile).toEqual({
      handle: 'avery',
      time_zone: 'UTC',
      locale: 'en',
      destination_calendar_id: null,
    })
    const schedule = await db
      .selectFrom('schedules')
      .selectAll()
      .where('id', '=', state.scheduleId)
      .executeTakeFirstOrThrow()
    expect(schedule.name).toBe('Working hours')
    expect(schedule.time_zone).toBe('UTC')
    expect(schedule.created_at).toEqual(new Date(SCREENSHOT_NOW))
    expect(schedule.weekly_hours).toEqual({
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '15:00' }],
    })
    const events = await db
      .selectFrom('event_types')
      .selectAll()
      .where('organization_id', '=', host.organizationId)
      .orderBy('position')
      .orderBy('id')
      .execute()
    expect(events.map((event) => event.slug)).toEqual(SCREENSHOT_EVENT_TYPES.map((e) => e.slug))
    expect(events.map((event) => event.position)).toEqual([10, 20, 30])
    expect(events.map((event) => event.created_at)).toEqual(
      SCREENSHOT_EVENT_TYPES.map(() => new Date(SCREENSHOT_NOW)),
    )
    expect(events.every((event) => event.location === null && event.is_active)).toBe(true)
    expect(events[0]?.id).toBe(state.eventTypeId)
    expect(
      await db
        .selectFrom('event_types')
        .select('id')
        .where('id', '=', unrelatedType)
        .executeTakeFirst(),
    ).toBeDefined()
    const bookings = await db
      .selectFrom('bookings as b')
      .innerJoin('booking_attendees as a', 'a.booking_id', 'b.id')
      .select(['b.title', 'b.start_at', 'b.end_at', 'b.created_at', 'b.source', 'a.email'])
      .where('b.organization_id', '=', host.organizationId)
      .orderBy('b.start_at')
      .execute()
    expect(bookings).toEqual(
      SCREENSHOT_BOOKINGS.map((booking, index) => ({
        title: `${SCREENSHOT_EVENT_TYPES[index]?.title} with ${booking.attendee.name}`,
        start_at: new Date(booking.start),
        end_at: new Date(booking.end),
        created_at: new Date(SCREENSHOT_NOW),
        source: 'web',
        email: booking.attendee.email,
      })),
    )
    expect(await db.selectFrom('calendar_connections').select('id').execute()).toEqual([])
    expect(await db.selectFrom('conference_connections').select('id').execute()).toEqual([])
  }

  it('seeds English synthetic content with stable ordering, clock, zone, and no integrations', () =>
    verify())
  it('verifies the unmutated source copy against real stored rows', () => verify(sourceCopy()))
  it.each<[string, [string, string]]>([
    ['host name', ['name: SCREENSHOT_HOST, email:', "name: 'Fixture Host', email:"]],
    ['host email', ['email: SCREENSHOT_HOST_EMAIL', "email: 'fixture@example.com'"]],
    [
      'organization identity',
      ['name: SCREENSHOT_HOST, slug:', "name: 'Fixture organization', slug:"],
    ],
    [
      'public handle',
      ['handle: SCREENSHOT_HANDLE, time_zone:', "handle: 'fixture-host', time_zone:"],
    ],
    [
      'fixed time zone',
      [
        "export const SCREENSHOT_TIME_ZONE = 'UTC'",
        "export const SCREENSHOT_TIME_ZONE = 'America/New_York'",
      ],
    ],
    ['schedule title', ["name: 'Working hours'", "name: 'Fixture schedule'"]],
    [
      'stable timestamps',
      ['created_at: SCREENSHOT_NOW,', "created_at: '2029-01-01T00:00:00.000Z',"],
    ],
    [
      'event timestamps',
      [
        'position: (index + 1) * 10, created_at: SCREENSHOT_NOW',
        "position: (index + 1) * 10, created_at: '2029-01-01T00:00:00.000Z'",
      ],
    ],
    [
      'booking timestamps',
      [
        "source: 'web',\n        created_at: SCREENSHOT_NOW,",
        "source: 'web',\n        created_at: '2029-01-01T00:00:00.000Z',",
      ],
    ],
    ['event list order', ['position: (index + 1) * 10', 'position: 0']],
    [
      'generic fixture replacement',
      [
        `  await db
    .deleteFrom('event_types')
    .where('organization_id', '=', host.organizationId)
    .where('owner_user_id', '=', host.userId)
    .execute()`,
        '  void db',
      ],
    ],
    [
      'unrelated team preservation',
      [
        `.deleteFrom('event_types')
    .where('organization_id', '=', host.organizationId)
    .where('owner_user_id', '=', host.userId)`,
        ".deleteFrom('event_types')",
      ],
    ],
    [
      'booking title',
      [`title: \`\${event.title} with \${booking.attendee.name}\``, "title: 'Fixture booking'"],
    ],
    ['booking source', ["source: 'web'", "source: 'api'"]],
  ])('detects removal of %s determinism', async (_name, replacement) => {
    await expect(verify(sourceCopy(replacement))).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
