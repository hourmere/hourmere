// SCIM User creation (RFC 7644 section 3.3): POST /Users. docs/scim.md fixes what it does: it
// records a managed provisioning entry in the connection the token is bound to and, for its
// work address, a pending claim whose invitation comes from the existing invitation service.
// An address that already has its own standing in the organization (a member's, or one
// another pending invitation holds) gets the same entry and a claim without an invitation.
// It never creates an account, a membership or a session, never marks an address verified,
// and admits nobody: the recipient proves the mailbox through the claim later. Production
// registers no handler yet; see ScimResources in scim.ts.
import {
  admitInvitation,
  type EnqueueInvitationEmail,
  invitationEmailAccepted,
  invitationLifetimeMs,
  invitationRefusalCode,
  type ReserveInvitationEmail,
  type SignupPolicy,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { type AuditEvent, writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import {
  type ScimReply,
  type ScimResourceHandler,
  type ScimResourceRequest,
  scimError,
} from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { parseScimProjection, projectScimResource, scimUserQuery } from './scim-query.ts'
import { readScimUser } from './scim-users.ts'

type Json = Record<string, unknown>

export interface ScimUserCreationDeps {
  db: Db
  /** The instance sign-up policy (SIGNUP and SIGNUP_ALLOWED_DOMAINS). */
  signup: SignupPolicy
  /** The invitation mail budget, as the invitation entrance of Better Auth reserves it. */
  reserve?: ReserveInvitationEmail | undefined
  /** Queues a committed delivery generation, as the invitation entrance does after commit. */
  enqueue?: EnqueueInvitationEmail | undefined
}

/** A refusal that rolls back everything the transaction wrote. */
class Refusal extends Error {
  readonly reply: ScimReply
  constructor(reply: ScimReply) {
    super('SCIM request refused')
    this.reply = reply
  }
}
const refuse = (status: 400 | 401 | 403 | 409 | 429, detail: string, scimType?: string) =>
  new Refusal({ status, body: scimError(status, detail, scimType) })
const invalidSyntax = (detail: string) => refuse(400, detail, 'invalidSyntax')
const invalidValue = (detail: string) => refuse(400, detail, 'invalidValue')
const unauthorized = () =>
  new Refusal({
    status: 401,
    body: scimError(401, 'A valid provisioning token is required.'),
    headers: { 'WWW-Authenticate': 'Bearer' },
  })
// Details are fixed text: none names a value, a member or another resource. A duplicate live
// identity of the connection is the only conflict; nothing about an address is one.
const identifierTaken = () =>
  refuse(409, 'A User of this connection already has this userName or externalId.', 'uniqueness')
// An organization precondition, not a duplicate: identity providers read a create's 409 as
// "already exists".
const noInviter = () =>
  refuse(403, 'No owner of this organization with a verified email address can invite.')
// The per-recipient limit counts every organization's invitations, so the detail names none.
const invitationsLimited = () =>
  new Refusal({
    status: 429,
    body: scimError(429, 'Invitation sending is limited right now. Retry later.'),
    headers: { 'Retry-After': '3600' },
  })

/**
 * Invitation refusals that mean the address already has its own standing in this
 * organization: it belongs to a member, or another administrator's, a legacy (a role other
 * than member) or a duplicated pending invitation holds it, or that invitation's inviter has
 * left. admitInvitation refuses each before it writes anything. The claim then records the
 * address without an invitation and nothing is sent.
 */
const HELD_ELSEWHERE = [
  'INVITATION_RECIPIENT_ALREADY_MEMBER',
  'INVITATION_ALREADY_PENDING',
  'TEAM_MANAGEMENT_ACCESS_DENIED',
  'INVITATION_CONFLICT',
  'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
]

/** The stored columns one POST writes; everything else is server-owned. */
interface Draft {
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
function draft(body: unknown): Draft {
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
  // Activity is the lifecycle step's write; a new entry is active and awaits its claim.
  const active = user.get('active')
  if (active !== undefined && active !== true)
    throw invalidValue(
      active === false
        ? 'Creating an inactive User is not supported yet.'
        : 'The active attribute is not a valid value.',
    )
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
      if (typeof value !== 'string' || !UUID.test(value))
        throw invalidValue('The manager attribute does not name a User of this connection.')
      managerId = value
    }
  }
  return {
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
}

/**
 * SCIM is never a sign-up authority: on a restricted instance it provisions only addresses
 * the sign-up policy already admits by domain. The decision reads no account or invitation,
 * so its answer is the same whether or not a personal account exists.
 */
function signupAdmits(policy: SignupPolicy, email: string) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return policy.mode === 'open' || policy.allowedDomains.includes(domain)
}

const LIVE_IDENTIFIERS = ['scim_users_live_username', 'scim_users_live_external_id']

async function create(
  deps: ScimUserCreationDeps,
  request: ScimResourceRequest,
): Promise<ScimReply> {
  const projection = parseScimProjection(request.query, scimUserQuery)
  if (!projection.ok) return projection.reply
  const body = await request.body?.()
  if (!body) return invalidSyntax('The request body must be a User object.').reply
  if (!body.ok) return body.reply
  const { principal } = request
  // Attributed to the token that made the request: the actor is the credential.
  const audit: Pick<AuditEvent, 'actor' | 'credential'> = {
    actor: { type: 'scim_token', id: principal.tokenId },
    credential: { type: 'none' },
  }
  let created: {
    id: string
    representation: Json
    queued?: { invitationId: string; generation: number }
  }
  try {
    const entry = draft(body.value)
    if (entry.work_email !== null && !signupAdmits(deps.signup, entry.work_email))
      throw refuse(403, "This instance's sign-up policy does not admit this work email address.")
    created = await deps.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // The organization update lock that team management and invitations take first.
        const organization = await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', principal.organizationId)
          .forUpdate()
          .executeTakeFirst()
        // A token revoked since authentication is refused here, and a revocation that starts
        // later waits for this create (its organization lock already makes it wait). A
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
        const connection = binding.connection_id
        if (
          entry.manager_id !== null &&
          !(await trx
            .selectFrom('scim_users')
            .select('id')
            .where('id', '=', entry.manager_id)
            .where('organization_id', '=', principal.organizationId)
            .where('connection_id', '=', connection)
            .where('retired_at', 'is', null)
            .executeTakeFirst())
        )
          throw invalidValue('The manager attribute does not name a User of this connection.')
        // Live uniqueness is the database's: a duplicate fails here, before any invitation.
        const { id } = await trx
          .insertInto('scim_users')
          .values({
            ...entry,
            organization_id: principal.organizationId,
            connection_id: connection,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await writeAuditEvent(trx, {
          organizationId: principal.organizationId,
          ...audit,
          action: 'scim_user.created',
          targetType: 'scim_user',
          targetId: id,
        })
        let queued: { invitationId: string; generation: number } | undefined
        if (entry.work_email !== null) {
          const mailbox = entry.work_email.toLowerCase()
          // The earliest current owner with a verified address invites: the organization's
          // authority, whichever token or person set provisioning up, and one the invitation
          // sender accepts. The update lock keeps that owner in place. It is required for
          // every work address, so this refusal never depends on the address.
          const inviter = await trx
            .selectFrom('auth.member')
            .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
            .select('auth.member.userId')
            .where('auth.member.organizationId', '=', principal.organizationId)
            .where(
              sql<boolean>`'owner' = ANY (SELECT btrim(token) FROM unnest(string_to_array(auth.member.role, ',')) AS token)`,
            )
            .where('auth.user.emailVerified', '=', true)
            .orderBy('auth.member.createdAt')
            .orderBy('auth.member.id')
            .executeTakeFirst()
          if (!inviter) throw noInviter()
          // Whatever admission does is kept only when the claim links its invitation.
          await sql`SAVEPOINT scim_user_invitation`.execute(trx)
          const admit = async () => {
            try {
              // No `current` check: the token was rechecked under the organization lock, so
              // TEAM_MANAGEMENT_ACCESS_DENIED can only be the refusal of a legacy role.
              return await admitInvitation(
                trx,
                { userId: inviter.userId, audit },
                {
                  organizationId: principal.organizationId,
                  email: mailbox,
                  resend: false,
                },
                { reserve: deps.reserve },
              )
            } catch (error) {
              const code = invitationRefusalCode(error)
              if (code === undefined || !HELD_ELSEWHERE.includes(code)) throw error
              return undefined
            }
          }
          let admitted: Awaited<ReturnType<typeof admitInvitation>> | undefined
          try {
            admitted = await admit()
          } catch (error) {
            // A pending invitation for the address expired while admission waited for its
            // delivery row, the mail budget or another administrator's invitation. Admission
            // runs once more from the savepoint: it then skips the expired invitation and
            // issues a new one, as the provider's retry would. It is never a claim without
            // an invitation, which would leave the person without an email.
            if (invitationRefusalCode(error) !== 'INVITATION_INELIGIBLE') throw error
            await sql`ROLLBACK TO SAVEPOINT scim_user_invitation`.execute(trx)
            admitted = await admit()
          }
          // A pending invitation another entry's claim already holds is not shared.
          if (
            admitted?.existing &&
            (await trx
              .selectFrom('scim_user_claims')
              .select('id')
              .where('invitation_id', '=', admitted.invitation.id)
              .executeTakeFirst())
          )
            admitted = undefined
          if (!admitted) await sql`ROLLBACK TO SAVEPOINT scim_user_invitation`.execute(trx)
          await sql`RELEASE SAVEPOINT scim_user_invitation`.execute(trx)
          // The same pending claim either way. Without an invitation nothing is sent and
          // the claim lasts as long as an invitation would; the SSO linking completion step
          // proves and links the person's own account.
          await trx
            .insertInto('scim_user_claims')
            .values({
              organization_id: principal.organizationId,
              connection_id: connection,
              scim_user_id: id,
              invitation_id: admitted?.invitation.id ?? null,
              work_email: mailbox,
              expires_at:
                admitted?.invitation.expiresAt ??
                sql<Date>`clock_timestamp() + make_interval(secs => ${invitationLifetimeMs / 1000}::double precision)`,
            })
            .execute()
          if (admitted?.delivery.state === 'queued')
            queued = {
              invitationId: admitted.invitation.id,
              generation: admitted.delivery.generation,
            }
        }
        const representation = await readScimUser(trx, request, id)
        if (!representation) throw new Error('The created User is not readable.')
        return { id, representation, ...(queued ? { queued } : {}) }
      })
  } catch (error) {
    if (error instanceof Refusal) return error.reply
    const database = error as { code?: unknown; constraint?: unknown }
    if (database?.code === '23505' && LIVE_IDENTIFIERS.includes(String(database.constraint)))
      return identifierTaken().reply
    const code = invitationRefusalCode(error)
    if (code === 'INVITATION_RATE_LIMITED' || code === 'INVITATION_PENDING_LIMIT')
      return invitationsLimited().reply
    // Anything else rolls everything back as a server error the provider retries.
    throw error
  }
  // The entry and its delivery intent are committed. A queue outage leaves that generation
  // to the invitation repairer, so the create still succeeds.
  if (created.queued && deps.enqueue) {
    try {
      await deps.enqueue(created.queued)
    } catch {}
  }
  return {
    status: 201,
    body: projectScimResource(scimUserQuery, created.representation, projection.value),
    headers: { Location: (created.representation.meta as { location: string }).location },
  }
}

/** POST /Users for the token's connection; every other request is left to the next handler. */
export function scimUserCreation(deps: ScimUserCreationDeps): ScimResourceHandler {
  return (request) =>
    request.method === 'POST' && request.path === '/Users' ? create(deps, request) : undefined
}
