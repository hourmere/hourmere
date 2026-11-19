import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  bookingNotifier,
  type NotificationKind,
  sendBookingNotification,
} from '@hourmere/notifications'
import { cancelHostBooking, createPublicBooking } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  headerValues,
  rawMailCapture,
} from '../../../../packages/notifications/src/testing/raw-mime.ts'
import { alignSmtpDateNowWithDatabase } from '../../../../packages/notifications/src/testing-clock.ts'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { bookingRoutes } from '../routes/bookings.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { publicRoutes } from '../routes/public.ts'
import { bookingTools } from './bookings.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'

const URL = 'http://localhost:4189'
const NOW = Temporal.Instant.from('2027-10-31T12:00Z')
const START = Temporal.Instant.from('2027-11-01T09:00Z')
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing acceptance fixture')
  return value
}
describe.skipIf(!process.env.DATABASE_URL)('group events interface parity and privacy', () => {
  let database: TestDatabase
  let db: Db
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    capture = await rawMailCapture('calendar@sender.example.test')
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await capture?.close()
    await database?.drop()
  })

  async function setup(creation: 'rest' | 'mcp' = 'rest', team = false) {
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
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const teamOrganization = team
      ? await createTestTeam(db, [
          { user: { ...user, principal: hostPrincipal }, role: 'member' },
          { user: admin, role: 'admin' },
          { user: member, role: 'member' },
        ])
      : undefined
    const actingHost = teamOrganization?.as({ ...user, principal: hostPrincipal }) ?? hostPrincipal
    let principal: Principal | null = teamOrganization?.as(admin) ?? actingHost
    const jobs: { bookingId: string; kind: NotificationKind }[] = []
    const notify = bookingNotifier({
      async enqueue(_name, payload) {
        if ('kind' in payload && !('requestId' in payload) && payload.kind !== 'reminder')
          jobs.push({ bookingId: payload.bookingId, kind: payload.kind })
        return null
      },
    })
    const app = createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () =>
        principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] },
      routes: [
        eventTypeRoutes({ db }),
        bookingRoutes({ db, now: () => NOW, notify }),
        publicRoutes({
          db,
          now: () => NOW,
          notify,
          rateLimits: { book: { limit: 1000, windowSeconds: 60 } },
        }),
      ],
      mcp: mcpEndpoint({
        oauth: {
          handler: async () => new Response(null, { status: 404 }),
          resolve: async () =>
            principal?.kind === 'oauth'
              ? { ok: true, principal }
              : { ok: false, error: 'invalid_token' },
        },
        tools: [...eventTypeTools({ db }), ...bookingTools({ db, now: () => NOW, notify })],
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
    const input = {
      slug: 'class',
      title: 'Class',
      durationMinutes: 30,
      bookingMode: 'group',
      groupCapacity: 2,
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: false }],
      ...(team ? { hosts: [{ userId: user.id }] } : {}),
    }
    let event: { id: string }
    if (creation === 'rest') {
      const create = await rest('/api/v1/event-types', 'POST', input)
      expect(create.status).toBe(201)
      event = (await create.json()) as { id: string }
    } else {
      const create = await cli('create-event', input)
      expect(create.code).toBe(0)
      event = create.data
    }
    principal = actingHost
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
      hostPrincipal: actingHost,
      publicPath: teamOrganization
        ? `/api/v1/public/teams/${actingHost.organization.slug}/class`
        : `/api/v1/public/${host.handle}/class`,
      teamOrganization,
      admin,
      member,
      async drain() {
        for (const job of jobs.splice(0))
          await sendBookingNotification(
            {
              db,
              mailer: capture.mailer,
              secret: 'synthetic-group-acceptance-secret',
              publicUrl: URL,
              now: () => NOW,
              log: () => {},
            },
            job.bookingId,
            job.kind,
          )
      },
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
    const cancelled = (await (await s.rest(`${path}?status=all`)).json()) as {
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

  it.each(['rest', 'mcp'] as const)(
    'accepts a private capacity-two lifecycle through public REST and host %s',
    async (transport) => {
      await alignSmtpDateNowWithDatabase(db)
      capture.sent.length = 0
      const s = await setup(transport)
      const people = ['Alphainvitee', 'Bravoinvitee', 'Charlieinvitee'].map((name) => ({
        name,
        email: `${name.toLowerCase()}@people.example.test`,
        timeZone: 'UTC',
      }))
      const responses: { self: number | null; text: string }[] = []
      const seats: { booking: { id: string }; manageToken: string }[] = []
      async function record(response: Response, self: number | null) {
        const text = await response.text()
        responses.push({ self, text })
        return JSON.parse(text)
      }
      async function book(index: number, expected: number) {
        const response = await s.app.request(`${s.publicPath}/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            start: START.toString(),
            invitee: people[index],
            responses: { topic: `answer-${required(people[index]).name}` },
          }),
        })
        expect(response.status).toBe(expected)
        return record(response, index)
      }
      async function slots(expected: number) {
        const response = await s.app.request(
          `${s.publicPath}/slots?${new URLSearchParams({
            start: START.toString(),
            end: START.add({ minutes: 30 }).toString(),
          })}`,
        )
        expect(response.status).toBe(200)
        const data = await record(response, null)
        if (expected === 0) expect(data.data).toEqual([])
        else
          expect(data.data).toEqual([
            expect.objectContaining({ capacity: 2, seatsRemaining: expected }),
          ])
      }
      const discovery = await s.app.request(s.publicPath)
      expect(discovery.status).toBe(200)
      await record(discovery, null)
      await slots(2)
      seats[0] = await book(0, 201)
      await slots(1)
      seats[1] = await book(1, 201)
      await slots(0)
      expect(await book(2, 409)).toMatchObject({ error: 'slot_taken' })
      await s.drain()
      const firstCancel = await s.app.request('/api/v1/bookings/manage/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-manage-token': required(seats[0]).manageToken,
        },
        body: '{}',
      })
      expect(firstCancel.status).toBe(200)
      await record(firstCancel, 0)
      await s.drain()
      await slots(1)
      seats[2] = await book(2, 201)
      await s.drain()
      const hostList = await s.rest('/api/v1/bookings')
      expect(hostList.status).toBe(200)
      const { data: bookings } = (await hostList.json()) as { data: { groupSlotId: string }[] }
      const id = required(bookings[0]).groupSlotId
      expect(bookings.every((booking) => booking.groupSlotId === id)).toBe(true)
      async function roster(query: Record<string, string | number> = {}) {
        if (transport === 'mcp') {
          const result = await s.cli('group-attendees', { occurrenceId: id, ...query })
          expect(result.code).toBe(0)
          return result.data
        }
        const params = new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        )
        const result = await s.rest(`/api/v1/group-occurrences/${id}/attendees?${params}`)
        expect(result.status).toBe(200)
        return result.json()
      }
      const active = await roster()
      expect(active.attendees.map((seat: { bookingId: string }) => seat.bookingId)).toEqual([
        required(seats[1]).booking.id,
        required(seats[2]).booking.id,
      ])
      const cancelled = await roster({ status: 'cancelled' })
      expect(cancelled.attendees).toEqual([
        expect.objectContaining({ bookingId: required(seats[0]).booking.id, status: 'cancelled' }),
      ])
      for (let offset = 0; offset < 3; offset++) {
        const page = await roster({ status: 'all', limit: 1, offset })
        expect(page.attendees).toEqual([
          expect.objectContaining({ bookingId: required(seats[offset]).booking.id }),
        ])
        expect(page.pagination).toEqual({ limit: 1, offset, hasMore: offset < 2 })
      }
      for (const query of [
        { limit: 0 },
        { limit: 101 },
        { offset: -1 },
        { offset: 10001 },
        { status: 'unknown' },
      ]) {
        const params = new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        )
        expect((await s.rest(`/api/v1/group-occurrences/${id}/attendees?${params}`)).status).toBe(
          400,
        )
        expect((await s.cli('group-attendees', { occurrenceId: id, ...query })).code).not.toBe(0)
      }
      const beforeCancel = capture.sent.length
      if (transport === 'mcp') {
        expect(await s.cli('cancel-group', { occurrenceId: id })).toMatchObject({
          code: 0,
          data: { cancelledSeatCount: 2 },
        })
      } else {
        const result = await s.rest(`/api/v1/group-occurrences/${id}/cancel`, 'POST', {})
        expect(result.status).toBe(200)
        expect(await result.json()).toMatchObject({ cancelledSeatCount: 2 })
      }
      await s.drain()
      const cancellations = capture.sent
        .slice(beforeCancel)
        .filter((message) => people.some((person) => person.email === message.to))
      expect(cancellations.map((message) => message.to).sort()).toEqual(
        [required(people[1]).email, required(people[2]).email].sort(),
      )
      for (const message of cancellations) expect(message.ics).toContain('METHOD:CANCEL')
      expect((await roster()).attendees).toEqual([])
      expect((await roster({ status: 'cancelled' })).attendees).toHaveLength(3)
      await slots(0)
      expect(await book(0, 409)).toMatchObject({ error: 'slot_unavailable' })
      for (const [index, seat] of seats.entries()) {
        const response = await s.app.request('/api/v1/bookings/manage', {
          headers: { 'x-manage-token': seat.manageToken },
        })
        expect(response.status).toBe(200)
        const body = await record(response, index)
        expect(body).not.toHaveProperty('groupSlotId')
        expect(body.attendees).toHaveLength(1)
      }
      const privateValues = people.map((person, index) => [
        person.name,
        person.email,
        `answer-${person.name}`,
        required(seats[index]).booking.id,
        required(seats[index]).manageToken,
        ...capture.sent
          .filter((message) => message.to === person.email)
          .flatMap((message) =>
            [...message.decoded.matchAll(/#token=([A-Za-z0-9_%-]{20,})/g)].map((match) =>
              decodeURIComponent(required(match[1])),
            ),
          ),
      ])
      function assertPrivate(text: string, self: number | null) {
        for (const [index, values] of privateValues.entries()) {
          if (index === self) continue
          for (const value of values)
            expect(
              text.toLowerCase().includes(value.toLowerCase()),
              'another invitee private value is absent',
            ).toBe(false)
        }
      }
      for (const response of responses) assertPrivate(response.text, response.self)
      for (const [index, person] of people.entries()) {
        const messages = capture.sent.filter((message) => message.to === person.email)
        expect(messages.length).toBe(2)
        for (const message of messages) {
          expect(message.envelope).toEqual([person.email])
          expect(headerValues(message, 'Cc')).toEqual([])
          expect(headerValues(message, 'Bcc')).toEqual([])
          assertPrivate(message.text, index)
        }
      }
    },
  )

  it('admits only two simultaneous public bookings without disclosing the other contenders', async () => {
    const s = await setup()
    const names = ['Concurrentalpha', 'Concurrentbravo', 'Concurrentcharlie']
    const responses = await Promise.all(
      names.map((name) =>
        s.app.request(`${s.publicPath}/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            start: START.toString(),
            invitee: { name, email: `${name.toLowerCase()}@people.example.test`, timeZone: 'UTC' },
          }),
        }),
      ),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 409])
    for (const [index, response] of responses.entries()) {
      const text = (await response.text()).toLowerCase()
      for (const [other, name] of names.entries())
        if (index !== other)
          expect(text.includes(name.toLowerCase()), 'other contender remains private').toBe(false)
    }
    const list = (await (await s.rest('/api/v1/bookings')).json()) as {
      data: { groupSlotId: string }[]
    }
    expect(list.data).toHaveLength(2)
    const id = required(list.data[0]).groupSlotId
    expect(list.data.every((booking) => booking.groupSlotId === id)).toBe(true)
    expect(await (await s.rest(`/api/v1/group-occurrences/${id}/attendees`)).json()).toMatchObject({
      capacity: 2,
      activeSeats: 2,
    })
  })

  it('allows a team admin session but denies another member and non-host MCP credentials', async () => {
    const s = await setup('rest', true)
    const booked = await s.app.request(`${s.publicPath}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        start: START.toString(),
        invitee: { name: 'Team invitee', email: 'team-private@example.test', timeZone: 'UTC' },
      }),
    })
    expect(booked.status).toBe(201)
    const list = (await (await s.rest('/api/v1/bookings')).json()) as {
      data: { groupSlotId: string }[]
    }
    const id = required(list.data[0]).groupSlotId
    const path = `/api/v1/group-occurrences/${id}`
    for (const user of [s.admin, s.member]) {
      const key = required(s.teamOrganization).as(user)
      s.setPrincipal(key)
      expect((await s.rest(`${path}/attendees`)).status).toBe(404)
      expect((await s.cli('group-attendees', { occurrenceId: id })).code).not.toBe(0)
      expect((await s.cli('cancel-group', { occurrenceId: id })).code).not.toBe(0)
      s.setPrincipal({ ...key, kind: 'session', sessionId: randomUUID() })
      expect((await s.rest(`${path}/attendees`)).status).toBe(user === s.admin ? 200 : 404)
      if (user === s.member)
        expect((await s.rest(`${path}/cancel`, 'POST', {}, { origin: URL })).status).toBe(404)
    }
    s.setPrincipal({
      ...required(s.teamOrganization).as(s.admin),
      kind: 'session',
      sessionId: randomUUID(),
    })
    const cancelled = await s.rest(`${path}/cancel`, 'POST', {}, { origin: URL })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ cancelledSeatCount: 1 })
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
