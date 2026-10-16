import type { Db } from '@hourmere/db'
import type { Auth } from './index.ts'
import { ensurePersonalOrganization, isUuid } from './organizations.ts'

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
export type Principal = { user: CallerUser; organization: CallerOrganization } & (
  | { kind: 'session'; sessionId: string }
  | { kind: 'api_key'; apiKeyId: string }
)

export type CallerResult = {
  /** Set-Cookie values to pass on: Better Auth extends or clears the session cookie. */
  setCookie: string[]
} & (
  | { ok: true; principal: Principal }
  | { ok: false; error: 'unauthorized' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number | null }
)

/** Identifies the caller of a request from its headers. */
export type CallerResolver = (headers: Headers) => Promise<CallerResult>

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i

/**
 * Callers authenticate with `Authorization: Bearer hm_…` (an API key, for agents) or with
 * the session cookie (the web app). A request that sends an Authorization header is judged
 * by it alone, so a bad key never falls back to a cookie the client happens to carry.
 */
export function createCallerResolver({ auth, db }: { auth: Auth; db: Db }): CallerResolver {
  async function inOrganization(
    userId: string,
    organizationId: string,
  ): Promise<Omit<Principal, 'kind' | 'sessionId' | 'apiKeyId'> | undefined> {
    if (!isUuid(userId) || !isUuid(organizationId)) return undefined
    // The membership check matters even for ids we stored ourselves: people leave teams.
    const row = await db
      .selectFrom('auth.member as m')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
      .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
      .select([
        'u.id as userId',
        'u.name as userName',
        'u.email',
        'o.id as organizationId',
        'o.name as organizationName',
        'o.slug',
        'p.user_id as personalOwnerId',
      ])
      .where('m.userId', '=', userId)
      .where('m.organizationId', '=', organizationId)
      .executeTakeFirst()
    if (!row) return undefined
    return {
      user: { id: row.userId, name: row.userName, email: row.email },
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
    const stored: unknown = result.key.metadata?.organizationId
    const organizationId =
      typeof stored === 'string' ? stored : await ensurePersonalOrganization(db, userId)
    const caller = await inOrganization(userId, organizationId)
    if (!caller) return { ok: false, error: 'unauthorized', setCookie: [] }
    return {
      ok: true,
      principal: { ...caller, kind: 'api_key', apiKeyId: result.key.id },
      setCookie: [],
    }
  }

  async function fromSession(headers: Headers): Promise<CallerResult> {
    const { headers: responseHeaders, response: session } = await auth.api.getSession({
      headers,
      returnHeaders: true,
    })
    const setCookie = responseHeaders.getSetCookie()
    if (!session) return { ok: false, error: 'unauthorized', setCookie }
    const userId = session.user.id
    const active = session.session.activeOrganizationId
    // A session whose active organization is gone (or was never set) acts in the personal one.
    const caller =
      (active ? await inOrganization(userId, active) : undefined) ??
      (await inOrganization(userId, await ensurePersonalOrganization(db, userId)))
    if (!caller) return { ok: false, error: 'unauthorized', setCookie }
    return {
      ok: true,
      principal: { ...caller, kind: 'session', sessionId: session.session.id },
      setCookie,
    }
  }

  return (headers) => {
    const authorization = headers.get('authorization')
    return authorization === null ? fromSession(headers) : fromApiKey(authorization)
  }
}
