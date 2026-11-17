// Full booking/manage route acceptance over real Postgres. Only authentication transport
// is synthetic; authorization, slot selection, booking writes and deadline checks are real.
import '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookingTools } from '../mcp/bookings.ts'
import { type McpCaller, runTool, type Tool } from '../mcp/tools.ts'
import { bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'
import { productApp } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const hostZone = 'America/Los_Angeles'
const inviteeZone = 'Asia/Shanghai'
const plenty = { limit: 100_000, windowSeconds: 60 }
const seasons = [
  {
    name: 'spring-forward',
    start: '2027-03-14T19:00:00Z',
    deadline: '2027-03-13T19:00:00Z',
    hostDeadline: '2027-03-13T11:00:00',
    inviteeDeadline: '2027-03-14T03:00:00',
  },
  {
    name: 'fall-back',
    start: '2027-11-07T20:00:00Z',
    deadline: '2027-11-06T20:00:00Z',
    hostDeadline: '2027-11-06T13:00:00',
    inviteeDeadline: '2027-11-07T04:00:00',
  },
] as const

type Booking = { id: string; status: string; start: string }
type Created = { booking: Booking; manageToken: string | null }

describe.skipIf(!serverUrl)('cross-zone change deadline acceptance', () => {
  let owned: TestDatabase
  let db: Db
  // The same injected Temporal clock used by the scheduling/route test helpers: no timers
  // or wall-clock assumptions, including when the optional clock-offset lane is enabled.
  let current: Temporal.Instant
  const now = () => current
  const principals = new Map<string, Principal>()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  async function fixture(season: (typeof seasons)[number]) {
    const start = Temporal.Instant.from(season.start)
    current = start.subtract({ hours: 72 })
    const f = createFixtures(db)
    const host = await f.host({ timeZone: hostZone })
    await f.schedule(host.userId, {
      timeZone: hostZone,
      weeklyHours: { sunday: [{ start: '09:00', end: '17:00' }] },
    })
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      rescheduleCutoffMinutes: 120,
      cancelCutoffMinutes: 1440,
    })
    const key = crypto.randomUUID()
    const principal: Principal = {
      kind: 'api_key',
      apiKeyScope: 'full',
      apiKeyId: crypto.randomUUID(),
      user: { id: host.userId, name: 'Host', email: 'host@example.com' },
      organization: { id: host.organizationId, name: '', slug: '', personal: true },
    }
    principals.set(key, principal)
    const app = productApp(db, principals, [
      publicRoutes({ db, now, rateLimits: { page: plenty, slots: plenty, book: plenty } }),
      bookingRoutes({
        db,
        now,
        rateLimits: { manage: plenty, slots: plenty },
        hostRateLimits: { manage: plenty, slots: plenty },
      }),
    ])
    const booked = await app.request(`/api/v1/public/${host.handle}/intro/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        start: season.start,
        invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: inviteeZone },
      }),
    })
    expect(booked.status).toBe(201)
    const created = (await booked.json()) as Created
    expect(typeof created.manageToken === 'string').toBe(true)
    const token = created.manageToken as string
    const tools = bookingTools({ db, now })
    const tool = (name: string, args: Record<string, unknown>, caller = principal) =>
      runTool(
        tools.find((t) => t.name === name) as Tool,
        args,
        { caller: caller as McpCaller, rateLimit: () => {} },
        () => {
          throw Error('Unexpected tool failure')
        },
      )
    const manage = (path: string, body?: unknown, manageToken = token) =>
      app.request(`/api/v1/bookings/manage${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-manage-token': manageToken, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const hostWrite = (id: string, action: string, body: unknown, credential = key) =>
      app.request(`/api/v1/bookings/${id}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const target = start.add({ hours: 1 }).toString()
    return { created, token, manage, tool, hostWrite, principal, target }
  }

  function toolError(result: Awaited<ReturnType<typeof runTool>>) {
    expect(result.isError).toBe(true)
    const content = result.content[0]
    if (content?.type !== 'text') throw Error('Expected error text')
    return JSON.parse(content.text) as { error: string }
  }

  for (const season of seasons) {
    it(`${season.name}: reports elapsed deadlines in both zones and keeps invitee details private`, async () => {
      const s = await fixture(season)
      const shown = await s.manage('')
      expect(shown.status).toBe(200)
      const body = (await shown.json()) as {
        changeDeadlines: { rescheduleBy: string; cancelBy: string }
      }
      const deadline = Temporal.Instant.from(season.deadline)
      expect(body.changeDeadlines).toEqual({
        rescheduleBy: deadline.toString({ fractionalSecondDigits: 3 }),
        cancelBy: deadline.toString({ fractionalSecondDigits: 3 }),
      })
      expect(deadline.toZonedDateTimeISO(hostZone).toPlainDateTime().toString()).toBe(
        season.hostDeadline,
      )
      expect(deadline.toZonedDateTimeISO(inviteeZone).toPlainDateTime().toString()).toBe(
        season.inviteeDeadline,
      )
      expect(Temporal.Instant.from(season.start).since(deadline).total('hours')).toBe(24)
      const stored = await db
        .selectFrom('booking_attendees')
        .select('time_zone')
        .where('booking_id', '=', s.created.booking.id)
        .executeTakeFirstOrThrow()
      expect(stored.time_zone).toBe(inviteeZone)
      const unknown = 'A'.repeat(43)
      for (const path of ['', `/slots?start=${season.start}&end=${s.target}`]) {
        const response = await s.manage(path, undefined, unknown)
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: 'booking_not_found' })
      }
      for (const action of ['cancel', 'reschedule'] as const) {
        const response = await s.manage(
          `/${action}`,
          action === 'cancel' ? {} : { start: s.target },
          unknown,
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: 'booking_not_found' })
        expect(
          toolError(
            await s.tool(`${action}_booking`, {
              manageToken: unknown,
              ...(action === 'reschedule' ? { start: s.target } : {}),
            }),
          ).error,
        ).toBe('booking_not_found')
      }
    })

    for (const channel of ['REST', 'MCP'] as const) {
      for (const action of ['cancel', 'reschedule'] as const) {
        for (const offset of [-1, 0] as const) {
          it(`${season.name}: ${channel} ${action} ${offset === -1 ? 'succeeds 1 ms before' : 'refuses exactly at'} the effective deadline`, async () => {
            const s = await fixture(season)
            current = Temporal.Instant.from(season.deadline).add({ milliseconds: offset })
            if (action === 'reschedule') {
              const slots = await s.manage(
                `/slots?start=${season.start}&end=${Temporal.Instant.from(s.target).add({ hours: 1 })}`,
              )
              expect(slots.status).toBe(offset === -1 ? 200 : 409)
              if (offset === 0)
                expect(await slots.json()).toMatchObject({
                  error: 'booking_reschedule_deadline_passed',
                })
            }
            const args = action === 'cancel' ? {} : { start: s.target }
            let successor: Booking | undefined
            if (channel === 'REST') {
              const response = await s.manage(`/${action}`, args)
              expect(response.status).toBe(offset === -1 ? 200 : 409)
              const body = (await response.json()) as Booking & Created & { error?: string }
              if (offset === 0) expect(body.error).toBe(`booking_${action}_deadline_passed`)
              else successor = action === 'reschedule' ? body.booking : body
            } else {
              const result = await s.tool(`${action}_booking`, { manageToken: s.token, ...args })
              if (offset === 0)
                expect(toolError(result).error).toBe(`booking_${action}_deadline_passed`)
              else {
                expect(result.isError).toBeFalsy()
                successor =
                  action === 'reschedule'
                    ? (result.structuredContent as { booking: Booking }).booking
                    : (result.structuredContent as Booking)
              }
            }
            const old = await db
              .selectFrom('bookings')
              .select('status')
              .where('id', '=', s.created.booking.id)
              .executeTakeFirstOrThrow()
            expect(old.status).toBe(offset === -1 ? 'cancelled' : 'confirmed')
            if (offset === -1) {
              expect(successor?.status).toBe(action === 'cancel' ? 'cancelled' : 'confirmed')
              if (action === 'reschedule') {
                expect(
                  Temporal.Instant.from(successor?.start as string).equals(
                    Temporal.Instant.from(s.target),
                  ),
                ).toBe(true)
                const snapshot = await db
                  .selectFrom('bookings')
                  .select(['reschedule_cutoff_minutes', 'cancel_cutoff_minutes'])
                  .where('id', '=', successor?.id as string)
                  .executeTakeFirstOrThrow()
                expect(snapshot).toEqual({
                  reschedule_cutoff_minutes: 120,
                  cancel_cutoff_minutes: 1440,
                })
              }
            }
          })
        }
      }
    }

    it(`${season.name}: host can move and cancel after both cutoffs; other accounts cannot`, async () => {
      const s = await fixture(season)
      current = Temporal.Instant.from(season.start).subtract({ minutes: 60 })
      const other = await fixture(season)
      current = Temporal.Instant.from(season.start).subtract({ minutes: 60 })
      for (const action of ['reschedule', 'cancel'] as const) {
        const denied = await other.hostWrite(
          s.created.booking.id,
          action,
          action === 'cancel' ? {} : { start: s.target },
        )
        expect(denied.status).toBe(404)
        expect(await denied.json()).toMatchObject({ error: 'booking_not_found' })
        expect(
          toolError(
            await s.tool(
              `${action}_booking`,
              {
                bookingId: s.created.booking.id,
                ...(action === 'reschedule' ? { start: s.target } : {}),
              },
              other.principal,
            ),
          ).error,
        ).toBe('booking_not_found')
      }
      const moved = await s.hostWrite(s.created.booking.id, 'reschedule', { start: s.target })
      expect(moved.status).toBe(200)
      const successor = (await moved.json()) as Created
      expect(successor.manageToken === null).toBe(true)
      const cancelled = await s.tool('cancel_booking', { bookingId: successor.booking.id })
      expect(cancelled.isError).toBeFalsy()
      expect((cancelled.structuredContent as Booking).status).toBe('cancelled')
    })
  }
})
