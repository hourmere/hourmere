import type { Db } from '@hourmere/db'
import { APIError, type createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { sql } from 'kysely'
import { API_KEY_PREFIX } from './caller.ts'
import { ensurePersonalOrganization, isMember, isUuid } from './organizations.ts'

/**
 * Per-key limit written into each new key. A safety net against runaway agents, not the
 * product's API limits, which belong in the API layer.
 */
export const API_KEY_RATE_LIMIT = { timeWindow: 60_000, maxRequests: 600 } as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const invalidMetadata = () =>
  new APIError('BAD_REQUEST', {
    code: 'INVALID_METADATA',
    message: 'metadata must be null or { "organizationId": "<uuid>" }',
  })

/**
 * The only metadata a key may carry: which organization it acts in. Anything else (other
 * keys, `__proto__`, arrays, non-uuid ids) is refused before Better Auth stores it, because
 * stored metadata is parsed again whenever the owner lists their keys.
 */
function parseMetadata(value: unknown): { organizationId?: string } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidMetadata()
  }
  const keys = Object.keys(value)
  if (keys.some((k) => k !== 'organizationId')) throw invalidMetadata()
  const { organizationId } = value
  if (organizationId === undefined) return {}
  if (typeof organizationId !== 'string' || !isUuid(organizationId)) throw invalidMetadata()
  return { organizationId }
}

/**
 * Whether `userId` may hold API keys right now: their email is verified and, for a request
 * made with a session, that session still exists. One statement, so it sees a consistent
 * moment: when an unverified account's real owner proves the address, Better Auth deletes
 * the sessions before it marks the email verified, so "session alive and verified" is never
 * true for an account in that process. (Better Auth reuses the session it loaded at the
 * start of the request, so its own check cannot be relied on to notice the deletion.)
 */
export async function mayHoldApiKeys(db: Db, userId: string, sessionId: string | undefined) {
  const row = await db
    .selectFrom('auth.user as u')
    .select((eb) => [
      'u.emailVerified',
      sessionId === undefined
        ? sql<boolean>`true`.as('sessionAlive')
        : eb
            .exists(
              eb
                .selectFrom('auth.session as s')
                .select('s.id')
                .where('s.id', '=', sessionId)
                .whereRef('s.userId', '=', 'u.id'),
            )
            .as('sessionAlive'),
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst()
  if (!row || (sessionId !== undefined && !row.sessionAlive)) {
    throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED_SESSION', message: 'Sign in again' })
  }
  if (!row.emailVerified) {
    throw new APIError('FORBIDDEN', {
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Confirm your email address by signing in with an email link before using API keys',
    })
  }
}

/**
 * Rules for `/api-key/create` and `/api-key/update`, run before Better Auth's endpoint.
 *
 * API keys belong to a user with a verified email and act in one organization, stored in the
 * key's metadata as `organizationId`: the personal organization unless the creator names
 * another organization they belong to. Keys always carry the `hm_` prefix.
 */
export async function apiKeyRules(ctx: AuthMiddlewareContext, db: Db) {
  const creating = ctx.path === '/api-key/create'
  if (!creating && ctx.path !== '/api-key/update') return
  const body: unknown = ctx.body
  // Malformed bodies are left to the endpoint's own validation.
  if (!isRecord(body)) return
  if (creating && body.prefix !== undefined && body.prefix !== API_KEY_PREFIX) {
    throw new APIError('BAD_REQUEST', { message: `API keys always start with ${API_KEY_PREFIX}` })
  }
  const withMetadata = creating || 'metadata' in body
  const metadata = withMetadata ? parseMetadata(body.metadata) : {}
  const session = await getSessionFromCtx(ctx)
  // body.userId counts only in server-side calls (auth.api.*); the endpoint refuses it from
  // clients, and without a user it answers 401 itself.
  const fromServer = !ctx.request && typeof body.userId === 'string' ? body.userId : undefined
  const userId = session?.user.id ?? fromServer
  if (!userId || !isUuid(userId)) return
  // Switching a key off is always allowed: it only takes power away. (Better Auth still
  // checks that the key belongs to the caller.)
  const disablingOnly =
    !creating &&
    body.enabled === false &&
    Object.keys(body).every((k) => k === 'keyId' || k === 'enabled' || k === 'configId')
  if (disablingOnly) return
  await mayHoldApiKeys(db, userId, session?.session.id)
  if (!withMetadata) return
  const organizationId = metadata.organizationId ?? (await ensurePersonalOrganization(db, userId))
  if (!(await isMember(db, userId, organizationId))) {
    throw new APIError('FORBIDDEN', {
      message: 'metadata.organizationId must be an organization you are a member of',
    })
  }
  return { context: { body: { ...body, metadata: { organizationId } } } }
}

/** The context Better Auth passes to a `hooks.before` middleware. */
export type AuthMiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]
