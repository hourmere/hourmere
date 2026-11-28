import { invitationEmailAccepted } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { type ScimReply, type ScimResourceRequest, scimError } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { SCIM_USER_ID } from './scim-users.ts'

/** A refusal that rolls back everything the transaction wrote. */
class ScimWriteRefusal extends Error {
  readonly reply: ScimReply
  constructor(reply: ScimReply) {
    super('SCIM request refused')
    this.reply = reply
  }
}
export const refuse = (
  status: ScimReply['status'],
  detail: string,
  scimType?: string,
  headers?: ScimReply['headers'],
) => new ScimWriteRefusal({ status, body: scimError(status, detail, scimType), headers })
export const invalidSyntax = (detail: string) => refuse(400, detail, 'invalidSyntax')
export const invalidValue = (detail: string) => refuse(400, detail, 'invalidValue')
export const immutableScimPrivileges = () =>
  refuse(
    403,
    'Roles and entitlements are not provisioned. Change membership roles through ordinary team administration.',
    'mutability',
  )
const unauthorized = () =>
  refuse(401, 'A valid provisioning token is required.', undefined, {
    'WWW-Authenticate': 'Bearer',
  })
// Details are fixed text: none names a value, a member or another resource. A duplicate live
// identity of the connection is the only conflict; nothing about an address is one.
const identifierTaken = () =>
  refuse(409, 'A User of this connection already has this userName or externalId.', 'uniqueness')
/** The writable profile stored by POST and PUT. Lifecycle and account links are separate. */
export interface ScimUserProfile {
  user_name: string
  external_id: string | null
  formatted_name: string | null
  family_name: string | null
  given_name: string | null
  display_name: string | null
  nick_name: string | null
  title: string | null
  user_type: string | null
  locale: string | null
  timezone: string | null
  employee_number: string | null
  cost_center: string | null
  enterprise_organization: string | null
  division: string | null
  department: string | null
  work_email: string | null
  manager_id: string | null
}

// Attribute names are case-insensitive (RFC 7643 section 2.1); a name given twice in different
// cases is ambiguous and refused.
export function scimAttributes(value: unknown, what: string): Map<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidValue(`The ${what} attribute must be an object.`)
  const named = new Map<string, unknown>()
  for (const [name, item] of Object.entries(value)) {
    const key = name.toLowerCase()
    if (named.has(key)) throw invalidSyntax('An attribute is named more than once.')
    // Null and absent are the same unassigned state (RFC 7643 section 2.5), but the name
    // itself must still be known.
    named.set(key, item ?? undefined)
  }
  return named
}
/** Refuses any name not listed; the detail never echoes the name. */
function only(named: Map<string, unknown>, names: readonly string[]) {
  for (const name of named.keys())
    if (!names.includes(name))
      throw invalidValue('The request names an attribute that this server does not support.')
}

// Postgres text cannot hold U+0000, and a lone surrogate is not a character to store.
function text(value: unknown, name: string, max: number): string | null {
  if (value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.includes('\u0000') ||
    !value.isWellFormed() ||
    [...value].length > max
  )
    throw invalidValue(`The ${name} attribute is not a valid value.`)
  return value
}

export { only as onlyScimAttributes, text as scimText }

const LOCALE = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/
function locale(value: unknown): string | null {
  const stored = text(value, 'locale', 64)
  if (stored === null) return null
  try {
    // Providers send both en-US and en_US.
    if (LOCALE.test(stored) && Intl.getCanonicalLocales(stored.replaceAll('_', '-')).length === 1)
      return stored
  } catch {}
  throw invalidValue('The locale attribute is not a valid value.')
}
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/
function timezone(value: unknown): string | null {
  const stored = text(value, 'timezone', 128)
  if (stored === null) return null
  try {
    // An IANA name; offsets such as +01:00 are not time zone names.
    if (ZONE.test(stored)) {
      new Intl.DateTimeFormat('en', { timeZone: stored })
      return stored
    }
  } catch {}
  throw invalidValue('The timezone attribute is not a valid value.')
}

// RFC 7643 User attributes Hourmere does not map: never stored, so never returned. password is
// one of them: nothing is provisioned, recorded or echoed. groups is read-only.
const ignoredCore = [
  'id',
  'meta',
  'password',
  'groups',
  'profileurl',
  'preferredlanguage',
  'phonenumbers',
  'ims',
  'photos',
  'addresses',
  'x509certificates',
]
const enterprise = SCIM_URN.enterpriseUser.toLowerCase()

/**
 * The one work address, chosen in this order: the primary `work` email, the first `work`
 * email, a primary email without `type`, or the only email when it has no `type` (RFC 7643
 * makes `type` optional). A list none of these selects is refused, never dropped silently.
 */
function workEmail(value: unknown, existing?: string | null): string | null {
  if (value === undefined) return existing ?? null
  if (!Array.isArray(value) || value.length > 10)
    throw invalidValue('The emails attribute is not a valid value.')
  const emails = value.map((item) => {
    const entry = scimAttributes(item, 'emails')
    only(entry, ['value', 'type', 'primary', 'display'])
    if (existing !== undefined && !invitationEmailAccepted(entry.get('value')))
      throw invalidValue('The email address is not a valid value.')
    const type = text(entry.get('type'), 'emails', 256)
    const primary = entry.get('primary')
    if (primary !== undefined && typeof primary !== 'boolean')
      throw invalidValue('The emails attribute is not a valid value.')
    // An empty type is no type.
    return { entry, type: type?.trim().toLowerCase() || null, primary: primary === true }
  })
  if (emails.length === 0) return existing ?? null
  // RFC 7643 section 2.4: "primary" is true for at most one value.
  if (emails.filter((email) => email.primary).length > 1)
    throw invalidValue('The emails attribute marks more than one address as primary.')
  const work = emails.filter((email) => email.type === 'work')
  const untyped = emails.filter((email) => email.type === null)
  const primaryWork = work.find((email) => email.primary)
  // PATCH add appends to the one stored primary work address. A new explicit
  // primary work address can take its place under the same selection rules.
  if (existing != null && !primaryWork) return existing
  const chosen =
    primaryWork ??
    work[0] ??
    untyped.find((email) => email.primary) ??
    (emails.length === 1 ? untyped[0] : undefined)
  if (!chosen)
    throw invalidValue(
      'The emails attribute holds no work address. Send a "work" email, or a primary or single email without a type.',
    )
  const address = chosen.entry.get('value')
  if (!invitationEmailAccepted(address))
    throw invalidValue('The work email address is not a valid value.')
  return address.trim()
}

/** Privileges are never provisioned: an empty list is ignored, anything else refused. */
function noPrivileges(value: unknown) {
  if (value === undefined) return
  if (!Array.isArray(value)) throw invalidValue('The roles attribute is not a valid value.')
  if (value.length > 0) throw immutableScimPrivileges()
}

/** RFC 7643 sections 4.1 and 4.3, as docs/scim.md maps them; server-owned fields ignored. */
export function parseScimUserWrite(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalidSyntax('The request body must be a User object.')
  const user = scimAttributes(body, 'User')
  const schemas = user.get('schemas')
  if (
    !Array.isArray(schemas) ||
    !schemas.every((schema) => typeof schema === 'string') ||
    !schemas.some((schema) => schema.toLowerCase() === SCIM_URN.user.toLowerCase()) ||
    !schemas.every((schema) =>
      [SCIM_URN.user.toLowerCase(), enterprise].includes(schema.toLowerCase()),
    )
  )
    throw invalidSyntax(
      'The schemas attribute must name the User schema and only supported extensions.',
    )
  only(user, [
    'schemas',
    'externalid',
    'username',
    'name',
    'displayname',
    'nickname',
    'title',
    'usertype',
    'locale',
    'timezone',
    'active',
    'emails',
    'roles',
    'entitlements',
    enterprise,
    ...ignoredCore,
  ])
  const active = user.get('active')
  if (active !== undefined && typeof active !== 'boolean')
    throw invalidValue('The active attribute is not a valid value.')
  return {
    profile: parseScimUserProfile(user),
    active,
    roleWrite: user.has('roles') || user.has('entitlements'),
  }
}

type AttributeGroup = Map<string, unknown> | null | undefined

// Absent groups preserve their values on PATCH. Explicitly unassigned groups clear them.
function group(parent: AttributeGroup, name: string, label = name): AttributeGroup {
  if (parent === null) return null
  if (!parent?.has(name)) return undefined
  const value = parent.get(name)
  return value === undefined ? null : scimAttributes(value, label)
}

/** Validates and maps one replacement or one ordered PATCH overlay onto a locked profile. */
export function parseScimUserProfile(
  user: Map<string, unknown>,
  current?: ScimUserProfile,
  appendEmails = false,
): ScimUserProfile {
  const pick = <T>(
    named: AttributeGroup,
    name: string,
    previous: T | undefined,
    parse: (value: unknown) => T,
  ): T => {
    if (previous !== undefined && named !== null && !named?.has(name)) return previous
    return parse(named?.get(name))
  }
  const field = (named: AttributeGroup, label: string, previous?: string | null, max = 256) =>
    pick(named, label.slice(label.lastIndexOf('.') + 1).toLowerCase(), previous, (value) =>
      text(value, label, max),
    )
  const userName = field(user, 'userName', current?.user_name)
  if (userName === null || userName.trim() === '')
    throw invalidValue('The userName attribute is required.')
  const externalId = field(user, 'externalId', current?.external_id, 1024)
  if (externalId === '') throw invalidValue('The externalId attribute is not a valid value.')
  noPrivileges(user.get('roles'))
  noPrivileges(user.get('entitlements'))
  const name = group(user, 'name')
  if (name)
    only(name, [
      'formatted',
      'familyname',
      'givenname',
      'middlename',
      'honorificprefix',
      'honorificsuffix',
    ])
  const extension = group(user, enterprise, 'enterprise')
  if (extension)
    only(extension, [
      'employeenumber',
      'costcenter',
      'organization',
      'division',
      'department',
      'manager',
    ])
  const manager = group(extension, 'manager')
  if (manager) only(manager, ['value', 'displayname', '$ref'])
  const managerId = pick(manager, 'value', current?.manager_id, (value) => {
    if (value === undefined) return null
    if (typeof value !== 'string' || !SCIM_USER_ID.test(value))
      throw invalidValue('The manager attribute does not name a User of this connection.')
    return value
  })
  return {
    user_name: userName,
    external_id: externalId,
    formatted_name: field(name, 'name.formatted', current?.formatted_name),
    family_name: field(name, 'name.familyName', current?.family_name),
    given_name: field(name, 'name.givenName', current?.given_name),
    display_name: field(user, 'displayName', current?.display_name),
    nick_name: field(user, 'nickName', current?.nick_name),
    title: field(user, 'title', current?.title),
    user_type: field(user, 'userType', current?.user_type),
    locale: pick(user, 'locale', current?.locale, locale),
    timezone: pick(user, 'timezone', current?.timezone, timezone),
    employee_number: field(extension, 'employeeNumber', current?.employee_number),
    cost_center: field(extension, 'costCenter', current?.cost_center),
    enterprise_organization: field(extension, 'organization', current?.enterprise_organization),
    division: field(extension, 'division', current?.division),
    department: field(extension, 'department', current?.department),
    work_email: pick(user, 'emails', current?.work_email, (value) =>
      workEmail(value, appendEmails ? (current?.work_email ?? null) : undefined),
    ),
    manager_id: managerId,
  }
}

const LIVE_IDENTIFIERS = ['scim_users_live_username', 'scim_users_live_external_id']

/** Turn expected write refusals and scoped uniqueness violations into redacted SCIM replies. */
export function scimUserWriteError(error: unknown): ScimReply | undefined {
  const reply = scimWriteRefusal(error)
  if (reply) return reply
  const database = error as { code?: unknown; constraint?: unknown }
  if (database?.code === '23505' && LIVE_IDENTIFIERS.includes(String(database.constraint)))
    return identifierTaken().reply
}

export const scimWriteRefusal = (error: unknown) =>
  error instanceof ScimWriteRefusal ? error.reply : undefined

export async function lockScimWriteConnection(
  trx: Db,
  principal: ScimResourceRequest['principal'],
): Promise<string> {
  // The organization update lock that team management and invitations take first.
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', principal.organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (!organization) throw unauthorized()
  return lockScimTokenConnection(trx, principal)
}

/** The calling write already holds the update locks for all of its organizations. */
export async function lockScimTokenConnection(
  trx: Db,
  principal: ScimResourceRequest['principal'],
): Promise<string> {
  // A token revoked since authentication is refused here, and a revocation that starts
  // later waits for this write (its organization lock already makes it wait). A
  // rotation keeps the token row, so a request authenticated before it still completes.
  // The key share lock lets the last-use update of concurrent requests through.
  const token = await trx
    .selectFrom('scim_provisioning_tokens')
    .select('id')
    .where('id', '=', principal.tokenId)
    .where('organization_id', '=', principal.organizationId)
    .where('revoked_at', 'is', null)
    .forKeyShare()
    .executeTakeFirst()
  const binding = await trx
    .selectFrom('scim_token_connections')
    .select('connection_id')
    .where('token_id', '=', principal.tokenId)
    .where('organization_id', '=', principal.organizationId)
    .where(sql<boolean>`coalesce((SELECT protocol_version FROM scim_token_protocol_versions
      WHERE token_id = scim_token_connections.token_id), 1) = 1`)
    .executeTakeFirst()
  if (!token || !binding) throw unauthorized()
  return binding.connection_id
}

export async function validateScimManager(
  trx: Db,
  organizationId: string,
  connectionId: string,
  ...managerIds: (string | null)[]
) {
  const ids = [...new Set(managerIds.filter((id) => id !== null))]
  if (ids.length === 0) return
  const managers = await trx
    .selectFrom('scim_users')
    .select('id')
    .where('id', 'in', ids)
    .where('organization_id', '=', organizationId)
    .where('connection_id', '=', connectionId)
    .where('retired_at', 'is', null)
    .execute()
  if (managers.length !== ids.length)
    throw invalidValue('The manager attribute does not name a User of this connection.')
}
