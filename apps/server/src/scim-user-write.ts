import { invitationEmailAccepted } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
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
const invalidValue = (detail: string) => refuse(400, detail, 'invalidValue')
const unauthorized = () =>
  refuse(401, 'A valid provisioning token is required.', undefined, {
    'WWW-Authenticate': 'Bearer',
  })
// Details are fixed text: none names a value, a member or another resource. A duplicate live
// identity of the connection is the only conflict; nothing about an address is one.
const identifierTaken = () =>
  refuse(409, 'A User of this connection already has this userName or externalId.', 'uniqueness')
/** The writable profile stored by POST and PUT. Lifecycle and account links are separate. */
interface Profile {
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
function attributes(value: unknown, what: string): Map<string, unknown> {
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
function workEmail(value: unknown): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > 10)
    throw invalidValue('The emails attribute is not a valid value.')
  const emails = value.map((item) => {
    const entry = attributes(item, 'emails')
    only(entry, ['value', 'type', 'primary', 'display'])
    const type = text(entry.get('type'), 'emails', 256)
    const primary = entry.get('primary')
    if (primary !== undefined && typeof primary !== 'boolean')
      throw invalidValue('The emails attribute is not a valid value.')
    // An empty type is no type.
    return { entry, type: type?.trim().toLowerCase() || null, primary: primary === true }
  })
  if (emails.length === 0) return null
  // RFC 7643 section 2.4: "primary" is true for at most one value.
  if (emails.filter((email) => email.primary).length > 1)
    throw invalidValue('The emails attribute marks more than one address as primary.')
  const work = emails.filter((email) => email.type === 'work')
  const untyped = emails.filter((email) => email.type === null)
  const chosen =
    work.find((email) => email.primary) ??
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
  if (value.length > 0)
    throw refuse(
      403,
      'Roles and entitlements are not provisioned. Change membership roles through ordinary team administration.',
      'mutability',
    )
}

/** RFC 7643 sections 4.1 and 4.3, as docs/scim.md maps them; server-owned fields ignored. */
export function parseScimUserWrite(
  body: unknown,
  method: 'POST' | 'PUT',
): { profile: Profile; active: boolean | undefined } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalidSyntax('The request body must be a User object.')
  const user = attributes(body, 'User')
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
  const userName = text(user.get('username'), 'userName', 256)
  if (userName === null || userName.trim() === '')
    throw invalidValue('The userName attribute is required.')
  const externalId = text(user.get('externalid'), 'externalId', 1024)
  if (externalId === '') throw invalidValue('The externalId attribute is not a valid value.')
  const active = user.get('active')
  if (active !== undefined && typeof active !== 'boolean')
    throw invalidValue('The active attribute is not a valid value.')
  // A new entry is active and awaits its claim. PUT checks the current state under lock.
  if (method === 'POST' && active === false)
    throw invalidValue('Creating an inactive User is not supported yet.')
  noPrivileges(user.get('roles'))
  noPrivileges(user.get('entitlements'))
  const name = user.get('name') !== undefined ? attributes(user.get('name'), 'name') : new Map()
  only(name, [
    'formatted',
    'familyname',
    'givenname',
    'middlename',
    'honorificprefix',
    'honorificsuffix',
  ])
  const extension =
    user.get(enterprise) !== undefined ? attributes(user.get(enterprise), 'enterprise') : new Map()
  only(extension, [
    'employeenumber',
    'costcenter',
    'organization',
    'division',
    'department',
    'manager',
  ])
  let managerId: string | null = null
  if (extension.get('manager') !== undefined) {
    const manager = attributes(extension.get('manager'), 'manager')
    only(manager, ['value', 'displayname', '$ref'])
    const value = manager.get('value')
    if (value !== undefined) {
      if (typeof value !== 'string' || !SCIM_USER_ID.test(value))
        throw invalidValue('The manager attribute does not name a User of this connection.')
      managerId = value
    }
  }
  const profile: Profile = {
    user_name: userName,
    external_id: externalId,
    formatted_name: text(name.get('formatted'), 'name.formatted', 256),
    family_name: text(name.get('familyname'), 'name.familyName', 256),
    given_name: text(name.get('givenname'), 'name.givenName', 256),
    display_name: text(user.get('displayname'), 'displayName', 256),
    nick_name: text(user.get('nickname'), 'nickName', 256),
    title: text(user.get('title'), 'title', 256),
    user_type: text(user.get('usertype'), 'userType', 256),
    locale: locale(user.get('locale')),
    timezone: timezone(user.get('timezone')),
    employee_number: text(extension.get('employeenumber'), 'employeeNumber', 256),
    cost_center: text(extension.get('costcenter'), 'costCenter', 256),
    enterprise_organization: text(extension.get('organization'), 'organization', 256),
    division: text(extension.get('division'), 'division', 256),
    department: text(extension.get('department'), 'department', 256),
    work_email: workEmail(user.get('emails')),
    manager_id: managerId,
  }
  return { profile, active }
}

const LIVE_IDENTIFIERS = ['scim_users_live_username', 'scim_users_live_external_id']

/** Turn expected write refusals and scoped uniqueness violations into redacted SCIM replies. */
export function scimUserWriteError(error: unknown): ScimReply | undefined {
  if (error instanceof ScimWriteRefusal) return error.reply
  const database = error as { code?: unknown; constraint?: unknown }
  if (database?.code === '23505' && LIVE_IDENTIFIERS.includes(String(database.constraint)))
    return identifierTaken().reply
}

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
    .executeTakeFirst()
  if (!organization || !token || !binding) throw unauthorized()
  return binding.connection_id
}

export async function validateScimManager(
  trx: Db,
  organizationId: string,
  connectionId: string,
  managerId: string | null,
) {
  if (managerId === null) return
  const manager = await trx
    .selectFrom('scim_users')
    .select('id')
    .where('id', '=', managerId)
    .where('organization_id', '=', organizationId)
    .where('connection_id', '=', connectionId)
    .where('retired_at', 'is', null)
    .executeTakeFirst()
  if (!manager) throw invalidValue('The manager attribute does not name a User of this connection.')
}
