import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  type SignupPolicy,
  scimClaimCompletion,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { SCIM_ERROR_SCHEMA } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { scimUserCreation } from './scim-user-create.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUsers } from './scim-users.ts'
import { productionAppOptions } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const signingSecret = 'synthetic-scim-replacement-test-signing-secret'
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const { user: core, enterpriseUser: enterprise } = SCIM_URN

type Json = Record<string, unknown>
type App = ReturnType<typeof createApp>
type Organization = { id: string; tokenId: string; bearer: string; connectionId: string }

function profile(userName: string, values: Json = {}): Json {
  return { schemas: [core], userName, ...values }
}

function patchProfile(value: Json): Json {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', value }],
  }
}

async function expectError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/scim+json')
  const body = (await response.json()) as Json
  expect(body).toEqual({
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail: expect.any(String),
  })
  return body
}

describe.skipIf(!databaseUrl)('SCIM User profile replacement and PATCH', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let app: App

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_replace' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret: signingSecret,
      signup,
      mailer: { send: async () => {} },
      scimClaims: scimClaimCompletion,
    })
    const replace = scimUserReplacement(db)
    const create = scimUserCreation({ db, signup })
    const read = scimUsers(db)
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
      scim: {
        db,
        enabled: true,
        resources: (request) => replace(request) ?? create(request) ?? read(request),
      },
    })
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function token(organizationId: string) {
    const bearer = `scim_${randomBytes(32).toString('base64url')}`
    const { id: tokenId } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(bearer).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { tokenId, bearer }
  }

  async function team(): Promise<Organization> {
    const owner = await createTestUser(db, 'Directory test owner')
    const { id } = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const credential = await token(id)
    const { connection_id: connectionId } = await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', credential.tokenId)
      .executeTakeFirstOrThrow()
    return { id, ...credential, connectionId }
  }

  async function entry(organization: Organization, userName: string, displayName?: string) {
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: organization.id,
        connection_id: organization.connectionId,
        user_name: userName,
        display_name: displayName ?? null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  function send(
    organization: Organization,
    resource: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    body?: Json | string,
    headers: Record<string, string> = {},
    application = app,
  ) {
    return application.request(`${origin}/scim/v2/${organization.id}/${resource}`, {
      method,
      headers: {
        ...headers,
        authorization: `Bearer ${organization.bearer}`,
        'content-type': 'application/scim+json',
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  }
  const put = (organization: Organization, id: string, body: Json | string) =>
    send(organization, `Users/${id}`, 'PUT', body)
  const patch = (organization: Organization, id: string, value: Json) =>
    send(organization, `Users/${id}`, 'PATCH', patchProfile(value))

  const stored = (id: string) =>
    db.selectFrom('scim_users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  const updates = (id: string) =>
    db
      .selectFrom('audit_events')
      .select([
        'organization_id',
        'actor_type',
        'actor_id',
        'credential_type',
        'credential_id',
        'target_type',
        'target_id',
        'details',
      ])
      .where('target_id', '=', id)
      .where('action', '=', 'scim_user.updated')
      .orderBy('id')
      .execute()

  it('replaces an Okta-shaped profile, protects server fields and makes exact replay a no-op', async () => {
    const organization = await team()
    const id = await entry(organization, 'old-name')
    const manager = await entry(organization, 'manager', 'Real Manager')
    const old = await stored(id)
    await db
      .updateTable('scim_users')
      .set({
        formatted_name: 'Former Name',
        given_name: 'Former',
        family_name: 'Name',
        nick_name: 'Former Nickname',
        title: 'Former Title',
        user_type: 'Former Type',
        work_email: 'old@directory.example',
        locale: 'en-US',
        timezone: 'America/New_York',
        employee_number: 'old-number',
        cost_center: 'old-center',
        enterprise_organization: 'old-org',
        division: 'old-division',
        department: 'old-department',
      })
      .where('id', '=', id)
      .execute()
    const request = profile('new-name@directory.example', {
      schemas: [core, enterprise],
      id: randomUUID(),
      meta: {
        created: '2001-01-01T00:00:00Z',
        lastModified: '2001-01-01T00:00:00Z',
        location: 'https://elsewhere.example',
        version: 'idp-controlled',
      },
      groups: [{ value: randomUUID(), display: 'Administrators' }],
      password: 'synthetic-password-fixture',
      externalId: 'IdP-AB123',
      active: true,
      roles: [],
      entitlements: [],
      displayName: 'New Name',
      name: { givenName: 'New' },
      emails: [
        { value: 'unselected@directory.example', type: 'home' },
        { value: 'new@directory.example', type: 'work', primary: true },
      ],
      [enterprise]: {
        department: 'Scheduling',
        manager: { value: manager, displayName: 'Spoofed Name', $ref: 'https://elsewhere.example' },
      },
    })
    const result = await put(organization, id, request)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/scim+json')
    expect(result.headers.has('etag')).toBe(false)
    const body = (await result.json()) as { meta: Json }
    expect(body).toEqual({
      schemas: [core, enterprise],
      id,
      userName: 'new-name@directory.example',
      externalId: 'IdP-AB123',
      active: true,
      displayName: 'New Name',
      name: { givenName: 'New' },
      emails: [{ value: 'new@directory.example', type: 'work', primary: true }],
      [enterprise]: {
        department: 'Scheduling',
        manager: { value: manager, displayName: 'Real Manager' },
      },
      meta: {
        resourceType: 'User',
        created: old.created_at.toISOString(),
        lastModified: expect.any(String),
        location: `${origin}/scim/v2/${organization.id}/Users/${id}`,
      },
    })
    const current = await stored(id)
    expect(current.updated_at.getTime()).toBeGreaterThan(old.updated_at.getTime())
    expect(current).toMatchObject({
      organization_id: old.organization_id,
      connection_id: old.connection_id,
      created_at: old.created_at,
      linked_user_id: null,
      linked_member_id: null,
      formatted_name: null,
      family_name: null,
      nick_name: null,
      title: null,
      user_type: null,
      locale: null,
      timezone: null,
      employee_number: null,
      cost_center: null,
      enterprise_organization: null,
      division: null,
    })
    expect(await (await send(organization, `Users/${id}`, 'GET')).json()).toEqual(body)

    expect(await (await put(organization, id, request)).json()).toEqual(body)
    expect(await stored(id)).toEqual(current)
    expect(await updates(id)).toEqual([
      {
        organization_id: organization.id,
        actor_type: 'scim_token',
        actor_id: organization.tokenId,
        credential_type: 'none',
        credential_id: null,
        target_type: 'scim_user',
        target_id: id,
        details: {},
      },
    ])

    const cleared = await put(organization, id, profile('new-name@directory.example'))
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({
      schemas: [core],
      id,
      userName: 'new-name@directory.example',
      active: true,
      meta: { ...body.meta, lastModified: expect.any(String) },
    })
    expect(await updates(id)).toHaveLength(2)
  })

  it('refuses conditional, malformed, privileged and conflicting replacements atomically', async () => {
    const organization = await team()
    const id = await entry(organization, 'to-replace')
    const occupied = await entry(organization, 'Occupied')
    await db
      .updateTable('scim_users')
      .set({ external_id: 'Taken' })
      .where('id', '=', occupied)
      .execute()
    const before = await stored(id)
    for (const [header, value] of [
      ['If-Match', '*'],
      ['If-None-Match', '"idp-version"'],
      ['If-Unmodified-Since', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ] as const)
      await expectError(
        await send(organization, `Users/${id}`, 'PUT', profile('otherwise-valid'), {
          [header]: value,
        }),
        412,
      )
    for (const [payload, status, code] of [
      ['{', 400, 'invalidSyntax'],
      [{ schemas: [core] }, 400, 'invalidValue'],
      [profile('x', { active: 'false' }), 400, 'invalidValue'],
      [profile('x', { roles: [{ value: 'owner' }] }), 403, 'mutability'],
      [profile('x', { entitlements: [{ value: 'admin' }] }), 403, 'mutability'],
      [profile('x', { 'name.givenName': 'bypass' }), 400, 'invalidValue'],
      [profile('x', { displayName: 'x'.repeat(65_536) }), 413, undefined],
      [profile(' occupied '), 409, 'uniqueness'],
      [profile('x', { externalId: 'Taken' }), 409, 'uniqueness'],
    ] as const)
      await expectError(await put(organization, id, payload), status, code)
    const unsupported = await expectError(
      await put(organization, id, profile('synthetic-login', { unknownPersonalField: 'fixture' })),
      400,
      'invalidValue',
    )
    expect(
      await expectError(
        await put(organization, id, profile('other-login', { differentUnknownField: 'other' })),
        400,
        'invalidValue',
      ),
    ).toEqual(unsupported)
    expect(await stored(id)).toEqual(before)
    expect(await updates(id)).toEqual([])

    await db.updateTable('scim_users').set({ active: false }).where('id', '=', id).execute()
    const inactive = await put(organization, id, profile('still-inactive', { active: false }))
    expect(inactive.status).toBe(200)
    expect(await inactive.json()).toMatchObject({ active: false, userName: 'still-inactive' })
    const reactivated = await put(organization, id, profile('active', { active: true }))
    expect(reactivated.status).toBe(200)
    expect(await reactivated.json()).toMatchObject({ active: true, userName: 'active' })
  })

  it('uses the same not-found for unknown, retired, intrinsic and foreign IDs', async () => {
    const organization = await team()
    const other = await team()
    const foreign = await entry(other, 'foreign')
    const retired = await entry(organization, 'retired')
    await db
      .updateTable('scim_users')
      .set({ active: false, retired_at: new Date() })
      .where('id', '=', retired)
      .execute()
    const member = await db
      .selectFrom('auth.member')
      .select(['id', 'userId'])
      .where('organizationId', '=', organization.id)
      .executeTakeFirstOrThrow()
    const absent = await expectError(await put(organization, randomUUID(), profile('x')), 404)
    for (const target of [
      foreign,
      retired,
      member.id,
      member.userId,
      foreign.toUpperCase(),
      'unknown',
    ])
      expect(await expectError(await put(organization, target, profile('x')), 404)).toEqual(absent)
    await expectError(
      await put({ ...other, bearer: organization.bearer }, foreign, profile('x')),
      401,
    )
    expect((await stored(foreign)).user_name).toBe('foreign')
    expect((await stored(retired)).user_name).toBe('retired')
    expect(await updates(foreign)).toEqual([])
  })

  async function provision(organization: Organization, email: string) {
    const response = await send(
      organization,
      'Users',
      'POST',
      profile(email, { emails: [{ type: 'work', value: email }], displayName: 'Managed display' }),
    )
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    const claim = await db
      .selectFrom('scim_user_claims')
      .selectAll()
      .where('scim_user_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(claim.invitation_id).toEqual(expect.any(String))
    return { id, claim, invitationId: claim.invitation_id as string }
  }

  const claimById = (id: string) =>
    db.selectFrom('scim_user_claims').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('keeps the original pending claim on a case-only work address change', async () => {
    const organization = await team()
    const mailbox = 'case-test@directory.example'
    const { id, claim } = await provision(organization, mailbox)
    const replacement = await put(
      organization,
      id,
      profile(mailbox, { emails: [{ type: 'work', value: mailbox.toUpperCase() }] }),
    )
    expect(replacement.status).toBe(200)
    expect(await stored(id)).toMatchObject({ work_email: mailbox.toUpperCase() })
    expect(await claimById(claim.id)).toEqual(claim)
    expect(await updates(id)).toHaveLength(1)
  })

  async function cookieFor(userId: string) {
    const sessionToken = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', signingSecret).update(sessionToken).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`
  }

  const accept = (cookie: string, invitationId: string) =>
    app.request(`${origin}/api/auth/organization/accept-invitation`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId }),
    })

  async function waitForBlockedRequests(pid: number, count: number) {
    await vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ n: number }>(
          `WITH RECURSIVE waiting(pid) AS (
           VALUES ($1::int)
           UNION
           SELECT activity.pid FROM pg_stat_activity AS activity JOIN waiting
             ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
           WHERE activity.datname = current_database()
         ) SELECT count(*)::int - 1 AS n FROM waiting`,
          [pid],
        )
        expect(rows[0]?.n).toBeGreaterThanOrEqual(count)
      },
      { timeout: 5_000, interval: 15 },
    )
  }

  // Hold the target's row until the first request has acquired the organization lock and
  // the second is queued behind it. PostgreSQL's observed waits determine the ordering.
  async function ordered(
    id: string,
    first: () => Response | Promise<Response>,
    second: () => Response | Promise<Response>,
  ) {
    const hold = await owned.pool.connect()
    const pending: Promise<Response>[] = []
    try {
      await hold.query('BEGIN')
      const { rows } = await hold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = rows[0]?.pid as number
      await hold.query('SELECT id FROM scim_users WHERE id = $1 FOR UPDATE', [id])
      pending.push(Promise.resolve(first()))
      await waitForBlockedRequests(pid, 1)
      pending.push(Promise.resolve(second()))
      await waitForBlockedRequests(pid, 2)
    } finally {
      try {
        await hold.query('ROLLBACK')
      } finally {
        hold.release()
        await Promise.allSettled(pending)
      }
    }
    const [one, two] = await Promise.all(pending)
    if (one === undefined || two === undefined) throw new Error('Both requests must finish')
    return [one, two] as const
  }

  it('serializes two replacements and returns each committed profile', async () => {
    const organization = await team()
    const id = await entry(organization, 'before-race')
    const [first, second] = await ordered(
      id,
      () => put(organization, id, profile('first', { displayName: 'First' })),
      () => put(organization, id, profile('second', { title: 'Second' })),
    )
    expect([first.status, second.status]).toEqual([200, 200])
    expect(await first.json()).toMatchObject({ userName: 'first', displayName: 'First' })
    const last = await second.json()
    expect(last).toMatchObject({ userName: 'second', title: 'Second' })
    expect(last).not.toHaveProperty('displayName')
    expect(await stored(id)).toMatchObject({
      user_name: 'second',
      title: 'Second',
      display_name: null,
    })
    expect(await updates(id)).toHaveLength(2)
  }, 15_000)

  it.each(['PUT', 'PATCH'] as const)(
    'normalizes a concurrent PATCH against the locked profile when %s commits first',
    async (first) => {
      const organization = await team()
      const id = await entry(organization, 'before-race', 'Before')
      const replace = () => put(organization, id, profile('after-put', { title: 'PUT title' }))
      const update = () => patch(organization, id, { displayName: 'PATCH display' })
      const [one, two] =
        first === 'PUT' ? await ordered(id, replace, update) : await ordered(id, update, replace)
      expect([one.status, two.status]).toEqual([200, 200])
      const replacement = await (first === 'PUT' ? one : two).json()
      const patched = await (first === 'PUT' ? two : one).json()
      expect(replacement).toMatchObject({ userName: 'after-put', title: 'PUT title' })
      expect(replacement).not.toHaveProperty('displayName')
      expect(patched).toMatchObject({ displayName: 'PATCH display' })
      if (first === 'PUT') {
        expect(patched).toMatchObject({ userName: 'after-put', title: 'PUT title' })
      } else {
        expect(patched).toMatchObject({ userName: 'before-race' })
        expect(patched).not.toHaveProperty('title')
      }
      expect(await stored(id)).toMatchObject({
        user_name: 'after-put',
        title: 'PUT title',
        display_name: first === 'PUT' ? 'PATCH display' : null,
      })
      expect(await updates(id)).toHaveLength(2)
    },
    15_000,
  )

  it.each([
    ['PUT', 'profile write'],
    ['PUT', 'claim'],
    ['PATCH', 'profile write'],
    ['PATCH', 'claim'],
  ] as const)(
    'preserves admission and personal identity in a %s race when %s commits first',
    async (method, first) => {
      const organization = await team()
      const oldOwner = await createTestUser(db, 'Personal name')
      const otherOwner = await createTestUser(db, 'Different personal name')
      const { id, claim, invitationId } = await provision(organization, oldOwner.email)
      const cookie = await cookieFor(oldOwner.id)
      const users = () =>
        db
          .selectFrom('auth.user')
          .selectAll()
          .where('id', 'in', [oldOwner.id, otherOwner.id])
          .orderBy('id')
          .execute()
      const before = await users()
      const values = {
        displayName: 'Updated managed display',
        emails: [{ value: otherOwner.email, type: 'work', primary: true }],
      }
      const replaceProfile = () =>
        method === 'PUT'
          ? put(organization, id, profile('provider-login', values))
          : patch(organization, id, { userName: 'provider-login', ...values })
      const acceptClaim = () => accept(cookie, invitationId)
      const [one, two] =
        first === 'profile write'
          ? await ordered(id, replaceProfile, acceptClaim)
          : await ordered(id, acceptClaim, replaceProfile)
      expect([one.status, two.status]).toEqual([200, 200])
      expect(await users()).toEqual(before)

      const members = await db
        .selectFrom('auth.member')
        .select(['id', 'role', 'userId'])
        .where('organizationId', '=', organization.id)
        .where('userId', 'in', [oldOwner.id, otherOwner.id])
        .execute()
      const [member] = members
      expect(members).toEqual([{ id: expect.any(String), role: 'member', userId: oldOwner.id }])
      const invitations = await db
        .selectFrom('auth.invitation')
        .select(['id', 'status', 'email'])
        .where('organizationId', '=', organization.id)
        .execute()
      expect(invitations).toEqual([{ id: invitationId, status: 'accepted', email: oldOwner.email }])
      const linked = first === 'claim'
      expect(await stored(id)).toMatchObject({
        user_name: 'provider-login',
        display_name: 'Updated managed display',
        work_email: otherOwner.email,
        linked_user_id: linked ? oldOwner.id : null,
        linked_member_id: linked ? member?.id : null,
      })
      expect(await claimById(claim.id)).toEqual({
        ...claim,
        completed_at: linked ? expect.any(Date) : null,
        invalidated_at: linked ? null : expect.any(Date),
      })
      expect(
        await db
          .selectFrom('scim_user_claims')
          .select('id')
          .where('scim_user_id', '=', id)
          .execute(),
      ).toEqual([{ id: claim.id }])
      expect(await updates(id)).toHaveLength(1)
    },
    15_000,
  )

  it.each(['PUT', 'PATCH'] as const)(
    'rolls back the %s profile and pending claim when the audit writer fails',
    async (method) => {
      const organization = await team()
      const { id, claim } = await provision(organization, 'pending@directory.example')
      const before = await stored(id)
      await sql`CREATE FUNCTION test_refuse_scim_replace_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_user.updated' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
      await sql`CREATE TRIGGER test_refuse_scim_replace_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_scim_replace_audit()`.execute(db)
      try {
        const answer =
          method === 'PUT'
            ? await put(organization, id, profile('would-change'))
            : await patch(organization, id, { userName: 'would-change', emails: [] })
        expect(await expectError(answer, 500)).toMatchObject({
          detail: 'SCIM request could not be processed.',
        })
        expect(await stored(id)).toEqual(before)
        expect(await claimById(claim.id)).toEqual(claim)
        expect(await updates(id)).toEqual([])
      } finally {
        await sql`DROP TRIGGER test_refuse_scim_replace_audit ON audit_events`.execute(db)
        await sql`DROP FUNCTION test_refuse_scim_replace_audit()`.execute(db)
      }
    },
  )

  it('leaves production Users, Groups and discovery unregistered with token provisioning on', async () => {
    const organization = await team()
    const id = await entry(organization, 'production-control')
    const unreachable = async (): Promise<never> => {
      throw new Error('SCIM must not call this collaborator')
    }
    const application = createApp(
      productionAppOptions({
        config: loadConfig({
          DATABASE_URL: owned.url,
          BETTER_AUTH_SECRET: signingSecret,
          PUBLIC_URL: origin,
          SCIM_PROVISIONING_ENABLED: 'true',
        }),
        db,
        auth: { handler: unreachable },
        resolveCaller: unreachable,
        resolveMcpOAuth: unreachable,
        checkDb: unreachable,
        waitlist: { verify: unreachable, remove: unreachable },
        invitationMailLimits: { secret: signingSecret },
        webhookSettings: { enabled: false },
        webhookQueue: { enqueue: unreachable },
        notify: unreachable,
        notifyAttendeeNoShow: unreachable,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unreachable,
        enqueueCalendarWritebackRecovery: unreachable,
        mailboxProofQueue: { enqueue: unreachable },
      }),
    )
    const unavailable = await expectError(
      await send(organization, `Users/${id}`, 'PUT', profile('would-change'), {}, application),
      404,
    )
    expect(unavailable.detail).toBe('SCIM resources are not available yet.')
    expect(
      await expectError(
        await send(
          organization,
          `Users/${id}`,
          'PATCH',
          patchProfile({ userName: 'would-change' }),
          {},
          application,
        ),
        404,
      ),
    ).toEqual(unavailable)
    for (const resource of [
      'Users',
      `Users/${id}`,
      'Groups',
      'ServiceProviderConfig',
      'ResourceTypes',
      'Schemas',
    ])
      expect(
        await expectError(
          await send(organization, resource, 'GET', undefined, {}, application),
          404,
        ),
      ).toEqual(unavailable)
    expect((await stored(id)).user_name).toBe('production-control')
    expect(await updates(id)).toEqual([])
  })

  // Keep this last: disabling one-per-organization changes the test database's token trigger.
  it('scopes target IDs, manager IDs and identifiers to the exact token connection', async () => {
    const a = await team()
    const credential = await token(a.id)
    await db.schema
      .alterTable('scim_connections')
      .dropConstraint('scim_connections_one_per_organization')
      .execute()
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: a.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('scim_token_connections')
      .set({ connection_id: connectionId })
      .where('token_id', '=', credential.tokenId)
      .execute()
    const b = { id: a.id, ...credential, connectionId }
    const subject = await entry(a, 'first')
    const manager = await entry(b, 'second')
    const unknown = await expectError(await put(a, randomUUID(), profile('irrelevant')), 404)
    expect(await expectError(await put(a, manager, profile('forbidden')), 404)).toEqual(unknown)
    expect(await expectError(await put(b, subject, profile('forbidden')), 404)).toEqual(unknown)

    const withManager = (value: string) =>
      profile('second', {
        schemas: [core, enterprise],
        [enterprise]: { manager: { value } },
      })
    const absentManager = await expectError(
      await put(a, subject, withManager(randomUUID())),
      400,
      'invalidValue',
    )
    expect(
      await expectError(await put(a, subject, withManager(manager)), 400, 'invalidValue'),
    ).toEqual(absentManager)
    const replacement = await put(a, subject, profile('second'))
    expect(replacement.status).toBe(200)
    expect(await stored(subject)).toMatchObject({
      user_name: 'second',
      connection_id: a.connectionId,
    })
    expect(await stored(manager)).toMatchObject({
      user_name: 'second',
      connection_id: connectionId,
    })
  })
})
