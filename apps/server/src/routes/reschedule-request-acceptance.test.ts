// REST and the real MCP HTTP transport share one throwaway Postgres database per file.
// Authentication and the email token handoff are fixtures; booking services are real.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingEvent } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingTools } from '../mcp/bookings.ts'
import { mcpEndpoint } from '../mcp/endpoint.ts'
import { bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:3000'
const START = '2026-11-06T09:00:00Z'
const TARGET = '2026-11-06T10:00:00Z'
const plenty = { limit: 100_000, windowSeconds: 60 }
type Channel = 'REST' | 'MCP'
type Booking = {
  id: string
  status: string
  start: string
  pendingReschedule?: { id: string; expiresAt: string }
}
type Created = { booking: Booking; manageToken: string | null }
type ToolResult = {
  isError?: boolean
  content: { type: string; text?: string }[]
  structuredContent?: unknown
}

describe.skipIf(!serverUrl)('host reschedule request acceptance through REST and MCP', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  async function fixture(cutoff = false) {
    let current = Temporal.Instant.from('2026-11-01T12:00:00Z')
    const now = () => current
    const f = createFixtures(db)
    const host = await f.host()
    const stranger = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      ...(cutoff ? { rescheduleCutoffMinutes: 120, cancelCutoffMinutes: 1440 } : {}),
    })
    const principals = new Map<string, Principal>()
    for (const [key, user] of [
      ['host', host],
      ['stranger', stranger],
    ] as const) {
      principals.set(key, {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: randomUUID(),
        user: { id: user.userId, name: key, email: `${key}@example.com` },
        organization: { id: user.organizationId, name: key, slug: key, personal: true },
      })
    }
    const events: BookingEvent[] = []
    const deps = {
      db,
      now,
      notify: async (_trx: Db, event: BookingEvent) => {
        events.push(event)
      },
      rateLimits: { page: plenty, slots: plenty, book: plenty, manage: plenty },
    }
    const app = createApp({
      publicUrl: PUBLIC_URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => {
        const principal = principals.get(headers.get('authorization')?.replace('Bearer ', '') ?? '')
        return principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [publicRoutes(deps), bookingRoutes(deps)],
      mcp: mcpEndpoint({ tools: bookingTools(deps) }),
    })
    const booked = await app.request(`/api/v1/public/${host.handle}/intro/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        start: START,
        invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'Europe/Berlin' },
      }),
    })
    expect(booked.status).toBe(201)
    const created = (await booked.json()) as Created
    async function tool(name: string, args: Record<string, unknown>, key = 'host') {
      const client = new Client({ name: 'acceptance', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
            fetch: async (input, init) => app.request(input, init),
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        )
        const result = (await client.callTool({ name, arguments: args })) as ToolResult
        return {
          error: result.isError
            ? (JSON.parse(result.content[0]?.text ?? '{}').error as string)
            : undefined,
          body: result.structuredContent,
        }
      } finally {
        await client.close()
      }
    }
    async function request(channel: Channel, key = 'host') {
      const input = { idempotencyKey: randomUUID(), note: 'Please choose another time.' }
      if (channel === 'MCP')
        return tool('request_reschedule', { bookingId: created.booking.id, ...input }, key)
      const response = await app.request(
        `/api/v1/bookings/${created.booking.id}/request-reschedule`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      )
      const body = (await response.json()) as Booking & { error?: string }
      expect(response.status).toBe(
        body.error ? (body.error === 'booking_not_found' ? 404 : 409) : 200,
      )
      return { body, error: body.error }
    }
    // This is the notification sender's persisted token handoff, without sending SMTP.
    async function emailToken(requestId: string) {
      const token = randomBytes(32).toString('base64url')
      const attendee = await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', created.booking.id)
        .where('is_booker', '=', true)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('booking_notifications')
        .values({
          booking_id: created.booking.id,
          kind: 'reschedule_requested',
          message_key: requestId,
          recipient: `attendee:${attendee.id}`,
          manage_token_hash: createHash('sha256').update(token).digest(),
        })
        .execute()
      return token
    }
    const open = (token: string, suffix = '') =>
      app.request(`/api/v1/bookings/manage${suffix}`, {
        headers: { 'x-manage-token': token },
      })
    async function pick(channel: Channel, token: string, requestId: string, start = TARGET) {
      const input = { start, rescheduleRequestId: requestId }
      if (channel === 'MCP') return tool('reschedule_booking', { manageToken: token, ...input })
      const response = await app.request('/api/v1/bookings/manage/reschedule', {
        method: 'POST',
        headers: { 'x-manage-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = (await response.json()) as Created & { error?: string }
      expect(response.status).toBe(body.error ? 409 : 200)
      return { body, error: body.error }
    }
    return {
      request,
      emailToken,
      open,
      pick,
      created,
      events,
      host,
      advance: (at: string) => {
        current = Temporal.Instant.from(at)
      },
    }
  }

  for (const channel of ['REST', 'MCP'] as const) {
    it(`${channel}: requests, opens, selects an offered time and replays exactly one move`, async () => {
      const s = await fixture()
      expect((await s.request(channel, 'stranger')).error).toBe('booking_not_found')
      const asked = await s.request(channel)
      expect(asked.error).toBeUndefined()
      const pending = (asked.body as Booking).pendingReschedule
      expect(pending).toBeDefined()
      const id = pending?.id as string
      const token = await s.emailToken(id)
      const opened = await s.open(token)
      expect(opened.status).toBe(200)
      expect(await opened.json()).toMatchObject({
        id: s.created.booking.id,
        status: 'confirmed',
        pendingReschedule: { id },
        rescheduleRequest: { id, state: 'pending' },
      })
      const slots = await s.open(
        token,
        `/slots?${new URLSearchParams({ start: TARGET, end: '2026-11-06T11:00:00Z' })}`,
      )
      expect(slots.status).toBe(200)
      expect(await slots.json()).toMatchObject({
        data: expect.arrayContaining([
          { start: '2026-11-06T10:00:00.000Z', end: '2026-11-06T10:30:00.000Z' },
        ]),
      })
      const picked = await s.pick(channel, token, id)
      expect(picked.error).toBeUndefined()
      const moved = picked.body as Created
      expect(moved.booking).toMatchObject({
        status: 'confirmed',
        start: '2026-11-06T10:00:00.000Z',
      })
      expect(moved.booking.id).not.toBe(s.created.booking.id)
      const replay = await s.pick(channel, token, id)
      expect(replay.error).toBeUndefined()
      expect(replay.body).toMatchObject({ booking: moved.booking, manageToken: null })
      expect((await s.pick(channel, token, id, '2026-11-06T11:00:00Z')).error).toBe(
        'reschedule_request_changed',
      )
      expect(await (await s.open(token)).json()).toMatchObject({
        id: moved.booking.id,
        rescheduleRequest: { id, state: 'rescheduled' },
      })
      expect(
        await db
          .selectFrom('bookings')
          .select(['id', 'status'])
          .where('organization_id', '=', s.host.organizationId)
          .orderBy('start_at')
          .execute(),
      ).toEqual([
        { id: s.created.booking.id, status: 'cancelled' },
        { id: moved.booking.id, status: 'confirmed' },
      ])
      expect(
        await db
          .selectFrom('booking_reschedule_requests')
          .select(['state', 'picked_booking_id'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'picked', picked_booking_id: moved.booking.id })
      expect(s.events.filter((event) => event.type === 'rescheduled')).toHaveLength(1)
    })

    it(`${channel}: expires at 48 hours without moving the original booking`, async () => {
      const s = await fixture()
      const asked = await s.request(channel)
      expect(asked.error).toBeUndefined()
      const pending = (asked.body as Booking).pendingReschedule
      expect(pending?.expiresAt).toBe('2026-11-03T12:00:00.000Z')
      const id = pending?.id as string
      const token = await s.emailToken(id)
      s.advance('2026-11-03T12:00:00Z')
      expect(await (await s.open(token)).json()).toMatchObject({
        id: s.created.booking.id,
        status: 'confirmed',
        rescheduleRequest: { id, state: 'expired' },
      })
      expect((await s.pick(channel, token, id)).error).toBe('reschedule_request_changed')
      expect(
        await db
          .selectFrom('bookings')
          .select(['id', 'status'])
          .where('organization_id', '=', s.host.organizationId)
          .execute(),
      ).toEqual([{ id: s.created.booking.id, status: 'confirmed' }])
      expect(s.events.filter((event) => event.type === 'rescheduled')).toHaveLength(0)
    })

    it(`${channel}: caps the request at the earlier cancel deadline and refuses new requests there`, async () => {
      const s = await fixture(true)
      s.advance('2026-11-04T12:00:00Z')
      const asked = await s.request(channel)
      expect(asked.error).toBeUndefined()
      const pending = (asked.body as Booking).pendingReschedule
      expect(pending?.expiresAt).toBe('2026-11-05T09:00:00.000Z')
      const id = pending?.id as string
      const token = await s.emailToken(id)
      s.advance('2026-11-05T09:00:00Z')
      expect((await s.request(channel)).error).toBe('booking_reschedule_deadline_passed')
      expect((await s.pick(channel, token, id)).error).toBe('reschedule_request_changed')
      expect(
        await db
          .selectFrom('booking_reschedule_requests')
          .select('id')
          .where('booking_id', '=', s.created.booking.id)
          .execute(),
      ).toEqual([{ id }])
    })
  }
})
