import { createHash, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  conferenceAad,
  conferenceEncryptionKey,
  conferenceStateAad,
  conferenceTokenAad,
  decryptConferenceCredential,
  encryptConferenceCredential,
} from './credentials.ts'
import {
  authorizeZoomMeetings,
  beginZoomConnection,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
  listConferenceConnections,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { ZOOM_SCOPE, type ZoomMode, zoomScopes } from './zoom.ts'

const databaseUrl = process.env.DATABASE_URL
const key = conferenceEncryptionKey(TEST_CONFERENCE_KEY)
describe.skipIf(!databaseUrl)('explicit Zoom authorization modes (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    other: typeof owner
  let provider: ReturnType<typeof fakeZoom>,
    deps: ConferenceDeps,
    settings: NonNullable<ConferenceDeps['zoom']>
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
    other = await conferenceTestSession(db)
  })
  afterAll(async () => {
    await database?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    provider = fakeZoom()
    settings = {
      client: provider.client,
      encryptionKey: TEST_CONFERENCE_KEY,
      meetingsEnabled: true,
    }
    deps = { db, zoom: settings }
  })
  async function start(mode: ZoomMode, id?: string) {
    const result =
      mode === 'meetings'
        ? await authorizeZoomMeetings(deps, owner, id)
        : await beginZoomConnection(deps, owner, id)
    const url = new URL(result.authorizationUrl),
      state = url.searchParams.get('state') as string
    return { url, state, query: new URLSearchParams({ state, code: 'synthetic-code' }) }
  }
  async function connect(mode: ZoomMode = 'identity', id?: string) {
    const attempt = await start(mode, id)
    provider.controls.token.scope = zoomScopes(mode).join(' ')
    expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('connected')
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('external_user_id', '=', String(provider.controls.identity.id))
      .executeTakeFirstOrThrow()
  }
  const saved = (id: string) =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  it('keeps identity grants minimal while requesting a separate exact meeting set in canonical order', async () => {
    const attempt = await start('meetings')
    expect(attempt.url.searchParams.get('scope')).toBe(zoomScopes('meetings').join(' '))
    expect(attempt.url.searchParams.get('optional_scope')).toBe('')
    expect(attempt.url.searchParams.has('include_granted_scopes')).toBe(false)
    provider.controls.token.scope = [...zoomScopes('meetings')].reverse().join(' ')
    expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('connected')
    const row = await db.selectFrom('conference_connections').selectAll().executeTakeFirstOrThrow()
    expect(row.mode).toBe('meetings')
    expect(row.scopes).toEqual(zoomScopes('meetings'))
    expect((await listConferenceConnections(deps, owner)).data[0]?.mode).toBe('meetings')
    expect(() =>
      decryptConferenceCredential(
        key,
        conferenceAad('connection-tokens', owner.user.id, row.id, row.external_user_id as string),
        row.credentials as Buffer,
      ),
    ).toThrow()
    expect(
      JSON.parse(
        decryptConferenceCredential(
          key,
          conferenceTokenAad(owner.user.id, row.id, row.external_user_id as string, 'meetings'),
          row.credentials as Buffer,
        ),
      ).refreshToken,
    ).toBe('synthetic-zoom-refresh')
  })
  it('is opt-in and never changes a pending attempt when the instance flag changes', async () => {
    settings.meetingsEnabled = false
    await expect(authorizeZoomMeetings(deps, owner)).rejects.toMatchObject({
      code: 'zoom_meetings_disabled',
    })
    const identity = await start('identity')
    settings.meetingsEnabled = true
    expect(identity.url.searchParams.get('scope')).toBe(ZOOM_SCOPE)
    expect(await finishZoomConnection(deps, owner, identity.query)).toBe('connected')
    const meeting = await start('meetings')
    settings.meetingsEnabled = false
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    expect(await finishZoomConnection(deps, owner, meeting.query)).toBe('connected')
    expect((await listConferenceConnections(deps, owner)).zoomMeetingsEnabled).toBe(false)
  })
  it.each(['mode', 'connection'] as const)(
    'authenticates the %s decision and refuses transplanted state before exchange',
    async (change) => {
      const connection = await connect(),
        attempt = await start('meetings', connection.id)
      const before = provider.calls.length
      await db
        .updateTable('conference_oauth_states')
        .set(change === 'mode' ? { mode: 'identity' } : { connection_id: null })
        .where('state_hash', '=', createHash('sha256').update(attempt.state).digest('hex'))
        .execute()
      expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('provider_unavailable')
      expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('invalid_state')
      expect(provider.calls).toHaveLength(before)
    },
  )
  it('retains legacy pending v1 rows unchanged but never exchanges them; a restarted identity flow succeeds', async () => {
    const state = randomBytes(32).toString('base64url'),
      hash = createHash('sha256').update(state).digest('hex')
    await db
      .insertInto('conference_oauth_states')
      .values({
        state_hash: hash,
        user_id: owner.user.id,
        session_id: owner.sessionId,
        connection_id: null,
        verifier: encryptConferenceCredential(
          key,
          conferenceAad('oauth-state', owner.user.id, hash, owner.sessionId),
          'legacy-synthetic-verifier',
        ),
        expires_at: new Date(Date.now() + 600000),
      })
      .execute()
    const before = await db
      .selectFrom('conference_oauth_states')
      .selectAll()
      .where('state_hash', '=', hash)
      .executeTakeFirstOrThrow()
    expect(before.binding_version).toBe(1)
    expect((await listConferenceConnections(deps, owner)).pendingAttempts).toBe(0)
    expect(
      await finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({ state, code: 'synthetic-code' }),
      ),
    ).toBe('invalid_state')
    expect(
      await db
        .selectFrom('conference_oauth_states')
        .selectAll()
        .where('state_hash', '=', hash)
        .executeTakeFirstOrThrow(),
    ).toEqual(before)
    expect(provider.calls).toHaveLength(0)
    expect((await connect()).mode).toBe('identity')
  })
  it('continues decrypting and rotating legacy active identity credentials without reconsent', async () => {
    const old = await connect()
    const legacy = encryptConferenceCredential(
      key,
      conferenceAad('connection-tokens', owner.user.id, old.id, old.external_user_id as string),
      JSON.stringify({
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        expiresAt: Date.now() + 3600000,
      }),
    )
    await db
      .updateTable('conference_connections')
      .set({ credentials: legacy })
      .where('id', '=', old.id)
      .execute()
    provider.controls.token.refresh_token = 'rotated-legacy-refresh'
    await refreshConference(deps, owner, old.id)
    const row = await saved(old.id)
    expect(row.mode).toBe('identity')
    expect(row.status).toBe('active')
    expect(new URLSearchParams(String(provider.calls.at(-2)?.init.body)).get('refresh_token')).toBe(
      'legacy-refresh',
    )
    expect(
      JSON.parse(
        decryptConferenceCredential(
          key,
          conferenceAad('connection-tokens', owner.user.id, row.id, row.external_user_id as string),
          row.credentials as Buffer,
        ),
      ).refreshToken,
    ).toBe('rotated-legacy-refresh')
  })
  it('retires unsafe credentials after wrong-mode reconsent while retaining stronger mode, stable ID and scopes', async () => {
    const initial = await connect('meetings'),
      attempt = await start('identity')
    provider.controls.token.scope = ZOOM_SCOPE
    expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('mode_conflict')
    const row = await saved(initial.id)
    expect(row).toMatchObject({
      mode: 'meetings',
      status: 'needs_reauth',
      last_error: 'mode_conflict',
      credentials: null,
      operation_id: null,
      scopes: zoomScopes('meetings'),
    })
    const count = provider.calls.length
    await expect(refreshConference(deps, owner, row.id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(provider.calls).toHaveLength(count)
    settings.meetingsEnabled = false
    const reconnect = await beginZoomConnection(deps, owner, row.id)
    expect(new URL(reconnect.authorizationUrl).searchParams.get('scope')).toBe(
      zoomScopes('meetings').join(' '),
    )
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    expect(
      await finishZoomConnection(
        deps,
        owner,
        new URLSearchParams({
          state: new URL(reconnect.authorizationUrl).searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    expect((await saved(row.id)).mode).toBe('meetings')
  })
  it('also retires a discovered stronger identity after the user chose it during another identity reconnect', async () => {
    provider.controls.identity.id = 'synthetic-first-identity'
    const first = await connect('identity')
    provider.controls.identity.id = 'synthetic-second-meetings'
    const second = await connect('meetings')
    const attempt = await start('identity', first.id)
    provider.controls.token.scope = ZOOM_SCOPE
    expect(await finishZoomConnection(deps, owner, attempt.query)).toBe('mode_conflict')
    expect(await saved(first.id)).toMatchObject({
      mode: 'identity',
      status: 'needs_reauth',
      credentials: null,
    })
    expect(await saved(second.id)).toMatchObject({
      mode: 'meetings',
      status: 'needs_reauth',
      credentials: null,
      last_error: 'mode_conflict',
      scopes: zoomScopes('meetings'),
    })
    expect(await db.selectFrom('conference_connections').select('id').execute()).toHaveLength(2)
  })
  it('only permits a deliberate identity downgrade after local disconnect, preserving its ID', async () => {
    const initial = await connect('meetings')
    await disconnectConference(deps, owner, initial.id)
    const restored = await connect('identity')
    expect(restored.id).toBe(initial.id)
    expect(restored.mode).toBe('identity')
    expect(restored.scopes).toEqual([ZOOM_SCOPE])
  })
  it('upgrades only via the explicit owned action and never accepts another user or API key', async () => {
    const initial = await connect()
    await expect(authorizeZoomMeetings(deps, other, initial.id)).rejects.toMatchObject({
      code: 'zoom_connection_not_found',
    })
    const apiKey = {
      kind: 'apiKey',
      user: owner.user,
      organization: owner.organization,
      scopes: [] as string[],
      id: 'synthetic-key',
    } as unknown as Parameters<typeof authorizeZoomMeetings>[1]
    await expect(authorizeZoomMeetings(deps, apiKey)).rejects.toMatchObject({
      code: 'conference_session_required',
    })
    const upgraded = await connect('meetings', initial.id)
    expect(upgraded.id).toBe(initial.id)
    expect(upgraded.mode).toBe('meetings')
    expect(await db.selectFrom('calendar_connections').select('id').execute()).toHaveLength(0)
  })
  it.each([
    ZOOM_SCOPE,
    `${zoomScopes('meetings').join(' ')} meeting:read:admin`,
    `${zoomScopes('meetings').join(' ')} ${ZOOM_SCOPE}`,
  ])('retires rotating meeting tokens when the returned exact set is wrong', async (scope) => {
    const initial = await connect('meetings')
    provider.controls.token.scope = scope
    await expect(refreshConference(deps, owner, initial.id)).rejects.toMatchObject({
      code: 'zoom_permissions_missing',
    })
    expect(await saved(initial.id)).toMatchObject({
      mode: 'meetings',
      status: 'needs_reauth',
      credentials: null,
      operation_id: null,
    })
    const count = provider.calls.length
    await expect(refreshConference(deps, owner, initial.id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(provider.calls).toHaveLength(count)
  })
  it('enforces exact canonical scope sets in the database and purpose-binds new state ciphertext', async () => {
    const initial = await connect('meetings')
    await expect(
      db
        .updateTable('conference_connections')
        .set({ scopes: [ZOOM_SCOPE] })
        .where('id', '=', initial.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    const attempt = await start('meetings', initial.id),
      row = await db.selectFrom('conference_oauth_states').selectAll().executeTakeFirstOrThrow()
    expect(row.binding_version).toBe(2)
    expect(row.mode).toBe('meetings')
    expect(() =>
      decryptConferenceCredential(
        key,
        conferenceStateAad(owner.user.id, row.state_hash, owner.sessionId, 'meetings', null),
        row.verifier as Buffer,
      ),
    ).toThrow()
    expect(await finishZoomConnection(deps, other, attempt.query)).toBe('invalid_state')
  })
})
