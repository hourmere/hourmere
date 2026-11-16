import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  type ScimClaimCompletion,
  type SignupPolicy,
  scimClaimCompletion,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import {
  createTestDatabase,
  type TestDatabase,
  takePoolOrderViolations,
} from '@hourmere/db/testing'
import { reserveInvitationEmailBudget } from '@hourmere/notifications'
import { sql } from 'kysely'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { manageInvitation } from '../../../packages/auth/src/invitations.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import type { ScimResourceHandler } from './scim.ts'
import { SCIM_URN, scimDiscovery } from './scim-discovery.ts'
import { type ScimUserCreationDeps, scimUserCreation } from './scim-user-create.ts'
import { scimUsers } from './scim-users.ts'
import { productionAppOptions, productionAuthOptions } from './server.ts'

// Claim completion through invitation acceptance (docs/scim.md), over real HTTP on a socket and
// real Postgres. Expectations come from the design and the rows read back, never from the
// completion's helpers, so a weakened protection fails here.
const serverUrl = process.env.DATABASE_URL
const design = readFileSync(new URL('../../../docs/scim.md', import.meta.url), 'utf8')
const words = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')
const says = (sentence: string) => new RegExp(words(sentence)).test(design)
// Better Auth's trusted origin; requests go to the socket and name this origin.
const origin = 'http://localhost:4389'
const secret = 'synthetic-scim-claim-completion-cookie-signing-secret'
const open: SignupPolicy = { mode: 'open', allowedDomains: [] }
const roomy = {
  secret,
  invitationInviterMaxPerHour: 1000,
  invitationInviterMaxPerDay: 1000,
  invitationTeamMaxPerHour: 1000,
  invitationTeamMaxPerDay: 1000,
}
// The acceptance's existing uniform refusal.
const denied = { code: 'TEAM_MANAGEMENT_ACCESS_DENIED', message: 'team_management_access_denied' }
type Json = Record<string, unknown>
type Factory = typeof createAuth

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved = replacements[specifier]
      if (!resolved) {
        if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
        else {
          try {
            resolved = import.meta.resolve(specifier)
          } catch {
            resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
          }
        }
      }
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}
function mutated(location: URL, mutations: [string, string][]) {
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of mutations) {
    expect(source.split(from).length - 1, from).toBe(1)
    source = source.replace(from, to)
  }
  return source
}
const completionLocation = new URL('../../../packages/auth/src/scim-claims.ts', import.meta.url)
/** A copy of the completion, passed to the real createAuth as the test dependency. */
async function completionCopy(...mutations: [string, string][]): Promise<ScimClaimCompletion> {
  const copy = await import(moduleUrl(mutated(completionLocation, mutations), completionLocation))
  return copy.scimClaimCompletion
}
/** createAuth whose invitation acceptance policy is a copy. */
async function authCopy(...mutations: [string, string][]): Promise<Factory> {
  const policy = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
  const index = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const copy = await import(
    moduleUrl(readFileSync(index, 'utf8'), index, {
      './team-role-policy.ts': moduleUrl(mutated(policy, mutations), policy),
    })
  )
  return copy.createAuth
}
/** A copy of the server assembly. */
async function serverCopy(...mutations: [string, string][]): Promise<typeof import('./server.ts')> {
  const location = new URL('./server.ts', import.meta.url)
  const javascript = stripTypeScriptTypes(mutated(location, mutations)).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!serverUrl)('SCIM claim completion through invitation acceptance', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: pg.Pool
  const servers: ReturnType<typeof serve>[] = []
  const enqueued: { invitationId: string; generation: number }[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'scim_claims' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, open)
    // Injected failure after the completion: the acceptance's session switch, for
    // refuse-session-* accounts only.
    await sql`CREATE FUNCTION test_refuse_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."activeOrganizationId" IS DISTINCT FROM OLD."activeOrganizationId" AND EXISTS (
          SELECT 1 FROM auth."user" WHERE id = NEW."userId" AND email LIKE 'refuse-session-%') THEN
          RAISE EXCEPTION 'injected session failure';
        END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_session BEFORE UPDATE ON auth.session
      FOR EACH ROW EXECUTE FUNCTION test_refuse_session()`.execute(db)
  })
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
    )
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  const unique = () => randomBytes(6).toString('hex')
  async function account(email: string, emailVerified = true) {
    return (
      await db
        .insertInto('auth.user')
        // Better Auth stores addresses lower-cased.
        .values({ name: `Person ${unique()}`, email: email.toLowerCase(), emailVerified })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }
  /** An account as sign-up leaves it: a verified address and a personal organization. */
  async function person(email: string, emailVerified = true) {
    const id = await account(email, emailVerified)
    await ensurePersonalOrganization(db, id)
    return id
  }
  /** A browser session of that account, as Better Auth signs its cookie. */
  async function signIn(userId: string, activeOrganizationId: string | null = null) {
    const token = randomBytes(24).toString('base64url')
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        activeOrganizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      sessionId: id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  async function token(organizationId: string) {
    const value = `scim_${randomBytes(32).toString('base64url')}`
    await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(value).digest('base64url'),
      })
      .execute()
    return value
  }
  /** A team whose earliest owner invites, with an administrator and a member. */
  async function team() {
    const id = (
      await db
        .insertInto('auth.organization')
        .values({ name: `Team ${unique()}`, slug: `team-${unique()}`, createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    const memberEmail = `member-${unique()}@example.com`
    const people = {
      owner: await person(`owner-${unique()}@example.com`),
      admin: await person(`admin-${unique()}@example.com`),
      member: await person(memberEmail),
    }
    for (const [user, role, minutes] of [
      [people.owner, 'owner', 0],
      [people.admin, 'admin', 10],
      [people.member, 'member', 20],
    ] as const)
      await db
        .insertInto('auth.member')
        .values({
          organizationId: id,
          userId: user,
          role,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutes)),
        })
        .execute()
    return { id, people, memberEmail, secret: await token(id) }
  }
  type Team = Awaited<ReturnType<typeof team>>

  const creationDeps: ScimUserCreationDeps = {
    get db() {
      return db
    },
    signup: open,
    reserve: (trx, input, now) => reserveInvitationEmailBudget(trx, input, roomy, now),
    enqueue: async (payload) => {
      enqueued.push(payload)
    },
  }
  // The resource test flag: discovery, reads and creation injected in code.
  const flagged: ScimResourceHandler = (request) =>
    scimDiscovery(request) ?? scimUserCreation(creationDeps)(request) ?? scimUsers(db)(request)

  async function listen(fetch: (request: Request) => Response | Promise<Response>) {
    const port = await new Promise<number>((resolve) => {
      servers.push(serve({ fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port)))
    })
    return `http://127.0.0.1:${port}`
  }
  type Served = { url: string; auth: ReturnType<Factory> }
  /**
   * Real Better Auth on the shared auth pool, with the given completion as the only test
   * dependency (none means production's wiring), and the flagged SCIM resources.
   */
  async function instance(
    completion: ScimClaimCompletion | undefined = scimClaimCompletion,
    factory: Factory = createAuth,
  ): Promise<Served> {
    const auth = factory({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup: open,
      mailer: { send: async () => {} },
      ...(completion ? { scimClaims: completion } : {}),
    })
    const app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
      scim: { db, enabled: true, resources: flagged },
    })
    return { url: await listen(app.fetch), auth }
  }

  async function provision(served: { url: string }, organization: Team, address: string) {
    const response = await fetch(`${served.url}/scim/v2/${organization.id}/Users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${organization.secret}`,
        'content-type': 'application/scim+json',
      },
      body: JSON.stringify({
        schemas: [SCIM_URN.user],
        userName: `user-${unique()}`,
        displayName: 'Provisioned Person',
        name: { givenName: 'Provisioned', familyName: 'Person' },
        emails: [{ value: address, type: 'work', primary: true }],
      }),
    })
    const text = await response.text()
    expect(response.status, text).toBe(201)
    const id = (JSON.parse(text) as Json).id as string
    const claim = await db
      .selectFrom('scim_user_claims')
      .selectAll()
      .where('scim_user_id', '=', id)
      .executeTakeFirstOrThrow()
    return { id, claim, text, location: response.headers.get('location') }
  }
  async function representation(served: { url: string }, organization: Team, id: string) {
    const response = await fetch(`${served.url}/scim/v2/${organization.id}/Users/${id}`, {
      headers: { authorization: `Bearer ${organization.secret}` },
    })
    return response.text()
  }
  async function accept(served: { url: string }, cookie: string, invitationId: string) {
    const response = await fetch(`${served.url}/api/auth/organization/accept-invitation`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId }),
    })
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body: body as Json }
  }
  /** An invitation sent from the app by an owner or administrator. */
  async function appInvitation(organization: Team, userId: string, email: string, extra = {}) {
    const { sessionId } = await signIn(userId, organization.id)
    return manageInvitation(
      db,
      { userId, sessionId, activeOrganizationId: organization.id },
      { organizationId: organization.id, email, ...extra },
      {
        reserve: (trx, input, now) => reserveInvitationEmailBudget(trx, input, roomy, now),
        enqueue: async (payload) => {
          enqueued.push(payload)
        },
      },
    )
  }

  // Everything an acceptance may write in one organization.
  async function snapshot(organizationId: string) {
    const [entries, claims, members, invitations, events] = await Promise.all([
      db
        .selectFrom('scim_users')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('scim_user_claims')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('auth.member')
        .select(['id', 'userId', 'role'])
        .where('organizationId', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('auth.invitation')
        .select(['id', 'email', 'status', 'expiresAt', 'inviterId'])
        .where('organizationId', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_events')
        .select([
          'action',
          'actor_type',
          'actor_id',
          'credential_type',
          'credential_id',
          'target_type',
          'target_id',
          'details',
        ])
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
    ])
    return { entries, claims, members, invitations, events }
  }
  // Accounts, sign-in methods, verifications and personal organizations, byte for byte.
  async function identities() {
    const rows: string[][] = []
    for (const table of [
      'auth."user"',
      'auth.account',
      'auth.verification',
      'personal_organizations',
    ])
      rows.push(
        (
          await sql<{
            row: string
          }>`SELECT to_jsonb(t)::text AS row FROM ${sql.raw(table)} t ORDER BY 1`.execute(db)
        ).rows.map(({ row }) => row),
      )
    return rows
  }
  const claimed = <T extends { action: string }>(events: T[]) =>
    events.filter((event) => event.action === 'scim_user.claimed')
  /** Waits until another backend waits on a lock that pid holds. */
  async function blockedBy(pid: number) {
    await vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        )
        expect(rows[0]?.n).toBeGreaterThan(0)
      },
      { timeout: 10_000, interval: 20 },
    )
  }

  /** Mailbox and own-account proof: only the signed-in, verified addressee completes. */
  async function verifyCompletion(served: Served) {
    const organization = await team()
    const address = `Pat.${unique()}@Example.com`
    const { id, claim, text } = await provision(served, organization, address)
    expect(claim).toMatchObject({ completed_at: null, invalidated_at: null })
    const invitationId = claim.invitation_id as string
    expect(invitationId).toEqual(expect.any(String))
    const pat = await person(address.toLowerCase())
    const before = await snapshot(organization.id)
    // Another verified account cannot accept, whoever signs in.
    const other = await signIn(await person(`other-${unique()}@example.com`))
    expect((await accept(served, other.cookie, invitationId)).status).toBe(403)
    expect(await snapshot(organization.id), 'a refused acceptance writes nothing').toEqual(before)
    const accounts = await identities()
    const { cookie, sessionId } = await signIn(pat)
    const answer = await accept(served, cookie, invitationId)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const after = await snapshot(organization.id)
    const member = after.members.find((row) => row.userId === pat)
    expect(member?.role).toBe('member')
    expect(after.members).toHaveLength(before.members.length + 1)
    expect(answer.body.member).toMatchObject({ id: member?.id, userId: pat, role: 'member' })
    // The entry is linked to the account and its new membership; nothing else in it changes.
    const entry = after.entries.find((row) => row.id === id)
    expect(entry).toMatchObject({ linked_user_id: pat, linked_member_id: member?.id })
    expect({ ...entry, linked_user_id: null, linked_member_id: null }).toEqual(
      before.entries.find((row) => row.id === id),
    )
    const completed = after.claims.find((row) => row.id === claim.id)
    expect(completed?.completed_at).toBeInstanceOf(Date)
    expect({ ...completed, completed_at: null }).toEqual(claim)
    expect(after.invitations.find((row) => row.id === invitationId)?.status).toBe('accepted')
    // One acceptance event and one claim event, both the person's session, no details.
    const by = { actor_type: 'user', actor_id: pat, credential_type: 'session' }
    expect(after.events.slice(before.events.length)).toEqual([
      {
        action: 'membership.accepted',
        ...by,
        credential_id: sessionId,
        target_type: 'invitation',
        target_id: invitationId,
        details: {},
      },
      {
        action: 'scim_user.claimed',
        ...by,
        credential_id: sessionId,
        target_type: 'scim_user',
        target_id: id,
        details: {},
      },
    ])
    // No profile, address, verification or sign-in method of any account changed.
    expect(await identities()).toEqual(accounts)
    // The SCIM representation is unchanged: linking is not exposed to the provider.
    expect(await representation(served, organization, id)).toBe(text)
  }

  /** An existing same-email personal account proves itself in its own session. */
  async function verifySameEmail(served: Served) {
    const organization = await team()
    const held = `Sam.${unique()}@Example.com`
    const fresh = `Kim.${unique()}@Example.com`
    const sam = await person(held.toLowerCase())
    const personal = await db
      .selectFrom('personal_organizations')
      .selectAll()
      .where('user_id', '=', sam)
      .executeTakeFirstOrThrow()
    // The create answers alike whether or not the address has an account.
    const withAccount = await provision(served, organization, held)
    const without = await provision(served, organization, fresh)
    const neutral = (created: Awaited<ReturnType<typeof provision>>, address: string) =>
      created.text
        .replaceAll(created.id, 'ID')
        .replaceAll(address, 'ADDRESS')
        .replace(/"userName":"[^"]+"/, '"userName":"NAME"')
        .replace(/"(created|lastModified)":"[^"]+"/g, '"$1":"TIME"')
    expect(neutral(withAccount, held)).toBe(neutral(without, fresh))
    const invitations = (await snapshot(organization.id)).invitations
    const shape = (invitationId: string | null) => {
      const row = invitations.find((invitation) => invitation.id === invitationId)
      return { status: row?.status, inviterId: row?.inviterId }
    }
    expect(shape(withAccount.claim.invitation_id)).toEqual(shape(without.claim.invitation_id))
    expect(shape(withAccount.claim.invitation_id)).toEqual({
      status: 'pending',
      inviterId: organization.people.owner,
    })
    // An unverified account with its address has not proven the mailbox.
    const unproven = `Lee.${unique()}@example.com`
    const lee = await account(unproven, false)
    const leeClaim = await provision(served, organization, unproven)
    const before = await snapshot(organization.id)
    const leeAnswer = await accept(
      served,
      (await signIn(lee)).cookie,
      leeClaim.claim.invitation_id as string,
    )
    expect(leeAnswer.status).toBe(403)
    expect(await snapshot(organization.id)).toEqual(before)
    // Sam completes in Sam's own session: the existing account is linked, no other.
    const accounts = await identities()
    const answer = await accept(
      served,
      (await signIn(sam)).cookie,
      withAccount.claim.invitation_id as string,
    )
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const after = await snapshot(organization.id)
    expect(after.entries.find((row) => row.id === withAccount.id)?.linked_user_id).toBe(sam)
    expect(claimed(after.events).map((event) => event.target_id)).toEqual([withAccount.id])
    expect(await identities()).toEqual(accounts)
    expect(
      await db
        .selectFrom('auth.user')
        .select('id')
        .where('email', '=', held.toLowerCase())
        .execute(),
    ).toEqual([{ id: sam }])
    expect(
      await db
        .selectFrom('personal_organizations')
        .selectAll()
        .where('user_id', '=', sam)
        .executeTakeFirstOrThrow(),
    ).toEqual(personal)
    // The other entries stay unlinked.
    for (const entry of after.entries.filter((row) => row.id !== withAccount.id))
      expect(entry.linked_user_id).toBeNull()
  }

  /** An expired invitation admits nobody and completes nothing, as any expired invitation. */
  async function verifyExpiredInvitation(served: Served) {
    const organization = await team()
    const address = `Expired.${unique()}@example.com`
    const { claim } = await provision(served, organization, address)
    const invitationId = claim.invitation_id as string
    const ordinaryAddress = `ordinary-${unique()}@example.com`
    const ordinary = await appInvitation(organization, organization.people.admin, ordinaryAddress)
    // Both are 48 hours old.
    for (const id of [invitationId, ordinary.id])
      await sql`UPDATE auth.invitation SET "createdAt" = now() - interval '49 hours',
        "expiresAt" = now() - interval '1 hour' WHERE id = ${id}`.execute(db)
    await sql`UPDATE scim_user_claims SET created_at = now() - interval '49 hours',
      expires_at = now() - interval '1 hour' WHERE id = ${claim.id}`.execute(db)
    const pat = await person(address)
    const before = await snapshot(organization.id)
    const answer = await accept(served, (await signIn(pat)).cookie, invitationId)
    expect(answer.status).not.toBe(200)
    expect(await snapshot(organization.id), 'nothing is admitted or completed').toEqual(before)
    // The same answer as an ordinary expired invitation.
    const control = await accept(
      served,
      (await signIn(await person(ordinaryAddress))).cookie,
      ordinary.id,
    )
    expect(answer).toEqual(control)
    // An invitation and claim that expire while the acceptance waits for the organization
    // lock: the locked recheck refuses, and both expiries are judged at one instant.
    const late = `Late.${unique()}@example.com`
    const lateClaim = (await provision(served, organization, late)).claim
    const latePerson = await person(late)
    const { cookie } = await signIn(latePerson)
    const lateBefore = await snapshot(organization.id)
    const holder = await owned.pool.connect()
    let lateAnswer: ReturnType<typeof accept> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
        organization.id,
      ])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number
      const expiry = (
        await owned.pool.query<{ at: Date }>(
          `UPDATE auth.invitation SET "expiresAt" = clock_timestamp() + interval '2 seconds'
            WHERE id = $1 RETURNING "expiresAt" AS at`,
          [lateClaim.invitation_id],
        )
      ).rows[0]?.at as Date
      await owned.pool.query('UPDATE scim_user_claims SET expires_at = $2 WHERE id = $1', [
        lateClaim.id,
        expiry,
      ])
      lateAnswer = accept(served, cookie, lateClaim.invitation_id as string)
      await blockedBy(pid)
      await vi.waitFor(
        async () => {
          const { rows } = await holder.query<{ lapsed: boolean }>(
            'SELECT clock_timestamp() > $1 AS lapsed',
            [expiry],
          )
          expect(rows[0]?.lapsed).toBe(true)
        },
        { timeout: 10_000, interval: 50 },
      )
      await holder.query('COMMIT')
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
    expect(await lateAnswer).toEqual({ status: 403, body: denied })
    expect(await snapshot(organization.id)).toEqual({
      ...lateBefore,
      invitations: lateBefore.invitations.map((row) =>
        row.id === lateClaim.invitation_id ? { ...row, expiresAt: expect.any(Date) } : row,
      ),
      claims: lateBefore.claims.map((row) =>
        row.id === lateClaim.id ? { ...row, expires_at: expect.any(Date) } : row,
      ),
    })
  }

  /**
   * An expired claim whose invitation an administrator resent (extended) or replaced: the
   * invitation admits the person as an ordinary acceptance, and the claim is not completed.
   */
  async function verifyExpiredClaim(served: Served) {
    const organization = await team()
    const reserve = {
      reserve: (
        trx: Db,
        input: { userId: string; organizationId: string; email: string },
        now: Date,
      ) => reserveInvitationEmailBudget(trx, input, roomy, now),
    }
    const resend = async (invitationId: string, email: string) => {
      const { sessionId } = await signIn(organization.people.owner, organization.id)
      return manageInvitation(
        db,
        { userId: organization.people.owner, sessionId, activeOrganizationId: organization.id },
        {
          organizationId: organization.id,
          email,
          resend: true,
          invitationId,
          expectedGeneration: 1,
          requestId: randomUUID(),
        },
        reserve,
      )
    }
    const ageClaim = (id: string) =>
      sql`UPDATE scim_user_claims SET created_at = now() - interval '49 hours',
        expires_at = now() - interval '1 hour' WHERE id = ${id}`.execute(db)
    for (const variant of ['extended', 'replaced'] as const) {
      const address = `Resent.${unique()}@example.com`
      const { id, claim } = await provision(served, organization, address)
      const original = claim.invitation_id as string
      let accepted = original
      if (variant === 'extended') {
        // Past the resend cooldown; the resend gives the invitation 48 more hours.
        await sql`UPDATE invitation_deliveries SET generation_started_at = now() - interval '2 minutes',
          updated_at = now() - interval '2 minutes' WHERE invitation_id = ${original}`.execute(db)
        expect((await resend(original, address)).id).toBe(original)
        await ageClaim(claim.id)
      } else {
        // Both expired; the resend replaces the invitation.
        await sql`UPDATE auth.invitation SET "createdAt" = now() - interval '49 hours',
          "expiresAt" = now() - interval '1 hour' WHERE id = ${original}`.execute(db)
        await ageClaim(claim.id)
        accepted = (await resend(original, address)).id
        expect(accepted).not.toBe(original)
      }
      const pat = await person(address)
      const before = await snapshot(organization.id)
      const answer = await accept(served, (await signIn(pat)).cookie, accepted)
      expect(answer.status, `${variant}: ${JSON.stringify(answer.body)}`).toBe(200)
      const after = await snapshot(organization.id)
      expect(after.members.filter((row) => row.userId === pat)).toHaveLength(1)
      // The claim and its entry are untouched; only the acceptance is recorded.
      expect(
        after.claims.find((row) => row.id === claim.id),
        variant,
      ).toEqual(before.claims.find((row) => row.id === claim.id))
      expect(after.entries.find((row) => row.id === id)).toEqual(
        before.entries.find((row) => row.id === id),
      )
      expect(after.events.slice(before.events.length).map((event) => event.action)).toEqual([
        'membership.accepted',
      ])
    }
  }

  /**
   * An account that another live entry of the connection still links (its membership was
   * removed, the link kept) is admitted by a new entry's invitation without a second link.
   */
  async function verifyLinkedElsewhere(served: Served) {
    const organization = await team()
    const mailbox = `returning-${unique()}@example.com`
    const first = await provision(served, organization, mailbox)
    const pat = await person(mailbox)
    expect(
      (await accept(served, (await signIn(pat)).cookie, first.claim.invitation_id as string))
        .status,
    ).toBe(200)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', organization.id)
      .where('userId', '=', pat)
      .execute()
    const second = await provision(served, organization, mailbox)
    expect(second.claim.invitation_id).toEqual(expect.any(String))
    const before = await snapshot(organization.id)
    const answer = await accept(
      served,
      (await signIn(pat)).cookie,
      second.claim.invitation_id as string,
    )
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const after = await snapshot(organization.id)
    expect(after.members.filter((row) => row.userId === pat)).toHaveLength(1)
    expect(after.entries.find((row) => row.id === first.id)?.linked_user_id).toBe(pat)
    expect(after.entries.find((row) => row.id === second.id)).toEqual(
      before.entries.find((row) => row.id === second.id),
    )
    expect(after.claims.find((row) => row.id === second.claim.id)).toEqual(
      before.claims.find((row) => row.id === second.claim.id),
    )
    expect(claimed(after.events).map((event) => event.target_id)).toEqual([first.id])
  }

  /** A SCIM-issued invitation never clears a live blocker of either authority. */
  async function verifyTombstones(served: Served) {
    type Block = {
      user_id?: string | null
      identity_email?: string | null
      source: 'local' | 'scim'
      kind: 'suspension' | 'removal'
      connection_id?: string | null
      scim_user_id?: string | null
      cleared_at?: Date | null
      organization_id?: string
    }
    type Context = {
      organization: Team
      pat: string
      mailbox: string
      entry: string
      claim: string
      connection: string
      other: string
    }
    // A blocker also refuses where the claim itself would not be completed: an expired claim
    // whose invitation an administrator resent, or an account another entry already links.
    const expiredClaim = async ({ claim }: Context) => {
      await sql`UPDATE scim_user_claims SET created_at = now() - interval '49 hours',
        expires_at = now() - interval '1 hour' WHERE id = ${claim}`.execute(db)
    }
    const linkedElsewhere = async ({ organization, pat }: Context) => {
      const response = await fetch(`${served.url}/scim/v2/${organization.id}/Users`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${organization.secret}`,
          'content-type': 'application/scim+json',
        },
        body: JSON.stringify({ schemas: [SCIM_URN.user], userName: `former-${unique()}` }),
      })
      const { id } = (await response.json()) as { id: string }
      await db.updateTable('scim_users').set({ linked_user_id: pat }).where('id', '=', id).execute()
    }
    const cases: [string, boolean, (ctx: Context) => Block, ((ctx: Context) => Promise<void>)?][] =
      [
        [
          'local removal of the account',
          true,
          ({ pat }) => ({ user_id: pat, source: 'local', kind: 'removal' }),
        ],
        [
          'local suspension of the mailbox',
          true,
          ({ mailbox }) => ({ identity_email: mailbox, source: 'local', kind: 'suspension' }),
        ],
        [
          'SCIM suspension of the account',
          true,
          ({ pat, connection, entry }) => ({
            user_id: pat,
            source: 'scim',
            kind: 'suspension',
            connection_id: connection,
            scim_user_id: entry,
          }),
        ],
        [
          'SCIM removal of the mailbox',
          true,
          ({ mailbox, connection, entry }) => ({
            identity_email: mailbox,
            source: 'scim',
            kind: 'removal',
            connection_id: connection,
            scim_user_id: entry,
          }),
        ],
        [
          'local removal of the account, with an expired claim',
          true,
          ({ pat }) => ({ user_id: pat, source: 'local', kind: 'removal' }),
          expiredClaim,
        ],
        [
          'SCIM suspension of the mailbox, for an account another entry links',
          true,
          ({ mailbox, connection, entry }) => ({
            identity_email: mailbox,
            source: 'scim',
            kind: 'suspension',
            connection_id: connection,
            scim_user_id: entry,
          }),
          linkedElsewhere,
        ],
        // Controls: a cleared blocker and another team's blocker do not refuse.
        [
          'a cleared local removal',
          false,
          ({ pat }) => ({ user_id: pat, source: 'local', kind: 'removal', cleared_at: new Date() }),
        ],
        [
          "another team's local removal",
          false,
          ({ pat, other }) => ({
            user_id: pat,
            source: 'local',
            kind: 'removal',
            organization_id: other,
          }),
        ],
      ]
    const elsewhere = await team()
    for (const [name, refused, block, setup] of cases) {
      const organization = await team()
      const mailbox = `blocked-${unique()}@example.com`
      const { id, claim } = await provision(served, organization, mailbox)
      const pat = await person(mailbox)
      const context: Context = {
        organization,
        pat,
        mailbox,
        entry: id,
        claim: claim.id,
        connection: claim.connection_id,
        other: elsewhere.id,
      }
      await setup?.(context)
      await db
        .insertInto('scim_membership_blocks')
        .values({ organization_id: organization.id, ...block(context) })
        .execute()
      const before = await snapshot(organization.id)
      const answer = await accept(served, (await signIn(pat)).cookie, claim.invitation_id as string)
      if (refused) {
        expect(answer, name).toEqual({ status: 403, body: denied })
        expect(await snapshot(organization.id), name).toEqual(before)
      } else {
        expect(answer.status, name).toBe(200)
        expect(claimed((await snapshot(organization.id)).events), name).toHaveLength(1)
      }
    }
  }

  /** Repeated and concurrent acceptances complete once. */
  async function verifyReplay(served: Served) {
    const once = async (organization: Team, id: string, pat: string) => {
      const after = await snapshot(organization.id)
      expect(claimed(after.events), 'one claim event').toHaveLength(1)
      expect(
        after.entries.filter((row) => row.linked_user_id === pat).map((row) => row.id),
      ).toEqual([id])
      expect(after.claims.filter((row) => row.completed_at !== null)).toHaveLength(1)
      expect(
        after.members.filter((row) => row.userId === pat),
        'one membership',
      ).toHaveLength(1)
      expect(after.events.filter((event) => event.action === 'membership.accepted')).toHaveLength(1)
    }
    // One after another, from the same and from a second session.
    {
      const organization = await team()
      const mailbox = `replay-${unique()}@example.com`
      const { id, claim } = await provision(served, organization, mailbox)
      const pat = await person(mailbox)
      const [first, second] = [await signIn(pat), await signIn(pat)]
      const invitation = claim.invitation_id as string
      expect((await accept(served, first.cookie, invitation)).status).toBe(200)
      expect((await accept(served, first.cookie, invitation)).status).not.toBe(200)
      expect((await accept(served, second.cookie, invitation)).status).not.toBe(200)
      await once(organization, id, pat)
    }
    // At once, over two HTTP connections.
    {
      const organization = await team()
      const mailbox = `replay-${unique()}@example.com`
      const { id, claim } = await provision(served, organization, mailbox)
      const pat = await person(mailbox)
      const [first, second] = [await signIn(pat), await signIn(pat)]
      const answers = await Promise.all(
        [first, second].map((session) =>
          accept(served, session.cookie, claim.invitation_id as string),
        ),
      )
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1)
      await once(organization, id, pat)
    }
    // At once, through the trusted server API, which has no HTTP recipient fence.
    {
      const organization = await team()
      const mailbox = `replay-${unique()}@example.com`
      const { id, claim } = await provision(served, organization, mailbox)
      const pat = await person(mailbox)
      const [first, second] = [await signIn(pat), await signIn(pat)]
      const outcomes = await Promise.allSettled(
        [first, second].map((session) =>
          served.auth.api.acceptInvitation({
            body: { invitationId: claim.invitation_id as string },
            headers: new Headers({ cookie: session.cookie }),
          }),
        ),
      )
      await once(organization, id, pat)
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    }
  }

  /** Claims without an invitation are never completed, whichever invitation is accepted. */
  async function verifyUntouched(served: Served) {
    const organization = await team()
    // Another administrator's invitation holds the address.
    const adminAddress = `admin-held-${unique()}@example.com`
    const adminInvitation = await appInvitation(
      organization,
      organization.people.admin,
      adminAddress,
    )
    const held = await provision(served, organization, adminAddress)
    expect(held.claim.invitation_id).toBeNull()
    // Another entry's claim holds the owner's invitation.
    const sharedAddress = `shared-${unique()}@example.com`
    const first = await provision(served, organization, sharedAddress)
    const second = await provision(served, organization, sharedAddress)
    expect(second.claim.invitation_id).toBeNull()
    // An existing member's address.
    const memberClaim = await provision(served, organization, organization.memberEmail)
    expect(memberClaim.claim.invitation_id).toBeNull()
    const nullClaims = [held, second, memberClaim]
    const before = await snapshot(organization.id)
    const heldPerson = await person(adminAddress)
    expect(
      (await accept(served, (await signIn(heldPerson)).cookie, adminInvitation.id)).status,
    ).toBe(200)
    const sharedPerson = await person(sharedAddress)
    expect(
      (
        await accept(
          served,
          (
            await signIn(sharedPerson)
          ).cookie,
          first.claim.invitation_id as string,
        )
      ).status,
    ).toBe(200)
    const after = await snapshot(organization.id)
    expect(after.members.map((row) => row.userId)).toEqual(
      expect.arrayContaining([heldPerson, sharedPerson]),
    )
    for (const { id, claim } of nullClaims) {
      expect(after.claims.find((row) => row.id === claim.id)).toEqual(
        before.claims.find((row) => row.id === claim.id),
      )
      expect(after.entries.find((row) => row.id === id)).toEqual(
        before.entries.find((row) => row.id === id),
      )
    }
    // Only the entry whose claim the accepted invitation carries is completed.
    expect(claimed(after.events).map((event) => event.target_id)).toEqual([first.id])
  }

  /** A failure after the completion rolls the claim, link, membership and events back. */
  async function verifyAtomicity(served: Served) {
    const organization = await team()
    const mailbox = `refuse-session-${unique()}@example.com`
    const { claim } = await provision(served, organization, mailbox)
    const pat = await person(mailbox)
    const before = await snapshot(organization.id)
    const answer = await accept(served, (await signIn(pat)).cookie, claim.invitation_id as string)
    expect(answer.status).toBe(500)
    expect(await snapshot(organization.id), 'nothing survives the failed acceptance').toEqual(
      before,
    )
  }

  /**
   * The addressee is rechecked after the acceptance's locks: an account whose address changes
   * while it waits is no longer the invitation's recipient, though Better Auth's own check saw
   * the old address before the wait.
   */
  async function verifyAddressee(served: Served) {
    const organization = await team()
    const mailbox = `moving-${unique()}@example.com`
    const { claim } = await provision(served, organization, mailbox)
    const pat = await person(mailbox)
    const { cookie } = await signIn(pat)
    const before = await snapshot(organization.id)
    const contender = await owned.pool.connect()
    let answer: ReturnType<typeof accept> | undefined
    try {
      await contender.query('BEGIN')
      await contender.query('SELECT 1 FROM auth."user" WHERE id = $1 FOR UPDATE', [pat])
      const pid = (await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number
      answer = accept(served, cookie, claim.invitation_id as string)
      await blockedBy(pid)
      await contender.query('UPDATE auth."user" SET email = $2 WHERE id = $1', [
        pat,
        `moved-${unique()}@example.com`,
      ])
      await contender.query('COMMIT')
    } finally {
      await contender.query('ROLLBACK')
      contender.release()
    }
    expect(await answer).toEqual({ status: 403, body: denied })
    expect(await snapshot(organization.id)).toEqual(before)
  }

  /**
   * Lock order: a SCIM writer that takes the organization lock first and then the entry and
   * the claim, while the acceptance runs as one step, must neither deadlock nor fail.
   */
  async function verifyLockOrder(served: Served) {
    const organization = await team()
    const mailbox = `ordered-${unique()}@example.com`
    const { id, claim } = await provision(served, organization, mailbox)
    const pat = await person(mailbox)
    const { cookie } = await signIn(pat)
    const contender = await owned.pool.connect()
    let answer: ReturnType<typeof accept> | undefined
    let failure: unknown
    try {
      await contender.query('BEGIN')
      await contender.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
        organization.id,
      ])
      const pid = (await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number
      answer = accept(served, cookie, claim.invitation_id as string)
      await blockedBy(pid)
      try {
        await contender.query('SELECT id FROM scim_users WHERE id = $1 FOR UPDATE', [id])
        await contender.query('SELECT id FROM scim_user_claims WHERE id = $1 FOR UPDATE', [
          claim.id,
        ])
        await contender.query(
          "UPDATE scim_users SET display_name = 'Renamed while accepting' WHERE id = $1",
          [id],
        )
        await contender.query('COMMIT')
      } catch (error) {
        failure = error
      }
    } finally {
      await contender.query('ROLLBACK')
      contender.release()
    }
    expect(failure, 'the organization-first writer completes').toBeUndefined()
    expect((await answer)?.status).toBe(200)
    const after = await snapshot(organization.id)
    expect(after.entries.find((row) => row.id === id)).toMatchObject({
      display_name: 'Renamed while accepting',
      linked_user_id: pat,
    })
    expect(claimed(after.events)).toHaveLength(1)
  }

  const verifiers = {
    completion: verifyCompletion,
    sameEmail: verifySameEmail,
    expiredInvitation: verifyExpiredInvitation,
    expiredClaim: verifyExpiredClaim,
    tombstones: verifyTombstones,
    linkedElsewhere: verifyLinkedElsewhere,
    replay: verifyReplay,
    untouched: verifyUntouched,
    atomicity: verifyAtomicity,
    addressee: verifyAddressee,
    lockOrder: verifyLockOrder,
  }

  it('takes its completion rules from docs/scim.md', () => {
    for (const sentence of [
      'Claim completion rides on the existing acceptance of the invitation the create bound to the claim',
      'An existing same-email personal account accepts the same way, in its own session, and nothing else links it',
      'After the organization and invitation locks, acceptance locks the claim and then its entry.',
      'A SCIM-issued invitation never clears an admission blocker',
      'the entry is linked to the account and that membership, the claim is marked completed and `scim_user.claimed` is recorded; all of it commits or rolls back together.',
      'A second or concurrent acceptance of the invitation is refused as before, so a claim completes once.',
      'An expired invitation admits nobody and completes nothing.',
      'an expired claim is then never completed, while its still-valid invitation admits the person as an ordinary acceptance',
      'Claims without an invitation stay unlinked until the SSO linking completion step, and expire after 48 hours without renewal',
      "No address is marked verified, and neither the account's profile, address or sign-in methods nor the entry's provisioned profile or timestamps change.",
      '| Claim completion through invitation acceptance | User creation and claim intent | Existing invitation acceptance; no new operation/tool/command | Resource test flag only |',
      '| Claim completion through SSO linking | Claim completion through invitation acceptance; SSO design PR #247 and accepted linking implementation | SSO linking completion; no new operation/tool/command | Resource test flag only |',
    ])
      expect(says(sentence), sentence).toBe(true)
  })

  it("completes a SCIM-issued invitation's claim on acceptance by its addressee", async () =>
    verifyCompletion(await instance()))
  it('lets an existing same-email account prove itself, without disclosing it', async () =>
    verifySameEmail(await instance()))
  it(
    'admits nobody and completes nothing with an expired invitation',
    async () => verifyExpiredInvitation(await instance()),
    30_000,
  )
  it('admits through a resent invitation without completing an expired claim', async () =>
    verifyExpiredClaim(await instance()))
  it('refuses admission while a local or SCIM blocker exists', async () =>
    verifyTombstones(await instance()))
  it('admits an account another entry links without a second link', async () =>
    verifyLinkedElsewhere(await instance()))
  it('completes once under repeated and concurrent acceptance', async () =>
    verifyReplay(await instance()))
  it('never completes a claim without an invitation', async () => verifyUntouched(await instance()))
  it('commits the link, completion, membership and events together', async () =>
    verifyAtomicity(await instance()))
  it(
    'rechecks the addressee after waiting for the account lock',
    async () => verifyAddressee(await instance()),
    30_000,
  )
  it(
    'takes the claim and entry locks after the organization lock',
    async () => verifyLockOrder(await instance()),
    30_000,
  )

  it('detects each weakened protection in a source copy', async () => {
    // Unmutated copies pass every verifier.
    const control = await instance(await completionCopy(), await authCopy())
    for (const verify of Object.values(verifiers)) await verify(control)
    const apart = '__scimClaimAuditApart'
    ;(globalThis as Record<string, unknown>)[apart] = db
    const completionMutants: [keyof typeof verifiers, [string, string][]][] = [
      // An expired claim completed.
      ['expiredClaim', [['      !claim.current ||\n', '']]],
      // A live blocker ignored.
      [
        'tombstones',
        [['    if (blocked) return { refused: true }', '    if (false) return { refused: true }']],
      ],
      // The blocker consulted only for a claim that would be completed.
      [
        'tombstones',
        [
          ['    if (blocked) return { refused: true }\n', ''],
          [
            '    if (linked) return admitted\n',
            '    if (linked) return admitted\n    if (blocked) return { refused: true }\n',
          ],
        ],
      ],
      // An account another live entry links linked a second time.
      ['linkedElsewhere', [['    if (linked) return admitted\n', '']]],
      // A claim without an invitation completed by its mailbox.
      [
        'untouched',
        [
          [
            "      .where('invitation_id', '=', proof.invitationId)",
            "      .where((eb) => eb.or([eb('invitation_id', '=', proof.invitationId), eb.and([eb('invitation_id', 'is', null), eb('work_email', '=', proof.mailbox)])]))",
          ],
        ],
      ],
      // The claim event written in a transaction of its own.
      [
        'atomicity',
        [
          [
            '        await writeAuditEvent(trx, {',
            `        await (globalThis as any).${apart}.transaction().execute((apart: any) => writeAuditEvent(apart, {`,
          ],
          [
            '          targetId: entry.id,\n        })\n',
            '          targetId: entry.id,\n        }))\n',
          ],
        ],
      ],
      // The account's profile, or its verified address, overwritten from the entry.
      [
        'completion',
        [
          [
            '        await writeAuditEvent(trx, {',
            "        await trx.updateTable('auth.user').set({ name: 'Provisioned Person' }).where('id', '=', proof.userId).execute()\n        await writeAuditEvent(trx, {",
          ],
        ],
      ],
      [
        'completion',
        [
          [
            '        await writeAuditEvent(trx, {',
            "        await trx.updateTable('auth.user').set((eb) => ({ email: eb.selectFrom('scim_users').select('work_email').where('id', '=', entry.id), emailVerified: true })).where('id', '=', proof.userId).execute()\n        await writeAuditEvent(trx, {",
          ],
        ],
      ],
    ]
    const policyMutants: [keyof typeof verifiers, [string, string][]][] = [
      // The addressee no longer rechecked after the locks.
      [
        'addressee',
        [['      stored.email.trim().toLowerCase() !== user.email.trim().toLowerCase() ||\n', '']],
      ],
      // The claim and entry locked before the organization.
      [
        'lockOrder',
        [
          [
            '    if (!target) throw teamRoleDenied()\n    const organization = await trx',
            '    if (!target) throw teamRoleDenied()\n    await scimClaims?.invitation(trx, { organizationId: target.organizationId, invitationId, userId: actor.user.id, mailbox: user.email.trim().toLowerCase(), audit: auditActor(actor) })\n    const organization = await trx',
          ],
        ],
      ],
    ]
    // Replay passes several guards in turn: Better Auth's early status check and the HTTP
    // recipient fence, then the policy's status and membership rechecks under the locks and
    // its conditional status update, then the completion's own pending checks. Each alone is
    // shadowed by the next, so the replay mutant removes every guard after the early check.
    const replayMutant = {
      completion: [
        ['      claim.completed_at !== null ||\n', ''],
        ['      entry.linked_user_id !== null ||\n', ''],
        ["          .where('linked_user_id', 'is', null)\n", ''],
        ["          .where('completed_at', 'is', null)\n", ''],
      ] as [string, string][],
      policy: [
        ["||\n      stored.status !== 'pending'\n", '\n'],
        ['    if (member) throw recipientAlreadyMember()\n', ''],
        [
          "            .where('id', '=', stored.id)\n            .where('status', '=', 'pending')\n",
          "            .where('id', '=', stored.id)\n",
        ],
      ] as [string, string][],
    }
    const survivors: string[] = []
    const outcome = (run: Promise<void>) =>
      run.then(
        () => 'survived',
        (error: Error) =>
          error.name === 'AssertionError' ? 'killed' : `errored: ${error.message}`,
      )
    for (const [name, mutations] of completionMutants) {
      const result = await outcome(
        verifiers[name](await instance(await completionCopy(...mutations), await authCopy())),
      )
      if (result !== 'killed') survivors.push(`${name}: ${mutations[0]?.[1]} (${result})`)
    }
    for (const [name, mutations] of policyMutants) {
      const result = await outcome(
        verifiers[name](await instance(await completionCopy(), await authCopy(...mutations))),
      )
      if (result !== 'killed') survivors.push(`${name}: ${mutations[0]?.[1]} (${result})`)
    }
    const replay = await outcome(
      verifiers.replay(
        await instance(
          await completionCopy(...replayMutant.completion),
          await authCopy(...replayMutant.policy),
        ),
      ),
    )
    if (replay !== 'killed') survivors.push(`replay: every recheck removed (${replay})`)
    delete (globalThis as Record<string, unknown>)[apart]
    expect(survivors).toEqual([])
    // The atomicity mutant writes its event on a separate application connection inside the
    // acceptance transaction; that wait is what it breaks, and this test asserts it differently.
    takePoolOrderViolations()
  }, 600_000)

  // The production assembly, as startServer builds it: productionAuthOptions for Better Auth
  // and productionAppOptions for the app.
  const unreachable = async (): Promise<never> => {
    throw new Error('Invitation acceptance must not reach this collaborator')
  }
  async function productionAcceptance(
    server: Pick<typeof import('./server.ts'), 'productionAppOptions' | 'productionAuthOptions'>,
  ) {
    const config = loadConfig({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: secret,
      PUBLIC_URL: origin,
      SCIM_PROVISIONING_ENABLED: 'true',
    })
    const options = server.productionAuthOptions({
      config,
      pool: authPool,
      db,
      mailer: { send: unreachable },
      invitationDelivery: {
        db,
        queue: {
          enqueue: unreachable,
          retireExpiredInvitationEmailJobs: unreachable,
          hasLiveInvitationEmailJob: unreachable,
        },
      },
      invitationMailLimits: { secret },
      jobs: { enqueue: unreachable },
    })
    const auth = createAuth(options)
    const url = await listen(
      createApp(
        server.productionAppOptions({
          config,
          db,
          auth,
          resolveCaller: createCallerResolver({ auth, db }),
          resolveMcpOAuth: unreachable,
          checkDb: async () => {},
          waitlist: { verify: unreachable, remove: unreachable },
          invitationMailLimits: { secret },
          webhookSettings: { enabled: false },
          webhookQueue: { enqueue: unreachable },
          notify: unreachable,
          notifyAttendeeNoShow: unreachable,
          googleCalendar: undefined,
          microsoftCalendar: undefined,
          zoomConference: undefined,
          enqueueCalendarSync: unreachable,
          enqueueCalendarWritebackRecovery: unreachable,
        }),
      ).fetch,
    )
    // The claim comes from the flagged test harness; production has no SCIM resources.
    const harness = await instance(undefined)
    const organization = await team()
    const mailbox = `production-${unique()}@example.com`
    const { id, claim } = await provision(harness, organization, mailbox)
    const pat = await person(mailbox)
    const answer = await accept({ url }, (await signIn(pat)).cookie, claim.invitation_id as string)
    const after = await snapshot(organization.id)
    return {
      options,
      answer,
      claim: after.claims.find((row) => row.id === claim.id),
      entry: after.entries.find((row) => row.id === id),
      claimed: claimed(after.events).length,
      admitted: after.members.some((row) => row.userId === pat),
    }
  }

  it('is not wired in the production assembly', async () => {
    const production = await productionAcceptance({ productionAppOptions, productionAuthOptions })
    expect('scimClaims' in production.options).toBe(false)
    // The invitation admits as before, and the claim stays pending and unlinked.
    expect(production.answer.status).toBe(200)
    expect(production).toMatchObject({
      claim: { completed_at: null, invalidated_at: null },
      entry: { linked_user_id: null, linked_member_id: null },
      claimed: 0,
      admitted: true,
    })
    // An unmutated copy of the assembly answers the same; wired in production, the claim
    // would complete.
    const control = await productionAcceptance(await serverCopy())
    expect(control).toMatchObject({ claimed: 0, entry: { linked_user_id: null } })
    const wired = await productionAcceptance(
      await serverCopy(
        [
          "} from '@hourmere/auth'\n",
          "} from '@hourmere/auth'\nimport { scimClaimCompletion } from '@hourmere/auth'\n",
        ],
        [
          '    mcpOAuth: config.MCP_OAUTH_ENABLED,\n',
          '    mcpOAuth: config.MCP_OAUTH_ENABLED,\n    scimClaims: scimClaimCompletion,\n',
        ],
      ),
    )
    expect(wired.claimed).toBe(1)
    expect(wired.entry?.linked_user_id).not.toBeNull()
  })
})
