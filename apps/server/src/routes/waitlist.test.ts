import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createEventType, joinWaitlist, setEventTypeWaitlist } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eventTypeRoutes } from './event-types.ts'
import { publicRoutes } from './public.ts'
import {
  createTestApp,
  openApiDocument,
  productApp,
  responseAndRequestStrictness,
  type TestApp,
} from './test-app.ts'

const bootstrap = process.env.DATABASE_URL
const secret = 'synthetic-waitlist-rest-surface-secret'
const plenty = { limit: 100000, windowSeconds: 60 }

async function copyPublic(before: string, after: string): Promise<typeof publicRoutes> {
  const moduleUrl = new URL('public.ts', import.meta.url)
  let source = readFileSync(moduleUrl, 'utf8')
  expect(source.includes(before), 'mutation must match').toBe(true)
  source = stripTypeScriptTypes(source.replace(before, after))
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  source = source.replace(/\bexport /g, '')
  return new Function(...Object.keys(dependencies), `${source}; return publicRoutes`)(
    ...Object.values(dependencies),
  ) as typeof publicRoutes
}

function publicProjection(before?: string, after?: string) {
  let source = readFileSync(
    new URL('../../../../packages/scheduling/src/availability.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('function publicEventType(')
  const end = source.indexOf('/** One event type as the host', start)
  source = source.slice(start, end)
  if (before) {
    expect(source.includes(before), 'projection mutation must match').toBe(true)
    source = source.replace(before, after ?? '')
  }
  return new Function(
    'eventTypeNotFound',
    `${stripTypeScriptTypes(source)}; return publicEventType`,
  )(() => new Error('Missing event')) as (
    record: Record<string, unknown>,
  ) => Record<string, unknown>
}
function assertPublicProjection(project = publicProjection()) {
  const record = {
    handle: 'host',
    slug: 'intro',
    title: 'Intro',
    description: null,
    durationMinutes: 30,
    allowedDurationsMinutes: [30],
    location: null,
    questions: [],
    allowGuests: false,
    successRedirect: null,
    hostName: 'Host',
    hostTimeZone: 'UTC',
    schedulingType: 'individual',
    hostUserIds: ['host'],
    eligibleHostUserIds: ['host'],
    hosts: [],
    waitlistEnabled: false,
  }
  expect(project(record)).not.toHaveProperty('waitlist')
  expect(project({ ...record, waitlistEnabled: true })).toHaveProperty('waitlist', {
    enabled: true,
  })
  for (const change of [
    { schedulingType: 'collective' },
    { schedulingType: 'round_robin' },
    { hostUserIds: ['a', 'b'] },
    { eligibleHostUserIds: [] },
  ])
    expect(project({ ...record, waitlistEnabled: true, ...change })).not.toHaveProperty('waitlist')
}

describe('public waitlist offer projection', () => {
  it('offers enrollment only for an enabled eligible single-host individual event', () =>
    assertPublicProjection())
  it.each([
    'et.waitlistEnabled &&',
    "et.schedulingType === 'individual' &&",
    'et.hostUserIds.length === 1 &&',
    'et.eligibleHostUserIds.length === 1 &&',
  ])('detects source-copy removal of %s', (anchor) => {
    expect(() => assertPublicProjection(publicProjection(anchor, ''))).toThrowError(/expected/)
  })
})

describe('waitlist OpenAPI', () => {
  it('uses strict additive inputs, open token-free response schemas and authenticated management', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const paths = [
      '/api/v1/event-types/{id}/waitlist',
      '/api/v1/event-types/{id}/waitlist/entries',
      '/api/v1/event-types/{id}/waitlist/entries/{entryId}',
      '/api/v1/public/{handle}/{slug}/waitlist',
      '/api/v1/public/teams/{handle}/{slug}/waitlist',
    ]
    expect(responseAndRequestStrictness(doc, paths)).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    expect(doc.paths[paths[0] as string]?.put?.security).toEqual([{ apiKey: [] }, { session: [] }])
    expect(JSON.stringify(doc.components.schemas.WaitlistEntryPage)).not.toMatch(
      /token|recipientHash|encrypted/i,
    )
    expect(doc.components.schemas.JoinWaitlist).toBeDefined()
  })
})

describe.skipIf(!bootstrap)('waitlist REST surfaces', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(bootstrap as string)
  })
  afterAll(async () => {
    await t?.drop()
  })
  beforeEach(async () => {
    await t.db.deleteFrom('waitlist_verification_requests').execute()
  })

  async function setup(team = false) {
    const user = await createTestUser(t.db)
    const member = await createTestUser(t.db)
    const organization = team
      ? await createTestTeam(t.db, [
          { user, role: 'owner' },
          { user: member, role: 'member' },
        ])
      : undefined
    const principal = organization ? organization.as(user) : user.principal
    const handle = `waitlist-${randomUUID().slice(0, 8)}`
    await t.db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'UTC' })
      .execute()
    const event = await createEventType(testContext(t.db, principal), {
      slug: 'full',
      title: 'Full event',
      durationMinutes: 30,
      waitlist: { enabled: true },
      isHidden: true,
    })
    const slug = principal.organization.slug
    const path = organization
      ? `/api/v1/public/teams/${slug}/full`
      : `/api/v1/public/${handle}/full`
    const start = Temporal.Now.instant().add({ hours: 24 }).toString()
    const end = Temporal.Now.instant().add({ hours: 48 }).toString()
    const input = {
      email: `invitee-${randomUUID()}@example.test`,
      name: 'Invitee',
      preferredWindow: { start, end, timeZone: 'UTC' },
      locale: 'zh-CN',
      consent: true,
    }
    return { user, member, principal, organization, event, path, input, handle }
  }
  const appWith = (factory = publicRoutes, principals = new Map<string, Principal>()) =>
    productApp(t.db, principals, [
      eventTypeRoutes({ db: t.db }),
      factory({
        db: t.db,
        waitlistSecret: secret,
        publicUrl: 'http://localhost:3000',
        rateLimits: { page: plenty, slots: plenty, book: plenty },
      } as Parameters<typeof publicRoutes>[0]),
    ])
  async function post(
    app: ReturnType<typeof productApp>,
    path: string,
    input: unknown,
    authorization?: string,
  ) {
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
      body: JSON.stringify(input),
    })
    return { status: response.status, body: await response.json() }
  }

  async function assertPublic(factory = publicRoutes) {
    const f = await setup()
    const app = appWith(factory)
    const result = await post(app, `${f.path}/waitlist`, f.input)
    expect(result).toEqual({ status: 202, body: { accepted: true } })
    expect(await post(app, `${f.path}/waitlist`, { ...f.input, name: 'Do not overwrite' })).toEqual(
      result,
    )
    const entries = await t.db
      .selectFrom('waitlist_entries')
      .select(['id', 'name', 'status'])
      .where('event_type_id', '=', f.event.id)
      .execute()
    expect(entries).toEqual([
      { id: expect.any(String), name: 'Invitee', status: 'pending_verification' },
    ])
    expect((await app.request(f.path)).status).toBe(200)
    expect(await (await app.request(f.path)).json()).toMatchObject({ waitlist: { enabled: true } })
    expect(
      await post(app, `${f.path}/waitlist`, { ...f.input, trustedIp: '192.0.2.1' }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    await setEventTypeWaitlist(testContext(t.db, f.principal), f.event.id, { enabled: false })
    expect(await (await app.request(f.path)).json()).not.toHaveProperty('waitlist')
    expect(await post(app, `${f.path}/waitlist`, f.input)).toMatchObject({
      status: 409,
      body: { error: 'waitlist_unavailable' },
    })
  }
  it('offers hidden direct pages only while enabled, joins neutrally and cannot overwrite existing entries', async () => {
    await assertPublic()
  })
  it('detects source-copy bypass of the admission service', async () => {
    const copy = await copyPublic(
      'await joinWaitlist(context,',
      'await (async () => ({accepted:true as const}))(context,',
    )
    await expect(assertPublic(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects source-copy disclosure in the neutral accepted response', async () => {
    const copy = await copyPublic(
      'return c.json(result, 202)',
      'return c.json({...result, entryExists: true},202)',
    )
    await expect(assertPublic(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('uses the same join in embeds and team pages without accepting caller IP or source overrides', async () => {
    const f = await setup(true)
    const app = appWith()
    expect(await (await app.request(f.path)).json()).toMatchObject({ waitlist: { enabled: true } })
    expect(await post(app, `${f.path}/waitlist`, f.input)).toEqual({
      status: 202,
      body: { accepted: true },
    })
    expect(await post(app, `${f.path}/waitlist`, { ...f.input, source: 'embed' })).toMatchObject({
      status: 400,
    })
    expect(await post(app, `${f.path}/waitlist/resend`, { email: f.input.email })).toEqual({
      status: 202,
      body: { accepted: true },
    })
  })

  it('rechecks real availability and never queues verification while a normal time is available', async () => {
    const f = await setup()
    await createFixtures(t.db).schedule(f.user.id, { timeZone: 'UTC' })
    let date = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
    while (date.dayOfWeek > 5) date = date.add({ days: 1 })
    const input = {
      ...f.input,
      preferredWindow: {
        start: `${date}T00:00:00Z`,
        end: `${date.add({ days: 1 })}T00:00:00Z`,
        timeZone: 'UTC',
      },
    }
    expect(await post(appWith(), `${f.path}/waitlist`, input)).toMatchObject({
      status: 409,
      body: { error: 'availability_changed' },
    })
    expect(
      await t.db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('event_type_id', '=', f.event.id)
        .execute(),
    ).toEqual([])
  })

  it('keeps durable trusted-IP admission limits and reports only a neutral retry response', async () => {
    const f = await setup()
    const app = appWith()
    for (let i = 0; i < 6; i++) {
      const response = await app.request(
        `${f.path}/waitlist`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
          body: JSON.stringify({ ...f.input, email: `ip-bound-${i}@example.test` }),
        },
        { incoming: { socket: { remoteAddress: '198.51.100.73' } } },
      )
      expect(response.status).toBe(i < 5 ? 202 : 429)
      expect(await response.json()).toEqual(i < 5 ? { accepted: true } : { error: 'rate_limited' })
      if (i === 5) expect(response.headers.get('retry-after')).toMatch(/^\d+$/)
    }
    expect(
      await t.db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('event_type_id', '=', f.event.id)
        .execute(),
    ).toHaveLength(5)
  })

  it.each(['join', 'resend'] as const)(
    'hides listed and unlisted targets in the six-request %s IP-limit probe',
    async (kind) => {
      const sequences: number[][] = []
      for (const listed of [true, false]) {
        const f = await setup()
        if (listed)
          await joinWaitlist(
            {
              db: t.db,
              secret,
              publicUrl: 'http://localhost:3000',
              trustedIp: '192.0.2.81',
            },
            { ...f.input, handle: f.handle, slug: 'full', consent: true },
          )
        const app = appWith()
        const statuses: number[] = []
        for (let index = 0; index < 6; index++) {
          const resend = index === 0 && kind === 'resend'
          const email = index === 0 ? f.input.email : `probe-${randomUUID()}@example.test`
          const response = await app.request(
            `${f.path}/waitlist${resend ? '/resend' : ''}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(resend ? { email } : { ...f.input, email }),
            },
            { incoming: { socket: { remoteAddress: listed ? '198.51.100.81' : '198.51.100.82' } } },
          )
          statuses.push(response.status)
          expect(await response.json()).toEqual(
            index < 5 ? { accepted: true } : { error: 'rate_limited' },
          )
        }
        sequences.push(statuses)
      }
      expect(sequences[0]).toEqual(sequences[1])
      expect(sequences[0]).toEqual([202, 202, 202, 202, 202, 429])
    },
  )

  it('enforces read scopes for manager contact lists, full for settings/removal and bookings for anonymous joins with a supplied bearer', async () => {
    const f = await setup(true)
    const principals = new Map<string, Principal>(
      ['full', 'read', 'bookings'].map((apiKeyScope) => [
        apiKeyScope,
        { ...f.principal, apiKeyScope } as Principal,
      ]),
    )
    const app = appWith(publicRoutes, principals)
    for (const scope of ['full', 'read', 'bookings']) {
      const response = await app.request(`/api/v1/event-types/${f.event.id}/waitlist/entries`, {
        headers: { authorization: `Bearer ${scope}` },
      })
      expect(response.status).toBe(scope === 'bookings' ? 403 : 200)
      const write = await app.request(`/api/v1/event-types/${f.event.id}/waitlist`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${scope}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      expect(write.status).toBe(scope === 'full' ? 200 : 403)
      expect((await post(app, `${f.path}/waitlist`, f.input, scope)).status).toBe(
        scope === 'read' ? 403 : 202,
      )
    }
    if (!f.organization) throw new Error('Expected team fixture')
    const memberApp = appWith(publicRoutes, new Map([['member', f.organization.as(f.member)]]))
    const denied = await memberApp.request(`/api/v1/event-types/${f.event.id}/waitlist/entries`, {
      headers: { authorization: 'Bearer member' },
    })
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain(f.input.email)
  })
})
