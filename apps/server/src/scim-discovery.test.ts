import { createHmac, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { provisioningTokenRoutes } from './routes/provisioning-tokens.ts'
import { type ScimResources, scimError } from './scim.ts'
import { SCIM_URN, scimDiscovery } from './scim-discovery.ts'
import { productionAppOptions } from './server.ts'

// Every expectation below is read from docs/scim.md or RFC 7643/7644, never from a
// snapshot of the representations, so the design and the code cannot drift apart.
const design = readFileSync(new URL('../../../docs/scim.md', import.meta.url), 'utf8')
const origin = 'http://localhost'
const signingSecret = 'synthetic-scim-discovery-cookie-signing-secret'
const base = `${origin}/scim/v2/00000000-0000-4000-8000-0000000000a1`

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

type Attribute = {
  name: string
  type: string
  mutability: string
  required: boolean
  returned: string
  uniqueness: string
  caseExact: boolean
  canonicalValues?: string[]
  subAttributes?: Attribute[]
} & Record<string, unknown>
type Schema = { id: string; attributes: Attribute[] } & Record<string, unknown>
type Listed<T> = { Resources: T[] } & Record<string, unknown>

function discover(
  path: string,
  { method = 'GET', query = '', resources = scimDiscovery } = {},
): { status: number; body: unknown } | undefined {
  return resources({
    method,
    path,
    query: new URLSearchParams(query),
    principal: { tokenId: '00000000-0000-4000-8000-0000000000b1', organizationId: 'unused' },
    base,
  })
}
function body<T>(path: string, resources = scimDiscovery): T {
  const reply = discover(path, { resources })
  expect(reply?.status, path).toBe(200)
  return reply?.body as T
}

// docs/scim.md, "Protocol surface": the ServiceProviderConfig row and the ETag paragraph.
function designedCapabilities() {
  const row = /^\| `GET \/ServiceProviderConfig` \| (.+) \|$/m.exec(design)?.[1] ?? ''
  const patch = /`patch\.supported=(true|false)`/.exec(row)?.[1]
  const filter = /filter supported with maxResults (\d+)/.exec(row)?.[1]
  const unsupported = /; ([A-Za-z, ]+?) unsupported;/.exec(row)?.[1]?.split(/, | and /) ?? []
  const etag = /advertise `etag\.supported=(true|false)`/.exec(design)?.[1]
  const pageCap = /Offset pagination starts at 1, defaults to \d+, caps at (\d+)/.exec(design)?.[1]
  // Each statement must be found; its value then flows into the expectation below.
  expect({
    patch,
    filter,
    pageCap,
    bearer: /bearer authentication advertised/.test(row),
    etagParagraphAgrees: etag === 'false' && unsupported.includes('etag'),
  }).toEqual({
    patch: expect.stringMatching(/^(?:true|false)$/),
    filter: expect.stringMatching(/^\d+$/),
    pageCap: filter,
    bearer: true,
    etagParagraphAgrees: true,
  })
  return {
    patch: { supported: patch === 'true' },
    filter: { supported: true, maxResults: Number(filter) },
    ...Object.fromEntries(
      unsupported.map((name) => [
        name,
        // RFC 7643 section 5 requires bulk's limits; nothing is accepted while unsupported.
        name === 'bulk'
          ? { supported: false, maxOperations: 0, maxPayloadSize: 0 }
          : { supported: false },
      ]),
    ),
  }
}

async function verifyCapabilities(resources: ScimResources) {
  const config = body<Record<string, unknown>>('/ServiceProviderConfig', resources)
  const capabilities = designedCapabilities()
  // RFC 7643 section 5 requires exactly these capability attributes; the design names each.
  expect(Object.keys(capabilities).sort()).toEqual(
    ['bulk', 'changePassword', 'etag', 'filter', 'patch', 'sort'].sort(),
  )
  const { schemas, meta, authenticationSchemes, ...advertised } = config
  expect(advertised).toEqual(capabilities)
  expect(schemas).toEqual([SCIM_URN.serviceProviderConfig])
  expect(meta).toEqual({
    resourceType: 'ServiceProviderConfig',
    location: `${base}/ServiceProviderConfig`,
  })
  // "bearer authentication advertised": RFC 7643 names RFC 6750 bearer tokens
  // "oauthbearertoken"; provisioning tokens are the only accepted credential.
  expect(authenticationSchemes).toEqual([
    {
      type: 'oauthbearertoken',
      name: expect.any(String),
      description: expect.any(String),
      specUri: 'https://www.rfc-editor.org/info/rfc6750',
    },
  ])
}

const characteristics = [
  'name',
  'type',
  'multiValued',
  'description',
  'required',
  'caseExact',
  'mutability',
  'returned',
  'uniqueness',
]
// RFC 7643 section 7, checked recursively; sub-attributes are never complex themselves.
function expectWellFormed(attributes: Attribute[], depth = 0) {
  for (const attribute of attributes) {
    const extra = Object.keys(attribute).filter((key) => !characteristics.includes(key))
    expect(extra.sort(), attribute.name).toEqual(
      [
        ...(attribute.type === 'complex' ? ['subAttributes'] : []),
        ...(attribute.canonicalValues ? ['canonicalValues'] : []),
      ].sort(),
    )
    expect(characteristics.filter((key) => !(key in attribute))).toEqual([])
    expect(['string', 'boolean', 'complex']).toContain(attribute.type)
    expect(['readOnly', 'readWrite']).toContain(attribute.mutability)
    expect(['always', 'default']).toContain(attribute.returned)
    expect(['none', 'server']).toContain(attribute.uniqueness)
    expect(typeof attribute.description === 'string' && attribute.description.length > 0).toBe(true)
    if (attribute.subAttributes) {
      expect(depth).toBe(0)
      expect(attribute.subAttributes.length).toBeGreaterThan(0)
      expectWellFormed(attribute.subAttributes, depth + 1)
    }
  }
}
const leaves = (attributes: Attribute[], prefix = ''): Attribute[] =>
  attributes.flatMap((attribute) =>
    attribute.subAttributes
      ? leaves(attribute.subAttributes, `${prefix}${attribute.name}.`)
      : [{ ...attribute, name: `${prefix}${attribute.name}` }],
  )
// Every attribute, complex parents included, named by its path.
const nodes = (attributes: Attribute[], prefix = ''): Attribute[] =>
  attributes.flatMap((attribute) => [
    { ...attribute, name: `${prefix}${attribute.name}` },
    ...nodes(attribute.subAttributes ?? [], `${prefix}${attribute.name}.`),
  ])
const names = (attributes: Attribute[]): string[] =>
  attributes.flatMap((attribute) => [attribute.name, ...names(attribute.subAttributes ?? [])])

// docs/scim.md, "Identity, membership and trust": the SCIM field mapping table.
function designedFields() {
  const table = design.split('| SCIM field | Hourmere mapping decision |\n|---|---|\n')[1] ?? ''
  const rows = table
    .slice(0, table.indexOf('\n\n'))
    .split('\n')
    .map((line) => line.slice(2, -2).split(' | '))
  expect(rows.length).toBeGreaterThan(5)
  const core: string[] = []
  const enterprise: string[] = []
  const refused: string[] = []
  const deferred: string[] = []
  const derived: string[] = []
  for (const [field = '', decision = ''] of rows) {
    const fields = [...field.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string)
    const target = field.startsWith('Enterprise ') ? enterprise : core
    if (/^Read-only derived membership once Groups ships/.test(decision)) deferred.push(...fields)
    else if (/^No privilege mapping or password provisioning/.test(decision))
      refused.push(...fields)
    // id, externalId and meta are RFC 7643 section 3.1 common attributes, not schema fields.
    else target.push(...fields.filter((name) => !['id', 'externalId'].includes(name)))
    for (const match of decision.matchAll(/`([\w.]+)` is derived/g)) {
      target.push(match[1] as string)
      derived.push(match[1] as string)
    }
  }
  // "One primary work address", patched as `emails[type eq "work"].value`.
  expect(design).toContain('One primary work address used for the invitation/claim workflow')
  expect(design).toContain('`emails[type eq "work"].value`')
  const emails = ['emails.value', 'emails.type', 'emails.primary']
  return {
    core: core.flatMap((name) => (name === 'emails' ? emails : [name])).sort(),
    enterprise: enterprise.sort(),
    refused,
    deferred,
    derived,
  }
}

async function verifySchemas(resources: ScimResources) {
  const fields = designedFields()
  const listed = body<Listed<Schema>>('/Schemas', resources)
  const [user, extension] = listed.Resources
  expect(listed.Resources.map((schema) => schema.id)).toEqual([
    SCIM_URN.user,
    SCIM_URN.enterpriseUser,
  ])
  for (const schema of listed.Resources) {
    expect(Object.keys(schema).sort()).toEqual(
      ['schemas', 'id', 'name', 'description', 'attributes', 'meta'].sort(),
    )
    expect(schema.schemas).toEqual([SCIM_URN.schema])
    expect(schema.meta).toEqual({
      resourceType: 'Schema',
      location: `${base}/Schemas/${schema.id}`,
    })
    expectWellFormed(schema.attributes)
    expect(body<Schema>(`/Schemas/${schema.id}`, resources)).toEqual(schema)
    const all = names(schema.attributes)
    expect(new Set(all).size, 'unique names').toBe(all.length)
    for (const name of [...fields.refused, ...fields.deferred, 'id', 'externalId', 'meta'])
      expect(all, name).not.toContain(name)
  }
  const userLeaves = leaves(user?.attributes ?? [])
  const extensionLeaves = leaves(extension?.attributes ?? [])
  expect(userLeaves.map((leaf) => leaf.name).sort()).toEqual(fields.core)
  expect(extensionLeaves.map((leaf) => leaf.name).sort()).toEqual(fields.enterprise)
  const every = [...userLeaves, ...extensionLeaves]
  const all = [...nodes(user?.attributes ?? []), ...nodes(extension?.attributes ?? [])]
  // Only the derived fields are read-only; every other field and parent is mapped and writable.
  expect(all.filter((node) => node.mutability !== 'readWrite').map((node) => node.name)).toEqual(
    fields.derived,
  )
  // userName is the one required identity field: normalized (case-insensitive) uniqueness
  // within the connection, and projection never hides it.
  expect(design).toContain('Normalize userName consistently for uniqueness')
  expect(design).toContain('Never let projection hide mandatory identity fields.')
  const special = all.filter(
    (node) =>
      node.required || node.caseExact || node.uniqueness !== 'none' || node.returned !== 'default',
  )
  expect(special).toEqual([
    expect.objectContaining({
      name: 'userName',
      required: true,
      caseExact: false,
      uniqueness: 'server',
      returned: 'always',
    }),
  ])
  expect(every.find((leaf) => leaf.name === 'emails.type')?.canonicalValues).toEqual(['work'])
  expect(every.filter((leaf) => leaf.canonicalValues).length).toBe(1)
  expect(
    Object.fromEntries(
      [...userLeaves, ...extensionLeaves]
        .filter((leaf) => leaf.type !== 'string')
        .map((leaf) => [leaf.name, leaf.type]),
    ),
  ).toEqual({ active: 'boolean', 'emails.primary': 'boolean' })
  // The one work address list; nothing else, at any level, is multi-valued.
  expect(all.filter((node) => node.multiValued).map((node) => node.name)).toEqual(['emails'])
}

async function verifyResourceTypes(resources: ScimResources) {
  const listed = body<Listed<Record<string, unknown>>>('/ResourceTypes', resources)
  // "User and, only once implemented, Group resource descriptors": Groups are deferred.
  expect(design).toMatch(
    /^\| `GET \/Groups`.* \| Deferred until the hierarchy and authorization prerequisite/m,
  )
  expect(listed.Resources).toEqual([
    {
      schemas: [SCIM_URN.resourceType],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: expect.any(String),
      schema: SCIM_URN.user,
      // Every enterprise field is optional local metadata.
      schemaExtensions: [{ schema: SCIM_URN.enterpriseUser, required: false }],
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
    },
  ])
  expect(body('/ResourceTypes/User', resources)).toEqual(listed.Resources[0])
  // RFC 7643 section 6: each schema and extension a type names is a served Schema, and
  // every served schema belongs to a type.
  const served = body<Listed<Schema>>('/Schemas', resources).Resources.map((schema) => schema.id)
  const named = listed.Resources.flatMap((type) => [
    type.schema,
    ...(type.schemaExtensions as { schema: string }[]).map((extension) => extension.schema),
  ])
  expect(named.sort()).toEqual(served.sort())
}

function verifyProtocol(resources: ScimResources) {
  for (const path of ['/ResourceTypes', '/Schemas']) {
    const listed = body<Listed<unknown>>(path, resources)
    expect(Object.keys(listed).sort()).toEqual(
      ['schemas', 'totalResults', 'itemsPerPage', 'startIndex', 'Resources'].sort(),
    )
    expect(listed).toMatchObject({
      schemas: [SCIM_URN.listResponse],
      totalResults: listed.Resources.length,
      itemsPerPage: listed.Resources.length,
      startIndex: 1,
    })
    // Paging, sorting and projection parameters are ignored on discovery endpoints.
    expect(
      discover(path, { resources, query: 'startIndex=5&count=0&sortBy=id&attributes=name' })?.body,
    ).toEqual(listed)
  }
  // A filter is refused with 403 so a client never assumes it matched.
  for (const path of ['/ServiceProviderConfig', '/ResourceTypes', '/Schemas/x'])
    expect(discover(path, { resources, query: 'filter=id eq "User"' })).toEqual({
      status: 403,
      body: scimError(403, 'Discovery endpoints do not support filtering.'),
    })
  // Encoded colons name the same schema.
  expect(body(`/Schemas/${encodeURIComponent(SCIM_URN.user)}`, resources)).toEqual(
    body(`/Schemas/${SCIM_URN.user}`, resources),
  )
  for (const path of [
    '/Schemas/%E0%A4%A',
    '/ResourceTypes/Group',
    '/ResourceTypes/user',
    `/Schemas/${SCIM_URN.user}x`,
    '/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group',
    `/Schemas/${SCIM_URN.serviceProviderConfig}`,
  ])
    expect(discover(path, { resources })).toEqual({
      status: 404,
      body: scimError(404, 'Resource not found.'),
    })
  // HEAD is GET without a body; Hono drops the body.
  expect(discover('/ServiceProviderConfig', { resources, method: 'HEAD' })).toEqual(
    discover('/ServiceProviderConfig', { resources }),
  )
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    for (const path of ['/ServiceProviderConfig', '/ResourceTypes', '/Schemas/x'])
      expect(discover(path, { resources, method })).toEqual({
        status: 501,
        body: scimError(501, 'Discovery resources are read-only.'),
      })
  // Anything else stays with the unavailable answer.
  for (const path of [
    '',
    '/',
    '/Users',
    '/Schemas/',
    '/ServiceProviderConfig/x',
    '/ResourceTypes/User/x',
    '/serviceproviderconfig',
    '/Bulk',
    '/.search',
  ])
    expect(discover(path, { resources }), path).toBeUndefined()
}

describe('SCIM discovery representations', () => {
  it('advertises exactly the capabilities the design states', async () => {
    await verifyCapabilities(scimDiscovery)
  })

  it('detects any capability flag that drifts from the design (source-copy controls)', async () => {
    const control = await sourceCopy<typeof import('./scim-discovery.ts')>('./scim-discovery.ts')
    await verifyCapabilities(control.scimDiscovery)
    for (const mutation of [
      ['bulk: { supported: false,', 'bulk: { supported: true,'],
      ['sort: { supported: false }', 'sort: { supported: true }'],
      ['changePassword: { supported: false }', 'changePassword: { supported: true }'],
      ['etag: { supported: false }', 'etag: { supported: true }'],
      ['patch: { supported: true }', 'patch: { supported: false }'],
      ['maxResults: 100', 'maxResults: 200'],
      ["type: 'oauthbearertoken'", "type: 'httpbasic'"],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof import('./scim-discovery.ts')>(
        './scim-discovery.ts',
        mutation,
      )
      await expect(verifyCapabilities(mutant.scimDiscovery), mutation[1]).rejects.toMatchObject({
        name: 'AssertionError',
      })
    }
  })

  it('describes exactly the mapped User and enterprise fields with RFC 7643 characteristics', async () => {
    await verifySchemas(scimDiscovery)
  })

  it('detects an unmapped, writable or mis-characterized schema field (source-copy controls)', async () => {
    for (const mutation of [
      [
        "attribute('nickName', 'Casual name.'),",
        "attribute('nickName', 'Casual name.'),\n  attribute('roles', 'Roles.'),",
      ],
      [
        "attribute('nickName', 'Casual name.'),",
        "attribute('nickName', 'Casual name.'),\n  attribute('preferredLanguage', 'Language.'),",
      ],
      ["attribute('title', 'Job title; organization-local profile metadata.'),", ''],
      ["        mutability: 'readOnly',\n", ''],
      ["    returned: 'always',\n", ''],
      ["    uniqueness: 'server',\n", ''],
      ["canonicalValues: ['work']", "canonicalValues: ['work', 'home']"],
      ['    multiValued: true,\n', '    multiValued: true,\n    required: true,\n'],
      [
        "attribute('manager', 'Another User of the same provisioning connection.', {",
        "attribute('manager', 'Another User of the same provisioning connection.', {\n    mutability: 'readOnly',",
      ],
      [
        "attribute('givenName', 'Given name.')",
        "attribute('givenName', 'Given name.', { multiValued: true })",
      ],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof import('./scim-discovery.ts')>(
        './scim-discovery.ts',
        mutation,
      )
      await expect(verifySchemas(mutant.scimDiscovery), mutation[0]).rejects.toMatchObject({
        name: 'AssertionError',
      })
    }
  })

  it('offers only the User resource type, whose schemas are all served', async () => {
    await verifyResourceTypes(scimDiscovery)
    const mutant = await sourceCopy<typeof import('./scim-discovery.ts')>('./scim-discovery.ts', [
      'schemaExtensions: [{ schema: SCIM_URN.enterpriseUser, required: false }]',
      'schemaExtensions: []',
    ])
    await expect(verifyResourceTypes(mutant.scimDiscovery)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('answers lists, single resources and refusals in RFC 7644 form', () => {
    verifyProtocol(scimDiscovery)
  })

  it('detects a weakened filter, method, identifier or list rule (source-copy controls)', async () => {
    for (const mutation of [
      ["if (query.has('filter'))", 'if (false)'],
      ["if (method !== 'GET' && method !== 'HEAD')", 'if (false)'],
      ["method !== 'GET' && method !== 'HEAD'", "method !== 'GET'"],
      ['decoded = decodeURIComponent(id)', 'decoded = id'],
      ['startIndex: 1,', 'startIndex: 0,'],
      ["(endpoint === 'ServiceProviderConfig' && id !== undefined)", 'false'],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof import('./scim-discovery.ts')>(
        './scim-discovery.ts',
        mutation,
      )
      await expect(
        (async () => verifyProtocol(mutant.scimDiscovery))(),
        mutation[0],
      ).rejects.toMatchObject({ name: 'AssertionError' })
    }
  })

  it('is imported by no production source', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    const sources = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) return sources(path)
        return /\.tsx?$/.test(entry) && !/\.test\.tsx?$|testing\.ts$/.test(entry) ? [path] : []
      })
    const files = sources(root)
    expect(files.some((file) => file.endsWith('server.ts'))).toBe(true)
    expect(
      files.filter(
        (file) =>
          !file.endsWith('scim-discovery.ts') &&
          readFileSync(file, 'utf8').includes('scim-discovery'),
      ),
    ).toEqual([])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('SCIM discovery over HTTP', () => {
  let owned: TestDatabase, db: Db, auth: Auth, authPool: ReturnType<typeof createAuthPool>
  let organizationId: string, foreignId: string, emptyId: string
  let cookie: string, foreignCookie: string, apiKey: string
  const tokenPath = (organization: string) =>
    `/api/v1/organizations/${organization}/provisioning-tokens`
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'scim_discovery',
    })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    const owner = await createTestUser(db)
    const foreignOwner = await createTestUser(db)
    organizationId = await f.organization('scim-discovery')
    foreignId = await f.organization('scim-discovery-foreign')
    emptyId = await f.organization('scim-discovery-empty')
    await f.member(owner.id, organizationId, 'owner')
    await f.member(foreignOwner.id, foreignId, 'owner')
    await f.member(owner.id, emptyId, 'owner')
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      signup,
      baseURL: origin,
      secret: signingSecret,
      mailer: { send: async () => {} },
    })
    const session = async (userId: string, activeOrganizationId: string) => {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId,
          token,
          activeOrganizationId,
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
      return `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', signingSecret).update(token).digest('base64')}`)}`
    }
    cookie = await session(owner.id, organizationId)
    foreignCookie = await session(foreignOwner.id, foreignId)
    apiKey = (
      await auth.api.createApiKey({ body: { userId: owner.id, metadata: { organizationId } } })
    ).key
  })
  // Each organization may hold only ten active tokens.
  afterEach(async () => {
    await db.deleteFrom('scim_provisioning_tokens').execute()
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  // The test harness injects the handlers in code: the resource test flag.
  function harness(resources: ScimResources | undefined = scimDiscovery, enabled = true) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
      scim: { db, enabled, resources },
      routes: [provisioningTokenRoutes({ db, enabled: true })],
    })
  }
  async function manage(
    organization: string,
    path: string,
    method: string,
    payload?: unknown,
  ): Promise<{ token: { id: string }; secret: string }> {
    const response = await harness().request(`${tokenPath(organization)}${path}`, {
      method,
      headers: {
        cookie: organization === foreignId ? foreignCookie : cookie,
        origin,
        'x-expected-organization-id': organization,
        'content-type': 'application/json',
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
    expect(response.status, `${method} ${path}`).toBe(method === 'POST' && !path ? 201 : 200)
    return response.json() as Promise<{ token: { id: string }; secret: string }>
  }
  const issue = (organization = organizationId) =>
    manage(organization, '', 'POST', { name: 'Synthetic IdP' })
  const scim = (
    application: ReturnType<typeof harness>,
    organization: string,
    resource: string,
    headers: Record<string, string> = {},
  ) => application.request(`/scim/v2/${organization}/${resource}`, { headers })
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` })
  const discovery = [
    'ServiceProviderConfig',
    'ResourceTypes',
    'ResourceTypes/User',
    'Schemas',
    `Schemas/${SCIM_URN.user}`,
    `Schemas/${encodeURIComponent(SCIM_URN.enterpriseUser)}`,
  ]

  it('serves each organization its own view with absolute locations under PUBLIC_URL', async () => {
    const application = harness()
    for (const [organization, issued] of [
      [organizationId, await issue()],
      [foreignId, await issue(foreignId)],
    ] as const) {
      const own = `${origin}/scim/v2/${organization}/`
      for (const resource of discovery) {
        const response = await scim(application, organization, resource, bearer(issued.secret))
        expect(response.status, resource).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/scim+json')
        expect(response.headers.get('cache-control')).toBe('no-store')
        const text = await response.text()
        const locations = [...text.matchAll(/"location":"([^"]+)"/g)].map((match) => match[1])
        expect(locations.length).toBeGreaterThan(0)
        for (const location of locations) expect(location?.startsWith(own), location).toBe(true)
        const other = organization === organizationId ? foreignId : organizationId
        expect(text.includes(other)).toBe(false)
      }
      // The stored organization names the base, never the URL's spelling of it.
      const upper = await scim(
        application,
        organization.toUpperCase(),
        'ServiceProviderConfig',
        bearer(issued.secret),
      )
      expect(((await upper.json()) as { meta: { location: string } }).meta.location).toBe(
        `${own}ServiceProviderConfig`,
      )
    }
    // An unknown schema stays a SCIM 404 after authentication.
    const issued = await issue()
    const unknown = await scim(
      application,
      organizationId,
      'Schemas/unknown',
      bearer(issued.secret),
    )
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual(scimError(404, 'Resource not found.'))
  })

  it('refuses other organizations, revoked and rotated-away tokens, cookies and API keys with one 401', async () => {
    const own = await issue()
    const foreign = await issue(foreignId)
    const revoked = await issue()
    await manage(organizationId, `/${revoked.token.id}`, 'DELETE')
    const replaced = await issue()
    const replacement = await manage(organizationId, `/${replaced.token.id}/rotate`, 'POST', {
      overlapSeconds: 0,
    })
    const overlapping = await issue()
    const successor = await manage(organizationId, `/${overlapping.token.id}/rotate`, 'POST', {
      overlapSeconds: 3600,
    })
    const both = await issue()
    const bothSuccessor = await manage(organizationId, `/${both.token.id}/rotate`, 'POST', {
      overlapSeconds: 3600,
    })
    await manage(organizationId, `/${both.token.id}`, 'DELETE')
    const application = harness()
    const accepted = async (secret: string) =>
      (await scim(application, organizationId, 'ServiceProviderConfig', bearer(secret))).status
    // Controls: current, replacement and in-overlap predecessor are accepted.
    for (const secret of [own.secret, replacement.secret, successor.secret, overlapping.secret])
      expect(await accepted(secret)).toBe(200)
    // The overlap ends: the predecessor is rotated away, its successor stays.
    await db
      .updateTable('scim_provisioning_tokens')
      .set({ previous_valid_until: sql`clock_timestamp() - interval '1 second'` })
      .where('id', '=', overlapping.token.id)
      .execute()
    expect(await accepted(successor.secret)).toBe(200)

    const refusals: [string, string, Record<string, string>][] = [
      ['other organization token', organizationId, bearer(foreign.secret)],
      ['token at another existing organization', foreignId, bearer(own.secret)],
      ['token at an organization without tokens', emptyId, bearer(own.secret)],
      [
        'token at an unknown organization',
        '00000000-0000-4000-8000-0000000000c1',
        bearer(own.secret),
      ],
      ['revoked token', organizationId, bearer(revoked.secret)],
      ['revoked rotated token', organizationId, bearer(both.secret)],
      ['revoked replacement', organizationId, bearer(bothSuccessor.secret)],
      ['zero-overlap predecessor', organizationId, bearer(replaced.secret)],
      ['expired-overlap predecessor', organizationId, bearer(overlapping.secret)],
      ['session cookie', organizationId, { cookie }],
      ['session cookie with API key', organizationId, { cookie, ...bearer(apiKey) }],
      ['API key', organizationId, bearer(apiKey)],
      ['session cookie with foreign token', organizationId, { cookie, ...bearer(foreign.secret) }],
      ['malformed bearer', organizationId, bearer(`${own.secret}x`)],
      ['basic credentials', organizationId, { authorization: `Basic ${own.secret}` }],
    ]
    const expected = JSON.stringify(scimError(401, 'A valid provisioning token is required.'))
    for (const [label, organization, headers] of refusals)
      for (const resource of ['ServiceProviderConfig', 'Schemas', 'ResourceTypes/User']) {
        const response = await scim(application, organization, resource, headers)
        expect({ label, resource, status: response.status }).toEqual({
          label,
          resource,
          status: 401,
        })
        expect(response.headers.get('www-authenticate')).toBe('Bearer')
        expect(response.headers.get('content-type')).toBe('application/scim+json')
        expect(response.headers.get('cache-control')).toBe('no-store')
        // Identical bytes: nothing tells an existing organization or token from another.
        expect(await response.text(), label).toBe(expected)
      }
  })

  it('stays off while SCIM_PROVISIONING_ENABLED is off, even with handlers injected', async () => {
    const issued = await issue()
    const application = harness(scimDiscovery, false)
    for (const resource of discovery) {
      const response = await scim(application, organizationId, resource, bearer(issued.secret))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(scimError(404, 'SCIM provisioning is disabled.'))
    }
  })

  // The production assembly, as startServer builds it, with the operator switch on.
  async function productionAnswers(options = productionAppOptions) {
    const issued = await issue()
    const config = loadConfig({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: signingSecret,
      PUBLIC_URL: origin,
      SCIM_PROVISIONING_ENABLED: 'true',
    })
    const unavailable = async (): Promise<never> => {
      throw new Error('SCIM discovery must not reach this collaborator')
    }
    const application = createApp(
      options({
        config,
        db,
        auth: { handler: unavailable },
        resolveCaller: unavailable,
        resolveMcpOAuth: unavailable,
        checkDb: unavailable,
        waitlist: { verify: unavailable, remove: unavailable },
        invitationMailLimits: { secret: signingSecret },
        webhookSettings: { enabled: config.WEBHOOKS_ENABLED },
        webhookQueue: { enqueue: unavailable },
        notify: unavailable,
        notifyAttendeeNoShow: unavailable,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unavailable,
        enqueueCalendarWritebackRecovery: unavailable,
      }),
    )
    // Only SCIM-specific names: the unavailable handler is mounted and no discovery route or
    // OpenAPI path sits beside it. Handlers would be dispatched inside /scim/*, so the
    // answers below are what actually prove discovery absent.
    const paths = application.routes.map((route) => route.path)
    expect(paths).toContain('/scim/*')
    expect(
      paths.filter((path) => /ServiceProviderConfig|ResourceTypes|Schemas/.test(path)),
    ).toEqual([])
    const document = (await (await application.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(document.paths).filter((path) => path.includes('scim/v2'))).toEqual([])
    const answers = []
    for (const resource of discovery) {
      const response = await scim(application, organizationId, resource, bearer(issued.secret))
      expect(response.headers.get('content-type')).toBe('application/scim+json')
      answers.push({ resource, status: response.status, body: await response.json() })
    }
    return answers
  }
  const unavailableAnswers = discovery.map((resource) => ({
    resource,
    status: 404,
    body: scimError(404, 'SCIM resources are not available yet.'),
  }))

  it('keeps discovery unregistered in the production assembly with SCIM enabled', async () => {
    expect(await productionAnswers()).toEqual(unavailableAnswers)
    // Controls: an unmutated copy of the assembly answers the same, and the same token
    // reads discovery through the harness.
    const control = await sourceCopy<typeof import('./server.ts')>('./server.ts')
    expect(await productionAnswers(control.productionAppOptions)).toEqual(unavailableAnswers)
    const issued = await issue()
    expect(
      (await scim(harness(), organizationId, 'ServiceProviderConfig', bearer(issued.secret)))
        .status,
    ).toBe(200)
    const mutant = await sourceCopy<typeof import('./server.ts')>(
      './server.ts',
      [
        "import { type AppDeps, createApp } from './app.ts'",
        "import { type AppDeps, createApp } from './app.ts'\nimport { scimDiscovery } from './scim-discovery.ts'",
      ],
      [
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED },',
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED, resources: scimDiscovery },',
      ],
    )
    // Registered in production, every discovery path would answer.
    expect(
      (await productionAnswers(mutant.productionAppOptions)).map(({ resource, status }) => ({
        resource,
        status,
      })),
    ).toEqual(discovery.map((resource) => ({ resource, status: 200 })))
  })

  it('advertises only fields the connection identity storage holds', async () => {
    // Advertised leaf → scim_users column; the rest are derived and read-only or fixed.
    const storage: Record<string, string | null> = {
      userName: 'user_name',
      'name.formatted': 'formatted_name',
      'name.familyName': 'family_name',
      'name.givenName': 'given_name',
      displayName: 'display_name',
      nickName: 'nick_name',
      title: 'title',
      userType: 'user_type',
      locale: 'locale',
      timezone: 'timezone',
      active: 'active',
      'emails.value': 'work_email',
      // The one work address: its type is always "work" and it is the primary one.
      'emails.type': null,
      'emails.primary': null,
      employeeNumber: 'employee_number',
      costCenter: 'cost_center',
      organization: 'enterprise_organization',
      division: 'division',
      department: 'department',
      'manager.value': 'manager_id',
      'manager.displayName': null,
    }
    const columns = new Map(
      (
        await sql<{ column_name: string; is_nullable: string; column_default: string | null }>`
          SELECT column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'scim_users'`.execute(db)
      ).rows.map((row) => [row.column_name, row]),
    )
    const advertised = body<Listed<Schema>>('/Schemas').Resources.flatMap((schema) =>
      leaves(schema.attributes),
    )
    expect(advertised.map((leaf) => leaf.name).sort()).toEqual(Object.keys(storage).sort())
    for (const leaf of advertised) {
      const column = storage[leaf.name]
      if (column === null) continue
      const stored = columns.get(column as string)
      expect(stored, leaf.name).toBeDefined()
      // Required exactly when the stored column needs a value and has no default.
      expect(leaf.required, leaf.name).toBe(
        stored?.is_nullable === 'NO' && stored.column_default === null,
      )
    }
  })
})
