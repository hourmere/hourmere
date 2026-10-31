import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createEventType,
  createSchedule,
  putProfile,
  type SuccessRedirectInput,
  type SuccessRedirectPolicy,
  updateEventType,
} from '@hourmere/scheduling'
import { createTestTeam, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { openApiDocument } from '../openapi-document.ts'
import { productRoutes } from '../server.ts'
import { bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
const input = {
  start: '2026-11-02T09:00:00Z',
  invitee: { name: 'Invitee & Co', email: 'invitee@example.test', timeZone: 'UTC' },
}
interface Reply {
  booking: Record<string, unknown>
  manageToken: string
  successRedirect?: { url: string; allowEmbedParent: boolean }
}

describe.skipIf(!serverUrl)('booking continuation HTTP contract', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  afterEach(() => vi.restoreAllMocks())

  async function setup(
    teamPage = false,
    successRedirect: SuccessRedirectInput | null = null,
    policy?: SuccessRedirectPolicy,
  ) {
    const user = await createTestUser(db, 'Host & Co')
    const personal = testContext(db, user.principal, now)
    const handle = `redirect-${randomUUID().slice(0, 8)}`
    await putProfile(personal, { handle, timeZone: 'UTC', locale: 'en' })
    await createSchedule(personal, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
    })
    const team = teamPage ? await createTestTeam(db, [{ user, role: 'owner' }]) : undefined
    const ctx = {
      ...(team ? testContext(db, team.as(user), now) : personal),
      successRedirectPolicy: policy,
    }
    const event = await createEventType(ctx, {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
      successRedirect,
    })
    const path = teamPage
      ? `/api/v1/public/teams/${ctx.principal.organization.slug}/call`
      : `/api/v1/public/${handle}/call`
    const app = createApp({
      publicUrl: 'https://hourmere.example.test',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [publicRoutes({ db, now }), bookingRoutes({ db, now })],
    })
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    return { app, post, ctx, event, path }
  }

  it.each([false, true])(
    'uses only saved configuration and freezes successful replay (team=%s)',
    async (team) => {
      const s = await setup(team, {
        url: 'https://host.example.test/done?campaign=one&campaign=two#thanks',
        parameters: ['eventTypeSlug', 'hostName'],
      })
      const headers = { 'idempotency-key': randomUUID() }
      const url = `${s.path}/bookings?redirect=https%3A%2F%2Fevil.example.test&allowEmbedParent=true`
      const first = await s.post(url, { ...input, source: 'embed' }, headers)
      expect(first.status).toBe(201)
      expect(first.headers.get('location')).toBeNull()
      const body = (await first.json()) as Reply
      expect(body.successRedirect).toEqual({
        url: 'https://host.example.test/done?campaign=one&campaign=two&eventTypeSlug=call&hostName=Host+%26+Co#thanks',
        allowEmbedParent: false,
      })
      expect(body.booking).not.toHaveProperty('successRedirect')
      expect(await (await s.app.request(s.path)).json()).not.toHaveProperty('successRedirect')
      await updateEventType(s.ctx, s.event.id, {
        successRedirect: { url: 'https://other.example.test/', allowEmbedParent: true },
      })
      const replay = await s.post(url, { ...input, source: 'embed' }, headers)
      expect(replay.status).toBe(200)
      const replayBody = (await replay.json()) as Reply
      expect(replayBody.successRedirect).toEqual(body.successRedirect)
      expect((replayBody.manageToken as string | null) === null).toBe(true)
      const managed = await s.app.request('/api/v1/bookings/manage', {
        headers: { 'x-manage-token': body.manageToken },
      })
      expect(managed.status).toBe(200)
      expect(await managed.json()).not.toHaveProperty('successRedirect')
      const moved = await s.post(
        '/api/v1/bookings/manage/reschedule',
        { start: '2026-11-02T10:00:00Z' },
        { 'x-manage-token': body.manageToken },
      )
      expect(moved.status).toBe(200)
      const movedBody = (await moved.json()) as Reply
      expect(movedBody).not.toHaveProperty('successRedirect')
      expect(movedBody.booking).not.toHaveProperty('successRedirect')
      const cancelled = await s.post(
        '/api/v1/bookings/manage/cancel',
        {},
        { 'x-manage-token': movedBody.manageToken },
      )
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).not.toHaveProperty('successRedirect')
    },
  )

  it.each(['redirect', 'redirectUrl', 'successRedirect', 'allowEmbedParent'])(
    'rejects a body-supplied %s',
    async (field) => {
      const s = await setup()
      const response = await s.post(`${s.path}/bookings`, {
        ...input,
        [field]: 'https://evil.example.test/',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_request' })
      expect(
        (
          await owned.pool.query('SELECT count(*)::int AS n FROM bookings WHERE event_type_id=$1', [
            s.event.id,
          ])
        ).rows,
      ).toEqual([{ n: 0 }])
    },
  )

  it('keeps unset confirmation unchanged despite a query target, and refuses an unsuccessful booking', async () => {
    const s = await setup()
    const response = await s.post(`${s.path}/bookings?redirectUrl=https://evil.example.test`, input)
    expect(response.status).toBe(201)
    expect(Object.keys((await response.json()) as Reply).sort()).toEqual(['booking', 'manageToken'])
    await updateEventType(s.ctx, s.event.id, {
      successRedirect: { url: 'https://host.example.test/' },
    })
    const failed = await s.post(`${s.path}/bookings`, { ...input, start: '2026-11-02T03:00:00Z' })
    expect(failed.status).toBe(409)
    expect(await failed.json()).not.toHaveProperty('successRedirect')
  })

  it('passes the production instance hostname and explicit IP exception to public booking validation', async () => {
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(now)
    for (const [url, publicUrl, allowIpHosts] of [
      ['https://127.0.0.1/thanks', 'https://127.0.0.1', false],
      ['https://192.0.2.1/thanks', 'https://hourmere.example.test', true],
    ] as const) {
      const s = await setup(false, { url }, { publicUrl, allowIpHosts })
      const app = createApp({
        publicUrl,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        routes: productRoutes({
          db,
          publicUrl,
          successRedirectAllowIpHosts: allowIpHosts,
          socialProviders: {},
          invitationMailLimits: { secret: 'redirect-route-fixture' },
        }),
      })
      const response = await app.request(`${s.path}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      expect(response.status).toBe(201)
      expect(((await response.json()) as Reply).successRedirect?.url).toBe(url)
    }
  })
})

it('documents continuation only in successful public creation responses', async () => {
  const doc = (await openApiDocument()) as {
    components: {
      schemas: Record<
        string,
        { properties?: Record<string, unknown>; allOf?: { properties?: Record<string, unknown> }[] }
      >
    }
    paths: Record<
      string,
      Record<
        string,
        {
          responses: Record<
            string,
            { content: { 'application/json': { schema: { $ref: string } } } }
          >
        }
      >
    >
  }
  expect(doc.components.schemas.PublicBookingResult?.allOf?.[1]?.properties).toHaveProperty(
    'successRedirect',
  )
  expect(doc.components.schemas.BookingWithToken?.properties).not.toHaveProperty('successRedirect')
  expect(doc.components.schemas.CreateBooking?.properties).not.toHaveProperty('successRedirect')
  for (const path of [
    '/api/v1/public/{handle}/{slug}/bookings',
    '/api/v1/public/teams/{handle}/{slug}/bookings',
  ])
    for (const status of ['200', '201'])
      expect(
        doc.paths[path]?.post?.responses[status]?.content['application/json'].schema.$ref,
      ).toBe('#/components/schemas/PublicBookingResult')
})
