import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calendarTestSession,
  fakeGoogle,
  fakeMicrosoft,
  TEST_CALENDAR_KEY,
  TEST_PUBLIC_URL,
} from '../../../../packages/calendars/src/testing.ts'
import { createApp } from '../app.ts'
import { calendarRoutes } from './calendars.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('calendar HTTP routes (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let provider: ReturnType<typeof fakeGoogle>
  let microsoft: ReturnType<typeof fakeMicrosoft>
  let app: ReturnType<typeof createApp>
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
  })
  beforeEach(async () => {
    await db.deleteFrom('calendar_connections').execute()
    await db.deleteFrom('calendar_oauth_states').execute()
    provider = fakeGoogle()
    microsoft = fakeMicrosoft()
    app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      publicUrl: TEST_PUBLIC_URL,
      resolveCaller: async (headers) => {
        const cookie = headers.get('cookie')
        const principal = headers.has('authorization')
          ? {
              kind: 'api_key' as const,
              apiKeyId: owner.sessionId,
              user: owner.user,
              organization: owner.organization,
            }
          : cookie === 'owner'
            ? owner
            : undefined
        return principal
          ? { ok: true, principal, setCookie: ['test-session=extended; HttpOnly'] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [
        calendarRoutes({
          db,
          google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
          microsoft: { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
        }),
      ],
    })
  })
  afterAll(async () => {
    await database?.drop()
  })
  const request = (
    path: string,
    method = 'GET',
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: 'owner',
        origin: TEST_PUBLIC_URL,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { body }),
    })
  async function start() {
    const response = await request('/api/v1/calendar-connections/google/authorize', 'POST', '{}')
    expect(response.status).toBe(200)
    const data = (await response.json()) as { authorizationUrl: string }
    return new URL(data.authorizationUrl).searchParams.get('state') as string
  }

  it('protects the Microsoft authorization endpoint with browser sessions, origin and strict input', async () => {
    for (const [headers, expected] of [
      [{ cookie: '' }, 401],
      [{ origin: 'https://attacker.example' }, 403],
      [{ authorization: 'Bearer hm_test' }, 403],
    ] as const) {
      expect(
        (await request('/api/v1/calendar-connections/microsoft/authorize', 'POST', '{}', headers))
          .status,
      ).toBe(expected)
    }
    expect(
      (
        await request(
          '/api/v1/calendar-connections/microsoft/authorize',
          'POST',
          '{"access":"sync"}',
        )
      ).status,
    ).toBe(400)
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toEqual([])
  })

  it('keeps Microsoft callback secrets out of redirects and logs, then refreshes and disconnects', async () => {
    const response = await request('/api/v1/calendar-connections/microsoft/authorize', 'POST', '{}')
    expect(response.status).toBe(200)
    const { authorizationUrl } = (await response.json()) as { authorizationUrl: string }
    const state = new URL(authorizationUrl).searchParams.get('state') as string
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const wrong = await request(`/api/calendar/google/callback?state=${state}&code=fake-ms-code`)
      expect(wrong.headers.get('location')).toBe('/app/calendars?connection=invalid_state')
      expect(microsoft.calls).toHaveLength(0)
      expect(provider.calls).toHaveLength(0)
      const callback = await request(
        `/api/calendar/microsoft/callback?state=${state}&code=fake-ms-code&next=https://attacker.example`,
      )
      expect(callback.status).toBe(303)
      expect(callback.headers.get('location')).toBe(
        '/app/calendars?connection=connected&provider=microsoft',
      )
      expect(callback.headers.get('cache-control')).toBe('no-store')
      expect(callback.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await callback.text()).not.toMatch(/fake-ms-code|fake-microsoft/)
      expect(JSON.stringify(log.mock.calls)).not.toContain(state)
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/fake-ms-code|fake-microsoft/)
    } finally {
      log.mockRestore()
    }
    const list = (await (await request('/api/v1/calendar-connections')).json()) as {
      microsoftEnabled: boolean
      data: { id: string; provider: string; syncAuthorized: boolean }[]
    }
    expect(list.microsoftEnabled).toBe(true)
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({ provider: 'microsoft', syncAuthorized: false })
    const id = list.data[0]!.id
    expect((await request(`/api/v1/calendar-connections/${id}/refresh`, 'POST', '{}')).status).toBe(
      204,
    )
    expect((await request(`/api/v1/calendar-connections/${id}`, 'DELETE')).status).toBe(204)
    expect(await db.selectFrom('calendar_connections').selectAll().execute()).toEqual([])
    expect(await db.selectFrom('calendars').selectAll().execute()).toEqual([])
  })

  it('redirects unauthenticated Microsoft callbacks to a clean sign-in notice', async () => {
    const response = await request(
      '/api/calendar/microsoft/callback?state=private&code=private',
      'GET',
      undefined,
      { cookie: '' },
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/app/calendars?connection=session_required')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('requires same-origin browser sessions and validates bodies before creating a state', async () => {
    for (const [headers, expected] of [
      [{ cookie: '' }, 401],
      [{ origin: 'https://attacker.example' }, 403],
      [{ authorization: 'Bearer hm_test' }, 403],
    ] as const) {
      const res = await request(
        '/api/v1/calendar-connections/google/authorize',
        'POST',
        '{}',
        headers,
      )
      expect(res.status).toBe(expected)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(
      (
        await request(
          '/api/v1/calendar-connections/google/authorize',
          'POST',
          '{"next":"https://attacker.example"}',
        )
      ).status,
    ).toBe(400)
    expect(
      (await request('/api/v1/calendar-connections/google/authorize', 'POST', '{broken')).status,
    ).toBe(400)
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toEqual([])
  })

  it('redirects a successful callback to a fixed clean page and never logs codes/state', async () => {
    const state = await start()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const response = await request(
        `/api/calendar/google/callback?state=${state}&code=fake-callback-secret&next=https://attacker.example`,
      )
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/app/calendars?connection=connected')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('set-cookie')).toContain('test-session=extended')
      expect(await response.text()).not.toMatch(
        /fake-callback-secret|fake-access-token|fake-refresh-token/,
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain(state)
      expect(JSON.stringify(log.mock.calls)).not.toContain('fake-callback-secret')
    } finally {
      log.mockRestore()
    }
    const listed = await request('/api/v1/calendar-connections')
    expect(listed.status).toBe(200)
    expect(JSON.stringify(await listed.json())).not.toMatch(
      /credentials|fake-access-token|fake-refresh-token/,
    )
  })

  it('handles missing sessions and untrusted errors without copying them to redirects', async () => {
    const state = await start()
    const unauthenticated = await request(
      `/api/calendar/google/callback?state=${state}&code=secret`,
      'GET',
      undefined,
      { cookie: '' },
    )
    expect(unauthenticated.headers.get('location')).toBe(
      '/app/calendars?connection=session_required',
    )
    const denied = await request(
      `/api/calendar/google/callback?state=${state}&error=access_denied&error_description=private-secret`,
    )
    expect(denied.headers.get('location')).toBe('/app/calendars?connection=denied')
    const replay = await request(`/api/calendar/google/callback?state=${state}&code=secret`)
    expect(replay.headers.get('location')).toBe('/app/calendars?connection=invalid_state')
  })

  it('protects settings and sync writes before parsing bodies', async () => {
    const id = 'a0000000-0000-7000-8000-000000000001'
    const paths: [string, string][] = [
      [`/api/v1/calendars/${id}`, 'PATCH'],
      [`/api/v1/calendars/${id}/sync`, 'POST'],
      ['/api/v1/calendar-destination', 'PUT'],
    ]
    const headersCases: Record<string, string>[] = [
      { origin: 'https://attacker.example' },
      { authorization: 'Bearer hm_test' },
    ]
    for (const [path, method] of paths)
      for (const headers of headersCases)
        expect((await request(path, method, '{broken', headers)).status).toBe(403)
  })

  it('bounds authorization attempts before reading a large body', async () => {
    for (let i = 0; i < 30; i++)
      expect(
        (await request('/api/v1/calendar-connections/google/authorize', 'POST', '{}')).status,
      ).toBe(200)
    const limited = await request(
      '/api/v1/calendar-connections/google/authorize',
      'POST',
      '{invalid-json',
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).not.toBeNull()
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toHaveLength(5)
  })
})
