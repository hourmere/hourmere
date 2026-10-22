import { createHash } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarEncryptionKey, decryptCredential, encryptCredential } from './credentials.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishGoogleConnection,
  listCalendarConnections,
  refreshGoogleCalendars,
} from './index.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('separate Google calendar connections (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let secondSession: typeof owner
  let provider: ReturnType<typeof fakeGoogle>
  let deps: CalendarDeps
  let now: number
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: owner.user.id,
        token: 'second-session',
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    secondSession = { ...owner, sessionId: row.id }
  })
  beforeEach(async () => {
    await db.deleteFrom('calendar_oauth_states').execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    now = Date.now()
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
  })
  afterAll(async () => {
    await database?.drop()
  })
  async function start(principal = owner) {
    const url = new URL((await beginGoogleConnection(deps, principal)).authorizationUrl)
    return { url, state: url.searchParams.get('state') as string }
  }
  const query = (
    state: string,
    extra: Record<string, string> = { code: 'fake-authorization-code' },
  ) => new URLSearchParams({ state, ...extra })
  async function connect() {
    const { state } = await start()
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('connected')
    return await db.selectFrom('calendar_connections').selectAll().executeTakeFirstOrThrow()
  }

  it('uses only identity/list scopes, session-bound hashed state and encrypted PKCE', async () => {
    const { url, state } = await start()
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/api/calendar/google/callback',
    )
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_secret')).toBeNull()
    const saved = await db.selectFrom('calendar_oauth_states').selectAll().executeTakeFirstOrThrow()
    expect(saved.state_hash).toBe(createHash('sha256').update(state).digest('hex'))
    expect(saved.session_id).toBe(owner.sessionId)
    expect(saved.user_id).toBe(owner.user.id)
    const verifier = decryptCredential(
      calendarEncryptionKey(TEST_CALENDAR_KEY),
      `state:${owner.user.id}:${owner.sessionId}:${saved.state_hash}`,
      saved.verifier,
    )
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
    expect(saved.verifier.includes(Buffer.from(verifier))).toBe(false)
  })

  it('stores encrypted credentials, only safe metadata in lists, and no sign-in account', async () => {
    const connection = await connect()
    expect(connection.credentials.includes(Buffer.from('fake-refresh-token'))).toBe(false)
    expect(connection.credentials.includes(Buffer.from('fake-access-token'))).toBe(false)
    const plaintext = decryptCredential(
      calendarEncryptionKey(TEST_CALENDAR_KEY),
      `google:${owner.user.id}:google-account-1`,
      connection.credentials,
    )
    expect(JSON.parse(plaintext)).toMatchObject({ refreshToken: 'fake-refresh-token' })
    const list = await listCalendarConnections(deps, owner)
    expect(list.data).toHaveLength(1)
    expect(list.data[0]).toMatchObject({
      accountEmail: 'calendar@example.com',
      calendars: [{ name: 'My calendar', isPrimary: true, timeZone: 'America/Los_Angeles' }],
    })
    expect(JSON.stringify(list)).not.toMatch(
      /fake-refresh-token|fake-access-token|credentials|external_account_id/,
    )
    expect((await listCalendarConnections(deps, other)).data).toEqual([])
    expect(await db.selectFrom('auth.account').selectAll().execute()).toEqual([])
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toEqual([])
  })

  it('returns a calendar without a known time zone as null', async () => {
    await connect()
    await db.updateTable('calendars').set({ time_zone: null }).execute()
    expect((await listCalendarConnections(deps, owner)).data[0]?.calendars[0]?.timeZone).toBeNull()
  })

  it('does not consume a state used by another user or another session of its owner', async () => {
    const { state } = await start()
    expect(await finishGoogleConnection(deps, other, query(state))).toBe('invalid_state')
    expect(await finishGoogleConnection(deps, secondSession, query(state))).toBe('invalid_state')
    expect(provider.calls).toHaveLength(0)
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('connected')
  })

  it('exposes only safe connection errors so hosts can see terminal writeback failures', async () => {
    const connection = await connect()
    for (const lastError of ['permissions_missing', 'provider_unavailable', 'needs_reauth', null]) {
      await db
        .updateTable('calendar_connections')
        .set({ last_error: lastError })
        .where('id', '=', connection.id)
        .execute()
      expect((await listCalendarConnections(deps, owner)).data[0]?.lastError).toBe(lastError)
    }
    await db
      .updateTable('calendar_connections')
      .set({ last_error: 'untrusted-provider-detail' })
      .where('id', '=', connection.id)
      .execute()
    expect((await listCalendarConnections(deps, owner)).data[0]?.lastError).toBeNull()
  })

  it('refuses expired and duplicate states before contacting Google', async () => {
    const { state } = await start()
    const repeated = query(state)
    repeated.append('state', state)
    expect(await finishGoogleConnection(deps, owner, repeated)).toBe('invalid_state')
    now += 10 * 60_000
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('invalid_state')
    expect(provider.calls).toHaveLength(0)
  })

  it('redeems a callback only once even when two arrive concurrently', async () => {
    const { state } = await start()
    let entered: () => void = () => {}
    let duplicated: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((r) => {
      entered = r
    })
    const replayed = new Promise<void>((r) => {
      duplicated = r
    })
    const paused = new Promise<void>((r) => {
      release = r
    })
    const exchange = provider.client.exchange
    let exchanges = 0
    vi.spyOn(provider.client, 'exchange').mockImplementation(async (...args) => {
      if (++exchanges === 1) entered()
      else duplicated()
      await paused
      return exchange(...args)
    })
    const first = finishGoogleConnection(deps, owner, query(state))
    await started
    const second = finishGoogleConnection(deps, owner, query(state))
    let observed: string
    try {
      observed = await Promise.race([second, replayed.then(() => 'exchanged_twice')])
    } finally {
      release()
    }
    const results = await Promise.all([first, second])
    expect(observed).toBe('invalid_state')
    expect(results.sort()).toEqual(['connected', 'invalid_state'])
    expect(provider.calls.filter((c) => c.url.pathname === '/token')).toHaveLength(1)
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('invalid_state')
  })

  it.each(['denied', 'provider_error', 'duplicate_code'])(
    'consumes cancelled/malformed attempts without a token exchange: %s',
    async (kind) => {
      const { state } = await start()
      const params =
        kind === 'denied'
          ? query(state, { error: 'access_denied' })
          : kind === 'provider_error'
            ? query(state, { error: 'unsafe-provider-message' })
            : query(state)
      if (kind === 'duplicate_code') params.append('code', 'second')
      expect(await finishGoogleConnection(deps, owner, params)).toBe(
        kind === 'denied' ? 'denied' : 'provider_unavailable',
      )
      expect(provider.calls).toHaveLength(0)
      expect(await finishGoogleConnection(deps, owner, query(state))).toBe('invalid_state')
    },
  )

  it('rejects partial consent and consumes failed token exchanges permanently', async () => {
    provider.controls.token.scope = 'openid email'
    let attempt = await start()
    expect(await finishGoogleConnection(deps, owner, query(attempt.state))).toBe(
      'permissions_missing',
    )
    provider.controls.tokenStatus = 400
    provider.controls.token = { error: 'invalid_grant' }
    attempt = await start()
    expect(await finishGoogleConnection(deps, owner, query(attempt.state))).toBe('needs_reauth')
    expect(await finishGoogleConnection(deps, owner, query(attempt.state))).toBe('invalid_state')
    expect((await listCalendarConnections(deps, owner)).data).toHaveLength(0)
  })

  it('requires a verified identity and continuing access for a first connection', async () => {
    provider.controls.identity.email_verified = false
    let attempt = await start()
    expect(await finishGoogleConnection(deps, owner, query(attempt.state))).toBe(
      'provider_unavailable',
    )
    provider.controls.identity.email_verified = true
    delete provider.controls.token.refresh_token
    attempt = await start()
    expect(await finishGoogleConnection(deps, owner, query(attempt.state))).toBe('needs_reauth')
    expect((await listCalendarConnections(deps, owner)).data).toEqual([])
  })

  it('reconnects the same account in place and retains a missing refresh token', async () => {
    const initial = await connect()
    delete provider.controls.token.refresh_token
    provider.controls.token.access_token = 'new-fake-access'
    provider.controls.pages = [
      { items: [{ id: 'new-calendar', summary: 'New calendar' }], nextPageToken: '1' },
      { items: [{ id: 'second-calendar', summary: 'Second calendar' }] },
    ]
    const next = await connect()
    expect(next.id).toBe(initial.id)
    const saved = JSON.parse(
      decryptCredential(
        calendarEncryptionKey(TEST_CALENDAR_KEY),
        `google:${owner.user.id}:google-account-1`,
        next.credentials,
      ),
    )
    expect(saved).toMatchObject({
      accessToken: 'new-fake-access',
      refreshToken: 'fake-refresh-token',
    })
    expect(
      (await listCalendarConnections(deps, owner)).data[0]?.calendars.map((c) => c.name),
    ).toEqual(['New calendar', 'Second calendar'])
    expect(
      provider.calls
        .filter((c) => c.url.pathname.includes('calendarList'))
        .every(
          (c) =>
            !c.url.searchParams.has('access_token') && c.init.redirect === 'error' && c.init.signal,
        ),
    ).toBe(true)
  })

  it('keeps the old connection intact when list pagination fails', async () => {
    const initial = await connect()
    provider.controls.pages = [{ items: [], nextPageToken: '0' }]
    const { state } = await start()
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('provider_unavailable')
    expect(
      (
        await db
          .selectFrom('calendar_connections')
          .select('credentials')
          .where('id', '=', initial.id)
          .executeTakeFirstOrThrow()
      ).credentials,
    ).toEqual(initial.credentials)
    expect((await listCalendarConnections(deps, owner)).data[0]?.calendars).toHaveLength(1)
  })

  it('cannot resurrect a connection when disconnect wins during a slow callback', async () => {
    const initial = await connect()
    const { state } = await start()
    let release: () => void = () => {}
    let reached: () => void = () => {}
    const started = new Promise<void>((r) => {
      reached = r
    })
    const waiting = new Promise<void>((r) => {
      release = r
    })
    const identity = provider.client.identity
    vi.spyOn(provider.client, 'identity').mockImplementation(async (...args) => {
      reached()
      await waiting
      return identity(...args)
    })
    const callback = finishGoogleConnection(deps, owner, query(state))
    await started
    await disconnectCalendar(deps, owner, initial.id)
    release()
    expect(await callback).toBe('invalid_state')
    expect((await listCalendarConnections(deps, owner)).data).toEqual([])
  })

  it('disconnects only the owner, deletes credentials/calendars and cancels pending attempts', async () => {
    const initial = await connect()
    const { state } = await start()
    await expect(disconnectCalendar(deps, other, initial.id)).rejects.toMatchObject({
      code: 'calendar_connection_not_found',
    })
    await disconnectCalendar(deps, owner, initial.id)
    expect(await finishGoogleConnection(deps, owner, query(state))).toBe('invalid_state')
    expect(await db.selectFrom('calendars').selectAll().execute()).toEqual([])
    expect(await db.selectFrom('calendar_connections').selectAll().execute()).toEqual([])
  })

  it('refreshes an expired access token without losing an unrotated refresh token', async () => {
    const initial = await connect()
    now += 3_600_000
    delete provider.controls.token.refresh_token
    delete provider.controls.token.scope
    provider.controls.token.access_token = 'refreshed-access'
    await refreshGoogleCalendars(deps, owner, initial.id)
    const refresh = provider.calls.filter((c) => c.url.pathname === '/token').at(-1)
    expect(new URLSearchParams(String(refresh?.init.body)).get('grant_type')).toBe('refresh_token')
    const connection = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(
      JSON.parse(
        decryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          `google:${owner.user.id}:google-account-1`,
          connection.credentials,
        ),
      ),
    ).toMatchObject({ accessToken: 'refreshed-access', refreshToken: 'fake-refresh-token' })
  })

  it('marks revoked access as needing reauthorization but retains active status on transient failure', async () => {
    const connection = await connect()
    now += 3_600_000
    provider.controls.tokenStatus = 503
    await expect(refreshGoogleCalendars(deps, owner, connection.id)).rejects.toMatchObject({
      code: 'google_calendar_provider_unavailable',
    })
    expect((await listCalendarConnections(deps, owner)).data[0]?.status).toBe('active')
    provider.controls.tokenStatus = 400
    provider.controls.token = { error: 'invalid_grant' }
    await expect(refreshGoogleCalendars(deps, owner, connection.id)).rejects.toMatchObject({
      code: 'google_calendar_needs_reauth',
    })
    expect((await listCalendarConnections(deps, owner)).data[0]?.status).toBe('needs_reauth')
  })

  it('keeps a rotated refresh token when listing calendars fails after the refresh', async () => {
    const connection = await connect()
    now += 3_600_000
    provider.controls.token.refresh_token = 'rotated-refresh-token'
    provider.controls.listStatus = 503
    await expect(refreshGoogleCalendars(deps, owner, connection.id)).rejects.toMatchObject({
      code: 'google_calendar_provider_unavailable',
    })
    const saved = await db
      .selectFrom('calendar_connections')
      .select('credentials')
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow()
    expect(
      JSON.parse(
        decryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          `google:${owner.user.id}:google-account-1`,
          saved.credentials,
        ),
      ).refreshToken,
    ).toBe('rotated-refresh-token')
  })

  it('caps abandoned attempts at five per user and refuses API-key authorization', async () => {
    for (let i = 0; i < 8; i++) await start()
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toHaveLength(5)
    await expect(
      beginGoogleConnection(deps, {
        kind: 'api_key',
        apiKeyId: owner.sessionId,
        user: owner.user,
        organization: owner.organization,
      }),
    ).rejects.toMatchObject({ code: 'session_required' })
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toHaveLength(5)
    now += 600_000
    await start()
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toHaveLength(1)
  })
})

describe('calendar encryption', () => {
  it('authenticates ciphertext, owner context, version and key', () => {
    const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
    const encrypted = encryptCredential(key, 'owner-a', 'fake-refresh-token')
    expect(decryptCredential(key, 'owner-a', encrypted)).toBe('fake-refresh-token')
    expect(encryptCredential(key, 'owner-a', 'fake-refresh-token')).not.toEqual(encrypted)
    const tampered = Buffer.from(encrypted)
    tampered[29] = (tampered[29] ?? 0) ^ 1
    for (const attempt of [
      () => decryptCredential(key, 'owner-b', encrypted),
      () => decryptCredential(Buffer.alloc(32, 2), 'owner-a', encrypted),
      () => decryptCredential(key, 'owner-a', tampered),
      () => decryptCredential(key, 'owner-a', Buffer.from([0])),
    ]) {
      expect(attempt).toThrow('Calendar credentials could not be decrypted')
    }
    for (const value of [
      'not-base64',
      Buffer.alloc(31).toString('base64'),
      `${TEST_CALENDAR_KEY}\n`,
    ])
      expect(() => calendarEncryptionKey(value)).toThrow('CALENDAR_ENCRYPTION_KEY')
  })
})
