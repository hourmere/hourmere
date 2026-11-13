import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { serve } from '@hono/node-server'
import type { SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  deliverInvitationEmail,
  type InvitationMailLimits,
  reserveInvitationEmailBudget,
} from '@hourmere/notifications'
import { type KyselyPlugin, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { manageInvitation } from '../../../packages/auth/src/invitations.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import type { ScimResourceHandler } from './scim.ts'
import { SCIM_URN, scimDiscovery } from './scim-discovery.ts'
import { type ScimUserCreationDeps, scimUserCreation } from './scim-user-create.ts'
import { scimUsers } from './scim-users.ts'
import { productionAppOptions } from './server.ts'

// Expectations come from docs/scim.md, RFC 7643/7644 and the rows these tests read back,
// never from the handler's helpers, so a weakened protection fails here.
const design = readFileSync(new URL('../../../docs/scim.md', import.meta.url), 'utf8')
const words = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')
const says = (sentence: string) => new RegExp(words(sentence)).test(design)
type Json = Record<string, unknown>
type Create = typeof scimUserCreation
const publicUrl = 'https://scim-create.example'
const signingSecret = 'synthetic-scim-user-creation-cookie-signing-secret'
const core = SCIM_URN.user
const enterprise = SCIM_URN.enterpriseUser
const errorBody = (status: number, detail: string, scimType?: string) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
  status: String(status),
  ...(scimType === undefined ? {} : { scimType }),
  detail,
})
const unavailable = errorBody(404, 'SCIM resources are not available yet.')
const identifierTaken = errorBody(
  409,
  'A User of this connection already has this userName or externalId.',
  'uniqueness',
)
const noInviter = errorBody(
  403,
  'No owner of this organization with a verified email address can invite.',
)
const limited = errorBody(429, 'Invitation sending is limited right now. Retry later.')
const noWorkAddress = errorBody(
  400,
  'The emails attribute holds no work address. Send a "work" email, or a primary or single email without a type.',
  'invalidValue',
)
const twoPrimaries = errorBody(
  400,
  'The emails attribute marks more than one address as primary.',
  'invalidValue',
)
// A claim without an invitation lasts as long as an invitation: 48 hours.
const claimLifetime = 48 * 3_600_000
const signupRefused = errorBody(
  403,
  "This instance's sign-up policy does not admit this work email address.",
)
const open: SignupPolicy = { mode: 'open', allowedDomains: [] }
const closed: SignupPolicy = { mode: 'closed', allowedDomains: ['allowed.example'] }
// Generous admission limits: these tests create many invitations from one owner.
const roomy: InvitationMailLimits & { secret: string } = {
  secret: signingSecret,
  invitationInviterMaxPerHour: 1000,
  invitationInviterMaxPerDay: 1000,
  invitationTeamMaxPerHour: 1000,
  invitationTeamMaxPerDay: 1000,
}

async function sourceCopy<T>(file: string, ...mutations: [string, string][]): Promise<T> {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of mutations) {
    expect(source.includes(from), from).toBe(true)
    source = source.replace(from, to)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!process.env.DATABASE_URL)('SCIM User creation over HTTP', () => {
  let owned: TestDatabase, db: Db
  // Every queued delivery generation, and every message the real sender produced from them.
  const enqueued: { invitationId: string; generation: number }[] = []
  let delivered = 0
  const sent: MailMessage[] = []
  // 500 answers seen; a mutant must fail an assertion, not merely break a query.
  let serverErrors = 0
  // Harnesses served on a real socket.
  const servers: ReturnType<typeof serve>[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'scim_create',
    })
    db = createDb(owned.pool)
    // Injected failures: the claim insert for refuse-claim-* addresses, and the creation
    // event for refuse-audit-* names. Nothing else is affected.
    await sql`CREATE FUNCTION test_refuse_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.work_email LIKE 'refuse-claim-%' THEN RAISE EXCEPTION 'injected claim failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_claim BEFORE INSERT ON scim_user_claims
      FOR EACH ROW EXECUTE FUNCTION test_refuse_claim()`.execute(db)
    await sql`CREATE FUNCTION test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_user.created' AND EXISTS (SELECT 1 FROM scim_users
          WHERE id::text = NEW.target_id AND user_name LIKE 'refuse-audit-%') THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_audit()`.execute(db)
  })
  afterAll(async () => {
    for (const server of servers) server.close()
    await owned?.drop()
  })

  const unique = () => randomBytes(6).toString('hex')
  async function account(email: string, emailVerified = true) {
    return (
      await db
        .insertInto('auth.user')
        .values({ name: `Person ${unique()}`, email, emailVerified })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }
  async function token(organizationId: string) {
    const secret = `scim_${randomBytes(32).toString('base64url')}`
    await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(secret).digest('base64url'),
      })
      .execute()
    return secret
  }
  /**
   * A fresh team: the earliest owner invites; a later owner, an admin and a member exist too.
   * Two tokens share its one connection.
   */
  async function team() {
    const id = (
      await db
        .insertInto('auth.organization')
        .values({ name: `Team ${unique()}`, slug: `team-${unique()}`, createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    const people = {
      owner: await account(`owner-${unique()}@example.com`),
      laterOwner: await account(`later-${unique()}@example.com`),
      admin: await account(`admin-${unique()}@example.com`),
      member: await account(`member-${unique()}@example.com`),
    }
    const joined = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes))
    // The later owner joined first by ID order but later in time; createdAt decides.
    for (const [user, role, minutes] of [
      [people.laterOwner, 'owner', 30],
      [people.owner, 'owner', 0],
      [people.admin, 'admin', 10],
      [people.member, 'member', 20],
    ] as const)
      await db
        .insertInto('auth.member')
        .values({ organizationId: id, userId: user, role, createdAt: joined(minutes) })
        .execute()
    const secrets = { first: await token(id), second: await token(id) }
    const memberEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', people.member)
        .executeTakeFirstOrThrow()
    ).email
    return { id, people, secrets, memberEmail }
  }
  type Team = Awaited<ReturnType<typeof team>>

  const deps = (overrides: Partial<ScimUserCreationDeps> = {}): ScimUserCreationDeps => ({
    db,
    signup: open,
    reserve: (trx, input, now) => reserveInvitationEmailBudget(trx, input, roomy, now),
    enqueue: async (payload) => {
      enqueued.push(payload)
    },
    ...overrides,
  })
  // The resource test flag: the harness injects the handlers in code.
  const flagged =
    (create: Create, options: ScimUserCreationDeps): ScimResourceHandler =>
    (request) =>
      scimDiscovery(request) ?? create(options)(request) ?? scimUsers(db)(request)
  function harness(resources: ScimResourceHandler | undefined, enabled = true) {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl,
      scim: { db, enabled, resources },
    })
  }
  type Application = ReturnType<typeof harness>
  // A forged Host and forwarded host never name the location.
  async function call(
    application: Application,
    organization: string,
    secret: string,
    resource: string,
    method = 'GET',
    body?: unknown,
  ) {
    const response = await application.request(`/scim/v2/${organization}/${resource}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
        ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    if (response.status === 500) serverErrors += 1
    expect(response.headers.get('content-type'), resource).toBe('application/scim+json')
    expect(response.headers.get('cache-control'), resource).toBe('no-store')
    const text = await response.text()
    return {
      status: response.status,
      text,
      body: text ? (JSON.parse(text) as Json) : undefined,
      location: response.headers.get('location'),
      retryAfter: response.headers.get('retry-after'),
    }
  }
  const client = (create: Create, organization: Team, options = deps(), secret?: string) => {
    const application = harness(flagged(create, options))
    const as = secret ?? organization.secrets.first
    return {
      post: (body: unknown, query = '') =>
        call(application, organization.id, as, `Users${query}`, 'POST', body),
      get: (resource: string) => call(application, organization.id, as, resource),
      send: (resource: string, method: string, body?: unknown) =>
        call(application, organization.id, as, resource, method, body),
    }
  }
  /** The same harness served by @hono/node-server on 127.0.0.1, called with fetch. */
  async function httpClient(create: Create, organization: Team, options = deps()) {
    const application = harness(flagged(create, options))
    const port = await new Promise<number>((resolve) => {
      servers.push(
        serve({ fetch: application.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
          resolve(info.port),
        ),
      )
    })
    const send = async (resource: string, method = 'GET', body?: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/scim/v2/${organization.id}/${resource}`,
        {
          method,
          headers: {
            authorization: `Bearer ${organization.secrets.first}`,
            ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      )
      if (response.status === 500) serverErrors += 1
      const text = await response.text()
      return {
        status: response.status,
        text,
        body: text ? (JSON.parse(text) as Json) : undefined,
        headers: Object.fromEntries(response.headers.entries()),
      }
    }
    return {
      post: (body: unknown) => send('Users', 'POST', body),
      get: (resource: string) => send(resource),
    }
  }
  /** A signed-in session of a team member, for invitations sent from the app. */
  async function session(userId: string, organizationId: string) {
    return (
      await db
        .insertInto('auth.session')
        .values({
          userId,
          token: randomBytes(24).toString('base64url'),
          activeOrganizationId: organizationId,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }
  /** An invitation sent from the app by a team owner or administrator. */
  const native = (userId: string, sessionId: string, organizationId: string, email: string) =>
    manageInvitation(
      db,
      { userId, sessionId, activeOrganizationId: organizationId },
      { organizationId, email },
      {
        reserve: (trx, input, now) => reserveInvitationEmailBudget(trx, input, roomy, now),
        enqueue: async (payload) => {
          enqueued.push(payload)
        },
      },
    )
  const user = (userName: string, extra: Json = {}): Json => ({
    schemas: [core],
    userName,
    ...extra,
  })
  const work = (value: string) => ({ emails: [{ value, type: 'work', primary: true }] })

  // Everything one organization's creations can leave behind.
  async function written(organizationId: string) {
    const [entries, claims, invitations, deliveries, events, requests] = await Promise.all([
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
        .selectFrom('auth.invitation')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('invitation_deliveries as d')
        .innerJoin('auth.invitation as i', 'i.id', 'd.invitation_id')
        .select(['d.invitation_id', 'd.generation', 'd.state', 'd.authorized_by_user_id'])
        .where('i.organizationId', '=', organizationId)
        .orderBy('d.invitation_id')
        .execute(),
      db
        .selectFrom('audit_events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('invitation_email_requests')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .execute(),
    ])
    return { entries, claims, invitations, deliveries, events, requests }
  }
  // Accounts, memberships, sessions and sign-in methods: creation never writes any.
  async function accounts() {
    const rows = []
    for (const table of ['user', 'member', 'session', 'account', 'verification'])
      rows.push(
        (
          await sql<{
            row: string
          }>`SELECT to_jsonb(t)::text AS row FROM auth.${sql.raw(`"${table}"`)} t ORDER BY 1`.execute(
            db,
          )
        ).rows,
      )
    return rows
  }
  /** Runs the real invitation sender for every generation queued since the last call. */
  async function deliver() {
    while (delivered < enqueued.length) {
      const payload = enqueued[delivered] as (typeof enqueued)[number]
      delivered += 1
      await deliverInvitationEmail(
        {
          db,
          mailer: {
            send: async (message) => {
              sent.push(message)
            },
          },
          smtpConfigured: true,
          publicUrl,
          secret: signingSecret,
          mailMaxPerHour: 10_000,
          log: () => {},
        },
        payload,
      )
    }
  }
  const mailTo = (address: string) =>
    sent.filter((message) => message.to.toLowerCase() === address.toLowerCase()).length

  /** Holds the first matching query's transaction until another backend waits on a lock. */
  function holdAfter(match: (node: string) => boolean, hold: () => Promise<void>): KyselyPlugin {
    const queries = new Map<unknown, string>()
    let held = false
    return {
      transformQuery: (args) => {
        queries.set(args.queryId, JSON.stringify(args.node))
        return args.node
      },
      transformResult: async (args) => {
        const node = queries.get(args.queryId)
        queries.delete(args.queryId)
        if (!held && node && match(node)) {
          held = true
          await hold()
        }
        return args.result
      },
    }
  }
  const organizationLock = (node: string) =>
    node.includes('"name":"organization"') && node.includes('"ForUpdate"')
  const tokenRecheck = (node: string) =>
    node.includes('"name":"scim_provisioning_tokens"') && node.includes('"ForKeyShare"')
  async function lockWaiter(timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting
        FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(
        db,
      )
      if ((rows[0]?.waiting ?? 0) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }

  async function verifyCreation(create: Create) {
    const organization = await team()
    const { post, get } = client(create, organization)
    const before = await accounts()
    const queuedBefore = enqueued.length
    // A manager entry first, without a work address: no claim and no invitation.
    const boss = await post(user(`boss-${unique()}@example.com`, { displayName: 'Boss' }))
    expect(boss.status).toBe(201)
    const bossId = boss.body?.id as string
    expect((await written(organization.id)).claims).toEqual([])
    expect((await written(organization.id)).invitations).toEqual([])
    expect(enqueued.length).toBe(queuedBefore)
    const userName = `Ada.Lovelace.${unique()}@Example.com`
    const address = `Ada.${unique()}@Example.com`
    const created = await post({
      schemas: [core, enterprise],
      externalId: `ext-${unique()}`,
      userName,
      name: {
        formatted: 'Ada Lovelace',
        familyName: 'Lovelace',
        givenName: 'Ada',
        middleName: 'King',
      },
      displayName: 'Ada',
      nickName: 'A',
      title: 'Analyst',
      userType: 'Employee',
      locale: 'en-GB',
      timezone: 'Europe/London',
      active: true,
      emails: [
        // The work entry is the work address even when another entry is primary.
        { value: 'ada@home.example', type: 'home', primary: true },
        { value: ` ${address} `, type: 'work' },
      ],
      phoneNumbers: [{ value: '+44 20 0000 0000', type: 'work' }],
      password: 'Never-stored-password-1',
      groups: [],
      roles: [],
      entitlements: [],
      // Server-owned: ignored.
      id: 'client-chosen-id',
      meta: { resourceType: 'User', created: '2000-01-01T00:00:00Z' },
      [enterprise]: {
        employeeNumber: '7',
        costCenter: 'CC-1',
        organization: 'Analytical Engines',
        division: 'Research',
        department: 'Mathematics',
        manager: { value: bossId, displayName: 'Forged name' },
      },
    })
    expect(created.status).toBe(201)
    const id = created.body?.id as string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const location = `${publicUrl}/scim/v2/${organization.id}/Users/${id}`
    expect(created.location).toBe(location)
    const meta = created.body?.meta as Json
    expect(created.body).toEqual({
      schemas: [core, enterprise],
      id,
      externalId: expect.stringMatching(/^ext-/),
      userName,
      name: { formatted: 'Ada Lovelace', familyName: 'Lovelace', givenName: 'Ada' },
      displayName: 'Ada',
      nickName: 'A',
      title: 'Analyst',
      userType: 'Employee',
      locale: 'en-GB',
      timezone: 'Europe/London',
      active: true,
      emails: [{ value: address, type: 'work', primary: true }],
      [enterprise]: {
        employeeNumber: '7',
        costCenter: 'CC-1',
        organization: 'Analytical Engines',
        division: 'Research',
        department: 'Mathematics',
        // Derived from the manager's entry, never from the request.
        manager: { value: bossId, displayName: 'Boss' },
      },
      meta: {
        resourceType: 'User',
        created: expect.any(String),
        lastModified: meta.created,
        location,
      },
    })
    // The answer is the read representation, byte for byte.
    expect(created.text).toBe((await get(`Users/${id}`)).text)
    // Nothing was admitted: the entry is unlinked and every account table is unchanged.
    const state = await written(organization.id)
    const entry = state.entries.find((row) => row.id === id)
    expect(entry).toMatchObject({
      active: true,
      retired_at: null,
      linked_user_id: null,
      linked_member_id: null,
      work_email: address,
    })
    expect(await accounts()).toEqual(before)
    // One pending claim, through one pending member invitation from the earliest owner.
    const mailbox = address.toLowerCase()
    expect(state.invitations).toEqual([
      expect.objectContaining({
        organizationId: organization.id,
        email: mailbox,
        role: 'member',
        status: 'pending',
        inviterId: organization.people.owner,
      }),
    ])
    const invitation = state.invitations[0] as (typeof state.invitations)[number]
    expect(state.claims).toEqual([
      expect.objectContaining({
        scim_user_id: id,
        connection_id: entry?.connection_id,
        invitation_id: invitation.id,
        work_email: mailbox,
        expires_at: invitation.expiresAt,
        completed_at: null,
        invalidated_at: null,
      }),
    ])
    expect(state.deliveries).toEqual([
      {
        invitation_id: invitation.id,
        generation: 1,
        state: 'queued',
        authorized_by_user_id: organization.people.owner,
      },
    ])
    expect(enqueued.slice(queuedBefore)).toEqual([{ invitationId: invitation.id, generation: 1 }])
    // The real sender sends exactly one invitation email for it.
    await deliver()
    expect(mailTo(mailbox)).toBe(1)
    // Attributed to the token, with empty details: no name, address or other value.
    const tokenId = (
      await db
        .selectFrom('scim_provisioning_tokens')
        .select('id')
        .where(
          'token_hash',
          '=',
          createHash('sha256').update(organization.secrets.first).digest('base64url'),
        )
        .executeTakeFirstOrThrow()
    ).id
    const events = state.events.filter((event) => event.target_id !== bossId)
    expect(events).toEqual([
      expect.objectContaining({
        actor_type: 'scim_token',
        actor_id: tokenId,
        credential_type: 'none',
        credential_id: null,
        action: 'scim_user.created',
        target_type: 'scim_user',
        target_id: id,
        details: {},
      }),
      expect.objectContaining({
        actor_type: 'scim_token',
        actor_id: tokenId,
        credential_type: 'none',
        action: 'membership.invited',
        target_type: 'invitation',
        target_id: invitation.id,
        details: {},
      }),
    ])
    // Both carry the request's correlation ID. A source copy loads its own audit module,
    // outside the app's request context, so only the real module is checked for it.
    if (create === scimUserCreation) expect(events[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[1]?.request_id).toBe(events[0]?.request_id)
    const journal = JSON.stringify(state.events).toLowerCase()
    for (const value of [userName, mailbox, 'ada lovelace', 'never-stored-password-1'])
      expect(journal).not.toContain(value.toLowerCase())
    // The password is ignored: never stored anywhere.
    expect(JSON.stringify(state)).not.toContain('Never-stored-password-1')
    // A projection applies to the answer, never hiding the identity fields.
    const projected = await post(
      user(`projected-${unique()}@example.com`, { displayName: 'P' }),
      '?attributes=displayName',
    )
    expect(projected.status).toBe(201)
    expect(Object.keys(projected.body as Json).sort()).toEqual([
      'displayName',
      'id',
      'schemas',
      'userName',
    ])
    expect(projected.location).toBe(
      `${publicUrl}/scim/v2/${organization.id}/Users/${projected.body?.id}`,
    )
  }

  // Request shapes from the Okta SCIM 2.0 and Entra provisioning references.
  async function verifyProviderShapes(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    const okta = await post({
      schemas: [core],
      userName: `test.user.${unique()}@okta.example`,
      name: { givenName: 'Test', familyName: 'User' },
      emails: [{ primary: true, value: `test.user.${unique()}@okta.example`, type: 'work' }],
      displayName: 'Test User',
      locale: 'en-US',
      externalId: `00u${unique()}`,
      groups: [],
      password: 'okta-sync-password',
      active: true,
    })
    expect(okta.status).toBe(201)
    const entra = await post({
      schemas: [core, enterprise],
      externalId: randomUUID(),
      userName: `Test_User_${randomUUID()}`,
      active: true,
      emails: [{ primary: true, type: 'work', value: `Test_User_${unique()}@testuser.example` }],
      meta: { resourceType: 'User' },
      name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' },
      roles: [],
      addresses: [{ type: 'work', formatted: 'Somewhere', primary: true }],
      preferredLanguage: 'en-US',
      title: 'Engineer',
      [enterprise]: { employeeNumber: '1', department: 'R&D' },
    })
    expect(entra.status).toBe(201)
    // Attribute names are case-insensitive.
    const cased = await post({
      Schemas: [core.toUpperCase()],
      USERNAME: `cased-${unique()}@example.com`,
      DisplayName: 'Cased',
      Emails: [{ Value: `cased-${unique()}@example.com`, Type: 'Work', Primary: true }],
    })
    expect(cased.status).toBe(201)
    expect(cased.body?.displayName).toBe('Cased')
    expect(cased.body?.emails).toEqual([expect.objectContaining({ type: 'work' })])
  }

  async function verifyUniqueness(create: Create) {
    const organization = await team()
    const other = await team()
    const { post } = client(create, organization)
    const name = `Grace.${unique()}@Example.com`
    const externalId = `Ext-${unique()}`
    const first = await post(user(name, { externalId, ...work(`grace-${unique()}@example.com`) }))
    expect(first.status).toBe(201)
    const settled = await written(organization.id)
    const queued = enqueued.length
    // The same live identifiers, as uniqueness compares them, in the same connection.
    for (const duplicate of [
      user(name),
      user(` ${name.toLowerCase()} `),
      user(name.toUpperCase(), { externalId: `other-${unique()}` }),
      user(`fresh-${unique()}@example.com`, { externalId }),
      user(`fresh-${unique()}@example.com`, {
        externalId,
        ...work(`never-${unique()}@example.com`),
      }),
    ]) {
      const answer = await post(duplicate)
      expect(answer.status, JSON.stringify(duplicate)).toBe(409)
      expect(answer.body).toEqual(identifierTaken)
    }
    // Refusals write nothing: no entry, claim, invitation, delivery, event or budget.
    expect(await written(organization.id)).toEqual(settled)
    expect(enqueued.length).toBe(queued)
    // externalId is case-exact; another organization's identifiers never conflict.
    expect(
      (await post(user(`case-${unique()}@example.com`, { externalId: externalId.toLowerCase() })))
        .status,
    ).toBe(201)
    expect((await client(create, other).post(user(name, { externalId }))).status).toBe(201)
    // A retired entry's identifiers can be reused by a fresh resource.
    const connection = settled.entries[0]?.connection_id as string
    const retiredName = `retired-${unique()}@example.com`
    await db
      .insertInto('scim_users')
      .values({
        organization_id: organization.id,
        connection_id: connection,
        user_name: retiredName,
        external_id: 'retired-ext',
        active: false,
        retired_at: new Date('2026-11-01T00:00:00Z'),
      })
      .execute()
    const reused = await post(user(retiredName, { externalId: 'retired-ext' }))
    expect(reused.status).toBe(201)
  }

  async function verifyReplayRace(create: Create) {
    const organization = await team()
    const queued = enqueued.length
    let waited = false
    const held = db.withPlugin(
      holdAfter(organizationLock, async () => {
        waited = await lockWaiter()
      }),
    )
    const options = deps({ db: held })
    const mailbox = `race-${unique()}@example.com`
    const body = user(`race-${unique()}@example.com`, {
      externalId: `race-${unique()}`,
      ...work(mailbox),
    })
    // The same create through both tokens of the connection, at the same time.
    const answers = await Promise.all([
      client(create, organization, options, organization.secrets.first).post(body),
      client(create, organization, options, organization.secrets.second).post(body),
    ])
    expect(waited).toBe(true)
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
    expect(answers.find((answer) => answer.status === 409)?.body).toEqual(identifierTaken)
    const state = await written(organization.id)
    expect(state.entries).toHaveLength(1)
    expect(state.claims).toHaveLength(1)
    expect(state.invitations).toHaveLength(1)
    expect(state.deliveries).toEqual([expect.objectContaining({ generation: 1 })])
    expect(state.events.map((event) => event.action).sort()).toEqual([
      'membership.invited',
      'scim_user.created',
    ])
    expect(enqueued.length).toBe(queued + 1)
    // An IdP retry after the winner committed changes nothing either.
    const replay = await client(create, organization).post(body)
    expect(replay.body).toEqual(identifierTaken)
    expect(await written(organization.id)).toEqual(state)
    expect(enqueued.length).toBe(queued + 1)
    await deliver()
    expect(mailTo(mailbox)).toBe(1)
  }

  async function verifyDeduplication(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    const sessionId = await session(organization.people.owner, organization.id)
    const owner = (email: string) =>
      native(organization.people.owner, sessionId, organization.id, email)
    // The owner invited this address in the app; the email went out.
    const invited = `invited-${unique()}@example.com`
    const nativeInvitation = await owner(invited)
    await deliver()
    expect(mailTo(invited)).toBe(1)
    const queued = enqueued.length
    const created = await post(user(`invited-${unique()}`, work(invited)))
    expect(created.status).toBe(201)
    // The claim reuses that invitation: no second generation, no second email.
    let state = await written(organization.id)
    expect(state.invitations.map((row) => row.id)).toEqual([nativeInvitation.id])
    expect(state.claims).toEqual([
      expect.objectContaining({
        scim_user_id: created.body?.id,
        invitation_id: nativeInvitation.id,
      }),
    ])
    expect(state.deliveries).toEqual([
      expect.objectContaining({
        invitation_id: nativeInvitation.id,
        generation: 1,
        state: 'smtp_accepted',
      }),
    ])
    expect(enqueued.length).toBe(queued)
    await deliver()
    expect(mailTo(invited)).toBe(1)
    // Another entry for the same mailbox does not share that pending claim's invitation: it
    // gets its own claim without one, and nothing is sent again.
    const before = await written(organization.id)
    const second = await post(user(`second-${unique()}`, work(invited.toUpperCase())))
    expect(second.status).toBe(201)
    state = await written(organization.id)
    expect(state.claims).toEqual([
      ...before.claims,
      expect.objectContaining({
        scim_user_id: second.body?.id,
        invitation_id: null,
        work_email: invited,
      }),
    ])
    expect(state.invitations).toEqual(before.invitations)
    expect(state.deliveries).toEqual(before.deliveries)
    expect(state.requests).toEqual(before.requests)
    expect(enqueued.length).toBe(queued)
    await deliver()
    expect(mailTo(invited)).toBe(1)
    // A creation racing an invitation in the app for the same address: the app's request
    // waits for the creation's organization lock, then finds and keeps its invitation.
    const raced = `raced-${unique()}@example.com`
    let outcome = ''
    let nativeResult: Promise<{ id: string; existing: boolean }> | undefined
    const held = db.withPlugin(
      holdAfter(tokenRecheck, async () => {
        nativeResult = owner(raced)
        const settled = nativeResult.then(
          () => 'settled',
          () => 'settled',
        )
        outcome = await Promise.race([
          lockWaiter(5_000).then((waiting) => (waiting ? 'waiting' : 'timeout')),
          settled,
        ])
      }),
    )
    const racing = await client(create, organization, deps({ db: held })).post(
      user(`raced-${unique()}`, work(raced)),
    )
    expect(racing.status).toBe(201)
    expect(outcome).toBe('waiting')
    const nativeAnswer = await nativeResult
    expect(nativeAnswer?.existing).toBe(true)
    const racedInvitations = (await written(organization.id)).invitations.filter(
      (row) => row.email === raced,
    )
    expect(racedInvitations.map((row) => row.id)).toEqual([nativeAnswer?.id])
    await deliver()
    expect(mailTo(raced)).toBe(1)
  }

  async function verifySignup(create: Create) {
    const organization = await team()
    const outside = {
      verified: `verified-${unique()}@outside.example`,
      unverified: `unverified-${unique()}@outside.example`,
      nobody: `nobody-${unique()}@outside.example`,
    }
    await account(outside.verified, true)
    await account(outside.unverified, false)
    for (const policy of [closed, { ...closed, mode: 'first-user' as const }]) {
      const { post } = client(create, organization, deps({ signup: policy }))
      const state = await written(organization.id)
      // The same refusal whether or not an account, or a membership, holds the address.
      for (const address of [
        outside.verified,
        outside.unverified,
        outside.nobody,
        organization.memberEmail,
      ]) {
        const answer = await post(user(`signup-${unique()}`, work(address)))
        expect(answer.text, `${policy.mode} ${address}`).toBe(JSON.stringify(signupRefused))
      }
      expect(await written(organization.id)).toEqual(state)
      // An allowed domain, and an entry without a work address, are created.
      expect(
        (await post(user(`allowed-${unique()}`, work(`a-${unique()}@Allowed.example`)))).status,
      ).toBe(201)
      expect((await post(user(`no-mail-${unique()}`))).status).toBe(201)
    }
    // An open instance admits every domain.
    const { post } = client(create, organization)
    expect((await post(user(`open-${unique()}`, work(outside.nobody)))).status).toBe(201)
  }

  async function verifyNoAdmission(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    // Personal accounts hold these addresses, one of them never verified.
    const verified = `holder-${unique()}@example.com`
    const unverified = `unproven-${unique()}@example.com`
    await account(verified, true)
    await account(unverified, false)
    const before = await accounts()
    const answers: Awaited<ReturnType<typeof post>>[] = []
    for (const address of [verified, unverified, `absent-${unique()}@example.com`]) {
      const answer = await post(user(`holder-${unique()}`, work(address)))
      expect(answer.status, address).toBe(201)
      answers.push(answer)
    }
    // No account, membership, session or sign-in method changed: no address became
    // verified, nobody joined, nothing was linked.
    expect(await accounts()).toEqual(before)
    const state = await written(organization.id)
    for (const entry of state.entries) {
      expect(entry.linked_user_id).toBeNull()
      expect(entry.linked_member_id).toBeNull()
    }
    expect(state.invitations.map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
    expect(state.claims.every((claim) => claim.completed_at === null)).toBe(true)
    // The answers do not tell an existing account from an absent one.
    const shape = (answer: (typeof answers)[number]) =>
      JSON.stringify(answer.body, (key, value) =>
        ['id', 'userName', 'value', 'created', 'lastModified', 'location'].includes(key)
          ? 'x'
          : value,
      )
    expect(new Set(answers.map(shape)).size).toBe(1)
  }

  async function verifyAtomicity(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    const state = await written(organization.id)
    const queued = enqueued.length
    // A failure after the creation event (the claim insert) and of the event itself.
    for (const body of [
      user(`claim-${unique()}`, work(`refuse-claim-${unique()}@example.com`)),
      user(`refuse-audit-${unique()}`, work(`audit-${unique()}@example.com`)),
      user(`refuse-audit-${unique()}`),
    ]) {
      serverErrors = 0
      const answer = await post(body)
      expect(answer.status).toBe(500)
      expect(answer.body).toEqual(errorBody(500, 'SCIM request could not be processed.'))
      serverErrors = 0
    }
    // A refusal after the event was written: exhausted admission limits.
    const refused = await client(create, organization, deps({ reserve: async () => false })).post(
      user(`limited-${unique()}`, work(`limited-${unique()}@example.com`)),
    )
    expect(refused.body).toEqual(limited)
    expect(await written(organization.id)).toEqual(state)
    expect(enqueued.length).toBe(queued)
  }

  async function verifyRevocation(create: Create) {
    const organization = await team()
    const hash = createHash('sha256').update(organization.secrets.second).digest('base64url')
    const tokenId = (
      await db
        .selectFrom('scim_provisioning_tokens')
        .select('id')
        .where('token_hash', '=', hash)
        .executeTakeFirstOrThrow()
    ).id
    // The token is revoked after authentication, while the create waits for its locks.
    const held = db.withPlugin(
      holdAfter(organizationLock, async () => {
        await owned.pool.query(
          'UPDATE scim_provisioning_tokens SET revoked_at = clock_timestamp(), token_hash = NULL, previous_token_hash = NULL, previous_valid_until = NULL WHERE id = $1',
          [tokenId],
        )
      }),
    )
    const state = await written(organization.id)
    const answer = await client(
      create,
      organization,
      deps({ db: held }),
      organization.secrets.second,
    ).post(user(`revoked-${unique()}`, work(`revoked-${unique()}@example.com`)))
    expect(answer.status).toBe(401)
    expect(answer.body).toEqual(errorBody(401, 'A valid provisioning token is required.'))
    expect(await written(organization.id)).toEqual(state)
  }

  async function verifyLimits(create: Create) {
    // Default admission limits, with a team limit of one invitation an hour.
    const limitedTeam = await team()
    const options = deps({
      reserve: (trx, input, now) =>
        reserveInvitationEmailBudget(trx, input, { ...roomy, invitationTeamMaxPerHour: 1 }, now),
    })
    const { post } = client(create, limitedTeam, options)
    expect(
      (await post(user(`first-${unique()}`, work(`first-${unique()}@example.com`)))).status,
    ).toBe(201)
    const state = await written(limitedTeam.id)
    const refused = await post(user(`second-${unique()}`, work(`second-${unique()}@example.com`)))
    expect(refused.status).toBe(429)
    expect(refused.retryAfter).toBe('3600')
    expect(refused.body).toEqual(limited)
    expect(await written(limitedTeam.id)).toEqual(state)
    // A member's address needs no invitation, so it is recorded while sending is limited.
    expect((await post(user(`member-${unique()}`, work(limitedTeam.memberEmail)))).status).toBe(201)
    // The pending-invitation cap of the invitation service applies too.
    const full = await team()
    await db
      .insertInto('auth.invitation')
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          organizationId: full.id,
          email: `pending-${index}-${unique()}@example.com`,
          role: 'member',
          status: 'pending',
          inviterId: full.people.admin,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      )
      .execute()
    const before = await written(full.id)
    const capped = await client(create, full).post(
      user(`capped-${unique()}`, work(`capped-${unique()}@example.com`)),
    )
    expect(capped.status).toBe(429)
    expect(capped.retryAfter).toBe('3600')
    expect(await written(full.id)).toEqual(before)
  }

  async function verifyRefusals(create: Create) {
    const organization = await team()
    const other = await team()
    const { post, send } = client(create, organization)
    const foreignManager = (await client(create, other).post(user(`foreign-${unique()}`))).body
      ?.id as string
    const ownManager = (await post(user(`own-${unique()}`))).body?.id as string
    const connection = (await written(organization.id)).entries[0]?.connection_id as string
    const retiredManager = randomUUID()
    await db
      .insertInto('scim_users')
      .values({
        id: retiredManager,
        organization_id: organization.id,
        connection_id: connection,
        user_name: `retired-manager-${unique()}`,
        active: false,
        retired_at: new Date('2026-11-01T00:00:00Z'),
      })
      .execute()
    const state = await written(organization.id)
    const queued = enqueued.length
    const syntax = (detail: string) => errorBody(400, detail, 'invalidSyntax')
    const value = (detail: string) => errorBody(400, detail, 'invalidValue')
    const secret = `secret-${unique()}`
    const notAUser = syntax('The request body must be a User object.')
    const badSchemas = syntax(
      'The schemas attribute must name the User schema and only supported extensions.',
    )
    const unknown = value('The request names an attribute that this server does not support.')
    const managerRefused = value('The manager attribute does not name a User of this connection.')
    const cases: [unknown, number, Json][] = [
      ['{"schemas":', 400, syntax('The request body is not valid JSON.')],
      ['', 400, syntax('The request body is not valid JSON.')],
      [[user(secret)], 400, notAUser],
      ['"text"', 400, notAUser],
      [{ userName: secret }, 400, badSchemas],
      [{ schemas: core, userName: secret }, 400, badSchemas],
      [{ schemas: [enterprise], userName: secret }, 400, badSchemas],
      [{ schemas: [core, 'urn:example:custom:2.0:User'], userName: secret }, 400, badSchemas],
      [
        { schemas: [core], userName: secret, UserName: secret },
        400,
        syntax('An attribute is named more than once.'),
      ],
      [
        user(secret, { nickname: 'a', nickName: 'b' }),
        400,
        syntax('An attribute is named more than once.'),
      ],
      [{ schemas: [core] }, 400, value('The userName attribute is required.')],
      [user('   '), 400, value('The userName attribute is required.')],
      [user('x'.repeat(257)), 400, value('The userName attribute is not a valid value.')],
      [user(42 as unknown as string), 400, value('The userName attribute is not a valid value.')],
      [user(`nul\u0000${secret}`), 400, value('The userName attribute is not a valid value.')],
      [user(`lone\ud800${secret}`), 400, value('The userName attribute is not a valid value.')],
      [
        user(secret, { externalId: '' }),
        400,
        value('The externalId attribute is not a valid value.'),
      ],
      [
        user(secret, { externalId: 'e'.repeat(1025) }),
        400,
        value('The externalId attribute is not a valid value.'),
      ],
      [
        user(secret, { displayName: 'd'.repeat(257) }),
        400,
        value('The displayName attribute is not a valid value.'),
      ],
      [user(secret, { title: ['list'] }), 400, value('The title attribute is not a valid value.')],
      [
        user(secret, { locale: 'not a locale' }),
        400,
        value('The locale attribute is not a valid value.'),
      ],
      [
        user(secret, { timezone: 'Mars/Olympus_Mons' }),
        400,
        value('The timezone attribute is not a valid value.'),
      ],
      [
        user(secret, { timezone: '+01:00' }),
        400,
        value('The timezone attribute is not a valid value.'),
      ],
      [user(secret, { name: 'Full Name' }), 400, value('The name attribute must be an object.')],
      [user(secret, { name: { formatted: 'F', nickname: 'N' } }), 400, unknown],
      [user(secret, { badge: secret }), 400, unknown],
      [user(secret, { badge: null }), 400, unknown],
      [
        { schemas: [core], userName: secret, USERNAME: null },
        400,
        syntax('An attribute is named more than once.'),
      ],
      [user(secret, { 'urn:example:custom:2.0:User': { badge: secret } }), 400, unknown],
      [
        user(secret, { active: false }),
        400,
        value('Creating an inactive User is not supported yet.'),
      ],
      [user(secret, { active: 'True' }), 400, value('The active attribute is not a valid value.')],
      [
        user(secret, { emails: `${secret}@example.com` }),
        400,
        value('The emails attribute is not a valid value.'),
      ],
      [
        user(secret, { emails: [{ value: `${secret}@example.com`, type: 'work', label: 'x' }] }),
        400,
        unknown,
      ],
      [
        user(secret, {
          emails: [{ value: `${secret}@example.com`, type: 'work', primary: 'yes' }],
        }),
        400,
        value('The emails attribute is not a valid value.'),
      ],
      // RFC 7643 section 2.4: at most one primary value.
      [
        user(secret, {
          emails: [
            { value: `a-${secret}@example.com`, type: 'work', primary: true },
            { value: `b-${secret}@example.com`, type: 'home', primary: true },
          ],
        }),
        400,
        twoPrimaries,
      ],
      // Addresses that none of the four rules selects are refused, never dropped.
      [
        user(secret, { emails: [{ value: `${secret}@example.com`, type: 'home' }] }),
        400,
        noWorkAddress,
      ],
      [
        user(secret, { emails: [{ value: `${secret}@example.com`, type: 'home', primary: true }] }),
        400,
        noWorkAddress,
      ],
      [
        user(secret, {
          emails: [
            { value: `a-${secret}@example.com`, type: 'home' },
            { value: `b-${secret}@example.com` },
          ],
        }),
        400,
        noWorkAddress,
      ],
      [
        user(secret, {
          emails: [{ value: `a-${secret}@example.com` }, { value: `b-${secret}@example.com` }],
        }),
        400,
        noWorkAddress,
      ],
      [
        user(secret, { emails: [{ value: `${secret}@example.com`, type: 'other' }] }),
        400,
        noWorkAddress,
      ],
      [
        user(secret, work(`not-an-address-${secret}`)),
        400,
        value('The work email address is not a valid value.'),
      ],
      [
        user(secret, work(`${'a'.repeat(250)}@example.com`)),
        400,
        value('The work email address is not a valid value.'),
      ],
      [
        user(secret, { roles: [{ value: 'admin' }] }),
        403,
        errorBody(
          403,
          'Roles and entitlements are not provisioned. Change membership roles through ordinary team administration.',
          'mutability',
        ),
      ],
      [
        user(secret, { entitlements: [{ value: 'owner' }] }),
        403,
        errorBody(
          403,
          'Roles and entitlements are not provisioned. Change membership roles through ordinary team administration.',
          'mutability',
        ),
      ],
      [user(secret, { roles: 'admin' }), 400, value('The roles attribute is not a valid value.')],
      [user(secret, { [enterprise]: { manager: { value: foreignManager } } }), 400, managerRefused],
      [user(secret, { [enterprise]: { manager: { value: retiredManager } } }), 400, managerRefused],
      [user(secret, { [enterprise]: { manager: { value: randomUUID() } } }), 400, managerRefused],
      [
        user(secret, { [enterprise]: { manager: { value: ownManager.toUpperCase() } } }),
        400,
        managerRefused,
      ],
      [
        user(secret, { [enterprise]: { manager: ownManager } }),
        400,
        value('The manager attribute must be an object.'),
      ],
      [user(secret, { [enterprise]: { badge: secret } }), 400, unknown],
    ]
    for (const [body, status, expected] of cases) {
      const answer = await post(body)
      expect(
        { status: answer.status, body: answer.body },
        JSON.stringify(body)?.slice(0, 200),
      ).toEqual({ status, body: expected })
      // A refusal never echoes what was sent.
      expect(answer.text).not.toContain(secret)
    }
    // An invalid projection is refused before anything is written.
    expect((await post(user(`projection-${unique()}`), '?attributes=badge')).status).toBe(400)
    // A body larger than 64 KiB, declared or not.
    const large = user(`large-${unique()}`, { displayName: 'x'.repeat(70_000) })
    const tooLarge = await post(large)
    expect(tooLarge).toMatchObject({
      status: 413,
      body: errorBody(413, 'The request body is too large.'),
    })
    expect(await written(organization.id)).toEqual(state)
    expect(enqueued.length).toBe(queued)
    // The own connection's live manager is accepted.
    const managed = await post(
      user(`managed-${unique()}`, { [enterprise]: { manager: { value: ownManager } } }),
    )
    expect(managed.status).toBe(201)
    // Other write methods and paths keep the unavailable answer.
    for (const [method, resource] of [
      ['POST', `Users/${ownManager}`],
      ['POST', 'Users/.search'],
      ['POST', 'Users/'],
      ['PUT', `Users/${ownManager}`],
      ['PATCH', `Users/${ownManager}`],
      ['DELETE', `Users/${ownManager}`],
    ] as const)
      expect(
        await send(resource, method, user(`x-${unique()}`)),
        `${method} ${resource}`,
      ).toMatchObject({
        status: 404,
        body: unavailable,
      })
  }

  async function verifyInviter(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    const verify = (user: string, emailVerified: boolean) =>
      db.updateTable('auth.user').set({ emailVerified }).where('id', '=', user).execute()
    // The earliest owner changed their address and has not proven it yet: the next owner
    // with a verified address invites, so the sender delivers the invitation.
    await verify(organization.people.owner, false)
    const address = `inviter-${unique()}@example.com`
    expect((await post(user(`inviter-${unique()}`, work(address)))).status).toBe(201)
    const invitation = (await written(organization.id)).invitations.find(
      (row) => row.email === address,
    )
    expect(invitation?.inviterId).toBe(organization.people.laterOwner)
    await deliver()
    expect(mailTo(address)).toBe(1)
    // No owner can invite: nothing is created. An administrator never invites.
    await verify(organization.people.laterOwner, false)
    const state = await written(organization.id)
    // The same refusal for a member's address, which would need no invitation.
    for (const address of [`none-${unique()}@example.com`, organization.memberEmail]) {
      const refused = await post(user(`no-inviter-${unique()}`, work(address)))
      expect(refused.status, address).toBe(403)
      expect(refused.text, address).toBe(JSON.stringify(noInviter))
    }
    expect(await written(organization.id)).toEqual(state)
  }

  async function verifyQueueOutage(create: Create) {
    const organization = await team()
    const failing = deps({
      enqueue: async () => {
        throw new Error('queue unavailable')
      },
    })
    const answer = await client(create, organization, failing).post(
      user(`outage-${unique()}`, work(`outage-${unique()}@example.com`)),
    )
    expect(answer.status).toBe(201)
    // The committed delivery intent stays queued for the invitation repairer.
    const state = await written(organization.id)
    expect(state.claims).toHaveLength(1)
    expect(state.deliveries).toEqual([expect.objectContaining({ generation: 1, state: 'queued' })])
  }

  // The work address, in order: the primary work email, the first work email, a primary
  // email without type, the only email when it has no type.
  async function verifyEmailChoice(create: Create) {
    const organization = await team()
    const { post } = client(create, organization)
    const address = (label: string) => `${label}-${unique()}@example.com`
    const cases: [string, Json[], number][] = []
    const add = (emails: Json[], chosen: number) => cases.push([unique(), emails, chosen])
    const [a, b, c] = [address('a'), address('b'), address('c')]
    // 1. The primary work email, before an earlier work email and any other primary.
    add(
      [
        { value: a, type: 'home' },
        { value: b, type: 'work' },
        { value: c, type: 'WORK', primary: true },
      ],
      2,
    )
    // 2. Any work email: the first, when none is primary, even after a primary home email
    //    or a primary email without a type.
    add(
      [
        { value: a, type: 'home', primary: true },
        { value: b, type: 'work' },
        { value: c, type: 'work' },
      ],
      1,
    )
    add(
      [
        { value: a, primary: true },
        { value: b, type: 'Work' },
      ],
      1,
    )
    // 3. A primary email without a type, when there is no work email.
    add([{ value: a, type: 'home' }, { value: b, primary: true }, { value: c }], 1)
    // 4. The only email, when it has no type.
    add([{ value: a }], 0)
    add([{ value: b, primary: false }], 0)
    // An empty type is no type, and a padded work type is work.
    add([{ value: c, type: '' }], 0)
    add(
      [
        { value: a, type: 'home' },
        { value: b, type: ' Work ' },
      ],
      1,
    )
    for (const [label, emails, chosen] of cases) {
      const answer = await post(user(`emails-${label}`, { emails }))
      const expected = (emails[chosen] as { value: string }).value
      expect(answer.status, JSON.stringify(emails)).toBe(201)
      expect(answer.body?.emails, JSON.stringify(emails)).toEqual([
        { value: expected, type: 'work', primary: true },
      ])
      const claim = (await written(organization.id)).claims.find(
        (row) => row.scim_user_id === answer.body?.id,
      )
      expect(claim?.work_email, JSON.stringify(emails)).toBe(expected.toLowerCase())
    }
    // An empty list holds no address: the entry is created without a claim.
    const empty = await post(user(`emails-empty-${unique()}`, { emails: [] }))
    expect(empty.status).toBe(201)
    expect(
      (await written(organization.id)).claims.some((row) => row.scim_user_id === empty.body?.id),
    ).toBe(false)
  }

  // Existing members and invitations go through the claim flow: the same entry, a pending
  // claim without an invitation, no email, and the same 201 as a fresh create.
  async function verifyHeldAddresses(create: Create) {
    const organization = await team()
    const scim = await httpClient(create, organization)
    // A team that has never seen any of these addresses answers the same Users.
    const fresh = await team()
    const control = await httpClient(create, fresh)
    const connection = (
      await db
        .selectFrom('scim_connections')
        .select('id')
        .where('organization_id', '=', organization.id)
        .executeTakeFirstOrThrow()
    ).id
    const pending = (email: string, inviterId: string, role = 'member') =>
      db
        .insertInto('auth.invitation')
        .values({
          organizationId: organization.id,
          email,
          role,
          status: 'pending',
          inviterId,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    // Another administrator invited this address in the app; that email went out.
    const otherAdmin = `other-admin-${unique()}@example.com`
    await native(
      organization.people.admin,
      await session(organization.people.admin, organization.id),
      organization.id,
      otherAdmin,
    )
    await deliver()
    expect(mailTo(otherAdmin)).toBe(1)
    // A legacy invitation with a role SCIM never grants, from the inviting owner itself.
    const legacy = `legacy-${unique()}@example.com`
    await pending(legacy, organization.people.owner, 'admin')
    // Two pending invitations for one address, from before one-per-address was enforced.
    const duplicated = `duplicated-${unique()}@example.com`
    await pending(duplicated, organization.people.admin)
    await pending(duplicated, organization.people.laterOwner)
    // An invitation whose inviter has left the team.
    const orphaned = `orphaned-${unique()}@example.com`
    await pending(orphaned, await account(`departed-${unique()}@example.com`))
    // The inviting owner's pending invitation, which another entry's claim already holds,
    // still without a delivery generation: admission would give it one, budget included.
    const claimed = `claimed-${unique()}@example.com`
    const held = await pending(claimed, organization.people.owner)
    const holder = await db
      .insertInto('scim_users')
      .values({
        organization_id: organization.id,
        connection_id: connection,
        user_name: `holder-${unique()}`,
        work_email: claimed,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_user_claims')
      .values({
        organization_id: organization.id,
        connection_id: connection,
        scim_user_id: holder.id,
        invitation_id: held.id,
        work_email: claimed,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute()
    const normalized = (answer: Awaited<ReturnType<typeof scim.post>>, organizationId: string) => {
      const id = answer.body?.id as string
      const created = (answer.body?.meta as Json | undefined)?.created as string
      const blank = (text: string) =>
        text.replaceAll(id, '<id>').replaceAll(organizationId, '<org>').replaceAll(created, '<at>')
      const { date: _date, location, ...headers } = answer.headers
      return { text: blank(answer.text), headers, location: blank(location ?? '') }
    }
    for (const [label, address] of [
      ['member', organization.memberEmail.toUpperCase()],
      ["another administrator's invitation", otherAdmin],
      ['legacy invitation', legacy],
      ['duplicated invitations', duplicated],
      ["departed inviter's invitation", orphaned],
      ["another entry's claimed invitation", claimed],
    ] as const) {
      const before = await written(organization.id)
      const people = await accounts()
      const queued = enqueued.length
      const mails = mailTo(address)
      const body = user(`held-${unique()}@example.com`, {
        externalId: `held-${unique()}`,
        displayName: 'Held',
        ...work(address),
      })
      const answer = await scim.post(body)
      expect(answer.status, label).toBe(201)
      const id = answer.body?.id as string
      // The entry and a pending claim without an invitation; nothing else is written.
      const after = await written(organization.id)
      expect(after.entries, label).toEqual([
        ...before.entries,
        expect.objectContaining({
          id,
          work_email: address,
          linked_user_id: null,
          linked_member_id: null,
          retired_at: null,
        }),
      ])
      const claim = after.claims.find((row) => row.scim_user_id === id)
      expect(after.claims, label).toEqual([...before.claims, claim])
      expect(claim, label).toMatchObject({
        organization_id: organization.id,
        connection_id: connection,
        invitation_id: null,
        work_email: address.toLowerCase(),
        completed_at: null,
        invalidated_at: null,
      })
      const lifetime =
        (claim?.expires_at.getTime() ?? 0) - (claim?.created_at.getTime() ?? 0) - claimLifetime
      expect(lifetime, label).toBeGreaterThanOrEqual(0)
      expect(lifetime, label).toBeLessThan(60_000)
      expect(after.invitations, label).toEqual(before.invitations)
      expect(after.deliveries, label).toEqual(before.deliveries)
      expect(after.requests, label).toEqual(before.requests)
      expect(after.events, label).toEqual([
        ...before.events,
        expect.objectContaining({
          action: 'scim_user.created',
          actor_type: 'scim_token',
          target_id: id,
          details: {},
        }),
      ])
      // No email: nothing queued, and the real sender sends nothing more to the address.
      expect(enqueued.length, label).toBe(queued)
      await deliver()
      expect(mailTo(address), label).toBe(mails)
      expect(await accounts(), label).toEqual(people)
      // Byte for byte the answer a fresh create of the same User gets, apart from its ID,
      // organization and timestamps.
      const baseline = await control.post(body)
      expect(baseline.status, label).toBe(201)
      expect(normalized(answer, organization.id), label).toEqual(normalized(baseline, fresh.id))
      // The identity provider's userName filter finds the entry.
      const found = await scim.get(
        `Users?filter=${encodeURIComponent(`userName eq "${body.userName}"`)}`,
      )
      expect(found.status, label).toBe(200)
      expect(found.body, label).toMatchObject({
        totalResults: 1,
        Resources: [expect.objectContaining({ id, userName: body.userName })],
      })
      // A duplicate live identity of the connection is still the one conflict.
      const settled = await written(organization.id)
      for (const duplicate of [
        body,
        user(`other-${unique()}`, { externalId: body.externalId, ...work(address) }),
      ]) {
        const conflict = await scim.post(duplicate)
        expect(conflict.status, label).toBe(409)
        expect(conflict.body, label).toEqual(identifierTaken)
      }
      expect(await written(organization.id), label).toEqual(settled)
    }
  }

  const verifiers = {
    creation: verifyCreation,
    emails: verifyEmailChoice,
    held: verifyHeldAddresses,
    inviter: verifyInviter,
    queue: verifyQueueOutage,
    providers: verifyProviderShapes,
    uniqueness: verifyUniqueness,
    race: verifyReplayRace,
    deduplication: verifyDeduplication,
    signup: verifySignup,
    admission: verifyNoAdmission,
    atomicity: verifyAtomicity,
    revocation: verifyRevocation,
    limits: verifyLimits,
    refusals: verifyRefusals,
  }

  it('takes its creation rules from docs/scim.md', () => {
    for (const sentence of [
      '| `POST /Users` | Create a managed provisioning entry; 201 with representation and Location; duplicate live scoped identity gets 409; retired entries do not conflict. |',
      'POST creates the provisioning entry and a bounded, deduplicated invitation intent, using the existing mail queue and admission policy.',
      'It does not set `emailVerified=true`, create a sign-in session, or bypass restricted signup.',
      'SCIM is never a signup-domain authority.',
      'Existing same-email personal accounts receive the same claim flow and require their own current account proof.',
      'Errors must not echo bearer values, raw requests, SQL, mailbox existence outside the connection or sensitive attribute values.',
      'User creation records one live entry in the connection the token is bound to',
      'the earliest current owner of the organization whose email address is verified is the inviter (with no such owner the create gets 403, whatever the address)',
      'the primary `work` email, the first `work` email, a primary email without `type`, then the only email when it has no `type`',
      'gets the same entry and a pending claim without an invitation, nothing is sent, and the answer is the same 201 as any other create',
      'Only a duplicate live identity of the connection gets 409.',
      'a restricted instance (`SIGNUP` set to `closed` or `first-user`) refuses a work address whose domain is not in `SIGNUP_ALLOWED_DOMAINS` with 403',
    ])
      expect(says(sentence), sentence).toBe(true)
  })

  it('creates an entry with a pending claim and one invitation, admitting nobody', () =>
    verifyCreation(scimUserCreation))
  it('accepts the documented Okta and Entra request shapes', () =>
    verifyProviderShapes(scimUserCreation))
  it('refuses live duplicates in the connection with 409 uniqueness', () =>
    verifyUniqueness(scimUserCreation))
  it('lets one of two concurrent identical creates win, with one invitation email', () =>
    verifyReplayRace(scimUserCreation))
  it('reuses a pending invitation and never shares one between claims', () =>
    verifyDeduplication(scimUserCreation))
  it('records existing members and invitations as claims without an invitation or email', () =>
    verifyHeldAddresses(scimUserCreation))
  it('chooses the work address in the documented order', () => verifyEmailChoice(scimUserCreation))
  it('respects a restricted sign-up policy without looking at accounts', () =>
    verifySignup(scimUserCreation))
  it('never admits, links or verifies an existing account', () =>
    verifyNoAdmission(scimUserCreation))
  it('commits the entry, claim, invitation and audit events together', () =>
    verifyAtomicity(scimUserCreation))
  it('refuses a token revoked while the create waits', () => verifyRevocation(scimUserCreation))
  it('lets the earliest owner with a verified address invite', () =>
    verifyInviter(scimUserCreation))
  it('still answers 201 when the queue is down after commit', () =>
    verifyQueueOutage(scimUserCreation))
  it('applies the invitation admission limits', () => verifyLimits(scimUserCreation))
  it('refuses invalid users with SCIM Errors that echo nothing', () =>
    verifyRefusals(scimUserCreation))

  it('detects each weakened protection in a source copy', async () => {
    const control =
      await sourceCopy<typeof import('./scim-user-create.ts')>('./scim-user-create.ts')
    serverErrors = 0
    for (const verify of Object.values(verifiers)) await verify(control.scimUserCreation)
    expect(serverErrors).toBe(0)
    const mutants: [keyof typeof verifiers, [string, string]][] = [
      // The sign-up policy ignored.
      [
        'signup',
        [
          'if (entry.work_email !== null && !signupAdmits(deps.signup, entry.work_email))',
          'if (false)',
        ],
      ],
      // Live duplicates no longer answered as conflicts.
      ['uniqueness', ["if (database?.code === '23505'", "if (database?.code === 'none'"]],
      // The creation event written outside the transaction.
      [
        'atomicity',
        [
          '        await writeAuditEvent(trx, {',
          '        await (async (event) => deps.db.transaction().execute((apart) => writeAuditEvent(apart, event)))({',
        ],
      ],
      // A same-address account marked verified, or admitted at once.
      [
        'admission',
        [
          '        let queued:',
          "        if (entry.work_email !== null) await trx.updateTable('auth.user').set({ emailVerified: true }).where('email', '=', entry.work_email.toLowerCase()).execute()\n        let queued:",
        ],
      ],
      [
        'admission',
        [
          '        let queued:',
          "        if (entry.work_email !== null) for (const account of await trx.selectFrom('auth.user').select('id').where('email', '=', entry.work_email.toLowerCase()).execute()) await trx.insertInto('auth.member').values({ organizationId: principal.organizationId, userId: account.id, role: 'member', createdAt: new Date() }).execute()\n        let queued:",
        ],
      ],
      // A claimed invitation shared by a second entry.
      ['deduplication', ['            admitted = undefined\n', '            void 0\n']],
      // A member's address refused again, and the other held addresses likewise.
      ['held', ["  'INVITATION_RECIPIENT_ALREADY_MEMBER',\n", '']],
      ['held', ["  'INVITATION_ALREADY_PENDING',\n", '']],
      ['held', ["  'TEAM_MANAGEMENT_ACCESS_DENIED',\n", '']],
      ['held', ["  'INVITATION_CONFLICT',\n", '']],
      ['held', ["  'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',\n", '']],
      // An admission that is not linked kept anyway (its budget and delivery generation).
      [
        'held',
        [
          '          if (!admitted) await sql`ROLLBACK TO SAVEPOINT scim_user_invitation`.execute(trx)\n',
          '',
        ],
      ],
      // No claim recorded without an invitation.
      [
        'held',
        [
          "          await trx\n            .insertInto('scim_user_claims')",
          "          if (admitted) await trx\n            .insertInto('scim_user_claims')",
        ],
      ],
      // A claim without an invitation that expires at once, or never.
      ['held', ['invitationLifetimeMs / 1000}::double precision', '1}::double precision']],
      // The organization lock dropped: an invitation in the app is no longer serialized.
      [
        'deduplication',
        [
          '          .forUpdate()\n          .executeTakeFirst()\n        // A token',
          '          .executeTakeFirst()\n        // A token',
        ],
      ],
      // The queue fed before commit, for a create that then fails.
      [
        'atomicity',
        [
          "          await trx\n            .insertInto('scim_user_claims')",
          "          await deps.enqueue?.({ invitationId: admitted.invitation.id, generation: admitted.delivery.generation })\n          await trx\n            .insertInto('scim_user_claims')",
        ],
      ],
      // A revoked token still creating.
      [
        'revocation',
        [
          "          .where('revoked_at', 'is', null)\n          .forKeyShare()",
          '          .forKeyShare()',
        ],
      ],
      // A queue outage after commit turned into a failed create.
      [
        'queue',
        [
          '    try {\n      await deps.enqueue(created.queued)\n    } catch {}\n',
          '    await deps.enqueue(created.queued)\n',
        ],
      ],
      // Another owner, or an administrator, as the inviter.
      [
        'creation',
        [".orderBy('auth.member.createdAt')\n", ".orderBy('auth.member.createdAt', 'desc')\n"],
      ],
      // An owner whose address is unproven chosen as the inviter.
      ['inviter', ["            .where('auth.user.emailVerified', '=', true)\n", '']],
      // No owner answered as a duplicate.
      ['inviter', ["  refuse(403, 'No owner of this", "  refuse(409, 'No owner of this"]],
      // An unknown attribute sent as null accepted.
      [
        'refusals',
        ['    named.set(key, item ?? undefined)', '    if (item !== null) named.set(key, item)'],
      ],
      // Admission limits ignored.
      ['limits', ['          { reserve: deps.reserve },\n', '          {},\n']],
      // A refused or unauthorized-looking value echoed, inactive entries created, and a
      // manager from outside the connection accepted.
      [
        'refusals',
        [
          "          throw invalidValue('The manager attribute does not name a User of this connection.')\n        // Live",
          '          void 0\n        // Live',
        ],
      ],
      [
        'refusals',
        [
          '  if (active !== undefined && active !== true)',
          '  if (active !== undefined && active !== true && active !== false)',
        ],
      ],
      ['refusals', ['  if (value.length > 0)\n', '  if (false)\n']],
      // The work address read from the wrong entry: any type as work, the primary work
      // email not preferred, typeless primary or single emails dropped, two primaries let
      // through.
      [
        'creation',
        ["const work = emails.filter((email) => email.type === 'work')", 'const work = emails'],
      ],
      ['emails', ['    work.find((email) => email.primary) ??\n', '']],
      ['emails', ['    untyped.find((email) => email.primary) ??\n', '']],
      ['emails', ['(emails.length === 1 ? untyped[0] : undefined)', 'undefined']],
      ['refusals', ['  if (emails.filter((email) => email.primary).length > 1)', '  if (false)']],
      // Limits answered with the old organization wording.
      [
        'limits',
        [
          "'Invitation sending is limited right now. Retry later.'",
          "'Invitations for this organization are limited right now. Retry later.'",
        ],
      ],
    ]
    // Each mutant must fail an assertion of its verifier; anything else is a survivor.
    const survivors: string[] = []
    for (const [name, mutation] of mutants) {
      const mutant = await sourceCopy<typeof import('./scim-user-create.ts')>(
        './scim-user-create.ts',
        mutation,
      )
      serverErrors = 0
      const outcome = await verifiers[name](mutant.scimUserCreation).then(
        () => 'survived',
        (error: Error) =>
          error.name === 'AssertionError' ? 'killed' : `errored: ${error.message}`,
      )
      if (outcome !== 'killed') survivors.push(`${name}: ${mutation[1]} (${outcome})`)
    }
    expect(survivors).toEqual([])
  }, 600_000)

  // The production assembly, as startServer builds it, with the operator switch on.
  async function productionAnswers(organization: Team, options = productionAppOptions) {
    const config = loadConfig({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: signingSecret,
      PUBLIC_URL: publicUrl,
      SCIM_PROVISIONING_ENABLED: 'true',
    })
    const unreachable = async (): Promise<never> => {
      throw new Error('SCIM User creation must not reach this collaborator')
    }
    const application = createApp(
      options({
        config,
        db,
        auth: { handler: unreachable },
        resolveCaller: unreachable,
        resolveMcpOAuth: unreachable,
        checkDb: unreachable,
        waitlist: { verify: unreachable, remove: unreachable },
        invitationMailLimits: { secret: signingSecret },
        webhookSettings: { enabled: config.WEBHOOKS_ENABLED },
        webhookQueue: { enqueue: unreachable },
        notify: unreachable,
        notifyAttendeeNoShow: unreachable,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unreachable,
        enqueueCalendarWritebackRecovery: unreachable,
      }),
    )
    return call(
      application,
      organization.id,
      organization.secrets.first,
      'Users',
      'POST',
      // No work address, so the default first-user sign-up policy plays no part.
      user(`production-${unique()}`),
    )
  }

  it('stays unreachable without the flag, while disabled, and in the production assembly', async () => {
    const organization = await team()
    const state = await written(organization.id)
    const body = user(`off-${unique()}`, work(`off-${unique()}@example.com`))
    const answer = async (application: Application) =>
      call(application, organization.id, organization.secrets.first, 'Users', 'POST', body)
    expect(await answer(harness(undefined))).toMatchObject({ status: 404, body: unavailable })
    expect(await answer(harness(flagged(scimUserCreation, deps()), false))).toMatchObject({
      status: 404,
      body: errorBody(404, 'SCIM provisioning is disabled.'),
    })
    expect(await productionAnswers(organization)).toMatchObject({ status: 404, body: unavailable })
    // Controls: an unmutated copy of the assembly answers the same, and registered in
    // production, creation would answer.
    const control = await sourceCopy<typeof import('./server.ts')>('./server.ts')
    expect(await productionAnswers(organization, control.productionAppOptions)).toMatchObject({
      status: 404,
      body: unavailable,
    })
    expect(await written(organization.id)).toEqual(state)
    const mutant = await sourceCopy<typeof import('./server.ts')>(
      './server.ts',
      [
        "import { type AppDeps, createApp } from './app.ts'",
        "import { type AppDeps, createApp } from './app.ts'\nimport { scimUserCreation } from './scim-user-create.ts'",
      ],
      [
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED },',
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED, resources: scimUserCreation({ db, signup: config.signup }) },',
      ],
    )
    expect((await productionAnswers(organization, mutant.productionAppOptions)).status).toBe(201)
  })
})
