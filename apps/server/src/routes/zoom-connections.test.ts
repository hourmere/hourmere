import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conferenceTestSession,
  fakeZoom,
  TEST_CONFERENCE_KEY,
} from '../../../../packages/conferences/src/testing.ts'
import { createApp } from '../app.ts'
import { conferenceRoutes } from './conferences.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('Zoom HTTP session-only routes (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    other: typeof owner
  let provider: ReturnType<typeof fakeZoom>, app: ReturnType<typeof createApp>
  function composition(enabled = true, meetingsEnabled = false) {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      publicUrl: 'http://localhost:5173',
      resolveCaller: async (headers) => {
        const current = headers.get('cookie') === 'other' ? other : owner
        const principal = headers.has('authorization')
          ? { ...current, kind: 'api_key' as const, apiKeyId: current.sessionId }
          : headers.has('x-oauth')
            ? {
                ...current,
                kind: 'oauth' as const,
                oauthClientId: 'synthetic-client',
                oauthGrantId: 'synthetic-grant',
              }
            : headers.has('cookie')
              ? current
              : undefined
        return principal
          ? { ok: true, principal: principal as typeof owner, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [
        conferenceRoutes({
          db,
          ...(enabled && {
            zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled },
          }),
        }),
      ],
    })
  }
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
    other = await conferenceTestSession(db)
  })
  beforeEach(async () => {
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    provider = fakeZoom()
    app = composition()
  })
  afterAll(async () => {
    await database?.drop()
  })
  const req = (path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: {
        cookie: 'owner',
        ...(method !== 'GET' && {
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
        }),
        ...headers,
      },
      ...(body !== undefined && { body }),
    })
  async function start() {
    const response = await req('/api/v1/conference-connections/zoom/authorize', 'POST', '{}')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { authorizationUrl: string }
    return new URL(body.authorizationUrl).searchParams.get('state') as string
  }
  async function connect() {
    const state = await start()
    expect(
      (await req(`/api/conference/zoom/callback?state=${state}&code=synthetic-code`)).headers.get(
        'location',
      ),
    ).toBe('/app/conferences?zoom=connected')
    return db.selectFrom('conference_connections').select('id').executeTakeFirstOrThrow()
  }
  it('lists private metadata without credentials and supports explicit refresh/disconnect', async () => {
    const { id } = await connect(),
      response = await req('/api/v1/conference-connections')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const body = await response.text()
    expect(body).toContain('Settings')
    expect(body).not.toMatch(
      /synthetic-zoom-access|synthetic-zoom-refresh|state_hash|external_user_id|credentials|operation_id/,
    )
    expect((await req(`/api/v1/conference-connections/${id}/refresh`, 'POST', '{}')).status).toBe(
      204,
    )
    expect((await req(`/api/v1/conference-connections/${id}`, 'DELETE', '{}')).status).toBe(204)
  })
  it.each([
    ['authorization', 'Bearer synthetic-api-key'],
    ['x-oauth', 'synthetic-oauth'],
  ])('refuses %s callers before state or provider I/O', async (header, value) => {
    for (const [path, method] of [
      ['/api/v1/conference-connections', 'GET'],
      ['/api/v1/conference-connections/zoom/authorize', 'POST'],
      ['/api/v1/conference-connections/zoom/authorize-meetings', 'POST'],
      [`/api/v1/conference-connections/${owner.sessionId}/authorize-meetings`, 'POST'],
    ] as const) {
      expect(
        (await req(path, method, method === 'POST' ? '{}' : undefined, { [header]: value })).status,
      ).toBe(403)
    }
    expect(provider.calls).toHaveLength(0)
    expect(await db.selectFrom('conference_oauth_states').selectAll().execute()).toHaveLength(0)
  })
  it('rejects cross-origin writes, unknown/malformed/nonempty bodies and excessive size before state/provider mutation', async () => {
    expect(
      (
        await req('/api/v1/conference-connections/zoom/authorize', 'POST', '{}', {
          origin: 'https://untrusted.invalid',
        })
      ).status,
    ).toBe(403)
    for (const body of ['{"scope":"meeting:write:meeting"}', '{', '[]', 'null'])
      expect(
        (await req('/api/v1/conference-connections/zoom/authorize', 'POST', body)).status,
      ).toBe(400)
    expect(
      (
        await req(
          '/api/v1/conference-connections/zoom/authorize',
          'POST',
          JSON.stringify({ padding: 'x'.repeat(1100) }),
        )
      ).status,
    ).toBe(413)
    expect(provider.calls).toHaveLength(0)
    expect(await db.selectFrom('conference_oauth_states').selectAll().execute()).toHaveLength(0)
  })
  it('does not disclose another owner’s connection through refresh/reconnect/disconnect', async () => {
    const { id } = await connect()
    app = composition(true, true)
    for (const [suffix, method] of [
      ['/refresh', 'POST'],
      ['/reconnect', 'POST'],
      ['/authorize-meetings', 'POST'],
      ['', 'DELETE'],
    ] as const)
      expect(
        (
          await req(`/api/v1/conference-connections/${id}${suffix}`, method, '{}', {
            cookie: 'other',
          })
        ).status,
      ).toBe(404)
    expect(provider.calls).toHaveLength(2)
  })
  it('reconnects via an expected-identity attempt and consumes callback state once', async () => {
    const { id } = await connect(),
      response = await req(`/api/v1/conference-connections/${id}/reconnect`, 'POST', '{}'),
      body = (await response.json()) as { authorizationUrl: string },
      state = new URL(body.authorizationUrl).searchParams.get('state')
    const callback = `/api/conference/zoom/callback?state=${state}&code=synthetic-code`
    expect((await req(callback)).headers.get('location')).toBe('/app/conferences?zoom=connected')
    expect((await req(callback)).headers.get('location')).toBe(
      '/app/conferences?zoom=invalid_state',
    )
    expect(await db.selectFrom('conference_connections').select('id').execute()).toEqual([{ id }])
  })
  it.each([
    [undefined, 'provider_unavailable'],
    ['invalid_grant', 'needs_reauth'],
  ])(
    'redirects callback errors (%s) to bounded outcomes without secrets, query strings or provider prose in logs',
    async (error, outcome) => {
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {}),
        errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const state = await start()
        provider.controls.tokenStatus = 400
        provider.controls.token = {
          ...(error && { error }),
          error_description: 'synthetic-private-provider-prose',
        }
        const response = await req(
          `/api/conference/zoom/callback?state=${state}&code=synthetic-private-code`,
        )
        expect(response.status).toBe(303)
        expect(response.headers.get('location')).toBe(`/app/conferences?zoom=${outcome}`)
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(response.headers.get('cache-control')).toBe('no-store')
        const logText = [...logs.mock.calls, ...errors.mock.calls].flat().join(' ')
        expect(logText).not.toContain(state)
        expect(logText).not.toMatch(/synthetic-private|synthetic-zoom-(access|refresh)|code=/)
        const noSession = await app.request(
          '/api/conference/zoom/callback?state=synthetic-private-state&code=synthetic-private-code',
        )
        expect(noSession.status).toBe(303)
        expect(noSession.headers.get('location')).toBe('/app/conferences?zoom=session_required')
        expect(noSession.headers.get('referrer-policy')).toBe('no-referrer')
      } finally {
        logs.mockRestore()
        errors.mockRestore()
      }
    },
  )
  it('sets private response headers before refusing unauthenticated or non-session callers', async () => {
    for (const response of [
      await app.request('/api/v1/conference-connections'),
      await req('/api/v1/conference-connections', 'GET', undefined, {
        authorization: 'Bearer synthetic-api-key',
      }),
      await req('/api/v1/conference-connections/zoom/authorize', 'POST', '{}', {
        origin: 'https://untrusted.invalid',
      }),
    ]) {
      expect([401, 403]).toContain(response.status)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(provider.calls).toHaveLength(0)
  })
  it('rate-limited callbacks keep a truthful safe redirect with no secret query values', async () => {
    for (let i = 0; i < 20; i++) {
      const response = await req(
        '/api/conference/zoom/callback?state=synthetic-private-state&code=synthetic-private-code',
      )
      expect(response.headers.get('location')).toBe('/app/conferences?zoom=invalid_state')
    }
    const response = await req(
      '/api/conference/zoom/callback?state=synthetic-private-state&code=synthetic-private-code',
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/app/conferences?zoom=rate_limited')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(provider.calls).toHaveLength(0)
  })
  it('refuses bodyless or non-JSON meeting commands before creating state, while retaining caller/origin gates', async () => {
    app = composition(true, true)
    const path = '/api/v1/conference-connections/zoom/authorize-meetings'
    for (const headers of [
      { cookie: 'owner', origin: 'http://localhost:5173' },
      { cookie: 'owner', origin: 'http://localhost:5173', 'content-type': 'text/plain' },
      { cookie: 'owner', origin: 'http://localhost:5173', 'content-type': 'application/json' },
    ]) {
      const response = await app.request(path, { method: 'POST', headers })
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(
      await db.selectFrom('conference_oauth_states').select('state_hash').execute(),
    ).toHaveLength(0)
    expect(provider.calls).toHaveLength(0)
    expect(
      (await app.request(path, { method: 'POST', headers: { origin: 'http://localhost:5173' } }))
        .status,
    ).toBe(401)
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: {
            cookie: 'owner',
            origin: 'http://localhost:5173',
            authorization: 'Bearer synthetic-key',
          },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { cookie: 'owner', origin: 'https://untrusted.invalid' },
        })
      ).status,
    ).toBe(403)
    expect(
      await db.selectFrom('conference_oauth_states').select('state_hash').execute(),
    ).toHaveLength(0)
  })
  it('uses a distinct session-only meeting action and refuses caller-supplied modes/scopes/connection IDs', async () => {
    expect(
      (await req('/api/v1/conference-connections/zoom/authorize-meetings', 'POST', '{}')).status,
    ).toBe(409)
    app = composition(true, true)
    for (const path of ['/api/v1/conference-connections/zoom/authorize-meetings']) {
      for (const body of [
        '{"mode":"identity"}',
        '{"scope":"meeting:read:admin"}',
        '{"connectionId":"synthetic"}',
        '[]',
      ])
        expect((await req(path, 'POST', body)).status).toBe(400)
      expect((await req(path, 'POST', '{}', { origin: 'https://untrusted.invalid' })).status).toBe(
        403,
      )
    }
    expect(
      await db.selectFrom('conference_oauth_states').select('state_hash').execute(),
    ).toHaveLength(0)
    const response = await req(
      '/api/v1/conference-connections/zoom/authorize-meetings',
      'POST',
      '{}',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = (await response.json()) as { authorizationUrl: string },
      url = new URL(result.authorizationUrl)
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'user:read:user',
      'meeting:write:meeting',
      'meeting:read:meeting',
      'meeting:update:meeting',
      'meeting:delete:meeting',
    ])
    provider.controls.token.scope = url.searchParams.get('scope')
    const callback = await req(
      `/api/conference/zoom/callback?state=${url.searchParams.get('state')}&code=synthetic-code`,
    )
    expect(callback.headers.get('location')).toBe('/app/conferences?zoom=connected')
    const row = await db.selectFrom('conference_connections').selectAll().executeTakeFirstOrThrow()
    expect(row.mode).toBe('meetings')
    expect(row.status).toBe('active')
    const data = (await (await req('/api/v1/conference-connections')).json()) as {
      zoomMeetingsEnabled: boolean
      data: { mode: string }[]
    }
    expect(data.zoomMeetingsEnabled).toBe(true)
    expect(data.data[0]?.mode).toBe('meetings')
  })
  it('keeps disabled composition honest and makes no provider request', async () => {
    app = composition(false)
    expect(
      ((await (await req('/api/v1/conference-connections')).json()) as { zoomEnabled: boolean })
        .zoomEnabled,
    ).toBe(false)
    expect((await req('/api/v1/conference-connections/zoom/authorize', 'POST', '{}')).status).toBe(
      409,
    )
    expect(provider.calls).toHaveLength(0)
  })
})
