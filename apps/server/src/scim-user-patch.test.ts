import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { createDb, type Db, type ScimUsers } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { type Insertable, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mountScim, SCIM_BODY_LIMIT, SCIM_ERROR_SCHEMA } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUsers } from './scim-users.ts'

const databaseUrl = process.env.DATABASE_URL
const origin = 'https://directory.example'
const patchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const { enterpriseUser: enterprise } = SCIM_URN
const workValue = 'emails[type eq "work"].value'
const oldEmail = 'before@directory.example'
const newEmail = 'after@directory.example'
const privateValue = 'private-fixture@directory.example'
const baseline = new Date('2026-01-01T00:00:00Z')
type Json = Record<string, unknown>
type Scope = { organizationId: string; connectionId: string; tokenId: string; bearer: string }
type Operation = { op: string; path?: string; value?: unknown }

const document = (operations: readonly Operation[]) => ({
  schemas: [patchSchema],
  Operations: operations,
})

async function expectError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('Content-Type')).toBe('application/scim+json')
  const body: unknown = await response.json()
  expect(body).toEqual({
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail: expect.any(String),
  })
  expect(JSON.stringify(body)).not.toContain(privateValue)
  return body
}

describe.skipIf(!databaseUrl)('SCIM User PATCH normalization', () => {
  let owned: TestDatabase
  let db: Db
  let app: OpenAPIHono
  let scope: Scope
  let foreign: Scope

  async function provisionScope(): Promise<Scope> {
    const organizationId = await createFixtures(db).organization()
    const bearer = `scim_${randomBytes(32).toString('base64url')}`
    const { id: tokenId } = await db
      .insertInto('scim_provisioning_tokens')
      .values({
        organization_id: organizationId,
        name: 'Synthetic directory',
        token_hash: createHash('sha256').update(bearer).digest('base64url'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { connection_id: connectionId } = await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', tokenId)
      .executeTakeFirstOrThrow()
    return { organizationId, connectionId, tokenId, bearer }
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_patch' })
    db = createDb(owned.pool)
    scope = await provisionScope()
    foreign = await provisionScope()
    const replace = scimUserReplacement(db)
    const read = scimUsers(db)
    app = new OpenAPIHono()
    mountScim(app, { db, enabled: true, resources: (req) => replace(req) ?? read(req) }, [], origin)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function seed(data: Partial<Insertable<ScimUsers>> = {}, tenant = scope) {
    const { id } = await db
      .insertInto('scim_users')
      .values({
        organization_id: tenant.organizationId,
        connection_id: tenant.connectionId,
        user_name: `fixture-${randomUUID()}`,
        given_name: 'Before Given',
        family_name: 'Before Family',
        title: 'Before Title',
        department: 'Before Department',
        work_email: oldEmail,
        created_at: baseline,
        updated_at: baseline,
        ...data,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  function patch(
    id: string,
    body: Json | string,
    headers: Record<string, string> = {},
    tenant = scope,
  ) {
    return app.request(`${origin}/scim/v2/${tenant.organizationId}/Users/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/scim+json',
        authorization: `Bearer ${tenant.bearer}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  const stored = (id: string) =>
    db.selectFrom('scim_users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  const updates = (id: string) =>
    db
      .selectFrom('audit_events')
      .select(['organization_id', 'actor_type', 'actor_id', 'target_type', 'details'])
      .where('target_id', '=', id)
      .where('action', '=', 'scim_user.updated')
      .orderBy('id')
      .execute()

  const providerCases = [
    {
      name: 'Entra without the feature flag uses explicit Replace paths',
      operations: [
        { op: 'Replace', path: 'displayName', value: 'Directory Profile' },
        { op: 'Replace', path: workValue, value: newEmail },
        { op: 'Replace', path: 'name.givenName', value: 'Synced Given' },
        { op: 'Replace', path: 'name.familyName', value: 'Synced Family' },
        { op: 'Replace', path: 'externalId', value: 'IdP-Correlation' },
        { op: 'Replace', path: `${enterprise}:employeeNumber`, value: '42' },
      ],
      result: {
        displayName: 'Directory Profile',
        name: { givenName: 'Synced Given', familyName: 'Synced Family' },
        externalId: 'IdP-Correlation',
        emails: [{ value: newEmail, type: 'work', primary: true }],
        [enterprise]: { department: 'Before Department', employeeNumber: '42' },
      },
    },
    {
      name: 'Entra with the feature flag uses a dotted and qualified pathless replacement',
      operations: [
        { op: 'replace', path: workValue, value: newEmail },
        {
          op: 'replace',
          value: {
            DISPLAYNAME: 'Directory Profile',
            'NaMe.GiVeNnAmE': 'Synced Given',
            [`${enterprise.toUpperCase()}:EMPLOYEENUMBER`]: '42',
          },
        },
      ],
      result: {
        displayName: 'Directory Profile',
        name: { givenName: 'Synced Given', familyName: 'Before Family' },
        emails: [{ value: newEmail, type: 'work', primary: true }],
        [enterprise]: { department: 'Before Department', employeeNumber: '42' },
      },
    },
    {
      name: 'Entra on-demand applies mixed-case Add and Remove around Replace in order',
      operations: [
        { op: 'Add', path: 'nickName', value: 'First' },
        { op: 'Replace', path: 'NICKNAME', value: 'Second' },
        { op: 'Remove', path: 'nickName' },
        { op: 'Add', value: { nickname: 'Final', name: { givenName: 'Synced Given' } } },
        { op: 'Replace', path: 'eMaIlS[TyPe EQ "WORK"].VaLuE', value: newEmail },
        { op: 'Replace', path: 'AcTiVe', value: 'TrUe' },
      ],
      result: {
        nickName: 'Final',
        name: { givenName: 'Synced Given', familyName: 'Before Family' },
        emails: [{ value: newEmail, type: 'work', primary: true }],
        active: true,
      },
    },
  ] as const

  it.each(providerCases)('$name', async ({ operations, result }) => {
    const id = await seed()
    const original = await stored(id)
    const payload = document(operations)
    const response = await patch(id, payload)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/scim+json')
    expect(response.headers.has('etag')).toBe(false)
    const body = await response.json()
    expect(body).toMatchObject({
      id,
      userName: original.user_name,
      title: original.title,
      meta: {
        resourceType: 'User',
        created: baseline.toISOString(),
        location: `${origin}/scim/v2/${scope.organizationId}/Users/${id}`,
      },
      ...result,
    })
    expect(await stored(id)).toMatchObject({
      organization_id: scope.organizationId,
      connection_id: scope.connectionId,
      work_email: newEmail,
      created_at: baseline,
    })
    expect((await stored(id)).updated_at.getTime()).toBeGreaterThan(baseline.getTime())
    const read = await app.request(`${origin}/scim/v2/${scope.organizationId}/Users/${id}`, {
      headers: { authorization: `Bearer ${scope.bearer}` },
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(body)
    const replay = await patch(id, payload)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(body)
    expect(await updates(id)).toEqual([
      {
        organization_id: scope.organizationId,
        actor_type: 'scim_token',
        actor_id: scope.tokenId,
        target_type: 'scim_user',
        details: { operations: operations.map(({ op }) => op.toLowerCase()) },
      },
    ])
  })

  it('matches the evolving work address and clears mapped optional attributes', async () => {
    const id = await seed({ work_email: null, external_id: 'Clearable' })
    const response = await patch(
      id,
      document([
        { op: 'add', path: workValue, value: oldEmail },
        { op: 'replace', path: workValue, value: newEmail },
        { op: 'remove', path: workValue },
        { op: 'remove', path: 'externalId' },
        { op: 'remove', path: 'name.familyName' },
        { op: 'remove', path: `${enterprise}:department` },
      ]),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ id, name: { givenName: 'Before Given' } })
    expect(body).not.toHaveProperty('name.familyName')
    expect(body).not.toHaveProperty('emails')
    expect(body).not.toHaveProperty('externalId')
    expect(body).not.toHaveProperty([enterprise])
    expect(await stored(id)).toMatchObject({
      work_email: null,
      external_id: null,
      department: null,
    })
  })

  it('applies whole-email replacement and shares PUT selection and validation', async () => {
    const id = await seed()
    const replaced = await patch(
      id,
      document([
        {
          op: 'replace',
          value: {
            EMAILS: [
              { value: 'home@directory.example', type: 'home' },
              { VALUE: newEmail, TYPE: 'WORK', PRIMARY: true },
            ],
          },
        },
      ]),
    )
    expect(replaced.status).toBe(200)
    expect(await replaced.json()).toMatchObject({
      emails: [{ value: newEmail, type: 'work', primary: true }],
    })
    const unselectedAdd = await patch(
      id,
      document([{ op: 'add', path: 'emails', value: [{ value: oldEmail, type: 'work' }] }]),
    )
    expect(unselectedAdd.status).toBe(200)
    expect(await unselectedAdd.json()).toMatchObject({
      emails: [{ value: newEmail, type: 'work', primary: true }],
    })
    const selectedAdd = await patch(
      id,
      document([
        { op: 'add', path: 'emails', value: [{ value: oldEmail, type: 'work', primary: true }] },
      ]),
    )
    expect(selectedAdd.status).toBe(200)
    expect(await selectedAdd.json()).toMatchObject({
      emails: [{ value: oldEmail, type: 'work', primary: true }],
    })
    const removed = await patch(id, document([{ op: 'remove', path: 'emails' }]))
    expect(removed.status).toBe(200)
    expect(await removed.json()).not.toHaveProperty('emails')
    expect((await stored(id)).work_email).toBeNull()
  })

  it('resolves a qualified manager in its own connection and derives its display name', async () => {
    const id = await seed()
    const manager = await seed({ display_name: 'Current Manager' })
    const response = await patch(
      id,
      document([{ op: 'replace', path: `${enterprise}:manager.value`, value: manager }]),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      [enterprise]: {
        department: 'Before Department',
        manager: { value: manager, displayName: 'Current Manager' },
      },
    })
    expect((await stored(id)).manager_id).toBe(manager)
  })

  it('preserves an untouched reference to a retired manager while keeping it out of the response', async () => {
    const manager = await seed({ active: false, retired_at: baseline })
    const id = await seed({ manager_id: manager })
    const response = await patch(
      id,
      document([{ op: 'replace', value: { title: 'Updated Title' } }]),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      title: 'Updated Title',
      [enterprise]: { department: 'Before Department' },
    })
    expect(body).not.toHaveProperty([enterprise, 'manager'])
    expect(await stored(id)).toMatchObject({ title: 'Updated Title', manager_id: manager })
  })

  it.each([
    { active: true, echo: true },
    { active: true, echo: 'True' },
    { active: false, echo: false },
    { active: false, echo: 'False' },
  ])('allows an Okta/Entra pathless active echo of $echo', async ({ active, echo }) => {
    const id = await seed({ active })
    const payload = {
      ScHeMaS: [patchSchema],
      oPeRaTiOnS: [{ OP: 'Replace', VaLuE: { aCtIvE: echo, roles: [], entitlements: [] } }],
    }
    const response = await patch(id, payload)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      active,
      meta: { lastModified: baseline.toISOString() },
    })
    expect(await updates(id)).toEqual([])
  })

  const refusedOperations: {
    name: string
    operations: Operation[]
    code: string
    status?: number
  }[] = [
    {
      name: 'unknown path',
      operations: [{ op: 'replace', path: privateValue, value: privateValue }],
      code: 'invalidPath',
    },
    {
      name: 'unsupported filter',
      operations: [
        { op: 'replace', path: `emails[value eq "${privateValue}"].value`, value: newEmail },
      ],
      code: 'invalidPath',
    },
    {
      name: 'nonwork type selector',
      operations: [{ op: 'replace', path: 'emails[type eq "home"].value', value: newEmail }],
      code: 'invalidPath',
    },
    {
      name: 'malformed filter',
      operations: [{ op: 'replace', path: 'emails[type eq "work].value', value: newEmail }],
      code: 'invalidPath',
    },
    {
      name: 'legacy dotted enterprise URI',
      operations: [{ op: 'replace', value: { [`${enterprise}.department`]: privateValue } }],
      code: 'invalidPath',
    },
    {
      name: 'double-qualified enterprise path',
      operations: [
        {
          op: 'replace',
          path: `${SCIM_URN.user}:${enterprise}:department`,
          value: privateValue,
        },
      ],
      code: 'invalidPath',
    },
    {
      name: 'bare schema URI as an explicit path',
      operations: [{ op: 'remove', path: enterprise }],
      code: 'invalidPath',
    },
    {
      name: 'Group members path',
      operations: [{ op: 'Remove', path: 'members' }],
      code: 'invalidPath',
    },
    {
      name: 'read-only ID',
      operations: [{ op: 'replace', path: 'ID', value: randomUUID() }],
      code: 'mutability',
    },
    {
      name: 'read-only dotted metadata',
      operations: [{ op: 'replace', value: { 'mEtA.lastModified': privateValue } }],
      code: 'mutability',
    },
    {
      name: 'read-only nested groups',
      operations: [{ op: 'add', value: { Groups: [{ value: privateValue }] } }],
      code: 'mutability',
    },
    {
      name: 'read-only nested manager display',
      operations: [
        { op: 'replace', value: { [enterprise]: { manager: { DisplayName: privateValue } } } },
      ],
      code: 'mutability',
    },
    {
      name: 'read-only manager reference metadata',
      operations: [{ op: 'replace', path: `${enterprise}:manager.$ref`, value: privateValue }],
      code: 'mutability',
    },
    {
      name: 'role grant',
      operations: [{ op: 'add', path: 'RoLeS', value: [{ value: 'owner' }] }],
      status: 403,
      code: 'mutability',
    },
    {
      name: 'entitlement grant',
      operations: [{ op: 'add', value: { Entitlements: [{ value: 'admin' }] } }],
      status: 403,
      code: 'mutability',
    },
    {
      name: 'active removal',
      operations: [{ op: 'remove', path: 'active' }],
      status: 403,
      code: 'mutability',
    },
    {
      name: 'active unassignment',
      operations: [{ op: 'replace', value: { active: null } }],
      status: 403,
      code: 'mutability',
    },
    {
      name: 'nonboolean active string',
      operations: [{ op: 'replace', path: 'active', value: 'yes' }],
      code: 'invalidValue',
    },
    {
      name: 'malformed email add even when a primary work address is present',
      operations: [{ op: 'add', path: 'emails', value: [{ type: 'work', value: 123 }] }],
      code: 'invalidValue',
    },
    {
      name: 'boolean string outside active',
      operations: [
        {
          op: 'replace',
          path: 'emails',
          value: [{ value: newEmail, type: 'work', primary: 'True' }],
        },
      ],
      code: 'invalidValue',
    },
    {
      name: 'required userName removal',
      operations: [{ op: 'remove', path: 'uSeRnAmE' }],
      code: 'mutability',
    },
    {
      name: 'empty required userName',
      operations: [{ op: 'replace', value: { userName: '' } }],
      code: 'invalidValue',
    },
    {
      name: 'invalid intermediate value',
      operations: [
        { op: 'replace', path: 'displayName', value: 42 },
        { op: 'replace', path: 'displayName', value: 'Would mask error' },
      ],
      code: 'invalidValue',
    },
    { name: 'pathless remove', operations: [{ op: 'remove' }], code: 'noTarget' },
    {
      name: 'User remove with a value',
      operations: [{ op: 'remove', path: 'emails', value: [{ value: privateValue }] }],
      code: 'invalidValue',
    },
    {
      name: 'unmatched filtered replace',
      operations: [
        { op: 'remove', path: 'emails' },
        { op: 'replace', path: workValue, value: newEmail },
      ],
      code: 'noTarget',
    },
    {
      name: 'unmatched filtered remove',
      operations: [
        { op: 'remove', path: 'emails' },
        { op: 'remove', path: workValue },
      ],
      code: 'noTarget',
    },
  ]

  it.each(refusedOperations)(
    'rolls back a preceding valid write after $name',
    async ({ operations, code, status = 400 }) => {
      const id = await seed()
      const before = await stored(id)
      await expectError(
        await patch(
          id,
          document([{ op: 'replace', path: 'title', value: privateValue }, ...operations]),
        ),
        status,
        code,
      )
      expect(await stored(id)).toEqual(before)
      expect(await updates(id)).toEqual([])
    },
  )

  it('rolls back reactivation when a scoped identifier conflicts', async () => {
    await seed({ user_name: 'Occupied', external_id: 'Taken' })
    const id = await seed({ active: false })
    const before = await stored(id)
    for (const value of [{ userName: ' OcCuPiEd ' }, { externalId: 'Taken' }])
      await expectError(
        await patch(id, document([{ op: 'replace', value: { ...value, active: true } }])),
        409,
        'uniqueness',
      )
    expect(await stored(id)).toEqual(before)
    expect(await updates(id)).toEqual([])
  })

  it('bounds operation count, path length and UTF-8 bytes and checks the envelope', async () => {
    const id = await seed()
    const before = await stored(id)
    const operation = { op: 'replace', path: 'title', value: before.title }
    await expectError(await patch(id, '{'), 400, 'invalidSyntax')
    for (const payload of [
      { schemas: [SCIM_URN.user], Operations: [operation] },
      { schemas: [patchSchema], Operations: [] },
      { schemas: [patchSchema], Operations: [operation], operations: [operation] },
      { schemas: [patchSchema], Operations: [{ ...operation, OP: 'Remove' }] },
      document([{ ...operation, op: 'move' }]),
      document(Array.from({ length: 101 }, () => operation)),
    ])
      await expectError(await patch(id, payload), 400, 'invalidSyntax')
    const boundary = await patch(id, document(Array.from({ length: 100 }, () => operation)))
    expect(boundary.status).toBe(200)
    const filtered = (length: number) => ({
      op: 'replace',
      path: `emails[${' '.repeat(length - workValue.length)}type eq "work"].value`,
      value: oldEmail,
    })
    expect((await patch(id, document([filtered(512)]))).status).toBe(200)
    await expectError(await patch(id, document([filtered(513)])), 400, 'invalidPath')
    await expectError(
      await patch(id, document([{ ...operation, value: '界'.repeat(SCIM_BODY_LIMIT / 2) }]), {
        'Content-Length': '12',
      }),
      413,
    )
    await expectError(await patch(id, document([operation]), { 'If-Match': '*' }), 412)
    expect(await stored(id)).toEqual(before)
    expect(await updates(id)).toEqual([])
  })

  it('conceals other organization and connection targets and manager references', async () => {
    const id = await seed()
    const other = await seed({}, foreign)
    const retired = await seed({ active: false, retired_at: baseline })
    // Temporarily allow a second connection in this throwaway database to exercise the
    // handler's scope even though production currently provisions one per organization.
    await sql`ALTER TABLE scim_connections DROP CONSTRAINT scim_connections_one_per_organization`.execute(
      db,
    )
    const { id: secondConnection } = await db
      .insertInto('scim_connections')
      .values({ organization_id: scope.organizationId })
      .returning('id')
      .executeTakeFirstOrThrow()
    const otherConnection = await seed({ connection_id: secondConnection })
    const before = await stored(id)
    const beforeOther = await stored(other)
    const beforeOtherConnection = await stored(otherConnection)
    const valid = document([{ op: 'replace', path: 'title', value: privateValue }])
    const missing = await expectError(await patch(randomUUID(), valid), 404)
    for (const unrelated of [other, otherConnection, retired])
      expect(await expectError(await patch(unrelated, valid), 404)).toEqual(missing)
    const unauthorized = await expectError(
      await patch(other, valid, {}, { ...foreign, bearer: scope.bearer }),
      401,
    )
    expect(JSON.stringify(unauthorized).includes(scope.bearer)).toBe(false)
    for (const manager of [other, otherConnection, retired])
      await expectError(
        await patch(
          id,
          document([{ op: 'replace', path: `${enterprise}:manager.value`, value: manager }]),
        ),
        400,
        'invalidValue',
      )
    expect(await stored(id)).toEqual(before)
    expect(await stored(other)).toEqual(beforeOther)
    expect(await stored(otherConnection)).toEqual(beforeOtherConnection)
    for (const untouched of [id, other, otherConnection, retired])
      expect(await updates(untouched)).toEqual([])
  })
})
