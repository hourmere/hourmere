import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import * as calendars from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { routeBodyLimit } from '../body-limit.ts'
import { localeDescription } from '../i18n/locale-description.ts'
import * as openapi from '../openapi.ts'
import * as rateLimits from '../rate-limit.ts'
import * as management from '../team-management.ts'
import * as bookings from './bookings.ts'
import * as publicPage from './public.ts'
import { openApiDocument, resolve } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const range = 'start=2026-11-02T09:00:00Z&end=2026-11-02T12:00:00Z'
const invitee = { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' }
const plenty = { limit: 100_000, windowSeconds: 60 }
type App = ReturnType<typeof createApp>
type Result = { booking: scheduling.Booking; manageToken: string }
type Change = readonly [string, string]

/** Compile a changed copy of the real route module without editing shared source files. */
function routeCopy<T>(file: 'public' | 'bookings', returned: string, change?: Change): T {
  let source = readFileSync(`apps/server/src/routes/${file}.ts`, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replaceAll(...change)
  }
  source = stripTypeScriptTypes(
    source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '').replace(/^export \{[^\n]+\}\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    createRoute,
    z,
    ...calendars,
    ...scheduling,
    ...openapi,
    ...rateLimits,
    ...management,
    ...bookings,
    createMiddleware,
    localeDescription,
    routeBodyLimit,
  }
  // The bookings module declares its own shared schemas; bind only imported values.
  const declarations = new Set(
    [...source.matchAll(/^(?:const|let|function|async function|class)\s+(\w+)/gm)].map(
      (match) => match[1],
    ),
  )
  const imported = Object.entries(bindings).filter(([name]) => !declarations.has(name))
  return new Function(...imported.map(([name]) => name), `${source}; return ${returned}`)(
    ...imported.map(([, value]) => value),
  ) as T
}

const publicCopy = (change?: Change) =>
  routeCopy<typeof publicPage.publicRoutes>('public', 'publicRoutes', change)
const bookingCopy = (change?: Change) =>
  routeCopy<typeof bookings.bookingRoutes>('bookings', 'bookingRoutes', change)

function minutes(booking: { start: string; end: string }) {
  return Temporal.Instant.from(booking.end)
    .since(Temporal.Instant.from(booking.start))
    .total('minutes')
}

const post = (app: App, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { 'x-manage-token': token }) },
    body: JSON.stringify(body),
  })

describe.skipIf(!serverUrl)('REST meeting length selection', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(team = false, allowed = [15, 30, 60]) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, {
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
    })
    const organizationId = team ? await f.organization() : host.organizationId
    if (team) await f.member(host.userId, organizationId, 'owner')
    const id = await f.eventType(organizationId, team ? null : host.userId, {
      slug: 'call',
      durationMinutes: 30,
      hosts: [{ userId: host.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: allowed })
      .where('id', '=', id)
      .execute()
    const organization = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow()
    const principal = {
      kind: 'api_key' as const,
      apiKeyScope: 'full' as const,
      apiKeyId: crypto.randomUUID(),
      user: { id: host.userId, name: 'Host', email: 'host@example.test' },
      organization: { id: organizationId, slug: organization.slug, name: '', personal: !team },
    }
    const appWith = (
      publicFactory = publicPage.publicRoutes,
      bookingFactory = bookings.bookingRoutes,
    ) =>
      createApp({
        publicUrl: 'http://localhost:3000',
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
        routes: [
          publicFactory({ db, now, rateLimits: { page: plenty, slots: plenty, book: plenty } }),
          bookingFactory({ db, now, rateLimits: { manage: plenty, slots: plenty } }),
        ],
      })
    return {
      id,
      appWith,
      path: team
        ? `/api/v1/public/teams/${organization.slug}/call`
        : `/api/v1/public/${host.handle}/call`,
    }
  }

  async function create(s: Awaited<ReturnType<typeof setup>>, app = s.appWith()) {
    const response = await post(app, `${s.path}/bookings`, {
      start: '2026-11-02T09:00:00Z',
      invitee,
      durationMinutes: 15,
      source: 'embed',
    })
    expect(response.status).toBe(201)
    const result = (await response.json()) as Result
    expect(minutes(result.booking)).toBe(15)
    expect(result.booking.source).toBe('embed')
    return result
  }

  async function verifyPublicSlots(factory: typeof publicPage.publicRoutes, team = false) {
    const s = await setup(team)
    const app = s.appWith(factory)
    for (const durationMinutes of [15, 30, 60]) {
      const response = await app.request(
        `${s.path}/slots?${range}&durationMinutes=${durationMinutes}`,
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: scheduling.SlotView[] }
      expect(body.data).toHaveLength(180 / durationMinutes)
      expect(body.data.every((slot) => minutes(slot) === durationMinutes)).toBe(true)
    }
    const omitted = await app.request(`${s.path}/slots?${range}`)
    expect(await omitted.json()).toEqual(
      await (await app.request(`${s.path}/slots?${range}&durationMinutes=30`)).json(),
    )
  }

  it.each([false, true])(
    'offers selected lengths on personal/team public slots (team=%s)',
    async (team) => {
      await verifyPublicSlots(publicPage.publicRoutes, team)
      const s = await setup(team)
      const app = s.appWith()
      expect(await (await app.request(s.path)).json()).toMatchObject({
        durationMinutes: 30,
        allowedDurationsMinutes: [15, 30, 60],
      })
      await create(s, app)
    },
  )

  it('keeps singleton event responses and omitted booking length unchanged', async () => {
    const s = await setup(false, [30])
    const app = s.appWith()
    expect(await (await app.request(s.path)).json()).not.toHaveProperty('allowedDurationsMinutes')
    const response = await post(app, `${s.path}/bookings`, {
      start: '2026-11-02T09:00:00Z',
      invitee,
    })
    expect(response.status).toBe(201)
    expect(minutes(((await response.json()) as Result).booking)).toBe(30)
  })

  it.each([false, true])(
    'rejects unsupported and malformed public selections (team=%s)',
    async (team) => {
      const s = await setup(team)
      const app = s.appWith()
      for (const durationMinutes of [45, 0, 1441, 15.5, 'fifteen', null]) {
        const slots = await app.request(
          `${s.path}/slots?${range}&durationMinutes=${durationMinutes}`,
        )
        expect(slots.status).toBe(400)
        expect(await slots.json()).toMatchObject({
          error: durationMinutes === 45 ? 'invalid_duration' : 'invalid_request',
        })
        const response = await post(app, `${s.path}/bookings`, {
          start: '2026-11-02T09:00:00Z',
          invitee,
          durationMinutes,
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: durationMinutes === 45 ? 'invalid_duration' : 'invalid_request',
        })
      }
      expect(
        await db.selectFrom('bookings').select('id').where('event_type_id', '=', s.id).execute(),
      ).toEqual([])
    },
  )

  async function verifyManageSlots(factory: typeof bookings.bookingRoutes, host = false) {
    const s = await setup()
    const app = s.appWith(undefined, factory)
    const original = await create(s, app)
    const path = host
      ? `/api/v1/bookings/${original.booking.id}/slots`
      : '/api/v1/bookings/manage/slots'
    const headers = { 'x-manage-token': original.manageToken }
    const read = async (selection = '') => {
      const response = await app.request(`${path}?${range}${selection}`, { headers })
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: scheduling.SlotView[] }).data
    }
    expect((await read()).every((slot) => minutes(slot) === 15)).toBe(true)
    const changed = await read('&durationMinutes=60')
    expect(changed).toHaveLength(3)
    expect(changed.every((slot) => minutes(slot) === 60)).toBe(true)
    for (const selection of ['45', '15.5', '0']) {
      const response = await app.request(`${path}?${range}&durationMinutes=${selection}`, {
        headers,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: selection === '45' ? 'invalid_duration' : 'invalid_request',
      })
    }
  }

  async function verifyReschedule(factory: typeof bookings.bookingRoutes, host = false) {
    const s = await setup()
    const app = s.appWith(undefined, factory)
    const original = await create(s, app)
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [30, 60] })
      .where('id', '=', s.id)
      .execute()
    const managed = await app.request('/api/v1/bookings/manage', {
      headers: { 'x-manage-token': original.manageToken },
    })
    expect(await managed.json()).toMatchObject({
      start: original.booking.start,
      end: original.booking.end,
      eventType: { durationMinutes: 60, allowedDurationsMinutes: [30, 60] },
    })
    const path = (booking: Result) =>
      host
        ? `/api/v1/bookings/${booking.booking.id}/reschedule`
        : '/api/v1/bookings/manage/reschedule'
    const kept = await post(
      app,
      path(original),
      { start: '2026-11-02T10:00:00Z' },
      original.manageToken,
    )
    expect(kept.status).toBe(200)
    const preserved = (await kept.json()) as Result
    expect(minutes(preserved.booking)).toBe(15)
    for (const durationMinutes of [15, 45, 15.5]) {
      const refused = await post(
        app,
        path(preserved),
        { start: '2026-11-02T11:00:00Z', durationMinutes },
        host ? original.manageToken : preserved.manageToken,
      )
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({
        error: durationMinutes === 15.5 ? 'invalid_request' : 'invalid_duration',
      })
    }
    const changed = await post(
      app,
      path(preserved),
      { start: '2026-11-02T11:00:00Z', durationMinutes: 60 },
      host ? original.manageToken : preserved.manageToken,
    )
    expect(changed.status).toBe(200)
    expect(minutes(((await changed.json()) as Result).booking)).toBe(60)
  }

  it.each([false, true])(
    'offers original or explicitly selected reschedule slots (host=%s)',
    async (host) => {
      await verifyManageSlots(bookings.bookingRoutes, host)
    },
  )
  it.each([false, true])(
    'preserves the original length or validates a new reschedule length (host=%s)',
    async (host) => {
      await verifyReschedule(bookings.bookingRoutes, host)
    },
  )

  it('documents additive optional duration parameters and leaves operations unchanged', async () => {
    const s = await setup()
    const doc = await openApiDocument(s.appWith())
    for (const path of [
      '/api/v1/public/{handle}/{slug}/slots',
      '/api/v1/public/teams/{handle}/{slug}/slots',
      '/api/v1/bookings/manage/slots',
      '/api/v1/bookings/{id}/slots',
    ]) {
      expect(doc.paths[path]?.get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: 'query', name: 'durationMinutes', required: false }),
        ]),
      )
    }
    for (const name of ['CreateBooking', 'Reschedule']) {
      const schema = resolve(doc, doc.components.schemas[name] as Record<string, unknown>)
      expect(schema.properties).toHaveProperty('durationMinutes')
      expect(schema.required).not.toContain('durationMinutes')
    }
  })

  it('verifies unmodified source copies with the same assertions', async () => {
    await verifyPublicSlots(publicCopy())
    await verifyReschedule(bookingCopy())
    await verifyManageSlots(bookingCopy(), true)
  })

  it('detects dropping public slot selection forwarding', async () => {
    await expect(
      verifyPublicSlots(
        publicCopy([
          'end: Temporal.Instant.from(end),\n            durationMinutes,',
          'end: Temporal.Instant.from(end),',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects dropping public booking selection forwarding', async () => {
    const s = await setup()
    await expect(
      create(s, s.appWith(publicCopy(['durationMinutes: body.durationMinutes,', '']))),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each([false, true])(
    'detects dropping reschedule slot selection forwarding (host=%s)',
    async (host) => {
      await expect(
        verifyManageSlots(
          bookingCopy([
            'end: Temporal.Instant.from(end),\n            durationMinutes,',
            'end: Temporal.Instant.from(end),',
          ]),
          host,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
  it.each([false, true])(
    'detects dropping reschedule selection forwarding (host=%s)',
    async (host) => {
      await expect(
        verifyReschedule(
          bookingCopy(["durationMinutes: c.req.valid('json').durationMinutes,", '']),
          host,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
