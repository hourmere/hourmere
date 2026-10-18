import { createHash } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  conferenceAad,
  conferenceEncryptionKey,
  conferenceStateAad,
  decryptConferenceCredential,
} from './credentials.ts'
import {
  beginZoomConnection,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
  listConferenceConnections,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe.skipIf(!databaseUrl)('independent Zoom connections (real Postgres)', () => {
  let database: TestDatabase, db: Db
  let owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    other: typeof owner,
    second: typeof owner
  let provider: ReturnType<typeof fakeZoom>, deps: ConferenceDeps, now: number
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
    other = await conferenceTestSession(db)
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: owner.user.id,
        token: 'synthetic-second-session',
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    second = { ...owner, sessionId: session.id }
  })
  beforeEach(async () => {
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    provider = fakeZoom()
    now = Date.now()
    deps = {
      db,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
      now: () => now,
    }
  })
  afterAll(async () => {
    await database?.drop()
  })
  const query = (state: string, extra: Record<string, string> = { code: 'synthetic-code' }) =>
    new URLSearchParams({ state, ...extra })
  async function start(principal = owner, id?: string) {
    const url = new URL((await beginZoomConnection(deps, principal, id)).authorizationUrl)
    return { url, state: url.searchParams.get('state') as string }
  }
  async function connect(principal = owner) {
    const { state } = await start(principal)
    expect(await finishZoomConnection(deps, principal, query(state))).toBe('connected')
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('user_id', '=', principal.user.id)
      .where('external_user_id', '=', String(provider.controls.identity.id))
      .executeTakeFirstOrThrow()
  }
  const row = (id: string) =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const tokens = (value: Awaited<ReturnType<typeof row>>) =>
    JSON.parse(
      decryptConferenceCredential(
        conferenceEncryptionKey(TEST_CONFERENCE_KEY),
        conferenceAad(
          'connection-tokens',
          owner.user.id,
          value.id,
          value.external_user_id as string,
        ),
        value.credentials as Buffer,
      ),
    ) as { refreshToken: string }

  it('stores only a state digest, encrypts a session-bound verifier and creates no calendar/login account', async () => {
    const { url, state } = await start(),
      saved = await db.selectFrom('conference_oauth_states').selectAll().executeTakeFirstOrThrow()
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(saved.state_hash).toBe(createHash('sha256').update(state).digest('hex'))
    const verifier = decryptConferenceCredential(
      conferenceEncryptionKey(TEST_CONFERENCE_KEY),
      conferenceStateAad(owner.user.id, saved.state_hash, owner.sessionId, 'identity', null),
      saved.verifier as Buffer,
    )
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
    expect(saved.verifier?.includes(Buffer.from(verifier))).toBe(false)
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('connected')
    const metadata = await listConferenceConnections(deps, owner)
    expect(metadata.data[0]).toMatchObject({
      displayName: 'Settings',
      accountEmail: 'zoom@example.com',
      status: 'active',
    })
    expect(JSON.stringify(metadata)).not.toMatch(
      /synthetic-zoom-(access|refresh)|external_user_id|credentials|operation_id|verifier|state_hash/,
    )
    expect(await db.selectFrom('calendar_connections').select('id').execute()).toHaveLength(0)
    expect(
      await db
        .selectFrom('auth.account')
        .select('id')
        .where('userId', '=', owner.user.id)
        .execute(),
    ).toHaveLength(0)
  })
  it('rejects other users/sessions, expiry, duplicate and reused state without redeeming', async () => {
    const { state } = await start()
    expect(await finishZoomConnection(deps, other, query(state))).toBe('invalid_state')
    expect(await finishZoomConnection(deps, second, query(state))).toBe('invalid_state')
    const duplicate = query(state)
    duplicate.append('state', state)
    expect(await finishZoomConnection(deps, owner, duplicate)).toBe('invalid_state')
    expect(provider.calls).toHaveLength(0)
    now += 600001
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    now -= 600001
    expect(
      await finishZoomConnection(
        deps,
        owner,
        query(state, { error: 'access_denied', error_description: 'synthetic-private-prose' }),
      ),
    ).toBe('denied')
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    expect(provider.calls).toHaveLength(0)
  })
  it.each([
    { code: 'one', unexpected: 'value' },
    { code: 'one', error: 'access_denied' },
    { code: 'with space' },
    { code: 'x'.repeat(8193) },
  ] as Record<string, string>[])(
    'consumes malformed callbacks once without upstream calls',
    async (extra) => {
      const { state } = await start()
      expect(await finishZoomConnection(deps, owner, query(state, extra))).not.toBe('connected')
      expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
      expect(provider.calls).toHaveLength(0)
    },
  )
  it('redeems a concurrent callback at most once', async () => {
    const { state } = await start(),
      outcomes = await Promise.all([
        finishZoomConnection(deps, owner, query(state)),
        finishZoomConnection(deps, owner, query(state)),
      ])
    expect(outcomes.sort()).toEqual(['connected', 'invalid_state'])
    expect(provider.calls.filter((c) => c.url.includes('/oauth/token'))).toHaveLength(1)
  })
  it('keeps the same stable ID for the same owner and prevents identity/owner transfer', async () => {
    const first = await connect()
    const secondAttempt = await start()
    expect(await finishZoomConnection(deps, owner, query(secondAttempt.state))).toBe('connected')
    expect((await listConferenceConnections(deps, owner)).data.map((v) => v.id)).toEqual([first.id])
    const foreign = await start(other)
    expect(await finishZoomConnection(deps, other, query(foreign.state))).toBe('account_in_use')
    expect((await listConferenceConnections(deps, other)).data).toEqual([])
    const reconnect = await start(owner, first.id)
    provider.controls.identity.id = 'different-identity'
    expect(await finishZoomConnection(deps, owner, query(reconnect.state))).toBe(
      'identity_mismatch',
    )
    expect(await row(first.id)).toMatchObject({
      status: 'needs_reauth',
      credentials: null,
      external_user_id: 'synthetic-zoom-identity',
    })
  })
  it('bounds pending attempts and releases capacity after five disconnected identities', async () => {
    for (let i = 0; i < 7; i++) await start()
    expect((await listConferenceConnections(deps, owner)).pendingAttempts).toBe(5)
    for (let i = 0; i < 5; i++) {
      provider.controls.identity.id = `disconnected-${i}`
      const connected = await connect()
      await disconnectConference(deps, owner, connected.id)
    }
    const rows = await db
      .selectFrom('conference_connections')
      .select(['status', 'credentials'])
      .execute()
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.status === 'disconnected' && row.credentials === null)).toBe(
      true,
    )
    expect((await listConferenceConnections(deps, owner)).data).toEqual([])
    await expect(start()).resolves.toBeDefined()
    provider.controls.identity.id = 'sixth-identity'
    await connect()
    expect((await listConferenceConnections(deps, owner)).data).toHaveLength(1)
  })
  it('counts only connected identities and prevents old-ID reconnection from bypassing capacity', async () => {
    provider.controls.identity.id = 'historical-identity'
    const historical = await connect()
    await disconnectConference(deps, owner, historical.id)
    for (let i = 0; i < 5; i++) {
      provider.controls.identity.id = `active-${i}`
      await connect()
    }
    const listed = await listConferenceConnections(deps, owner)
    expect(listed.data).toHaveLength(5)
    expect(listed.data.some((row) => row.id === historical.id)).toBe(false)
    await expect(start()).rejects.toMatchObject({ code: 'zoom_connection_limit' })
    await expect(start(owner, historical.id)).rejects.toMatchObject({
      code: 'zoom_connection_limit',
    })
    expect(await row(historical.id)).toMatchObject({ status: 'disconnected', credentials: null })
    const current = listed.data[0]
    expect(current).toBeDefined()
    const existing = await row(current?.id as string)
    provider.controls.identity.id = existing.external_user_id
    const replacement = await start(owner, existing.id)
    expect(await finishZoomConnection(deps, owner, query(replacement.state))).toBe('connected')
    expect((await listConferenceConnections(deps, owner)).data).toHaveLength(5)
    await disconnectConference(deps, owner, existing.id)
    const reconnect = await start(owner, historical.id)
    expect(await row(historical.id)).toMatchObject({ status: 'needs_reauth', credentials: null })
    await expect(start()).rejects.toMatchObject({ code: 'zoom_connection_limit' })
    provider.controls.identity.id = 'historical-identity'
    expect(await finishZoomConnection(deps, owner, query(reconnect.state))).toBe('connected')
    expect((await listConferenceConnections(deps, owner)).data.map((row) => row.id)).toContain(
      historical.id,
    )
    expect((await listConferenceConnections(deps, owner)).data).toHaveLength(5)
  })
  it('rechecks capacity at callback commit and serializes two pending new identities at the last place', async () => {
    for (let i = 0; i < 4; i++) {
      provider.controls.identity.id = `active-${i}`
      await connect()
    }
    const a = await start(),
      b = await start()
    provider.controls.tokenHook = async (init) => {
      provider.controls.identity.id = new URLSearchParams(String(init.body)).get('code')
      return Response.json(provider.controls.token)
    }
    const outcomes = await Promise.all([
      finishZoomConnection(deps, owner, query(a.state, { code: 'new-identity-a' })),
      finishZoomConnection(deps, owner, query(b.state, { code: 'new-identity-b' })),
    ])
    expect(outcomes.sort()).toEqual(['connected', 'connection_limit'])
    expect((await listConferenceConnections(deps, owner)).data).toHaveLength(5)
    expect(
      await db
        .selectFrom('conference_connections')
        .select('id')
        .where('status', '!=', 'disconnected')
        .execute(),
    ).toHaveLength(5)
  })
  it('a normal grant for a disconnected identity recovers its original ID without consuming a historical cap', async () => {
    const original = await connect()
    await disconnectConference(deps, owner, original.id)
    expect((await listConferenceConnections(deps, owner)).data).toEqual([])
    const restored = await connect()
    expect(restored.id).toBe(original.id)
    expect((await listConferenceConnections(deps, owner)).data.map((row) => row.id)).toEqual([
      original.id,
    ])
  })
  it('disconnects locally and invalidates all outstanding attempts without revoking upstream', async () => {
    const first = await connect()
    const pending = await start()
    await disconnectConference(deps, owner, first.id)
    expect(await row(first.id)).toMatchObject({
      id: first.id,
      status: 'disconnected',
      credentials: null,
      operation_id: null,
      scopes: [],
    })
    expect(await finishZoomConnection(deps, owner, query(pending.state))).toBe('invalid_state')
    expect(provider.calls).toHaveLength(2)
    await expect(disconnectConference(deps, other, first.id)).rejects.toMatchObject({
      code: 'zoom_connection_not_found',
    })
  })
  it('durably retires credentials before rotation, serializes concurrent refreshes, and never retries an old token', async () => {
    const first = await connect(),
      entered = deferred<void>(),
      release = deferred<Response>()
    provider.controls.tokenHook = async () => {
      entered.resolve()
      return release.promise
    }
    const refreshing = refreshConference(deps, owner, first.id)
    await entered.promise
    expect(await row(first.id)).toMatchObject({ status: 'refreshing', credentials: null })
    const concurrent = refreshConference(deps, owner, first.id)
    provider.controls.token.refresh_token = 'synthetic-rotated-refresh'
    release.resolve(Response.json(provider.controls.token))
    await refreshing
    // A serialized explicit second action may rotate the new token, never the retired one.
    provider.controls.tokenHook = undefined
    const outcomes = await Promise.allSettled([concurrent])
    expect(outcomes[0]?.status).toBe('fulfilled')
    const refreshBodies = provider.calls
      .filter((c) => new URLSearchParams(String(c.init.body)).get('grant_type') === 'refresh_token')
      .map((c) => new URLSearchParams(String(c.init.body)).get('refresh_token'))
    expect(refreshBodies).toEqual(['synthetic-zoom-refresh', 'synthetic-rotated-refresh'])
    expect(tokens(await row(first.id)).refreshToken).toBe('synthetic-rotated-refresh')
  })
  it.each([undefined, 'user:read:user meeting:write:meeting'])(
    'retired rotating tokens remain unusable after invalid returned scopes: %s',
    async (scope) => {
      const first = await connect()
      provider.controls.token.refresh_token = 'synthetic-new-rotating-token'
      if (scope === undefined) delete provider.controls.token.scope
      else provider.controls.token.scope = scope
      await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
        code: scope ? 'zoom_permissions_missing' : 'zoom_provider_unavailable',
      })
      expect(await row(first.id)).toMatchObject({
        status: 'needs_reauth',
        credentials: null,
        operation_id: null,
      })
      const count = provider.calls.length
      await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
        code: 'zoom_needs_reauth',
      })
      expect(provider.calls).toHaveLength(count)
    },
  )
  it('persists the new refresh token after a transient metadata error and uses it on the next explicit refresh', async () => {
    const first = await connect()
    provider.controls.token.refresh_token = 'synthetic-rotated-refresh'
    provider.controls.identityStatus = 503
    await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
      code: 'zoom_provider_unavailable',
    })
    expect(await row(first.id)).toMatchObject({
      status: 'active',
      last_error: 'provider_unavailable',
    })
    expect(tokens(await row(first.id)).refreshToken).toBe('synthetic-rotated-refresh')
    provider.controls.identityStatus = 200
    await refreshConference(deps, owner, first.id)
    expect(new URLSearchParams(String(provider.calls.at(-2)?.init.body)).get('refresh_token')).toBe(
      'synthetic-rotated-refresh',
    )
  })
  it('rejects a changed identity and ciphertext bound to a different key without retrying provider access', async () => {
    const first = await connect()
    provider.controls.identity.id = 'changed-id'
    await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
      code: 'zoom_identity_mismatch',
    })
    expect(await row(first.id)).toMatchObject({ status: 'needs_reauth', credentials: null })
    provider.controls.identity.id = 'synthetic-zoom-identity'
    await connect()
    const count = provider.calls.length
    await expect(
      refreshConference(
        {
          ...deps,
          zoom: { client: provider.client, encryptionKey: Buffer.alloc(32, 21).toString('base64') },
        },
        owner,
        first.id,
      ),
    ).rejects.toMatchObject({ code: 'zoom_needs_reauth' })
    expect(provider.calls).toHaveLength(count)
  })
  it('a failed final commit cannot make a rotating refresh token reusable', async () => {
    const first = await connect()
    await database.pool.query(
      `CREATE FUNCTION reject_zoom_test_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${first.id}'::uuid AND NEW.credentials IS NOT NULL THEN RAISE EXCEPTION 'synthetic final commit rejection'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER reject_zoom_test_commit AFTER UPDATE ON conference_connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_zoom_test_commit();`,
    )
    try {
      provider.controls.token.refresh_token = 'synthetic-rotated-refresh'
      await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
        code: 'zoom_refresh_incomplete',
      })
      expect(await row(first.id)).toMatchObject({ status: 'refreshing', credentials: null })
      const count = provider.calls.length
      await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
        code: 'zoom_needs_reauth',
      })
      expect(provider.calls).toHaveLength(count)
    } finally {
      await database.pool.query(
        'DROP TRIGGER reject_zoom_test_commit ON conference_connections; DROP FUNCTION reject_zoom_test_commit();',
      )
    }
    await disconnectConference(deps, owner, first.id)
    expect(await row(first.id)).toMatchObject({
      status: 'disconnected',
      credentials: null,
      operation_id: null,
    })
  })
  it('disconnect racing provider I/O leaves no resurrected access', async () => {
    const first = await connect(),
      entered = deferred<void>(),
      release = deferred<Response>()
    provider.controls.tokenHook = async () => {
      entered.resolve()
      return release.promise
    }
    const refreshing = refreshConference(deps, owner, first.id)
    await entered.promise
    const disconnect = disconnectConference(deps, owner, first.id)
    release.resolve(Response.json(provider.controls.token))
    await refreshing
    await disconnect
    expect(await row(first.id)).toMatchObject({
      status: 'disconnected',
      credentials: null,
      operation_id: null,
    })
  })
  it('account deletion racing callback I/O wipes credentials, attempts and display identity while retaining a secret-free ID', async () => {
    const disposable = await conferenceTestSession(db),
      initial = await start(disposable),
      entered = deferred<void>(),
      release = deferred<Response>()
    provider.controls.tokenHook = async () => {
      entered.resolve()
      return release.promise
    }
    const finishing = finishZoomConnection(deps, disposable, query(initial.state))
    await entered.promise
    const deletion = db.deleteFrom('auth.user').where('id', '=', disposable.user.id).execute()
    release.resolve(Response.json(provider.controls.token))
    expect(await finishing).toBe('connected')
    await deletion
    const tombstone = await db
      .selectFrom('conference_connections')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(tombstone).toMatchObject({
      user_id: null,
      external_user_id: null,
      account_email: null,
      display_name: null,
      credentials: null,
      operation_id: null,
      status: 'disconnected',
      scopes: [],
      last_error: null,
    })
    expect(await db.selectFrom('conference_oauth_states').selectAll().execute()).toHaveLength(0)
    provider.controls.tokenHook = undefined
    const replacement = await conferenceTestSession(db)
    await db
      .updateTable('auth.user')
      .set({ email: disposable.user.email })
      .where('id', '=', replacement.user.id)
      .execute()
    expect((await listConferenceConnections(deps, replacement)).data).toEqual([])
    const fresh = await connect(replacement)
    expect(fresh.id).not.toBe(tombstone.id)
    await expect(disconnectConference(deps, replacement, tombstone.id)).rejects.toMatchObject({
      code: 'zoom_connection_not_found',
    })
  })
  async function pauseFirstCommit() {
    const pool = createPool(database.url),
      reached = deferred<void>(),
      resume = deferred<void>()
    let armed = true
    const proxy = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (input: unknown, ...args: unknown[]) => {
                    const result = await Reflect.apply(connection.query, connection, [
                      input,
                      ...args,
                    ])
                    const text =
                      typeof input === 'string' ? input : (input as { text?: string })?.text
                    if (armed && text?.trim().toLowerCase() === 'commit') {
                      armed = false
                      reached.resolve()
                      await resume.promise
                    }
                    return result
                  }
                const value = Reflect.get(connection, key)
                return typeof value === 'function' ? value.bind(connection) : value
              },
            })
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return {
      db: createDb(proxy),
      reached: reached.promise,
      resume: () => resume.resolve(),
      close: () => pool.end(),
    }
  }
  it('disconnect between the durable callback claim and exchange invalidates the attempt before I/O', async () => {
    const first = await connect(),
      pending = await start(),
      paused = await pauseFirstCommit(),
      count = provider.calls.length
    try {
      const finishing = finishZoomConnection(
        { ...deps, db: paused.db },
        owner,
        query(pending.state),
      )
      await paused.reached
      const claim = await db
        .selectFrom('conference_oauth_states')
        .select(['claimed', 'verifier'])
        .executeTakeFirstOrThrow()
      expect(claim).toEqual({ claimed: true, verifier: null })
      await disconnectConference(deps, owner, first.id)
      paused.resume()
      expect(await finishing).toBe('invalid_state')
      expect(provider.calls).toHaveLength(count)
      expect(await row(first.id)).toMatchObject({ status: 'disconnected', credentials: null })
    } finally {
      paused.resume()
      await paused.close()
    }
  })
  it('disconnect between durable token retirement and refresh prevents provider I/O and resurrection', async () => {
    const first = await connect(),
      paused = await pauseFirstCommit(),
      count = provider.calls.length
    try {
      const refreshing = refreshConference({ ...deps, db: paused.db }, owner, first.id)
      const outcome = refreshing.catch((error: unknown) => error)
      await paused.reached
      expect(await row(first.id)).toMatchObject({ status: 'refreshing', credentials: null })
      await disconnectConference(deps, owner, first.id)
      paused.resume()
      expect(await outcome).toMatchObject({ code: 'zoom_needs_reauth' })
      expect(provider.calls).toHaveLength(count)
      expect(await row(first.id)).toMatchObject({
        status: 'disconnected',
        credentials: null,
        operation_id: null,
      })
    } finally {
      paused.resume()
      await paused.close()
    }
  })
  it('failed callback commit leaves a durable consumed claim that cannot redeem the code again', async () => {
    const { state } = await start()
    await database.pool.query(
      "CREATE FUNCTION reject_zoom_insert_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic callback commit rejection'; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER reject_zoom_insert_commit AFTER INSERT ON conference_connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_zoom_insert_commit();",
    )
    try {
      expect(await finishZoomConnection(deps, owner, query(state))).toBe('provider_unavailable')
      expect(await db.selectFrom('conference_connections').select('id').execute()).toHaveLength(0)
      expect(
        await db
          .selectFrom('conference_oauth_states')
          .select(['claimed', 'verifier'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ claimed: true, verifier: null })
      const count = provider.calls.length
      expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
      expect(provider.calls).toHaveLength(count)
    } finally {
      await database.pool.query(
        'DROP TRIGGER reject_zoom_insert_commit ON conference_connections; DROP FUNCTION reject_zoom_insert_commit();',
      )
    }
  })
  it('disabled composition and non-session callers cannot contact a provider or create state', async () => {
    expect((await listConferenceConnections({ db }, owner)).zoomEnabled).toBe(false)
    await expect(beginZoomConnection({ db }, owner)).rejects.toMatchObject({
      code: 'zoom_disabled',
    })
    await expect(
      beginZoomConnection(deps, { ...owner, kind: 'api_key' } as never),
    ).rejects.toMatchObject({ code: 'conference_session_required' })
    expect(provider.calls).toHaveLength(0)
    expect(await db.selectFrom('conference_oauth_states').selectAll().execute()).toHaveLength(0)
  })
  it('clears access if a locked session expires while a provider call is in flight', async () => {
    const first = await connect()
    provider.controls.identityHook = async () => {
      now += 86400001
      return Response.json(provider.controls.identity)
    }
    await expect(refreshConference(deps, owner, first.id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(await row(first.id)).toMatchObject({ status: 'needs_reauth', credentials: null })
  })
})
