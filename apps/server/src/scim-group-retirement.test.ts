import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { scimDiscoveryWithGroups } from './scim-discovery.ts'
import { scimGroupRetirement } from './scim-group-retirement.ts'
import { scimGroups } from './scim-groups.ts'
import type { ScimMappingNoticeQueue } from './scim-team-mapping-notices.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUserRetirement } from './scim-user-retirement.ts'
import { OidcAttemptRefused } from './sso-oidc-attempt.ts'
import { lockOidcLinkActor } from './sso-oidc-link.ts'
import { ssoRecoveryTeamOwners } from './sso-recovery-enrollment.ts'
import { bookingWriteAccess } from './team-management.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://scim-group-retirement.example.test'
const signingSecret = 'synthetic-scim-group-retire-signing-secret-00'
const signup = { mode: 'open', allowedDomains: [] } as const
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

type Token = { id: string; organizationId: string; connectionId: string; secret: string }
type Group = { id: string; displayName: string; members?: { value: string }[] }
type Notice = { organizationId: string; userId: string; mappingId: string; action: string }

const base = (organizationId: string) => `${publicUrl}/scim/v2/${organizationId}`
const patchBody = (...operations: object[]) => ({ schemas: [PATCH], Operations: operations })
const values = (...ids: string[]) => ids.map((value) => ({ value }))

async function expectError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/scim+json')
  expect(await response.json()).toEqual({
    schemas: [ERROR],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail: expect.any(String),
  })
}

describe.skipIf(!databaseUrl)('SCIM Group retirement', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>
  let withoutRetirement: ReturnType<typeof createApp>
  const noticed: Notice[] = []
  let refuseNotices = false
  const notices: ScimMappingNoticeQueue = {
    enqueue: async (_name, notice, options) => {
      // The notice joins the retirement transaction or the retirement does not commit.
      expect(options.transaction).toBeTruthy()
      if (refuseNotices) return null
      noticed.push(notice)
      return 'synthetic-job'
    },
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_retire' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret: signingSecret,
      signup,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('Group retirement must not send mail') },
    })
    const groups = scimGroups(db)
    const retireGroup = scimGroupRetirement(db, notices)
    const replace = scimUserReplacement(db)
    const retireUser = scimUserRetirement(db)
    const shared = {
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, scimResourcesEnabled: true }),
    }
    app = createApp({
      ...shared,
      scim: {
        db,
        enabled: true,
        resources: (request) =>
          scimDiscoveryWithGroups(request) ??
          retireGroup(request) ??
          groups(request) ??
          retireUser(request) ??
          replace(request),
      },
    })
    // The earlier Group harness: every Group handler except retirement.
    withoutRetirement = createApp({
      ...shared,
      scim: {
        db,
        enabled: true,
        resources: (request) => scimDiscoveryWithGroups(request) ?? groups(request),
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

  function call(token: Token, path: string, method = 'GET', body?: object, headers = {}) {
    return app.request(`${base(token.organizationId)}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/scim+json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function team(name: string, members: TestUser[] = []) {
    const owner = await createTestUser(db, 'Fixture team owner')
    const { id } = await createTestTeam(
      db,
      [{ user: owner, role: 'owner' }, ...members.map((user) => ({ user, role: 'member' }))],
      name,
    )
    return { id, owner }
  }

  async function issue(organizationId: string): Promise<Token> {
    const secret = `scim_${randomBytes(32).toString('base64url')}`
    const { id } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic IdP',
        token_hash: createHash('sha256').update(secret).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { connection_id: connectionId } = await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', id)
      .executeTakeFirstOrThrow()
    return { id, organizationId, connectionId, secret }
  }

  const member = (teamId: string, user: TestUser) =>
    db
      .selectFrom('auth.member')
      .select(['id', 'role'])
      .where('organizationId', '=', teamId)
      .where('userId', '=', user.id)
      .executeTakeFirst()

  async function linkedUser(token: Token, user: TestUser, linked = true) {
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: token.organizationId,
        connection_id: token.connectionId,
        user_name: user.email,
        display_name: user.name,
        linked_user_id: linked ? user.id : null,
        linked_member_id: linked ? ((await member(token.organizationId, user))?.id ?? null) : null,
        active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  const reserve = (token: Token, childId: string, externalId: string) =>
    db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: token.organizationId,
        connection_id: token.connectionId,
        child_organization_id: childId,
        external_id: externalId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

  async function activate(token: Token, manual: TestUser[] = [], initial: string[] = []) {
    const child = await team('Retirement child', manual)
    const externalId = randomUUID()
    const { id: mappingId } = await reserve(token, child.id, externalId)
    const response = await call(token, 'Groups', 'POST', {
      schemas: [GROUP],
      externalId,
      displayName: 'Directory name',
      members: values(...initial),
    })
    expect(response.status).toBe(201)
    const group = (await response.json()) as Group
    const path = `Groups/${group.id}`
    const patch = (...operations: object[]) => call(token, path, 'PATCH', patchBody(...operations))
    return { child, externalId, mappingId, group, path, patch }
  }

  /** A parent with linked ordinary members, all on the roster of one activated Group. */
  async function directory(count: number, manual: TestUser[] = []) {
    const people = await Promise.all(
      Array.from({ length: count }, (_, index) => createTestUser(db, `Directory member ${index}`)),
    )
    const parent = await team('Retirement parent', people)
    const token = await issue(parent.id)
    const ids: string[] = []
    for (const person of people) ids.push(await linkedUser(token, person))
    const group = await activate(token, manual, ids)
    return { parent, token, people, ids, ...group }
  }

  const managed = (childId: string) =>
    db
      .selectFrom('scim_team_managed_memberships')
      .select(['user_id', 'scim_user_id', 'suspended_at'])
      .where('child_organization_id', '=', childId)
      .orderBy('scim_user_id')
      .execute()
  const childMembers = (childId: string) =>
    db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', childId)
      .orderBy('userId')
      .execute()
  const mapping = (id: string) =>
    db
      .selectFrom('scim_team_mappings')
      .select(['retired_at', 'live_child_organization_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const journal = (organizationId: string, targets: string[]) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'actor_type', 'actor_id', 'target_type', 'target_id', 'details'])
      .where('organization_id', '=', organizationId)
      .where('target_id', 'in', targets)
      .where('action', 'in', ['scim_group.deleted', 'scim_mapping.unlinked'])
      .orderBy('action')
      .execute()
  const issueKey = (userId: string, organizationId: string) =>
    auth.api.createApiKey({ body: { userId, metadata: { organizationId, scope: 'bookings' } } })
  const keyAccess = (key: string) =>
    app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })
  const suspended = async (organizationId: string, user: TestUser, capability = true) =>
    (
      await db
        .selectNoFrom(scimSuspended(organizationId, user.id, capability).as('suspended'))
        .executeTakeFirstOrThrow()
    ).suspended
  const setActive = (token: Token, id: string, active: boolean) =>
    call(token, `Users/${id}`, 'PATCH', patchBody({ op: 'replace', path: 'active', value: active }))

  /** Hold the given team locks until `during` returns, with `start` waiting behind them. */
  async function behindTeamLocks(
    teams: string[],
    start: () => Promise<Response> | Response,
    during: (trx: Db) => Promise<void>,
  ) {
    let pending: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', 'in', teams)
          .orderBy('id')
          .forUpdate()
          .execute()
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        const pid = rows[0]?.pid
        pending = Promise.resolve(start())
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
            ) AS waiting`.execute(db)
            expect(rows[0]?.waiting).toBe(true)
          },
          { timeout: 3_000, interval: 15 },
        )
        await during(trx)
      })
    } finally {
      await pending?.catch(() => {})
    }
    if (!pending) throw new Error('The concurrent SCIM request must finish.')
    return pending
  }

  it('removes managed access, keeps the team and its history, and answers 404 afterwards', async () => {
    const local = await createTestUser(db, 'Manual child member')
    const f = await directory(2, [local])
    const [first, second] = f.people as [TestUser, TestUser]
    const eventId = await createFixtures(db).eventType(f.child.id, null, {
      hosts: [{ userId: f.child.owner.id }],
    })
    await db
      .insertInto('scim_membership_blocks')
      .values({ organization_id: f.child.id, user_id: second.id, source: 'local', kind: 'removal' })
      .execute()
    const blocks = () =>
      db
        .selectFrom('scim_membership_blocks')
        .select(['user_id', 'source', 'kind', 'cleared_at'])
        .where('organization_id', '=', f.child.id)
        .execute()
    const before = { blocks: await blocks() }
    const childKey = await issueKey(first.id, f.child.id)
    const parentKey = await issueKey(first.id, f.parent.id)
    expect((await keyAccess(childKey.key)).status).toBe(200)
    noticed.length = 0

    // Without the retirement handler the route does not exist and nothing changes.
    const unavailable = await withoutRetirement.request(`${base(f.parent.id)}/${f.path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${f.token.secret}` },
    })
    await expectError(unavailable, 404)
    expect((await mapping(f.mappingId)).retired_at).toBeNull()
    expect(await managed(f.child.id)).toHaveLength(2)

    const retired = await call(f.token, f.path, 'DELETE')
    expect(retired.status).toBe(204)
    expect(await retired.text()).toBe('')

    // Only the access this mapping sourced ends. The team and its own state remain.
    expect(await managed(f.child.id)).toEqual([])
    expect(await childMembers(f.child.id)).toEqual(
      [
        { userId: f.child.owner.id, role: 'owner' },
        { userId: local.id, role: 'member' },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    )
    expect(await member(f.parent.id, first)).toMatchObject({ role: 'member' })
    expect((await keyAccess(childKey.key)).status).toBe(401)
    expect((await keyAccess(parentKey.key)).status).toBe(200)
    expect(
      await db
        .selectFrom('auth.organization')
        .select('name')
        .where('id', '=', f.child.id)
        .executeTakeFirst(),
    ).toEqual({ name: 'Directory name' })
    expect(
      await db.selectFrom('event_types').select('id').where('id', '=', eventId).execute(),
    ).toHaveLength(1)
    expect(await blocks()).toEqual(before.blocks)
    expect(await mapping(f.mappingId)).toEqual({
      retired_at: expect.any(Date),
      live_child_organization_id: null,
    })
    // The Group identity is retained so that its ID is never assigned again.
    expect(
      await db
        .selectFrom('scim_groups')
        .select('mapping_id')
        .where('id', '=', f.group.id)
        .execute(),
    ).toEqual([{ mapping_id: f.mappingId }])

    const token = { actor_type: 'scim_token', actor_id: f.token.id, details: {} }
    expect(await journal(f.parent.id, [f.group.id, f.mappingId])).toEqual([
      { ...token, action: 'scim_group.deleted', target_type: 'scim_group', target_id: f.group.id },
      {
        ...token,
        action: 'scim_mapping.unlinked',
        target_type: 'scim_mapping',
        target_id: f.mappingId,
      },
    ])
    // The child journal records the unlink without the parent's token.
    expect(await journal(f.child.id, [f.group.id, f.mappingId])).toEqual([
      {
        action: 'scim_mapping.unlinked',
        actor_type: 'system',
        actor_id: 'scim-group-retirement',
        target_type: 'scim_mapping',
        target_id: f.mappingId,
        details: {},
      },
    ])
    expect(
      await db
        .selectFrom('audit_events')
        .select('id')
        .where('organization_id', '=', f.child.id)
        .where('actor_id', '=', f.token.id)
        .execute(),
    ).toEqual([])
    expect(
      noticed.map(({ language: _language, ...notice }: Notice & { language?: string }) => notice),
    ).toEqual([
      {
        organizationId: f.parent.id,
        userId: f.parent.owner.id,
        mappingId: f.mappingId,
        action: 'unlinked',
      },
      {
        organizationId: f.child.id,
        userId: f.child.owner.id,
        mappingId: f.mappingId,
        action: 'unlinked',
      },
    ])

    // Every later operation on the retired ID is the scoped 404, repeated DELETE included.
    for (const response of [
      await call(f.token, f.path),
      await call(f.token, f.path, 'DELETE'),
      await call(f.token, f.path, 'DELETE', undefined, { 'if-match': '*' }),
      await call(f.token, f.path, 'PUT', { schemas: [GROUP], displayName: 'Again' }),
      await f.patch({ op: 'replace', path: 'displayName', value: 'Again' }),
    ])
      await expectError(response, 404)
    const list = (await (await call(f.token, 'Groups')).json()) as { totalResults: number }
    expect(list.totalResults).toBe(0)
    expect(await journal(f.parent.id, [f.group.id, f.mappingId])).toHaveLength(2)

    // The retired reservation no longer takes part in uniqueness: a newly approved
    // mapping may reuse the externalId and activates under a new Group ID.
    await expectError(
      await call(f.token, 'Groups', 'POST', {
        schemas: [GROUP],
        externalId: f.externalId,
        displayName: 'Not approved again',
      }),
      409,
      'uniqueness',
    )
    const { id: nextMapping } = await reserve(f.token, f.child.id, f.externalId)
    const recreated = await call(f.token, 'Groups', 'POST', {
      schemas: [GROUP],
      externalId: f.externalId,
      displayName: 'Approved again',
    })
    expect(recreated.status).toBe(201)
    const next = (await recreated.json()) as Group
    expect(next.id).not.toBe(f.group.id)
    expect(next).not.toHaveProperty('members')
    expect(nextMapping).not.toBe(f.mappingId)
    await expectError(await call(f.token, f.path), 404)
    const filter = `Groups?filter=${encodeURIComponent(`externalId eq "${f.externalId}"`)}`
    const found = (await (await call(f.token, filter)).json()) as { Resources: Group[] }
    expect(found.Resources.map(({ id }) => id)).toEqual([next.id])
  })

  it('refuses the whole retirement for a privileged member or an unsafe departure', async () => {
    const f = await directory(3)
    const [promoted, host] = f.people as [TestUser, TestUser, TestUser]
    const promotedMember = (await member(f.child.id, promoted))?.id as string
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', promotedMember)
      .execute()
    const state = async () => ({
      rows: await managed(f.child.id),
      members: await childMembers(f.child.id),
      mapping: await mapping(f.mappingId),
      group: await (await call(f.token, f.path)).json(),
      events: await journal(f.parent.id, [f.group.id, f.mappingId]),
    })
    const before = await state()
    noticed.length = 0

    await expectError(await call(f.token, f.path, 'DELETE'), 403, 'mutability')
    expect(await state()).toEqual(before)

    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', promotedMember)
      .execute()
    const eventId = await createFixtures(db).eventType(f.child.id, null, {
      hosts: [{ userId: host.id }],
    })
    await expectError(await call(f.token, f.path, 'DELETE'), 409)
    expect(await state()).toEqual({ ...before, members: await childMembers(f.child.id) })
    expect(noticed).toEqual([])

    // An unsupported precondition is refused on a live Group before any guard runs.
    await expectError(
      await call(f.token, f.path, 'DELETE', undefined, { 'if-match': 'W/"1"' }),
      412,
    )
    await db.deleteFrom('event_types').where('id', '=', eventId).execute()
    expect((await call(f.token, f.path, 'DELETE')).status).toBe(204)
    expect(await managed(f.child.id)).toEqual([])
    expect(await childMembers(f.child.id)).toEqual([{ userId: f.child.owner.id, role: 'owner' }])
  })

  it('answers the scoped 404 outside the connection and without directory authority', async () => {
    const f = await directory(1)
    const other = await directory(1)
    const untouched = async () => {
      expect((await mapping(f.mappingId)).retired_at).toBeNull()
      expect(await managed(f.child.id)).toHaveLength(1)
    }
    // Another parent's token, in its own URL space and against the first parent's URL.
    await expectError(await call(other.token, f.path, 'DELETE'), 404)
    const foreign = await app.request(`${base(f.parent.id)}/${f.path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${other.token.secret}` },
    })
    expect(foreign.status).toBe(401)
    await untouched()
    for (const path of [`Groups/${randomUUID()}`, 'Groups/not-a-uuid', `Groups/${f.mappingId}`])
      await expectError(await call(f.token, path, 'DELETE'), 404)
    await expectError(
      await call(f.token, `Groups/${randomUUID()}`, 'DELETE', undefined, { 'if-match': '*' }),
      404,
    )
    await untouched()

    // An operator stopped directory authority: the Group is no longer the token's to retire.
    await db
      .updateTable('scim_team_mappings')
      .set({ suspended_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', f.mappingId)
      .execute()
    await expectError(await call(f.token, f.path, 'DELETE'), 404)
    await untouched()
    expect(await journal(f.parent.id, [f.group.id, f.mappingId])).toEqual([])
  })

  it('commits nothing when the owner notice or an audit event cannot be written', async () => {
    const f = await directory(1)
    const [person] = f.people as [TestUser]
    const key = await issueKey(person.id, f.child.id)
    const unchanged = async () => {
      expect((await mapping(f.mappingId)).retired_at).toBeNull()
      expect(await managed(f.child.id)).toHaveLength(1)
      expect((await keyAccess(key.key)).status).toBe(200)
      expect(await journal(f.parent.id, [f.group.id, f.mappingId])).toEqual([])
      expect(await journal(f.child.id, [f.group.id, f.mappingId])).toEqual([])
      expect((await call(f.token, f.path)).status).toBe(200)
    }
    refuseNotices = true
    try {
      await expectError(await call(f.token, f.path, 'DELETE'), 500)
    } finally {
      refuseNotices = false
    }
    await unchanged()

    await sql`CREATE FUNCTION test_refuse_retirement_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_mapping.unlinked' AND NEW.organization_id = ${sql.lit(f.child.id)}::uuid
        THEN RAISE EXCEPTION 'injected SCIM retirement audit failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_retirement_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_retirement_audit()`.execute(db)
    try {
      await expectError(await call(f.token, f.path, 'DELETE'), 500)
    } finally {
      await sql`DROP FUNCTION test_refuse_retirement_audit() CASCADE`.execute(db)
    }
    await unchanged()
    expect((await call(f.token, f.path, 'DELETE')).status).toBe(204)
  })

  it('serializes retirement with Group writes and native changes on the team locks', async () => {
    const f = await directory(2)
    const [kept, promoted] = f.people as [TestUser, TestUser]
    // A promotion that commits first protects the member from the waiting retirement.
    const refused = await behindTeamLocks(
      [f.child.id],
      () => call(f.token, f.path, 'DELETE'),
      async (trx) => {
        await trx
          .updateTable('auth.member')
          .set({ role: 'admin' })
          .where('organizationId', '=', f.child.id)
          .where('userId', '=', promoted.id)
          .execute()
      },
    )
    await expectError(refused, 403, 'mutability')
    expect(await managed(f.child.id)).toHaveLength(2)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.child.id)
      .where('userId', '=', promoted.id)
      .execute()

    // Retirement and a roster write race for the same locks: whichever order they take,
    // the Group ends retired with no managed access left behind.
    const [retired, patched] = await Promise.all([
      call(f.token, f.path, 'DELETE'),
      f.patch({ op: 'remove', path: `members[value eq "${f.ids[0]}"]` }),
    ])
    expect(retired.status).toBe(204)
    expect([200, 404]).toContain(patched.status)
    expect(await managed(f.child.id)).toEqual([])
    expect(await member(f.child.id, kept)).toBeUndefined()
    expect((await mapping(f.mappingId)).retired_at).toBeInstanceOf(Date)
  })

  it('admits no account that a Group PATCH linked only after its identity locks', async () => {
    const f = await directory(1)
    const late = await createTestUser(db, 'Linked during the request')
    await db
      .insertInto('auth.member')
      .values({
        id: randomUUID(),
        userId: late.id,
        organizationId: f.parent.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const lateId = await linkedUser(f.token, late, false)
    const add = () => f.patch({ op: 'add', path: 'members', value: values(lateId) })

    // The pass before the team locks finds no account to lock. The link commits while
    // the request waits, and the pass under the locks must not admit that account.
    const waiting = await behindTeamLocks([f.parent.id, f.child.id], add, async (trx) => {
      await trx
        .updateTable('scim_users')
        .set({
          linked_user_id: late.id,
          linked_member_id: (await member(f.parent.id, late))?.id as string,
        })
        .where('id', '=', lateId)
        .execute()
    })
    await expectError(waiting, 400, 'invalidValue')
    expect(await member(f.child.id, late)).toBeUndefined()
    expect(await managed(f.child.id)).toHaveLength(1)

    // Sent again, the same request locks the now linked account first and admits it.
    expect((await add()).status).toBe(200)
    expect(await member(f.child.id, late)).toMatchObject({ role: 'member' })
  })

  it('restarts a User write when a Group write adds another child team meanwhile', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    const [source] = f.people as [TestUser]
    const second = await activate(f.token)

    // The User write read one child team, then waits for the parent. A roster entry in a
    // second child commits first, so the write must start over and lock that team too.
    const response = await behindTeamLocks(
      [f.parent.id],
      () => setActive(f.token, sourceId, false),
      async (trx) => {
        const memberId = randomUUID()
        await trx
          .insertInto('auth.member')
          .values({
            id: memberId,
            userId: source.id,
            organizationId: second.child.id,
            role: 'member',
            createdAt: new Date(),
          })
          .execute()
        await trx
          .insertInto('scim_team_managed_memberships')
          .values({
            member_id: memberId,
            mapping_id: second.mappingId,
            child_organization_id: second.child.id,
            user_id: source.id,
            scim_user_id: sourceId,
          })
          .execute()
      },
    )
    expect(response.status).toBe(200)
    expect(await suspended(f.child.id, source)).toBe(true)
    expect(await suspended(second.child.id, source)).toBe(true)
    expect((await managed(second.child.id)).map((row) => row.suspended_at)).toEqual([
      expect.any(Date),
    ])
  })

  it('journals the child resume that a refused reactivation commits', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    const [source] = f.people as [TestUser]
    expect((await setActive(f.token, sourceId, false)).status).toBe(200)
    await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.parent.id,
        user_id: source.id,
        source: 'local',
        kind: 'suspension',
      })
      .execute()
    const resumes = () =>
      db
        .selectFrom('audit_events')
        .select(['organization_id', 'actor_type', 'actor_id', 'target_type', 'details'])
        .where('action', '=', 'scim_user.child_access_resumed')
        .where('target_id', '=', sourceId)
        .execute()
    const user = () =>
      db.selectFrom('scim_users').selectAll().where('id', '=', sourceId).executeTakeFirstOrThrow()

    // The refusal leaves the User itself untouched and records the one change it carries.
    const before = await user()
    await expectError(await setActive(f.token, sourceId, true), 403, 'mutability')
    expect(await user()).toEqual(before)
    expect(before).toMatchObject({ active: false })
    expect(await suspended(f.child.id, source)).toBe(false)
    expect(await suspended(f.parent.id, source)).toBe(true)
    expect(await resumes()).toEqual([
      {
        organization_id: f.parent.id,
        actor_type: 'scim_token',
        actor_id: f.token.id,
        target_type: 'scim_user',
        details: {},
      },
    ])
    // With nothing left to resume the same refusal commits nothing and records nothing.
    await expectError(await setActive(f.token, sourceId, true), 403, 'mutability')
    expect(await resumes()).toHaveLength(1)
  })

  it('refuses a directory-suspended child member on the server paths that hold the capability', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    const [source] = f.people as [TestUser]
    expect((await setActive(f.token, sourceId, false)).status).toBe(200)
    expect(await suspended(f.child.id, source, false)).toBe(false)
    expect(await suspended(f.child.id, source)).toBe(true)
    const browser = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { secret: signingSecret, publicUrl },
        {
          userId: source.id,
          organizationId: f.child.id,
          now: new Date().toISOString(),
          headers: new Headers(),
        },
      ),
    )
    const principal = (capability: boolean): Principal => ({
      kind: 'session',
      sessionId: browser.id,
      user: { id: source.id, name: source.name, email: source.email },
      organization: { id: f.child.id, name: 'Directory name', slug: 'child', personal: false },
      ...(capability && { scimResourcesEnabled: true as const }),
    })

    // Booking writes bound to the browser's team.
    const bookingWrite = (capability: boolean) =>
      db
        .transaction()
        .execute((trx) => bookingWriteAccess(principal(capability), f.child.id)(trx, f.child.id))
    await expect(bookingWrite(false)).resolves.toBeUndefined()
    await expect(bookingWrite(true)).rejects.toMatchObject({ code: 'organization_context_changed' })

    // OIDC account linking.
    const link = (capability?: boolean) =>
      db
        .transaction()
        .execute((trx) =>
          lockOidcLinkActor(trx, f.child.id, { userId: source.id, id: browser.id }, capability),
        )
    expect((await link()).member.id).toBe((await member(f.child.id, source))?.id)
    await expect(link(true)).rejects.toBeInstanceOf(OidcAttemptRefused)

    // Owner notices. A fixture role stands in for an owner whose suspension predates it.
    await db
      .updateTable('auth.member')
      .set({ role: 'owner' })
      .where('organizationId', '=', f.child.id)
      .where('userId', '=', source.id)
      .execute()
    const owners = async (capability?: boolean) =>
      (await ssoRecoveryTeamOwners(db, f.child.id, capability).execute())
        .map(({ userId }) => userId)
        .sort()
    expect(await owners()).toEqual([f.child.owner.id, source.id].sort())
    expect(await owners(true)).toEqual([f.child.owner.id])
  })
})
