import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { cancelHostBooking, createPublicBooking } from '@hourmere/scheduling'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { bookingRoutes } from '../routes/bookings.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { bookingTools } from './bookings.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'

const URL = 'http://localhost:4189'
const NOW = Temporal.Instant.from('2027-10-31T12:00Z')
const START = Temporal.Instant.from('2027-11-01T09:00Z')
describe.skipIf(!process.env.DATABASE_URL)('group events interface parity and privacy', () => {
  let database: TestDatabase
  let db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })

  async function setup() {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const user = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', host.userId)
      .executeTakeFirstOrThrow()
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'name', 'slug'])
      .where('id', '=', host.organizationId)
      .executeTakeFirstOrThrow()
    const hostPrincipal: Principal = {
      user,
      organization: { ...organization, personal: true },
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'full',
    }
    let principal: Principal | null = hostPrincipal
    const app = createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () =>
        principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] },
      routes: [eventTypeRoutes({ db }), bookingRoutes({ db, now: () => NOW })],
      mcp: mcpEndpoint({
        oauth: {
          handler: async () => new Response(null, { status: 404 }),
          resolve: async () =>
            principal?.kind === 'oauth'
              ? { ok: true, principal }
              : { ok: false, error: 'invalid_token' },
        },
        tools: [...eventTypeTools({ db }), ...bookingTools({ db, now: () => NOW })],
      }),
    })
    async function rest(
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      return app.request(path, {
        method,
        headers: {
          authorization: 'Bearer hm_synthetic',
          'content-type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    async function cli(command: string, input: Record<string, unknown>) {
      let stdout = ''
      let stderr = ''
      const code = await runCli({
        argv: [command, '--input', '-'],
        env: { HOURMERE_URL: URL, HOURMERE_API_KEY: 'hm_synthetic' },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch: async (input, init) => {
          if (principal?.kind === 'oauth') {
            const headers = new Headers(init?.headers)
            headers.set('authorization', 'Bearer synthetic_oauth')
            return app.request(input, { ...init, headers })
          }
          return app.request(input, init)
        },
      })
      return {
        code,
        data: stdout ? JSON.parse(stdout) : null,
        error: stderr ? JSON.parse(stderr) : null,
      }
    }
    const create = await rest('/api/v1/event-types', 'POST', {
      slug: 'class',
      title: 'Class',
      durationMinutes: 30,
      bookingMode: 'group',
      groupCapacity: 2,
    })
    expect(create.status).toBe(201)
    const event = (await create.json()) as { id: string }
    const book = (email: string) =>
      createPublicBooking(
        { db, now: () => NOW },
        {
          handle: host.handle,
          slug: 'class',
          start: START,
          invitee: { name: email, email, timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        },
      )
    return {
      app,
      rest,
      cli,
      event,
      book,
      hostPrincipal,
      setPrincipal: (value: Principal | null) => {
        principal = value
      },
    }
  }

  it('configures group mode through REST and CLI/MCP and exposes each seat with its occurrence', async () => {
    const s = await setup()
    expect(s.event).toMatchObject({ bookingMode: 'group', groupCapacity: 2 })
    const update = await s.cli('update-event', { id: s.event.id, groupCapacity: 3 })
    expect(update.code).toBe(0)
    expect(update.data).toMatchObject({ bookingMode: 'group', groupCapacity: 3 })
    const create = await s.cli('create-event', {
      slug: 'second',
      title: 'Second',
      durationMinutes: 30,
      bookingMode: 'group',
      groupCapacity: 4,
    })
    expect(create.code).toBe(0)
    expect(create.data).toMatchObject({ bookingMode: 'group', groupCapacity: 4 })
    const seat = await s.book('first@example.test')
    const list = await s.cli('list', {})
    expect(list.code).toBe(0)
    expect(list.data.data).toEqual([
      expect.objectContaining({
        id: seat.booking.id,
        groupSlotId: expect.any(String),
        isGroupSeat: true,
      }),
    ])
    const forbidden = await s.cli('update-event', {
      id: s.event.id,
      bookingMode: 'individual',
      groupCapacity: null,
    })
    expect(forbidden.code).not.toBe(0)
    for (const values of [
      { groupCapacity: 1 },
      { allowGuests: true },
      { schedulingType: 'collective' },
    ]) {
      expect((await s.rest(`/api/v1/event-types/${s.event.id}`, 'PATCH', values)).status).toBe(400)
    }
  })

  it('returns full and cancelled seats identically through REST and CLI, and cancels the whole occurrence', async () => {
    const s = await setup()
    const first = await s.book('first@example.test')
    const second = await s.book('second@example.test')
    const listed = (await (await s.rest('/api/v1/bookings')).json()) as {
      data: { groupSlotId: string }[]
    }
    const id = listed.data[0]?.groupSlotId
    const path = `/api/v1/group-occurrences/${id}/attendees`
    const full = (await (await s.rest(path)).json()) as { attendees: unknown[] }
    expect(full).toMatchObject({ id, capacity: 2, activeSeats: 2 })
    expect(full.attendees).toHaveLength(2)
    expect((await s.cli('group-attendees', { occurrenceId: id })).data).toEqual(full)
    await cancelHostBooking({ db, principal: s.hostPrincipal, now: () => NOW }, first.booking.id)
    const cancelled = (await (await s.rest(path)).json()) as {
      activeSeats: number
      attendees: unknown[]
    }
    expect(cancelled.activeSeats).toBe(1)
    expect(cancelled.attendees).toContainEqual(
      expect.objectContaining({
        bookingId: first.booking.id,
        status: 'cancelled',
        noShowMarkedAt: null,
      }),
    )
    expect(cancelled.attendees).toContainEqual(
      expect.objectContaining({ bookingId: second.booking.id, status: 'confirmed' }),
    )
    const all = await s.cli('cancel-group', { occurrenceId: id, reason: 'Class cancelled' })
    expect(all).toMatchObject({ code: 0, data: { id, cancelledSeatCount: 1 } })
    expect((await s.rest(`/api/v1/group-occurrences/${id}/cancel`, 'POST', {})).status).toBe(200)
    expect(await (await s.rest(path)).json()).toMatchObject({
      state: 'host_cancelled',
      activeSeats: 0,
    })
  })

  it('enforces key scopes, OAuth host isolation, and denies invitee capabilities', async () => {
    const s = await setup()
    const seat = await s.book('private@example.test')
    const listing = (await (await s.rest('/api/v1/bookings')).json()) as {
      data: { groupSlotId: string }[]
    }
    const id = listing.data[0]?.groupSlotId
    const path = `/api/v1/group-occurrences/${id}/attendees`
    for (const apiKeyScope of ['read', 'bookings', 'full'] as const) {
      s.setPrincipal({ ...s.hostPrincipal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope })
      expect((await s.rest(path)).status).toBe(200)
      expect((await s.cli('group-attendees', { occurrenceId: id })).code).toBe(0)
      if (apiKeyScope === 'read')
        expect((await s.rest(`/api/v1/group-occurrences/${id}/cancel`, 'POST', {})).status).toBe(
          403,
        )
    }
    s.setPrincipal({
      ...s.hostPrincipal,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: randomUUID(),
      scopes: ['mcp:tools'],
    })
    expect((await s.cli('group-attendees', { occurrenceId: id })).code).toBe(0)
    const other = await createTestUser(db)
    s.setPrincipal(other.principal)
    const denied = await s.rest(path)
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual(
      await (await s.rest(`/api/v1/group-occurrences/${randomUUID()}/attendees`)).json(),
    )
    expect((await s.cli('group-attendees', { occurrenceId: id })).code).not.toBe(0)
    s.setPrincipal({
      ...other.principal,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: randomUUID(),
      scopes: ['mcp:tools'],
    })
    expect((await s.cli('group-attendees', { occurrenceId: id })).code).not.toBe(0)
    s.setPrincipal(null)
    const invitee = await s.app.request(path, {
      headers: { 'x-manage-token': seat.manageToken as string },
    })
    expect(invitee.status).toBe(401)
    const managed = await s.app.request('/api/v1/bookings/manage', {
      headers: { 'x-manage-token': seat.manageToken as string },
    })
    expect(managed.status).toBe(200)
    const data = (await managed.json()) as { attendees: unknown[] }
    expect(data).not.toHaveProperty('groupSlotId')
    expect(data.attendees).toHaveLength(1)
  })
})
