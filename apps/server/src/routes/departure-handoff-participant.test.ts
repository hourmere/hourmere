import '@hono/zod-openapi'
import { randomBytes } from 'node:crypto'
import type { CallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { departureHandoffTokenDigest } from '@hourmere/scheduling/departure-handoff-delivery'
import { departureHandoffStore } from '@hourmere/scheduling/departure-handoff-store'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  handoffTestRecords,
} from '../../../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { mcpEndpoint } from '../mcp/endpoint.ts'
import { productRoutes, productTools } from '../server.ts'

const publicUrl = 'https://handoff-participant.example.test'
const path = '/api/v1/booking-handoffs'
const unavailable = { error: 'handoff_offer_unavailable' }
const unauthenticated: CallerResolver = async () => ({
  ok: false,
  error: 'unauthorized',
  setCookie: [],
})

function appFor(db: Db, { enabled = true, resolveCaller = unauthenticated } = {}) {
  const handoffs = { store: departureHandoffStore, now: () => HANDOFF_NOW }
  const wiring = { db, ...(enabled && { departureHandoffs: handoffs }) }
  return createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    routes: productRoutes({
      ...wiring,
      publicUrl,
      socialProviders: {},
      invitationMailLimits: { secret: 'synthetic-handoff-transport-tests' },
    }),
    mcp: mcpEndpoint({ tools: productTools(wiring) }),
  })
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

function expectPrivate(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
}

describe('participant handoff transport privacy', () => {
  it('hard-disables both operations before reading input', async () => {
    const app = appFor({} as Db, { enabled: false })
    for (const action of ['offer', 'answer']) {
      const res = await app.request(`${path}/${action}`, { method: 'POST' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(unavailable)
      expectPrivate(res)
    }
  })

  it('shares the trusted IP rate limit across both operations and counts invalid requests', async () => {
    const app = appFor({} as Db)
    const ip = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })
    for (let i = 0; i < 30; i++) {
      const res = await app.request(
        path + (i % 2 ? '/offer' : '/answer'),
        post({}, { 'x-forwarded-for': `203.0.113.${i + 1}` }),
        ip('2001:db8::1'),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_request' })
    }
    const res = await app.request(`${path}/answer`, post({}), ip('2001:db8::2'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expectPrivate(res)
    const other = await app.request(`${path}/offer`, post({}), ip('2001:db8:0:1::1'))
    expect(other.status).toBe(400)
  })

  it('keeps supplied capability text out of validation responses, request logs and diagnostics', async () => {
    const sentinel = randomBytes(32).toString('base64url')
    const app = appFor({
      transaction: () => {
        throw new Error(sentinel)
      },
    } as unknown as Db)
    const line = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const invalid = await app.request(`${path}/offer?token=${sentinel}`, post({ [sentinel]: 1 }))
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })
      expectPrivate(invalid)
      const missing = await app.request(`${path}/${sentinel}`, post({}))
      expect(missing.status).toBe(404)
      expectPrivate(missing)
      const validShape = `00000000-0000-4000-8000-000000000001.${sentinel}`
      const failure = await app.request(`${path}/offer`, post({ token: validShape }))
      expect(failure.status).toBe(500)
      expect(await failure.json()).toEqual({ error: 'internal_error' })
      expectPrivate(failure)
      expect(JSON.stringify(line.mock.calls).includes(sentinel)).toBe(false)
      expect(diagnostic).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(diagnostic.mock.calls).includes(sentinel)).toBe(false)
    } finally {
      line.mockRestore()
      diagnostic.mockRestore()
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('handoff recipient over REST and CLI', () => {
  let database: TestDatabase
  let db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'handoff_http',
    })
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })

  it('requires the capability in every transport and binds an explicit answer to what was read', async () => {
    const f = await createHandoffTestFixture(db)
    await handoffTestRecords(db).offer(
      f.ctx,
      f.input,
      { departingUserId: f.departing.id },
      (offer) => ({
        ...offer,
        approvals: [],
      }),
    )
    const guest = await db
      .selectFrom('departure_handoff_recipients')
      .select('id')
      .where('source_booking_id', '=', f.booking.id)
      .where('recipient_key', '=', 'guest@example.test')
      .executeTakeFirstOrThrow()
    const secret = randomBytes(32).toString('base64url')
    const token = `${guest.id}.${secret}`
    await db
      .updateTable('departure_handoff_recipients')
      .set({ token_digest: departureHandoffTokenDigest(guest.id, secret) })
      .where('id', '=', guest.id)
      .execute()

    const key = 'hm_synthetic'
    const readKey = 'hm_synthetic_read'
    const resolveCaller: CallerResolver = async (headers) => {
      const credential = headers.get('authorization')
      if (credential !== `Bearer ${key}` && credential !== `Bearer ${readKey}`)
        return unauthenticated(headers)
      return {
        ok: true,
        principal: {
          kind: 'api_key',
          apiKeyId: f.owner.id,
          apiKeyScope: credential === `Bearer ${readKey}` ? 'read' : 'bookings',
          user: f.ctx.principal.user,
          organization: f.ctx.principal.organization,
        },
        setCookie: [],
      }
    }
    const app = appFor(db, { resolveCaller })
    const unauth = await app.request(
      `${path}/offer`,
      post({ token }, { authorization: 'Bearer invalid' }),
    )
    expect(unauth.status).toBe(401)
    expectPrivate(unauth)

    const noRecipient = await app.request(
      `${path}/offer`,
      post({ token: f.manageToken }, { authorization: `Bearer ${key}` }),
    )
    expect(noRecipient.status).toBe(404)
    expect(await noRecipient.json()).toEqual(unavailable)

    const terms = await app.request(`${path}/offer`, post({ token }))
    expect(terms.status).toBe(200)
    expectPrivate(terms)
    const view = await terms.json()
    expect(view).toMatchObject({ role: 'guest', version: 1, answers: [] })
    const denied = await app.request(
      `${path}/answer`,
      post({ token, decision: 'accept', version: 1 }, { authorization: `Bearer ${readKey}` }),
    )
    expect(denied.status).toBe(403)

    let stdout = ''
    let stderr = ''
    const cli = (command: 'offer' | 'answer', input: unknown, apiKey = key) =>
      runCli({
        argv: ['booking-handoff', command, '--input', '-'],
        env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: apiKey },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (value) => {
          stdout = value
        },
        stderr: (value) => {
          stderr = value
        },
        fetch: async (input, options) => app.request(input, options),
      })
    expect(await cli('offer', { token }, readKey)).toBe(0)
    expect(JSON.parse(stdout)).toEqual(view)
    expect(await cli('answer', { token, version: 2, decision: 'decline' })).toBe(1)
    expect(JSON.parse(stderr)).toMatchObject(unavailable)
    expect(await cli('answer', { token, version: 1, decision: 'decline' })).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ decision: 'decline' })
    expect((stdout + stderr).includes(token)).toBe(false)

    const replay = await app.request(`${path}/offer`, post({ token }))
    expect(replay.status).toBe(404)
    expect(await replay.json()).toEqual(unavailable)
    expectPrivate(replay)
    const booking = await db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', f.booking.id)
      .executeTakeFirstOrThrow()
    expect(booking.status).toBe('confirmed')
  })
})
