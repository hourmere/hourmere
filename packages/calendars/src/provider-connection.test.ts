import { inspect } from 'node:util'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import {
  beginGoogleConnection,
  beginMicrosoftConnection,
  type CalendarDeps,
  finishGoogleConnection,
  finishMicrosoftConnection,
  refreshCalendarList,
} from './index.ts'
import { useGoogleConnection } from './sync.ts'
import { calendarTestSession, fakeGoogle, fakeMicrosoft, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
describe.skipIf(!url)('OAuth token error recovery (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let google: ReturnType<typeof fakeGoogle>
  let microsoft: ReturnType<typeof fakeMicrosoft>
  let deps: CalendarDeps
  let now: number
  beforeAll(async () => {
    database = await createTestDatabase(url as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
  })
  beforeEach(async () => {
    await db.deleteFrom('calendar_connections').execute()
    google = fakeGoogle()
    google.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    microsoft = fakeMicrosoft()
    now = Date.now()
    deps = {
      db,
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
      microsoft: { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
  })
  afterAll(async () => {
    await database?.drop()
  })

  async function connect(provider: 'google' | 'microsoft') {
    const started =
      provider === 'google'
        ? await beginGoogleConnection(deps, owner, 'sync')
        : await beginMicrosoftConnection(deps, owner)
    const state = new URL(started.authorizationUrl).searchParams.get('state') as string
    const finish = provider === 'google' ? finishGoogleConnection : finishMicrosoftConnection
    expect(await finish(deps, owner, new URLSearchParams({ state, code: 'fake-code' }))).toBe(
      'connected',
    )
    now += 3_600_000
    return db
      .selectFrom('calendar_connections')
      .select('id')
      .where('provider', '=', provider)
      .executeTakeFirstOrThrow()
  }

  for (const provider of ['google', 'microsoft'] as const) {
    it.each(['invalid_client', 'unauthorized_client', 'invalid_request'])(
      `${provider} keeps a connection active after %s and refreshes when configuration is repaired`,
      async (error) => {
        const { id } = await connect(provider)
        const fake = provider === 'google' ? google : microsoft
        fake.controls.tokenStatus = error === 'invalid_client' ? 401 : 400
        fake.controls.token.error = error
        fake.controls.token.error_description = 'private-provider-echo fake-refresh'
        const failure = await refreshCalendarList(deps, owner, id).catch((error: unknown) => error)
        expect(failure).toMatchObject({
          code: `${provider}_calendar_provider_unavailable`,
          cause: { oauthError: error, message: `provider_unavailable (${error})` },
        })
        expect(inspect(failure)).not.toMatch(/private-provider-echo|fake-refresh/)
        expect(
          await db
            .selectFrom('calendar_connections')
            .select('status')
            .where('id', '=', id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'active' })
        const attempts = fake.calls.filter((call) => call.url.pathname.endsWith('/token')).length
        fake.controls.tokenStatus = 200
        delete fake.controls.token.error
        delete fake.controls.token.error_description
        await refreshCalendarList(deps, owner, id)
        expect(fake.calls.filter((call) => call.url.pathname.endsWith('/token'))).toHaveLength(
          attempts + 1,
        )
      },
    )

    it(`${provider} marks an invalid grant as needing reauthorization and refuses another token call`, async () => {
      const { id } = await connect(provider)
      const fake = provider === 'google' ? google : microsoft
      fake.controls.tokenStatus = 400
      fake.controls.token.error = 'invalid_grant'
      await expect(refreshCalendarList(deps, owner, id)).rejects.toMatchObject({
        code: `${provider}_calendar_needs_reauth`,
      })
      expect(
        await db
          .selectFrom('calendar_connections')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'needs_reauth' })
      const attempts = fake.calls.length
      fake.controls.tokenStatus = 200
      delete fake.controls.token.error
      await expect(refreshCalendarList(deps, owner, id)).rejects.toMatchObject({
        code: `${provider}_calendar_needs_reauth`,
      })
      expect(fake.calls).toHaveLength(attempts)
    })
  }

  it.each(['interaction_required', 'consent_required'])(
    'Microsoft prompts for reconnection after %s and refuses further silent refreshes',
    async (error) => {
      const { id } = await connect('microsoft')
      microsoft.controls.tokenStatus = 400
      microsoft.controls.token.error = error
      await expect(refreshCalendarList(deps, owner, id)).rejects.toMatchObject({
        code: 'microsoft_calendar_needs_reauth',
        cause: { oauthError: error },
      })
      expect(
        await db
          .selectFrom('calendar_connections')
          .select(['status', 'last_error'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'needs_reauth', last_error: 'needs_reauth' })
      const attempts = microsoft.calls.length
      microsoft.controls.tokenStatus = 200
      delete microsoft.controls.token.error
      await expect(refreshCalendarList(deps, owner, id)).rejects.toMatchObject({
        code: 'microsoft_calendar_needs_reauth',
      })
      expect(microsoft.calls).toHaveLength(attempts)
    },
  )

  it('Google sync preserves the active connection and safe operator error until a retry succeeds', async () => {
    const { id } = await connect('google')
    google.controls.tokenStatus = 401
    google.controls.token.error = 'invalid_client'
    await expect(
      useGoogleConnection(deps, id, AbortSignal.timeout(1000), async () => 'synced'),
    ).rejects.toMatchObject({ code: 'provider_unavailable', oauthError: 'invalid_client' })
    expect(
      await db
        .selectFrom('calendar_connections')
        .select(['status', 'last_error'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'active', last_error: 'provider_unavailable' })
    google.controls.tokenStatus = 200
    delete google.controls.token.error
    expect(
      await useGoogleConnection(deps, id, AbortSignal.timeout(1000), async () => 'synced'),
    ).toBe('synced')
  })
})
