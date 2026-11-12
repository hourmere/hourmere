import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import type { KyselyPlugin } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import type { ScimResourceHandler } from './scim.ts'
import { SCIM_URN, scimDiscovery } from './scim-discovery.ts'
import { scimUsers } from './scim-users.ts'
import { productionAppOptions } from './server.ts'

// Expectations come from docs/scim.md, RFC 7643/7644 and the rows these tests write, never
// from the handler's own helpers, so a weakened scope or representation fails here.
const design = readFileSync(new URL('../../../docs/scim.md', import.meta.url), 'utf8')
// Design sentences are matched however their lines wrap.
const words = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')
const says = (sentence: string) => new RegExp(words(sentence)).test(design)
const pageCap = Number(
  /caps\s+at\s+(\d+),\s+uses\s+stable\s+resource-ID\s+ordering/.exec(design)?.[1],
)
type Json = Record<string, unknown>
type Users = typeof scimUsers
const publicUrl = 'https://scim-public.example'
const signingSecret = 'synthetic-scim-user-reads-cookie-signing-secret'
const core = SCIM_URN.user
const enterprise = SCIM_URN.enterpriseUser
// RFC 7644 section 3.12: a string status and a detail; no scimType for 404.
const errorBody = (status: number, detail: string) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
  status: String(status),
  detail,
})
const unavailable = errorBody(404, 'SCIM resources are not available yet.')

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

interface Fixture {
  id: string
  user_name: string
  external_id?: string
  active?: boolean
  retired_at?: string
  display_name?: string
  manager_id?: string
  linked_user_id?: string
  linked_member_id?: string
  created_at: string
  updated_at?: string
  [column: string]: unknown
}

// IDs chosen so that ID order differs from creation and insertion order.
const own = {
  alice: 'c0000000-0000-4000-8000-000000000001',
  bob: '30000000-0000-4000-8000-000000000002',
  carol: 'a0000000-0000-4000-8000-000000000003',
  dave: '50000000-0000-4000-8000-000000000004',
  erin: 'e0000000-0000-4000-8000-000000000005',
  frank: '10000000-0000-4000-8000-000000000006',
  fresh: '80000000-0000-4000-8000-000000000007',
  gone: '20000000-0000-4000-8000-000000000008',
  old: '90000000-0000-4000-8000-000000000009',
}
const foreign = {
  alice: 'b0000000-0000-4000-8000-00000000000a',
  only: '40000000-0000-4000-8000-00000000000b',
  gone: '70000000-0000-4000-8000-00000000000c',
}
const ownEntries: Fixture[] = [
  {
    id: own.bob,
    user_name: 'bob@example.com',
    external_id: 'ext-bob',
    display_name: 'Bob',
    created_at: '2026-11-01T09:00:00Z',
  },
  {
    id: own.gone,
    user_name: 'gone@example.com',
    external_id: 'ext-gone',
    display_name: 'Gone',
    active: false,
    retired_at: '2026-11-05T00:00:00Z',
    created_at: '2026-11-01T09:30:00Z',
  },
  {
    id: own.old,
    user_name: 'reuse@example.com',
    external_id: 'ext-reuse',
    active: false,
    retired_at: '2026-11-05T00:00:00Z',
    created_at: '2026-11-01T09:45:00Z',
  },
  {
    id: own.alice,
    user_name: 'Alice@Example.com',
    external_id: 'ext-alice',
    formatted_name: 'Alice Liddell',
    family_name: 'Liddell',
    given_name: 'Alice',
    display_name: 'Alice',
    nick_name: 'Al',
    title: 'Engineer',
    user_type: 'Employee',
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    work_email: 'alice.work@example.com',
    employee_number: '42',
    cost_center: 'R&D',
    enterprise_organization: 'Example',
    division: 'Core',
    department: 'Platform',
    manager_id: own.bob,
    created_at: '2026-11-01T08:00:00Z',
    updated_at: '2026-11-02T09:30:00.250Z',
  },
  {
    id: own.carol,
    user_name: 'carol@example.com',
    external_id: 'EXT-carol',
    display_name: 'Carol',
    active: false,
    created_at: '2026-11-01T10:00:00Z',
  },
  {
    id: own.dave,
    user_name: 'Dave@Example.com',
    active: false,
    created_at: '2026-11-01T11:00:00Z',
  },
  {
    id: own.erin,
    user_name: 'erin.idp@example.com',
    external_id: 'ext-erin',
    created_at: '2026-11-01T12:00:00Z',
  },
  {
    id: own.frank,
    user_name: 'frank@example.com',
    external_id: 'ext-frank',
    manager_id: own.gone,
    created_at: '2026-11-01T13:00:00Z',
  },
  // Reuses the retired entry's identifiers, as a fresh resource may.
  {
    id: own.fresh,
    user_name: 'Reuse@Example.com',
    external_id: 'ext-reuse',
    created_at: '2026-11-06T00:00:00Z',
  },
]
const foreignEntries: Fixture[] = [
  {
    id: foreign.alice,
    user_name: 'alice@example.com',
    external_id: 'ext-alice',
    display_name: 'Other Alice',
    created_at: '2026-11-01T08:00:00Z',
  },
  {
    id: foreign.only,
    user_name: 'only.foreign@example.com',
    external_id: 'ext-only-foreign',
    active: false,
    created_at: '2026-11-01T08:00:00Z',
  },
  {
    id: foreign.gone,
    user_name: 'foreign.gone@example.com',
    active: false,
    retired_at: '2026-11-05T00:00:00Z',
    created_at: '2026-11-01T08:00:00Z',
  },
]

const iso = (text: string) => new Date(text).toISOString()
const location = (organization: string, id: string) =>
  `${publicUrl}/scim/v2/${organization}/Users/${id}`
// RFC 7643 section 4.1 and docs/scim.md's mapping table, written out per entry.
function expected(organization: string, entry: Fixture, extra: Json = {}): Json {
  return {
    schemas: [core],
    id: entry.id,
    ...(entry.external_id ? { externalId: entry.external_id } : {}),
    userName: entry.user_name,
    ...(entry.display_name ? { displayName: entry.display_name } : {}),
    active: entry.active ?? true,
    ...extra,
    meta: {
      resourceType: 'User',
      created: iso(entry.created_at),
      lastModified: iso(entry.updated_at ?? entry.created_at),
      location: location(organization, entry.id),
    },
  }
}
const listed = (totalResults: number, startIndex: number, Resources: unknown[]) => ({
  schemas: [SCIM_URN.listResponse],
  totalResults,
  itemsPerPage: Resources.length,
  startIndex,
  Resources,
})
const query = (entries: Record<string, string>) => new URLSearchParams(entries).toString()
const leafPaths = (value: unknown, prefix = ''): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => leafPaths(item, prefix))
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([name, child]) =>
    leafPaths(child, prefix ? `${prefix}.${name}` : name),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('SCIM User reads over HTTP', () => {
  let owned: TestDatabase, db: Db
  let ownOrganization: string, foreignOrganization: string, bigOrganization: string
  let snapshotOrganization: string
  let personal: TestUser, native: TestUser, linked: TestUser
  let probes: { label: string; id: string }[]
  let bigIds: string[]
  const secrets: Record<'own' | 'ownSecond' | 'foreign' | 'big' | 'snapshot', string> = {
    own: '',
    ownSecond: '',
    foreign: '',
    big: '',
    snapshot: '',
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
  async function entries(organizationId: string, rows: Fixture[]) {
    const { id: connection } = await db
      .selectFrom('scim_connections')
      .select('id')
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow()
    for (const row of rows)
      await db
        .insertInto('scim_users')
        .values({
          updated_at: row.created_at,
          ...row,
          organization_id: organizationId,
          connection_id: connection,
        })
        .execute()
  }
  const memberId = async (userId: string, organizationId: string) =>
    (
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('userId', '=', userId)
        .where('organizationId', '=', organizationId)
        .executeTakeFirstOrThrow()
    ).id

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'scim_users',
    })
    db = createDb(owned.pool)
    personal = await createTestUser(db, 'Personal')
    native = await createTestUser(db, 'Native')
    linked = await createTestUser(db, 'Linked')
    const owner = await createTestUser(db, 'Owner')
    ownOrganization = (
      await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: native, role: 'member' },
        { user: linked, role: 'member' },
      ])
    ).id
    foreignOrganization = (await createTestTeam(db, [{ user: personal, role: 'member' }])).id
    bigOrganization = (await createTestTeam(db, [{ user: owner, role: 'owner' }])).id
    snapshotOrganization = (await createTestTeam(db, [{ user: owner, role: 'owner' }])).id
    secrets.own = await token(ownOrganization)
    secrets.ownSecond = await token(ownOrganization)
    secrets.foreign = await token(foreignOrganization)
    secrets.big = await token(bigOrganization)
    secrets.snapshot = await token(snapshotOrganization)
    const linkedMember = await memberId(linked.id, ownOrganization)
    await entries(
      ownOrganization,
      ownEntries.map((entry) =>
        entry.id === own.erin
          ? { ...entry, linked_user_id: linked.id, linked_member_id: linkedMember }
          : entry,
      ),
    )
    await entries(foreignOrganization, foreignEntries)
    // More than one page: the default and cap of 100 over real rows.
    bigIds = Array.from({ length: pageCap + 1 }, () => randomUUID())
    await entries(
      bigOrganization,
      bigIds.map((id, index) => ({
        id,
        user_name: `user-${index}@big.example`,
        created_at: '2026-11-01T00:00:00Z',
      })),
    )
    bigIds.sort()
    await entries(snapshotOrganization, [
      { id: randomUUID(), user_name: 'first@snapshot.example', created_at: '2026-11-01T00:00:00Z' },
    ])
    const personalOrganization = (
      await db
        .selectFrom('auth.member')
        .select(['organizationId', 'id'])
        .where('userId', '=', personal.id)
        .where('organizationId', '!=', foreignOrganization)
        .executeTakeFirstOrThrow()
    ).organizationId
    const connection = await db
      .selectFrom('scim_connections')
      .select('id')
      .where('organization_id', '=', ownOrganization)
      .executeTakeFirstOrThrow()
    const tokenRow = await db
      .selectFrom('scim_provisioning_tokens')
      .select('id')
      .where('organization_id', '=', ownOrganization)
      .executeTakeFirstOrThrow()
    // Everything a token must not read through /Users/{id}, and nothing it may.
    probes = [
      { label: 'other organization entry', id: foreign.alice },
      { label: 'other organization inactive entry', id: foreign.only },
      { label: 'other organization retired entry', id: foreign.gone },
      { label: 'retired entry', id: own.gone },
      { label: 'retired entry with reused identifiers', id: own.old },
      { label: 'personal account', id: personal.id },
      { label: 'personal organization', id: personalOrganization },
      {
        label: 'personal account membership',
        id: await memberId(personal.id, personalOrganization),
      },
      { label: 'unmanaged member account', id: native.id },
      { label: 'unmanaged membership', id: await memberId(native.id, ownOrganization) },
      { label: 'linked account', id: linked.id },
      { label: 'linked membership', id: linkedMember },
      { label: 'own organization', id: ownOrganization },
      { label: 'own connection', id: connection.id },
      { label: 'own token', id: tokenRow.id },
      { label: 'unknown', id: randomUUID() },
      { label: 'upper-case own ID', id: own.alice.toUpperCase() },
      { label: 'own ID with a suffix', id: `${own.alice}0` },
      { label: 'not a UUID', id: 'not-a-uuid' },
      { label: 'empty', id: '' },
    ]
  })
  afterAll(async () => {
    await owned?.drop()
  })

  // 500 answers seen; a mutant must fail an assertion, not merely break a query.
  let serverErrors = 0
  // The resource test flag: the harness injects the handlers in code.
  const flagged =
    (users: Users, readDb: () => Db = () => db): ScimResourceHandler =>
    (request) =>
      scimDiscovery(request) ?? users(readDb())(request)
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
  // A forged Host and forwarded host never name the locations.
  async function call(
    application: Application,
    organization: string,
    secret: string,
    resource: string,
    method = 'GET',
  ) {
    const response = await application.request(`/scim/v2/${organization}/${resource}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
      },
    })
    if (response.status === 500) serverErrors += 1
    expect(response.headers.get('content-type'), resource).toBe('application/scim+json')
    expect(response.headers.get('cache-control'), resource).toBe('no-store')
    const text = await response.text()
    return { status: response.status, text, body: text ? (JSON.parse(text) as Json) : undefined }
  }
  const client = (users: Users, organization = ownOrganization, secret = secrets.own) => {
    const application = harness(flagged(users))
    return {
      get: (resource: string) => call(application, organization, secret, resource),
      head: (resource: string) => call(application, organization, secret, resource, 'HEAD'),
      send: (resource: string, method: string) =>
        call(application, organization, secret, resource, method),
    }
  }
  const ownFixture = (id: string) => ownEntries.find((entry) => entry.id === id) as Fixture
  const aliceRepresentation = (): Json => ({
    schemas: [core, enterprise],
    id: own.alice,
    externalId: 'ext-alice',
    userName: 'Alice@Example.com',
    name: { formatted: 'Alice Liddell', familyName: 'Liddell', givenName: 'Alice' },
    displayName: 'Alice',
    nickName: 'Al',
    title: 'Engineer',
    userType: 'Employee',
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    active: true,
    emails: [{ value: 'alice.work@example.com', type: 'work', primary: true }],
    [enterprise]: {
      employeeNumber: '42',
      costCenter: 'R&D',
      organization: 'Example',
      division: 'Core',
      department: 'Platform',
      // manager.displayName is derived from the manager's entry.
      manager: { value: own.bob, displayName: 'Bob' },
    },
    meta: {
      resourceType: 'User',
      created: '2026-11-01T08:00:00.000Z',
      lastModified: '2026-11-02T09:30:00.250Z',
      location: location(ownOrganization, own.alice),
    },
  })
  // Every live entry of the own connection, in resource-ID order, inactive ones included.
  const ownListed = () =>
    [own.frank, own.bob, own.dave, own.fresh, own.carol, own.alice, own.erin].map((id) =>
      id === own.alice ? aliceRepresentation() : expected(ownOrganization, ownFixture(id)),
    )

  async function verifyRepresentation(users: Users) {
    const { get, head } = client(users)
    const alice = await get(`Users/${own.alice}`)
    expect(alice.status).toBe(200)
    expect(alice.body).toEqual(aliceRepresentation())
    // Exactly the advertised fields, built from the discovery schemas.
    const schemas = scimDiscovery({
      method: 'GET',
      path: '/Schemas',
      query: new URLSearchParams(),
      principal: { tokenId: 'unused', organizationId: ownOrganization },
      base: 'unused',
    })?.body as { Resources: { id: string; attributes: unknown[] }[] }
    const advertised = schemas.Resources.flatMap((schema) =>
      leafPaths(
        Object.fromEntries(
          (schema.attributes as { name: string; subAttributes?: { name: string }[] }[]).map(
            (attribute) => [
              attribute.name,
              attribute.subAttributes
                ? Object.fromEntries(attribute.subAttributes.map((sub) => [sub.name, 0]))
                : 0,
            ],
          ),
        ),
      ).map((path) => (schema.id === core ? path : `${schema.id}.${path}`)),
    )
    const fields = Object.fromEntries(
      Object.entries(alice.body as Json).filter(
        ([name]) => !['schemas', 'id', 'externalId', 'meta'].includes(name),
      ),
    )
    expect(leafPaths(fields).sort()).toEqual(advertised.sort())
    for (const entry of [own.bob, own.carol, own.dave, own.erin, own.fresh]) {
      const response = await get(`Users/${entry}`)
      expect(response.status, entry).toBe(200)
      expect(response.body, entry).toEqual(expected(ownOrganization, ownFixture(entry)))
    }
    // Frank's manager entry is retired: there is no manager left to refer to.
    expect((await get(`Users/${own.frank}`)).body).toEqual(
      expected(ownOrganization, ownFixture(own.frank)),
    )
    // HEAD answers like GET without a body.
    expect(await head(`Users/${own.alice}`)).toEqual({ status: 200, text: '', body: undefined })
    expect((await head(`Users/${foreign.alice}`)).status).toBe(404)
  }

  async function verifyListing(users: Users) {
    const { get } = client(users)
    const all = await get('Users')
    expect(all.body).toEqual(listed(7, 1, ownListed()))
    // Stable: the same request answers the same bytes, for every token of the connection.
    expect((await get('Users')).text).toBe(all.text)
    expect((await client(users, ownOrganization, secrets.ownSecond).get('Users')).text).toBe(
      all.text,
    )
    // Inactive entries are listed, read and filtered, marked inactive.
    for (const entry of [own.carol, own.dave]) {
      const fixture = ownFixture(entry)
      expect((await get(`Users/${entry}`)).body).toMatchObject({ id: entry, active: false })
      expect(
        (await get(`Users?${query({ filter: `userName eq "${fixture.user_name}"` })}`)).body,
      ).toEqual(listed(1, 1, [expected(ownOrganization, fixture)]))
    }
    // The other organization sees only its own entries.
    const other = await client(users, foreignOrganization, secrets.foreign).get('Users')
    expect(other.body).toEqual(
      listed(2, 1, [
        expected(foreignOrganization, foreignEntries[1] as Fixture),
        expected(foreignOrganization, foreignEntries[0] as Fixture),
      ]),
    )
  }

  async function verifyPages(users: Users) {
    const { get } = client(users)
    const all = ownListed()
    const pages: [string, number, unknown[]][] = [
      ['', 1, all],
      ['startIndex=1&count=3', 1, all.slice(0, 3)],
      ['startIndex=4&count=3', 4, all.slice(3, 6)],
      ['startIndex=7&count=3', 7, all.slice(6)],
      ['startIndex=7&count=1', 7, all.slice(6)],
      ['startIndex=8&count=3', 8, []],
      ['startIndex=2', 2, all.slice(1)],
      ['startIndex=6&count=1', 6, all.slice(5, 6)],
      ['count=0', 1, []],
      ['startIndex=3&count=0', 3, []],
      ['startIndex=0&count=2', 1, all.slice(0, 2)],
      ['startIndex=-4&count=2', 1, all.slice(0, 2)],
      ['count=-1', 1, []],
      ['count=6', 1, all.slice(0, 6)],
      ['count=7', 1, all],
      ['count=1000', 1, all],
      ['startIndex=9007199254740991&count=5', 9007199254740991, []],
    ]
    for (const [parameters, startIndex, resources] of pages)
      expect((await get(`Users?${parameters}`)).body, parameters).toEqual(
        listed(7, startIndex, resources),
      )
    // Walking the pages returns every entry once, in order.
    for (const count of [1, 2, 3, 4]) {
      const walked: unknown[] = []
      for (let startIndex = 1; startIndex <= 7; startIndex += count) {
        const page = (await get(`Users?startIndex=${startIndex}&count=${count}`)).body as Json
        expect(page.totalResults).toBe(7)
        walked.push(...(page.Resources as unknown[]))
      }
      expect(walked, `count=${count}`).toEqual(all)
    }
    // Filtered: one live entry at most, with the same page edges.
    const bob = expected(ownOrganization, ownFixture(own.bob))
    const bobFilter = query({ filter: 'userName eq "BOB@EXAMPLE.COM"' })
    for (const [parameters, startIndex, resources] of [
      ['', 1, [bob]],
      ['&startIndex=1&count=1', 1, [bob]],
      ['&startIndex=2', 2, []],
      ['&startIndex=2&count=1', 2, []],
      ['&count=0', 1, []],
      ['&startIndex=0&count=-3', 1, []],
      ['&startIndex=-1', 1, [bob]],
    ] as [string, number, unknown[]][])
      expect((await get(`Users?${bobFilter}${parameters}`)).body, parameters).toEqual(
        listed(1, startIndex, resources),
      )
    // Retired identifiers are reusable: only the live entry matches them.
    const fresh = expected(ownOrganization, ownFixture(own.fresh))
    for (const filter of ['userName eq "reuse@example.com"', 'externalId eq "ext-reuse"'])
      expect((await get(`Users?${query({ filter, count: '5' })}`)).body, filter).toEqual(
        listed(1, 1, [fresh]),
      )
    // The default and cap are 100 over real rows.
    const big = client(users, bigOrganization, secrets.big)
    const ids = async (parameters: string) => {
      const page = (await big.get(`Users?attributes=id&${parameters}`)).body as Json
      expect(page.totalResults, parameters).toBe(pageCap + 1)
      expect(page.itemsPerPage, parameters).toBe((page.Resources as unknown[]).length)
      return (page.Resources as { id: string }[]).map((resource) => resource.id)
    }
    expect(await ids('')).toEqual(bigIds.slice(0, pageCap))
    expect(await ids(`count=${pageCap + 1}`)).toEqual(bigIds.slice(0, pageCap))
    expect(await ids(`startIndex=2&count=${pageCap}`)).toEqual(bigIds.slice(1))
    expect(await ids(`startIndex=${pageCap + 1}`)).toEqual(bigIds.slice(pageCap))
    expect(await ids(`startIndex=${pageCap - 40}&count=50`)).toEqual(bigIds.slice(pageCap - 41))
    expect(await ids(`startIndex=${pageCap + 2}`)).toEqual([])
  }

  async function verifyNotFound(users: Users) {
    const { get, head } = client(users)
    const baseline = await get(`Users/${randomUUID()}`)
    expect(baseline.status).toBe(404)
    expect(baseline.body).toEqual(errorBody(404, 'Resource not found.'))
    // Controls: the token reads its own entries, inactive ones included.
    for (const id of [own.alice, own.carol]) expect((await get(`Users/${id}`)).status).toBe(200)
    for (const { label, id } of probes)
      for (const suffix of ['', '?attributes=displayName', '?excludedAttributes=groups'])
        expect({ label, suffix, ...(await get(`Users/${id}${suffix}`)) }).toEqual({
          label,
          suffix,
          ...baseline,
        })
    expect((await head(`Users/${personal.id}`)).status).toBe(404)
    // Another organization's token: the same answer for this organization's entries.
    const other = client(users, foreignOrganization, secrets.foreign)
    expect((await other.get(`Users/${foreign.alice}`)).status).toBe(200)
    for (const id of [own.alice, own.carol, own.gone, randomUUID()])
      expect(await other.get(`Users/${id}`), id).toEqual(baseline)
  }

  async function verifyFilters(users: Users) {
    const { get } = client(users)
    const filter = (text: string, extra: Record<string, string> = {}) =>
      get(`Users?${query({ filter: text, ...extra })}`)
    const nobody = await filter('userName eq "nobody@nowhere.example"')
    expect(nobody).toEqual({ status: 200, text: nobody.text, body: listed(0, 1, []) })
    const nobodyCount = await filter('userName eq "nobody@nowhere.example"', { count: '5' })
    // Names and identifiers that exist outside this connection's live entries are
    // indistinguishable from names that exist nowhere: same status, same bytes.
    const outside = [
      `userName eq "${personal.email}"`,
      `userName eq "${personal.email.toUpperCase()}"`,
      `userName eq "${native.email}"`,
      `userName eq "${linked.email}"`,
      'userName eq "only.foreign@example.com"',
      'userName eq "foreign.gone@example.com"',
      'externalId eq "ext-only-foreign"',
      'userName eq "gone@example.com"',
      'externalId eq "ext-gone"',
      // externalId is case-sensitive and compared exactly.
      'externalId eq "EXT-ALICE"',
      'externalId eq "ext-carol"',
      'externalId eq " ext-alice"',
    ]
    for (const probe of outside) {
      expect({ probe, ...(await filter(probe)) }).toEqual({ probe, ...nobody })
      expect({ probe, ...(await filter(probe, { count: '5' })) }).toEqual({
        probe,
        ...nobodyCount,
      })
    }
    // Controls: the connection's own entries match, and only them.
    const alice = aliceRepresentation()
    for (const text of [
      'userName eq "alice@example.com"',
      'userName eq "  ALICE@example.COM  "',
      'externalId eq "ext-alice"',
      `${core}:externalId eq "ext-alice"`,
    ])
      expect((await filter(text)).body, text).toEqual(listed(1, 1, [alice]))
    expect((await filter('externalId eq "EXT-carol"')).body).toEqual(
      listed(1, 1, [expected(ownOrganization, ownFixture(own.carol))]),
    )
    expect((await filter('userName eq "erin.idp@example.com"')).body).toEqual(
      listed(1, 1, [expected(ownOrganization, ownFixture(own.erin))]),
    )
    const other = client(users, foreignOrganization, secrets.foreign)
    expect(
      (await other.get(`Users?${query({ filter: 'userName eq "alice@example.com"' })}`)).body,
    ).toEqual(listed(1, 1, [expected(foreignOrganization, foreignEntries[0] as Fixture)]))
    expect((await other.get(`Users?${query({ filter: 'externalId eq "ext-bob"' })}`)).text).toBe(
      nobody.text,
    )
  }

  async function verifyProjection(users: Users) {
    const { get } = client(users)
    const alice = aliceRepresentation()
    const minimal = { schemas: [core], id: own.alice, userName: 'Alice@Example.com' }
    const { externalId, meta, ...withoutCommon } = alice
    const cases: [string, Json][] = [
      ['attributes=displayName', { ...minimal, displayName: 'Alice' }],
      ['attributes=title', { ...minimal, title: 'Engineer' }],
      ['excludedAttributes=id,userName,schemas', alice],
      // Unmapped standard attributes: excluding changes nothing, requesting adds nothing.
      ['excludedAttributes=groups,phoneNumbers,addresses', alice],
      ['excludedAttributes=name.middleName,emails.display,meta.version', alice],
      ['attributes=groups,roles', minimal],
      ['attributes=groups,displayName', { ...minimal, displayName: 'Alice' }],
      // Common attributes may carry the core schema URN.
      [`attributes=${core}:meta`, { ...minimal, meta }],
      [`attributes=${core}:externalId,${core}:id`, { ...minimal, externalId }],
      [`excludedAttributes=${core}:externalId,${core}:meta`, withoutCommon],
      [
        `attributes=${enterprise}:manager`,
        {
          ...minimal,
          schemas: [core, enterprise],
          [enterprise]: { manager: { value: own.bob, displayName: 'Bob' } },
        },
      ],
      [
        `excludedAttributes=${enterprise}`,
        {
          ...Object.fromEntries(Object.entries(alice).filter(([key]) => key !== enterprise)),
          schemas: [core],
        },
      ],
    ]
    for (const [parameters, body] of cases) {
      expect((await get(`Users/${own.alice}?${parameters}`)).body, parameters).toEqual(body)
      expect(
        (await get(`Users?${query({ filter: 'externalId eq "ext-alice"' })}&${parameters}`)).body,
        parameters,
      ).toEqual(listed(1, 1, [body]))
    }
    expect(
      (
        await get(
          `Users?${query({ filter: `${core}:externalId eq "ext-bob"` })}&attributes=${core}:id`,
        )
      ).body,
    ).toEqual(listed(1, 1, [{ schemas: [core], id: own.bob, userName: 'bob@example.com' }]))
    // Refusals stay 400 SCIM Errors with their RFC 7644 keyword.
    const invalidValue = {
      ...errorBody(400, 'The attribute list names an unsupported attribute.'),
      scimType: 'invalidValue',
    }
    for (const resource of [
      `Users/${own.alice}?attributes=badge`,
      `Users/${randomUUID()}?attributes=badge`,
      'Users?excludedAttributes=members',
      `Users?attributes=${core}:schemas`,
    ])
      expect(await get(resource), resource).toMatchObject({ status: 400, body: invalidValue })
    expect(await get(`Users?${query({ filter: 'groups eq "x"' })}`)).toMatchObject({
      status: 400,
      body: {
        ...errorBody(400, 'This attribute cannot be used in a filter.'),
        scimType: 'invalidFilter',
      },
    })
  }

  // The count and the page come from one snapshot: an entry added between them is in neither.
  async function verifySnapshot(users: Users) {
    let added = 0
    const insertBetween: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        const [first] = args.result.rows as Json[]
        if (first && Object.keys(first).join() === 'total') {
          added += 1
          await entries(snapshotOrganization, [
            {
              id: randomUUID(),
              user_name: `added-${randomUUID()}@snapshot.example`,
              created_at: '2026-11-01T00:00:00Z',
            },
          ])
        }
        return args.result
      },
    }
    const observed = db.withPlugin(insertBetween)
    const application = harness(flagged(users, () => observed))
    const page = (await call(application, snapshotOrganization, secrets.snapshot, 'Users'))
      .body as Json
    expect(added).toBe(1)
    expect(page.itemsPerPage).toBe(page.totalResults)
    const after = (await client(users, snapshotOrganization, secrets.snapshot).get('Users'))
      .body as Json
    expect(after.totalResults).toBe((page.totalResults as number) + 1)
  }

  async function verifyUnavailable(users: Users) {
    const { get, send } = client(users)
    // Writes belong to later steps: they keep the unavailable answer.
    for (const [method, resource] of [
      ['POST', 'Users'],
      ['PUT', `Users/${own.alice}`],
      ['PATCH', `Users/${own.alice}`],
      ['DELETE', `Users/${own.alice}`],
      ['DELETE', 'Users'],
      ['POST', 'Users/.search'],
      ['GET', `Users/${own.alice}/manager`],
      ['GET', 'Users/a/b'],
    ] as const)
      expect(await send(resource, method), `${method} ${resource}`).toMatchObject({
        status: 404,
        body: unavailable,
      })
    expect((await get(`Users/${own.alice}`)).body).toEqual(aliceRepresentation())
    expect((await get('ServiceProviderConfig')).status).toBe(200)
  }

  const verifiers = {
    representation: verifyRepresentation,
    listing: verifyListing,
    pages: verifyPages,
    notFound: verifyNotFound,
    filters: verifyFilters,
    projection: verifyProjection,
    snapshot: verifySnapshot,
    unavailable: verifyUnavailable,
  }

  it('takes its scope and page size from docs/scim.md', () => {
    for (const sentence of [
      '| `GET /Users`, `GET /Users/{id}` | Scoped list/read, including inactive managed entries; never a global email lookup. |',
      'User reads see only the live entries of the connection the token is bound to, in its own organization, ordered by resource ID.',
      'Inactive entries are listed and read with `active: false`.',
      'so an unknown, retired, account, membership or other-organization ID gets the same 404 SCIM Error, and a filter naming any of them gets the same empty list as a name that exists nowhere.',
      'A `userName` filter compares the trimmed, lower-cased name, as live uniqueness does; `externalId` compares exactly.',
      'Resource IDs are case-exact, so only the canonical lower-case form names an entry.',
      'An attribute that RFC 7643 defines for the resource but Hourmere does not map, such as `groups`, `phoneNumbers` or `addresses`, is never returned: excluding it changes nothing and requesting it adds nothing.',
      'the common attributes `id`, `externalId` and `meta` may carry the core schema URN',
    ])
      expect(says(sentence), sentence).toBe(true)
    // The big organization holds one entry more than a page.
    expect(pageCap).toBe(100)
  })

  it('builds each representation from the advertised schemas, under PUBLIC_URL', () =>
    verifyRepresentation(scimUsers))
  it("lists the connection's live entries, inactive ones included, in stable ID order", () =>
    verifyListing(scimUsers))
  it('pages filtered and unfiltered lists over real rows', () => verifyPages(scimUsers))
  it('answers every ID outside the connection with the same 404', () => verifyNotFound(scimUsers))
  it('never reveals personal accounts or other organizations through a filter', () =>
    verifyFilters(scimUsers))
  it('projects reads and lists without hiding identity fields', () => verifyProjection(scimUsers))
  it('counts and reads a page in one snapshot', () => verifySnapshot(scimUsers))
  it('leaves writes and other paths unavailable', () => verifyUnavailable(scimUsers))

  it('detects each weakened protection in a source copy', async () => {
    // Placeholders of scim-users.ts's template literals, written without one here.
    const dollar = '$'
    const control = await sourceCopy<typeof import('./scim-users.ts')>('./scim-users.ts')
    serverErrors = 0
    for (const verify of Object.values(verifiers)) await verify(control.scimUsers)
    expect(serverErrors).toBe(0)
    const listScope: [string, string] = [
      ".selectFrom('scim_users')\n        .where(scope(request.principal))\n",
      ".selectFrom('scim_users')\n",
    ]
    const readScope: [string, string] = [
      ".where('scim_users.id', '=', id)\n    .where(scope(request.principal))\n",
      ".where('scim_users.id', '=', id)\n",
    ]
    const mutants: [keyof typeof verifiers, [string, string]][] = [
      // Scope dropped from the list and from the read.
      ['listing', listScope],
      ['filters', listScope],
      ['notFound', readScope],
      // Inactive entries filtered out of the list or the read.
      [
        'listing',
        [
          "        .where('scim_users.retired_at', 'is', null)\n      const selected",
          "        .where('scim_users.retired_at', 'is', null)\n        .where('scim_users.active', '=', true)\n      const selected",
        ],
      ],
      [
        'notFound',
        [
          "    .where('scim_users.retired_at', 'is', null)\n    .executeTakeFirst()",
          "    .where('scim_users.retired_at', 'is', null)\n    .where('scim_users.active', '=', true)\n    .executeTakeFirst()",
        ],
      ],
      // Retired entries listed or read.
      [
        'pages',
        [
          "        .where('scim_users.retired_at', 'is', null)\n      const selected",
          '      const selected',
        ],
      ],
      [
        'notFound',
        [
          "    .where('scim_users.retired_at', 'is', null)\n    .executeTakeFirst()",
          '    .executeTakeFirst()',
        ],
      ],
      // A personal account returned by a filter: a global lookup by email, or through the
      // linked account.
      [
        'filters',
        [
          '  return { status: 200, body: scimListResponse(page, total, resources) }',
          "  if (total === 0 && filter?.attribute === 'userName') {\n    const account = await db.selectFrom('auth.user').select(['id', 'email']).where('email', '=', filter.value).executeTakeFirst()\n    if (account) return { status: 200, body: scimListResponse(page, 1, [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: account.id, userName: account.email }]) }\n  }\n  return { status: 200, body: scimListResponse(page, total, resources) }",
        ],
      ],
      [
        'filters',
        [
          `eb('scim_users.normalized_user_name', '=', sql<string>\`lower(btrim(${dollar}{value}))\`),`,
          `eb.or([eb('scim_users.normalized_user_name', '=', sql<string>\`lower(btrim(${dollar}{value}))\`), eb('scim_users.linked_user_id', 'in', eb.selectFrom('auth.user').select('auth.user.id').where('auth.user.email', '=', value))]),`,
        ],
      ],
      // Distinct 404 bodies: another organization's entry, or an account, told apart.
      [
        'notFound',
        [
          '  if (!row) return notFound\n',
          "  if (!row && (await db.selectFrom('scim_users').select('id').where('id', '=', id).executeTakeFirst())) return { status: 404, body: scimError(404, 'Resource not found in this organization.') }\n  if (!row) return notFound\n",
        ],
      ],
      [
        'notFound',
        [
          '  if (!row) return notFound\n',
          "  if (!row && (await db.selectFrom('auth.user').select('id').where('id', '=', id).executeTakeFirst())) return { status: 403, body: scimError(403, 'Resource not found.') }\n  if (!row) return notFound\n",
        ],
      ],
      // Malformed and differently cased IDs.
      ['notFound', ['  if (!UUID.test(id)) return notFound\n', '']],
      ['notFound', ['[0-9a-f]{12}$/', '[0-9a-f]{12}$/i']],
      // count ignored, startIndex off by one, unstable order, totals from another set.
      [
        'pages',
        [
          'const { filter, projection, ...page } = parsed.value',
          'const { filter, projection, ...requested } = parsed.value\n  const page = { ...requested, count: 100 }',
        ],
      ],
      ['pages', ['.offset(window.offset)', '.offset(page.startIndex)']],
      ['pages', ['.offset(window.offset)', '.offset(window.offset + 1)']],
      ['pages', [".orderBy('scim_users.id')", ".orderBy('scim_users.created_at')"]],
      ['listing', [".orderBy('scim_users.id')", ".orderBy('scim_users.user_name')"]],
      ['pages', ['const counted = await selected', 'const counted = await listed']],
      [
        'snapshot',
        [".setIsolationLevel('repeatable read')", ".setIsolationLevel('read committed')"],
      ],
      // Filter comparisons: userName as uniqueness normalizes it, externalId exactly.
      [
        'filters',
        [`sql<string>\`lower(btrim(${dollar}{value}))\``, `sql<string>\`lower(${dollar}{value})\``],
      ],
      [
        'filters',
        [
          "eb('scim_users.external_id', '=', value)",
          "eb(sql`lower(scim_users.external_id)`, '=', value.toLowerCase())",
        ],
      ],
      // Representation: inactive state, derived manager name, work address, timestamps.
      ['representation', ['active: (row) => row.active,', 'active: () => true,']],
      ['listing', ['active: (row) => row.active,', 'active: () => true,']],
      ['representation', ["    .where('manager.retired_at', 'is', null)\n", '']],
      ['representation', ["'emails.type': () => 'work',", "'emails.type': () => 'home',"]],
      [
        'representation',
        [
          'lastModified: row.updated_at.toISOString(),',
          'lastModified: row.created_at.toISOString(),',
        ],
      ],
      ['representation', ['        ? complex.value !== undefined', '        ? true']],
      // Projection applied to reads and lists.
      [
        'projection',
        [
          'body: projectScimResource(scimUserQuery, representation(row, request.base), parsed.value),',
          'body: representation(row, request.base),',
        ],
      ],
      [
        'projection',
        [
          'projectScimResource(scimUserQuery, representation(row, request.base), projection),',
          'representation(row, request.base),',
        ],
      ],
      // Writes stay unavailable.
      [
        'unavailable',
        [
          "if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) return undefined",
          'if (!match) return undefined',
        ],
      ],
    ]
    // Only the malformed-ID guard protects against a query error itself.
    const uuidGuard = '  if (!UUID.test(id)) return notFound\n'
    for (const [name, mutation] of mutants) {
      const mutant = await sourceCopy<typeof import('./scim-users.ts')>('./scim-users.ts', mutation)
      serverErrors = 0
      await expect(
        verifiers[name](mutant.scimUsers),
        `${name}: ${mutation[1]}`,
      ).rejects.toMatchObject({
        name: 'AssertionError',
      })
      if (mutation[0] !== uuidGuard) expect(serverErrors, `${name}: ${mutation[1]}`).toBe(0)
    }
  })

  // The production assembly, as startServer builds it, with the operator switch on.
  async function productionAnswers(resources: string[], options = productionAppOptions) {
    const config = loadConfig({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: signingSecret,
      PUBLIC_URL: publicUrl,
      SCIM_PROVISIONING_ENABLED: 'true',
    })
    const unreachable = async (): Promise<never> => {
      throw new Error('SCIM User reads must not reach this collaborator')
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
    expect(
      application.routes.map((route) => route.path).filter((path) => /Users/.test(path)),
    ).toEqual([])
    const answers = []
    for (const resource of resources)
      answers.push({
        resource,
        ...(await call(application, ownOrganization, secrets.own, resource)),
      })
    return answers
  }
  const offResources = () => [
    'Users',
    `Users/${own.alice}`,
    `Users/${own.carol}`,
    `Users/${randomUUID()}`,
    `Users?${query({ filter: 'userName eq "alice@example.com"' })}`,
    'Users?startIndex=2&count=1',
  ]

  it('stays unreachable without the flag, while disabled, and in the production assembly', async () => {
    const resources = offResources()
    const answers = async (application: Application) => {
      const replies = []
      for (const resource of resources)
        replies.push({
          resource,
          ...(await call(application, ownOrganization, secrets.own, resource)),
        })
      return replies
    }
    const off = (body: Json) =>
      resources.map((resource) => ({
        resource,
        status: 404,
        text: JSON.stringify(body),
        body,
      }))
    // Flag absent, and the flag present with SCIM_PROVISIONING_ENABLED off.
    expect(await answers(harness(undefined))).toEqual(off(unavailable))
    expect(await answers(harness(flagged(scimUsers), false))).toEqual(
      off(errorBody(404, 'SCIM provisioning is disabled.')),
    )
    expect(await productionAnswers(resources)).toEqual(off(unavailable))
    // Controls: an unmutated copy of the assembly answers the same, and registered in
    // production, User reads would answer.
    const control = await sourceCopy<typeof import('./server.ts')>('./server.ts')
    expect(await productionAnswers(resources, control.productionAppOptions)).toEqual(
      off(unavailable),
    )
    const mutant = await sourceCopy<typeof import('./server.ts')>(
      './server.ts',
      [
        "import { type AppDeps, createApp } from './app.ts'",
        "import { type AppDeps, createApp } from './app.ts'\nimport { scimUsers } from './scim-users.ts'",
      ],
      [
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED },',
        'scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED, resources: scimUsers(db) },',
      ],
    )
    const registered = await productionAnswers(resources, mutant.productionAppOptions)
    expect(registered.map(({ resource, status }) => ({ resource, status }))).toEqual(
      resources.map((resource, index) => ({ resource, status: index === 3 ? 404 : 200 })),
    )
  })
})
