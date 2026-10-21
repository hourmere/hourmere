import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type Booking,
  cancelHostBooking,
  createPublicBooking,
  rescheduleHostBooking,
  rescheduleManagedBooking,
  type ServiceContext,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { bookingRoutes } from './routes/bookings.ts'

const bootstrap = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const MOVED_AT = NOW.add({ minutes: 5 })
const readers = ['REST manage', 'REST detail', 'REST list', 'MCP list'] as const

describe.skipIf(!bootstrap)('REST/MCP booking hydration snapshot', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function read(
    app: ReturnType<typeof createApp>,
    reader: (typeof readers)[number],
    id: string,
    token: string,
  ): Promise<Booking> {
    if (reader === 'MCP list') {
      const client = new Client({ name: 'snapshot-test', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL('http://localhost:4001/mcp'), {
            fetch: async (input, init) => app.request(input, init),
            requestInit: { headers: { authorization: 'Bearer synthetic-only' } },
          }),
        )
        const response = await client.callTool({ name: 'list_bookings', arguments: {} })
        expect(response.isError).not.toBe(true)
        const page = response.structuredContent as { data: Booking[] }
        expect(page.data).toHaveLength(1)
        const booking = page.data.find((booking) => booking.id === id)
        expect(booking).toBeDefined()
        return booking as Booking
      } finally {
        await client.close()
      }
    }
    const response = await app.request(
      reader === 'REST manage'
        ? '/api/v1/bookings/manage'
        : reader === 'REST detail'
          ? `/api/v1/bookings/${id}`
          : '/api/v1/bookings',
      { headers: { 'X-Manage-Token': token } },
    )
    expect(response.status).toBe(200)
    if (reader === 'REST list') {
      const page = (await response.json()) as { data: Booking[] }
      expect(page.data).toHaveLength(1)
      const booking = page.data.find((booking) => booking.id === id)
      expect(booking).toBeDefined()
      return booking as Booking
    }
    return (await response.json()) as Booking
  }

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const actor of ['host', 'invitee'] as const) {
      for (const cancelSuccessor of [false, true]) {
        it.each(readers)(
          `%s returns the old ${provider} booking cancelled when ${actor} moves it during hydration${cancelSuccessor ? ' and cancels its successor' : ''}`,
          async (reader) => {
            const host = await f.host()
            await f.schedule(host.userId)
            await f.eventType(host.organizationId, host.userId, { slug: 'snapshot' })
            const ctx = { db, now: () => MOVED_AT }
            const created = await createPublicBooking(
              { ...ctx, now: () => NOW },
              {
                handle: host.handle,
                slug: 'snapshot',
                start: Temporal.Instant.from('2026-11-02T09:00Z'),
                invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
              },
            )
            await db
              .updateTable('bookings')
              .set({
                location: JSON.stringify({
                  kind: provider,
                  autoCreate: true,
                  url:
                    provider === 'zoom'
                      ? 'https://us02web.zoom.us/j/81234567890'
                      : 'https://meet.google.com/aaa-bbbb-ccc',
                }),
              })
              .where('id', '=', created.booking.id)
              .execute()
            await db
              .insertInto('booking_conferences')
              .values({
                root_booking_id: created.booking.id,
                booking_id: created.booking.id,
                organization_id: host.organizationId,
                organizer_user_id: host.userId,
                provider,
                state: 'ready',
                applied_revision: 0,
                ...(provider === 'zoom'
                  ? { zoom_connection_id: randomUUID(), zoom_user_id: 'synthetic-zoom-user' }
                  : {}),
              })
              .execute()
            const principal = {
              kind: 'api_key' as const,
              apiKeyId: randomUUID(),
              user: { id: host.userId, name: 'Host', email: 'host@example.test' },
              organization: { id: host.organizationId, name: '', slug: '', personal: true },
            }
            const service: ServiceContext = { ...ctx, principal }
            let moved = false
            let hydrated = false
            let successor: Booking | undefined
            const observed = db.withPlugin({
              transformQuery: ({ node }) => node,
              async transformResult({ result }) {
                const initial = result.rows.find(
                  (row) => row.id === created.booking.id && Object.hasOwn(row, 'responses'),
                )
                if (initial && !moved) {
                  expect(initial.status).toBe('confirmed')
                  moved = true
                  const input = { start: Temporal.Instant.from('2026-11-02T10:00Z') }
                  const result =
                    actor === 'host'
                      ? await rescheduleHostBooking(service, created.booking.id, input)
                      : await rescheduleManagedBooking(ctx, created.manageToken as string, input)
                  successor = result.booking
                  if (cancelSuccessor)
                    await cancelHostBooking(service, successor.id, {
                      reason: 'Successor cancelled',
                    })
                  const pointer = await db
                    .selectFrom('booking_conferences')
                    .select('booking_id')
                    .where('root_booking_id', '=', created.booking.id)
                    .executeTakeFirstOrThrow()
                  expect(pointer.booking_id).toBe(successor.id)
                }
                if (
                  result.rows.some(
                    (row) =>
                      row.booking_id === created.booking.id &&
                      Object.hasOwn(row, 'booking_location'),
                  )
                )
                  hydrated = true
                return result
              },
            })
            // The resolver supplies a synthetic principal; the real route, MCP protocol,
            // schemas and shared booking services run against one owned, bounded pool.
            const app = createApp({
              publicUrl: 'http://localhost:4001',
              checkDb: async () => {},
              authHandler: async () => new Response(null, { status: 404 }),
              resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
              routes: [bookingRoutes({ db: observed, now: () => NOW })],
              mcp: mcpEndpoint({ tools: bookingTools({ db: observed, now: () => NOW }) }),
            })
            const booking = await read(
              app,
              reader,
              created.booking.id,
              created.manageToken as string,
            )
            expect(moved && hydrated).toBe(true)
            expect(booking.id).toBe(created.booking.id)
            expect(booking.status).toBe('cancelled')
            expect(booking.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
            expect(booking.cancelReason).toBeNull()
            expect(booking.location).toEqual({ kind: provider, autoCreate: true })
            expect(Object.hasOwn(booking, 'conference')).toBe(false)
            expect(successor?.id).not.toBe(created.booking.id)
          },
        )
      }
    }
  }

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const afterHydration of [false, true]) {
      for (const change of ['copy and identity', 'reschedule'] as const) {
        it.each(readers)(
          `%s snapshots ${provider} host controls when ${change} changes ${afterHydration ? 'after' : 'before'} hydration`,
          async (reader) => {
            const host = await f.host()
            await f.schedule(host.userId)
            await f.eventType(host.organizationId, host.userId, { slug: 'host-controls' })
            const created = await createPublicBooking(
              { db, now: () => NOW },
              {
                handle: host.handle,
                slug: 'host-controls',
                start: Temporal.Instant.from('2026-11-02T09:00Z'),
                invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
              },
            )
            const organizer = await db
              .selectFrom('auth.user')
              .select('email')
              .where('id', '=', host.userId)
              .executeTakeFirstOrThrow()
            await db
              .updateTable('bookings')
              .set({ location: JSON.stringify({ kind: provider, autoCreate: true }) })
              .where('id', '=', created.booking.id)
              .execute()
            await db
              .insertInto('booking_conferences')
              .values({
                root_booking_id: created.booking.id,
                booking_id: created.booking.id,
                organization_id: host.organizationId,
                organizer_user_id: host.userId,
                invitation_organizer_name: 'Host',
                invitation_organizer_email: organizer.email,
                provider,
                state: 'ready',
                applied_revision: 0,
                ...(provider === 'zoom'
                  ? { zoom_connection_id: randomUUID(), zoom_user_id: 'synthetic-zoom-user' }
                  : {}),
              })
              .execute()
            await db
              .insertInto('booking_conference_mirrors')
              .values([
                {
                  root_booking_id: created.booking.id,
                  user_id: host.userId,
                  calendar_id: randomUUID(),
                  connection_id: randomUUID(),
                  state: 'failed',
                  error_code: 'permissions_missing',
                },
                {
                  root_booking_id: created.booking.id,
                  user_id: await f.user(),
                  calendar_id: randomUUID(),
                  connection_id: randomUUID(),
                  state: 'failed',
                  error_code: 'needs_reauth',
                },
              ])
              .execute()
            const service: ServiceContext = {
              db,
              now: () => MOVED_AT,
              principal: {
                kind: 'api_key',
                apiKeyId: randomUUID(),
                user: { id: host.userId, name: 'Host', email: organizer.email },
                organization: { id: host.organizationId, name: '', slug: '', personal: true },
              },
            }
            let changed = false
            let hydrationQueries = 0
            let queriesAfterHydration = 0
            const observed = db.withPlugin({
              transformQuery: ({ node }) => node,
              async transformResult({ result }) {
                const hydrated = result.rows.some(
                  (row) =>
                    row.booking_id === created.booking.id && Object.hasOwn(row, 'booking_location'),
                )
                if (hydrationQueries) queriesAfterHydration++
                if (hydrated) {
                  hydrationQueries++
                  expect(result.rows).toHaveLength(1)
                }
                const boundary = result.rows.some((row) =>
                  afterHydration
                    ? row.booking_id === created.booking.id &&
                      Object.hasOwn(row, 'booking_location')
                    : row.id === created.booking.id && Object.hasOwn(row, 'responses'),
                )
                if (!changed && boundary) {
                  changed = true
                  if (change === 'reschedule') {
                    await rescheduleHostBooking(service, created.booking.id, {
                      start: Temporal.Instant.from('2026-11-02T10:00Z'),
                    })
                  } else {
                    await db
                      .updateTable('booking_conference_mirrors')
                      .set({ state: 'ready', applied_revision: 0, error_code: null })
                      .where('root_booking_id', '=', created.booking.id)
                      .where('user_id', '=', host.userId)
                      .execute()
                    await db
                      .updateTable('auth.user')
                      .set({ emailVerified: false })
                      .where('id', '=', host.userId)
                      .execute()
                  }
                }
                return result
              },
            })
            const app = createApp({
              publicUrl: 'http://localhost:4001',
              checkDb: async () => {},
              authHandler: async () => new Response(null, { status: 404 }),
              resolveCaller: async () => ({
                ok: true,
                principal: service.principal,
                setCookie: [],
              }),
              routes: [bookingRoutes({ db: observed, now: () => NOW })],
              mcp: mcpEndpoint({ tools: bookingTools({ db: observed, now: () => NOW }) }),
            })
            const booking = await read(
              app,
              reader,
              created.booking.id,
              created.manageToken as string,
            )
            expect(changed).toBe(true)
            expect(hydrationQueries).toBe(1)
            // Host fixtures have no assigned-host lookup: hydration is their final read.
            if (reader !== 'REST manage') expect(queriesAfterHydration).toBe(0)
            const movedBefore = change === 'reschedule' && !afterHydration
            expect(booking.status).toBe(movedBefore ? 'cancelled' : 'confirmed')
            if (reader === 'REST manage' || movedBefore) {
              expect(Object.hasOwn(booking, 'calendarCopy')).toBe(false)
              expect(Object.hasOwn(booking, 'conferenceCanRetry')).toBe(false)
            } else {
              expect(booking.calendarCopy).toEqual({
                status: afterHydration ? 'failed' : 'ready',
                errorCode: afterHydration ? 'permissions_missing' : null,
                canRetry: afterHydration,
              })
              expect(booking.conferenceCanRetry).toBe(afterHydration)
            }
            if (movedBefore) expect(Object.hasOwn(booking, 'conference')).toBe(false)
            else
              expect(booking.conference).toEqual({
                provider,
                status: change === 'copy and identity' && !afterHydration ? 'failed' : 'ready',
                errorCode:
                  change === 'copy and identity' && !afterHydration
                    ? 'organizer_unavailable'
                    : null,
              })
          },
        )
      }
    }
  }
})
