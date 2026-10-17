import { createHash } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarEncryptionKey, decryptCredential } from './credentials.ts'
import {
  beginGoogleConnection,
  beginMicrosoftConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishGoogleConnection,
  finishMicrosoftConnection,
  listCalendarConnections,
  readTokens,
  refreshCalendarList,
} from './index.ts'
import { calendarTestSession, fakeGoogle, fakeMicrosoft, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
describe.skipIf(!url)('separate Microsoft calendar connections (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let second: typeof owner
  let microsoft: ReturnType<typeof fakeMicrosoft>
  let google: ReturnType<typeof fakeGoogle>
  let deps: CalendarDeps
  let now: number
  beforeAll(async () => {
    database = await createTestDatabase(url as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: owner.user.id,
        token: 'second-ms-session',
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    second = { ...owner, sessionId: session.id }
  })
  beforeEach(async () => {
    await db.deleteFrom('calendar_oauth_states').execute()
    await db.deleteFrom('calendar_connections').execute()
    microsoft = fakeMicrosoft()
    google = fakeGoogle()
    now = Date.now()
    deps = {
      db,
      microsoft: { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
  })
  afterAll(async () => {
    await database?.drop()
  })
  const query = (state: string) => new URLSearchParams({ state, code: 'fake-microsoft-code' })
  const start = async () =>
    new URL((await beginMicrosoftConnection(deps, owner)).authorizationUrl).searchParams.get(
      'state',
    ) as string
  async function connect() {
    expect(await finishMicrosoftConnection(deps, owner, query(await start()))).toBe('connected')
    return db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('provider', '=', 'microsoft')
      .executeTakeFirstOrThrow()
  }

  it('binds hashed state, encrypted PKCE and stored tokens to the Microsoft provider', async () => {
    const state = await start()
    const saved = await db.selectFrom('calendar_oauth_states').selectAll().executeTakeFirstOrThrow()
    expect(saved).toMatchObject({
      provider: 'microsoft',
      user_id: owner.user.id,
      session_id: owner.sessionId,
      state_hash: createHash('sha256').update(state).digest('hex'),
    })
    const verifier = decryptCredential(
      calendarEncryptionKey(TEST_CALENDAR_KEY),
      `microsoft:state:${owner.user.id}:${owner.sessionId}:${saved.state_hash}`,
      saved.verifier,
    )
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(saved.verifier.includes(Buffer.from(verifier))).toBe(false)
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('connected')
    const row = await db.selectFrom('calendar_connections').selectAll().executeTakeFirstOrThrow()
    const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
    expect(
      readTokens(key, owner.user.id, row.external_account_id, row.credentials, 'microsoft')
        .refreshToken,
    ).toBe('fake-microsoft-refresh')
    expect(() => readTokens(key, owner.user.id, row.external_account_id, row.credentials)).toThrow(
      'Stored calendar credentials are invalid',
    )
    expect(row.credentials.includes(Buffer.from('fake-microsoft-refresh'))).toBe(false)
    const list = await listCalendarConnections(deps, owner)
    expect(list.microsoftEnabled).toBe(true)
    expect(list.data).toMatchObject([
      {
        provider: 'microsoft',
        accountEmail: 'outlook@example.com',
        syncAuthorized: false,
        calendars: [{ name: 'Outlook calendar', checkConflicts: false }],
      },
    ])
    expect(JSON.stringify(list)).not.toMatch(
      /fake-microsoft|microsoft-account-1|credentials|external_account_id/,
    )
    expect((await listCalendarConnections(deps, other)).data).toEqual([])
    expect(await db.selectFrom('auth.account').selectAll().execute()).toEqual([])
  })

  it('rejects provider mix-ups without claiming the other provider’s state', async () => {
    const ms = await start()
    const g = new URL((await beginGoogleConnection(deps, owner)).authorizationUrl).searchParams.get(
      'state',
    ) as string
    expect(await finishGoogleConnection(deps, owner, query(ms))).toBe('invalid_state')
    expect(await finishMicrosoftConnection(deps, owner, query(g))).toBe('invalid_state')
    expect(google.calls).toHaveLength(0)
    expect(microsoft.calls).toHaveLength(0)
    expect(await finishMicrosoftConnection(deps, owner, query(ms))).toBe('connected')
    expect(await finishGoogleConnection(deps, owner, query(g))).toBe('connected')
    expect((await listCalendarConnections(deps, owner)).data.map((c) => c.provider).sort()).toEqual(
      ['google', 'microsoft'],
    )
  })

  it('rejects other users, sessions, duplicate parameters, expiry and callback replay', async () => {
    let state = await start()
    expect(await finishMicrosoftConnection(deps, other, query(state))).toBe('invalid_state')
    expect(await finishMicrosoftConnection(deps, second, query(state))).toBe('invalid_state')
    const duplicate = query(state)
    duplicate.append('state', state)
    expect(await finishMicrosoftConnection(deps, owner, duplicate)).toBe('invalid_state')
    expect(microsoft.calls).toHaveLength(0)
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('connected')
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('invalid_state')
    state = await start()
    now += 600_000
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('invalid_state')
  })

  it('atomically claims simultaneous callbacks before exchanging a code', async () => {
    const state = await start()
    let entered: () => void = () => {}
    let duplicated: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const replayed = new Promise<void>((resolve) => {
      duplicated = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const exchange = microsoft.client.exchange
    let exchanges = 0
    vi.spyOn(microsoft.client, 'exchange').mockImplementation(async (...args) => {
      if (++exchanges === 1) entered()
      else duplicated()
      await paused
      return exchange(...args)
    })
    const first = finishMicrosoftConnection(deps, owner, query(state))
    await started
    const second = finishMicrosoftConnection(deps, owner, query(state))
    let observed: string
    try {
      observed = await Promise.race([second, replayed.then(() => 'exchanged_twice')])
    } finally {
      release()
    }
    const results = await Promise.all([first, second])
    expect(observed).toBe('invalid_state')
    expect(results.sort()).toEqual(['connected', 'invalid_state'])
    expect(microsoft.calls.filter((c) => c.url.pathname.endsWith('/token'))).toHaveLength(1)
  })

  it('consumes denied attempts and requires actual calendar permission and continuing access', async () => {
    let state = await start()
    expect(
      await finishMicrosoftConnection(
        deps,
        owner,
        new URLSearchParams({ state, error: 'access_denied' }),
      ),
    ).toBe('denied')
    expect(microsoft.calls).toHaveLength(0)
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('invalid_state')
    state = await start()
    microsoft.controls.token.scope = 'openid email'
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('permissions_missing')
    state = await start()
    microsoft.controls.token.scope = 'openid email Calendars.ReadBasic'
    delete microsoft.controls.token.refresh_token
    expect(await finishMicrosoftConnection(deps, owner, query(state))).toBe('needs_reauth')
    expect((await listCalendarConnections(deps, owner)).data).toEqual([])
  })

  it('accepts an identity without an email and keeps its subject as the account identifier', async () => {
    delete microsoft.controls.identity.email
    const row = await connect()
    expect(row.account_email).toBeNull()
    expect(row.external_account_id).toBe('microsoft-account-1')
  })

  it('connects and refreshes when a successful response omits scope, but refuses an explicit empty grant', async () => {
    delete microsoft.controls.token.scope
    const row = await connect()
    expect(row.scopes).toContain('Calendars.ReadBasic')
    now += 3_600_001
    microsoft.controls.token.expires_in = 7200
    await refreshCalendarList(deps, owner, row.id)
    expect((await listCalendarConnections(deps, owner)).data[0]?.status).toBe('active')
    microsoft.controls.token.scope = ''
    expect(await finishMicrosoftConnection(deps, owner, query(await start()))).toBe(
      'permissions_missing',
    )
    expect((await listCalendarConnections(deps, owner)).data).toHaveLength(1)
  })

  it('keeps rotated credentials when listing fails and reuses them on retry', async () => {
    const row = await connect()
    now += 3_600_001
    microsoft.controls.token.access_token = 'fake-rotated-access'
    microsoft.controls.token.refresh_token = 'fake-rotated-refresh'
    microsoft.controls.token.expires_in = 7200
    microsoft.controls.listStatus = 503
    await expect(refreshCalendarList(deps, owner, row.id)).rejects.toMatchObject({
      code: 'microsoft_calendar_provider_unavailable',
    })
    const rotated = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    expect(rotated.status).toBe('active')
    expect(
      readTokens(
        calendarEncryptionKey(TEST_CALENDAR_KEY),
        owner.user.id,
        rotated.external_account_id,
        rotated.credentials,
        'microsoft',
      ).refreshToken,
    ).toBe('fake-rotated-refresh')
    microsoft.controls.listStatus = 200
    await refreshCalendarList(deps, owner, row.id)
    expect(microsoft.calls.filter((c) => c.url.pathname.endsWith('/token'))).toHaveLength(2)
    expect(google.calls).toHaveLength(0)
  })

  it('retains a refresh token on reconnect, marks withdrawn permission, and lists while disabled', async () => {
    const row = await connect()
    delete microsoft.controls.token.refresh_token
    expect((await connect()).id).toBe(row.id)
    microsoft.controls.listStatus = 403
    await expect(refreshCalendarList(deps, owner, row.id)).rejects.toMatchObject({
      code: 'microsoft_calendar_permissions_missing',
    })
    const list = await listCalendarConnections({ db }, owner)
    expect(list.microsoftEnabled).toBe(false)
    expect(list.data[0]?.status).toBe('needs_reauth')
    await expect(refreshCalendarList(deps, other, row.id)).rejects.toMatchObject({
      code: 'calendar_connection_not_found',
    })
    await disconnectCalendar({ db }, owner, row.id)
    expect((await listCalendarConnections({ db }, owner)).data).toEqual([])
  })

  it('does not let a slow callback resurrect a disconnected Microsoft connection', async () => {
    const row = await connect()
    const state = await start()
    let entered: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const exchange = microsoft.client.exchange
    vi.spyOn(microsoft.client, 'exchange').mockImplementation(async (...args) => {
      entered()
      await paused
      return exchange(...args)
    })
    const callback = finishMicrosoftConnection(deps, owner, query(state))
    await started
    try {
      await disconnectCalendar(deps, owner, row.id)
    } finally {
      release()
    }
    expect(await callback).toBe('invalid_state')
    expect((await listCalendarConnections(deps, owner)).data).toEqual([])
    expect(await db.selectFrom('calendar_oauth_states').selectAll().execute()).toEqual([])
  })

  it('requires a browser session and independently configured Microsoft credentials', async () => {
    const { sessionId: _, ...rest } = owner
    await expect(
      beginMicrosoftConnection(deps, { ...rest, kind: 'api_key', apiKeyId: owner.sessionId }),
    ).rejects.toMatchObject({ code: 'session_required' })
    await expect(
      beginMicrosoftConnection({ db, google: deps.google }, owner),
    ).rejects.toMatchObject({ code: 'microsoft_calendar_disabled' })
  })
})
