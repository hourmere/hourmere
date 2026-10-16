import type { Db } from '@hourmere/db'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { type AuthMiddlewareContext, apiKeyRules } from './api-keys.ts'
import { isUuid, personalOwner } from './organizations.ts'

/** Request fields that Better Auth looks up in uuid columns. */
const ID_FIELDS = ['id', 'userId', 'organizationId', 'memberId', 'invitationId', 'keyId']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Answers 400 for an id that is not a UUID. Better Auth would pass it to Postgres, which
 * fails and echoes the value back in its error: a 500, and attacker-chosen text in the log.
 */
function requireUuidIds(source: unknown) {
  if (!isRecord(source)) return
  const invalid = (field: string) =>
    new APIError('BAD_REQUEST', { code: 'INVALID_ID', message: `${field} must be a UUID` })
  for (const field of ID_FIELDS) {
    const value = source[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !isUuid(value)) throw invalid(field)
  }
  // An email address or a member id.
  const memberIdOrEmail = source.memberIdOrEmail
  if (typeof memberIdOrEmail === 'string' && !memberIdOrEmail.includes('@')) {
    if (!isUuid(memberIdOrEmail)) throw invalid('memberIdOrEmail')
  }
}

/**
 * Fields that list endpoints may sort or filter by, per endpoint, and which of them hold
 * UUIDs. Better Auth hands sortBy / filterField to its database adapter as column names and
 * filterValue to Postgres as is: unknown names and malformed ids would be 500s with the
 * request text in the error.
 */
const LIST_FIELDS: Record<string, { fields: string[]; uuids: string[] }> = {
  '/organization/list-members': {
    fields: ['id', 'organizationId', 'userId', 'role', 'createdAt'],
    uuids: ['id', 'organizationId', 'userId'],
  },
  '/api-key/list': {
    fields: ['name', 'start', 'prefix', 'enabled', 'expiresAt', 'createdAt', 'updatedAt'],
    uuids: [],
  },
}

function requireListFields(path: string | undefined, query: unknown) {
  const list = path === undefined ? undefined : LIST_FIELDS[path]
  if (!list || !isRecord(query)) return
  for (const param of ['sortBy', 'filterField']) {
    const value = query[param]
    if (value !== undefined && (typeof value !== 'string' || !list.fields.includes(value))) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVALID_FIELD',
        message: `${param} must be one of ${list.fields.join(', ')}`,
      })
    }
  }
  const field = query.filterField
  if (typeof field === 'string' && list.uuids.includes(field) && query.filterValue !== undefined) {
    const values = Array.isArray(query.filterValue) ? query.filterValue : [query.filterValue]
    if (!values.every((v) => typeof v === 'string' && isUuid(v))) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVALID_ID',
        message: `filterValue must be a UUID (or UUIDs) for ${field}`,
      })
    }
  }
}

/**
 * Better Auth's organization plugin has no hook for leaving. Its own rule (the only owner
 * cannot leave) protects a personal organization only while nobody else is an owner, which
 * the other guards ensure for new data but which old or hand-made rows could break.
 */
async function personalOwnerStays(ctx: AuthMiddlewareContext, db: Db) {
  if (ctx.path !== '/organization/leave' || !isRecord(ctx.body)) return
  const organizationId = ctx.body.organizationId
  if (typeof organizationId !== 'string') return
  const session = await getSessionFromCtx(ctx)
  if (session && (await personalOwner(db, organizationId)) === session.user.id) {
    throw new APIError('FORBIDDEN', {
      code: 'PERSONAL_ORGANIZATION',
      message: 'Nobody can leave their own personal organization',
    })
  }
}

/** Better Auth's `hooks.before`: checks that apply across its endpoints. */
export function beforeHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    requireUuidIds(ctx.query)
    requireUuidIds(ctx.body)
    requireListFields(ctx.path, ctx.query)
    await personalOwnerStays(ctx, db)
    return apiKeyRules(ctx, db)
  })
}
