// SCIM User reads (RFC 7644 sections 3.4.1 and 3.4.2): GET /Users and GET /Users/{id}.
// docs/scim.md fixes what a provisioning token may read: the live entries of the connection
// it is bound to, in its own organization, inactive entries included. Nothing here reads an
// account, a membership or another organization, so neither a filter nor an ID can reveal
// whether a personal account or another organization's entry exists. Representations follow
// the advertised User schemas. Production registers no handler yet; see ScimResources in
// scim.ts.
import type { Database, Db, ScimUsers } from '@hourmere/db'
import { type Expression, type ExpressionBuilder, type Selectable, type SqlBool, sql } from 'kysely'
import {
  type ScimReply,
  type ScimResourceHandler,
  type ScimResourceRequest,
  scimError,
} from './scim.ts'
import { SCIM_URN, scimUserSchemas } from './scim-discovery.ts'
import {
  parseScimListQuery,
  parseScimProjection,
  projectScimResource,
  type ScimFilter,
  scimListResponse,
  scimPageWindow,
  scimUserQuery,
} from './scim-query.ts'

type Users = ExpressionBuilder<Database, 'scim_users'>
type Json = Record<string, unknown>

const columns = [
  'id',
  'external_id',
  'user_name',
  'active',
  'formatted_name',
  'family_name',
  'given_name',
  'display_name',
  'nick_name',
  'title',
  'user_type',
  'locale',
  'timezone',
  'work_email',
  'employee_number',
  'cost_center',
  'enterprise_organization',
  'division',
  'department',
  'created_at',
  'updated_at',
] as const
type Row = Pick<Selectable<ScimUsers>, (typeof columns)[number]> & {
  manager_id: string | null
  manager_display_name: string | null
}

// Where each advertised attribute is stored, by schema. The representation walks the
// advertised schemas, and this module refuses to load unless every advertised leaf has
// exactly one source here.
const sources: Record<string, Record<string, (row: Row) => unknown>> = {
  [SCIM_URN.user]: {
    userName: (row) => row.user_name,
    'name.formatted': (row) => row.formatted_name,
    'name.familyName': (row) => row.family_name,
    'name.givenName': (row) => row.given_name,
    displayName: (row) => row.display_name,
    nickName: (row) => row.nick_name,
    title: (row) => row.title,
    userType: (row) => row.user_type,
    locale: (row) => row.locale,
    timezone: (row) => row.timezone,
    active: (row) => row.active,
    // The one work address used for invitation and claim.
    'emails.value': (row) => row.work_email,
    'emails.type': () => 'work',
    'emails.primary': () => true,
  },
  [SCIM_URN.enterpriseUser]: {
    employeeNumber: (row) => row.employee_number,
    costCenter: (row) => row.cost_center,
    organization: (row) => row.enterprise_organization,
    division: (row) => row.division,
    department: (row) => row.department,
    // Both from the manager's live entry: a retired manager no longer exists to refer to.
    'manager.value': (row) => row.manager_id,
    'manager.displayName': (row) => row.manager_display_name,
  },
}

type Attribute = (typeof scimUserSchemas)[number]['attributes'][number]
const leaves = (attributes: readonly Attribute[], prefix = ''): string[] =>
  attributes.flatMap((attribute) =>
    attribute.subAttributes
      ? leaves(attribute.subAttributes, `${prefix}${attribute.name}.`)
      : [`${prefix}${attribute.name}`],
  )
const [coreSchema, ...extensionSchemas] = scimUserSchemas
if (
  !coreSchema ||
  Object.keys(sources).sort().join() !==
    scimUserSchemas
      .map((schema) => schema.id)
      .sort()
      .join() ||
  scimUserSchemas.some(
    (schema) =>
      leaves(schema.attributes).sort().join() !==
      Object.keys(sources[schema.id] ?? {})
        .sort()
        .join(),
  )
)
  throw new Error('Every advertised User attribute needs exactly one stored source.')

function build(attributes: readonly Attribute[], schema: string, row: Row, prefix = ''): Json {
  const object: Json = {}
  for (const attribute of attributes) {
    const path = `${prefix}${attribute.name}`
    let value: unknown
    if (attribute.subAttributes) {
      const complex = build(attribute.subAttributes, schema, row, `${path}.`)
      // A complex value with a value sub-attribute exists only with that value (an address
      // without its address, a manager without its reference); any other only when nonempty.
      const present = attribute.subAttributes.some((sub) => sub.name === 'value')
        ? complex.value !== undefined
        : Object.keys(complex).length > 0
      if (present) value = attribute.multiValued ? [complex] : complex
    } else value = sources[schema]?.[path]?.(row) ?? undefined
    if (value !== undefined) object[attribute.name] = value
  }
  return object
}

/** The full representation; meta.location is under the PUBLIC_URL base. */
function representation(row: Row, base: string): Json {
  const core = coreSchema as (typeof scimUserSchemas)[number]
  const extensions = extensionSchemas
    .map((schema) => [schema.id, build(schema.attributes, schema.id, row)] as const)
    .filter(([, object]) => Object.keys(object).length > 0)
  return {
    schemas: [core.id, ...extensions.map(([id]) => id)],
    id: row.id,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    ...build(core.attributes, core.id, row),
    ...Object.fromEntries(extensions),
    meta: {
      resourceType: 'User',
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: `${base}/Users/${row.id}`,
    },
  }
}

// The manager, only while it is a live entry of the same connection.
const liveManager = (eb: Users) =>
  eb
    .selectFrom('scim_users as manager')
    .whereRef('manager.organization_id', '=', 'scim_users.organization_id')
    .whereRef('manager.connection_id', '=', 'scim_users.connection_id')
    .whereRef('manager.id', '=', 'scim_users.manager_id')
    .where('manager.retired_at', 'is', null)
const manager = (eb: Users) => [
  liveManager(eb).select('manager.id').as('manager_id'),
  liveManager(eb).select('manager.display_name').as('manager_display_name'),
]

/** The connection the token is bound to, in the token's own organization. */
const scope =
  ({ tokenId, organizationId }: ScimResourceRequest['principal']) =>
  (eb: Users) =>
    eb.and([
      eb('scim_users.organization_id', '=', organizationId),
      eb(
        'scim_users.connection_id',
        '=',
        eb
          .selectFrom('scim_token_connections')
          .select('scim_token_connections.connection_id')
          .where('scim_token_connections.token_id', '=', tokenId)
          .where('scim_token_connections.organization_id', '=', organizationId),
      ),
    ])

// Filters compare the way live uniqueness does: userName trimmed and lower-cased, as the
// stored normalized_user_name is; externalId exactly.
const comparisons: Record<string, (value: string, eb: Users) => Expression<SqlBool>> = {
  userName: (value, eb) =>
    eb('scim_users.normalized_user_name', '=', sql<string>`lower(btrim(${value}))`),
  externalId: (value, eb) => eb('scim_users.external_id', '=', value),
}
if (scimUserQuery.filters.some((attribute) => !Object.hasOwn(comparisons, attribute)))
  throw new Error('Every User filter attribute needs a comparison.')
const matching = (filter: ScimFilter) => (eb: Users) => {
  const compare = comparisons[filter.attribute]
  if (!compare) throw new Error('Unsupported User filter attribute.')
  return compare(filter.value, eb)
}

const notFound: ScimReply = { status: 404, body: scimError(404, 'Resource not found.') }
// Resource IDs are case-exact; anything but a canonical lower-case UUID names no entry.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function listUsers(db: Db, request: ScimResourceRequest): Promise<ScimReply> {
  const parsed = parseScimListQuery(request.query, scimUserQuery)
  if (!parsed.ok) return parsed.reply
  const { filter, projection, ...page } = parsed.value
  const window = scimPageWindow(page)
  // One snapshot, so totalResults counts the entries the page is read from.
  const { total, rows } = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const listed = trx
        .selectFrom('scim_users')
        .where(scope(request.principal))
        .where('scim_users.retired_at', 'is', null)
      const selected = filter ? listed.where(matching(filter)) : listed
      const counted = await selected
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow()
      const rows = await selected
        .select(columns)
        .select(manager)
        .orderBy('scim_users.id')
        .offset(window.offset)
        .limit(window.limit)
        .execute()
      return { total: Number(counted.total), rows }
    })
  const resources = rows.map((row) =>
    projectScimResource(scimUserQuery, representation(row, request.base), projection),
  )
  return { status: 200, body: scimListResponse(page, total, resources) }
}

// The live entry `id` of the token's connection. Creation answers from it too, inside its
// own transaction.
function scopedUser(db: Db, request: ScimResourceRequest, id: string) {
  return db
    .selectFrom('scim_users')
    .select(columns)
    .select(manager)
    .where('scim_users.id', '=', id)
    .where(scope(request.principal))
    .where('scim_users.retired_at', 'is', null)
    .executeTakeFirst()
}

/** The full representation of the live entry `id` of the token's connection, if any. */
export async function readScimUser(db: Db, request: ScimResourceRequest, id: string) {
  const row = await scopedUser(db, request, id)
  return row && representation(row, request.base)
}

async function readUser(db: Db, request: ScimResourceRequest, id: string): Promise<ScimReply> {
  const parsed = parseScimProjection(request.query, scimUserQuery)
  if (!parsed.ok) return parsed.reply
  if (!UUID.test(id)) return notFound
  const row = await scopedUser(db, request, id)
  if (!row) return notFound
  return {
    status: 200,
    body: projectScimResource(scimUserQuery, representation(row, request.base), parsed.value),
  }
}

/**
 * GET /Users and GET /Users/{id} for the token's connection; every other request is left to
 * the next handler. Writes belong to later steps and stay unavailable.
 */
export function scimUsers(db: Db): ScimResourceHandler {
  return (request) => {
    const match = /^\/Users(?:\/([^/]*))?$/.exec(request.path)
    if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) return undefined
    const [, id] = match
    return id === undefined ? listUsers(db, request) : readUser(db, request, id)
  }
}
