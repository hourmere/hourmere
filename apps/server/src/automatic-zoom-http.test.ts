import { createHmac, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeBookingConference } from '../../../packages/calendars/src/conferences.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../../packages/conferences/src/testing.ts'
import { createZoomConferenceWork } from '../../../packages/conferences/src/worker.ts'
import { zoomScopes } from '../../../packages/conferences/src/zoom.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { callTool } from '../../../tools/cli/src/client.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { closeServer } from './shutdown.ts'

const bootstrap = process.env.DATABASE_URL,
  NOW = Temporal.Instant.from('2030-11-03T12:00Z')
describe.skipIf(!bootstrap)('automatic Zoom real TCP/session/API-key boundaries', () => {
  let owned: TestDatabase,
    db: Db,
    server: Server,
    authPool: ReturnType<typeof createAuthPool>,
    auth: ReturnType<typeof createAuth>,
    url: string,
    port: number
  let owner: Awaited<ReturnType<ReturnType<typeof createFixtures>['host']>>,
    host: typeof owner,
    team: string,
    ownerCookie: string,
    hostCookie: string,
    key: string,
    provider: ReturnType<typeof fakeZoom>
  const secret = randomBytes(32).toString('base64')
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    const f = createFixtures(db)
    owner = await f.host({ handle: 'zoom-admin', timeZone: 'UTC' })
    host = await f.host({ handle: 'zoom-private-host', timeZone: 'UTC' })
    team = await f.organization('http-zoom-team')
    await f.member(owner.userId, team, 'owner')
    await f.member(host.userId, team, 'admin')
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', resolve)
    })
    const address = probe.address()
    if (!address || typeof address === 'string') throw new Error('Owned listener address missing')
    port = address.port
    await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())))
    url = `http://127.0.0.1:${port}`
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      secret,
      baseURL: url,
      signup,
      mailer: {
        send: async () => {
          throw new Error('Synthetic HTTP must not send mail')
        },
      },
    })
    async function session(userId: string) {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId,
          activeOrganizationId: team,
          token,
          updatedAt: new Date(),
          expiresAt: new Date('2035-01-01Z'),
        })
        .execute()
      return `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`
    }
    ownerCookie = await session(owner.userId)
    hostCookie = await session(host.userId)
    const created = await auth.api.createApiKey({
      body: { userId: host.userId, name: 'synthetic-host-key', metadata: { organizationId: team } },
    })
    key = created.key
    provider = fakeZoom(url, () => NOW.epochMilliseconds)
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    // Product routes use their supplied service clock; inject the real fixed test clock via
    // the same route factories rather than altering browser/session expiry evaluation.
    const { eventTypeRoutes } = await import('./routes/event-types.ts'),
      { publicRoutes } = await import('./routes/public.ts'),
      { bookingRoutes } = await import('./routes/bookings.ts'),
      { conferenceRoutes } = await import('./routes/conferences.ts')
    const fixed = createApp({
      publicUrl: url,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      mcp: mcpEndpoint({ tools: bookingTools({ db, automaticZoom: true, now: () => NOW }) }),
      routes: [
        eventTypeRoutes({ db, automaticZoom: true, now: () => NOW }),
        publicRoutes({ db, automaticZoom: true, now: () => NOW }),
        bookingRoutes({ db, automaticZoom: true, now: () => NOW }),
        conferenceRoutes({
          db,
          now: () => NOW.epochMilliseconds,
          zoom: {
            client: provider.client,
            encryptionKey: TEST_CONFERENCE_KEY,
            meetingsEnabled: true,
          },
        }),
      ],
    })
    server = await new Promise<Server>((resolve, reject) => {
      const running = serve({ hostname: '127.0.0.1', port, fetch: fixed.fetch }, () =>
        resolve(running as Server),
      )
      running.once('error', reject)
    })
  })
  afterAll(async () => {
    try {
      if (server) await closeServer(server)
    } finally {
      try {
        await authPool?.end()
      } finally {
        if (owned) {
          await owned.drop()
          const probe = createPool(owned.url)
          try {
            await expect(probe.query('SELECT 1')).rejects.toMatchObject({ code: '3D000' })
          } finally {
            await probe.end()
          }
        }
        if (port) {
          const absent = await new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: '127.0.0.1', port })
            socket.once('connect', () => {
              socket.destroy()
              resolve(false)
            })
            socket.once('error', (error) =>
              resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'),
            )
            socket.setTimeout(1000, () => {
              socket.destroy()
              resolve(false)
            })
          })
          expect(absent).toBe(true)
        }
      }
    }
  })
  const request = (
    path: string,
    method = 'GET',
    cookie = hostCookie,
    body?: object,
    extra: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === 'GET' ? {} : { origin: url }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  it('enforces empty JSON, owner-only live selection and stable saved config across real signed sessions and a real team API key', async () => {
    const authorize = '/api/v1/conference-connections/zoom/authorize-meetings'
    for (const contentType of [undefined, 'text/plain', 'application/json']) {
      const response = await request(
        authorize,
        'POST',
        hostCookie,
        undefined,
        contentType ? { 'content-type': contentType } : {},
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(
      await db.selectFrom('conference_oauth_states').select('state_hash').execute(),
    ).toHaveLength(0)
    expect((await request(authorize, 'POST', '')).status).toBe(401)
    expect(
      (await request(authorize, 'POST', '', {}, { authorization: `Bearer ${key}` })).status,
    ).toBe(403)
    expect(
      (await request(authorize, 'POST', hostCookie, {}, { origin: 'https://untrusted.invalid' }))
        .status,
    ).toBe(403)
    expect(
      await db.selectFrom('conference_oauth_states').select('state_hash').execute(),
    ).toHaveLength(0)
    expect(provider.calls).toHaveLength(0)
    const authorization = await request(authorize, 'POST', hostCookie, {})
    expect(authorization.status).toBe(200)
    const endpoint = new URL(
      ((await authorization.json()) as { authorizationUrl: string }).authorizationUrl,
    )
    const callback = await request(
      `/api/conference/zoom/callback?state=${endpoint.searchParams.get('state')}&code=synthetic-code`,
    )
    expect(callback.headers.get('location')).toBe('/app/conferences?zoom=connected')
    const connection = (
      await db.selectFrom('conference_connections').select('id').executeTakeFirstOrThrow()
    ).id
    expect(
      (
        await request(
          `/api/v1/conference-connections/${connection}/authorize-meetings`,
          'POST',
          ownerCookie,
          {},
        )
      ).status,
    ).toBe(404)
    const input = {
      slug: 'owned-call',
      title: 'Host Zoom',
      durationMinutes: 30,
      hosts: [{ userId: host.userId }],
      location: { kind: 'zoom', autoCreate: true },
      zoomConnectionId: connection,
    }
    const foreign = await request('/api/v1/event-types', 'POST', ownerCookie, {
      ...input,
      slug: 'foreign-call',
    })
    expect(foreign.status).toBe(403)
    expect(((await foreign.json()) as { error: string }).error).toBe('zoom_host_session_required')
    const foreignSelf = await request('/api/v1/event-types', 'POST', ownerCookie, {
      ...input,
      slug: 'wrong-private-owner',
      hosts: [{ userId: owner.userId }],
    })
    expect(foreignSelf.status).toBe(409)
    expect(((await foreignSelf.json()) as { error: string }).error).toBe(
      'automatic_zoom_unavailable',
    )
    const api = await request(
      '/api/v1/event-types',
      'POST',
      '',
      { ...input, slug: 'key-call' },
      { authorization: `Bearer ${key}` },
    )
    expect(api.status).toBe(201)
    const keyEvent = (await api.json()) as { id: string; zoomConnectionId: string }
    expect(keyEvent.zoomConnectionId).toBe(connection)
    expect(
      (
        await request(
          `/api/v1/event-types/${keyEvent.id}`,
          'PATCH',
          '',
          { location: { kind: 'zoom' }, zoomConnectionId: null },
          { authorization: `Bearer ${key}` },
        )
      ).status,
    ).toBe(200)
    const keySelected = await request(
      `/api/v1/event-types/${keyEvent.id}`,
      'PATCH',
      '',
      { location: input.location, zoomConnectionId: connection },
      { authorization: `Bearer ${key}` },
    )
    expect(keySelected.status).toBe(200)
    expect(await keySelected.json()).toMatchObject({
      location: input.location,
      zoomConnectionId: connection,
    })
    const created = await request('/api/v1/event-types', 'POST', hostCookie, input)
    expect(created.status).toBe(201)
    const event = (await created.json()) as { id: string; zoomConnectionId: string }
    expect(event.zoomConnectionId).toBe(connection)
    expect(
      (
        await request(`/api/v1/event-types/${event.id}`, 'PATCH', ownerCookie, {
          title: 'Metadata only',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await request(
          `/api/v1/event-types/${event.id}`,
          'PATCH',
          '',
          { description: 'Key metadata' },
          { authorization: `Bearer ${key}` },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await request(`/api/v1/event-types/${event.id}`, 'PATCH', ownerCookie, {
          location: { kind: 'zoom' },
          zoomConnectionId: null,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await request(`/api/v1/event-types/${event.id}`, 'PATCH', ownerCookie, {
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connection,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(`/api/v1/event-types/${event.id}`, 'PATCH', hostCookie, {
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connection,
        })
      ).status,
    ).toBe(200)
    for (const schedulingType of ['collective', 'round_robin']) {
      const response = await request('/api/v1/event-types', 'POST', hostCookie, {
        ...input,
        slug: `unsupported-${schedulingType.replace('_', '-')}`,
        schedulingType,
        hosts:
          schedulingType === 'collective'
            ? [{ userId: host.userId }, { userId: owner.userId }]
            : [{ userId: host.userId }],
      })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe(
        'automatic_zoom_host_policy',
      )
    }
    const catalog = await request('/api/v1/public/teams/http-zoom-team/owned-call', 'GET', '')
    expect(catalog.status).toBe(200)
    expect(
      /zoomConnectionId|zoom_connection_id|zoom_user_id|synthetic-only/.test(await catalog.text()),
    ).toBe(false)
    const bookingBody = {
      start: '2030-11-04T09:00:00Z',
      invitee: { name: 'Synthetic invitee', email: 'synthetic@example.com', timeZone: 'UTC' },
    }
    const booking = await request(
      '/api/v1/public/teams/http-zoom-team/owned-call/bookings',
      'POST',
      '',
      bookingBody,
      { 'Idempotency-Key': 'synthetic-http-idempotency' },
    )
    expect(booking.status).toBe(201)
    const booked = (await booking.json()) as {
      booking: { id: string; conference: { provider: string; status: string } }
      manageToken: string
    }
    expect(booked.booking.conference).toEqual({
      provider: 'zoom',
      status: 'pending',
      errorCode: null,
    })
    const retry = await request(
      '/api/v1/public/teams/http-zoom-team/owned-call/bookings',
      'POST',
      '',
      bookingBody,
      { 'Idempotency-Key': 'synthetic-http-idempotency' },
    )
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as typeof booked).booking.id).toBe(booked.booking.id)
    provider.controls.meetingHook = async () => {
      throw new Error('synthetic unknown create')
    }
    const worker = {
      db,
      now: () => NOW.epochMilliseconds,
      zoomConferenceWork: createZoomConferenceWork(
        {
          db,
          now: () => NOW.epochMilliseconds,
          zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
        },
        provider.meetings,
      ),
    }
    await writeBookingConference(worker, booked.booking.id)
    expect(
      (
        await request(
          `/api/v1/bookings/${booked.booking.id}/conference/retry`,
          'POST',
          ownerCookie,
          {},
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          `/api/v1/bookings/${booked.booking.id}/conference/retry`,
          'POST',
          '',
          {},
          { authorization: `Bearer ${key}` },
        )
      ).status,
    ).toBe(204)
    provider.controls.meetingHook = undefined
    await writeBookingConference(worker, booked.booking.id)
    expect(
      provider.calls.filter(
        (c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'),
      ),
    ).toHaveLength(1)
    const managed = await request('/api/v1/bookings/manage', 'GET', '', undefined, {
      'X-Manage-Token': booked.manageToken,
    })
    expect(managed.status).toBe(200)
    expect(
      /zoom_connection_id|zoom_user_id|zoom_meeting_id|zoomConnectionId|synthetic-private-start/.test(
        await managed.text(),
      ),
    ).toBe(false)
  })
  it('runs Zoom booking, same-key recovery, same-ID reschedule/cancellation and conservative retry through real MCP and CLI HTTP', async () => {
    const authorization = await request(
      '/api/v1/conference-connections/zoom/authorize-meetings',
      'POST',
      hostCookie,
      {},
    )
    expect(authorization.status).toBe(200)
    const endpoint = new URL(
      ((await authorization.json()) as { authorizationUrl: string }).authorizationUrl,
    )
    expect(
      (
        await request(
          `/api/conference/zoom/callback?state=${endpoint.searchParams.get('state')}&code=synthetic-code`,
        )
      ).status,
    ).toBe(303)
    const connection = (
      await db
        .selectFrom('conference_connections')
        .select('id')
        .where('user_id', '=', host.userId)
        .executeTakeFirstOrThrow()
    ).id
    expect(
      (
        await request('/api/v1/event-types', 'POST', hostCookie, {
          slug: 'mcp-zoom',
          title: 'MCP Zoom',
          durationMinutes: 30,
          hosts: [{ userId: host.userId }],
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connection,
        })
      ).status,
    ).toBe(201)
    const mcp = (tool: string, input: Record<string, unknown>) =>
      callTool({ url: new URL('/mcp', url), key, tool, input })
    const cli = async (command: string, input: Record<string, unknown>) => {
      let stdout = '',
        stderr = ''
      const code = await runCli({
        argv: [command, '--input', '-'],
        env: { HOURMERE_URL: url, HOURMERE_API_KEY: key },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (value) => {
          stdout += value
        },
        stderr: (value) => {
          stderr += value
        },
      })
      expect((stdout + stderr).includes(key)).toBe(false)
      expect(stderr).toBe('')
      expect(code).toBe(0)
      return JSON.parse(stdout) as Record<string, unknown>
    }
    const requestBody = {
      teamSlug: 'http-zoom-team',
      slug: 'mcp-zoom',
      start: '2030-11-04T15:00:00Z',
      invitee: { name: 'MCP Synthetic', email: 'mcp-zoom@hourmere.invalid', timeZone: 'UTC' },
      idempotencyKey: 'mcp-zoom-key',
    }
    const booking = (await mcp('create_booking', requestBody)) as {
      booking: { id: string; conference: unknown }
      manageToken: string
      replayed: boolean
    }
    expect(booking.booking.conference).toEqual({
      provider: 'zoom',
      status: 'pending',
      errorCode: null,
    })
    const worker = {
      db,
      now: () => NOW.epochMilliseconds,
      zoomConferenceWork: createZoomConferenceWork(
        {
          db,
          now: () => NOW.epochMilliseconds,
          zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
        },
        provider.meetings,
      ),
    }
    const postsBefore = provider.calls.filter(
      (c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'),
    ).length
    await writeBookingConference(worker, booking.booking.id)
    const replay = (await mcp('create_booking', requestBody)) as typeof booking
    expect(replay.booking.id).toBe(booking.booking.id)
    expect(replay.replayed).toBe(true)
    const own = (await mcp('list_bookings', {})) as {
      data: {
        id: string
        location?: { url?: string }
        conference?: { status: string }
        calendarCopy?: { status: string }
      }[]
    }
    const listed = own.data.find((b) => b.id === booking.booking.id)
    expect(listed?.conference?.status).toBe('ready')
    expect(listed?.calendarCopy?.status).toBe('not_configured')
    expect(listed?.location?.url?.includes('/j/81234567890')).toBe(true)
    expect(
      /zoomConnectionId|zoom_connection_id|zoom_user_id|zoom_meeting_id|synthetic-private-start|synthetic-raw-passcode/.test(
        JSON.stringify(own),
      ),
    ).toBe(false)
    // A verified identity change leaves immutable invitation pins unavailable. Every
    // booking transport must use the same non-ready location mapping, not expose a stale URL.
    const oldEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
    ).email
    await db
      .updateTable('auth.user')
      .set({ email: 'changed-verified-zoom@hourmere.invalid' })
      .where('id', '=', host.userId)
      .execute()
    try {
      const assertUnavailable = (value: unknown) => {
        expect(typeof value === 'object' && value !== null).toBe(true)
        const response = value as
          | {
              location?: { url?: string }
              conference?: { status: string; errorCode: string | null }
            }
          | undefined
        expect(response?.conference).toMatchObject({
          status: 'failed',
          errorCode: 'organizer_unavailable',
        })
        expect(response?.location?.url === undefined).toBe(true)
      }
      const details = await request(
        `/api/v1/bookings/${booking.booking.id}`,
        'GET',
        '',
        undefined,
        { authorization: `Bearer ${key}` },
      )
      expect(details.status).toBe(200)
      assertUnavailable(await details.json())
      const management = await request('/api/v1/bookings/manage', 'GET', '', undefined, {
        'X-Manage-Token': booking.manageToken,
      })
      expect(management.status).toBe(200)
      assertUnavailable(await management.json())
      const listing = await request('/api/v1/bookings', 'GET', '', undefined, {
        authorization: `Bearer ${key}`,
      })
      expect(listing.status).toBe(200)
      type Unavailable = {
        id: string
        location?: { url?: string }
        conference?: { status: string; errorCode: string | null }
      }
      assertUnavailable(
        ((await listing.json()) as { data: Unavailable[] }).data.find(
          (b) => b.id === booking.booking.id,
        ),
      )
      const mcpList = (await mcp('list_bookings', {})) as { data: Unavailable[] }
      assertUnavailable(mcpList.data.find((b) => b.id === booking.booking.id))
      const cliList = (await cli('list', {})) as { data: Unavailable[] }
      assertUnavailable(cliList.data.find((b) => b.id === booking.booking.id))
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('location')
            .where('id', '=', booking.booking.id)
            .executeTakeFirstOrThrow()
        ).location,
      ).toHaveProperty('url')
    } finally {
      await db
        .updateTable('auth.user')
        .set({ email: oldEmail })
        .where('id', '=', host.userId)
        .execute()
    }
    const moved = (await mcp('reschedule_booking', {
      bookingId: booking.booking.id,
      start: '2030-11-04T16:00:00Z',
    })) as typeof booking
    await writeBookingConference(worker, booking.booking.id)
    const assertCancelled = (value: unknown, cleaned: boolean) => {
      const response = value as
        | { status?: string; location?: { url?: string }; conference?: { status: string } }
        | undefined
      expect(response?.status).toBe('cancelled')
      expect(response?.location?.url === undefined).toBe(true)
      expect(response?.conference?.status).toBe(cleaned ? 'ready' : 'pending')
    }
    const cancelledViews = async (cleaned: boolean) => {
      const details = await request(`/api/v1/bookings/${moved.booking.id}`, 'GET', '', undefined, {
        authorization: `Bearer ${key}`,
      })
      expect(details.status).toBe(200)
      assertCancelled(await details.json(), cleaned)
      const manage = await request('/api/v1/bookings/manage', 'GET', '', undefined, {
        'X-Manage-Token': moved.manageToken,
      })
      expect(manage.status).toBe(200)
      assertCancelled(await manage.json(), cleaned)
      type Item = { id: string }
      const rest = await request('/api/v1/bookings', 'GET', '', undefined, {
        authorization: `Bearer ${key}`,
      })
      expect(rest.status).toBe(200)
      assertCancelled(
        ((await rest.json()) as { data: Item[] }).data.find((b) => b.id === moved.booking.id),
        cleaned,
      )
      const mcpList = (await mcp('list_bookings', {})) as { data: Item[] }
      assertCancelled(
        mcpList.data.find((b) => b.id === moved.booking.id),
        cleaned,
      )
      const cliList = (await cli('list', {})) as { data: Item[] }
      assertCancelled(
        cliList.data.find((b) => b.id === moved.booking.id),
        cleaned,
      )
      const raw = (
        await db
          .selectFrom('bookings')
          .select('location')
          .where('id', '=', moved.booking.id)
          .executeTakeFirstOrThrow()
      ).location
      expect(
        typeof raw === 'object' && raw !== null && 'url' in raw && typeof raw.url === 'string',
      ).toBe(true)
    }
    assertCancelled(await cli('cancel', { bookingId: moved.booking.id }), false)
    await cancelledViews(false)
    await writeBookingConference(worker, booking.booking.id)
    await cancelledViews(true)
    expect(
      provider.calls.filter(
        (c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'),
      ),
    ).toHaveLength(postsBefore + 1)
    expect(
      provider.calls
        .filter(
          (c) =>
            ['PATCH', 'DELETE'].includes(c.init.method ?? '') &&
            c.url.endsWith('/meetings/81234567890'),
        )
        .map((c) => c.init.method),
    ).toEqual(['PATCH', 'DELETE'])
    expect(provider.controls.storedMeetings.size).toBe(0)
    const unknown = (await mcp('create_booking', {
      ...requestBody,
      idempotencyKey: 'mcp-unknown-key',
    })) as typeof booking
    provider.controls.meetingHook = async () => {
      throw new Error('synthetic unknown create')
    }
    await writeBookingConference(worker, unknown.booking.id)
    expect(await cli('retry-meeting', { bookingId: unknown.booking.id })).toEqual({
      accepted: true,
    })
    provider.controls.meetingHook = undefined
    await writeBookingConference(worker, unknown.booking.id)
    expect(
      (
        await db
          .selectFrom('booking_conferences')
          .select('error_code')
          .where('root_booking_id', '=', unknown.booking.id)
          .executeTakeFirstOrThrow()
      ).error_code,
    ).toBe('ambiguous_create')
    expect(
      provider.calls.filter(
        (c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'),
      ),
    ).toHaveLength(postsBefore + 2)
    await expect(
      mcp('retry_conference', { bookingId: unknown.booking.id, forceCreate: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
