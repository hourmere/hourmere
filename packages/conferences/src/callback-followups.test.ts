import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeZoomMeetings,
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  listConferenceConnections,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { ZOOM_SCOPE, zoomScopes } from './zoom.ts'

const databaseUrl = process.env.DATABASE_URL
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe.skipIf(!databaseUrl)('Zoom callback acceptance follow-ups (real Postgres)', () => {
  let database: TestDatabase, db: Db
  let owner: Awaited<ReturnType<typeof conferenceTestSession>>
  let provider: ReturnType<typeof fakeZoom>, deps: ConferenceDeps, now: number
  const gates: ReturnType<typeof deferred>[] = []
  const pending: Promise<unknown>[] = []

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
  })
  beforeEach(async () => {
    owner = await conferenceTestSession(db)
    now = Date.now()
    const team = await db
      .insertInto('auth.organization')
      .values({
        name: 'Synthetic Zoom team',
        slug: `zoom-${randomUUID()}`,
        createdAt: new Date(now),
      })
      .returning(['id', 'name', 'slug'])
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: owner.user.id,
        organizationId: team.id,
        role: 'member',
        createdAt: new Date(now),
      })
      .execute()
    owner = { ...owner, organization: { ...team, personal: false } }
    provider = fakeZoom(undefined, () => now)
    provider.controls.identity.id = `synthetic-${owner.user.id}`
    deps = {
      db,
      now: () => now,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
    }
  })
  afterEach(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled(pending)
    gates.length = 0
    pending.length = 0
  })
  afterAll(async () => {
    await database?.drop()
  })

  function query(state: string) {
    return new URLSearchParams({ state, code: 'synthetic-code' })
  }
  async function start(meetings = false) {
    const authorization = meetings
      ? await authorizeZoomMeetings(deps, owner)
      : await beginZoomConnection(deps, owner)
    return new URL(authorization.authorizationUrl).searchParams.get('state') as string
  }
  function row(id: string) {
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }
  function observe<T>(promise: Promise<T>) {
    const result = promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    pending.push(result)
    return result
  }
  function pause(phase: 'token' | 'identity') {
    const entered = deferred(),
      release = deferred(),
      response = structuredClone(
        phase === 'token' ? provider.controls.token : provider.controls.identity,
      )
    gates.push(release)
    const hook = async () => {
      entered.resolve()
      await release.promise
      return Response.json(response)
    }
    if (phase === 'token') provider.controls.tokenHook = hook
    else provider.controls.identityHook = hook
    return { entered: entered.promise, release: release.resolve }
  }
  async function removeMember() {
    await db
      .deleteFrom('auth.member')
      .where('userId', '=', owner.user.id)
      .where('organizationId', '=', owner.organization.id)
      .execute()
  }
  function connections() {
    return db
      .selectFrom('conference_connections')
      .selectAll()
      .where('user_id', '=', owner.user.id)
      .execute()
  }

  it('retires a conflicting meetings grant after a harmless in-flight row revision', async () => {
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    expect(await finishZoomConnection(deps, owner, query(await start(true)))).toBe('connected')
    const initial = (await connections())[0]
    if (!initial) throw new Error('Expected the meetings connection')
    const state = await start()
    provider.controls.token.scope = ZOOM_SCOPE
    const gate = pause('identity'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    // The existing grant has not changed; an unrelated row revision must not leave it usable.
    await db
      .updateTable('conference_connections')
      .set({ display_name: 'Synthetic renamed account' })
      .where('id', '=', initial.id)
      .execute()
    expect((await row(initial.id)).credentials?.equals(initial.credentials as Buffer)).toBe(true)
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'mode_conflict' })
    expect(await row(initial.id)).toMatchObject({
      id: initial.id,
      mode: 'meetings',
      scopes: zoomScopes('meetings'),
      status: 'needs_reauth',
      last_error: 'mode_conflict',
      operation_id: null,
      credentials: null,
    })
    const calls = provider.calls.length
    await expect(refreshConference(deps, owner, initial.id)).rejects.toMatchObject({
      code: 'zoom_needs_reauth',
    })
    expect(provider.calls).toHaveLength(calls)
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
  })

  it('accepts a callback claimed before expiry even when the exchange finishes after it', async () => {
    const state = await start(),
      hash = createHash('sha256').update(state).digest('hex'),
      attempt = await db
        .selectFrom('conference_oauth_states')
        .select('expires_at')
        .where('state_hash', '=', hash)
        .executeTakeFirstOrThrow()
    now = new Date(attempt.expires_at).getTime() - 1
    const gate = pause('token'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    expect(
      await db
        .selectFrom('conference_oauth_states')
        .select(['claimed', 'verifier'])
        .where('state_hash', '=', hash)
        .executeTakeFirstOrThrow(),
    ).toEqual({ claimed: true, verifier: null })
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    now += 2
    // Starting another attempt may clean expired unclaimed rows, but this exchange owns its claim.
    await start()
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'connected' })
    expect(await connections()).toHaveLength(1)
    expect(provider.calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
  })

  it('rejects an already expired callback before exchanging a code', async () => {
    const state = await start()
    now += 10 * 60_000
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    expect(await connections()).toHaveLength(0)
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a removed organization member before exchanging a code', async () => {
    const state = await start()
    await removeMember()
    await expect(listConferenceConnections(deps, owner)).rejects.toMatchObject({
      code: 'conference_access_denied',
    })
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
    expect(provider.calls).toHaveLength(0)
    expect(await connections()).toHaveLength(0)
  })

  it('does not persist a successful exchange after organization membership is removed', async () => {
    const state = await start(),
      gate = pause('identity'),
      finishing = observe(finishZoomConnection(deps, owner, query(state)))
    await gate.entered
    await removeMember()
    gate.release()
    expect(await finishing).toEqual({ status: 'fulfilled', value: 'invalid_state' })
    expect(provider.calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(1)
    expect(await connections()).toHaveLength(0)
    expect(await finishZoomConnection(deps, owner, query(state))).toBe('invalid_state')
  })
})
