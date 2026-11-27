import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  activateRoundRobin,
  createEventType,
  createOneTimeBookingLink,
  createRoutingForm,
  deleteEventType,
  getPublicTeamEventType,
  type PublicEventType,
  publicLocationOptions,
  publishRoutingForm,
  updateEventType,
  updateRoutingForm,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { oneTimeBookingRoutes } from './one-time-bookings.ts'
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
      'smsRemindersEnabled',
      'allowGuests',
      'description',
      'durationMinutes',
      'handle',
      'host',
      'location',
      'locations',
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
  expect(page.locations).toEqual([{ id: 'legacy', kind: 'phone' }])
  expect(page.allowedDurationsMinutes).toEqual(
    allowedDurationsMinutes.length > 1
      ? [...allowedDurationsMinutes].sort((a, b) => a - b)
      : undefined,
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

  const appWith = (
    teamPublicHomeOrganizationIds?: readonly string[],
    routingFormsEnabled = false,
  ) =>
    createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({
          db,
          now,
          routingFormsEnabled,
          teamPublicHomeOrganizationIds,
          rateLimits: { page: plenty, slots: plenty, book: plenty },
        }),
        oneTimeBookingRoutes({ db, now }),
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
      catalogPath: `/api/v1/public/teams/${teamSlug}`,
      page: { handle: teamSlug, slug: event.slug },
      path: `/api/v1/public/teams/${teamSlug}/${event.slug}`,
    }
  }

  it('lists only saved public team events in position order and redacts private link data', async () => {
    const s = await setup('individual')
    const other = await setup('individual')
    const hosts = s.users.map((user) => ({ userId: user.id }))
    const create = (slug: string, options: Omit<Parameters<typeof createEventType>[1], 'slug'>) =>
      createEventType(s.ctx, { ...options, slug, hosts })
    await updateEventType(s.ctx, s.event.id, { position: 20 })
    await create('first', {
      title: 'First saved event',
      durationMinutes: 45,
      description: 'Public',
    })
    const hidden = await create('hidden-link', {
      title: 'Private introduction',
      durationMinutes: 30,
      isHidden: true,
    })
    const { organization, user } = s.ctx.principal
    const privateLink = await createOneTimeBookingLink(
      { ...s.ctx, principal: { kind: 'session', sessionId: randomUUID(), organization, user } },
      {
        eventTypeId: hidden.id,
        prefill: { name: 'Private guest', email: 'private-guest@example.com' },
      },
    )
    await create('inactive', { title: 'Inactive', durationMinutes: 30, isActive: false })
    const deleted = await create('deleted', { title: 'Deleted', durationMinutes: 30 })
    await deleteEventType(s.ctx, deleted.id)
    await createFixtures(db).eventType(s.team.id, s.ctx.principal.user.id, {
      slug: 'personal-owned',
      title: 'Personal event',
    })
    await updateEventType(other.ctx, other.event.id, { title: 'Other team introduction' })

    const privateValues = [
      privateLink.token,
      privateLink.id,
      'private-guest@example.com',
      s.team.id,
      s.event.id,
      ...s.users.flatMap((user) => [user.id, user.email]),
      ...s.members.map((member) => member.id),
    ]
    const app = appWith([s.team.id, other.team.id])
    const response = await app.request(s.catalogPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    for (const value of privateValues) expect(body.includes(value)).toBe(false)
    expect(JSON.parse(body)).toEqual({
      team: { name: 'Research team', slug: s.teamSlug },
      eventTypes: [
        {
          slug: 'first',
          title: 'First saved event',
          description: 'Public',
          durationMinutes: 45,
          location: null,
        },
        {
          slug: 'intro',
          title: 'Research introduction',
          description: null,
          durationMinutes: 30,
          location: { kind: 'phone' },
        },
      ],
    })
    // Listing and link access remain separate; the directory does not change direct URLs.
    expect((await app.request(`${s.catalogPath}/${hidden.slug}`)).status).toBe(200)
    const guessedToken = 'x'.repeat(43)
    for (const slug of ['inactive', 'deleted', 'unknown-event', guessedToken]) {
      for (const suffix of ['', `/slots?${range}`]) {
        const unavailable = await app.request(`${s.catalogPath}/${slug}${suffix}`)
        expect(unavailable.status).toBe(404)
        expect(await unavailable.json()).toEqual({
          error: 'event_type_not_found',
          message: 'No such event type',
        })
      }
    }
    const guessedLink = await app.request(`/api/v1/book/${guessedToken}`)
    expect(guessedLink.status).toBe(404)
    expect(await guessedLink.json()).toEqual({ error: 'one_time_link_not_found' })
    const oneTimePage = await app.request(`/api/v1/book/${privateLink.token}`)
    expect(oneTimePage.status).toBe(200)
    const oneTimeBody = await oneTimePage.text()
    expect(oneTimeBody.includes(privateLink.token)).toBe(false)
    expect(JSON.parse(oneTimeBody)).toMatchObject({
      eventType: { title: hidden.title },
      prefill: { name: 'Private guest', email: 'private-guest@example.com' },
    })

    await updateEventType(s.ctx, s.event.id, { isHidden: true })
    const refreshed = await app.request(s.catalogPath)
    const refreshedBody = await refreshed.text()
    for (const value of privateValues) expect(refreshedBody.includes(value)).toBe(false)
    expect(JSON.parse(refreshedBody)).toHaveProperty('eventTypes', [
      {
        slug: 'first',
        title: 'First saved event',
        description: 'Public',
        durationMinutes: 45,
        location: null,
      },
    ])
  })

  it('omits a hidden target of a published routing form and preserves its direct link', async () => {
    const s = await setup('individual')
    const target = await createEventType(s.ctx, {
      slug: 'private-routing-target',
      title: 'Private routing target',
      durationMinutes: 30,
      hosts: [{ userId: s.ctx.principal.user.id }],
      isHidden: true,
    })
    const { organization, user } = s.ctx.principal
    const session = testContext(
      db,
      { kind: 'session', sessionId: randomUUID(), organization, user },
      now,
    )
    const form = await createRoutingForm(session, {
      slug: 'find-your-event',
      title: 'Find your event',
      fallback: { kind: 'event', eventTypeId: target.id, mappings: [] },
    })
    const { form: published } = await publishRoutingForm(session, form.id, {
      expectedRevision: form.draftRevision,
    })
    await updateRoutingForm(session, form.id, {
      expectedRevision: published.draftRevision,
      enabled: true,
    })

    const app = appWith([s.team.id], true)
    const catalogue = await app.request(s.catalogPath)
    expect(catalogue.status).toBe(200)
    expect(await catalogue.json()).toHaveProperty('eventTypes', [
      {
        slug: s.event.slug,
        title: s.event.title,
        description: s.event.description,
        durationMinutes: s.event.durationMinutes,
        location: { kind: 'phone' },
      },
    ])
    const publicForm = await app.request(
      `/api/v1/public/-/routing/teams/${s.teamSlug}/${form.slug}`,
    )
    expect(publicForm.status).toBe(200)
    expect(await publicForm.json()).toEqual({
      versionId: published.publishedVersionId,
      title: form.title,
      questions: [],
    })
    const direct = await app.request(`${s.catalogPath}/${target.slug}`)
    expect(direct.status).toBe(200)
    expect(await direct.json()).toMatchObject({ slug: target.slug, title: target.title })
  })

  it('moves publication with the organization when its former slug is reassigned', async () => {
    const s = await setup('individual')
    const replacement = await setup('individual')
    const newSlug = `${s.teamSlug}-renamed`
    const app = appWith([s.team.id])
    expect((await app.request(s.catalogPath)).status).toBe(200)

    await db
      .updateTable('auth.organization')
      .set({ slug: newSlug })
      .where('id', '=', s.team.id)
      .execute()
    await db
      .updateTable('auth.organization')
      .set({ slug: s.teamSlug })
      .where('id', '=', replacement.team.id)
      .execute()

    const old = await app.request(s.catalogPath)
    expect(old.status).toBe(404)
    expect(await old.json()).toEqual({
      error: 'team_not_found',
      message: 'No such team booking page',
    })
    const renamed = await app.request(`/api/v1/public/teams/${newSlug}`)
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      team: { name: 'Research team', slug: newSlug },
      eventTypes: [{ slug: s.event.slug }],
    })
    const direct = await app.request(`/api/v1/public/teams/${newSlug}/${s.event.slug}`)
    expect(direct.status).toBe(200)
    expect(await direct.json()).toMatchObject({ team: { slug: newSlug }, slug: s.event.slug })
  })

  it('serves an enabled empty team and answers unavailable pages without team identity', async () => {
    const s = await setup('individual')
    const other = await setup('individual')
    const personal = await createFixtures(db).host()
    await db
      .updateTable('auth.organization')
      .set({ slug: 'Personal-Space' })
      .where('id', '=', personal.organizationId)
      .execute()
    await db
      .updateTable('auth.organization')
      .set({ slug: s.teamSlug.toLowerCase() })
      .where('id', '=', other.team.id)
      .execute()
    await updateEventType(s.ctx, s.event.id, { isHidden: true })

    const app = appWith([s.team.id, personal.organizationId])
    const empty = await app.request(s.catalogPath)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({
      team: { name: 'Research team', slug: s.teamSlug },
      eventTypes: [],
    })
    const disabled = appWith()
    for (const response of [
      await disabled.request(s.catalogPath),
      await app.request(s.catalogPath.toLowerCase()),
      await app.request('/api/v1/public/teams/unknown-team'),
      await app.request('/api/v1/public/teams/Personal-Space'),
      await app.request('/api/v1/public/teams/invalid_slug'),
    ]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: 'team_not_found',
        message: 'No such team booking page',
      })
    }
    expect((await disabled.request(s.path)).status).toBe(200)
  })

  it('lists a Microsoft Teams event with only its location kind', async () => {
    const s = await setup('individual')
    // Inject a synthetic extra field at the storage boundary to exercise the public projection.
    const joinUrl = 'https://teams.microsoft.com/meet/synthetic-directory-test'
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'microsoft_teams', url: joinUrl }) })
      .where('id', '=', s.event.id)
      .execute()

    const response = await appWith([s.team.id]).request(s.catalogPath)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      team: { name: 'Research team', slug: s.teamSlug },
      eventTypes: [
        {
          slug: s.event.slug,
          title: s.event.title,
          description: null,
          durationMinutes: 30,
          location: { kind: 'microsoft_teams' },
        },
      ],
    })
  })

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
    const app = appWith([s.team.id])
    const page = (await (await app.request(s.path)).json()) as PublicEventType
    expect(page.handle).toBe(s.teamSlug)
    expect(page.team?.slug).toBe(s.teamSlug)
    const catalog = await app.request(s.catalogPath)
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({
      team: page.team,
      eventTypes: [
        {
          slug: page.slug,
          title: page.title,
          description: page.description,
          durationMinutes: page.durationMinutes,
          location: page.location,
        },
      ],
    })
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
      const app = appWith([s.team.id])
      const catalog = await app.request(s.catalogPath)
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toHaveProperty('eventTypes', [])
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
  return new Function(
    'eventTypeNotFound',
    'publicLocationOptions',
    `${javascript}; return publicEventType`,
  )(() => {
    throw new Error('Missing synthetic record')
  }, publicLocationOptions) as Projection
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
    locations: [{ id: 'legacy', kind: 'phone', number: '+14155550123' }],
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

  it.each(schedulingTypes)('keeps offered durations in ascending order for a %s event', (type) => {
    verifyProjection(projectionCopy(), type, [60, 30, 15])
  })

  it('detects exposing private location settings in public choices', () => {
    const mutant = projectionCopy([
      'locations: publicLocationOptions(et.locations)',
      'locations: et.locations',
    ])
    expect(() => verifyProjection(mutant, 'individual')).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyProjection(projectionCopy(), 'individual')
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

  it('detects leaving offered durations unsorted', () => {
    const mutant = projectionCopy([
      'allowedDurationsMinutes: [...et.allowedDurationsMinutes].sort((a, b) => a - b)',
      'allowedDurationsMinutes: [...et.allowedDurationsMinutes]',
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
