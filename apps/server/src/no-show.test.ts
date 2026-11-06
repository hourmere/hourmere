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
      mcp: mcpEndpoint({
        tools: bookingTools(deps),
        oauth: {
          resolve: async () =>
            caller.kind === 'oauth'
              ? { ok: true, principal: caller }
              : { ok: false, error: 'invalid_token' },
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
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
      env: {
        HOURMERE_URL: 'http://localhost:4186',
        HOURMERE_API_KEY: 'hm_synthetic',
      },
      stdin: (async function* () {
        yield JSON.stringify({ bookingId, attendeeId, noShow: false })
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (input, init) => {
        if (caller.kind === 'oauth') {
          const headers = new Headers(init?.headers)
          headers.set('authorization', 'Bearer synthetic.oauth.token')
          return app.request(input, { ...init, headers })
        }
        return app.request(input, init)
      },
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
  it('enforces session-only team administration across REST, MCP and CLI', async () => {
    const { createTestUser, createTestTeam } = await import('@hourmere/scheduling/testing')
    const host = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: host, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const id = await createFixtures(db).booking(
      team.id,
      [host.id],
      '2026-11-01T09:00Z',
      '2026-11-01T09:30Z',
    )
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', id)
      .executeTakeFirstOrThrow()
    const original = caller
    const cli = async (command: string, input: unknown) => {
      let stdout = '',
        stderr = ''
      const code = await runCli({
        argv: [command, '--input', '-'],
        env: {
          HOURMERE_URL: 'http://localhost:4186',
          HOURMERE_API_KEY: 'hm_synthetic',
        },
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
          if (caller.kind === 'oauth') {
            const headers = new Headers(init?.headers)
            headers.set('authorization', 'Bearer synthetic.oauth.token')
            return app.request(input, { ...init, headers })
          }
          return app.request(input, init)
        },
      })
      return { code, stdout, stderr }
    }
    try {
      for (const role of ['owner', 'admin', 'member']) {
        await db
          .updateTable('auth.member')
          .set({ role })
          .where('organizationId', '=', team.id)
          .where('userId', '=', admin.id)
          .execute()
        for (const actor of [host, admin]) {
          for (const credential of [
            { kind: 'session', sessionId: 'test' },
            ...(['read', 'bookings', 'full'] as const).map((apiKeyScope) => ({
              kind: 'api_key' as const,
              apiKeyScope,
              apiKeyId: 'test',
            })),
            { kind: 'oauth', oauthConsentId: 'test', clientId: 'test', scopes: ['mcp:tools'] },
          ] as const) {
            caller = { ...team.as(actor), ...credential }
            const allowed = actor === host || (credential.kind === 'session' && role !== 'member')
            const headers =
              credential.kind === 'session'
                ? { origin: 'http://localhost:4186', 'content-type': 'application/json' }
                : { authorization: 'Bearer synthetic', 'content-type': 'application/json' }
            // OAuth credentials authenticate MCP only; the shared service matrix covers their reads/writes.
            if (credential.kind !== 'oauth') {
              const read = await app.request(`/api/v1/bookings/${id}/attendees`, { headers })
              expect(read.status).toBe(allowed ? 200 : 404)
              if (!allowed) expect(await read.json()).toMatchObject({ error: 'booking_not_found' })
              const write = await app.request(
                `/api/v1/bookings/${id}/attendees/${attendee.id}/no-show`,
                { method: 'PATCH', headers, body: JSON.stringify({ noShow: true }) },
              )
              expect(write.status).toBe(
                credential.kind === 'api_key' && credential.apiKeyScope === 'read'
                  ? 403
                  : allowed
                    ? 200
                    : 404,
              )
            }
            if (credential.kind !== 'session') {
              const read = await cli('booking-attendees', { bookingId: id })
              expect(read.code).toBe(actor === host ? 0 : 1)
              if (actor !== host) expect(read.stderr).toContain('booking_not_found')
              const write = await cli('set-no-show', {
                bookingId: id,
                attendeeId: attendee.id,
                noShow: true,
              })
              const readOnly = credential.kind === 'api_key' && credential.apiKeyScope === 'read'
              expect(write.code).toBe(actor === host && !readOnly ? 0 : 1)
              if (!readOnly && actor !== host) expect(write.stderr).toContain('booking_not_found')
            }
          }
        }
      }
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
