import { randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  ensurePersonalOrganization,
} from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { suspendScimMembership } from '@hourmere/db/scim-suspension'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql, type Transaction } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareScimSuspension } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import {
  type IdentityFixture,
  identityFixture,
  link,
  proofValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { claimedDomainValues, insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import {
  issueOidcSession,
  lockOidcSignInContext,
  oidcSignInTiming,
  writeOidcSession,
} from './sso-oidc-session.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('SCIM session authorization revocation', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: IdentityFixture
  let personal: string
  const emailedLinks = new Map<string, URL>()

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_session' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('Use the synthetic mail queue') },
      queueSignInEmail: async ({ email, url }) => {
        emailedLinks.set(email, new URL(url))
      },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
    } finally {
      client.release()
    }
    personal = await ensurePersonalOrganization(db, fixture.member)
  })

  async function browser(organizationId: string, userId = fixture.member) {
    const { id, cookie } = await db
      .transaction()
      .execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          { userId, organizationId, now: new Date().toISOString(), headers: new Headers() },
        ),
      )
    return { id, cookie: cookie.split(';')[0] as string }
  }

  const session = (id: string, connection = db) =>
    connection
      .selectFrom('auth.session')
      .select(['activeOrganizationId', 'expiresAt'])
      .where('id', '=', id)
      .executeTakeFirst()

  const getSession = (cookie: string) =>
    auth.handler(new Request(`${publicUrl}/api/auth/get-session`, { headers: { cookie } }))

  async function expectSignedOut(cookie: string) {
    const response = await getSession(cookie)
    expect(response.status).toBe(200)
    expect((await response.json()) === null).toBe(true)
  }

  const switchTeam = (cookie: string, organizationId: string) =>
    auth.handler(
      new Request(`${publicUrl}/api/auth/organization/set-active`, {
        method: 'POST',
        headers: { cookie, origin: publicUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      }),
    )

  async function makeRefreshDue(sessionId: string) {
    return db
      .updateTable('auth.session')
      .set({ expiresAt: sql`clock_timestamp() + interval '5 days'` })
      .where('id', '=', sessionId)
      .returning('expiresAt')
      .executeTakeFirstOrThrow()
  }

  async function oidcInputs() {
    const provider = {
      organizationId: fixture.team,
      providerId: String(fixture.provider.id),
      revision: Number(fixture.provider.revision),
    }
    const domain = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team, `team-${randomUUID()}.example.com`))
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_provider_domains')
      .values({
        organization_id: fixture.team,
        provider_id: provider.providerId,
        domain_id: domain.id,
      })
      .execute()
    const candidate = await db
      .updateTable('sso_identity_links')
      .set({
        proven_email: `member@${domain.name}`,
        email_proven_at: sql`clock_timestamp()`,
      })
      .where('id', '=', String(fixture.memberLink.id))
      .returning(['id', 'user_id', 'generation', 'proven_email', 'retired_at'])
      .executeTakeFirstOrThrow()
    const attempt = await db
      .selectNoFrom([
        sql<string>`uuidv7()`.as('id'),
        sql<Date>`clock_timestamp() + interval '5 minutes'`.as('expiresAt'),
      ])
      .executeTakeFirstOrThrow()
    return { provider, candidate, attempt, options: { publicUrl, secret, headers: new Headers() } }
  }

  function issue({
    provider,
    candidate,
    attempt,
    options,
  }: Awaited<ReturnType<typeof oidcInputs>>) {
    return issueOidcSession(db, provider, candidate, undefined, attempt, options)
  }

  async function suspension(organizationId = fixture.team) {
    const target = await db
      .transaction()
      .execute((trx) => prepareScimSuspension(trx, organizationId, fixture.member))
    return (trx: Transaction<Database>) => suspendScimMembership(trx, target)
  }

  const teamProofs = (connection = db, team = fixture.team) =>
    connection
      .selectFrom('sso_browser_proofs')
      .select('id')
      .where('organization_id', '=', team)
      .where('user_id', '=', fixture.member)
      .execute()

  function joinOtherTeam() {
    return db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.otherTeam,
        userId: fixture.member,
        role: 'member',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  async function otherTeamProof(client: pg.PoolClient, memberId: string, sessionId: string) {
    const otherLink = await link({ ...fixture, db: client }, fixture.member, fixture.otherProvider)
    return insert(client, 'sso_browser_proofs', {
      ...proofValues(fixture, otherLink),
      session_id: sessionId,
      organization_id: fixture.otherTeam,
      member_id: memberId,
      domain_id: fixture.otherDomain.id,
      domain_generation: fixture.otherDomain.generation,
    })
  }

  // The second operation really reaches a PostgreSQL lock. Release the holder even when a
  // regression makes the operation finish early, so assertions cannot leak a connection.
  async function race<First, Second>(
    hold: (trx: Transaction<Database>) => Promise<First>,
    contend: () => Promise<Second>,
    waitEvent?: 'advisory',
  ): Promise<{ first: First; second: Second }> {
    const ready = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const first = db.transaction().execute(async (trx) => {
      const pid = await trx
        .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
        .executeTakeFirstOrThrow()
      const result = await hold(trx)
      ready.resolve(pid.pid)
      await release.promise
      return result
    })
    void first.catch(ready.reject)
    let second: Promise<Second> | undefined
    try {
      const pid = await ready.promise
      second = contend()
      void second.catch(() => {})
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query<{ blocked: boolean }>(
                `SELECT EXISTS (SELECT FROM pg_stat_activity
                   WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
                     AND ($2::text IS NULL OR wait_event = $2)
                 ) AS blocked`,
                [pid, waitEvent ?? null],
              )
            ).rows[0]?.blocked,
          { timeout: 3000 },
        )
        .toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled([first, second])
    }
    return { first: await first, second: await second }
  }

  it('revokes all active-team sessions and proofs for the suspended member only', async () => {
    const active = await browser(fixture.team)
    const secondActive = await browser(fixture.team.toUpperCase())
    const survivor = await browser(personal)
    const otherUser = await browser(fixture.team, fixture.owner)
    const otherMembership = await joinOtherTeam()
    const otherTeam = await browser(fixture.otherTeam)
    const unaffectedProofs: string[] = []
    const client = await owned.pool.connect()
    try {
      for (const { id } of [active, survivor])
        await insert(client, 'sso_browser_proofs', { ...proofValues(fixture), session_id: id })
      const otherProof = await otherTeamProof(client, otherMembership.id, survivor.id)
      const ownerLink = await link({ ...fixture, db: client }, fixture.owner)
      const ownerProof = await insert(client, 'sso_browser_proofs', {
        ...proofValues(fixture, ownerLink),
        session_id: otherUser.id,
        member_id: fixture.ownerMember,
      })
      unaffectedProofs.push(String(otherProof.id), String(ownerProof.id))
    } finally {
      client.release()
    }
    expect(await teamProofs()).toHaveLength(2)

    const suspend = await suspension()
    const rollback = new Error('Roll back session revocation')
    await expect(
      db.transaction().execute(async (trx) => {
        await suspend(trx)
        expect(await session(active.id, trx)).toBeUndefined()
        expect(await teamProofs(trx)).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await session(active.id)).toBeDefined()
    expect(await teamProofs()).toHaveLength(2)
    expect((await switchTeam(survivor.cookie, fixture.team)).status).toBe(200)
    expect((await switchTeam(survivor.cookie, personal)).status).toBe(200)

    await db.transaction().execute(suspend)

    expect(await session(active.id)).toBeUndefined()
    expect(await session(secondActive.id)).toBeUndefined()
    expect(await teamProofs()).toEqual([])
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .select('id')
        .where('id', 'in', unaffectedProofs)
        .execute(),
    ).toHaveLength(2)
    await expectSignedOut(active.cookie)
    for (const [actor, organizationId] of [
      [survivor, personal],
      [otherTeam, fixture.otherTeam],
      [otherUser, fixture.team],
    ] as const) {
      const response = await getSession(actor.cookie)
      expect(response.status).toBe(200)
      const result = (await response.json()) as {
        session?: { id: string; activeOrganizationId: string }
      } | null
      expect(result?.session?.id).toBe(actor.id)
      expect(result?.session?.activeOrganizationId).toBe(organizationId)
    }
    const denied = await switchTeam(survivor.cookie, fixture.team)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    expect(denied.headers.getSetCookie().length).toBe(0)
    expect((await session(survivor.id))?.activeOrganizationId).toBe(personal)
  })

  it('does not refresh a session deleted by a concurrent suspension', async () => {
    const active = await browser(fixture.team)
    await makeRefreshDue(active.id)
    const { second: response } = await race(await suspension(), () => getSession(active.cookie))
    expect(response.status).toBe(401)
    expect(await session(active.id)).toBeUndefined()
    await expectSignedOut(active.cookie)
  })

  it.each(['HTTP', 'trusted'] as const)(
    'refuses a concurrent %s team switch after the preflight read',
    async (mode) => {
      const current = await browser(personal)
      const { second } = await race(await suspension(), async () => {
        if (mode === 'HTTP') return (await switchTeam(current.cookie, fixture.team)).status
        const response = await auth.api.setActiveOrganization({
          headers: new Headers({ cookie: current.cookie }),
          body: { organizationId: fixture.team },
          asResponse: true,
        })
        return response.status
      })
      expect(second).toBe(403)
      expect((await session(current.id))?.activeOrganizationId).toBe(personal)
    },
  )

  it('refuses browser proof issuance waiting behind the suspension', async () => {
    const inputs = await oidcInputs()
    const { second } = await race(await suspension(), () => issue(inputs))
    expect('reason' in second ? second.reason : undefined).toBe('mailbox_unproven')
    expect(await teamProofs()).toEqual([])
  })

  it('revokes a browser proof that commits while suspension is waiting', async () => {
    const { provider, candidate, attempt, options } = await oidcInputs()
    const suspend = await suspension()
    const { first: issued } = await race(
      async (trx) => {
        const context = await lockOidcSignInContext(
          trx,
          provider,
          candidate,
          candidate.proven_email,
        )
        if (context.reason !== undefined) expect.unreachable(context.reason)
        const timing = await oidcSignInTiming(trx, context, attempt.expiresAt, undefined, options)
        if (timing.reason !== undefined) expect.unreachable(timing.reason)
        return writeOidcSession(trx, provider, context, attempt.id, timing, options)
      },
      () => db.transaction().execute(suspend),
    )
    expect(await session(issued.sessionId)).toBeUndefined()
    expect(await teamProofs()).toEqual([])
  })

  it('serializes suspensions of one account across teams with cross-scoped browser proofs', async () => {
    const active = await browser(fixture.team)
    const otherMembership = await joinOtherTeam()
    const otherActive = await browser(fixture.otherTeam)
    const client = await owned.pool.connect()
    try {
      await insert(client, 'sso_browser_proofs', {
        ...proofValues(fixture),
        session_id: otherActive.id,
      })
      await otherTeamProof(client, otherMembership.id, active.id)
    } finally {
      client.release()
    }

    const suspend = await suspension()
    const suspendOther = await suspension(fixture.otherTeam)
    await race(suspend, () => db.transaction().execute(suspendOther), 'advisory')

    expect(await session(active.id)).toBeUndefined()
    expect(await session(otherActive.id)).toBeUndefined()
    expect(await teamProofs()).toEqual([])
    expect(await teamProofs(db, fixture.otherTeam)).toEqual([])
  })

  it('keeps the existing query counts without SCIM suspension data', async () => {
    const { email } = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', fixture.member)
      .executeTakeFirstOrThrow()
    await auth.api.signInMagicLink({
      body: { email, callbackURL: '/' },
      headers: new Headers({ origin: publicUrl }),
    })
    const query = emailedLinks.get(email)?.hash.slice(1)
    expect(query).toBeTruthy()
    const current = await browser(personal)
    const refresh = await makeRefreshDue(current.id)
    const inputs = await oidcInputs()
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const signedIn = await auth.handler(
        new Request(`${publicUrl}/api/auth/magic-link/verify?${query}`),
      )
      expect(signedIn.status).toBe(302)
      expect(
        signedIn.headers.getSetCookie().some((value) => value.includes('session_token=')),
      ).toBe(true)
      const signInQueries = queries.mock.calls.length

      queries.mockClear()
      const refreshed = await getSession(current.cookie)
      expect(refreshed.status).toBe(200)
      const result = (await refreshed.json()) as { session?: { id: string } } | null
      expect(result?.session?.id).toBe(current.id)
      const refreshQueries = queries.mock.calls.length
      expect((await session(current.id))?.expiresAt.getTime()).toBeGreaterThan(
        refresh.expiresAt.getTime(),
      )

      queries.mockClear()
      expect((await switchTeam(current.cookie, fixture.team)).status).toBe(200)
      const switchQueries = queries.mock.calls.length
      expect((await session(current.id))?.activeOrganizationId).toBe(fixture.team)

      queries.mockClear()
      const proof = await issue(inputs)
      expect(proof).toHaveProperty('sessionId')
      const proofQueries = queries.mock.calls.length
      expect({ signInQueries, refreshQueries, switchQueries, proofQueries }).toEqual({
        signInQueries: 12,
        refreshQueries: 3,
        switchQueries: 23,
        proofQueries: 14,
      })
    } finally {
      queries.mockRestore()
    }
  })
})
