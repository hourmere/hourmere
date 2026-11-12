import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SCIM_ERROR_SCHEMA, scimError } from './scim.ts'
import { SCIM_URN, scimDiscovery, scimUserSchemas } from './scim-discovery.ts'
import * as real from './scim-query.ts'

type Query = typeof import('./scim-query.ts')
type ErrorKey = keyof Query['SCIM_QUERY_ERRORS']
type Json = Record<string, unknown>

// Expectations come from docs/scim.md, RFC 7643/7644 and RFC 7159, never from the code's
// own constants, so a weakened bound or rule fails here.
const design = readFileSync(new URL('../../../docs/scim.md', import.meta.url), 'utf8')
const core = SCIM_URN.user
const enterprise = SCIM_URN.enterpriseUser
// A sentence of the design, however its lines wrap.
const says = (sentence: string) =>
  new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')).test(design)
const number = (pattern: RegExp) => {
  const text = pattern.exec(design)?.[1]
  expect(text, String(pattern)).toMatch(/^[\d,]+$/)
  return Number(text?.replaceAll(',', ''))
}
const bounds = {
  pageDefault: number(/Offset pagination starts at 1, defaults to ([\d,]+), caps at/),
  pageCap: number(/Offset pagination starts at 1, defaults to [\d,]+, caps at ([\d,]+)/),
  filter: number(/A filter is at most ([\d,]+) characters and exactly\s+one comparison/),
  names: number(/An attribute list names at most ([\d,]+) attributes in at\s+most/),
  list: number(/attributes in at\s+most ([\d,]+) characters, in standard attribute notation/),
  integer: number(/is not a decimal integer of at most ([\d,]+) characters/),
}

async function sourceCopy(...mutations: [string, string][]): Promise<Query> {
  const location = new URL('./scim-query.ts', import.meta.url)
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

// A seeded generator, so every property run is reproducible.
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const below = (limit: number) => Math.floor(next() * limit)
  const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T
  const join = (items: readonly string[], most: number) =>
    Array.from({ length: below(most + 1) }, () => pick(items)).join('')
  return { next, below, pick, join }
}

const list = (m: Query, entries: [string, string][]) =>
  m.parseScimListQuery(new URLSearchParams(entries), m.scimUserQuery)
const filtered = (m: Query, text: string) => list(m, [['filter', text]])
function refusal(error: ErrorKey) {
  const [scimType, detail] = real.SCIM_QUERY_ERRORS[error]
  return { ok: false, reply: { status: 400, body: scimError(400, detail, scimType) } }
}
const everyRefusal = () =>
  (Object.keys(real.SCIM_QUERY_ERRORS) as ErrorKey[]).map((error) => refusal(error).reply.body)
const page = { startIndex: 1, count: bounds.pageDefault }
const accepted = (attribute: string, value: string, caseExact: boolean) => ({
  ok: true,
  value: { filter: { attribute, value, caseExact }, projection: undefined, ...page },
})

// RFC 7159 section 7, read by JSON.parse. JSON.parse also allows whitespace around the value,
// which the filter grammar does not, and the design refuses lone surrogates and U+0000.
function oracle(text: string): string | undefined {
  if (!text.startsWith('"') || /[ \t\n\r]$/.test(text)) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
    ? value
    : undefined
}

// Comparison values: [JSON text, decoded value or undefined when refused].
const strings: [string, string | undefined][] = [
  ['""', ''],
  ['"alice@example.com"', 'alice@example.com'],
  ['"a\\"b"', 'a"b'],
  ['"a\\\\b"', 'a\\b'],
  ['"a\\/b"', 'a/b'],
  ['"a/b"', 'a/b'],
  ['"\\b\\f\\n\\r\\t"', '\b\f\n\r\t'],
  ['"\\u00e9\\u00E9\\u0041"', 'ééA'],
  ['"\\ud83d\\ude00"', '😀'],
  ['"\\uD83D\\uDE00"', '😀'],
  ['"😀é\u007f\u2028"', '😀é\u007f\u2028'],
  ['"\\\\\\""', '\\"'],
  ['"\\\\"', '\\'],
  ['"a b  c"', 'a b  c'],
  ['"x and y eq \\"z\\""', 'x and y eq "z"'],
  ['"(a) [b] or not"', '(a) [b] or not'],
  ['plain', undefined],
  ['"open', undefined],
  ['close"', undefined],
  ["'single'", undefined],
  ['"a"b"', undefined],
  ['"a" ', undefined],
  ['"a""', undefined],
  ['"a"x', undefined],
  [' "a"', undefined],
  ['"\\"', undefined],
  ['"\\', undefined],
  ['"\\x41"', undefined],
  ['"\\U00e9"', undefined],
  ['"\\\'"', undefined],
  ['"\\0"', undefined],
  ['"\\a"', undefined],
  ['"\\u12"', undefined],
  ['"\\u12G4"', undefined],
  ['"\\u"', undefined],
  ['"\\u-123"', undefined],
  ['"\\u 123"', undefined],
  ['"a\tb"', undefined],
  ['"a\nb"', undefined],
  ['"a\rb"', undefined],
  ['"a\u0000b"', undefined],
  ['"\u001f"', undefined],
  ['"\\u0000"', undefined],
  ['"a\\u0000b"', undefined],
  ['"\\ud800"', undefined],
  ['"\\udc00"', undefined],
  ['"\\ude00\\ud83d"', undefined],
  ['"\\ud83d x"', undefined],
  ['true', undefined],
  ['false', undefined],
  ['null', undefined],
  ['1', undefined],
  ['-1.5e3', undefined],
  ['["a"]', undefined],
  ['{"a":1}', undefined],
]

function verifyStrings(m: Query) {
  for (const [text, decoded] of strings) {
    // The table itself is RFC 7159: the oracle agrees with every row.
    expect(oracle(text), JSON.stringify(text)).toBe(decoded)
    expect(filtered(m, `externalId eq ${text}`), JSON.stringify(text)).toEqual(
      decoded === undefined ? refusal('filterValue') : accepted('externalId', decoded, true),
    )
  }
}

function verifyEscapeProperties(m: Query) {
  const random = generator(7644)
  const fragments = [
    ...['"', '\\', 'u', '0', 'e', '9', 'D', '8', '3', 'd', 'c', 'F', 'G', 'n', 't', 'r', 'b'],
    ...['f', '/', 'x', ' ', 'a', '\t', '\n', '\u0000', '\u001f', '\u007f', 'é', '\u2028'],
    ...['\ud83d', '\ude00', '\\u', '\\ud83d', '\\ude00', '\\u0000', '\\"', '\\\\', '\\/'],
  ]
  for (let run = 0; run < 3000; run++) {
    const body = random.join(fragments, 12)
    const text = `${random.next() < 0.9 ? '"' : ''}${body}${random.next() < 0.7 ? '"' : ''}`
    // A query holds USVStrings: an unpaired surrogate in it arrives as U+FFFD.
    const decoded = oracle(text.toWellFormed())
    expect(filtered(m, `userName eq ${text}`), JSON.stringify(text)).toEqual(
      decoded === undefined ? refusal('filterValue') : accepted('userName', decoded, false),
    )
  }
  // Any well-formed value round-trips, written by JSON.stringify or fully \u-escaped.
  const characters = ['a', 'Z', '"', '\\', '/', ' ', '\t', '\n', '\u0001', '\u007f', 'é', '😀']
  for (let run = 0; run < 1000; run++) {
    const value = random.join([...characters, '\u2028', '\ufffd', ' eq ', ' and '], 20)
    const escaped = [...Array(value.length).keys()]
      .map((index) => `\\u${value.charCodeAt(index).toString(16).padStart(4, '0')}`)
      .join('')
    for (const text of [JSON.stringify(value), `"${escaped}"`])
      expect(filtered(m, `externalId eq ${text}`), text).toEqual(
        accepted('externalId', value, true),
      )
  }
}

function verifyFilters(m: Query) {
  // Users filter userName (case-insensitive) and externalId (case-sensitive) with eq only.
  const ok: [string, string, string, boolean][] = [
    ['userName eq "alice@example.com"', 'userName', 'alice@example.com', false],
    ['externalId eq "00u1abc"', 'externalId', '00u1abc', true],
    ['USERNAME EQ "x"', 'userName', 'x', false],
    ['UserName Eq "x"', 'userName', 'x', false],
    ['EXTERNALID eQ "x"', 'externalId', 'x', true],
    [`${core}:userName eq "x"`, 'userName', 'x', false],
    [`${core.toUpperCase()}:USERNAME eq "x"`, 'userName', 'x', false],
    ['userName eq ""', 'userName', '', false],
    ['userName eq "a eq b"', 'userName', 'a eq b', false],
  ]
  for (const [text, attribute, value, caseExact] of ok)
    expect(filtered(m, text), text).toEqual(accepted(attribute, value, caseExact))
  const refused: [string, ErrorKey][] = [
    ['', 'filterForm'],
    [' ', 'filterForm'],
    ['userName', 'filterForm'],
    ['userName eq', 'filterForm'],
    ['userName pr', 'filterForm'],
    [' userName eq "x"', 'filterForm'],
    ['userName  eq "x"', 'filterForm'],
    ['userName\teq\t"x"', 'filterForm'],
    ['userName eq ', 'filterValue'],
    ['userName eq  "x"', 'filterValue'],
    ['userName eq "x" ', 'filterValue'],
    ['userName eq "a" and externalId eq "b"', 'filterValue'],
    ['userName eq "a" or userName eq "b"', 'filterValue'],
    ['userName eq "a"and', 'filterValue'],
    ['userName eq x', 'filterValue'],
    ['userName eq true', 'filterValue'],
    ['displayName eq "x"', 'filterAttribute'],
    ['id eq "x"', 'filterAttribute'],
    ['name.givenName eq "x"', 'filterAttribute'],
    ['emails.value eq "x"', 'filterAttribute'],
    ['emails[type eq "work"].value eq "x"', 'filterAttribute'],
    ['meta.lastModified gt "2026-01-01T00:00:00Z"', 'filterAttribute'],
    [`${enterprise}:employeeNumber eq "x"`, 'filterAttribute'],
    [`${core}:externalId eq "x"`, 'filterAttribute'],
    [`${core}:id eq "x"`, 'filterAttribute'],
    ['urn:ietf:params:scim:schemas:core:2.0:Group:displayName eq "x"', 'filterAttribute'],
    ['userName.value eq "x"', 'filterAttribute'],
    ['userNames eq "x"', 'filterAttribute'],
    ['not (userName eq "x")', 'filterAttribute'],
    ['(userName eq "x")', 'filterAttribute'],
    ['userName eq "x" and', 'filterValue'],
    ['userName == "x"', 'filterOperator'],
    ['userName eqq "x"', 'filterOperator'],
    ['userName e "x"', 'filterOperator'],
  ]
  // RFC 7644 figure 1 operators other than eq, and presence.
  for (const operator of ['ne', 'co', 'sw', 'ew', 'gt', 'lt', 'ge', 'le', 'pr', 'NE', 'Co'])
    refused.push([`userName ${operator} "x"`, 'filterOperator'])
  for (const [text, error] of refused)
    expect(filtered(m, text), JSON.stringify(text)).toEqual(refusal(error))
  expect(
    list(m, [
      ['filter', 'userName eq "a"'],
      ['filter', 'userName eq "a"'],
    ]),
  ).toEqual(refusal('filterRepeated'))
}

function verifyFilterBound(m: Query) {
  // 'externalId eq "' and the closing quote: 16 characters around the value.
  const at = `externalId eq "${'x'.repeat(bounds.filter - 16)}"`
  expect(at.length).toBe(bounds.filter)
  expect(filtered(m, at)).toEqual(accepted('externalId', 'x'.repeat(bounds.filter - 16), true))
  const over = `externalId eq "${'x'.repeat(bounds.filter - 15)}"`
  expect(filtered(m, over)).toEqual(refusal('filterTooLong'))
  // The bound applies before anything else is read, whatever follows.
  for (const text of [
    `userName co "${'x'.repeat(bounds.filter)}"`,
    '\\'.repeat(bounds.filter * 4),
    `${'('.repeat(bounds.filter)}userName eq "x"`,
    `userName eq "${'\\u00e9'.repeat(bounds.filter)}"`,
  ])
    expect(filtered(m, text)).toEqual(refusal('filterTooLong'))
}

// A User with every advertised attribute and every common attribute.
const id = '6f2d4b8e-1c3a-4e5f-9a7b-0c1d2e3f4a5b'
const alice: Json = {
  schemas: [core, enterprise],
  id,
  externalId: '00u1abc',
  userName: 'alice@example.com',
  name: { formatted: 'Alice Liddell', familyName: 'Liddell', givenName: 'Alice' },
  displayName: 'Alice',
  nickName: 'Al',
  title: 'Engineer',
  userType: 'Employee',
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  active: false,
  emails: [{ value: 'alice@example.com', type: 'work', primary: true }],
  [enterprise]: {
    employeeNumber: '42',
    costCenter: 'R&D',
    organization: 'Example',
    division: 'Core',
    department: 'Platform',
    manager: { value: 'b1e2c3d4-0000-4000-8000-000000000001', displayName: 'Bob' },
  },
  meta: {
    resourceType: 'User',
    created: '2026-11-01T00:00:00Z',
    lastModified: '2026-11-02T00:00:00Z',
    location: `https://scim-public.example/scim/v2/org/Users/${id}`,
  },
}
// "Never let projection hide mandatory identity fields": schemas, id (RFC 7643 section 3.1)
// and userName, the one field the User schema returns always.
const minimal = { schemas: [core], id, userName: 'alice@example.com' }
const identity = { id, userName: 'alice@example.com' }
const extension = alice[enterprise] as Json
const without = (object: Json, ...names: string[]) =>
  Object.fromEntries(Object.entries(object).filter(([name]) => !names.includes(name)))

function project(m: Query, entries: [string, string][], representation = alice) {
  const parsed = m.parseScimProjection(new URLSearchParams(entries), m.scimUserQuery)
  if (!parsed.ok) return parsed
  return m.projectScimResource(m.scimUserQuery, representation, parsed.value)
}

function verifyProjection(m: Query) {
  const cases: [[string, string][], Json][] = [
    [[], alice],
    [[['attributes', 'userName']], minimal],
    [[['attributes', 'id']], minimal],
    [[['attributes', 'schemas']], minimal],
    [[['attributes', 'displayName']], { ...minimal, displayName: 'Alice' }],
    [[['attributes', 'active']], { ...minimal, active: false }],
    [[['attributes', 'name']], { ...minimal, name: alice.name }],
    [[['attributes', 'name.givenName']], { ...minimal, name: { givenName: 'Alice' } }],
    [[['attributes', 'NAME.GIVENNAME']], { ...minimal, name: { givenName: 'Alice' } }],
    [[['attributes', `${core}:name.givenName`]], { ...minimal, name: { givenName: 'Alice' } }],
    [
      [['attributes', `${core.toLowerCase()}:Name.GivenName,name.familyName,name.givenName`]],
      { ...minimal, name: { familyName: 'Liddell', givenName: 'Alice' } },
    ],
    [[['attributes', 'emails']], { ...minimal, emails: alice.emails }],
    [[['attributes', 'emails.value']], { ...minimal, emails: [{ value: 'alice@example.com' }] }],
    [
      [['attributes', 'externalId,meta.location']],
      { ...minimal, externalId: '00u1abc', meta: { location: (alice.meta as Json).location } },
    ],
    [
      [['attributes', enterprise]],
      { ...minimal, schemas: [core, enterprise], [enterprise]: extension },
    ],
    [
      [['attributes', `${enterprise}:department,${enterprise.toLowerCase()}:MANAGER.displayName`]],
      {
        ...minimal,
        schemas: [core, enterprise],
        [enterprise]: { department: 'Platform', manager: { displayName: 'Bob' } },
      },
    ],
    [[['excludedAttributes', 'id,userName,schemas']], alice],
    [[['excludedAttributes', `${core}:userName`]], alice],
    [[['excludedAttributes', 'USERNAME,ID,Schemas']], alice],
    [
      [['excludedAttributes', 'name.givenName']],
      { ...alice, name: { formatted: 'Alice Liddell', familyName: 'Liddell' } },
    ],
    [
      [['excludedAttributes', 'name.formatted,name.familyName,name.givenName']],
      without(alice, 'name'),
    ],
    [[['excludedAttributes', 'name']], without(alice, 'name')],
    [[['excludedAttributes', enterprise]], { ...without(alice, enterprise), schemas: [core] }],
    [
      [['excludedAttributes', `${enterprise}:manager`]],
      { ...alice, [enterprise]: without(extension, 'manager') },
    ],
    [
      [['excludedAttributes', `${enterprise}:manager.value,${enterprise}:manager.displayName`]],
      { ...alice, [enterprise]: without(extension, 'manager') },
    ],
    [
      [['excludedAttributes', 'emails.type']],
      { ...alice, emails: [{ value: 'alice@example.com', primary: true }] },
    ],
    [[['excludedAttributes', 'emails.value,emails.type,emails.primary']], without(alice, 'emails')],
    [
      [['excludedAttributes', 'meta,externalId,active']],
      without(alice, 'meta', 'externalId', 'active'),
    ],
  ]
  for (const [entries, expected] of cases)
    expect(project(m, entries), JSON.stringify(entries)).toEqual(expected)
  // Without its extension object, a User keeps only the core schema.
  const plain = { ...without(alice, enterprise), schemas: [core] }
  expect(project(m, [['attributes', enterprise]], plain)).toEqual(minimal)
  expect(project(m, [['excludedAttributes', 'userName']], plain)).toEqual(plain)

  const unknown = [
    '',
    'roles',
    'password',
    'groups',
    'entitlements',
    'emails.display',
    'manager',
    'department',
    'meta.version',
    'name.givenName.x',
    'name.',
    '.name',
    'userName,',
    ',userName',
    'userName, name',
    ' userName',
    'nic\u212AName',
    core,
    `${core}:`,
    `${core}:id`,
    `${core}:${enterprise}:department`,
    `${enterprise}:`,
    `${enterprise}x`,
    `${enterprise}:userName`,
    `${enterprise}:manager.value.x`,
    'urn:ietf:params:scim:schemas:core:2.0:Group:displayName',
    'urn:ietf:params:scim:schemas:core:2.0:Group',
  ]
  for (const name of unknown)
    for (const mode of ['attributes', 'excludedAttributes'])
      expect(project(m, [[mode, name]]), `${mode}=${name}`).toEqual(refusal('attributesUnknown'))
  // "Mutually exclusive" (RFC 7644 section 3.9); one list per parameter.
  expect(
    project(m, [
      ['attributes', 'userName'],
      ['excludedAttributes', 'name'],
    ]),
  ).toEqual(refusal('attributesExclusive'))
  for (const mode of ['attributes', 'excludedAttributes'])
    expect(
      project(m, [
        [mode, 'name'],
        [mode, 'name'],
      ]),
    ).toEqual(refusal('attributesRepeated'))
  // Bounds: names, then characters.
  const names = (count: number) => Array(count).fill('displayName').join(',')
  expect(project(m, [['attributes', names(bounds.names)]])).toEqual({
    ...minimal,
    displayName: 'Alice',
  })
  expect(project(m, [['attributes', names(bounds.names + 1)]])).toEqual(
    refusal('attributesTooLong'),
  )
  expect(project(m, [['attributes', 'x'.repeat(bounds.list)]])).toEqual(
    refusal('attributesUnknown'),
  )
  expect(project(m, [['excludedAttributes', 'x'.repeat(bounds.list + 1)]])).toEqual(
    refusal('attributesTooLong'),
  )
}

// A deep subset: every value present in the projection is the original's.
function within(part: unknown, whole: unknown): boolean {
  if (Array.isArray(part))
    return Array.isArray(whole) && part.every((item) => whole.some((other) => within(item, other)))
  if (typeof part === 'object' && part !== null)
    return (
      typeof whole === 'object' &&
      whole !== null &&
      Object.entries(part).every(([name, value]) => within(value, (whole as Json)[name]))
    )
  return Object.is(part, whole)
}

function verifyProjectionProperties(m: Query) {
  const random = generator(7643)
  // Every attribute name, with and without its URN, in random case.
  const leaves = (attributes: readonly { name: string; subAttributes?: unknown[] }[]) =>
    attributes.flatMap((attribute) => [
      attribute.name,
      ...((attribute.subAttributes ?? []) as { name: string }[]).map(
        (sub) => `${attribute.name}.${sub.name}`,
      ),
    ])
  const [user, extended] = scimUserSchemas
  const names = [
    ...['schemas', 'id', 'externalId', 'meta', 'meta.location', 'meta.created'],
    ...leaves(user?.attributes ?? []),
    ...leaves(user?.attributes ?? []).map((name) => `${core}:${name}`),
    ...leaves(extended?.attributes ?? []).map((name) => `${enterprise}:${name}`),
    enterprise,
  ]
  const shuffle = (name: string) =>
    [...name].map((letter) => (random.next() < 0.3 ? letter.toUpperCase() : letter)).join('')
  for (let run = 0; run < 2000; run++) {
    const chosen = Array.from({ length: 1 + random.below(8) }, () => shuffle(random.pick(names)))
    const mode = random.pick(['attributes', 'excludedAttributes'])
    const projected = project(m, [[mode, chosen.join(',')]])
    const label = `${mode}=${chosen.join(',')}`
    expect(projected, label).toMatchObject(identity)
    expect((projected as Json).schemas, label).toContain(core)
    expect(within(projected, alice), label).toBe(true)
  }
}

function verifyPages(m: Query) {
  const pages: [[string, string][], number, number][] = [
    [[], 1, bounds.pageDefault],
    [[['startIndex', '1']], 1, bounds.pageDefault],
    [[['startIndex', '2']], 2, bounds.pageDefault],
    [[['startIndex', '0005']], 5, bounds.pageDefault],
    // RFC 7644 section 3.4.2.4: below 1 is 1.
    [[['startIndex', '0']], 1, bounds.pageDefault],
    [[['startIndex', '-1']], 1, bounds.pageDefault],
    [[['startIndex', '-0']], 1, bounds.pageDefault],
    [[['startIndex', `-${'9'.repeat(31)}`]], 1, bounds.pageDefault],
    [
      [['startIndex', String(Number.MAX_SAFE_INTEGER)]],
      Number.MAX_SAFE_INTEGER,
      bounds.pageDefault,
    ],
    [[['count', '0']], 1, 0],
    [[['count', '1']], 1, 1],
    [[['count', String(bounds.pageCap)]], 1, bounds.pageCap],
    // Capped at the maximum, however large.
    [[['count', String(bounds.pageCap + 1)]], 1, bounds.pageCap],
    [[['count', `1${'0'.repeat(31)}`]], 1, bounds.pageCap],
    // A negative count is 0.
    [[['count', '-1']], 1, 0],
    [[['count', '-0']], 1, 0],
    [[['count', `-${'9'.repeat(31)}`]], 1, 0],
    [
      [
        ['startIndex', '3'],
        ['count', '2'],
      ],
      3,
      2,
    ],
  ]
  for (const [entries, startIndex, count] of pages)
    expect(list(m, entries), JSON.stringify(entries)).toEqual({
      ok: true,
      value: { filter: undefined, projection: undefined, startIndex, count },
    })
  const notIntegers = ['', ' 1', '1 ', '+1', '1.0', '1.5', '1e2', '0x10', 'abc', 'NaN']
  notIntegers.push('Infinity', '--1', '1-', '١', '１', '1\n', '9'.repeat(bounds.integer + 1))
  for (const value of notIntegers) {
    expect(list(m, [['startIndex', value]]), value).toEqual(refusal('startIndexInteger'))
    expect(list(m, [['count', value]]), value).toEqual(refusal('countInteger'))
  }
  for (const value of [String(Number.MAX_SAFE_INTEGER + 1), '9'.repeat(bounds.integer)])
    expect(list(m, [['startIndex', value]]), value).toEqual(refusal('startIndexRange'))
  expect(
    list(m, [
      ['startIndex', '1'],
      ['startIndex', '1'],
    ]),
  ).toEqual(refusal('startIndexRepeated'))
  expect(
    list(m, [
      ['count', '1'],
      ['count', '1'],
    ]),
  ).toEqual(refusal('countRepeated'))
}

function verifyWindows(m: Query) {
  // Seven resources in stable order; each page is an OFFSET and LIMIT over them.
  const all = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']
  const windows: [string, string, string[]][] = [
    ['1', '100', all],
    ['1', '3', ['r1', 'r2', 'r3']],
    ['2', '3', ['r2', 'r3', 'r4']],
    ['4', '3', ['r4', 'r5', 'r6']],
    ['7', '3', ['r7']],
    ['8', '3', []],
    ['100', '5', []],
    ['0', '2', ['r1', 'r2']],
    ['-4', '1', ['r1']],
    ['1', '0', []],
    ['5', '0', []],
    ['3', '-2', []],
  ]
  for (const [startIndex, count, expected] of windows) {
    const parsed = list(m, [
      ['startIndex', startIndex],
      ['count', count],
    ])
    const label = `startIndex=${startIndex}&count=${count}`
    expect(parsed.ok, label).toBe(true)
    if (!parsed.ok) return
    const { offset, limit } = m.scimPageWindow(parsed.value)
    expect(all.slice(offset, offset + limit), label).toEqual(expected)
    expect(
      m.scimListResponse(parsed.value, all.length, all.slice(offset, offset + limit)),
      label,
    ).toEqual({
      schemas: [SCIM_URN.listResponse],
      totalResults: 7,
      itemsPerPage: expected.length,
      startIndex: Math.max(1, Number(startIndex)),
      Resources: expected,
    })
  }
  // Never more than count, even when given more.
  expect(m.scimListResponse({ startIndex: 1, count: 2 }, 7, all)).toMatchObject({
    itemsPerPage: 2,
    Resources: ['r1', 'r2'],
  })
}

const examples: Record<ErrorKey, [string, string][]> = {
  filterRepeated: [
    ['filter', 'userName eq "a"'],
    ['filter', 'externalId eq "b"'],
  ],
  filterTooLong: [['filter', `userName eq "${'x'.repeat(bounds.filter)}"`]],
  filterForm: [['filter', 'userName']],
  filterAttribute: [['filter', 'displayName eq "x"']],
  filterOperator: [['filter', 'userName sw "x"']],
  filterValue: [['filter', 'userName eq "\\x"']],
  attributesRepeated: [
    ['excludedAttributes', 'name'],
    ['excludedAttributes', 'title'],
  ],
  attributesExclusive: [
    ['attributes', 'name'],
    ['excludedAttributes', 'title'],
  ],
  attributesTooLong: [['attributes', 'x'.repeat(bounds.list + 1)]],
  attributesUnknown: [['attributes', 'password']],
  startIndexRepeated: [
    ['startIndex', '1'],
    ['startIndex', '2'],
  ],
  startIndexInteger: [['startIndex', 'first']],
  startIndexRange: [['startIndex', '1'.repeat(20)]],
  countRepeated: [
    ['count', '1'],
    ['count', '2'],
  ],
  countInteger: [['count', 'ten']],
}

function verifyErrors(m: Query) {
  expect(Object.keys(examples).sort()).toEqual(Object.keys(real.SCIM_QUERY_ERRORS).sort())
  for (const [error, entries] of Object.entries(examples) as [ErrorKey, [string, string][]][]) {
    const result = list(m, entries)
    expect(result, error).toEqual(refusal(error))
    // RFC 7644 section 3.12: the Error schema, a string status and the scimType keyword:
    // invalidFilter for every filter refusal (section 3.4.2.2 and docs/scim.md), and
    // invalidValue, which Table 9 applies to GET, for the other parameters.
    expect(result.ok ? undefined : result.reply.body, error).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      status: '400',
      scimType: error.startsWith('filter') ? 'invalidFilter' : 'invalidValue',
      detail: expect.any(String),
    })
  }
}

function verifyTotal(m: Query) {
  // Hostile bounded inputs: the parser never throws, accepts only what it can serve, and
  // refuses only with one of its fixed SCIM Errors.
  const random = generator(342)
  const parameters = ['filter', 'attributes', 'excludedAttributes', 'startIndex', 'count']
  const pieces = [
    ...['userName', 'externalId', 'displayName', 'name', 'givenName', 'emails', 'value', 'id'],
    ...['eq', 'EQ', 'ne', 'pr', 'and', 'or', 'not', '(', ')', '[', ']', ' ', '  ', '"', '\\'],
    ...['\\u', '00e9', 'd83d', 'dc00', '0000', '.', ',', ':', '-', '+', '0', '1', '9', 'x'],
    ...['\t', '\u0000', '😀', '\ud800', '\u212A', `${core}:`, `${enterprise}:`, enterprise],
  ]
  const known = everyRefusal()
  for (let run = 0; run < 3000; run++) {
    const entries: [string, string][] = Array.from({ length: random.below(5) }, () => {
      const value = random.join(pieces, 10)
      return [
        random.pick([...parameters, 'sortBy', 'Filter']),
        random.next() < 0.05 ? value.repeat(1 + random.below(100)) : value,
      ]
    })
    const label = JSON.stringify(entries)
    expect(() => list(m, entries), label).not.toThrow()
    const result = list(m, entries)
    if (!result.ok) {
      expect(result.reply.status, label).toBe(400)
      expect(known, label).toContainEqual(result.reply.body)
      continue
    }
    const { startIndex, count, filter, projection } = result.value
    expect(Number.isSafeInteger(startIndex) && startIndex >= 1, label).toBe(true)
    expect(Number.isInteger(count) && count >= 0 && count <= bounds.pageCap, label).toBe(true)
    if (filter) {
      expect(['userName', 'externalId'], label).toContain(filter.attribute)
      expect(filter.value.isWellFormed() && !filter.value.includes('\0'), label).toBe(true)
    }
    if (projection) {
      const projected = m.projectScimResource(m.scimUserQuery, alice, projection)
      expect(projected, label).toMatchObject(identity)
      expect(projected.schemas, label).toContain(core)
      expect(within(projected, alice), label).toBe(true)
    }
  }
}

const verifiers = {
  strings: verifyStrings,
  escapeProperties: verifyEscapeProperties,
  filters: verifyFilters,
  filterBound: verifyFilterBound,
  projection: verifyProjection,
  projectionProperties: verifyProjectionProperties,
  pages: verifyPages,
  windows: verifyWindows,
  errors: verifyErrors,
  total: verifyTotal,
}

describe('SCIM query parser', () => {
  it('takes its subset, defaults, caps and bounds from docs/scim.md', () => {
    const users = /List filters support a single quoted equality expression: Users ([^;]+);/.exec(
      design,
    )?.[1]
    expect(real.scimUserQuery.filters).toEqual(
      [...(users ?? '').matchAll(/`(\w+) eq`/g)].map((match) => match[1]),
    )
    expect(real.scimUserQuery.filters).toEqual(['userName', 'externalId'])
    for (const sentence of [
      'Reject unsupported expressions with 400 `invalidFilter`, not an unfiltered list.',
      'A count of zero returns only totals and an empty resource list; out-of-range pages are empty.',
      'Negative count is treated as zero and startIndex below 1 as 1.',
      'Never let projection hide mandatory identity fields.',
    ])
      expect(says(sentence), sentence).toBe(true)
    expect(bounds.pageDefault).toBe(bounds.pageCap)
    expect(real.SCIM_PAGE_SIZE).toBe(bounds.pageCap)
    expect(real.SCIM_MAX_FILTER_LENGTH).toBe(bounds.filter)
    expect(real.SCIM_MAX_ATTRIBUTE_LIST_LENGTH).toBe(bounds.list)
    expect(real.SCIM_MAX_ATTRIBUTE_LIST_NAMES).toBe(bounds.names)
    // The cap is what ServiceProviderConfig advertises as filter.maxResults.
    const config = scimDiscovery({
      method: 'GET',
      path: '/ServiceProviderConfig',
      query: new URLSearchParams(),
      principal: { tokenId: 'unused', organizationId: 'unused' },
      base: 'https://scim-public.example/scim/v2/unused',
    })?.body as { filter: { maxResults: number } }
    expect(config.filter.maxResults).toBe(bounds.pageCap)
    // userName is the schema's one attribute returned always.
    const always = scimUserSchemas.flatMap((schema) =>
      schema.attributes.filter((attribute) => attribute.returned === 'always'),
    )
    expect(always.map((attribute) => attribute.name)).toEqual(['userName'])
  })

  it('decodes comparison values exactly as RFC 7159 strings', () => verifyStrings(real))
  it('agrees with JSON.parse on random strings and round-trips any well-formed value', () =>
    verifyEscapeProperties(real))
  it('accepts only one eq comparison on userName or externalId', () => verifyFilters(real))
  it('bounds the filter length before reading it', () => verifyFilterBound(real))
  it('projects attributes without ever hiding schemas, id or userName', () =>
    verifyProjection(real))
  it('keeps the mandatory fields and only original values under random projections', () =>
    verifyProjectionProperties(real))
  it('reads startIndex and count as RFC 7644 section 3.4.2.4 defines them', () => verifyPages(real))
  it('turns pages into offsets and list responses with the actual count', () => verifyWindows(real))
  it('refuses with every SCIM error and status it defines', () => verifyErrors(real))
  it('never throws and refuses only with its own SCIM errors on hostile input', () =>
    verifyTotal(real))

  it('detects each weakened protection in a source copy', async () => {
    const control = await sourceCopy()
    for (const verify of Object.values(verifiers)) verify(control)
    const mutants: [keyof typeof verifiers, [string, string]][] = [
      // Escapes.
      ['strings', ["['\"', '\"'],", '[\'"\', "\'"],']],
      ['strings', ["  ['/', '/'],\n", '']],
      ['strings', ['/^[0-9A-Fa-f]{4}$/', '/^[0-9A-Fa-f]/']],
      [
        'strings',
        ["} else if (character < ' ') return undefined", '} else if (false) return undefined'],
      ],
      ['strings', ['value.isWellFormed() && ', '']],
      ['strings', [" && !value.includes('\\0')", '']],
      ['strings', ['index === text.length - 1 && ', '']],
      ['escapeProperties', ["  ['b', '\\b'],\n", '']],
      // The length bound.
      [
        'filterBound',
        ["if (text.length > SCIM_MAX_FILTER_LENGTH) return refuse('filterTooLong')", ''],
      ],
      [
        'filterBound',
        ['text.length > SCIM_MAX_FILTER_LENGTH', 'text.length > SCIM_MAX_FILTER_LENGTH + 1'],
      ],
      // Operators, attributes and form.
      [
        'filters',
        ["if (fold(text.slice(first + 1, second)) !== 'eq') return refuse('filterOperator')", ''],
      ],
      ['filters', [' || !resource.filters.includes(resolved.notation)', '']],
      ['filters', ['if (first <= 0 || second <= first + 1)', 'if (first < 0 || second < 0)']],
      ['filters', ["if (filters.length > 1) return refuse('filterRepeated')", '']],
      ['filters', ['text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())', 'text']],
      // Projection.
      ['projection', ['always.has(key(path)) || ', '']],
      ['projection', ["if (attribute.returned === 'always')", "if (attribute.name === 'id')"]],
      [
        'projection',
        [
          "if (included.length > 0 && excluded.length > 0) return refuse('attributesExclusive')",
          '',
        ],
      ],
      [
        'projection',
        ['text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())', 'text.toLowerCase()'],
      ],
      [
        'projection',
        [
          'return within([...common, ...core.attributes], name)',
          'return within([...common, ...core.attributes, ...extensions.flatMap((schema) => schema.attributes)], name)',
        ],
      ],
      ['projection', ['if (parts.length > 2) return undefined', '']],
      ['projection', ['uri === resource.schemas[0]?.id || Object.hasOwn(projected, uri)', 'true']],
      ['projection', ['names.length > SCIM_MAX_ATTRIBUTE_LIST_NAMES', 'false']],
      ['projectionProperties', ['always.has(key(path)) || ', '']],
      // Pagination.
      ['windows', ['offset: startIndex - 1', 'offset: startIndex']],
      ['windows', ['itemsPerPage: returned.length', 'itemsPerPage: page.count']],
      ['windows', ['resources.slice(0, page.count)', 'resources']],
      ['pages', ['count.value ?? SCIM_PAGE_SIZE', 'count.value || SCIM_PAGE_SIZE']],
      ['pages', ['requested <= 0 ? 0 : ', '']],
      ['pages', ['Math.min(requested, SCIM_PAGE_SIZE)', 'requested']],
      ['pages', ['start.value < 1 ? 1', 'start.value < 0 ? 1']],
      ['pages', ['!/^-?[0-9]+$/.test(text)', 'Number.isNaN(Number(text))']],
      ['pages', ["if (!Number.isSafeInteger(startIndex)) return refuse('startIndexRange')", '']],
      ['pages', ['text.length > MAX_INTEGER_LENGTH || ', '']],
      // Errors.
      ['errors', ["filterValue: ['invalidFilter',", "filterValue: ['invalidValue',"]],
      ['strings', ['if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined', '']],
      ['total', ["    if (!resolved) return refuse('attributesUnknown')\n", '']],
    ]
    for (const [name, mutation] of mutants) {
      const mutant = await sourceCopy(mutation)
      let failure: unknown
      try {
        verifiers[name](mutant)
      } catch (error) {
        failure = error
      }
      expect(failure, `${name}: ${mutation[0]}`).toMatchObject({ name: 'AssertionError' })
    }
  })
})
