import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../../packages/calendars/src/google.ts'
import {
  calendarTestSession,
  fakeGoogle,
  fakeMicrosoft,
  TEST_CALENDAR_KEY,
  TEST_PUBLIC_URL,
} from '../../../../packages/calendars/src/testing.ts'
import { createTestTeam } from '../../../../packages/scheduling/src/testing.ts'
import { createApp } from '../app.ts'
import { calendarRoutes } from './calendars.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('calendar HTTP routes (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let ownerInTeam: typeof owner
  let otherInTeam: typeof owner
  let provider: ReturnType<typeof fakeGoogle>
  let microsoft: ReturnType<typeof fakeMicrosoft>
  let app: ReturnType<typeof createApp>
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    const team = await createTestTeam(db, [
      { user: { ...owner.user, principal: owner }, role: 'owner' },
      { user: { ...other.user, principal: other }, role: 'admin' },
    ])
    ownerInTeam = {
      ...owner,
      organization: team.as({ ...owner.user, principal: owner }).organization,
    }
    otherInTeam = { ...other, organization: ownerInTeam.organization }
    for (const principal of [owner, ownerInTeam, otherInTeam])
      await db
        .insertInto('auth.apikey')
        .values({
          id: principal === ownerInTeam ? team.id : principal.sessionId,
          configId: 'default',
          referenceId: principal.user.id,
          key: `synthetic-${principal === ownerInTeam ? team.id : principal.sessionId}`,
          metadata: JSON.stringify({ organizationId: principal.organization.id }),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'calendar-http-owner', time_zone: 'UTC' })
      .execute()
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
        const keyOwner =
          headers.get('authorization') === 'Bearer hm_other'
            ? otherInTeam
            : headers.get('authorization') === 'Bearer hm_team'
              ? ownerInTeam
              : owner
        const principal = headers.has('authorization')
          ? {
              kind: 'api_key' as const,
              apiKeyId: keyOwner === ownerInTeam ? ownerInTeam.organization.id : keyOwner.sessionId,
              user: keyOwner.user,
              organization: keyOwner.organization,
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
  async function start(access: 'list' | 'sync' = 'list') {
    const response = await request(
      '/api/v1/calendar-connections/google/authorize',
      'POST',
      JSON.stringify({ access }),
    )
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
    expect(
      (
        await request(`/api/v1/calendar-connections/${id}/refresh`, 'POST', '{}', {
          authorization: 'Bearer hm_test',
          cookie: '',
          origin: '',
        })
      ).status,
    ).toBe(204)
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
      [`/api/v1/calendar-connections/${id}/refresh`, 'POST'],
    ]
    const headersCases: Record<string, string>[] = [
      { origin: 'https://attacker.example' },
      { cookie: '' },
    ]
    for (const [path, method] of paths)
      for (const headers of headersCases)
        expect((await request(path, method, '{broken', headers)).status).toBe(
          headers.cookie === '' ? 401 : 403,
        )
  })

  it.each(['hm_test', 'hm_team'])(
    'lets an owner API key list, refresh, select, sync and set its destination across acting organizations (%s)',
    async (key) => {
      provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
      const state = await start('sync')
      await request(`/api/calendar/google/callback?state=${state}&code=fake-code`)
      const headers = { authorization: `Bearer ${key}`, cookie: '', origin: '' }
      const listed = await request('/api/v1/calendar-connections', 'GET', undefined, headers)
      expect(listed.status).toBe(200)
      const data = (await listed.json()) as { data: { id: string; calendars: { id: string }[] }[] }
      const connection = data.data[0]
      if (!connection) throw new Error('Expected the owner connection')
      const id = connection.calendars[0]?.id
      expect(id).toBeDefined()
      expect(JSON.stringify(data)).not.toMatch(/credentials|fake-access-token|fake-refresh-token/)
      expect(
        (
          await request(
            `/api/v1/calendar-connections/${connection.id}/refresh`,
            'POST',
            '{}',
            headers,
          )
        ).status,
      ).toBe(204)
      expect(
        (await request(`/api/v1/calendars/${id}`, 'PATCH', '{"checkConflicts":true}', headers))
          .status,
      ).toBe(204)
      expect((await request(`/api/v1/calendars/${id}/sync`, 'POST', '{}', headers)).status).toBe(
        204,
      )
      expect(
        (
          await request(
            '/api/v1/calendar-destination',
            'PUT',
            JSON.stringify({ calendarId: id }),
            headers,
          )
        ).status,
      ).toBe(204)
      const updated = (await (
        await request('/api/v1/calendar-connections', 'GET', undefined, headers)
      ).json()) as {
        destinationCalendarId: string
        data: { calendars: { checkConflicts: boolean; lastSyncedAt: string | null }[] }[]
      }
      expect(updated.destinationCalendarId).toBe(id)
      expect(updated.data[0]?.calendars[0]).toMatchObject({
        checkConflicts: true,
        lastSyncedAt: expect.any(String),
      })
      expect(
        (await request('/api/v1/calendar-destination', 'PUT', '{"calendarId":null}', headers))
          .status,
      ).toBe(204)
    },
  )

  it('does not let a team administrator API key discover or change another member’s private calendars', async () => {
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    const state = await start('sync')
    await request(`/api/calendar/google/callback?state=${state}&code=fake-code`)
    const calendar = await db
      .selectFrom('calendars')
      .select(['id', 'connection_id'])
      .executeTakeFirstOrThrow()
    const headers = { authorization: 'Bearer hm_other', cookie: '', origin: '' }
    const listed = await request('/api/v1/calendar-connections', 'GET', undefined, headers)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ data: [], destinationCalendarId: null })
    const calls = provider.calls.length
    for (const [path, method, body, code] of [
      [
        `/api/v1/calendars/${calendar.id}`,
        'PATCH',
        '{"checkConflicts":true}',
        'calendar_not_found',
      ],
      [`/api/v1/calendars/${calendar.id}/sync`, 'POST', '{}', 'calendar_not_found'],
      [
        '/api/v1/calendar-destination',
        'PUT',
        JSON.stringify({ calendarId: calendar.id }),
        'calendar_not_found',
      ],
      [
        `/api/v1/calendar-connections/${calendar.connection_id}/refresh`,
        'POST',
        '{}',
        'calendar_connection_not_found',
      ],
    ] as const) {
      const response = await request(path, method, body, headers)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: code })
    }
    expect(provider.calls).toHaveLength(calls)
    expect(await db.selectFrom('calendars').select('check_conflicts').execute()).toEqual([
      { check_conflicts: false },
    ])
  })

  it('keeps provider consent, callbacks and disconnect session-only for an owner API key', async () => {
    const state = await start()
    await request(`/api/calendar/google/callback?state=${state}&code=fake-code`)
    const connection = await db
      .selectFrom('calendar_connections')
      .select('id')
      .executeTakeFirstOrThrow()
    const headers = { authorization: 'Bearer hm_test', cookie: '', origin: '' }
    for (const providerName of ['google', 'microsoft']) {
      const authorize = await request(
        `/api/v1/calendar-connections/${providerName}/authorize`,
        'POST',
        '{}',
        headers,
      )
      expect(authorize.status).toBe(403)
      expect(await authorize.json()).toMatchObject({ error: 'session_required' })
      const callback = await request(
        `/api/calendar/${providerName}/callback?state=private&code=private`,
        'GET',
        undefined,
        headers,
      )
      expect(callback.status).toBe(303)
      expect(callback.headers.get('location')).toBe('/app/calendars?connection=session_required')
    }
    const disconnect = await request(
      `/api/v1/calendar-connections/${connection.id}`,
      'DELETE',
      undefined,
      headers,
    )
    expect(disconnect.status).toBe(403)
    expect(await disconnect.json()).toMatchObject({ error: 'session_required' })
    expect(await db.selectFrom('calendar_connections').select('id').execute()).toHaveLength(1)
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
