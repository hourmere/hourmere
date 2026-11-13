// SCIM list and read query parameters: filter (RFC 7644 section 3.4.2.2), attributes and
// excludedAttributes (sections 3.4.2.5, 3.9 and 3.10), startIndex and count (section
// 3.4.2.4). docs/scim.md fixes the subset: one quoted equality comparison on a listed
// attribute, projection over the mapped fields that never hides an attribute returned
// "always", and offset pagination from 1 with a default and cap of 100. The parser is pure
// and total: it returns a parsed query or a 400 SCIM Error whose detail is fixed text that
// never echoes the request. Production imports none of this yet; see ScimResources in scim.ts.
import { type ScimReply, scimError } from './scim.ts'
import { SCIM_URN, scimUserSchemas } from './scim-discovery.ts'

/** Offset pagination default and cap; ServiceProviderConfig advertises it as maxResults. */
export const SCIM_PAGE_SIZE = 100
/** Longest filter read, in UTF-16 code units; one comparison needs far less. */
export const SCIM_MAX_FILTER_LENGTH = 4096
/** Longest attributes or excludedAttributes value (UTF-16 code units) and most names in it. */
export const SCIM_MAX_ATTRIBUTE_LIST_LENGTH = 4096
export const SCIM_MAX_ATTRIBUTE_LIST_NAMES = 64
/** Longest startIndex or count text; larger magnitudes are clamped or refused below. */
const MAX_INTEGER_LENGTH = 32

/** Every refusal: RFC 7644 section 3.12 keyword and a detail that echoes nothing. */
export const SCIM_QUERY_ERRORS = {
  filterSpelling: ['invalidFilter', 'Query parameter names are case-sensitive.'],
  filterRepeated: ['invalidFilter', 'Send at most one filter.'],
  filterTooLong: ['invalidFilter', 'The filter is too long.'],
  filterForm: ['invalidFilter', 'A filter must be one comparison: attribute eq "value".'],
  filterAttribute: ['invalidFilter', 'This attribute cannot be used in a filter.'],
  filterOperator: ['invalidFilter', 'Only the eq operator is supported.'],
  filterValue: ['invalidFilter', 'The comparison value must be a valid quoted string.'],
  parameterSpelling: ['invalidValue', 'Query parameter names are case-sensitive.'],
  attributesRepeated: ['invalidValue', 'Send at most one attributes or excludedAttributes list.'],
  attributesExclusive: ['invalidValue', 'attributes and excludedAttributes cannot be combined.'],
  attributesTooLong: ['invalidValue', 'The attribute list is too long.'],
  attributesUnknown: ['invalidValue', 'The attribute list names an unsupported attribute.'],
  startIndexRepeated: ['invalidValue', 'Send at most one startIndex.'],
  startIndexInteger: ['invalidValue', 'startIndex must be an integer.'],
  startIndexRange: ['invalidValue', 'startIndex is too large.'],
  countRepeated: ['invalidValue', 'Send at most one count.'],
  countInteger: ['invalidValue', 'count must be an integer.'],
} as const satisfies Record<string, readonly ['invalidFilter' | 'invalidValue', string]>

export type ScimQueryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reply: ScimReply & { status: 400 } }

function refuse(error: keyof typeof SCIM_QUERY_ERRORS): {
  ok: false
  reply: { status: 400; body: unknown }
} {
  const [scimType, detail] = SCIM_QUERY_ERRORS[error]
  return { ok: false, reply: { status: 400, body: scimError(400, detail, scimType) } }
}

interface Attribute {
  readonly name: string
  readonly returned: string
  readonly caseExact: boolean
  readonly subAttributes?: readonly Attribute[]
}

type Schema = { readonly id: string; readonly attributes: readonly Attribute[] }

/**
 * Every attribute RFC 7643 defines for a resource type, mapped or not, by schema URN:
 * attribute name → its sub-attribute names.
 */
export type ScimStandardNames = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>

/** What a resource type lets a list filter and a projection name; see scimQueryResource. */
export interface ScimQueryResource {
  /** The core schema first, then its extensions, as /Schemas serves them. */
  schemas: readonly Schema[]
  /** Attributes a filter may compare with eq, in standard attribute notation. */
  filters: readonly string[]
  /**
   * The same schemas with every attribute RFC 7643 defines for them. A projection may name
   * one that is not mapped; it is never returned.
   */
  standard: readonly Schema[]
}

const standardAttribute = (name: string, subAttributes?: readonly string[]): Attribute => ({
  name,
  returned: 'default',
  caseExact: true,
  ...(subAttributes?.length
    ? { subAttributes: subAttributes.map((sub) => standardAttribute(sub)) }
    : {}),
})

/**
 * Projection handles attributes returned "always" or by default, and protects those returned
 * "always" at the top level of a representation, where RFC 7643 puts them for Users and
 * Groups. A schema with any other returned value, or that marks a sub-attribute or an
 * extension attribute "always", is refused here, when its module loads, rather than
 * projected wrongly.
 */
export function scimQueryResource(
  schemas: readonly Schema[],
  filters: readonly string[],
  standard: ScimStandardNames,
): ScimQueryResource {
  const [core, ...extensions] = schemas
  const every = schemas.flatMap((schema) =>
    schema.attributes.flatMap((attribute) => [attribute, ...(attribute.subAttributes ?? [])]),
  )
  if (
    every.some((attribute) => attribute.returned !== 'always' && attribute.returned !== 'default')
  )
    throw new Error('Projection handles only attributes returned always or by default.')
  const nested = [
    ...(core?.attributes ?? []).flatMap((attribute) => attribute.subAttributes ?? []),
    ...extensions.flatMap((extension) =>
      extension.attributes.flatMap((attribute) => [attribute, ...(attribute.subAttributes ?? [])]),
    ),
  ]
  if (nested.some((attribute) => attribute.returned === 'always'))
    throw new Error('Only top-level core attributes can be returned always.')
  return {
    schemas,
    filters,
    standard: schemas.map(({ id }) => ({
      id,
      attributes: Object.entries(standard[id] ?? {}).map(([name, subs]) =>
        standardAttribute(name, subs),
      ),
    })),
  }
}

// RFC 7643 section 2.4: the sub-attributes a multi-valued attribute may have.
const multiValued = ['type', 'primary', 'display', 'value', '$ref']
/** RFC 7643 sections 4.1 and 4.3: every User and enterprise User attribute. */
const rfc7643User: ScimStandardNames = {
  [SCIM_URN.user]: {
    userName: [],
    name: [
      'formatted',
      'familyName',
      'givenName',
      'middleName',
      'honorificPrefix',
      'honorificSuffix',
    ],
    displayName: [],
    nickName: [],
    profileUrl: [],
    title: [],
    userType: [],
    preferredLanguage: [],
    locale: [],
    timezone: [],
    active: [],
    password: [],
    emails: multiValued,
    phoneNumbers: multiValued,
    ims: multiValued,
    photos: multiValued,
    addresses: [
      ...multiValued,
      ...['formatted', 'streetAddress', 'locality', 'region', 'postalCode', 'country'],
    ],
    groups: multiValued,
    entitlements: multiValued,
    roles: multiValued,
    x509Certificates: multiValued,
  },
  [SCIM_URN.enterpriseUser]: {
    employeeNumber: [],
    costCenter: [],
    organization: [],
    division: [],
    department: [],
    manager: ['value', '$ref', 'displayName'],
  },
}

/** Users: `userName eq` and `externalId eq` filters over the advertised User schemas. */
export const scimUserQuery = scimQueryResource(
  scimUserSchemas,
  ['userName', 'externalId'],
  rfc7643User,
)

// RFC 7643 sections 3 and 3.1: attributes of every resource, outside any schema. No ETags,
// so meta has no version.
const meta = ['resourceType', 'created', 'lastModified', 'location'].map((name) => ({
  name,
  returned: 'default',
  caseExact: true,
}))
const common: Attribute[] = [
  { name: 'schemas', returned: 'always', caseExact: true },
  { name: 'id', returned: 'always', caseExact: true },
  { name: 'externalId', returned: 'default', caseExact: true },
  { name: 'meta', returned: 'default', caseExact: true, subAttributes: meta },
]
// The same, with the meta.version that RFC 7643 section 3.1 also defines.
const standardCommon: Attribute[] = [
  ...common.filter((attribute) => attribute.name !== 'meta'),
  standardAttribute('meta', [...meta.map((attribute) => attribute.name), 'version']),
]

/** ASCII case folding: names, URNs and operators are case-insensitive, and only ASCII. */
const fold = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/**
 * Query parameter names are case-sensitive. A known name spelled in another case is refused,
 * because ignoring it would turn a filtered request into an unfiltered list.
 */
function misspelled(query: URLSearchParams, names: readonly string[]) {
  for (const name of query.keys()) {
    const known = names.find((candidate) => fold(candidate) === fold(name))
    if (known !== undefined && known !== name)
      return refuse(known === 'filter' ? 'filterSpelling' : 'parameterSpelling')
  }
  return undefined
}
const named = (attributes: readonly Attribute[], name: string) =>
  attributes.find((attribute) => fold(attribute.name) === fold(name))

interface Resolved {
  /** Representation keys, such as ['name', 'givenName'] or [extension URN, 'manager']. */
  path: string[]
  /** Canonical standard attribute notation. */
  notation: string
  attribute: Attribute
}

function within(attributes: readonly Attribute[], text: string, schema?: string) {
  // attrPath = [URI ":"] ATTRNAME *1subAttr: at most one sub-attribute.
  const parts = text.split('.')
  if (parts.length > 2) return undefined
  const [name = '', sub] = parts
  const parent = named(attributes, name)
  const attribute = sub === undefined ? parent : named(parent?.subAttributes ?? [], sub)
  if (!parent || !attribute) return undefined
  const keys = sub === undefined ? [parent.name] : [parent.name, attribute.name]
  const notation = keys.join('.')
  return {
    path: schema ? [schema, ...keys] : keys,
    notation: schema ? `${schema}:${notation}` : notation,
    attribute,
  }
}

/**
 * An attribute name in standard attribute notation (RFC 7644 section 3.10). Core names may
 * carry the core schema URN, and so may the common attributes id, externalId and meta, which
 * RFC 7643 section 3.1 makes part of every base resource schema. Extension names must be
 * fully qualified, and the extension URN alone names its whole object.
 */
function resolveIn(
  schemas: readonly Schema[],
  shared: readonly Attribute[],
  name: string,
): Resolved | undefined {
  const [core, ...extensions] = schemas
  if (!core) return undefined
  const folded = fold(name)
  for (const extension of extensions) {
    const urn = fold(extension.id)
    if (folded === urn)
      return {
        path: [extension.id],
        notation: extension.id,
        attribute: { name: extension.id, returned: 'default', caseExact: true },
      }
    if (folded.startsWith(`${urn}:`))
      return within(extension.attributes, name.slice(urn.length + 1), extension.id)
  }
  const qualified = folded.startsWith(`${fold(core.id)}:`)
  return within(
    [
      ...shared.filter((attribute) => !qualified || attribute.name !== 'schemas'),
      ...core.attributes,
    ],
    qualified ? name.slice(core.id.length + 1) : name,
  )
}

/**
 * A mapped attribute, null for one RFC 7643 defines for the resource but Hourmere does not
 * map (it is never returned), or undefined for an unknown name.
 */
function resolve(resource: ScimQueryResource, name: string): Resolved | null | undefined {
  const mapped = resolveIn(resource.schemas, common, name)
  if (mapped) return mapped
  return resolveIn(resource.standard, standardCommon, name) ? null : undefined
}

const escapes = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
])

/**
 * A JSON string (RFC 7159 section 7, the compValue rule) spanning the whole text, decoded.
 * Refused: anything outside the quotes, unescaped control characters, unknown escapes, short
 * \u escapes, lone surrogates and U+0000, which no stored identifier can hold.
 */
function jsonString(text: string): string | undefined {
  if (text[0] !== '"') return undefined
  let value = ''
  for (let index = 1; index < text.length; index++) {
    const character = text[index] as string
    if (character === '"')
      return index === text.length - 1 && value.isWellFormed() && !value.includes('\0')
        ? value
        : undefined
    if (character === '\\') {
      const escaped = text[++index]
      if (escaped === 'u') {
        const hex = text.slice(index + 1, index + 5)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
      } else {
        const decoded = escaped === undefined ? undefined : escapes.get(escaped)
        if (decoded === undefined) return undefined
        value += decoded
      }
    } else if (character < ' ') return undefined
    else value += character
  }
  return undefined
}

export interface ScimFilter {
  /** Canonical standard attribute notation, such as `userName`. */
  attribute: string
  /** The decoded comparison value. */
  value: string
  /** Whether the comparison is case-sensitive, from the attribute's caseExact. */
  caseExact: boolean
}

function parseFilter(text: string, resource: ScimQueryResource): ScimQueryResult<ScimFilter> {
  if (text.length > SCIM_MAX_FILTER_LENGTH) return refuse('filterTooLong')
  // attrExp = attrPath SP compareOp SP compValue (RFC 7644 figure 1). Only this one form is
  // accepted, so logical, grouping, value-path and presence filters never parse.
  const first = text.indexOf(' ')
  const second = first < 0 ? -1 : text.indexOf(' ', first + 1)
  if (first <= 0 || second <= first + 1) return refuse('filterForm')
  const resolved = resolve(resource, text.slice(0, first))
  if (!resolved || !resource.filters.includes(resolved.notation)) return refuse('filterAttribute')
  if (fold(text.slice(first + 1, second)) !== 'eq') return refuse('filterOperator')
  const value = jsonString(text.slice(second + 1))
  if (value === undefined) return refuse('filterValue')
  return {
    ok: true,
    value: { attribute: resolved.notation, value, caseExact: resolved.attribute.caseExact },
  }
}

export interface ScimProjection {
  mode: 'attributes' | 'excludedAttributes'
  /** Representation keys of each named attribute. */
  paths: string[][]
}

/** attributes or excludedAttributes, for a list or a single resource (RFC 7644 section 3.9). */
export function parseScimProjection(
  query: URLSearchParams,
  resource: ScimQueryResource,
): ScimQueryResult<ScimProjection | undefined> {
  const spelling = misspelled(query, ['attributes', 'excludedAttributes'])
  if (spelling) return spelling
  const included = query.getAll('attributes')
  const excluded = query.getAll('excludedAttributes')
  if (included.length > 1 || excluded.length > 1) return refuse('attributesRepeated')
  if (included.length > 0 && excluded.length > 0) return refuse('attributesExclusive')
  const list = included[0] ?? excluded[0]
  if (list === undefined) return { ok: true, value: undefined }
  if (list.length > SCIM_MAX_ATTRIBUTE_LIST_LENGTH) return refuse('attributesTooLong')
  const names = list.split(',')
  if (names.length > SCIM_MAX_ATTRIBUTE_LIST_NAMES) return refuse('attributesTooLong')
  const paths: string[][] = []
  for (const name of names) {
    const resolved = resolve(resource, name)
    if (resolved === undefined) return refuse('attributesUnknown')
    // An unmapped standard attribute is never returned: excluding it changes nothing, and
    // requesting it adds nothing.
    if (resolved) paths.push(resolved.path)
  }
  return {
    ok: true,
    value: { mode: included.length > 0 ? 'attributes' : 'excludedAttributes', paths },
  }
}

export interface ScimPage {
  /** 1-based index of the first result. */
  startIndex: number
  /** Most results to return, from 0 to SCIM_PAGE_SIZE. */
  count: number
}

function integer(query: URLSearchParams, name: 'startIndex' | 'count') {
  const values = query.getAll(name)
  if (values.length > 1) return refuse(name === 'count' ? 'countRepeated' : 'startIndexRepeated')
  const [text] = values
  if (text === undefined) return { ok: true as const, value: undefined }
  if (text.length > MAX_INTEGER_LENGTH || !/^-?[0-9]+$/.test(text))
    return refuse(name === 'count' ? 'countInteger' : 'startIndexInteger')
  return { ok: true as const, value: Number(text) }
}

function parsePage(query: URLSearchParams): ScimQueryResult<ScimPage> {
  const start = integer(query, 'startIndex')
  if (!start.ok) return start
  const count = integer(query, 'count')
  if (!count.ok) return count
  // RFC 7644 section 3.4.2.4: a startIndex below 1 is 1 and a negative count is 0.
  const startIndex = start.value === undefined || start.value < 1 ? 1 : start.value
  if (!Number.isSafeInteger(startIndex)) return refuse('startIndexRange')
  const requested = count.value ?? SCIM_PAGE_SIZE
  return {
    ok: true,
    value: { startIndex, count: requested <= 0 ? 0 : Math.min(requested, SCIM_PAGE_SIZE) },
  }
}

export interface ScimListQuery extends ScimPage {
  filter: ScimFilter | undefined
  projection: ScimProjection | undefined
}

/** filter, attributes or excludedAttributes, startIndex and count of a list request. */
export function parseScimListQuery(
  query: URLSearchParams,
  resource: ScimQueryResource,
): ScimQueryResult<ScimListQuery> {
  const spelling = misspelled(query, [
    'filter',
    'attributes',
    'excludedAttributes',
    'startIndex',
    'count',
  ])
  if (spelling) return spelling
  const filters = query.getAll('filter')
  if (filters.length > 1) return refuse('filterRepeated')
  let filter: ScimFilter | undefined
  if (filters[0] !== undefined) {
    const parsed = parseFilter(filters[0], resource)
    if (!parsed.ok) return parsed
    filter = parsed.value
  }
  const projection = parseScimProjection(query, resource)
  if (!projection.ok) return projection
  const page = parsePage(query)
  if (!page.ok) return page
  return { ok: true, value: { filter, projection: projection.value, ...page.value } }
}

/** The rows a page reads: an SQL OFFSET and LIMIT over the stable ordering. */
export function scimPageWindow({ startIndex, count }: ScimPage) {
  return { offset: startIndex - 1, limit: count }
}

/**
 * A ListResponse (RFC 7644 section 3.4.2): itemsPerPage is the number actually returned,
 * never more than count; a page past the end, or a count of 0, has no Resources.
 */
export function scimListResponse(page: ScimPage, totalResults: number, resources: unknown[]) {
  const returned = resources.slice(0, page.count)
  return {
    schemas: [SCIM_URN.listResponse],
    totalResults,
    itemsPerPage: returned.length,
    startIndex: page.startIndex,
    Resources: returned,
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Top-level attributes returned "always"; scimQueryResource refuses any deeper.
const alwaysReturned = (resource: ScimQueryResource) =>
  new Set(
    [...common, ...(resource.schemas[0]?.attributes ?? [])]
      .filter((attribute) => attribute.returned === 'always')
      .map((attribute) => attribute.name),
  )

type Visit = (node: unknown, paths: string[][], at: string[]) => unknown

// Both walks keep a top-level attribute returned "always" whatever the projection names.
function walker(always: Set<string>, mode: ScimProjection['mode']): Visit {
  const visit: Visit = (node, paths, at) => {
    if (paths.some((path) => path.length === 0)) return mode === 'attributes' ? node : undefined
    if (Array.isArray(node)) {
      const items = node.map((item) => visit(item, paths, at)).filter((item) => item !== undefined)
      return items.length > 0 ? items : undefined
    }
    if (!isObject(node)) return mode === 'attributes' ? undefined : node
    const result: Json = {}
    for (const [name, child] of Object.entries(node)) {
      const path = [...at, name]
      const below = paths.filter(([head]) => head === name).map((rest) => rest.slice(1))
      const value =
        (at.length === 0 && always.has(name)) ||
        (mode === 'excludedAttributes' && below.length === 0)
          ? child
          : below.length > 0
            ? visit(child, below, path)
            : undefined
      if (value !== undefined) result[name] = value
    }
    return Object.keys(result).length > 0 ? result : undefined
  }
  return visit
}

/**
 * Applies a projection to a full representation (RFC 7643 section 2.4, RFC 7644 section 3.9).
 * attributes keeps the named attributes; excludedAttributes removes them; neither ever hides
 * an attribute returned "always" (schemas, id and userName for Users). A complex or
 * multi-valued attribute left empty is omitted, and schemas then names only the core schema
 * and the extensions whose objects remain.
 */
export function projectScimResource(
  resource: ScimQueryResource,
  representation: Json,
  projection: ScimProjection | undefined,
): Json {
  if (!projection) return representation
  const visit = walker(alwaysReturned(resource), projection.mode)
  const projected = (visit(representation, projection.paths, []) ?? {}) as Json
  const { schemas } = representation
  if (Array.isArray(schemas))
    projected.schemas = schemas.filter(
      (uri) => uri === resource.schemas[0]?.id || Object.hasOwn(projected, uri),
    )
  return projected
}
