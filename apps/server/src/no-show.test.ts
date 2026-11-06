import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { groupFixture, occupiedSlot } from '../../../packages/db/src/group-seats-fixtures.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { bookingRoutes } from './routes/bookings.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-02T10:00:00Z')
describe.skipIf(!serverUrl)('attendee no-show interface parity', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  let bookingId: string
  let attendeeId: string
  let caller: Principal
  const notify = vi.fn()
  const notifyAttendeeNoShow = vi.fn()
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'no_show_api' })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    caller = {
      kind: 'api_key',
      apiKeyScope: 'bookings',
      apiKeyId: randomUUID(),
      user: { id: host.userId, name: 'Host', email: 'host@example.com' },
      organization: { id: host.organizationId, name: '', slug: '', personal: true },
    }
    bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      '2026-11-02T09:00Z',
      '2026-11-02T09:30Z',
    )
    attendeeId = (
      await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', bookingId)
        .executeTakeFirstOrThrow()
    ).id
    const deps = { db, now, notify, notifyAttendeeNoShow }
    app = createApp({
      publicUrl: 'http://localhost:4186',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
      routes: [bookingRoutes(deps)],
      mcp: mcpEndpoint({ tools: bookingTools(deps) }),
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const patch = (body: unknown, contentType = 'application/json') =>
    app.request(`/api/v1/bookings/${bookingId}/attendees/${attendeeId}/no-show`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer synthetic', 'content-type': contentType },
      body: JSON.stringify(body),
    })
  it('marks through REST, replays without effects and unmarks through CLI/MCP', async () => {
    const first = await patch({ noShow: true })
    expect(first.status).toBe(200)
    const marker = await first.json()
    expect(marker).toEqual({
      attendeeId,
      noShowMarkedAt: new Date(now().epochMilliseconds).toISOString(),
      noShowMarkedBy: caller.user.id,
    })
    expect(await (await patch({ noShow: true })).json()).toEqual(marker)
    expect(notifyAttendeeNoShow).toHaveBeenCalledTimes(1)
    let stdout = '',
      stderr = ''
    const code = await runCli({
      argv: ['set-no-show', '--input', '-'],
      env: { HOURMERE_URL: 'http://localhost:4186', HOURMERE_API_KEY: 'hm_synthetic' },
      stdin: (async function* () {
        yield JSON.stringify({ bookingId, attendeeId, noShow: false })
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (input, init) => app.request(input, init),
    })
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({ attendeeId, noShowMarkedAt: null, noShowMarkedBy: null })
    expect(notifyAttendeeNoShow).toHaveBeenCalledTimes(2)
    expect(notify).not.toHaveBeenCalled()
    const detail = await app.request(`/api/v1/bookings/${bookingId}`, {
      headers: { authorization: 'Bearer synthetic' },
    })
    expect(((await detail.json()) as { attendees: unknown[] }).attendees[0]).toMatchObject({
      id: attendeeId,
      noShowMarkedAt: null,
      noShowMarkedBy: null,
    })
  })
  it('exposes real group-seat attendee IDs and marks one seat without changing another', async () => {
    const fixture = await groupFixture(owned.pool)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.organization,
        userId: fixture.host,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const { bookings } = await occupiedSlot(fixture, 2)
    const original = caller
    caller = {
      ...caller,
      user: { ...caller.user, id: fixture.host },
      organization: { ...caller.organization, id: fixture.organization, personal: false },
    }
    try {
      const groupApp = createApp({
        publicUrl: 'http://localhost:4186',
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
        routes: [bookingRoutes({ db, now: () => Temporal.Instant.from(fixture.end) })],
      })
      const headers = { authorization: 'Bearer synthetic', 'content-type': 'application/json' }
      const list = await groupApp.request('/api/v1/bookings', { headers })
      expect(list.status).toBe(200)
      const page = (await list.json()) as {
        data: {
          id: string
          canManageNoShow: boolean
          attendees: { id: string; noShowMarkedAt: string | null }[]
        }[]
      }
      expect(page.data).toHaveLength(2)
      const first = page.data.find((booking) => booking.id === bookings[0])
      const second = page.data.find((booking) => booking.id === bookings[1])
      if (!first || !second) throw new Error('Missing group seats')
      expect(first.canManageNoShow).toBe(true)
      expect(second.attendees[0]?.noShowMarkedAt).toBeNull()
      const response = await groupApp.request(
        `/api/v1/bookings/${first.id}/attendees/${first.attendees[0]?.id}/no-show`,
        { method: 'PATCH', headers, body: JSON.stringify({ noShow: true }) },
      )
      expect(response.status).toBe(200)
      const unchanged = await groupApp.request(`/api/v1/bookings/${second.id}`, { headers })
      expect(
        ((await unchanged.json()) as { attendees: { noShowMarkedAt: string | null }[] })
          .attendees[0]?.noShowMarkedAt,
      ).toBeNull()
    } finally {
      caller = original
    }
  })
  it('lets a non-host team admin discover attendee IDs through REST and CLI/MCP', async () => {
    const f = createFixtures(db)
    const admin = await f.host()
    const host = await f.host()
    const teamId = randomUUID()
    await db
      .insertInto('auth.organization')
      .values({ id: teamId, name: 'Team', slug: `team-${teamId}`, createdAt: new Date() })
      .execute()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: teamId,
        userId: admin.userId,
        role: 'admin',
        createdAt: new Date(),
      })
      .execute()
    const id = await f.booking(teamId, [host.userId], '2026-11-03T09:00Z', '2026-11-03T09:30Z')
    const original = caller
    caller = {
      ...caller,
      user: { ...caller.user, id: admin.userId },
      organization: { ...caller.organization, id: teamId, personal: false },
    }
    try {
      const response = await app.request(`/api/v1/bookings/${id}/attendees`, {
        headers: { authorization: 'Bearer synthetic' },
      })
      expect(response.status).toBe(200)
      const attendees = await response.json()
      expect(attendees).toMatchObject({
        data: [{ id: expect.any(String), noShowMarkedAt: null, noShowMarkedBy: null }],
      })
      let stdout = ''
      const code = await runCli({
        argv: ['booking-attendees', '--input', '-'],
        env: { HOURMERE_URL: 'http://localhost:4186', HOURMERE_API_KEY: 'hm_synthetic' },
        stdin: (async function* () {
          yield JSON.stringify({ bookingId: id })
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: () => {},
        fetch: async (input, init) => app.request(input, init),
      })
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual(attendees)
    } finally {
      caller = original
    }
  })
  it('rejects malformed input and read-only keys before mutation', async () => {
    expect((await patch({ noShow: 'true' })).status).toBe(400)
    expect((await patch({ noShow: true }, 'text/plain')).status).toBe(415)
    if (caller.kind !== 'api_key') throw new Error('Expected key')
    caller = { ...caller, apiKeyScope: 'read' }
    const response = await patch({ noShow: true })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'insufficient_scope' })
    caller = { ...caller, apiKeyScope: 'bookings' }
  })
})
