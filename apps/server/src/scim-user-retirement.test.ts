import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { SCIM_ERROR_SCHEMA } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { scimUserCreation } from './scim-user-create.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUserRetirement } from './scim-user-retirement.ts'
import { scimUsers } from './scim-users.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const clientId = 'https://connector.example.test/client.json'

async function expectScimError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/scim+json')
  const body: unknown = await response.json()
  expect(body).toEqual({
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail: expect.any(String),
    ...(scimType ? { scimType } : {}),
  })
  return body
}

describe.skipIf(!databaseUrl)('SCIM User retirement', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_retire' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('The test uses synthetic sessions') },
    })
    const create = scimUserCreation({ db, signup })
    const replace = scimUserReplacement(db)
    const retire = scimUserRetirement(db)
    const read = scimUsers(db)
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      scim: {
        db,
        enabled: true,
        resources: (request) =>
          retire(request) ?? replace(request) ?? create(request) ?? read(request),
      },
    })
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://connector.example.test/callback']),
      })
      .execute()
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture(role = 'member', active = true) {
    const owner = await createTestUser(db, 'Team owner')
    const person = await createTestUser(db, 'Linked member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: person, role },
    ])
    const membership = await db
      .selectFrom('auth.member')
      .selectAll()
      .where('organizationId', '=', team.id)
      .where('userId', '=', person.id)
      .executeTakeFirstOrThrow()
    const bearer = `scim_${randomBytes(32).toString('base64url')}`
    const { id: tokenId } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: team.id,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(bearer).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { connection_id } = await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', tokenId)
      .executeTakeFirstOrThrow()
    const externalId = randomUUID()
    const userName = person.email
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: team.id,
        connection_id,
        linked_user_id: person.id,
        linked_member_id: membership.id,
        user_name: userName,
        external_id: externalId,
        work_email: person.email,
        active,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const profile = { schemas: [SCIM_URN.user], userName, externalId }
    const send = (
      method: string,
      path = `/Users/${id}`,
      body?: Record<string, unknown>,
      headers?: Record<string, string>,
    ) =>
      app.request(`${publicUrl}/scim/v2/${team.id}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/scim+json',
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    return { owner, person, team, membership, id, tokenId, profile, send }
  }

  const entry = (id: string) =>
    db.selectFrom('scim_users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const blocks = (id: string) =>
    db.selectFrom('scim_membership_blocks').selectAll().where('scim_user_id', '=', id).execute()
  const audits = (id: string) =>
    db.selectFrom('audit_events').selectAll().where('target_id', '=', id).orderBy('id').execute()

  async function browser(userId: string, organizationId: string) {
    const session = await db
      .transaction()
      .execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          { userId, organizationId, now: new Date().toISOString(), headers: new Headers() },
        ),
      )
    return { id: session.id, cookie: session.cookie.split(';')[0] as string }
  }

  async function issueKey(userId: string, organizationId: string) {
    return auth.api.createApiKey({
      body: { userId, metadata: { organizationId, scope: 'bookings' } },
    })
  }

  async function issueGrant(userId: string, organizationId: string) {
    const { id } = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: userId, organization_id: organizationId, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId,
        referenceId: id,
        scopes: JSON.stringify(['mcp:access']),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    return id
  }

  const keyAccess = (key: string) =>
    app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })
  const sessionIds = (userId: string) =>
    db.selectFrom('auth.session').select('id').where('userId', '=', userId).execute()
  const keyIds = (userId: string) =>
    db.selectFrom('auth.apikey').select('id').where('referenceId', '=', userId).execute()
  const grantIds = (userId: string) =>
    db.selectFrom('mcp_oauth_grants').select('id').where('user_id', '=', userId).execute()
  const consentRefs = (userId: string) =>
    db.selectFrom('auth.oauthConsent').select('referenceId').where('userId', '=', userId).execute()

  it('retires the old ID, preserves history and requires fresh admission when identifiers are reused', async () => {
    const f = await fixture()
    const personal = f.person.principal.organization.id
    const session = await browser(f.person.id, f.team.id)
    const personalSession = await browser(f.person.id, personal)
    const key = await issueKey(f.person.id, f.team.id)
    const personalKey = await issueKey(f.person.id, personal)
    const grantId = await issueGrant(f.person.id, f.team.id)
    const personalGrantId = await issueGrant(f.person.id, personal)
    expect(await sessionIds(f.person.id)).toContainEqual({ id: session.id })
    expect(await grantIds(f.person.id)).toContainEqual({ id: grantId })
    expect((await keyAccess(key.key)).status).toBe(200)

    const fixtures = createFixtures(db)
    const authoredId = await fixtures.eventType(personal, f.person.id, { title: 'Authored event' })
    const start = Temporal.Now.instant().subtract({ hours: 48 })
    const bookingId = await fixtures.booking(
      f.team.id,
      [f.person.id],
      start.toString(),
      start.add({ minutes: 30 }).toString(),
    )
    await db.transaction().execute((trx) =>
      writeAuditEvent(trx, {
        organizationId: f.team.id,
        actor: { type: 'user', id: f.person.id },
        credential: { type: 'none' },
        action: 'booking.created',
        targetType: 'booking',
        targetId: bookingId,
      }),
    )
    const booking = () =>
      db.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirstOrThrow()
    const authored = () =>
      db
        .selectFrom('event_types')
        .selectAll()
        .where('id', '=', authoredId)
        .executeTakeFirstOrThrow()
    const history = [await booking(), await authored(), await audits(bookingId)]
    const original = await entry(f.id)

    const deletion = await f.send('DELETE')
    expect(deletion.status).toBe(204)
    expect(await deletion.text()).toBe('')
    const retired = await entry(f.id)
    expect(retired).toEqual({
      ...original,
      active: false,
      retired_at: expect.any(Date),
      updated_at: expect.any(Date),
    })
    expect(await blocks(f.id)).toEqual([
      expect.objectContaining({
        user_id: f.person.id,
        source: 'scim',
        kind: 'suspension',
        cleared_at: null,
      }),
    ])
    expect(await audits(f.id)).toEqual([
      expect.objectContaining({ action: 'scim_user.credentials_revoked' }),
      expect.objectContaining({
        action: 'scim_user.retired',
        organization_id: f.team.id,
        actor_type: 'scim_token',
        actor_id: f.tokenId,
        target_type: 'scim_user',
        details: {},
      }),
    ])

    const notFound = await expectScimError(await f.send('GET', `/Users/${randomUUID()}`), 404)
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', f.profile],
      [
        'PATCH',
        {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        },
      ],
      ['DELETE', undefined],
    ] as const) {
      expect(await expectScimError(await f.send(method, `/Users/${f.id}`, body), 404)).toEqual(
        notFound,
      )
    }
    expect(await expectScimError(await f.send('GET', `/Users/${f.id}?attributes=(`), 404)).toEqual(
      notFound,
    )
    expect(await expectScimError(await f.send('PUT', undefined, {}), 404)).toEqual(notFound)
    expect(await expectScimError(await f.send('PATCH'), 404)).toEqual(notFound)
    expect(
      await expectScimError(await f.send('DELETE', undefined, undefined, { 'if-match': '*' }), 404),
    ).toEqual(notFound)

    const recreated = await f.send('POST', '/Users', {
      ...f.profile,
      id: f.id,
      emails: [{ type: 'work', value: f.person.email }],
    })
    expect(recreated.status).toBe(201)
    const { id: newId } = (await recreated.json()) as { id: string }
    expect(newId).not.toBe(f.id)
    expect(await entry(newId)).toMatchObject({
      active: true,
      linked_user_id: null,
      linked_member_id: null,
      retired_at: null,
      user_name: f.profile.userName,
      external_id: f.profile.externalId,
    })
    expect(
      await db
        .selectFrom('scim_user_claims')
        .selectAll()
        .where('scim_user_id', '=', newId)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        completed_at: null,
        invalidated_at: null,
        invitation_id: null,
        work_email: f.person.email,
      }),
    ])
    expect(await entry(f.id)).toEqual(retired)
    expect(await blocks(f.id)).toEqual([expect.objectContaining({ cleared_at: null })])
    expect(await sessionIds(f.person.id)).toEqual([{ id: personalSession.id }])
    expect(await keyIds(f.person.id)).toEqual([{ id: personalKey.id }])
    expect(await grantIds(f.person.id)).toEqual([{ id: personalGrantId }])
    expect(await consentRefs(f.person.id)).toEqual([{ referenceId: personalGrantId }])
    expect((await keyAccess(key.key)).status).toBe(401)
    expect((await keyAccess(personalKey.key)).status).toBe(200)
    expect(
      await db
        .selectFrom('auth.member')
        .selectAll()
        .where('id', '=', f.membership.id)
        .executeTakeFirst(),
    ).toEqual(f.membership)
    expect([await booking(), await authored(), await audits(bookingId)]).toEqual(history)
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', bookingId)
        .execute(),
    ).toEqual([{ user_id: f.person.id }])
  })

  it('retires an already suspended User and retains its original blocker', async () => {
    const f = await fixture()
    expect((await f.send('PUT', undefined, { ...f.profile, active: false })).status).toBe(200)
    const suspension = await blocks(f.id)
    expect(suspension).toEqual([expect.objectContaining({ cleared_at: null })])

    expect((await f.send('DELETE')).status).toBe(204)
    expect(await blocks(f.id)).toEqual(suspension)
    expect((await entry(f.id)).retired_at).toEqual(expect.any(Date))
  })

  it('accepts a profile update echoing active true after local member removal', async () => {
    const f = await fixture()
    const ownerSession = await browser(f.owner.id, f.team.id)
    const removal = await app.request(`${publicUrl}/api/auth/organization/remove-member`, {
      method: 'POST',
      headers: {
        origin: publicUrl,
        cookie: ownerSession.cookie,
        'content-type': 'application/json',
        'x-expected-organization-id': f.team.id,
      },
      body: JSON.stringify({ organizationId: f.team.id, memberIdOrEmail: f.membership.id }),
    })
    expect(removal.status).toBe(200)
    const afterRemoval = await entry(f.id)
    expect(afterRemoval).toMatchObject({ active: true, linked_member_id: null })

    const profile = { ...f.profile, active: true, displayName: 'Updated after local removal' }
    const echo = await f.send('PUT', undefined, profile)
    expect(echo.status).toBe(200)
    expect(await echo.json()).toMatchObject({ active: true, displayName: profile.displayName })
    expect(await entry(f.id)).toMatchObject({
      active: true,
      linked_member_id: null,
      display_name: profile.displayName,
    })
  })

  it.each([
    ['owner', true],
    ['admin', false],
    ['member, admin', true],
  ] as const)('refuses retirement of %s (active=%s)', async (role, active) => {
    const f = await fixture(role, active)
    if (role === 'member, admin') {
      // The original member row was removed and the account was readmitted separately.
      await db.deleteFrom('auth.member').where('id', '=', f.membership.id).execute()
      await db
        .insertInto('auth.member')
        .values({ ...f.membership, id: randomUUID() })
        .execute()
    }
    const before = await entry(f.id)
    await expectScimError(await f.send('DELETE', undefined, undefined, { 'If-Match': '*' }), 412)
    await expectScimError(await f.send('DELETE'), 403, 'mutability')
    expect(await entry(f.id)).toEqual(before)
    expect(await blocks(f.id)).toEqual([])
    expect(await audits(f.id)).toEqual([])
  })

  it('does not distinguish a foreign User ID from an unknown User ID', async () => {
    const f = await fixture()
    const other = await fixture()
    const before = await entry(other.id)
    const unknown = await expectScimError(await f.send('DELETE', `/Users/${randomUUID()}`), 404)
    expect(await expectScimError(await f.send('DELETE', `/Users/${other.id}`), 404)).toEqual(
      unknown,
    )
    expect(await entry(other.id)).toEqual(before)
    expect(await audits(other.id)).toEqual([])
  })

  it('rolls back retirement and credential revocation when the retirement audit is refused', async () => {
    const f = await fixture()
    const before = await entry(f.id)
    const session = await browser(f.person.id, f.team.id)
    const key = await issueKey(f.person.id, f.team.id)
    const grantId = await issueGrant(f.person.id, f.team.id)
    await sql`CREATE FUNCTION refuse_retirement_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected retirement audit failure'; END $$`.execute(db)
    try {
      await sql`CREATE TRIGGER refuse_retirement_audit BEFORE INSERT ON audit_events
        FOR EACH ROW WHEN (NEW.action = 'scim_user.retired') EXECUTE FUNCTION refuse_retirement_audit()`.execute(
        db,
      )
      await expectScimError(await f.send('DELETE'), 500)
      expect(await entry(f.id)).toEqual(before)
      expect(await blocks(f.id)).toEqual([])
      expect(await audits(f.id)).toEqual([])
      expect(await sessionIds(f.person.id)).toEqual([{ id: session.id }])
      expect(await keyIds(f.person.id)).toEqual([{ id: key.id }])
      expect(await grantIds(f.person.id)).toEqual([{ id: grantId }])
      expect(await consentRefs(f.person.id)).toEqual([{ referenceId: grantId }])
    } finally {
      await sql`DROP TRIGGER IF EXISTS refuse_retirement_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION refuse_retirement_audit()`.execute(db)
    }
  })

  it.each([
    ['member', 'admin', 403],
    ['admin', 'member', 204],
  ] as const)(
    'serializes retirement with a native %s to %s role change',
    async (from, to, status) => {
      const f = await fixture(from)
      const ownerSession = await browser(f.owner.id, f.team.id)
      const stalled = await owned.pool.connect()
      let local: Promise<Response> | undefined
      let remote: Promise<Response> | undefined
      try {
        await stalled.query('BEGIN')
        const blocker = await stalled.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        // Let the native route lock the organization but block its target member update.
        await stalled.query('SELECT id FROM auth.member WHERE id=$1 FOR UPDATE', [f.membership.id])
        local = Promise.resolve(
          app.request(`${publicUrl}/api/auth/organization/update-member-role`, {
            method: 'POST',
            headers: {
              origin: publicUrl,
              cookie: ownerSession.cookie,
              'content-type': 'application/json',
              'x-expected-organization-id': f.team.id,
            },
            body: JSON.stringify({
              organizationId: f.team.id,
              memberId: f.membership.id,
              role: to,
            }),
          }),
        )
        const nativePid = await vi.waitFor(
          async () => {
            const waiting = await owned.pool.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
           AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%"auth"."member"%'`,
              [blocker.rows[0]?.pid],
            )
            expect(waiting.rows).toHaveLength(1)
            return waiting.rows[0]?.pid as number
          },
          { timeout: 3000, interval: 20 },
        )
        remote = Promise.resolve(f.send('DELETE'))
        await vi.waitFor(
          async () => {
            const waiting = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database()
           AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%"auth"."organization"%for update%') AS blocked`,
              [nativePid],
            )
            expect(waiting.rows[0]?.blocked).toBe(true)
          },
          { timeout: 3000, interval: 20 },
        )
      } finally {
        try {
          await stalled.query('ROLLBACK')
        } finally {
          stalled.release()
          await Promise.allSettled([local, remote])
        }
      }
      expect((await local)?.status).toBe(200)
      const response = await remote
      if (!response) throw new Error('Expected the SCIM request')
      expect(response.status).toBe(status)
      if (status === 403) await expectScimError(response, 403, 'mutability')
      expect((await entry(f.id)).retired_at).toEqual(status === 204 ? expect.any(Date) : null)
      expect(await blocks(f.id)).toHaveLength(status === 204 ? 1 : 0)
    },
  )
})
