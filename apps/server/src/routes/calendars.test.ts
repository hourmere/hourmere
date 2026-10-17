import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calendarTestSession,
  fakeGoogle,
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
