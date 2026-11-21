import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ssoHardOff,
  type TeamSsoCapabilities,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const oidc = { ssoOidcEnabled: true, ssoSamlEnabled: false }

async function seed(db: Db) {
  const [owner, otherOwner, nonRecoveryOwner, admin, member, demoted, nominee] = await Promise.all([
    createTestUser(db, 'Recovery owner'),
    createTestUser(db, 'Other recovery owner'),
    createTestUser(db, 'Owner without recovery'),
    createTestUser(db, 'Team admin'),
    createTestUser(db, 'Team member'),
    createTestUser(db, 'Demoted recovery owner'),
    createTestUser(db, 'Pending nominee'),
  ])
  const displayName = 'Locked team'
  const otherDisplayName = 'Other locked team'
  const team = await createTestTeam(
    db,
    [
      { user: owner, role: 'admin, owner' },
      { user: nonRecoveryOwner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
      { user: demoted, role: 'owner' },
      { user: nominee, role: 'owner' },
    ],
    displayName,
  )
  const otherTeam = await createTestTeam(
    db,
    [
      { user: owner, role: 'owner' },
      { user: otherOwner, role: 'owner' },
    ],
    otherDisplayName,
  )
  const optionalTeam = await createTestTeam(db, [{ user: owner, role: 'owner' }])
  const policyRevision = 23
  const otherPolicyRevision = 7
  await db
    .insertInto('sso_policies')
    .values([
      { organization_id: team.id, require_sso: true, policy_revision: policyRevision },
      { organization_id: otherTeam.id, require_sso: true, policy_revision: otherPolicyRevision },
      { organization_id: optionalTeam.id, require_sso: false },
    ])
    .execute()

  async function recoveryRecord(organizationId: string, user: TestUser) {
    const membership = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow()
    return {
      organization_id: organizationId,
      user_id: user.id,
      member_id: membership.id,
      nominated_by_user_id: nonRecoveryOwner.id,
    }
  }

  const formerRecord = await recoveryRecord(team.id, demoted)
  await db
    .insertInto('sso_recovery_owners')
    .values([
      await recoveryRecord(team.id, owner),
      await recoveryRecord(otherTeam.id, otherOwner),
      await recoveryRecord(optionalTeam.id, owner),
      formerRecord,
    ])
    .execute()
  // Keep the old acceptance in storage to exercise the live membership check independently.
  await db
    .updateTable('auth.member')
    .set({ role: 'admin' })
    .where('id', '=', formerRecord.member_id)
    .execute()
  await db
    .insertInto('sso_recovery_nominations')
    .values({
      ...(await recoveryRecord(team.id, nominee)),
      expires_at: Temporal.Now.instant().add({ hours: 72 }).toString(),
    })
    .execute()

  return {
    owner,
    otherOwner,
    peopleWithoutRecovery: { nonRecoveryOwner, admin, member, demoted, nominee },
    team: { id: team.id, displayName, policyRevision },
    otherTeam: {
      id: otherTeam.id,
      displayName: otherDisplayName,
      policyRevision: otherPolicyRevision,
    },
  }
}

describe.skipIf(!databaseUrl)('SSO recovery targets in /me', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: Awaited<ReturnType<typeof seed>>
  const appStatements: string[] = []
  let authStatements = 0

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') appStatements.push(event.query.sql)
      },
    })
    authPool = createAuthPool(owned.url, signup)
    authPool.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown
      client.query = ((...args: unknown[]) => {
        authStatements++
        return query(...args)
      }) as typeof client.query
    })
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('Unexpected sign-in email') },
    })
    fixture = await seed(db)
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function app(capabilities: TeamSsoCapabilities, discovery = true) {
    const resolver = createCallerResolver({ auth, db, ssoCapabilities: capabilities })
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      // Main's handler uses the ordinary caller resolution, without the opt-in SELECT fields.
      resolveCaller: discovery ? resolver : (headers) => resolver(headers),
      publicUrl,
      ssoTeamReads: { db, capabilities },
    })
  }

  async function browser(user: TestUser, organizationId = user.principal.organization.id) {
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId: user.id,
          organizationId,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    return { cookie: session.cookie.split(';')[0] as string }
  }

  it('lists only the caller’s accepted, enforced teams using a fresh ordinary personal session', async () => {
    const server = app(oidc)
    for (const [user, team] of [
      [fixture.owner, fixture.team],
      [fixture.otherOwner, fixture.otherTeam],
    ] as const) {
      const response = await server.request('/api/v1/me', { headers: await browser(user) })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        user: { id: user.id, email: user.email, name: user.name },
        personalOrganizationId: user.principal.organization.id,
        organization: user.principal.organization,
        principal: { kind: 'session', apiKeyId: null },
        ssoRecoveryTeams: [team],
      })
    }
    const response = await server.request('/api/v1/me', {
      headers: await browser(fixture.owner, fixture.team.id),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      organization: { id: fixture.team.id, name: '', slug: '', personal: false },
      ssoRecoveryTeams: [fixture.team],
    })
  })

  it('omits teams for every insufficient role or recovery enrollment state', async () => {
    const server = app(oidc)
    for (const [state, user] of Object.entries(fixture.peopleWithoutRecovery)) {
      const response = await server.request('/api/v1/me', { headers: await browser(user) })
      expect(response.status, state).toBe(200)
      expect(await response.json(), state).not.toHaveProperty('ssoRecoveryTeams')
    }
  })

  it('omits recovery targets for an enrolled owner with a personal API key', async () => {
    const { owner } = fixture
    const { key } = await auth.api.createApiKey({ body: { userId: owner.id } })
    const response = await app(oidc).request('/api/v1/me', {
      headers: { ...(await browser(owner)), authorization: `Bearer ${key}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ principal: { kind: 'api_key' } })
    expect(body).not.toHaveProperty('ssoRecoveryTeams')
    expect(appStatements.at(-1)).not.toContain('sso_recovery_owners')
  })

  it('omits recovery targets even with an enforced row and accepted owner when both protocols are off', async () => {
    const headers = await browser(fixture.owner)
    appStatements.length = 0
    const response = await app(ssoHardOff).request('/api/v1/me', { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('ssoRecoveryTeams')
    expect(appStatements).toHaveLength(1)
    expect(appStatements[0]).not.toContain('sso_recovery_owners')
  })

  it.each([ssoHardOff, oidc])(
    'preserves main’s /me body and statement count with capabilities %j',
    async (capabilities) => {
      const { member } = fixture.peopleWithoutRecovery
      const main = app(capabilities, false)
      const current = app(capabilities)
      for (const organizationId of [member.principal.organization.id, fixture.team.id]) {
        const team = organizationId === fixture.team.id
        const headers = await browser(member, organizationId)
        async function capture(server: ReturnType<typeof createApp>) {
          appStatements.length = 0
          authStatements = 0
          const response = await server.request('/api/v1/me', { headers })
          expect(response.status).toBe(200)
          const body = await response.text()
          expect(JSON.parse(body)).not.toHaveProperty('ssoRecoveryTeams')
          expect(authStatements).toBeGreaterThan(0)
          return { body, appStatements: appStatements.length, authStatements }
        }
        const before = await capture(main)
        expect(before.body).toBe(
          JSON.stringify({
            user: { id: member.id, name: member.name, email: member.email },
            personalOrganizationId: member.principal.organization.id,
            organization: team
              ? { id: organizationId, name: '', slug: '', personal: false }
              : member.principal.organization,
            principal: { kind: 'session', apiKeyId: null },
            ...(team &&
              capabilities.ssoOidcEnabled && {
                sso: { requireSso: true, providers: [], attempts: [], links: [], proofs: [] },
              }),
          }),
        )
        expect(before.appStatements).toBe(team ? (capabilities.ssoOidcEnabled ? 3 : 2) : 1)
        expect(await capture(current)).toEqual(before)
      }
    },
  )
})
