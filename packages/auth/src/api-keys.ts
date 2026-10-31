import type { Db } from '@hourmere/db'
import { APIError, type createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { sql } from 'kysely'
import { API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE } from './api-key-errors.ts'
import {
  type ApiKeyScope,
  isApiKeyScope,
  parsePersistedApiKeyMetadata,
} from './api-key-metadata.ts'
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
    message:
      'metadata must be null or { "organizationId": "<uuid>", "scope": "full" | "read" | "bookings" }',
  })

/**
 * Input metadata selects the organization and immutable credential scope. Anything else (other
 * keys, `__proto__`, arrays, non-uuid ids) is refused before Better Auth stores it, because
 * stored metadata is parsed again whenever the owner lists their keys.
 */
function parseMetadata(value: unknown): { organizationId?: string; scope?: ApiKeyScope } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidMetadata()
  }
  const keys = Object.keys(value)
  if (keys.some((k) => k !== 'organizationId' && k !== 'scope')) throw invalidMetadata()
  const { organizationId, scope } = value
  if (Object.hasOwn(value, 'scope') && !isApiKeyScope(scope)) throw invalidMetadata()
  const parsedScope = isApiKeyScope(scope) ? { scope } : {}
  if (organizationId === undefined) return parsedScope
  if (typeof organizationId !== 'string' || !isUuid(organizationId)) throw invalidMetadata()
  return { organizationId, ...parsedScope }
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

/** API-key management accepts browser sessions or trusted server authority, never a bearer. */
export function apiKeyCredentialBoundary(ctx: AuthMiddlewareContext) {
  if (
    [
      '/api-key/create',
      '/api-key/get',
      '/api-key/list',
      '/api-key/update',
      '/api-key/delete',
    ].includes(ctx.path) &&
    ctx.request?.headers.has('authorization')
  ) {
    throw new APIError('FORBIDDEN', {
      code: 'SESSION_REQUIRED',
      message: 'API key management requires a browser session without Authorization',
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
  if ('scope' in body || 'scopes' in body) throw invalidMetadata()
  const withMetadata = creating || 'metadata' in body
  const session = await getSessionFromCtx(ctx)
  // body.userId counts only in server-side calls (auth.api.*); the endpoint refuses it from
  // clients, and without a user it answers 401 itself.
  const fromServer =
    !ctx.request && !ctx.headers && typeof body.userId === 'string' ? body.userId : undefined
  const userId = session?.user.id ?? fromServer
  if (!userId || !isUuid(userId)) return
  if (session && body.userId !== undefined && body.userId !== session.user.id) return
  // Leave ownership failures to the native endpoint, without revealing a key's scope.
  const owned =
    !creating && typeof body.keyId === 'string' && isUuid(body.keyId)
      ? await db
          .selectFrom('auth.apikey')
          .select('metadata')
          .where('id', '=', body.keyId)
          .where('referenceId', '=', userId)
          .where('configId', '=', typeof body.configId === 'string' ? body.configId : 'default')
          .executeTakeFirst()
      : undefined
  if (!creating && !owned) return
  // Switching a key off is always allowed: it only takes power away. (Better Auth still
  // checks that the key belongs to the caller.)
  const disablingOnly =
    !creating &&
    body.enabled === false &&
    Object.keys(body).every((k) => k === 'keyId' || k === 'enabled' || k === 'configId')
  if (disablingOnly) return
  await mayHoldApiKeys(db, userId, session?.session.id)
  if (!creating && isRecord(body.metadata) && Object.hasOwn(body.metadata, 'scope')) {
    throw new APIError('BAD_REQUEST', {
      code: 'API_KEY_SCOPE_IMMUTABLE',
      message: 'API key scope cannot be changed; create a replacement key',
    })
  }
  const metadata = withMetadata ? parseMetadata(body.metadata) : {}
  if (!withMetadata) return
  const organizationId = metadata.organizationId ?? (await ensurePersonalOrganization(db, userId))
  if (!(await isMember(db, userId, organizationId))) {
    throw new APIError('FORBIDDEN', {
      message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
    })
  }
  const scope = creating
    ? (metadata.scope ?? 'full')
    : parsePersistedApiKeyMetadata(owned?.metadata ?? null)?.scope
  if (!scope) throw invalidMetadata()
  return { context: { body: { ...body, metadata: { organizationId, scope } } } }
}

/** The context Better Auth passes to a `hooks.before` middleware. */
export type AuthMiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]
