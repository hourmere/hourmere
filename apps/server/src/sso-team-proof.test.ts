import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  ensurePersonalOrganization,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { suspendScimMember } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import {
  type IdentityFixture,
  identityFixture,
  proofValues,
  seeded,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { at, digest, insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { databaseClock } from './sso-mailbox-proof.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('browser proof on team reads', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>
  let fixture: IdentityFixture
  let actor: Awaited<ReturnType<typeof browser>>
  let teamEventId: string
  let afterResolution: (() => Promise<unknown>) | undefined

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'team_sso_proof' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('This test needs no email') },
    })
    app = instance(true)
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
      await insert(client, 'sso_policies', { organization_id: fixture.team, require_sso: true })
      actor = await browser(fixture.team)
      await insert(client, 'sso_browser_proofs', { ...proofValues(fixture), session_id: actor.id })
    } finally {
      client.release()
    }
    teamEventId = await createFixtures(db).eventType(fixture.team, null, {
      title: 'Team-only appointment',
      hosts: [{ userId: fixture.owner }],
    })
  })

  function instance(enabled: boolean) {
    const resolve = createCallerResolver({ auth, db })
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolve(headers)
        const after = afterResolution
        afterResolution = undefined
        await after?.()
        return result
      },
      publicUrl,
      routes: [eventTypeRoutes({ db })],
      ssoTeamReads: { db, capabilities: { ssoOidcEnabled: enabled, ssoSamlEnabled: false } },
    })
  }

  async function browser(organizationId: string) {
    const result = await db.transaction().execute(async (trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId: fixture.member,
          organizationId,
          now: await databaseClock(trx),
          headers: new Headers(),
        },
      ),
    )
    return { id: result.id, cookie: result.cookie.split(';')[0] as string }
  }

  function get(path: string, cookie = actor.cookie, request = app) {
    return request.request(new URL(`/api/v1/${path}`, publicUrl), { headers: { cookie } })
  }

  async function expectTeamRead() {
    const result = await get('event-types')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ data: [{ id: teamEventId }] })
  }

  async function expectRefused(cookie = actor.cookie, request = app) {
    const result = await get('event-types', cookie, request)
    expect(result.status).toBe(403)
    expect(await result.json()).toMatchObject({ error: 'sso_required' })
    expect(result.headers.get('location')).toBeNull()
  }

  it('accepts the live proof only in its browser session and team', async () => {
    await expectTeamRead()
    const me = await get('me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      sso: { requireSso: true, proofs: [{ providerId: fixture.provider.id }] },
    })
    await expectRefused((await browser(fixture.team)).cookie)

    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.otherTeam,
        userId: fixture.member,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    await db
      .insertInto('sso_policies')
      .values({
        organization_id: fixture.otherTeam,
        require_sso: true,
      })
      .execute()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: fixture.otherTeam })
      .where('id', '=', actor.id)
      .execute()
    await expectRefused()

    const personal = await ensurePersonalOrganization(db, fixture.member)
    const personalEventId = await createFixtures(db).eventType(personal, fixture.member)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: personal })
      .where('id', '=', actor.id)
      .execute()
    const personalEvents = await get('event-types')
    expect(personalEvents.status).toBe(200)
    expect(await personalEvents.json()).toMatchObject({ data: [{ id: personalEventId }] })
    const personalMe = await get('me')
    expect(await personalMe.json()).not.toHaveProperty('sso')
  })

  it('enforces a seeded policy with both protocols hard-off and leaves own identity available', async () => {
    await expectTeamRead()
    const off = instance(false)
    await expectRefused(actor.cookie, off)
    const me = await get('me', actor.cookie, off)
    expect(me.status).toBe(200)
    const identity = await me.json()
    expect(identity).toMatchObject({ user: { id: fixture.member } })
    expect(identity).not.toHaveProperty('sso')
    const team = await db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', fixture.team)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(identity)).not.toContain(team.slug)
    expect(JSON.stringify(identity)).not.toContain(team.name)
  })

  it.each([
    [
      'trust generation changes',
      () => sql`UPDATE sso_policies SET trust_generation = 2
      WHERE organization_id = ${fixture.team}`,
    ],
    [
      'link generation changes',
      () => sql`UPDATE sso_identity_links SET generation = generation + 1
      WHERE id = ${fixture.memberLink.id}`,
    ],
    [
      'domain claim expires',
      () => sql`UPDATE sso_domains
      SET verification_expires_at = statement_timestamp() WHERE id = ${fixture.domain.id}`,
    ],
    [
      'domain claim is retired',
      () => sql`UPDATE sso_domains SET retired_at = statement_timestamp()
      WHERE id = ${fixture.domain.id}`,
    ],
    [
      'domain is detached from the provider',
      () => sql`DELETE FROM sso_provider_domains
      WHERE domain_id = ${fixture.domain.id} AND provider_id = ${fixture.provider.id}`,
    ],
    [
      'provider is disabled',
      () => sql`UPDATE sso_providers SET enabled = false
      WHERE id = ${fixture.provider.id}`,
    ],
  ] as const)('ends access when the %s', async (_condition, change) => {
    await expectTeamRead()
    await change().execute(db)
    await expectRefused()
    const me = await get('me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      user: { id: fixture.member },
      sso: { requireSso: true, proofs: [] },
    })
  })

  it('refuses an expired browser proof while the session it belongs to remains live', async () => {
    await expectTeamRead()
    const expired = await browser(fixture.team)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await seeded(client, 'sso_browser_proofs', {
        ...proofValues(fixture),
        session_id: expired.id,
        created_at: at(-3600),
        expires_at: at(-1),
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await expectRefused(expired.cookie)
    const me = await get('me', expired.cookie)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      user: { id: fixture.member },
      sso: { requireSso: true, proofs: [] },
    })
  })

  it('ends access after a claim rotates and is verified at its new generation', async () => {
    await expectTeamRead()
    await db.transaction().execute(async (trx) => {
      await sql`UPDATE sso_domains SET generation = generation + 1,
        challenge_digest = ${digest()}, challenge_expires_at = ${at(3600)},
        verified_at = NULL, verification_expires_at = NULL
        WHERE id = ${fixture.domain.id}`.execute(trx)
      await sql`UPDATE sso_domains SET verified_at = statement_timestamp(),
        verification_expires_at = ${at(7200)} WHERE id = ${fixture.domain.id}`.execute(trx)
    })
    await expectRefused()
  })

  it('keeps existing proof through an unknown recheck and a renewal at the same claim generation', async () => {
    await expectTeamRead()
    await sql`UPDATE sso_domains SET last_check_outcome = 'unknown',
      last_checked_at = statement_timestamp() WHERE id = ${fixture.domain.id}`.execute(db)
    await expectTeamRead()
    await sql`UPDATE sso_domains SET last_check_outcome = 'positive',
      last_checked_at = statement_timestamp(), verification_expires_at = ${at(7 * 86400)}
      WHERE id = ${fixture.domain.id}`.execute(db)
    await expectTeamRead()
  })

  it('checks current membership even when the caller was resolved just before removal', async () => {
    await expectTeamRead()
    afterResolution = () =>
      db.deleteFrom('auth.member').where('id', '=', fixture.memberMember).execute()
    await expectRefused()
    const fallback = await get('event-types')
    expect(fallback.status).toBe(200)
    expect(await fallback.json()).toEqual({ data: [] })
  })

  it('refuses a cached browser proof when suspension commits after caller resolution', async () => {
    await expectTeamRead()
    const personal = await ensurePersonalOrganization(db, fixture.member)
    const personalEvent = await createFixtures(db).eventType(personal, fixture.member)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.otherTeam,
        userId: fixture.member,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const otherActor = await browser(fixture.otherTeam)
    const otherEvent = await createFixtures(db).eventType(fixture.otherTeam, null, {
      hosts: [{ userId: fixture.otherOwner }],
    })

    afterResolution = () => suspendScimMember(db, fixture.team, fixture.member)
    const inFlight = await get('event-types')
    expect(inFlight.status).toBe(403)
    expect(await inFlight.json()).toEqual({ error: 'team_management_access_denied' })

    const fallback = await get('event-types')
    expect(fallback.status).toBe(200)
    expect(await fallback.json()).toMatchObject({ data: [{ id: personalEvent }] })
    const otherTeam = await get('event-types', otherActor.cookie)
    expect(otherTeam.status).toBe(200)
    expect(await otherTeam.json()).toMatchObject({ data: [{ id: otherEvent }] })
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .select('session_id')
        .where('session_id', '=', actor.id)
        .executeTakeFirst(),
    ).toEqual({ session_id: actor.id })
  })
})
