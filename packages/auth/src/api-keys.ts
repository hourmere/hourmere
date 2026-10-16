import type { Db } from '@hourmere/db'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
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
 * API keys belong to a user and act in one organization, stored in the key's metadata as
 * `organizationId`: the personal organization unless the creator names another
 * organization they belong to. Keys always carry the `hm_` prefix.
 */
export function apiKeyHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    const creating = ctx.path === '/api-key/create'
    if (!creating && ctx.path !== '/api-key/update') return
    const body: unknown = ctx.body
    // Malformed bodies are left to the endpoint's own validation.
    if (!isRecord(body)) return
    if (creating && body.prefix !== undefined && body.prefix !== API_KEY_PREFIX) {
      throw new APIError('BAD_REQUEST', { message: `API keys always start with ${API_KEY_PREFIX}` })
    }
    if (!creating && !('metadata' in body)) return
    const metadata = parseMetadata(body.metadata)
    const session = await getSessionFromCtx(ctx)
    // body.userId counts only in server-side calls (auth.api.*); the endpoint refuses it from
    // clients, and without a user it answers 401 itself.
    const fromServer = !ctx.request && typeof body.userId === 'string' ? body.userId : undefined
    const userId = session?.user.id ?? fromServer
    if (!userId || !isUuid(userId)) return
    const organizationId = metadata.organizationId ?? (await ensurePersonalOrganization(db, userId))
    if (!(await isMember(db, userId, organizationId))) {
      throw new APIError('FORBIDDEN', {
        message: 'metadata.organizationId must be an organization you are a member of',
      })
    }
    return { context: { body: { ...body, metadata: { organizationId } } } }
  })
}
