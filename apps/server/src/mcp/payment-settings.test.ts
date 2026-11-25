import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import type { PaymentProviderAvailability } from '@hourmere/core/payment'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType, type EventType, type EventTypeInput } from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { instanceRoutes } from '../routes/instance.ts'
import { catalogTools } from './catalog.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'
import { type McpCaller, runTool } from './tools.ts'

const origin = 'https://hourmere.example.test'
const credentials = { authorization: 'Bearer hm_synthetic', 'content-type': 'application/json' }
const eventInput = () => ({
  slug: `paid-${randomUUID()}`,
  title: 'Paid consultation',
  durationMinutes: 30,
})
const payment = { currency: 'usd', prices: [{ durationMinutes: 30, amountMinor: 5000 }] } as const

describe.skipIf(!process.env.DATABASE_URL)(
  'event payment settings across REST, MCP and CLI',
  () => {
    let testDb: TestDatabase
    let db: Db
    beforeAll(async () => {
      testDb = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(testDb.pool)
    })
    afterAll(async () => testDb?.drop())

    function clients(caller: McpCaller, paidBookingAvailability: PaymentProviderAvailability) {
      const deps = { db, paidBookingAvailability }
      const tools = [...eventTypeTools(deps), ...catalogTools(deps)]
      const app = createApp({
        publicUrl: origin,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
        routes: [
          eventTypeRoutes(deps),
          instanceRoutes({
            publicUrl: origin,
            socialProviders: {},
            eventTypePaymentAvailability: paidBookingAvailability,
          }),
        ],
        mcp: mcpEndpoint({ tools }),
      })
      return {
        instance: () => app.request('/api/v1/instance'),
        rest(method: string, id?: string, input?: unknown) {
          return app.request(`/api/v1/event-types${id ? `/${id}` : ''}`, {
            method,
            headers: credentials,
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          })
        },
        async mcp(name: string, input: unknown) {
          const tool = tools.find((candidate) => candidate.name === name)
          if (!tool) throw Error(`Missing tool ${name}`)
          return runTool(tool, input, { caller, rateLimit: () => {} }, () => {
            throw Error('Unexpected MCP error')
          })
        },
        async cli(command: 'create-event' | 'update-event' | 'event', input: unknown) {
          let output = ''
          let error = ''
          const status = await runCli({
            argv: [command, '--input', '-'],
            env: { HOURMERE_URL: origin, HOURMERE_API_KEY: 'hm_synthetic' },
            stdin: (async function* () {
              yield JSON.stringify(input)
            })(),
            stdout: (text) => {
              output += text
            },
            stderr: (text) => {
              error += text
            },
            fetch: async (input, init) => app.request(input, init),
          })
          return { status, body: JSON.parse(status === 0 ? output : error) }
        },
      }
    }

    async function expectDenied(
      client: ReturnType<typeof clients>,
      expected: { status: number; error: string },
      input: { id?: string; [field: string]: unknown },
    ) {
      const { id, ...changes } = input
      const rest = await client.rest(id ? 'PATCH' : 'POST', id, changes)
      expect(rest.status).toBe(expected.status)
      expect(await rest.json()).toMatchObject({ error: expected.error })
      const mcp = await client.mcp(id ? 'update_event_type' : 'create_event_type', input)
      expect(mcp.isError).toBe(true)
      const content = mcp.content[0]
      if (content?.type !== 'text') throw Error('Expected error text')
      expect(JSON.parse(content.text)).toMatchObject({ error: expected.error })
      const cli = await client.cli(id ? 'update-event' : 'create-event', input)
      expect(cli.status).not.toBe(0)
      expect(cli.body).toMatchObject({ error: expected.error })
    }

    it('round-trips sorted per-duration prices and clears them across the three interfaces', async () => {
      const host = await createTestUser(db)
      const client = clients(host.principal as McpCaller, 'available')
      const prices = [
        { durationMinutes: 30, amountMinor: 50 },
        { durationMinutes: 60, amountMinor: 99_999_999 },
      ]
      const expected = { currency: 'jpy', prices }
      const created = await client.rest('POST', undefined, {
        ...eventInput(),
        allowedDurationsMinutes: [60, 30],
        payment: { currency: 'jpy', prices: prices.toReversed() },
      })
      expect(created.status).toBe(201)
      const event = (await created.json()) as EventType
      expect(event).toMatchObject({ payment: expected, paymentAvailability: 'available' })
      const mcp = await client.mcp('get_event_type', { id: event.id })
      expect(mcp.structuredContent).toMatchObject({
        payment: expected,
        paymentAvailability: 'available',
      })
      const cli = await client.cli('event', { id: event.id })
      expect(cli).toMatchObject({
        status: 0,
        body: { payment: expected, paymentAvailability: 'available' },
      })
      await expectDenied(
        client,
        { status: 400, error: 'invalid_payment_price' },
        { id: event.id, allowedDurationsMinutes: [30] },
      )
      await expectDenied(
        client,
        { status: 400, error: 'invalid_payment_price' },
        { id: event.id, payment },
      )
      await expect(
        client.cli('update-event', { id: event.id, payment: null }),
      ).resolves.toMatchObject({
        status: 0,
        body: { payment: null },
      })
      await expect(
        client.mcp('update_event_type', { id: event.id, payment: expected }),
      ).resolves.toMatchObject({
        structuredContent: { payment: expected },
      })
    })

    it.each([
      'disabled',
      'stripe_not_configured',
      'stripe_unverified',
      'live_mode_unavailable',
    ] as const)(
      'explains %s and rejects a price write while preserving the saved price',
      async (availability) => {
        const host = await createTestUser(db)
        const principal = host.principal as McpCaller
        const available = clients(principal, 'available')
        const saved = await available.cli('create-event', { ...eventInput(), payment })
        expect(saved.status).toBe(0)
        const id = saved.body.id as string
        const client = clients(principal, availability)
        expect(await (await client.instance()).json()).toMatchObject({
          eventTypePaymentAvailability: availability,
        })
        const read = await client.rest('GET', id)
        expect(await read.json()).toMatchObject({ payment, paymentAvailability: availability })
        await expectDenied(
          client,
          { status: 409, error: 'payment_settings_unavailable' },
          { id, payment },
        )
        await expect(client.cli('update-event', { id, title: 'Rename' })).resolves.toMatchObject({
          status: 0,
          body: { payment },
        })
        await expect(client.cli('update-event', { id, payment: null })).resolves.toMatchObject({
          status: 0,
          body: { payment: null },
        })
      },
    )

    it('requires full key scope and ownership, and refuses paid teams for every role', async () => {
      const host = await createTestUser(db)
      const principal = host.principal as McpCaller
      const personal = await createEventType(
        { db, principal, now: () => Temporal.Now.instant() },
        eventInput(),
      )
      for (const apiKeyScope of ['read', 'bookings'] as const) {
        const client = clients({ ...principal, apiKeyScope } as McpCaller, 'available')
        const denied = { status: 403, error: 'insufficient_scope' }
        await expectDenied(client, denied, { ...eventInput(), payment })
        await expectDenied(client, denied, { id: personal.id, payment })
      }
      const other = await createTestUser(db)
      await expectDenied(
        clients(other.principal as McpCaller, 'available'),
        { status: 404, error: 'event_type_not_found' },
        { id: personal.id, payment },
      )
      for (const role of ['owner', 'admin', 'member']) {
        const team = await createTestTeam(db, [{ user: host, role }])
        const client = clients(team.as(host) as McpCaller, 'available')
        await expectDenied(
          client,
          role === 'member'
            ? { status: 403, error: 'insufficient_role' }
            : { status: 400, error: 'payment_flow_unsupported' },
          { ...eventInput(), payment },
        )
      }
    })

    it('blocks pricing group seats, guests, waitlists, automatic locations and recurring settings', async () => {
      const host = await createTestUser(db)
      const principal = host.principal as McpCaller
      const client = clients(principal, 'available')
      const denied = { status: 400, error: 'payment_flow_unsupported' }
      const unsupported: Partial<EventTypeInput>[] = [
        { bookingMode: 'group', groupCapacity: 3 },
        { allowGuests: true },
        { waitlist: { enabled: true } },
        { location: { kind: 'phone', number: '+14155550123' } },
        { location: { kind: 'google_meet', autoCreate: true } },
      ]
      for (const patch of unsupported)
        await expectDenied(client, denied, { ...eventInput(), ...patch, payment })
      const event = await createEventType(
        { db, principal, now: () => Temporal.Now.instant() },
        eventInput(),
      )
      await db
        .updateTable('event_types')
        .set({
          recurrence: JSON.stringify({
            timeZone: 'UTC',
            allowedPatterns: ['weekly'],
            maxOccurrences: 4,
          }),
        })
        .where('id', '=', event.id)
        .execute()
      expect(await (await client.rest('GET', event.id)).json()).toMatchObject({
        paymentAvailability: 'unsupported_event',
      })
      await expectDenied(client, denied, { id: event.id, payment })
    })
  },
)
