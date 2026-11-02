import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  activateRoundRobin,
  createEventType,
  getPublicTeamEventType,
  type PublicEventType,
  updateEventType,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { publicRoutes } from './public.ts'

type SchedulingType = 'individual' | 'collective' | 'round_robin'
const schedulingTypes = ['individual', 'collective', 'round_robin'] as const
const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const range = 'start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z'
const plenty = { limit: 100_000, windowSeconds: 60 }

function verifyPublicKeys(
  page: PublicEventType,
  schedulingType: SchedulingType,
  allowedDurationsMinutes: number[] = [30],
) {
  expect(Object.keys(page).sort()).toEqual(
    [
      'allowGuests',
      'description',
      'durationMinutes',
      'handle',
      'host',
      'location',
      'questions',
      'slug',
      'team',
      'title',
      ...(allowedDurationsMinutes.length > 1 ? ['allowedDurationsMinutes'] : []),
      ...(schedulingType === 'collective' ? ['hosts'] : []),
      ...(schedulingType === 'round_robin' ? ['schedulingType'] : []),
    ].sort(),
  )
  expect(Object.keys(page.host).sort()).toEqual(
    schedulingType === 'round_robin' ? ['name'] : ['name', 'timeZone'],
  )
  expect(Object.keys(page.team ?? {}).sort()).toEqual(['name', 'slug'])
  expect(Object.keys(page.location ?? {})).toEqual(['kind'])
  expect(page.allowedDurationsMinutes).toEqual(
    allowedDurationsMinutes.length > 1 ? allowedDurationsMinutes : undefined,
  )
  if (schedulingType === 'collective') {
    expect(page.hosts).toHaveLength(2)
    for (const host of page.hosts ?? []) {
      expect(Object.keys(host).sort()).toEqual(['name', 'timeZone'])
    }
  }
}

describe.skipIf(!serverUrl)('public team event contract', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  const appWith = () =>
    createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({ db, now, rateLimits: { page: plenty, slots: plenty, book: plenty } }),
      ],
    })

  async function setup(schedulingType: SchedulingType, activate = true) {
    const owner = await createTestUser(db, 'Ada Lovelace')
    const users =
      schedulingType === 'individual' ? [owner] : [owner, await createTestUser(db, 'Grace Hopper')]
    const team = await createTestTeam(
      db,
      users.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
      'Research team',
    )
    const teamSlug = `Research-Team-${randomUUID().slice(0, 8)}`
    await db
      .updateTable('auth.organization')
      .set({ slug: teamSlug })
      .where('id', '=', team.id)
      .execute()
    const f = createFixtures(db)
    for (const user of users) await f.schedule(user.id, { timeZone: 'UTC' })
    const ctx = testContext(db, team.as(owner), now)
    const event = await createEventType(ctx, {
      slug: 'intro',
      title: 'Research introduction',
      durationMinutes: 30,
      schedulingType,
      hosts: users.map((user) => ({ userId: user.id })),
      location: { kind: 'phone', number: '+14155550123' },
    })
    if (schedulingType === 'round_robin' && activate) await activateRoundRobin(ctx, event.id)
    const members = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .execute()
    return {
      ctx,
      event,
      users,
      members,
      team,
      teamSlug,
      page: { handle: teamSlug, slug: event.slug },
      path: `/api/v1/public/teams/${teamSlug}/${event.slug}`,
    }
  }

  it.each(schedulingTypes)('exposes exact public DTO keys for a team %s event', async (type) => {
    const s = await setup(type)
    const servicePage = await getPublicTeamEventType({ db, now }, s.page)
    verifyPublicKeys(servicePage, type)
    const response = await appWith().request(s.path)
    expect(response.status).toBe(200)
    const httpPage = (await response.json()) as PublicEventType
    verifyPublicKeys(httpPage, type)
    expect(httpPage).toEqual(servicePage)
    const serialized = JSON.stringify(httpPage)
    for (const user of s.users) {
      expect(serialized).not.toContain(user.id)
      expect(serialized).not.toContain(user.email)
    }
    for (const member of s.members) expect(serialized).not.toContain(member.id)
    expect(serialized).not.toContain(s.team.id)
    expect(serialized).not.toContain('+14155550123')
  })

  it.each(schedulingTypes)('answers the stored mixed-case team address for %s', async (type) => {
    const s = await setup(type)
    const app = appWith()
    const page = (await (await app.request(s.path)).json()) as PublicEventType
    expect(page.handle).toBe(s.teamSlug)
    expect(page.team?.slug).toBe(s.teamSlug)
    expect(`/team/${page.team?.slug}/${page.slug}`).toBe(`/team/${s.teamSlug}/intro`)
    const slots = await app.request(`${s.path}/slots?${range}`)
    expect(slots.status).toBe(200)
    expect((await slots.json()) as { data: unknown[] }).toHaveProperty('data.0')
    const lower = `/api/v1/public/teams/${s.teamSlug.toLowerCase()}/intro`
    expect((await app.request(lower)).status).toBe(404)
    expect((await app.request(`${lower}/slots?${range}`)).status).toBe(404)
  })

  it.each(['saved', 'activation-disabled', 'inactive', 'no-eligible-hosts'] as const)(
    'does not expose a bookable round-robin page or slots when %s',
    async (mode) => {
      const s = await setup('round_robin', mode !== 'saved')
      if (mode === 'activation-disabled') {
        const hosts = s.users.map((user) => ({ userId: user.id }))
        await updateEventType(s.ctx, s.event.id, { schedulingType: 'collective', hosts })
        await updateEventType(s.ctx, s.event.id, { schedulingType: 'round_robin', hosts })
        expect(
          await db
            .selectFrom('round_robin_state')
            .select('enabled')
            .where('event_type_id', '=', s.event.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ enabled: false })
      }
      if (mode === 'inactive') await updateEventType(s.ctx, s.event.id, { isActive: false })
      if (mode === 'no-eligible-hosts') {
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where(
            'id',
            'in',
            s.users.map((user) => user.id),
          )
          .execute()
      }
      const app = appWith()
      for (const path of [s.path, `${s.path}/slots?${range}`]) {
        const response = await app.request(path)
        expect(response.status).toBe(404)
        expect(await response.json()).toHaveProperty('error', 'event_type_not_found')
      }
    },
  )
})

type Projection = (record: Record<string, unknown>) => PublicEventType
function projectionCopy(replacement?: [string, string]): Projection {
  const original = readFileSync('packages/scheduling/src/availability.ts', 'utf8')
  const start = original.indexOf('function publicEventType(')
  const end = original.indexOf('\n/** One event type', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  let source = original.slice(start, end)
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  const javascript = stripTypeScriptTypes(source)
  return new Function('eventTypeNotFound', `${javascript}; return publicEventType`)(() => {
    throw new Error('Missing synthetic record')
  }) as Projection
}

function verifyProjection(
  copy: Projection,
  type: SchedulingType,
  allowedDurationsMinutes: number[] = [30],
) {
  const page = copy({
    id: 'private-event-id',
    organizationId: 'private-organization-id',
    hostUserId: 'private-user-id',
    hostUserIds: ['private-user-id'],
    handle: 'Research-Team',
    slug: 'intro',
    title: 'Research introduction',
    description: null,
    durationMinutes: 30,
    allowedDurationsMinutes,
    allowGuests: false,
    schedulingType: type,
    hostName: 'Ada Lovelace',
    hostTimeZone: 'UTC',
    location: { kind: 'phone', number: '+14155550123' },
    questions: [],
    hosts: [
      { name: 'Ada Lovelace', timeZone: 'UTC' },
      { name: 'Grace Hopper', timeZone: 'UTC' },
    ],
    team: { name: 'Research team', slug: 'Research-Team' },
  })
  verifyPublicKeys(page, type, allowedDurationsMinutes)
  expect(page.handle).toBe('Research-Team')
  expect(page.team?.slug).toBe('Research-Team')
}

describe('public team DTO source-copy negative controls', () => {
  it.each(schedulingTypes)('verifies the original %s public projection', (type) => {
    verifyProjection(projectionCopy(), type)
  })

  it.each(schedulingTypes)('preserves offered duration order for a %s event', (type) => {
    verifyProjection(projectionCopy(), type, [60, 30, 15])
  })

  it('detects exposing a singleton duration list', () => {
    const mutant = projectionCopy([
      'et.allowedDurationsMinutes.length > 1',
      'et.allowedDurationsMinutes.length > 0',
    ])
    expect(() => verifyProjection(mutant, 'individual')).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects dropping multiple offered durations', () => {
    const mutant = projectionCopy(['et.allowedDurationsMinutes.length > 1', 'false'])
    expect(() => verifyProjection(mutant, 'individual', [60, 30, 15])).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects reordering offered durations', () => {
    const mutant = projectionCopy([
      'allowedDurationsMinutes: [...et.allowedDurationsMinutes]',
      'allowedDurationsMinutes: [...et.allowedDurationsMinutes].sort((a, b) => a - b)',
    ])
    expect(() => verifyProjection(mutant, 'individual', [60, 30, 15])).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each(schedulingTypes)('detects spreading private event state into the %s DTO', (type) => {
    const mutant = projectionCopy(['handle: et.handle,', '...et, handle: et.handle,'])
    expect(() => verifyProjection(mutant, type)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each(schedulingTypes)('detects a private user ID on the %s host', (type) => {
    const mutant = projectionCopy([
      'name: et.hostName,',
      'name: et.hostName, userId: et.hostUserId,',
    ])
    expect(() => verifyProjection(mutant, type)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects private user IDs on collective hosts', () => {
    const mutant = projectionCopy([
      'hosts: et.hosts',
      'hosts: et.hosts.map((host) => ({ ...host, userId: et.hostUserId }))',
    ])
    expect(() => verifyProjection(mutant, 'collective')).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects an internal team identifier', () => {
    const mutant = projectionCopy(['team: et.team', 'team: { ...et.team, id: et.organizationId }'])
    expect(() => verifyProjection(mutant, 'individual')).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects lowercasing the public team address', () => {
    const mutant = projectionCopy(['handle: et.handle,', 'handle: et.handle.toLowerCase(),'])
    expect(() => verifyProjection(mutant, 'individual')).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
