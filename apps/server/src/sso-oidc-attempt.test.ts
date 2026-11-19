import { createHash, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  oidcProviderValues,
  type SsoFixture,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { consumeOidcAttempt, OidcStateReplay, startOidcAttempt } from './sso-oidc-attempt.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'

const databaseUrl = process.env.DATABASE_URL
const key = randomBytes(32)
const binding = () => randomBytes(32).toString('base64url')
const sha256 = (value: string) => createHash('sha256').update(value, 'ascii').digest('hex')
const refused = 'OIDC attempt refused'

describe.skipIf(!databaseUrl)('OIDC sign-in attempts', () => {
  let owned: TestDatabase
  let db: Db
  let fixture: SsoFixture
  let primaryProvider: string
  let peerProvider: string
  let otherProvider: string
  let samlProvider: string
  let disabledProvider: string

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      fixture = await ssoFixture(client)
    } finally {
      client.release()
    }
    const provider = async (
      values: ReturnType<typeof oidcProviderValues | typeof samlProviderValues>,
      enabled = true,
    ) =>
      (
        await db
          .insertInto('sso_providers')
          .values({ ...values, enabled })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    primaryProvider = await provider(oidcProviderValues(fixture.team))
    peerProvider = await provider(oidcProviderValues(fixture.team))
    otherProvider = await provider(oidcProviderValues(fixture.otherTeam))
    samlProvider = await provider(samlProviderValues(fixture.team))
    disabledProvider = await provider(oidcProviderValues(fixture.team), false)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  const deps = () => ({ db, configurationKey: key })
  const browser = () => ({
    organizationId: fixture.team,
    providerId: primaryProvider,
    revision: 1,
    browserBinding: binding(),
    returnPath: '/app/bookings?tab=upcoming#next',
  })
  function rowFor(state: string) {
    return db
      .selectFrom('sso_attempts')
      .selectAll()
      .where('input_digest', '=', sha256(state))
      .executeTakeFirstOrThrow()
  }

  it('issues distinct S256, state and nonce values and stores only digests', async () => {
    const input = browser()
    const first = await startOidcAttempt(deps(), input)
    const second = await startOidcAttempt(deps(), input)
    expect(first.code_challenge_method).toBe('S256')
    expect(first.code_challenge).not.toBe(second.code_challenge)
    expect(first.state).not.toBe(second.state)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.state).not.toContain(input.returnPath)

    const consumed = await consumeOidcAttempt(deps(), { ...input, state: first.state })
    expect(consumed.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(consumed.codeVerifier).not.toBe(first.nonce)
    expect(first.code_challenge).toBe(
      createHash('sha256').update(consumed.codeVerifier, 'ascii').digest('base64url'),
    )
    expect(consumed.nonce).toBe(first.nonce)
    expect(consumed.returnPath).toBe(input.returnPath)
    expect(consumed.expiresAt.getTime() - consumed.createdAt.getTime()).toBe(
      authenticationAttemptLifetime * 1000,
    )

    const stored = await rowFor(first.state)
    expect(stored).toMatchObject({
      browser_binding_digest: sha256(input.browserBinding),
      input_digest: sha256(first.state),
      organization_id: input.organizationId,
      provider_id: input.providerId,
      provider_revision: input.revision,
    })
    for (const secret of [
      input.browserBinding,
      input.returnPath,
      first.state,
      first.nonce,
      consumed.codeVerifier,
    ])
      expect(JSON.stringify(stored)).not.toContain(secret)
  })

  it('binds state to its browser, team, provider, revision, key and precise encrypted value', async () => {
    const input = browser()
    const first = await startOidcAttempt(deps(), input)
    const second = await startOidcAttempt(deps(), { ...input, returnPath: '/app/event-types' })
    const [firstId] = first.state.split('.')
    const secondEnvelope = second.state.split('.')[1]
    const state = first.state
    for (const mismatch of [
      { browserBinding: binding() },
      { browserBinding: undefined },
      { providerId: peerProvider },
      { organizationId: fixture.otherTeam, providerId: otherProvider },
      { revision: 2 },
      { state: null },
      { state: `${firstId}.${secondEnvelope}` },
      { state: `${state.slice(0, 50)}${state[50] === 'A' ? 'B' : 'A'}${state.slice(51)}` },
    ]) {
      await expect(consumeOidcAttempt(deps(), { ...input, state, ...mismatch })).rejects.toThrow(
        refused,
      )
    }
    await expect(
      consumeOidcAttempt({ ...deps(), configurationKey: randomBytes(32) }, { ...input, state }),
    ).rejects.toThrow(refused)
    expect((await rowFor(state)).consumed_at).toBeNull()
    expect((await consumeOidcAttempt(deps(), { ...input, state })).returnPath).toBe(
      input.returnPath,
    )
  })

  it('rejects unsafe return paths and non-OIDC or disabled providers', async () => {
    const input = browser()
    for (const returnPath of [
      'https://attacker.example/app',
      '//attacker.example/app',
      '/app/../sign-in',
      '/app/%2e%2e/api',
      '/app/%2f%2fattacker.example',
      '/app/%5cpath',
      '/\\attacker.example/app',
      '/app\n?next=/other',
      '/application',
    ]) {
      await expect(startOidcAttempt(deps(), { ...input, returnPath })).rejects.toThrow(refused)
    }
    for (const providerId of [samlProvider, disabledProvider, otherProvider]) {
      await expect(startOidcAttempt(deps(), { ...input, providerId })).rejects.toThrow(refused)
    }
  })

  it('does not consume state after a provider revision change', async () => {
    const input = { ...browser(), providerId: peerProvider }
    const { state } = await startOidcAttempt(deps(), input)
    await db
      .updateTable('sso_providers')
      .set({ revision: 2, configuration: oidcProviderValues(fixture.team).configuration })
      .where('id', '=', peerProvider)
      .execute()
    await expect(consumeOidcAttempt(deps(), { ...input, state })).rejects.toThrow(refused)
    await expect(consumeOidcAttempt(deps(), { ...input, state, revision: 2 })).rejects.toThrow(
      refused,
    )
    expect((await rowFor(state)).consumed_at).toBeNull()
  })

  it('does not consume an expired attempt', async () => {
    const input = browser()
    const { state } = await startOidcAttempt(deps(), input)
    const fixture = await rowFor(state)
    await db.transaction().execute(async (trx) => {
      // Seed this unconsumed row just before expiry without changing the production lifetime.
      await trx.deleteFrom('sso_attempts').where('id', '=', fixture.id).execute()
      await trx
        .insertInto('sso_attempts')
        .values({
          ...fixture,
          created_at: sql`statement_timestamp() - interval '599 seconds'`,
          expires_at: sql`statement_timestamp() + interval '1 second'`,
        })
        .execute()
    })
    await sql`SELECT pg_sleep(1)`.execute(db)
    await expect(consumeOidcAttempt(deps(), { ...input, state })).rejects.toThrow(refused)
    expect((await rowFor(state)).consumed_at).toBeNull()
  })

  it('permits one exchange across concurrent consumers and refuses retries after an exchange failure', async () => {
    const input = browser()
    const { state } = await startOidcAttempt(deps(), input)
    const exchange = vi.fn(async () => {
      // A separate connection sees consumption before any exchange can start.
      expect((await rowFor(state)).consumed_at).toBeInstanceOf(Date)
      throw new Error('synthetic exchange failure')
    })
    const clients = [deps(), { ...deps(), db: createDb(owned.pool) }]
    const callbacks = await Promise.allSettled(
      clients.map(async (client) => {
        await consumeOidcAttempt(client, { ...input, state })
        return exchange()
      }),
    )
    expect(callbacks).toEqual(
      expect.arrayContaining([
        { status: 'rejected', reason: expect.any(OidcStateReplay) },
        { status: 'rejected', reason: new Error('synthetic exchange failure') },
      ]),
    )
    expect(exchange).toHaveBeenCalledTimes(1)
    await expect(consumeOidcAttempt(deps(), { ...input, state })).rejects.toThrow(refused)
  })
})
