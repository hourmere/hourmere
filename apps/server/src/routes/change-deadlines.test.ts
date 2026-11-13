// Invitee change deadlines over the public manage REST endpoints and MCP with a manage token:
// the same refusal on every invitee path, uniform not-found for unknown links, hosts not
// limited, and the OpenAPI contract.
// Registers .openapi() on zod before the scheduling package builds its schemas.
import '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createPublicBooking, type PublicContext } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingTools } from '../mcp/bookings.ts'
import { type McpCaller, runTool, type Tool } from '../mcp/tools.ts'
import type { RateLimit } from '../rate-limit.ts'
import { bookingRoutes } from './bookings.ts'
import { eventTypeRoutes } from './event-types.ts'
import { openApiDocument, resolve } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:3000'
const START = '2026-11-04T09:00:00Z'
const plenty: RateLimit = { limit: 100_000, windowSeconds: 60 }

describe.skipIf(!serverUrl)('invitee change deadlines over REST and MCP', () => {
  let testDb: TestDatabase
  let db: Db
  const clock = { now: Temporal.Instant.from('2026-11-01T12:00:00Z') }
  const now = () => clock.now
  const principals = new Map<string, Principal>()

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })

  const app = () =>
    createApp({
      publicUrl: PUBLIC_URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => {
        const principal = principals.get(headers.get('authorization')?.replace('Bearer ', '') ?? '')
        return principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [
        bookingRoutes({
          db,
          now,
          rateLimits: { manage: plenty, slots: plenty },
          hostRateLimits: { manage: plenty, slots: plenty },
        }),
        eventTypeRoutes({ db }),
      ],
    })

  async function fixture() {
    clock.now = Temporal.Instant.from('2026-11-01T12:00:00Z')
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      rescheduleCutoffMinutes: 1440,
      cancelCutoffMinutes: 720,
    })
    const pub: PublicContext = { db, now }
    const book = async (start = START) => {
      const created = await createPublicBooking(pub, {
        handle: host.handle,
        slug: 'intro',
        start: Temporal.Instant.from(start),
        invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
      })
      return { id: created.booking.id, token: created.manageToken as string }
    }
    const key = crypto.randomUUID()
    const principal: Principal = {
      kind: 'api_key',
      apiKeyScope: 'full',
      apiKeyId: crypto.randomUUID(),
      user: { id: host.userId, name: '', email: '' },
      organization: { id: host.organizationId, name: '', slug: '', personal: true },
    }
    principals.set(key, principal)
    const tools = bookingTools({ db, now })
    const tool = (name: string, args: Record<string, unknown>) =>
      runTool(
        tools.find((t) => t.name === name) as Tool,
        args,
        { caller: principal as McpCaller, rateLimit: () => {} },
        () => {
          throw Error('Unexpected tool failure')
        },
      )
    return { host, book, key, tool }
  }

  const manage = (path: string, token: string, body?: unknown) =>
    app().request(`/api/v1/bookings/manage${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-manage-token': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const toolError = (result: Awaited<ReturnType<typeof runTool>>) => {
    expect(result.isError).toBe(true)
    const content = result.content[0]
    if (content?.type !== 'text') throw Error('Expected error text')
    return JSON.parse(content.text) as { error: string; message?: string }
  }

  it('shows the deadlines and refuses every invitee path once they pass', async () => {
    const s = await fixture()
    const b = await s.book()
    const shown = await manage('', b.token)
    expect(shown.status).toBe(200)
    expect(((await shown.json()) as { changeDeadlines: unknown }).changeDeadlines).toEqual({
      rescheduleBy: '2026-11-03T09:00:00.000Z',
      cancelBy: '2026-11-03T21:00:00.000Z',
    })

    clock.now = Temporal.Instant.from('2026-11-03T22:00:00Z')
    const slots = await manage(
      '/slots?start=2026-11-04T08:00:00Z&end=2026-11-04T12:00:00Z',
      b.token,
    )
    const move = await manage('/reschedule', b.token, { start: '2026-11-04T10:00:00Z' })
    const cancel = await manage('/cancel', b.token, {})
    const rescheduleBody = {
      error: 'booking_reschedule_deadline_passed',
      message:
        'The deadline for rescheduling this booking online has passed. Contact the host to change it.',
    }
    expect([slots.status, await slots.json()]).toEqual([409, rescheduleBody])
    expect([move.status, await move.json()]).toEqual([409, rescheduleBody])
    expect([cancel.status, await cancel.json()]).toEqual([
      409,
      {
        error: 'booking_cancel_deadline_passed',
        message:
          'The deadline for cancelling this booking online has passed. Contact the host to cancel it.',
      },
    ])
    // MCP with the manage token answers the same codes.
    expect(
      toolError(
        await s.tool('reschedule_booking', {
          manageToken: b.token,
          start: '2026-11-04T10:00:00Z',
        }),
      ).error,
    ).toBe('booking_reschedule_deadline_passed')
    expect(toolError(await s.tool('cancel_booking', { manageToken: b.token })).error).toBe(
      'booking_cancel_deadline_passed',
    )

    // The host is not limited, by MCP or REST.
    const hostMove = await s.tool('reschedule_booking', {
      bookingId: b.id,
      start: '2026-11-04T10:00:00Z',
    })
    expect(hostMove.isError).toBeFalsy()
    const successor = (hostMove.structuredContent as { booking: { id: string } }).booking.id
    const hostCancel = await app().request(`/api/v1/bookings/${successor}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(hostCancel.status).toBe(200)
  })

  it('answers unknown tokens with the same not-found whatever deadlines exist', async () => {
    const s = await fixture()
    await s.book()
    clock.now = Temporal.Instant.from('2026-11-03T22:00:00Z')
    const answers = []
    for (const [path, body] of [
      ['', undefined],
      ['/slots?start=2026-11-04T08:00:00Z&end=2026-11-04T12:00:00Z', undefined],
      ['/reschedule', { start: '2026-11-04T10:00:00Z' }],
      ['/cancel', {}],
    ] as const) {
      const res = await manage(path, 'A'.repeat(43), body)
      answers.push([res.status, await res.json()])
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify(answers[0])]),
    )
    expect(answers[0]?.[0]).toBe(404)
  })

  it('documents the fields additively in OpenAPI', async () => {
    const doc = await openApiDocument(app())
    for (const name of ['EventType', 'EventTypeInput', 'EventTypeUpdate']) {
      const schema = resolve(doc, doc.components.schemas[name] as Record<string, unknown>) as {
        properties: Record<string, Record<string, unknown>>
        required?: string[]
      }
      for (const field of ['rescheduleCutoffMinutes', 'cancelCutoffMinutes']) {
        expect(schema.properties[field], `${name}.${field}`).toMatchObject({
          minimum: 1,
          maximum: 525600,
        })
        // Writes stay optional; only the response always carries the field.
        expect(schema.required?.includes(field) ?? false).toBe(name === 'EventType')
      }
    }
    // ManagedBooking extends Booking (allOf); the deadlines are in its own part.
    const managed = JSON.stringify(doc.components.schemas.ManagedBooking)
    expect(managed).toContain('"changeDeadlines"')
    expect(managed).toContain('"rescheduleBy"')
    expect(managed).toContain('"cancelBy"')
  })
})
