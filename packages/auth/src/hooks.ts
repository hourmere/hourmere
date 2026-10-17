import type { Db } from '@hourmere/db'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { type AuthMiddlewareContext, apiKeyRules } from './api-keys.ts'
import { displayNameRules } from './display-name.ts'
import { checkListQuery, emptyMemberList } from './lists.ts'
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
    const filter = checkListQuery(ctx.path, ctx.query)
    const empty = await emptyMemberList(ctx, db, filter)
    if (empty) return empty
    await personalOwnerStays(ctx, db)
    return displayNameRules(ctx) ?? apiKeyRules(ctx, db)
  })
}
