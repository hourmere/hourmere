import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { scimDiscoveryWithGroups } from './scim-discovery-fixture.ts'
import { scimGroups } from './scim-groups.ts'
import { productionAppOptions } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://scim-groups.example.test'
const signingSecret = 'synthetic-scim-group-test-signing-secret-0000'
const signup = { mode: 'open', allowedDomains: [] } as const
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

type Token = { id: string; organizationId: string; connectionId: string; secret: string }
type Application = ReturnType<typeof createApp>
type Group = { id: string; displayName: string; externalId: string }

const base = (organizationId: string) => `${publicUrl}/scim/v2/${organizationId}`
const groupBody = (externalId: string, displayName: string, members?: object[]) => ({
  schemas: [GROUP],
  externalId,
  displayName,
  ...(members === undefined ? {} : { members }),
})
const patchBody = (...operations: object[]) => ({ schemas: [PATCH], Operations: operations })
const query = (parameters: Record<string, string>) => `?${new URLSearchParams(parameters)}`

async function expectError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/scim+json')
  const raw = await response.text()
  expect(JSON.parse(raw)).toEqual({
    schemas: [ERROR],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail: expect.any(String),
  })
  return raw
}

function call(
  app: Application,
  token: Token,
  path: string,
  {
    method = 'GET',
    body,
    headers,
    organizationId = token.organizationId,
  }: {
    method?: string
    body?: object
    headers?: Record<string, string>
    organizationId?: string
  } = {},
) {
  return app.request(`${base(organizationId)}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token.secret}`,
      'content-type': 'application/scim+json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe.skipIf(!databaseUrl)('SCIM Group resources', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let app: Application

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_groups' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret: signingSecret,
      signup,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('Group writes must not send mail') },
    })
    const groups = scimGroups(db)
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
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

  // The owner-consent tests cover how a committed mapping is approved. These fixtures start
  // at that storage boundary, where SCIM resource requests consume the approved reservation.
  async function reserve(token: Token, childId: string, externalId: string) {
    const { id } = await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: token.organizationId,
        connection_id: token.connectionId,
        child_organization_id: childId,
        external_id: externalId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function memberId(teamId: string, user: TestUser) {
    return (
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', teamId)
        .where('userId', '=', user.id)
        .executeTakeFirstOrThrow()
    ).id
  }

  async function linkedUser(token: Token, user: TestUser) {
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: token.organizationId,
        connection_id: token.connectionId,
        user_name: user.email,
        display_name: user.name,
        linked_user_id: user.id,
        linked_member_id: await memberId(token.organizationId, user),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  async function markManaged(
    mappingId: string,
    childId: string,
    user: TestUser,
    scimUserId: string,
  ) {
    await db
      .insertInto('scim_team_managed_memberships')
      .values({
        mapping_id: mappingId,
        child_organization_id: childId,
        user_id: user.id,
        member_id: await memberId(childId, user),
        scim_user_id: scimUserId,
      })
      .execute()
  }

  async function create(token: Token, body: object) {
    const response = await call(app, token, 'Groups', { method: 'POST', body })
    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('application/scim+json')
    const row = (await response.json()) as Group
    expect(response.headers.get('location')).toBe(`${base(token.organizationId)}/Groups/${row.id}`)
    return row
  }

  const storedName = async (id: string) =>
    (
      await db
        .selectFrom('auth.organization')
        .select('name')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).name
  const scopedRows = (mappingId: string) =>
    db.selectFrom('scim_groups').selectAll().where('mapping_id', '=', mappingId).execute()
  const updateEvents = (id: string) =>
    db
      .selectFrom('audit_events')
      .select(['organization_id', 'actor_type', 'actor_id', 'credential_type', 'details'])
      .where('action', '=', 'scim_group.updated')
      .where('target_type', '=', 'scim_group')
      .where('target_id', '=', id)
      .execute()

  it('refuses unmapped children and binds creation to the exact reservation', async () => {
    const parent = await team('Directory parent')
    const child = await team('Mapped child before activation')
    const unmapped = await team('Shared directory name')
    const foreignParent = await team('Other directory parent')
    const foreignChild = await team('Shared directory name')
    const token = await issue(parent.id)
    const foreignToken = await issue(foreignParent.id)
    const mapping = await reserve(token, child.id, 'Exact-Reserved-ID')
    await reserve(foreignToken, foreignChild.id, 'Foreign-Reserved-ID')

    const refusals = []
    for (const externalId of ['Never-Reserved', 'exact-reserved-id', 'Foreign-Reserved-ID']) {
      refusals.push(
        await expectError(
          await call(app, token, 'Groups', {
            method: 'POST',
            body: groupBody(externalId, 'Shared directory name'),
          }),
          409,
          'uniqueness',
        ),
      )
    }
    expect(new Set(refusals).size).toBe(1)
    expect(await storedName(child.id)).toBe('Mapped child before activation')
    expect(await scopedRows(mapping)).toEqual([])

    const value = await create(token, groupBody('Exact-Reserved-ID', 'Shared directory name'))
    expect(value).toMatchObject({
      schemas: [GROUP],
      externalId: 'Exact-Reserved-ID',
      displayName: 'Shared directory name',
      meta: {
        resourceType: 'Group',
        created: expect.any(String),
        lastModified: expect.any(String),
        location: `${base(parent.id)}/Groups/${value.id}`,
      },
    })
    expect(value.id).toMatch(/^[0-9a-f-]{36}$/)
    expect([mapping, child.id, parent.id]).not.toContain(value.id)
    expect(await storedName(child.id)).toBe(value.displayName)
    expect(await storedName(unmapped.id)).toBe('Shared directory name')
    expect(await storedName(foreignChild.id)).toBe('Shared directory name')
    expect(await scopedRows(mapping)).toEqual([expect.objectContaining({ id: value.id })])
    const retry = await expectError(
      await call(app, token, 'Groups', {
        method: 'POST',
        body: groupBody('Exact-Reserved-ID', 'An ignored retry name'),
      }),
      409,
      'uniqueness',
    )
    expect(retry).toBe(refusals[0])
    expect(await storedName(child.id)).toBe(value.displayName)
    const audit = await db
      .selectFrom('audit_events')
      .select(['organization_id', 'action', 'actor_type', 'actor_id', 'credential_type', 'details'])
      .where('target_id', '=', value.id)
      .execute()
    expect(audit).toContainEqual({
      organization_id: parent.id,
      action: 'scim_group.created',
      actor_type: 'scim_token',
      actor_id: token.id,
      credential_type: 'none',
      details: {},
    })
    expect(audit.filter((event) => event.action === 'scim_group.created')).toHaveLength(1)
  })

  it('lists only active scoped Groups, including equal names, with stable paging', async () => {
    const parent = await team('Scope parent')
    const first = await team('First child')
    const second = await team('Second child')
    const hidden = await team('Hidden child')
    const pending = await team('Pending child')
    const retired = await team('Former child')
    const otherParent = await team('Other parent')
    const otherChild = await team('Other child')
    const token = await issue(parent.id)
    const otherToken = await issue(otherParent.id)
    const retiredMapping = await reserve(token, retired.id, 'retired-id')
    const suspendedMapping = await reserve(token, hidden.id, 'suspended-id')
    const pendingMapping = await reserve(token, pending.id, 'pending-id')
    await reserve(token, first.id, 'First-ID')
    await reserve(token, second.id, 'Second-ID')
    await reserve(otherToken, otherChild.id, 'First-ID')
    const a = await create(token, groupBody('First-ID', 'Directory Name'))
    const b = await create(token, groupBody('Second-ID', 'Directory Name'))
    const h = await create(token, groupBody('suspended-id', 'Directory Name'))
    const r = await create(token, groupBody('retired-id', 'Directory Name'))
    const foreign = await create(otherToken, groupBody('First-ID', 'Directory Name'))
    await db
      .updateTable('scim_team_mappings')
      .set({ suspended_at: sql`clock_timestamp()` })
      .where('id', '=', suspendedMapping)
      .execute()
    await db
      .updateTable('scim_team_mappings')
      .set({ retired_at: sql`clock_timestamp()` })
      .where('id', '=', retiredMapping)
      .execute()

    const all = await call(
      app,
      token,
      `Groups${query({ filter: 'DISPLAYNAME EQ "directory name"' })}`,
    )
    expect(all.status).toBe(200)
    const ordered = [a, b].sort((left, right) => left.id.localeCompare(right.id))
    expect(await all.json()).toEqual({
      schemas: [LIST],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: ordered,
    })
    const page = await call(app, token, 'Groups?startIndex=2&count=1')
    expect(await page.json()).toEqual({
      schemas: [LIST],
      totalResults: 2,
      itemsPerPage: 1,
      startIndex: 2,
      Resources: ordered.slice(1),
    })
    const totals = await call(app, token, 'Groups?count=0')
    expect(await totals.json()).toEqual({
      schemas: [LIST],
      totalResults: 2,
      itemsPerPage: 0,
      startIndex: 1,
      Resources: [],
    })
    for (const [externalId, expected] of [
      ['First-ID', [a]],
      ['first-id', []],
    ] as const) {
      const result = await call(
        app,
        token,
        `Groups${query({ filter: `${GROUP}:externalId eq "${externalId}"` })}`,
      )
      expect(await result.json()).toMatchObject({
        totalResults: expected.length,
        Resources: expected,
      })
    }
    await expectError(
      await call(app, token, `Groups${query({ filter: 'userName eq "hidden"' })}`),
      400,
      'invalidFilter',
    )
    await expectError(await call(app, token, 'Groups?count=bogus'), 400, 'invalidValue')

    const unknown = await expectError(await call(app, token, `Groups/${randomUUID()}`), 404)
    for (const id of [foreign.id, h.id, r.id, pendingMapping, first.id, a.id.toUpperCase()]) {
      expect(await expectError(await call(app, token, `Groups/${id}`), 404)).toBe(unknown)
    }
    const crossTeam = await call(app, token, `Groups/${a.id}`, { organizationId: first.id })
    await expectError(crossTeam, 401)
    expect(crossTeam.headers.get('WWW-Authenticate')).toBe('Bearer')
    for (const method of ['PUT', 'PATCH']) {
      // Even a malformed request for an unknown or unavailable Group gets the same 404.
      for (const id of [randomUUID(), foreign.id, h.id, r.id, pendingMapping]) {
        const refused = await call(app, token, `Groups/${id}`, { method, body: {} })
        expect(await expectError(refused, 404)).toBe(unknown)
      }
    }
    await expectError(await call(app, token, `Groups/${a.id}`, { method: 'DELETE' }), 404)
  })

  it('projects only directory-managed members of the mapped child', async () => {
    const managed = await createTestUser(db, 'Directory-managed test member')
    const manual = await createTestUser(db, 'Manual test member')
    const sibling = await createTestUser(db, 'Sibling-only managed test member')
    const parent = await team('Roster parent', [managed, manual, sibling])
    const foreignParent = await team('Second roster directory', [managed])
    const child = await team('Roster child', [managed, manual])
    const otherChild = await team('Sibling child', [sibling])
    const token = await issue(parent.id)
    const foreignToken = await issue(foreignParent.id)
    const managedId = await linkedUser(token, managed)
    await linkedUser(token, manual)
    const siblingId = await linkedUser(token, sibling)
    await linkedUser(foreignToken, managed)
    const mapped = await reserve(token, child.id, 'roster-main')
    const other = await reserve(token, otherChild.id, 'roster-other')
    const group = await create(token, groupBody('roster-main', 'Main roster'))
    await create(token, groupBody('roster-other', 'Other roster'))
    await markManaged(mapped, child.id, managed, managedId)
    await markManaged(other, otherChild.id, sibling, siblingId)

    const location = `${base(parent.id)}/Users/${managedId}`
    const path = `Groups/${group.id}`
    const response = await call(app, token, path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...group,
      members: [{ value: managedId, $ref: location, type: 'User' }],
    })
    const projected = await call(app, token, `${path}?attributes=members.value`)
    expect(await projected.json()).toEqual({
      schemas: [GROUP],
      id: group.id,
      displayName: group.displayName,
      members: [{ value: managedId }],
    })
    const excluded = await call(
      app,
      token,
      `Groups${query({ filter: 'externalId eq "roster-main"', excludedAttributes: 'members,id,displayName' })}`,
    )
    expect(await excluded.json()).toEqual({
      schemas: [LIST],
      totalResults: 1,
      itemsPerPage: 1,
      startIndex: 1,
      Resources: [group],
    })

    // The later lifecycle step removes the child membership on retirement. A retained
    // membership here still belongs to its original resource, even after a new claim.
    await db
      .updateTable('scim_users')
      .set({ active: false, retired_at: sql`clock_timestamp()` })
      .where('id', '=', managedId)
      .execute()
    expect(await linkedUser(token, managed)).not.toBe(managedId)
    const reclaimed = await call(app, token, path)
    expect(reclaimed.status).toBe(200)
    expect(await reclaimed.json()).toEqual(group)
  })

  it('refuses nested Group members before consuming the reservation', async () => {
    const user = await createTestUser(db, 'Eligible directory member')
    const parent = await team('Nesting parent', [user])
    const child = await team('Nesting child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'nesting-reservation')
    const id = await linkedUser(token, user)

    // A valid User ID ensures the declared Group type is what causes this refusal.
    await expectError(
      await call(app, token, 'Groups', {
        method: 'POST',
        body: groupBody('nesting-reservation', 'Nested attempt', [{ value: id, type: 'gRoUp' }]),
      }),
      400,
      'invalidValue',
    )
    expect(await scopedRows(mapping)).toEqual([])
    expect(await storedName(child.id)).toBe('Nesting child')
    const value = await create(
      token,
      groupBody('nesting-reservation', 'Direct Users', [{ value: id }]),
    )
    expect(value).toMatchObject({
      members: [{ value: id, $ref: `${base(parent.id)}/Users/${id}`, type: 'User' }],
    })
    const managed = await db
      .selectFrom('scim_team_managed_memberships as managed')
      .innerJoin('auth.member as member', 'member.id', 'managed.member_id')
      .select(['managed.user_id', 'managed.member_id', 'managed.scim_user_id', 'member.role'])
      .where('mapping_id', '=', mapping)
      .execute()
    expect(managed).toEqual([
      {
        user_id: user.id,
        member_id: await memberId(child.id, user),
        scim_user_id: id,
        role: 'member',
      },
    ])
  })

  it('preserves existing manual memberships and child admission blockers on create', async () => {
    const eligible = await createTestUser(db, 'Eligible test member')
    const manual = await createTestUser(db, 'Existing manual test member')
    const blocked = await createTestUser(db, 'Locally blocked test member')
    const parent = await team('Conflict parent', [eligible, manual, blocked])
    const child = await team('Conflict child', [manual])
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'conflict-reservation')
    const first = await linkedUser(token, eligible)
    const existing = await linkedUser(token, manual)
    const forbidden = await linkedUser(token, blocked)
    // Exercise a retained mailbox-only local blocker, after its original account has departed.
    await db
      .insertInto('scim_membership_blocks')
      .values({
        organization_id: child.id,
        identity_email: blocked.email,
        source: 'local',
        kind: 'removal',
      })
      .execute()
    const listMembers = () =>
      db
        .selectFrom('auth.member')
        .select(['id', 'role', 'userId'])
        .where('organizationId', '=', child.id)
        .orderBy('id')
        .execute()
    const before = await listMembers()
    const request = (value: string) =>
      call(app, token, 'Groups', {
        method: 'POST',
        body: groupBody('conflict-reservation', 'Must not be set', [{ value: first }, { value }]),
      })

    const conflict = await request(existing)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      schemas: [ERROR],
      status: '409',
      detail: expect.any(String),
    })
    const denied = await expectError(await request(forbidden), 403)
    expect(denied).not.toContain(blocked.email)
    expect(await scopedRows(mapping)).toEqual([])
    expect(await listMembers()).toEqual(before)
    expect(await storedName(child.id)).toBe('Conflict child')
  })

  it('rolls back activation, rename and initial members when the creation audit fails', async () => {
    const user = await createTestUser(db, 'Atomic Group test member')
    const parent = await team('SCIM audit failure parent', [user])
    const child = await team('Atomic Group child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'atomic-reservation')
    const id = await linkedUser(token, user)
    await sql`CREATE FUNCTION test_refuse_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_group.created' AND EXISTS (
          SELECT 1 FROM auth.organization WHERE id = NEW.organization_id AND name = 'SCIM audit failure parent'
        ) THEN RAISE EXCEPTION 'injected SCIM Group audit failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_group_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_group_audit()`.execute(db)

    const response = await call(app, token, 'Groups', {
      method: 'POST',
      body: groupBody('atomic-reservation', 'Uncommitted name', [{ value: id }]),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      schemas: [ERROR],
      status: '500',
      detail: 'SCIM request could not be processed.',
    })
    expect(await scopedRows(mapping)).toEqual([])
    expect(await storedName(child.id)).toBe('Atomic Group child')
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', child.id)
        .where('userId', '=', user.id)
        .execute(),
    ).toEqual([])
  })

  it('lets the child owner rename before activation and after directory authority stops', async () => {
    const parent = await team('Name authority parent')
    const child = await team('Name authority child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'name-authority')
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret: signingSecret },
        {
          userId: child.owner.id,
          organizationId: child.id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const rename = (name: string) =>
      app.request(`${publicUrl}/api/auth/organization/update`, {
        method: 'POST',
        headers: {
          cookie: session.cookie.split(';')[0] ?? '',
          origin: publicUrl,
          'content-type': 'application/json',
          'x-expected-organization-id': child.id,
        },
        body: JSON.stringify({ organizationId: child.id, data: { name } }),
      })
    expect((await rename('Owner before activation')).status).toBe(200)
    await create(token, groupBody('name-authority', 'Directory name'))
    const refused = await rename('Owner during provisioning')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'scim_managed_resource' })
    expect(await storedName(child.id)).toBe('Directory name')
    await db
      .updateTable('scim_team_mappings')
      .set({ suspended_at: sql`clock_timestamp()` })
      .where('id', '=', mapping)
      .execute()
    expect((await rename('Owner after suspension')).status).toBe(200)
    expect(await storedName(child.id)).toBe('Owner after suspension')
  })

  it('requires a replacement name, preserves the reservation and ignores read-only PUT echoes', async () => {
    const parent = await team('Replacement parent')
    const child = await team('Replacement child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'Fixed-Identifier')
    const original = await create(token, groupBody('Fixed-Identifier', 'Initial replacement name'))
    const path = `Groups/${original.id}`
    const before = await scopedRows(mapping)
    const replace = (body: object) => call(app, token, path, { method: 'PUT', body })

    await expectError(await replace({ schemas: [GROUP] }), 400, 'invalidValue')
    for (const externalId of ['fixed-identifier', null]) {
      await expectError(
        await replace({ ...groupBody('Fixed-Identifier', 'Refused replacement'), externalId }),
        400,
        'mutability',
      )
    }
    await expectError(
      await call(app, token, path, {
        method: 'PUT',
        headers: { 'if-match': '*' },
        body: groupBody('Fixed-Identifier', 'Conditional replacement'),
      }),
      412,
    )
    expect(await scopedRows(mapping)).toEqual(before)
    expect(await updateEvents(original.id)).toEqual([])

    const body = {
      schemas: [GROUP],
      DISPLAYNAME: '  Full replacement name  ',
      id: randomUUID(),
      meta: { created: 'untrusted creation time', location: 'untrusted location' },
    }
    const replacement = await replace(body)
    expect(replacement.status).toBe(200)
    expect(replacement.headers.get('content-type')).toBe('application/scim+json')
    const updated = await replacement.json()
    expect(updated).toMatchObject({
      schemas: [GROUP],
      id: original.id,
      externalId: 'Fixed-Identifier',
      displayName: 'Full replacement name',
      meta: { resourceType: 'Group', location: `${base(parent.id)}/${path}` },
    })
    const [after] = await scopedRows(mapping)
    expect(after).toEqual({ ...before[0], updated_at: expect.any(Date) })
    expect(after?.updated_at).not.toEqual(before[0]?.updated_at)
    expect(await (await call(app, token, path)).json()).toEqual(updated)
    expect(await (await replace({ ...body, externalId: 'Fixed-Identifier' })).json()).toEqual(
      updated,
    )
    expect(await updateEvents(original.id)).toEqual([
      {
        organization_id: parent.id,
        actor_type: 'scim_token',
        actor_id: token.id,
        credential_type: 'none',
        details: {},
      },
    ])
  })

  it('applies name PATCH operations in order and rejects mixed role or member requests atomically', async () => {
    const parent = await team('Patch parent')
    const child = await team('Patch child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'patch-reservation')
    const original = await create(token, groupBody('patch-reservation', 'Initial patch name'))
    const path = `Groups/${original.id}`
    const patch = (...operations: object[]) =>
      call(app, token, path, { method: 'PATCH', body: patchBody(...operations) })
    const first = { op: 'RePlAcE', path: `${GROUP}:DISPLAYNAME`, value: 'Intermediate name' }
    const rename = { op: 'add', value: { displayName: '  Final patch name  ' } }
    const keepExternalId = { op: 'replace', path: 'externalId', value: 'patch-reservation' }
    const changed = await patch(first, rename, keepExternalId)
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      id: original.id,
      externalId: 'patch-reservation',
      displayName: 'Final patch name',
    })

    const before = await scopedRows(mapping)
    for (const operation of [
      { op: 'add', path: 'Members', value: [{ value: randomUUID(), roles: ['owner'] }] },
      { op: 'replace', value: { displayName: 'Pathless rejected name', RoLeS: ['owner'] } },
      { op: 'replace', path: `${GROUP}:mEmBeRs[value eq "${randomUUID()}"].role`, value: 'owner' },
      { op: 'replace', path: 'members.role', value: 'owner' },
    ]) {
      await expectError(await patch(first, operation), 403, 'mutability')
    }
    await expectError(
      await patch(first, { op: 'add', path: 'members', value: [{ value: randomUUID() }] }),
      400,
      'invalidValue',
    )
    await expectError(await patch(first, { op: 'remove', path: 'externalId' }), 400, 'mutability')
    await expectError(await patch(first, { op: 'remove', path: 'displayName' }), 400, 'mutability')
    await expectError(
      await patch(first, { op: 'replace', path: 'slug', value: 'private' }),
      400,
      'invalidPath',
    )
    expect(await storedName(child.id)).toBe('Final patch name')
    expect(await scopedRows(mapping)).toEqual(before)
    expect(await updateEvents(original.id)).toHaveLength(1)
  })

  it('renames to a shared name without consulting an unrelated tenant', async () => {
    const parent = await team('Group name parent')
    const child = await team('Mapped child')
    const manualName = 'Private manual name'
    const manual = await team(manualName)
    const sibling = await team('Mapped sibling')
    const token = await issue(parent.id)
    const externalId = 'name-collision'
    await reserve(token, child.id, externalId)
    await reserve(token, sibling.id, 'another-name')
    const original = await create(token, groupBody(externalId, 'Before name collision'))
    await create(token, groupBody('another-name', 'Shared managed name'))
    const path = `Groups/${original.id}?attributes=externalId`

    async function rename(method: 'PUT' | 'PATCH', name: string) {
      const value = `  ${name}  `
      const body =
        method === 'PUT'
          ? groupBody(externalId, value)
          : patchBody({ op: 'replace', path: 'displayName', value })
      const queries = vi.spyOn(pg.Client.prototype, 'query')
      try {
        const response = await call(app, token, path, { method, body })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/scim+json')
        expect(await response.json()).toEqual({
          schemas: [GROUP],
          id: original.id,
          displayName: name,
          externalId,
        })
        // The proposed name appears only in the write to the authorized child.
        const nameStatements = queries.mock.calls.filter(
          ([, parameters]: readonly unknown[]) =>
            Array.isArray(parameters) && parameters.includes(name),
        )
        expect(nameStatements).toEqual([
          ['update "auth"."organization" set "name" = $1 where "id" = $2', [name, child.id]],
        ])
        return queries.mock.calls.map(([statement]) => statement)
      } finally {
        queries.mockRestore()
      }
    }

    for (const method of ['PUT', 'PATCH'] as const) {
      const shared = await rename(method, manualName)
      expect(await storedName(child.id)).toBe(manualName)
      expect(await rename(method, `Unused ${method} name`)).toEqual(shared)
    }
    expect(await storedName(manual.id)).toBe(manualName)
    await rename('PATCH', 'Shared managed name')
    expect(await storedName(child.id)).toBe('Shared managed name')
    expect(await storedName(sibling.id)).toBe('Shared managed name')
  })

  it('refuses changes to a protected roster and role grants without disclosing manual membership', async () => {
    const admin = await createTestUser(db, 'Promoted directory member')
    const ordinary = await createTestUser(db, 'Ordinary directory member')
    const manual = await createTestUser(db, 'Manual directory-linked member')
    const parent = await team('Protected roster parent', [admin, ordinary, manual])
    const child = await team('Protected roster child', [manual])
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'protected-roster')
    const adminId = await linkedUser(token, admin)
    const ordinaryId = await linkedUser(token, ordinary)
    const manualId = await linkedUser(token, manual)
    const original = await create(
      token,
      groupBody('protected-roster', 'Original roster name', [
        { value: adminId },
        { value: ordinaryId },
      ]),
    )
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', await memberId(child.id, admin))
      .execute()
    const path = `Groups/${original.id}`
    const before = await scopedRows(mapping)
    const childMembers = () =>
      db
        .selectFrom('auth.member')
        .select(['id', 'role'])
        .where('organizationId', '=', child.id)
        .orderBy('id')
        .execute()
    const roster = await childMembers()
    const replace = (members: object[]) =>
      call(app, token, path, {
        method: 'PUT',
        body: groupBody('protected-roster', 'Attempted roster replacement', members),
      })

    await expectError(await replace([{ value: ordinaryId }]), 403, 'mutability')
    await expectError(
      await replace([{ value: adminId, role: 'member' }, { value: ordinaryId }]),
      403,
      'mutability',
    )
    await expectError(
      await replace([{ value: adminId }, { value: ordinaryId, roles: ['owner'] }]),
      403,
      'mutability',
    )
    await expectError(
      await call(app, token, path, {
        method: 'PUT',
        body: { ...groupBody('protected-roster', 'Attempted grant'), roles: ['owner'] },
      }),
      403,
      'mutability',
    )
    await expectError(
      await call(app, token, path, {
        method: 'PATCH',
        body: patchBody({ op: 'remove', path: `members[value eq "${adminId}"]` }),
      }),
      403,
      'mutability',
    )
    expect(await storedName(child.id)).toBe(original.displayName)
    expect(await scopedRows(mapping)).toEqual(before)
    expect(await childMembers()).toEqual(roster)
    expect(await updateEvents(original.id)).toEqual([])

    const renamed = await replace([
      { value: ordinaryId },
      { value: adminId, $ref: `/Users/${adminId}` },
    ])
    expect(renamed.status).toBe(200)
    const result = await renamed.json()
    expect(result).toMatchObject({
      displayName: 'Attempted roster replacement',
      members: [adminId, ordinaryId].sort().map((value) => ({
        value,
        type: 'User',
        $ref: `${base(parent.id)}/Users/${value}`,
      })),
    })
    expect(JSON.stringify(result)).not.toContain(child.owner.id)
    expect(JSON.stringify(result)).not.toContain(manualId)
    const omitted = await call(app, token, path, {
      method: 'PUT',
      body: groupBody('protected-roster', 'Attempted roster replacement'),
    })
    expect(omitted.status).toBe(200)
    expect(await omitted.json()).toEqual(result)
    expect(await childMembers()).toEqual(roster)
  })

  it('rolls back the Group timestamp and child name when the update audit fails', async () => {
    const parent = await team('SCIM Group update audit failure parent')
    const child = await team('SCIM Group update audit child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'atomic-update')
    const original = await create(token, groupBody('atomic-update', 'Committed Group name'))
    const before = await scopedRows(mapping)
    await sql`CREATE FUNCTION test_refuse_group_update_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'scim_group.updated' AND EXISTS (
          SELECT 1 FROM auth.organization WHERE id = NEW.organization_id
            AND name = 'SCIM Group update audit failure parent'
        ) THEN RAISE EXCEPTION 'injected SCIM Group audit failure'; END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER test_refuse_group_update_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_group_update_audit()`.execute(db)

    const response = await call(app, token, `Groups/${original.id}`, {
      method: 'PATCH',
      body: patchBody({ op: 'replace', path: 'displayName', value: 'Uncommitted update name' }),
    })
    await expectError(response, 500)
    expect(await storedName(child.id)).toBe(original.displayName)
    expect(await scopedRows(mapping)).toEqual(before)
    expect(await updateEvents(original.id)).toEqual([])
  })

  it('rechecks mapping authority after waiting behind the team locks', async () => {
    const parent = await team('Concurrent mapping parent')
    const child = await team('Concurrent mapping child')
    const token = await issue(parent.id)
    const mapping = await reserve(token, child.id, 'concurrent-mapping')
    const original = await create(token, groupBody('concurrent-mapping', 'Before suspension'))
    let pending: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', 'in', [parent.id, child.id])
          .orderBy('id')
          .forUpdate()
          .execute()
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        const pid = rows[0]?.pid
        pending = Promise.resolve(
          call(app, token, `Groups/${original.id}`, {
            method: 'PUT',
            body: groupBody('concurrent-mapping', 'Name denied after suspension'),
          }),
        )
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
        await trx
          .updateTable('scim_team_mappings')
          .set({ suspended_at: sql`clock_timestamp()` })
          .where('id', '=', mapping)
          .execute()
      })
    } finally {
      await pending?.catch(() => {})
    }
    if (!pending) throw new Error('The concurrent SCIM request must finish.')
    await expectError(await pending, 404)
    expect(await storedName(child.id)).toBe(original.displayName)
    expect(await updateEvents(original.id)).toEqual([])
  })

  it.each([false, true])(
    'enforces the production switch for Group and discovery routes (%s)',
    async (enabled) => {
      const detail = 'SCIM provisioning is disabled.'
      const parent = await team('Production assembly parent')
      const child = await team('Production assembly child')
      const token = await issue(parent.id)
      await reserve(token, child.id, 'production-reservation')
      const value = await create(
        token,
        groupBody('production-reservation', 'Production-invisible Group'),
      )
      const config = loadConfig({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: signingSecret,
        PUBLIC_URL: publicUrl,
        SCIM_PROVISIONING_ENABLED: String(enabled),
      })
      const unexpected = async (): Promise<never> =>
        expect.unreachable('Unexpected SCIM collaborator')
      const production = createApp(
        productionAppOptions({
          config,
          db,
          auth: { handler: unexpected },
          resolveCaller: unexpected,
          resolveMcpOAuth: unexpected,
          checkDb: unexpected,
          waitlist: { verify: unexpected, remove: unexpected },
          invitationMailLimits: { secret: signingSecret },
          webhookSettings: { enabled: config.WEBHOOKS_ENABLED },
          webhookQueue: { enqueue: unexpected },
          notify: unexpected,
          notifyAttendeeNoShow: unexpected,
          googleCalendar: undefined,
          microsoftCalendar: undefined,
          zoomConference: undefined,
          enqueueCalendarSync: unexpected,
          enqueueCalendarWritebackRecovery: unexpected,
          mailboxProofQueue: { enqueue: unexpected },
          scimMappingNotices: { enqueue: async () => randomUUID() },
          enqueueScimInvitation: unexpected,
        }),
      )
      const expected = JSON.stringify({ schemas: [ERROR], status: '404', detail })
      for (const path of [
        'ServiceProviderConfig',
        'ResourceTypes',
        'ResourceTypes/User',
        'ResourceTypes/Group',
        'Schemas',
        'Schemas/urn:ietf:params:scim:schemas:core:2.0:User',
        `Schemas/${encodeURIComponent(GROUP)}`,
        'Groups',
        `Groups/${value.id}`,
      ]) {
        const response = await call(production, token, path)
        expect(response.status, path).toBe(enabled ? 200 : 404)
        expect(response.headers.get('content-type')).toBe('application/scim+json')
        if (!enabled) expect(await response.text(), path).toBe(expected)
      }
      const anotherChild = await team('Another production child')
      await reserve(token, anotherChild.id, 'production-post')
      const posted = await call(production, token, 'Groups', {
        method: 'POST',
        body: groupBody('production-post', 'Production post'),
      })
      expect(posted.status).toBe(enabled ? 201 : 404)
      if (!enabled) expect(await posted.text()).toBe(expected)
      const path = `Groups/${value.id}`
      for (const [method, body] of [
        ['PUT', groupBody('production-reservation', 'PUT name not applied')],
        [
          'PATCH',
          patchBody({ op: 'replace', path: 'displayName', value: 'PATCH name not applied' }),
        ],
        ['PATCH', patchBody({ op: 'remove', path: 'members' })],
      ] as const) {
        const response = await call(production, token, path, { method, body })
        expect(response.status, method).toBe(enabled ? 200 : 404)
        expect(response.headers.get('content-type')).toBe('application/scim+json')
        if (!enabled) expect(await response.text(), method).toBe(expected)
      }
      expect(await storedName(child.id)).toBe(
        enabled ? 'PATCH name not applied' : value.displayName,
      )
      const retired = await call(production, token, path, { method: 'DELETE' })
      expect(retired.status).toBe(enabled ? 204 : 404)
      if (!enabled) expect(await retired.text()).toBe(expected)
      expect((await call(production, token, path)).status).toBe(404)
    },
  )
})
