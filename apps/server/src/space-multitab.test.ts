import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

const adminUrl = process.env.DATABASE_URL
const secret = randomBytes(32).toString('base64')
const expectedHeader = 'X-Expected-Organization-Id'

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number }
      probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

describe.skipIf(!adminUrl)('space switching across real HTTP browser sessions', () => {
  let owned: TestDatabase, db: Db, running: RunningServer, origin: string, base: string
  const spies: ReturnType<typeof vi.spyOn>[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(adminUrl as string)
    db = createDb(owned.pool)
    const port = await freePort()
    origin = `http://localhost:${port}`
    base = `http://127.0.0.1:${port}`
    // The web role never consumes the notification queue or contacts a provider.
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      spies.push(vi.spyOn(console, method).mockImplementation(() => {}))
    running = await startServer({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: secret,
      SIGNUP: 'closed',
      HOURMERE_ROLE: 'web',
      MCP_OAUTH_ENABLED: 'true',
      PORT: String(port),
      PUBLIC_URL: origin,
    })
  }, 30_000)

  afterAll(async () => {
    try {
      try {
        await running?.close()
      } finally {
        await owned?.drop()
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  function browser(cookie: string) {
    return {
      cookie,
      request(path: string, method = 'GET', body?: object, expected?: string) {
        return fetch(`${base}${path}`, {
          method,
          redirect: 'manual',
          headers: {
            cookie,
            origin,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(expected === undefined ? {} : { [expectedHeader]: expected }),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      },
    }
  }
  type Browser = ReturnType<typeof browser>

  async function session(user: TestUser, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: organizationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id: row.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture() {
    const user = await createTestUser(db)
    const owner = await createTestUser(db)
    const members = [
      { user: owner, role: 'owner' },
      { user, role: 'admin' },
    ]
    const a = await createTestTeam(db, members, 'First space')
    const b = await createTestTeam(db, members, 'Second space')
    const shared = await session(user, a.id)
    const ownerSession = await session(owner, a.id)
    // Browser tabs share their cookie and the same server-side session row, while each
    // keeps its own opened draft and expected organization.
    return {
      user,
      a,
      b,
      sessionId: shared.id,
      tab1: browser(shared.cookie),
      tab2: browser(shared.cookie),
      owner: browser(ownerSession.cookie),
    }
  }

  async function switchTo(tab: Browser, organizationId: string) {
    const response = await tab.request('/api/auth/organization/set-active', 'POST', {
      organizationId,
    })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  }

  async function me(tab: Browser) {
    const response = await tab.request('/api/v1/me')
    expect(response.status).toBe(200)
    return (await response.json()) as { organization: { id: string } }
  }

  async function createEvent(tab: Browser, organizationId: string, title = 'Original draft') {
    const response = await tab.request(
      '/api/v1/event-types',
      'POST',
      { slug: `draft-${randomUUID()}`, title, durationMinutes: 30 },
      organizationId,
    )
    expect(response.status).toBe(201)
    return (await response.json()) as { id: string; organizationId: string; title: string }
  }

  async function refused(response: Response) {
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
  }

  async function eventRows(a: string, b: string) {
    return db
      .selectFrom('event_types')
      .select(['id', 'organization_id', 'title', 'slug'])
      .where('organization_id', 'in', [a, b])
      .orderBy('id')
      .execute()
  }

  async function waitForLock(query: string) {
    await expect
      .poll(
        async () => {
          const result = await owned.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query ILIKE $1) AS waiting`,
            [query],
          )
          return result.rows[0]?.waiting
        },
        { timeout: 5_000 },
      )
      .toBe(true)
  }

  it('refuses the first tab’s old create and edit drafts after the second tab switches', async () => {
    const f = await fixture()
    const existing = await createEvent(f.tab1, f.a.id)
    const draft = {
      slug: `unsaved-${randomUUID()}`,
      title: 'Opened in the first space',
      durationMinutes: 30,
    }
    const before = await eventRows(f.a.id, f.b.id)
    expect((await me(f.tab1)).organization.id).toBe(f.a.id)
    await switchTo(f.tab2, f.b.id)
    expect((await me(f.tab1)).organization.id).toBe(f.b.id)

    await refused(await f.tab1.request('/api/v1/event-types', 'POST', draft, f.a.id))
    await refused(
      await f.tab1.request(
        `/api/v1/event-types/${existing.id}`,
        'PATCH',
        { title: draft.title },
        f.a.id,
      ),
    )
    expect(await eventRows(f.a.id, f.b.id)).toEqual(before)
    const fresh = await createEvent(f.tab2, f.b.id, 'Fresh second-space draft')
    expect(fresh.organizationId).toBe(f.b.id)
  })

  it('finishes one in-flight save in its original team before the shared session switches', async () => {
    const f = await fixture()
    const event = await createEvent(f.tab1, f.a.id)
    const other = await createEvent(f.owner, f.a.id, 'Untouched event')
    const holder = await owned.pool.connect()
    let saving: Promise<Response> | undefined, switching: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM event_types WHERE id = $1 FOR UPDATE', [event.id])
      saving = f.tab1.request(
        `/api/v1/event-types/${event.id}`,
        'PATCH',
        { title: 'Saved exactly once in the first space' },
        f.a.id,
      )
      // Pause the genuine service after its context check, while it holds the session
      // read lock and waits for the event row. No HTTP response or service is mocked.
      await waitForLock('%event_types%for update%')
      switching = f.tab2.request('/api/auth/organization/set-active', 'POST', {
        organizationId: f.b.id,
      })
      await waitForLock('%update%session%')
      expect((await me(f.tab1)).organization.id).toBe(f.a.id)
      await holder.query('COMMIT')
      const saved = await saving
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({
        id: event.id,
        organizationId: f.a.id,
        title: 'Saved exactly once in the first space',
      })
      const switched = await switching
      expect(switched.status).toBe(200)
      await switched.arrayBuffer()
      expect((await me(f.tab1)).organization.id).toBe(f.b.id)
      const rows = await eventRows(f.a.id, f.b.id)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === event.id)).toMatchObject({
        organization_id: f.a.id,
        title: 'Saved exactly once in the first space',
      })
      expect(rows.find((row) => row.id === other.id)?.title).toBe('Untouched event')
      expect(rows.filter((row) => row.organization_id === f.b.id)).toEqual([])
      await refused(
        await f.tab1.request(
          `/api/v1/event-types/${event.id}`,
          'PATCH',
          { title: 'Late duplicate' },
          f.a.id,
        ),
      )
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled([saving, switching].filter((pending) => pending !== undefined))
    }
  }, 20_000)

  it('refuses an in-flight save when the switch commits before its locked context recheck', async () => {
    const f = await fixture()
    const event = await createEvent(f.tab1, f.a.id)
    const before = await eventRows(f.a.id, f.b.id)
    const holder = await owned.pool.connect()
    let saving: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [f.a.id])
      saving = f.tab1.request(
        `/api/v1/event-types/${event.id}`,
        'PATCH',
        { title: 'Superseded in-flight save' },
        f.a.id,
      )
      // This request has resolved its cookie in A, but has not reached the locked live
      // session recheck. A switch that commits first must win over that stale principal.
      await waitForLock('%organization%for update%')
      await switchTo(f.tab2, f.b.id)
      expect((await me(f.tab1)).organization.id).toBe(f.b.id)
      await holder.query('COMMIT')
      await refused(await saving)
      expect(await eventRows(f.a.id, f.b.id)).toEqual(before)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(saving ? [saving] : [])
    }
  }, 15_000)

  // node:http preserves browser navigation semantics. fetch adds sec-fetch-mode: cors,
  // which makes Better Auth return JSON rather than its authorization-page redirect.
  function authorize(tab: Browser, query: URLSearchParams) {
    return new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const req = request(
        `${base}/api/auth/oauth2/authorize?${query}`,
        {
          agent: false,
          headers: {
            cookie: tab.cookie,
            accept: 'text/html,application/xhtml+xml',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        },
        (res) => {
          res.resume()
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, location: res.headers.location }),
          )
        },
      )
      req.once('error', reject)
      req.end()
    })
  }

  async function connectOAuth(tab: Browser, organizationId: string) {
    const callback = 'https://connector.test/callback'
    const registered = await fetch(`${base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Synthetic space connector',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(registered.status).toBe(201)
    const registration = (await registered.json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'mcp:tools offline_access',
      resource: `${origin}/mcp`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'consent',
      state: randomBytes(16).toString('base64url'),
    })
    const initial = await authorize(tab, query)
    expect(initial.status).toBe(302)
    const selection = new URL(initial.location as string, origin)
    expect(selection.origin).toBe(origin)
    const selected = await tab.request('/api/v1/mcp-oauth/select', 'POST', {
      oauthQuery: selection.searchParams.toString(),
      organizationId,
    })
    expect(selected.status).toBe(200)
    const continuation = new URL(((await selected.json()) as { redirectUrl: string }).redirectUrl)
    const consent = await tab.request('/api/v1/mcp-oauth/consent', 'POST', {
      oauthQuery: continuation.searchParams.toString(),
      intentId: new URLSearchParams(continuation.hash.slice(1)).get('intent'),
      accept: true,
    })
    expect(consent.status).toBe(200)
    const approved = new URL(((await consent.json()) as { redirectUrl: string }).redirectUrl)
    const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code: approved.searchParams.get('code') as string,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: `${origin}/mcp`,
      }),
    })
    expect(exchanged.status).toBe(200)
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }
    expect(
      typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string',
    ).toBe(true)
    return { ...tokens, clientId: registration.client_id }
  }

  async function oauthWhoami(token: string) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'whoami',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'whoami',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
  }

  it('keeps issued keys and OAuth grants in their team through browser switches, then refuses removed members', async () => {
    const f = await fixture()
    const created = await f.tab1.request('/api/auth/api-key/create', 'POST', {
      name: 'Synthetic first-space key',
      metadata: { organizationId: f.a.id },
    })
    expect(created.status).toBe(200)
    const key = (await created.json()) as { id: string; key: string }
    expect(typeof key.key === 'string').toBe(true)
    const oauth = await connectOAuth(f.tab1, f.a.id)
    const grant = await db
      .selectFrom('mcp_oauth_grants')
      .select(['id', 'organization_id'])
      .where('user_id', '=', f.user.id)
      .where('client_id', '=', oauth.clientId)
      .executeTakeFirstOrThrow()
    await switchTo(f.tab2, f.b.id)
    await switchTo(f.tab2, f.user.principal.organization.id)
    await switchTo(f.tab2, f.b.id)
    const keyCaller = () =>
      fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${key.key}` } })
    const keyResponse = await keyCaller()
    expect(keyResponse.status).toBe(200)
    expect(await keyResponse.json()).toMatchObject({ organization: { id: f.a.id } })
    const oauthResponse = await oauthWhoami(oauth.access_token)
    expect(oauthResponse.status).toBe(200)
    const rpc = (await oauthResponse.json()) as {
      result: { structuredContent: { organization: { id: string } } }
    }
    expect(rpc.result.structuredContent.organization.id).toBe(f.a.id)
    const storedKey = await db
      .selectFrom('auth.apikey')
      .select('metadata')
      .where('id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(storedKey.metadata as string)).toEqual({
      organizationId: f.a.id,
      scope: 'full',
    })
    expect(
      await db
        .selectFrom('mcp_oauth_grants')
        .select(['id', 'organization_id'])
        .where('id', '=', grant.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(grant)
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', f.a.id)
      .where('userId', '=', f.user.id)
      .executeTakeFirstOrThrow()
    const removed = await f.owner.request(
      '/api/auth/organization/remove-member',
      'POST',
      { organizationId: f.a.id, memberIdOrEmail: member.id },
      f.a.id,
    )
    expect(removed.status).toBe(200)
    await removed.arrayBuffer()
    const deniedKey = await keyCaller()
    expect(deniedKey.status).toBe(401)
    await deniedKey.arrayBuffer()
    const deniedOAuth = await oauthWhoami(oauth.access_token)
    expect(deniedOAuth.status).toBe(401)
    await deniedOAuth.arrayBuffer()
    const refreshed = await fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauth.clientId,
        refresh_token: oauth.refresh_token,
        resource: `${origin}/mcp`,
      }),
    })
    expect(refreshed.status).toBe(400)
    const refreshError = (await refreshed.json()) as {
      error: string
      access_token?: string
      refresh_token?: string
    }
    expect(refreshError.error).toBe('invalid_grant')
    expect(
      refreshError.access_token === undefined && refreshError.refresh_token === undefined,
    ).toBe(true)
    expect((await me(f.tab1)).organization.id).toBe(f.b.id)
  })

  it('preserves and shares the personal default schedule across team and personal switches', async () => {
    const f = await fixture()
    const created = await f.tab1.request('/api/v1/schedules', 'POST', {
      name: 'Shared personal availability',
      timeZone: 'Europe/London',
      weeklyHours: { monday: [{ start: '09:00', end: '17:00' }] },
    })
    expect(created.status).toBe(201)
    const schedule = (await created.json()) as { id: string; name: string; isDefault: boolean }
    expect(schedule.isDefault).toBe(true)
    for (const target of [f.b.id, f.user.principal.organization.id, f.a.id]) {
      await switchTo(f.tab2, target)
      const listed = await f.tab1.request('/api/v1/schedules')
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual({ data: [schedule] })
    }
    await switchTo(f.tab2, f.b.id)
    const edited = await f.tab1.request(
      `/api/v1/schedules/${schedule.id}`,
      'PATCH',
      { name: 'Updated shared availability' },
      f.a.id,
    )
    // Schedule writes belong to the user, so even a stale team expectation is irrelevant.
    expect(edited.status).toBe(200)
    await edited.arrayBuffer()
    await switchTo(f.tab2, f.a.id)
    const reread = await f.tab1.request(`/api/v1/schedules/${schedule.id}`)
    expect(reread.status).toBe(200)
    expect(await reread.json()).toMatchObject({
      id: schedule.id,
      name: 'Updated shared availability',
      isDefault: true,
      weeklyHours: { monday: [{ start: '09:00', end: '17:00' }] },
    })
    expect(
      await db.selectFrom('schedules').select('id').where('user_id', '=', f.user.id).execute(),
    ).toEqual([{ id: schedule.id }])
  })
})
