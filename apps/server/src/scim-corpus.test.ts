import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { OpenAPIHono } from '@hono/zod-openapi'
import { createDb, type Db, type ScimUsers } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import type { Insertable } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mountScim } from './scim.ts'
import { scimDiscoveryWithGroups } from './scim-discovery-fixture.ts'
import { scimGroups } from './scim-groups.ts'
import { scimUserCreation } from './scim-user-create.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUsers } from './scim-users.ts'

// Keep the protocol identifiers independent of the implementation.
const userSchema = 'urn:ietf:params:scim:schemas:core:2.0:User'
const groupSchema = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const enterpriseSchema = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const listSchema = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const patchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const errorSchema = 'urn:ietf:params:scim:api:messages:2.0:Error'
const mime = 'application/scim+json'
const origin = 'https://scim-corpus.example'
const databaseUrl = process.env.DATABASE_URL
const privateValue = 'synthetic-private-marker'
const workPath = 'emails[type eq "work"].value'
const employeeNumber = `${enterpriseSchema}:employeeNumber`
const entraAddress = 'entra-work@directory.example'

type Scope = { organizationId: string; connectionId: string; bearer: string }
type Json = Record<string, unknown>
type User = Json & { id: string; userName: string; meta: Json }
type Group = { id: string; members?: { value: string }[] }
type Operation = { op: string; path?: string; value?: unknown }
const patch = (...Operations: Operation[]) => ({ schemas: [patchSchema], Operations })
const filter = (expression: string) => new URLSearchParams({ filter: expression }).toString()
const members = (...ids: string[]) => ids.map((value) => ({ value }))

// Scheduled request shapes and the on-demand flag exception in Microsoft's compatibility guide.
// https://learn.microsoft.com/en-us/entra/identity/app-provisioning/application-provisioning-config-problem-scim-compatibility
const entraLegacyProfile = patch(
  { op: 'Replace', path: workPath, value: entraAddress },
  { op: 'Replace', path: 'name.givenName', value: 'Ravi' },
  { op: 'Replace', path: employeeNumber, value: '42' },
)
const entraLegacyDisable = patch({ op: 'Replace', path: 'active', value: 'False' })
const entraFixtures = [
  { mode: 'scheduled legacy', profile: entraLegacyProfile, disable: entraLegacyDisable },
  {
    mode: 'scheduled compliant',
    profile: patch(
      { op: 'replace', path: workPath, value: entraAddress },
      { op: 'replace', value: { 'name.givenName': 'Ravi', [employeeNumber]: '42' } },
    ),
    disable: patch({ op: 'replace', path: 'active', value: false }),
  },
  {
    mode: 'on-demand with legacy operations',
    profile: patch(
      ...entraLegacyProfile.Operations,
      { op: 'Add', path: 'nickName', value: 'First' },
      { op: 'Remove', path: 'nickName' },
      { op: 'Add', path: 'nickName', value: 'Last' },
    ),
    disable: entraLegacyDisable,
    nickName: 'Last',
  },
]

async function responseBody<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status)
  expect(response.headers.get('Content-Type')).toBe(mime)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return (await response.json()) as T
}

// RFC 7644 §§3.4.2 and 3.12: Lists and Errors have their own message schema.
async function expectList(response: Response, Resources: Json[], totalResults = Resources.length) {
  expect(await responseBody(response)).toEqual({
    schemas: [listSchema],
    totalResults,
    itemsPerPage: Resources.length,
    startIndex: 1,
    Resources,
  })
}

async function expectError(response: Response, status: number, scimType?: string) {
  const body = await responseBody(response, status)
  expect(body).toEqual({
    schemas: [errorSchema],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail: expect.any(String),
  })
  expect(JSON.stringify(body)).not.toContain(privateValue)
  return body
}

async function groupSourceCopy(mutation?: { from: string; to: string }) {
  const location = new URL('./scim-groups.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    const { from, to } = mutation
    expect(source.indexOf(from)).toBeGreaterThanOrEqual(0)
    expect(source.indexOf(from)).toBe(source.lastIndexOf(from))
    source = source.replace(from, to)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  ) as Promise<typeof import('./scim-groups.ts')>
}

describe.skipIf(!databaseUrl)('SCIM RFC and provider HTTP corpus', () => {
  let owned: TestDatabase
  let db: Db
  let app: OpenAPIHono

  function mount(groups = scimGroups) {
    const harness = new OpenAPIHono()
    const group = groups(db)
    const create = scimUserCreation({ db, signup: { mode: 'open', allowedDomains: [] } })
    const replace = scimUserReplacement(db)
    const read = scimUsers(db)
    mountScim(
      harness,
      {
        db,
        enabled: true,
        resources: (request) =>
          scimDiscoveryWithGroups(request) ??
          group(request) ??
          create(request) ??
          replace(request) ??
          read(request),
      },
      [],
      origin,
    )
    return harness
  }

  beforeAll(async () => {
    // All mounted variants share this one bounded fixture pool. HTTP runs in process.
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_corpus' })
    db = createDb(owned.pool)
    app = mount()
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function directory(): Promise<Scope> {
    const organizationId = await createFixtures(db).organization()
    const bearer = `scim_${randomBytes(32).toString('base64url')}`
    const { id } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic provider',
        token_hash: createHash('sha256').update(bearer).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { connection_id: connectionId } = await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', id)
      .executeTakeFirstOrThrow()
    return { organizationId, connectionId, bearer }
  }

  function seedUser(scope: Scope, fields: Partial<Insertable<ScimUsers>> = {}) {
    return db
      .insertInto('scim_users')
      .values({
        organization_id: scope.organizationId,
        connection_id: scope.connectionId,
        user_name: `fixture-${randomUUID()}`,
        ...fields,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  async function seedLinkedUser(scope: Scope) {
    const fixture = createFixtures(db)
    const accountId = await fixture.user('Local account')
    await fixture.member(accountId, scope.organizationId)
    const { id: memberId } = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', scope.organizationId)
      .where('userId', '=', accountId)
      .executeTakeFirstOrThrow()
    const { id } = await seedUser(scope, { linked_user_id: accountId, linked_member_id: memberId })
    return { id, accountId, memberId }
  }

  function client(scope: Scope, harness = app) {
    const base = `${origin}/scim/v2/${scope.organizationId}`
    return (
      path: string,
      method = 'GET',
      body?: object | string,
      headers: Record<string, string> = {},
    ) =>
      harness.request(`${base}/${path}`, {
        method,
        headers: { authorization: `Bearer ${scope.bearer}`, 'content-type': mime, ...headers },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      })
  }

  const updates = (id: string) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'details'])
      .where('target_id', '=', id)
      .where('action', 'in', ['scim_user.updated', 'scim_group.updated'])
      .execute()

  it('matches scoped identities with RFC attribute casing, JSON escaping and count=0', async () => {
    const own = await directory()
    const foreign = await directory()
    const externalId = 'Correlation-"Quoted"\\Müller'
    const userName = 'Case.User@directory.example'
    const { id } = await seedUser(own, {
      user_name: userName,
      external_id: externalId,
      active: false,
    })
    await seedUser(foreign, { user_name: userName, external_id: externalId })
    const send = client(own)
    expect(await responseBody(await send('ServiceProviderConfig'))).toMatchObject({
      filter: { supported: true, maxResults: 100 },
      patch: { supported: true },
      etag: { supported: false },
    })
    const query = (expression: string) => `Users?${filter(expression)}&attributes=active`
    const projected = { schemas: [userSchema], id, userName, active: false }
    await expectList(await send(query('USERNAME Eq " case.user@directory.example "')), [projected])
    const externalMatch = query(`${userSchema}:EXTERNALID eQ ${JSON.stringify(externalId)}`)
    await expectList(await send(externalMatch), [projected])
    await expectList(await send(`${externalMatch}&count=0`), [], 1)
    await expectList(
      await send(query(`externalId eq ${JSON.stringify(externalId.toLowerCase())}`)),
      [],
    )

    const { id: privateId } = await seedUser(foreign, { user_name: privateValue })
    await expectList(await send(query(`userName eq "${privateValue}"`)), [])
    const missing = await expectError(await send(`Users/${randomUUID()}`), 404)
    expect(await expectError(await send(`Users/${privateId}`), 404)).toEqual(missing)
    const wrongTeam = client({ ...foreign, bearer: own.bearer })
    const unauthorized = await wrongTeam(`Users/${privateId}`)
    expect(unauthorized.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(JSON.stringify(await expectError(unauthorized, 401))).not.toContain(own.bearer)
  })

  it('returns RFC errors through HTTP and rolls back the preceding valid PATCH operations', async () => {
    const scope = await directory()
    const send = client(scope)
    const { id } = await seedUser(scope, { title: 'Original title' })
    const path = `Users/${id}`
    const original = await responseBody(await send(path))
    for (const expression of [
      `userName co "${privateValue}"`,
      `emails.value eq "${privateValue}"`,
      `userName eq "${privateValue}" or userName pr`,
      `userName eq ${privateValue}`,
    ])
      await expectError(await send(`Users?${filter(expression)}`), 400, 'invalidFilter')
    await expectError(
      await send(`Users?${filter(`userName eq "${privateValue}"`)}&filter=userName`),
      400,
      'invalidFilter',
    )
    await expectError(
      await send('Users?attributes=active&excludedAttributes=active'),
      400,
      'invalidValue',
    )
    await expectError(await send(path, 'PATCH', `{"${privateValue}":`), 400, 'invalidSyntax')
    await expectError(await send(path, 'PATCH', patch(), { 'If-Match': '*' }), 412)
    const preceding = { op: 'replace', path: 'title', value: privateValue }
    const failures: [Operation, number, string][] = [
      [{ op: 'replace', path: privateValue, value: 'ignored' }, 400, 'invalidPath'],
      [{ op: 'remove', path: workPath }, 400, 'noTarget'],
      [{ op: 'remove', path: 'userName' }, 400, 'mutability'],
      [{ op: 'replace', path: 'active', value: privateValue }, 400, 'invalidValue'],
      [{ op: 'add', path: 'roles', value: [{ value: privateValue }] }, 403, 'mutability'],
    ]
    for (const [operation, status, scimType] of failures) {
      await expectError(await send(path, 'PATCH', patch(preceding, operation)), status, scimType)
      expect(await responseBody(await send(path))).toEqual(original)
    }
    const duplicate = await seedUser(scope, { user_name: privateValue })
    await expectError(
      await send(
        path,
        'PATCH',
        patch(preceding, { op: 'replace', path: 'userName', value: privateValue }),
      ),
      409,
      'uniqueness',
    )
    await expectError(
      await send('Users', 'POST', { schemas: [userSchema], userName: privateValue, active: false }),
      409,
      'uniqueness',
    )
    expect(await responseBody(await send(path))).toEqual(original)
    expect(await updates(id)).toEqual([])
    expect(await updates(duplicate.id)).toEqual([])
  })

  it('replays the Okta GET and full User PUT without changing the linked account', async () => {
    // https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20#update-a-specific-user-put
    const scope = await directory()
    const { id, accountId, memberId } = await seedLinkedUser(scope)
    const send = client(scope)
    const path = `Users/${id}`
    await db.updateTable('scim_users').set({ title: 'Old title' }).where('id', '=', id).execute()
    const original = await responseBody<User>(await send(path))
    const account = () =>
      db.selectFrom('auth.user').selectAll().where('id', '=', accountId).executeTakeFirstOrThrow()
    const before = await account()
    const address = 'okta-work@directory.example'
    const body = {
      schemas: [userSchema],
      id: original.id,
      userName: original.userName,
      name: { givenName: 'Renée', middleName: 'Andi', familyName: 'Woods' },
      emails: [{ primary: true, value: address, type: 'work', display: address }],
      active: true,
      groups: [],
      meta: original.meta,
    }
    const current = await responseBody<User>(await send(path, 'PUT', body))
    expect(current).toEqual({
      schemas: [userSchema],
      id,
      userName: original.userName,
      name: { givenName: 'Renée', familyName: 'Woods' },
      emails: [{ primary: true, value: address, type: 'work' }],
      active: true,
      meta: { ...original.meta, lastModified: expect.any(String) },
    })
    expect(await responseBody(await send(path, 'PUT', body))).toEqual(current)
    expect(await responseBody(await send(path))).toEqual(current)
    expect(await updates(id)).toEqual([{ action: 'scim_user.updated', details: {} }])
    expect(await account()).toEqual(before)
    expect(
      await db
        .selectFrom('scim_users')
        .select(['linked_user_id', 'linked_member_id'])
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ linked_user_id: accountId, linked_member_id: memberId })
    const deactivated = await responseBody(
      await send(path, 'PATCH', patch({ op: 'replace', value: { active: false } })),
    )
    expect(deactivated).toMatchObject({ active: false })
    expect(await responseBody(await send(path))).toEqual(deactivated)
  })

  it.each(entraFixtures)('replays Entra $mode PATCH', async ({ profile, disable, nickName }) => {
    const scope = await directory()
    const { id } = await seedUser(scope, {
      family_name: 'Original family',
      work_email: 'old@directory.example',
    })
    const send = client(scope)
    const path = `Users/${id}`
    const updated = await responseBody<User>(await send(path, 'PATCH', profile))
    expect(updated).toMatchObject({
      schemas: [userSchema, enterpriseSchema],
      active: true,
      name: { givenName: 'Ravi', familyName: 'Original family' },
      emails: [{ value: entraAddress, type: 'work', primary: true }],
      [enterpriseSchema]: { employeeNumber: '42' },
    })
    expect(updated.nickName).toBe(nickName)
    expect(await responseBody(await send(path, 'PATCH', profile))).toEqual(updated)
    const deactivated = await responseBody(await send(path, 'PATCH', disable))
    expect(deactivated).toEqual({
      ...updated,
      active: false,
      meta: { ...updated.meta, lastModified: expect.any(String) },
    })
    expect(await responseBody(await send(path, 'PATCH', disable))).toEqual(deactivated)
    expect(await responseBody(await send(path))).toEqual(deactivated)
    expect(await updates(id)).toEqual([
      {
        action: 'scim_user.updated',
        details: { operations: profile.Operations.map(({ op }) => op.toLowerCase()) },
      },
    ])
  })

  async function verifyGroupMemberRemoval(harness: OpenAPIHono) {
    const scope = await directory()
    const childId = await createFixtures(db).organization()
    const externalId = `Group-${randomUUID()}`
    const [first, second] = [await seedLinkedUser(scope), await seedLinkedUser(scope)]
    await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: scope.organizationId,
        connection_id: scope.connectionId,
        child_organization_id: childId,
        external_id: externalId,
      })
      .execute()
    const send = client(scope, harness)
    const group = await responseBody<Group>(
      await send('Groups', 'POST', {
        schemas: [groupSchema],
        externalId,
        displayName: 'Directory group',
        members: members(first.id, second.id),
      }),
      201,
    )
    const path = `Groups/${group.id}`
    await expectList(
      await send(`Groups?${filter('DISPLAYNAME eq "directory GROUP"')}&attributes=displayName`),
      [{ schemas: [groupSchema], id: group.id, displayName: 'Directory group' }],
    )
    await expectList(
      await send(`Groups?${filter(`externalId eq "${externalId.toLowerCase()}"`)}`),
      [],
    )
    const legacy = patch({ op: 'Remove', path: 'members', value: members(first.id) })
    const removed = await responseBody<Group>(await send(path, 'PATCH', legacy))
    expect(
      removed.members?.map(({ value }) => value),
      'unmentioned members remain in the Group',
    ).toEqual([second.id])
    const childMembers = await db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', childId)
      .execute()
    expect(childMembers).toEqual([{ userId: second.accountId, role: 'member' }])
    expect(await responseBody(await send(path, 'PATCH', legacy))).toEqual(removed)
    expect(await responseBody(await send(path))).toEqual(removed)
    const compliant = patch({ op: 'remove', path: `members[value eq "${second.id}"]` })
    const empty = await responseBody(await send(path, 'PATCH', compliant))
    expect(empty).not.toHaveProperty('members')
    expect(await responseBody(await send(path, 'PATCH', compliant))).toEqual(empty)
    expect(await updates(group.id)).toHaveLength(2)
  }

  it('scopes legacy Entra Group removal and accepts the standard filtered form', async () => {
    await verifyGroupMemberRemoval(app)
  })

  it('detects a source copy that clears the Group for an Entra value-list removal', async () => {
    const control = await groupSourceCopy()
    await verifyGroupMemberRemoval(mount(control.scimGroups))
    const mutant = await groupSourceCopy({
      from: 'if (hasValue) for (const id of patchMembers(item, base)) roster.delete(id)',
      to: 'if (hasValue) roster.clear()',
    })
    await expect(verifyGroupMemberRemoval(mount(mutant.scimGroups))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('unmentioned members remain in the Group'),
    })
  })
})
