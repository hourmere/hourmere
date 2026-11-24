import type { Db } from '@hourmere/db'
import { scimProvisioned, scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import { type ApiKeyScope, parsePersistedApiKeyMetadata } from './api-key-metadata.ts'
import type { Auth } from './index.ts'
import { ensurePersonalOrganization, isUuid } from './organizations.ts'
import { type SsoDelegationStatus, ssoDelegationStatus } from './sso-delegation-access.ts'
import { type SsoRecoveryTeam, ssoRecoveryTeamsFor } from './sso-recovery-membership.ts'
import { ssoHardOff, ssoRetained, type TeamSsoCapabilities } from './team-sso.ts'

/** Every API key starts with this, so leaked keys are recognizable (e.g. by secret scanners). */
export const API_KEY_PREFIX = 'hm_'

export interface CallerUser {
  id: string
  name: string
  email: string
}

export interface CallerOrganization {
  id: string
  name: string
  slug: string
  /** Whether this is a user's personal organization rather than a team. */
  personal: boolean
}

/**
 * Who is making a request and in which organization they act. `kind` and `apiKeyId` are
 * what bookings record as their source and `api_key_id`.
 */
export type Principal = {
  user: CallerUser
  organization: CallerOrganization
  /** The caller's own marker, independent of the organization they currently act in. */
  personalOrganizationId?: string | null
  /** Whether the active team already has a SCIM connection. */
  scimProvisioned?: boolean
  /**
   * Set only by a resolver that holds the in-process SCIM resource capability, so later
   * membership checks for this caller read the same managed child suspension.
   */
  scimResourcesEnabled?: true
} & (
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'api_key'
      apiKeyId: string
      apiKeyScope: ApiKeyScope
      /** Null when this credential's team does not enforce SSO. */
      ssoDelegationStatus?: SsoDelegationStatus
    }
  | {
      kind: 'oauth'
      oauthConsentId: string
      oauthGrantId?: string
      clientId: string
      scopes: readonly string[]
      ssoDelegationStatus?: SsoDelegationStatus
    }
)

export type CallerResult = {
  /** Set-Cookie values to pass on: Better Auth extends or clears the session cookie. */
  setCookie: string[]
} & (
  | { ok: true; principal: Principal; ssoRecoveryTeams?: SsoRecoveryTeam[] }
  | { ok: false; error: 'unauthorized' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number | null }
)

/** Identifies the caller of a request from its headers. */
export type CallerResolver = (
  headers: Headers,
  options?: { includeSsoRecoveryTeams?: boolean },
) => Promise<CallerResult>

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i

/**
 * Callers authenticate with `Authorization: Bearer hm_…` (an API key, for agents) or with
 * the session cookie (the web app). A request that sends an Authorization header is judged
 * by it alone, so a bad key never falls back to a cookie the client happens to carry.
 */
export function createCallerResolver({
  auth,
  db,
  ssoCapabilities: protocolCapabilities = ssoHardOff,
  scimResourcesEnabled = false,
}: {
  auth: Auth
  db: Db
  ssoCapabilities?: TeamSsoCapabilities
  /** No production registration. The SCIM resource test harness supplies this flag. */
  scimResourcesEnabled?: boolean
}): CallerResolver {
  // Off keeps the same object, so nothing downstream changes without the test flag.
  const ssoCapabilities: TeamSsoCapabilities = scimResourcesEnabled
    ? { ...protocolCapabilities, scimResourcesEnabled: true }
    : protocolCapabilities
  const resourceCapability = scimResourcesEnabled ? { scimResourcesEnabled: true as const } : {}
  type Membership = Pick<
    Principal,
    'user' | 'organization' | 'personalOrganizationId' | 'scimProvisioned'
  > & {
    emailVerified: boolean
    apiKeyScope?: ApiKeyScope
    ssoDelegationStatus?: SsoDelegationStatus
    ssoRecoveryTeams?: SsoRecoveryTeam[]
  }

  /**
   * The caller's user and organization, if the user is a member of it. With `apiKeyId`, the
   * same statement also requires that key to still exist, belong to the user and be enabled:
   * Better Auth's key check is an earlier statement, and the key may have been revoked since
   * (e.g. deleted by the email-proof trigger while the request was in flight).
   */
  async function inOrganization(
    userId: string,
    organizationId: string,
    { apiKeyId, recoverySessionId }: { apiKeyId?: string; recoverySessionId?: string } = {},
  ): Promise<Membership | undefined> {
    if (!isUuid(userId) || !isUuid(organizationId)) return undefined
    if (apiKeyId !== undefined && !isUuid(apiKeyId)) return undefined
    // The membership check matters even for ids we stored ourselves: people leave teams.
    const row = await db
      .selectFrom('auth.member as m')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
      .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
      .leftJoin('personal_organizations as own', 'own.user_id', 'u.id')
      .leftJoin('auth.apikey as k', (join) =>
        join
          .on('k.id', '=', apiKeyId ?? '00000000-0000-4000-8000-000000000000')
          .on('k.referenceId', '=', userId),
      )
      .$if(apiKeyId !== undefined, (qb) =>
        qb
          .where('k.id', '=', apiKeyId as string)
          .where(sql<boolean>`k.enabled IS DISTINCT FROM false`),
      )
      .select([
        'u.id as userId',
        'u.name as userName',
        'u.email',
        'u.emailVerified',
        'o.id as organizationId',
        'o.name as organizationName',
        'o.slug',
        'p.user_id as personalOwnerId',
        'own.organization_id as personalOrganizationId',
        'k.metadata as apiKeyMetadata',
        'k.expiresAt as apiKeyExpiresAt',
      ])
      .select((eb) => scimProvisioned(eb.ref('o.id')).as('scimProvisioned'))
      .$if(apiKeyId !== undefined, (qb) =>
        qb.select(
          sql<SsoDelegationStatus>`CASE WHEN p.user_id IS NULL THEN ${ssoDelegationStatus(
            sql<string>`o.id`,
            sql<string>`u.id`,
            'api_key',
            sql<string>`k.id`,
            ssoCapabilities,
          )} END`.as('ssoDelegationStatus'),
        ),
      )
      .$if(recoverySessionId !== undefined, (qb) =>
        qb.select(
          sql<SsoRecoveryTeam[] | null>`CASE WHEN u."emailVerified"
            THEN ${ssoRecoveryTeamsFor(db, userId, recoverySessionId as string, scimResourcesEnabled)} END`.as(
            'ssoRecoveryTeams',
          ),
        ),
      )
      .where('m.userId', '=', userId)
      .where('m.organizationId', '=', organizationId)
      .where((eb) => eb.not(scimSuspended(organizationId, userId, scimResourcesEnabled)))
      .executeTakeFirst()
    if (!row) return undefined
    const metadata =
      apiKeyId === undefined ? null : parsePersistedApiKeyMetadata(row.apiKeyMetadata)
    if (
      apiKeyId !== undefined &&
      (!metadata ||
        (row.apiKeyExpiresAt !== null && row.apiKeyExpiresAt.getTime() <= Date.now()) ||
        (metadata.organizationId ?? row.personalOrganizationId)?.toLowerCase() !==
          organizationId.toLowerCase())
    ) {
      return undefined
    }
    return {
      ...(metadata ? { apiKeyScope: metadata.scope } : {}),
      ...(apiKeyId === undefined ? {} : { ssoDelegationStatus: row.ssoDelegationStatus ?? null }),
      ...(row.ssoRecoveryTeams?.length && { ssoRecoveryTeams: row.ssoRecoveryTeams }),
      emailVerified: row.emailVerified,
      user: { id: row.userId, name: row.userName, email: row.email },
      personalOrganizationId: row.personalOrganizationId,
      ...(row.scimProvisioned && { scimProvisioned: true }),
      organization: {
        id: row.organizationId,
        name: row.organizationName,
        slug: row.slug,
        personal: row.personalOwnerId !== null,
      },
    }
  }

  async function fromApiKey(authorization: string): Promise<CallerResult> {
    const key = BEARER.exec(authorization)?.[1]
    if (!key?.startsWith(API_KEY_PREFIX)) return { ok: false, error: 'unauthorized', setCookie: [] }
    const result = await auth.api.verifyApiKey({ body: { key } })
    if (!result.valid || !result.key) {
      const code = result.error?.code
      if (code === 'RATE_LIMITED' || code === 'USAGE_EXCEEDED') {
        const details: unknown = (result.error as { details?: unknown }).details
        const ms =
          typeof details === 'object' && details !== null && 'tryAgainIn' in details
            ? Number(details.tryAgainIn)
            : Number.NaN
        return {
          ok: false,
          error: 'rate_limited',
          retryAfterSeconds: Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : null,
          setCookie: [],
        }
      }
      return { ok: false, error: 'unauthorized', setCookie: [] }
    }
    const userId = result.key.referenceId
    // Keys act in the organization stored when they were created (see createAuth). A key
    // without one acts in the personal organization; a key whose organization the user has
    // left stops working rather than silently acting somewhere else.
    if (!isUuid(userId) || !isUuid(result.key.id)) {
      return { ok: false, error: 'unauthorized', setCookie: [] }
    }
    const persisted = await db
      .selectFrom('auth.apikey')
      .select('metadata')
      .where('id', '=', result.key.id)
      .where('referenceId', '=', userId)
      .executeTakeFirst()
    const stored = persisted ? parsePersistedApiKeyMetadata(persisted.metadata) : null
    if (!stored) return { ok: false, error: 'unauthorized', setCookie: [] }
    const organizationId = stored.organizationId ?? (await ensurePersonalOrganization(db, userId))
    const membership = await inOrganization(userId, organizationId, { apiKeyId: result.key.id })
    // Keys belong to verified users only; one from before that rule (or planted in an
    // account whose real owner has not signed in yet) does not work. Read in the same
    // statement as the key's existence, so a key deleted when the email was proven cannot
    // slip through as belonging to a now-verified user.
    if (!membership?.emailVerified || !membership.apiKeyScope)
      return { ok: false, error: 'unauthorized', setCookie: [] }
    const { emailVerified: _, apiKeyScope, ...caller } = membership
    return {
      ok: true,
      principal: {
        ...caller,
        ...resourceCapability,
        kind: 'api_key',
        apiKeyId: result.key.id,
        apiKeyScope,
      },
      setCookie: [],
    }
  }

  async function fromSession(
    headers: Headers,
    includeSsoRecoveryTeams: boolean,
  ): Promise<CallerResult> {
    const { headers: responseHeaders, response: session } = await auth.api.getSession({
      headers,
      returnHeaders: true,
    })
    const setCookie = responseHeaders.getSetCookie()
    if (!session) return { ok: false, error: 'unauthorized', setCookie }
    const userId = session.user.id
    const active =
      'activeOrganizationId' in session.session &&
      typeof session.session.activeOrganizationId === 'string'
        ? session.session.activeOrganizationId
        : undefined
    const membershipOptions =
      includeSsoRecoveryTeams && ssoRetained(ssoCapabilities)
        ? { recoverySessionId: session.session.id }
        : undefined
    // A session without effective membership in its active organization acts in the personal one.
    const membership =
      (active ? await inOrganization(userId, active, membershipOptions) : undefined) ??
      (await inOrganization(
        userId,
        await ensurePersonalOrganization(db, userId),
        membershipOptions,
      ))
    if (!membership) return { ok: false, error: 'unauthorized', setCookie }
    const {
      emailVerified: _,
      apiKeyScope: _scope,
      ssoDelegationStatus: _sso,
      ssoRecoveryTeams,
      ...caller
    } = membership
    return {
      ok: true,
      principal: {
        ...caller,
        ...resourceCapability,
        kind: 'session',
        sessionId: session.session.id,
      },
      ...(ssoRecoveryTeams && { ssoRecoveryTeams }),
      setCookie,
    }
  }

  return (headers, { includeSsoRecoveryTeams = false } = {}) => {
    const authorization = headers.get('authorization')
    return authorization === null
      ? fromSession(headers, includeSsoRecoveryTeams)
      : fromApiKey(authorization)
  }
}
