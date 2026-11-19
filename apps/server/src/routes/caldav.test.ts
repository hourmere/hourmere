import { type CalDavTransport, createCalDavDiscovery } from '@hourmere/calendars/caldav'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calendarTestSession,
  TEST_CALENDAR_KEY,
  TEST_PUBLIC_URL,
} from '../../../../packages/calendars/src/testing.ts'
import { createApp } from '../app.ts'
import { caldavRoutes } from './caldav.ts'
import { calendarRoutes } from './calendars.ts'

const credentials = {
  serverUrl: 'https://dav.example.com/',
  username: 'synthetic-private-login',
  password: 'synthetic-private-password',
}
const path = '/api/v1/calendar-connections/caldav'
const xml = (href: string, props: string) =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`

describe.skipIf(!process.env.DATABASE_URL)('CalDAV browser HTTP boundary (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof calendarTestSession>>,
    other: typeof owner
  let app: ReturnType<typeof createApp>,
    transport: ReturnType<typeof vi.fn<CalDavTransport>>,
    enqueue: ReturnType<typeof vi.fn<(calendarId: string, transaction: Db) => Promise<void>>>,
    recover: ReturnType<typeof vi.fn<(connectionId: string, transaction: Db) => Promise<void>>>,
    rejected: boolean,
    removed: boolean
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    await db
      .insertInto('auth.apikey')
      .values({
        id: owner.sessionId,
        configId: 'default',
        referenceId: owner.user.id,
        key: 'synthetic-caldav-http-key',
        metadata: JSON.stringify({ organizationId: owner.organization.id }),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'caldav-http-owner', time_zone: 'UTC' })
      .execute()
  })
  afterAll(async () => {
    await database?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('calendar_connections').execute()
    rejected = false
    removed = false
    enqueue = vi.fn(async () => {})
    recover = vi.fn(async () => {})
    transport = vi.fn(async (request) => {
      if (rejected) return { status: 401, body: credentials.password }
      const pathname = new URL(request.url).pathname
      return {
        status: 207,
        body:
          pathname === '/.well-known/caldav'
            ? xml(
                pathname,
                '<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>',
              )
            : pathname === '/principal/'
              ? xml(
                  pathname,
                  '<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set>',
                )
              : removed
                ? '<d:multistatus xmlns:d="DAV:"/>'
                : xml(
                    `/calendars/${credentials.username}/events/`,
                    `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${credentials.password}</d:displayname><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>`,
                  ),
      }
    })
    const deps = {
      db,
      caldav: {
        discoveryClient: createCalDavDiscovery(transport),
        syncClient: {
          sync: async () => {
            throw new Error('unexpected sync')
          },
        },
        encryptionKey: TEST_CALENDAR_KEY,
        enqueueSync: enqueue,
        enqueueWritebackRecovery: recover,
      },
    }
    app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      publicUrl: TEST_PUBLIC_URL,
      resolveCaller: async (headers) => {
        const principal = headers.has('authorization')
          ? {
              kind: 'api_key' as const,
              apiKeyScope: 'full' as const,
              apiKeyId: owner.sessionId,
              user: owner.user,
              organization: owner.organization,
            }
          : headers.get('cookie') === 'owner'
            ? owner
            : headers.get('cookie') === 'other'
              ? other
              : undefined
        return principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [calendarRoutes(deps), caldavRoutes(deps)],
    })
  })
  const request = (
    url: string,
    method = 'POST',
    body: unknown = credentials,
    headers: Record<string, string> = {},
  ) =>
    app.request(url, {
      method,
      headers: {
        cookie: 'owner',
        origin: TEST_PUBLIC_URL,
        'content-type': 'application/json',
        ...headers,
      },
      ...(method === 'GET' || method === 'DELETE'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  async function discover() {
    const response = await request(`${path}/discover`)
    expect(response.status).toBe(200)
    return (await response.json()) as {
      calendars: { key: string; displayName: string; canWrite: boolean }[]
    }
  }
  async function save() {
    const { calendars } = await discover()
    const key = calendars[0]?.key
    if (!key) throw new Error('Expected discovered calendar')
    const input = {
      ...credentials,
      calendarKeys: [key],
      conflictCalendarKeys: [key],
      destinationCalendarKey: key,
    }
    const response = await request(path, 'POST', input)
    expect(response.status).toBe(200)
    return { input, id: ((await response.json()) as { id: string }).id }
  }
  it('discovers without persistence or credential echoes; saves selections and encrypted credentials atomically', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}),
      error = vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const found = await discover()
      expect(found.calendars).toEqual([
        {
          key: expect.stringMatching(/^[a-f0-9]{64}$/),
          displayName: 'Calendar',
          color: null,
          canWrite: true,
        },
      ])
      expect(await db.selectFrom('calendar_connections').select('id').execute()).toEqual([])
      const { id } = await save()
      const listed = await request('/api/v1/calendar-connections', 'GET')
      const text = await listed.text()
      expect(listed.headers.get('cache-control')).toBe('no-store')
      expect(JSON.parse(text)).toMatchObject({
        caldavEnabled: true,
        data: [
          {
            id,
            provider: 'caldav',
            calendars: [{ checkConflicts: true, available: true, lastSyncedAt: null }],
          },
        ],
      })
      const row = await db
        .selectFrom('calendars')
        .select('id')
        .where('connection_id', '=', id)
        .executeTakeFirstOrThrow()
      expect(
        await db
          .selectFrom('profiles')
          .select('destination_calendar_id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ destination_calendar_id: row.id })
      expect(enqueue).toHaveBeenCalledWith(row.id, expect.anything())
      const record = await db
        .selectFrom('calendar_connections')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      for (const secret of Object.values(credentials)) {
        expect(text + JSON.stringify(found) + JSON.stringify(record)).not.toContain(secret)
        expect(JSON.stringify([log.mock.calls, error.mock.calls, warn.mock.calls])).not.toContain(
          secret,
        )
      }
    } finally {
      log.mockRestore()
      error.mockRestore()
      warn.mockRestore()
    }
  })
  it('rejects unauthorized callers and cross-origin writes before parsing bodies or outbound requests', async () => {
    for (const endpoint of [path, `${path}/discover`])
      for (const [headers, status] of [
        [{ cookie: '' }, 401],
        [{ authorization: 'Bearer synthetic' }, 403],
        [{ origin: 'https://attacker.example' }, 403],
      ] as const) {
        expect((await request(endpoint, 'POST', '{broken', headers)).status).toBe(status)
      }
    expect(transport).not.toHaveBeenCalled()
  })
  it('does not reveal or reconnect another owner’s connection, including discovery', async () => {
    const { id, input } = await save()
    transport.mockClear()
    for (const endpoint of [path, `${path}/discover`]) {
      const response = await request(
        endpoint,
        'POST',
        endpoint === path ? { ...input, connectionId: id } : { ...credentials, connectionId: id },
        { cookie: 'other' },
      )
      expect(response.status).toBe(404)
    }
    expect(transport).not.toHaveBeenCalled()
    const list = await request('/api/v1/calendar-connections', 'GET', undefined, {
      cookie: 'other',
    })
    expect(await list.json()).toMatchObject({ data: [] })
    expect(
      (
        await request(`/api/v1/calendar-connections/${id}`, 'DELETE', undefined, {
          cookie: 'other',
        })
      ).status,
    ).toBe(404)
  })
  it('reconnects in place and leaves prior state untouched after rejected credentials or invalid selections', async () => {
    const { id, input } = await save()
    const before = await db
      .selectFrom('calendars')
      .selectAll()
      .where('connection_id', '=', id)
      .executeTakeFirstOrThrow()
    rejected = true
    const failed = await request(path, 'POST', {
      ...input,
      connectionId: id,
      password: 'wrong-private-password',
    })
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: 'caldav_needs_reauth' })
    expect(
      await db
        .selectFrom('calendars')
        .selectAll()
        .where('id', '=', before.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before)
    rejected = false
    expect(
      (
        await request(path, 'POST', {
          ...input,
          connectionId: id,
          conflictCalendarKeys: ['f'.repeat(64)],
        })
      ).status,
    ).toBe(400)
    const response = await request(path, 'POST', {
      ...input,
      connectionId: id,
      password: 'replacement-private-password',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(id, expect.objectContaining({ isTransaction: true }))
    expect(
      await db.selectFrom('calendars').select('id').where('connection_id', '=', id).execute(),
    ).toEqual([{ id: before.id }])
  })
  it('refuses agent changes to CalDAV selections, sync, destination and disconnect', async () => {
    const { id } = await save()
    const calendar = await db
      .selectFrom('calendars')
      .select('id')
      .where('connection_id', '=', id)
      .executeTakeFirstOrThrow()
    const headers = { authorization: 'Bearer synthetic', cookie: '', origin: '' }
    for (const [url, method, body] of [
      [`/api/v1/calendars/${calendar.id}`, 'PATCH', { checkConflicts: false }],
      [`/api/v1/calendars/${calendar.id}/sync`, 'POST', {}],
      ['/api/v1/calendar-destination', 'PUT', { calendarId: calendar.id }],
      ['/api/v1/calendar-destination', 'PUT', { calendarId: null }],
      [`/api/v1/calendar-connections/${id}`, 'DELETE', {}],
    ] as const) {
      const response = await request(url, method, body, headers)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'session_required' })
    }
    expect(
      await db
        .selectFrom('profiles')
        .select('destination_calendar_id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ destination_calendar_id: calendar.id })
  })
  it('keeps a removed selected calendar unavailable and selected after reconnect', async () => {
    const { id, input } = await save()
    removed = true
    const response = await request(path, 'POST', {
      ...input,
      connectionId: id,
      calendarKeys: [],
      conflictCalendarKeys: [],
      destinationCalendarKey: null,
    })
    expect(response.status).toBe(200)
    const listed = await request('/api/v1/calendar-connections', 'GET')
    expect(await listed.json()).toMatchObject({
      data: [
        {
          calendars: [
            { checkConflicts: true, available: false, syncError: 'provider_unavailable' },
          ],
        },
      ],
    })
  })
  it('requires a live owner session again after discovery completes', async () => {
    const real = transport.getMockImplementation()
    if (!real) throw new Error('Expected fake transport')
    transport.mockImplementation(async (request) => {
      const result = await real(request)
      if (new URL(request.url).pathname === '/calendars/')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', owner.sessionId)
          .execute()
      return result
    })
    try {
      expect((await request(`${path}/discover`)).status).toBe(403)
      expect(await db.selectFrom('calendar_connections').select('id').execute()).toEqual([])
    } finally {
      await db
        .updateTable('auth.session')
        .set({ expiresAt: new Date(Date.now() + 86400_000) })
        .where('id', '=', owner.sessionId)
        .execute()
    }
  })
  it('never echoes credential-bearing invalid property names or provider failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const endpoint of [path, `${path}/discover`]) {
        const response = await request(endpoint, 'POST', {
          ...credentials,
          [credentials.password]: true,
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_request' })
      }
      transport.mockRejectedValue(new Error(credentials.password))
      const failed = await request(`${path}/discover`)
      expect(failed.status).toBe(409)
      expect(await failed.text()).not.toContain(credentials.password)
      expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
        credentials.password,
      )
    } finally {
      log.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })
  it('rejects unsafe URLs and caller-supplied outbound exceptions without network access', async () => {
    expect(
      (
        await request(`${path}/discover`, 'POST', {
          ...credentials,
          serverUrl: 'https://127.0.0.1/',
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request(`${path}/discover`, 'POST', {
          ...credentials,
          allowedOrigins: ['https://evil.example'],
        })
      ).status,
    ).toBe(400)
    expect(transport).not.toHaveBeenCalled()
  })
  it('disconnects local credentials and calendars without provider delete or password revocation calls', async () => {
    const { id } = await save()
    transport.mockClear()
    expect((await request(`/api/v1/calendar-connections/${id}`, 'DELETE')).status).toBe(204)
    expect(await db.selectFrom('calendar_connections').select('id').execute()).toEqual([])
    expect(await db.selectFrom('calendars').select('id').execute()).toEqual([])
    expect(
      await db
        .selectFrom('profiles')
        .select('destination_calendar_id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ destination_calendar_id: null })
    expect(transport).not.toHaveBeenCalled()
  })
})
