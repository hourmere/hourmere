import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
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
import { bookingTools } from './mcp/bookings.ts'
import { type McpCaller, runTool } from './mcp/tools.ts'
import { scimDiscoveryWithGroups } from './scim-discovery.ts'
import { scimGroups } from './scim-groups.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUserRetirement } from './scim-user-retirement.ts'
import { scimUsers } from './scim-users.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://scim-group-members.example.test'
const signingSecret = 'synthetic-scim-group-member-signing-secret-00'
const signup = { mode: 'open', allowedDomains: [] } as const
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

type Token = { id: string; organizationId: string; connectionId: string; secret: string }
type Group = {
  id: string
  displayName: string
  members?: { value: string; $ref: string; type: string }[]
  meta: { lastModified: string }
}

const base = (organizationId: string) => `${publicUrl}/scim/v2/${organizationId}`
const patchBody = (...operations: object[]) => ({ schemas: [PATCH], Operations: operations })
const values = (...ids: string[]) => ids.map((value) => ({ value }))
const filtered = (id: string) => `members[value eq "${id}"]`

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

describe.skipIf(!databaseUrl)('SCIM Group membership changes', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_members' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret: signingSecret,
      signup,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('Group writes must not send mail') },
    })
    const groups = scimGroups(db)
    const replace = scimUserReplacement(db)
    const retire = scimUserRetirement(db)
    const users = scimUsers(db)
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, scimResourcesEnabled: true }),
      scim: {
        db,
        enabled: true,
        resources: (request) =>
          scimDiscoveryWithGroups(request) ??
          groups(request) ??
          retire(request) ??
          replace(request) ??
          users(request),
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

  function call(token: Token, path: string, method = 'GET', body?: object) {
    return app.request(`${base(token.organizationId)}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/scim+json',
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

  async function linkedUser(token: Token, user: TestUser, active = true) {
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: token.organizationId,
        connection_id: token.connectionId,
        user_name: user.email,
        display_name: user.name,
        linked_user_id: user.id,
        linked_member_id: (await member(token.organizationId, user))?.id ?? null,
        active,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  /** A parent with linked ordinary members and one activated Group over a fresh child. */
  async function directory(count: number, manual: TestUser[] = []) {
    const people = await Promise.all(
      Array.from({ length: count }, (_, index) => createTestUser(db, `Directory member ${index}`)),
    )
    const parent = await team('Membership parent', [...people, ...manual])
    const token = await issue(parent.id)
    const ids: string[] = []
    for (const person of people) ids.push(await linkedUser(token, person))
    const group = await activate(token, manual)
    return { parent, token, people, ids, ...group }
  }

  async function activate(token: Token, manual: TestUser[] = [], initial: string[] = []) {
    const child = await team('Membership child', manual)
    const externalId = randomUUID()
    const { id: mappingId } = await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: token.organizationId,
        connection_id: token.connectionId,
        child_organization_id: child.id,
        external_id: externalId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const response = await call(token, 'Groups', 'POST', {
      schemas: [GROUP],
      externalId,
      displayName: 'Membership child',
      members: values(...initial),
    })
    expect(response.status).toBe(201)
    const group = (await response.json()) as Group
    const path = `Groups/${group.id}`
    const patch = (...operations: object[]) => call(token, path, 'PATCH', patchBody(...operations))
    const read = async () => (await (await call(token, path)).json()) as Group
    const roster = async () => ((await read()).members ?? []).map(({ value }) => value)
    return { child, mappingId, group, path, patch, read, roster }
  }

  async function applied(response: Response, expected: string[]) {
    expect(response.status).toBe(200)
    const group = (await response.json()) as Group
    expect((group.members ?? []).map(({ value }) => value)).toEqual([...expected].sort())
    return group
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
  const updateEvents = (groupId: string) =>
    db
      .selectFrom('audit_events')
      .select(['organization_id', 'actor_type', 'actor_id', 'details'])
      .where('action', '=', 'scim_group.updated')
      .where('target_id', '=', groupId)
      .execute()
  const issueKey = (userId: string, organizationId: string) =>
    auth.api.createApiKey({ body: { userId, metadata: { organizationId, scope: 'bookings' } } })
  const keyAccess = (key: string) =>
    app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })
  const suspended = async (organizationId: string, user: TestUser) =>
    (
      await db
        .selectNoFrom(scimSuspended(organizationId, user.id, true).as('suspended'))
        .executeTakeFirstOrThrow()
    ).suspended
  const entry = (id: string) =>
    db
      .selectFrom('scim_users')
      .select(['active', 'retired_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const setActive = (token: Token, id: string, active: boolean | string) =>
    call(token, `Users/${id}`, 'PATCH', patchBody({ op: 'Replace', path: 'active', value: active }))

  it('applies Entra and Okta member forms in order and treats every replay as a no-op', async () => {
    const outsider = await createTestUser(db, 'Manual child member')
    const f = await directory(3, [outsider])
    const [a, b, c] = f.ids as [string, string, string]
    const manual = (await childMembers(f.child.id)).length
    expect(manual).toBe(2)

    const add = { op: 'Add', path: 'members', value: [{ value: a, display: 'Ignored' }] }
    const first = await applied(await f.patch(add), [a])
    expect(first.members).toEqual([
      { value: a, type: 'User', $ref: `${base(f.parent.id)}/Users/${a}` },
    ])
    expect(await managed(f.child.id)).toEqual([
      { user_id: f.people[0]?.id, scim_user_id: a, suspended_at: null },
    ])
    expect(await member(f.child.id, f.people[0] as TestUser)).toMatchObject({ role: 'member' })
    expect(await updateEvents(f.group.id)).toEqual([
      { organization_id: f.parent.id, actor_type: 'scim_token', actor_id: f.token.id, details: {} },
    ])
    expect(await (await f.patch(add)).json()).toEqual(first)
    expect(await updateEvents(f.group.id)).toHaveLength(1)

    // Okta sends one object per added member and the standard filtered removal.
    await applied(await f.patch({ op: 'add', path: `${GROUP}:members`, value: { value: b } }), [
      a,
      b,
    ])
    const entraRemoval = { op: 'Remove', path: 'members', value: [{ value: a }] }
    const afterRemoval = await applied(await f.patch(entraRemoval), [b])
    expect(await member(f.child.id, f.people[0] as TestUser)).toBeUndefined()
    expect(await member(f.parent.id, f.people[0] as TestUser)).toBeDefined()
    expect(await (await f.patch(entraRemoval)).json()).toEqual(afterRemoval)
    const empty = await applied(await f.patch({ op: 'remove', path: filtered(b) }), [])
    expect(empty).not.toHaveProperty('members')
    expect(await (await f.patch({ op: 'remove', path: filtered(b) })).json()).toEqual(empty)
    expect(await (await f.patch({ op: 'remove', path: filtered(randomUUID()) })).json()).toEqual(
      empty,
    )
    expect(await updateEvents(f.group.id)).toHaveLength(4)

    await applied(await f.patch({ op: 'add', value: { MEMBERS: values(a, c) } }), [a, c])
    await applied(await f.patch({ op: 'Replace', path: 'members', value: values(b, c) }), [b, c])
    expect(await member(f.child.id, f.people[0] as TestUser)).toBeUndefined()
    // Ordered: the added member is removed again, the rename and the last add commit.
    const ordered = await applied(
      await f.patch(
        { op: 'add', path: 'members', value: values(a) },
        { op: 'replace', path: 'displayName', value: 'Renamed with members' },
        { op: 'remove', path: filtered(a) },
        { op: 'remove', path: 'members', value: values(b, randomUUID()) },
        { op: 'replace', value: { members: values(c) } },
        { op: 'add', path: 'members', value: values(b) },
      ),
      [b, c],
    )
    expect(ordered.displayName).toBe('Renamed with members')
    expect(await member(f.child.id, f.people[0] as TestUser)).toBeUndefined()

    // An Entra removal whose value is missing must not clear the Group.
    await expectError(
      await f.patch({ op: 'Remove', path: 'members', value: null }),
      400,
      'invalidValue',
    )
    await applied(await f.patch({ op: 'remove', path: 'members', value: [] }), [b, c])
    await applied(await f.patch({ op: 'remove', path: 'members' }), [])
    expect(await managed(f.child.id)).toEqual([])
    expect(await childMembers(f.child.id)).toHaveLength(manual)
    expect(await member(f.child.id, outsider)).toMatchObject({ role: 'member' })
  })

  it('admits only active linked Users of the same connection and applies nothing on refusal', async () => {
    const manual = await createTestUser(db, 'Manual and directory member')
    const blocked = await createTestUser(db, 'Locally removed member')
    const inactive = await createTestUser(db, 'Inactive directory member')
    const f = await directory(1, [manual])
    const [valid] = f.ids as [string]
    await db
      .insertInto('auth.member')
      .values(
        [blocked, inactive].map((user) => ({
          id: randomUUID(),
          userId: user.id,
          organizationId: f.parent.id,
          role: 'member',
          createdAt: new Date(),
        })),
      )
      .execute()
    const manualId = await linkedUser(f.token, manual)
    const blockedId = await linkedUser(f.token, blocked)
    const inactiveId = await linkedUser(f.token, inactive, false)
    const { id: unlinkedId } = await db
      .insertInto('scim_users')
      .values({
        organization_id: f.parent.id,
        connection_id: f.token.connectionId,
        user_name: 'unclaimed@example.test',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.child.id,
        user_id: blocked.id,
        source: 'local',
        kind: 'removal',
      })
      .execute()
    const foreign = await directory(1)
    const [foreignId] = foreign.ids as [string]
    const rename = { op: 'replace', path: 'displayName', value: 'Must not be applied' }
    const adding = (id: string, extra: object = {}) => ({
      op: 'add',
      path: 'members',
      value: [{ value: valid }, { value: id, ...extra }],
    })

    for (const id of [foreignId, unlinkedId, inactiveId, randomUUID(), f.group.id]) {
      await expectError(await f.patch(rename, adding(id)), 400, 'invalidValue')
    }
    await expectError(await f.patch(rename, adding(valid, { type: 'Group' })), 400, 'invalidValue')
    await expectError(
      await f.patch(rename, adding(valid, { $ref: `${base(foreign.parent.id)}/Users/${valid}` })),
      400,
      'invalidValue',
    )
    await expectError(await f.patch(rename, adding(manualId)), 409)
    await expectError(await f.patch(rename, adding(blockedId)), 403)
    await expectError(await f.patch(rename, adding(valid, { roles: ['owner'] })), 403, 'mutability')
    for (const path of [`${filtered(valid)}.roles`, 'members.role', 'roles']) {
      await expectError(
        await f.patch(rename, { op: 'replace', path, value: 'admin' }),
        403,
        'mutability',
      )
    }
    for (const operation of [
      { op: 'add', path: filtered(valid), value: { value: valid } },
      { op: 'replace', path: filtered(valid), value: { value: valid } },
      { op: 'remove', path: `${filtered(valid)}.display` },
      { op: 'remove', path: 'members[display eq "Someone"]' },
    ]) {
      await expectError(await f.patch(rename, operation), 400, 'invalidPath')
    }
    await expectError(
      await f.patch(rename, { op: 'remove', path: filtered('not-a-user') }),
      400,
      'invalidFilter',
    )
    await expectError(
      await f.patch(rename, { op: 'remove', path: filtered(valid), value: values(valid) }),
      400,
      'invalidValue',
    )
    await expectError(
      await f.patch(rename, { op: 'replace', value: { members: null } }),
      400,
      'invalidValue',
    )

    expect(await f.read()).toEqual(f.group)
    expect(await managed(f.child.id)).toEqual([])
    expect(await childMembers(f.child.id)).toHaveLength(2)
    expect(await updateEvents(f.group.id)).toEqual([])
    // The other tenant's Group is not addressable with this token.
    await expectError(await call(f.token, foreign.path, 'PATCH', patchBody(adding(valid))), 404)
    expect(await foreign.roster()).toEqual([])
  })

  it('keeps owner and admin access, refuses unsafe departures and revokes removed credentials', async () => {
    const f = await directory(3)
    const [promotedId, hostId, ordinaryId] = f.ids as [string, string, string]
    const [promoted, host, ordinary] = f.people as [TestUser, TestUser, TestUser]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(...f.ids) }), f.ids)
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', (await member(f.child.id, promoted))?.id as string)
      .execute()
    const before = { group: await f.read(), members: await childMembers(f.child.id) }

    for (const operation of [
      { op: 'remove', path: filtered(promotedId) },
      { op: 'Remove', path: 'members', value: values(promotedId) },
      { op: 'replace', path: 'members', value: values(hostId, ordinaryId) },
      { op: 'replace', value: { members: [] } },
      { op: 'remove', path: 'members' },
    ]) {
      await expectError(
        await f.patch({ op: 'remove', path: filtered(ordinaryId) }, operation),
        403,
        'mutability',
      )
    }
    const eventId = await createFixtures(db).eventType(f.child.id, null, {
      hosts: [{ userId: host.id }],
    })
    await expectError(
      await f.patch(
        { op: 'remove', path: filtered(ordinaryId) },
        { op: 'remove', path: filtered(hostId) },
      ),
      409,
    )
    expect(await f.read()).toEqual(before.group)
    expect(await childMembers(f.child.id)).toEqual(before.members)
    expect(await updateEvents(f.group.id)).toHaveLength(1)

    const childKey = await issueKey(ordinary.id, f.child.id)
    const parentKey = await issueKey(ordinary.id, f.parent.id)
    expect((await keyAccess(childKey.key)).status).toBe(200)
    await applied(await f.patch({ op: 'remove', path: filtered(ordinaryId) }), [promotedId, hostId])
    expect((await keyAccess(childKey.key)).status).toBe(401)
    expect((await keyAccess(parentKey.key)).status).toBe(200)
    expect(await member(f.child.id, ordinary)).toBeUndefined()
    expect(await member(f.child.id, promoted)).toMatchObject({ role: 'admin' })
    await db.deleteFrom('event_types').where('id', '=', eventId).execute()
    await applied(await f.patch({ op: 'remove', path: filtered(hostId) }), [promotedId])
  })

  it('rolls back the roster when the audit event cannot be written', async () => {
    const f = await directory(2)
    const [kept, added] = f.ids as [string, string]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(kept) }), [kept])
    const before = { group: await f.read(), rows: await managed(f.child.id) }
    await sql`CREATE FUNCTION test_refuse_member_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_group.updated' AND NEW.organization_id = ${sql.lit(f.parent.id)}::uuid
        THEN RAISE EXCEPTION 'injected SCIM Group audit failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_member_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_member_audit()`.execute(db)

    await expectError(await f.patch({ op: 'replace', path: 'members', value: values(added) }), 500)
    expect(await f.read()).toEqual(before.group)
    expect(await managed(f.child.id)).toEqual(before.rows)
  })

  it('serializes concurrent replacements and rechecks admission behind the team locks', async () => {
    const f = await directory(4)
    const [a, b, c, d] = f.ids as [string, string, string, string]
    const rosters = [[a, b], [b, c], [c, d], [a, d], [b]]
    const responses = await Promise.all(
      rosters.map((roster) =>
        f.patch({ op: 'replace', path: 'members', value: values(...roster) }),
      ),
    )
    expect(responses.map((response) => response.status)).toEqual(rosters.map(() => 200))
    const final = await f.roster()
    expect(rosters.map((roster) => [...roster].sort())).toContainEqual(final)
    expect((await managed(f.child.id)).map((row) => row.scim_user_id)).toEqual(final)
    expect(await childMembers(f.child.id)).toHaveLength(final.length + 1)

    await applied(await f.patch({ op: 'remove', path: 'members' }), [])
    const person = f.people[0] as TestUser
    let pending: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', 'in', [f.parent.id, f.child.id])
          .orderBy('id')
          .forUpdate()
          .execute()
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        const pid = rows[0]?.pid
        pending = Promise.resolve(f.patch({ op: 'add', path: 'members', value: values(a) }))
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
        // A manual membership committed first wins: the directory cannot adopt it.
        await trx
          .insertInto('auth.member')
          .values({
            id: randomUUID(),
            userId: person.id,
            organizationId: f.child.id,
            role: 'member',
            createdAt: new Date(),
          })
          .execute()
      })
    } finally {
      await pending?.catch(() => {})
    }
    if (!pending) throw new Error('The concurrent SCIM request must finish.')
    await expectError(await pending, 409)
    expect(await f.roster()).toEqual([])
    expect(await managed(f.child.id)).toEqual([])
  })

  it('applies the source User lifecycle to every managed child membership', async () => {
    const f = await directory(2)
    const [sourceId, otherId] = f.ids as [string, string]
    const [source, other] = f.people as [TestUser, TestUser]
    const second = await activate(f.token, [], [sourceId])
    await applied(await f.patch({ op: 'add', path: 'members', value: values(...f.ids) }), f.ids)
    const key = await issueKey(source.id, f.child.id)
    const otherKey = await issueKey(other.id, f.child.id)
    expect((await keyAccess(key.key)).status).toBe(200)
    const state = async () => ({
      first: (await managed(f.child.id)).map((row) => [
        row.scim_user_id,
        row.suspended_at !== null,
      ]),
      second: (await managed(second.child.id)).map((row) => row.suspended_at !== null),
      access: [
        await suspended(f.parent.id, source),
        await suspended(f.child.id, source),
        await suspended(second.child.id, source),
        await suspended(f.child.id, other),
      ],
    })
    const rows = (suspendedSource: boolean) =>
      [
        [sourceId, suspendedSource],
        [otherId, false],
      ].sort(([left], [right]) => String(left).localeCompare(String(right)))
    expect(await state()).toEqual({
      first: rows(false),
      second: [false],
      access: [false, false, false, false],
    })

    expect((await setActive(f.token, sourceId, 'False')).status).toBe(200)
    expect(await state()).toEqual({
      first: rows(true),
      second: [true],
      access: [true, true, true, false],
    })
    // The membership and its roster entry are retained while suspended.
    expect(await f.roster()).toEqual([...f.ids].sort())
    expect(await member(f.child.id, source)).toMatchObject({ role: 'member' })
    expect((await keyAccess(key.key)).status).toBe(401)
    // A credential issued during the suspension is refused, and without the resource
    // capability the statement does not read the child suspension at all.
    await expect(issueKey(source.id, f.child.id)).rejects.toMatchObject({ status: 'FORBIDDEN' })
    await expect(
      db
        .selectNoFrom(scimSuspended(f.child.id, source.id, false).as('suspended'))
        .executeTakeFirst(),
    ).resolves.toEqual({ suspended: false })
    expect((await keyAccess(otherKey.key)).status).toBe(200)
    // A replayed deactivation keeps the original suspension.
    const original = await managed(f.child.id)
    expect((await setActive(f.token, sourceId, false)).status).toBe(200)
    expect(await managed(f.child.id)).toEqual(original)

    // Stopped directory authority preserves that child's state in both directions.
    await db
      .updateTable('scim_team_mappings')
      .set({ suspended_at: sql`clock_timestamp()` })
      .where('id', '=', second.mappingId)
      .execute()
    expect((await setActive(f.token, sourceId, true)).status).toBe(200)
    expect(await state()).toEqual({
      first: rows(false),
      second: [true],
      access: [false, false, true, false],
    })
    // Reactivation restores no revoked credential.
    expect((await keyAccess(key.key)).status).toBe(401)

    const beforeRetirement = await f.read()
    const retired = await call(f.token, `Users/${sourceId}`, 'DELETE')
    expect(retired.status).toBe(204)
    // Leaving the roster changes the Group, so its version moves with the same commit.
    const afterRetirement = await f.read()
    expect(Date.parse(afterRetirement.meta.lastModified)).toBeGreaterThan(
      Date.parse(beforeRetirement.meta.lastModified),
    )
    expect(await updateEvents(f.group.id)).toHaveLength(1)
    expect(await entry(sourceId)).toMatchObject({ active: false, retired_at: expect.any(Date) })
    expect(await member(f.child.id, source)).toBeUndefined()
    expect(await member(second.child.id, source)).toMatchObject({ role: 'member' })
    expect(await member(f.parent.id, source)).toMatchObject({ role: 'member' })
    expect(await f.roster()).toEqual([otherId])
    expect(await managed(f.child.id)).toEqual([
      { user_id: other.id, scim_user_id: otherId, suspended_at: null },
    ])
    expect((await keyAccess(otherKey.key)).status).toBe(200)
  })

  it('refuses a source User write that would suspend or remove a child owner, admin or host', async () => {
    const f = await directory(2)
    const [promotedId, hostId] = f.ids as [string, string]
    const [promoted, host] = f.people as [TestUser, TestUser]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(...f.ids) }), f.ids)
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', (await member(f.child.id, promoted))?.id as string)
      .execute()
    await createFixtures(db).eventType(f.child.id, null, { hosts: [{ userId: host.id }] })
    const blocks = () =>
      db
        .selectFrom('scim_membership_blocks')
        .select('id')
        .where('organization_id', '=', f.parent.id)
        .execute()

    await expectError(await setActive(f.token, promotedId, false), 403, 'mutability')
    // A later operation that restores the value does not excuse the deactivation.
    await expectError(
      await call(
        f.token,
        `Users/${promotedId}`,
        'PATCH',
        patchBody(
          { op: 'replace', path: 'active', value: false },
          { op: 'replace', path: 'active', value: true },
        ),
      ),
      403,
      'mutability',
    )
    await expectError(await call(f.token, `Users/${promotedId}`, 'DELETE'), 403, 'mutability')
    await expectError(await call(f.token, `Users/${hostId}`, 'DELETE'), 409)
    for (const id of f.ids) expect(await entry(id)).toEqual({ active: true, retired_at: null })
    expect(await blocks()).toEqual([])
    expect(await managed(f.child.id)).toEqual(
      expect.arrayContaining([
        { user_id: promoted.id, scim_user_id: promotedId, suspended_at: null },
        { user_id: host.id, scim_user_id: hostId, suspended_at: null },
      ]),
    )
    expect(await member(f.parent.id, promoted)).toMatchObject({ role: 'member' })

    // Suspension keeps the membership, so it needs no departure handling.
    expect((await setActive(f.token, hostId, false)).status).toBe(200)
    expect(await suspended(f.child.id, host)).toBe(true)
    expect(await suspended(f.child.id, promoted)).toBe(false)
  })

  it('resumes child access only after an IdP retries reactivation with the parent blocker cleared', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    const [source] = f.people as [TestUser]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(sourceId) }), f.ids)
    expect((await setActive(f.token, sourceId, false)).status).toBe(200)
    expect(await suspended(f.child.id, source)).toBe(true)
    const blocker = await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: f.parent.id,
        user_id: source.id,
        source: 'local',
        kind: 'suspension',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const read = async () => {
      const response = await call(f.token, `Users/${sourceId}`)
      expect(response.status).toBe(200)
      return (await response.json()) as { active: boolean; displayName: string }
    }
    const sync = async (desiredActive: boolean) => {
      if ((await read()).active === desiredActive) return
      return setActive(f.token, sourceId, desiredActive)
    }
    const before = await read()
    expect(before).toMatchObject({ active: false, displayName: source.name })
    await expectError(
      await call(
        f.token,
        `Users/${sourceId}`,
        'PATCH',
        patchBody(
          { op: 'replace', path: 'active', value: true },
          { op: 'replace', path: 'displayName', value: 'Refused name' },
        ),
      ),
      403,
      'mutability',
    )
    expect(await read()).toEqual(before)
    expect(await suspended(f.child.id, source), 'refusal keeps child access suspended').toBe(true)
    expect(await suspended(f.parent.id, source)).toBe(true)
    expect(await sync(false)).toBeUndefined()
    expect(await suspended(f.child.id, source)).toBe(true)

    await db
      .updateTable('scim_membership_blocks')
      .set({ cleared_at: new Date() })
      .where('id', '=', blocker.id)
      .execute()
    expect(await read()).toEqual(before)
    expect(await suspended(f.child.id, source)).toBe(true)
    expect((await sync(true))?.status).toBe(200)
    expect(await read()).toMatchObject({ active: true, displayName: source.name })
    expect(await suspended(f.child.id, source)).toBe(false)
    expect(await suspended(f.parent.id, source)).toBe(false)
    const key = await issueKey(source.id, f.child.id)
    expect((await keyAccess(key.key)).status).toBe(200)

    expect((await sync(false))?.status).toBe(200)
    expect(await read()).toMatchObject({ active: false })
    expect(await suspended(f.child.id, source)).toBe(true)
    expect((await keyAccess(key.key)).status).toBe(401)
  })

  it('takes the child team lock before a source User write changes child access', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(sourceId) }), f.ids)
    let pending: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', f.child.id)
          .forUpdate()
          .execute()
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        const pid = rows[0]?.pid
        pending = Promise.resolve(setActive(f.token, sourceId, false))
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
        // A promotion that commits first protects the member from the waiting write.
        await trx
          .updateTable('auth.member')
          .set({ role: 'admin' })
          .where('organizationId', '=', f.child.id)
          .where('userId', '=', (f.people[0] as TestUser).id)
          .execute()
      })
    } finally {
      await pending?.catch(() => {})
    }
    if (!pending) throw new Error('The concurrent SCIM request must finish.')
    await expectError(await pending, 403, 'mutability')
    expect(await entry(sourceId)).toEqual({ active: true, retired_at: null })
    expect(await suspended(f.child.id, f.people[0] as TestUser)).toBe(false)
  })

  it('withholds MCP public availability for a suspended directory host when resources are enabled', async () => {
    const f = await directory(1)
    const [sourceId] = f.ids as [string]
    const [source] = f.people as [TestUser]
    await applied(await f.patch({ op: 'add', path: 'members', value: values(sourceId) }), f.ids)
    const fixtures = createFixtures(db)
    const slug = 'directory-host'
    await fixtures.eventType(f.child.id, null, { slug, hosts: [{ userId: source.id }] })
    await fixtures.schedule(source.id)
    const organization = await db
      .selectFrom('auth.organization')
      .select(['id', 'name', 'slug'])
      .where('id', '=', f.child.id)
      .executeTakeFirstOrThrow()
    const tool = bookingTools({
      db,
      now: () => Temporal.Instant.from('2026-11-01T12:00:00Z'),
    }).find(({ name }) => name === 'find_available_slots')
    if (!tool) throw new Error('No availability tool')
    const caller: McpCaller = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'bookings',
      organization: { ...organization, personal: false },
      user: f.child.owner,
    }
    const search = (scimResourcesEnabled: boolean) =>
      runTool(
        tool,
        {
          teamSlug: organization.slug,
          slug,
          startDate: '2026-11-02',
          endDate: '2026-11-02',
          timeZone: 'UTC',
        },
        {
          caller: { ...caller, ...(scimResourcesEnabled && { scimResourcesEnabled: true }) },
          rateLimit: () => {},
        },
        () => expect.unreachable('Availability must return a structured result'),
      )

    expect((await search(true)).structuredContent).toMatchObject({
      slots: expect.arrayContaining([expect.objectContaining({ start: expect.any(String) })]),
    })
    expect((await setActive(f.token, sourceId, false)).status).toBe(200)
    expect(await search(true)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('"error":"event_type_not_found"') }],
    })
    expect((await search(false)).structuredContent).toMatchObject({
      slots: expect.arrayContaining([expect.objectContaining({ start: expect.any(String) })]),
    })
  })
})
