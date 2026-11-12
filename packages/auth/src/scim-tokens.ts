import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import { isUuid } from './organizations.ts'
import { checkTeamManagementAccess, TeamManagementError } from './team-management.ts'

export const SCIM_TOKEN_PREFIX = 'scim_'
export const SCIM_MAX_OVERLAP_SECONDS = 86400
// One authoritative IdP, with room for staged replacement and recovery credentials.
export const SCIM_MAX_ACTIVE_TOKENS = 10
export class ScimTokenError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'conflict' | 'invalid_input'
  readonly status: 400 | 403 | 404 | 409
  constructor(
    code: 'forbidden' | 'not_found' | 'conflict' | 'invalid_input',
    status: 400 | 403 | 404 | 409,
  ) {
    super(`scim_token_${code}`)
    this.code = code
    this.status = status
  }
}
export interface ScimTokenActor {
  userId: string
  organizationId: string
  sessionId: string
}
// Same SHA-256/base64url digest as Better Auth's default API-key hasher.
const hash = (secret: string) => createHash('sha256').update(secret).digest('base64url')
const mint = () => `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
const metadata = [
  'id',
  'organization_id as organizationId',
  'name',
  'created_at as createdAt',
  'created_by_user_id as createdByUserId',
  'rotated_by_user_id as rotatedByUserId',
  'rotated_at as rotatedAt',
  'last_used_at as lastUsedAt',
  'revoked_at as revokedAt',
  'previous_valid_until as previousValidUntil',
  sql<null>`null`.as('expiresAt'),
] as const

/** Like API keys: the token ID and the session that changed it, never the name or a secret. */
async function audit(
  trx: Db,
  actor: ScimTokenActor,
  action: 'scim_token.created' | 'scim_token.rotated' | 'scim_token.revoked',
  tokenId: string,
) {
  await writeAuditEvent(trx, {
    organizationId: actor.organizationId,
    ...auditActor({ kind: 'session', sessionId: actor.sessionId, user: { id: actor.userId } }),
    action,
    targetType: 'scim_token',
    targetId: tokenId,
  })
}

async function authorized<T>(
  db: Db,
  actor: ScimTokenActor,
  work: (trx: Db) => Promise<T>,
  ownerOnly = false,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    try {
      const manager = await checkTeamManagementAccess(
        trx,
        {
          kind: 'session',
          sessionId: actor.sessionId,
          user: { id: actor.userId, name: '', email: '' },
          organization: { id: actor.organizationId, name: '', slug: '', personal: false },
        },
        actor.organizationId,
        true,
        { expectedOrganizationId: actor.organizationId, allowPersonal: false },
      )
      if (ownerOnly && manager.role !== 'owner') throw new ScimTokenError('forbidden', 403)
    } catch (error) {
      if (error instanceof TeamManagementError) throw new ScimTokenError('forbidden', 403)
      throw error
    }
    return work(trx)
  })
}

export async function createScimToken(db: Db, input: ScimTokenActor & { name: string }) {
  const name = input.name.trim()
  if (
    name.length < 1 ||
    name.length > 100 ||
    /^(?:scim_[A-Za-z0-9_-]{43}|hm_[A-Za-z0-9_-]{64})$/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new ScimTokenError('invalid_input', 400)
  return authorized(
    db,
    input,
    async (trx) => {
      const count = await trx
        .selectFrom('scim_provisioning_tokens')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('organization_id', '=', input.organizationId)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow()
      if (Number(count.count) >= SCIM_MAX_ACTIVE_TOKENS) throw new ScimTokenError('conflict', 409)
      const secret = mint()
      const token = await trx
        .insertInto('scim_provisioning_tokens')
        .values({
          organization_id: input.organizationId,
          name,
          token_hash: hash(secret),
          created_by_user_id: input.userId,
        })
        .returning(metadata)
        .executeTakeFirstOrThrow()
      await audit(trx, input, 'scim_token.created', token.id)
      return { token, secret }
    },
    true,
  )
}
export async function listScimTokens(
  db: Db,
  input: ScimTokenActor & { limit?: number; after?: string },
) {
  const limit = input.limit ?? 20
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.after !== undefined && !isUuid(input.after))
  )
    throw new ScimTokenError('invalid_input', 400)
  return authorized(db, input, async (trx) => {
    let query = trx
      .selectFrom('scim_provisioning_tokens')
      .select(metadata)
      .where('organization_id', '=', input.organizationId)
    if (input.after) query = query.where('id', '<', input.after)
    const rows = await query
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()
    const tokens = rows.slice(0, limit)
    return { tokens, nextCursor: rows.length > limit ? (tokens.at(-1)?.id ?? null) : null }
  })
}
export async function rotateScimToken(
  db: Db,
  input: ScimTokenActor & { tokenId: string; overlapSeconds: number },
) {
  if (
    !isUuid(input.tokenId) ||
    !Number.isInteger(input.overlapSeconds) ||
    input.overlapSeconds < 0 ||
    input.overlapSeconds > SCIM_MAX_OVERLAP_SECONDS
  )
    throw new ScimTokenError('invalid_input', 400)
  return authorized(
    db,
    input,
    async (trx) => {
      const row = await trx
        .selectFrom('scim_provisioning_tokens')
        .selectAll()
        .where('id', '=', input.tokenId)
        .where('organization_id', '=', input.organizationId)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw new ScimTokenError('not_found', 404)
      if (row.revoked_at) throw new ScimTokenError('conflict', 409)
      const overlapping = await trx
        .selectNoFrom(
          sql<boolean>`${row.previous_valid_until}::timestamptz > clock_timestamp()`.as('active'),
        )
        .executeTakeFirstOrThrow()
      if (overlapping.active) throw new ScimTokenError('conflict', 409)
      const secret = mint()
      const token = await trx
        .updateTable('scim_provisioning_tokens')
        .set({
          token_hash: hash(secret),
          rotated_by_user_id: input.userId,
          rotated_at: sql`clock_timestamp()`,
          previous_token_hash: input.overlapSeconds > 0 ? row.token_hash : null,
          previous_valid_until:
            input.overlapSeconds > 0
              ? sql`clock_timestamp() + ${input.overlapSeconds} * interval '1 second'`
              : null,
        })
        .where('id', '=', row.id)
        .returning(metadata)
        .executeTakeFirstOrThrow()
      await audit(trx, input, 'scim_token.rotated', token.id)
      return { token, secret }
    },
    true,
  )
}
export async function revokeScimToken(db: Db, input: ScimTokenActor & { tokenId: string }) {
  if (!isUuid(input.tokenId)) throw new ScimTokenError('invalid_input', 400)
  return authorized(db, input, async (trx) => {
    // Revocation is idempotent: only the request that revokes the token records it. The
    // organization lock taken by authorization already serializes token writes; this row
    // lock keeps the read exact on its own.
    const before = await trx
      .selectFrom('scim_provisioning_tokens')
      .select('revoked_at')
      .where('id', '=', input.tokenId)
      .where('organization_id', '=', input.organizationId)
      .forUpdate()
      .executeTakeFirst()
    const token = await trx
      .updateTable('scim_provisioning_tokens')
      .set({
        token_hash: null,
        previous_token_hash: null,
        previous_valid_until: null,
        revoked_at: sql`coalesce(revoked_at, clock_timestamp())`,
      })
      .where('id', '=', input.tokenId)
      .where('organization_id', '=', input.organizationId)
      .returning(metadata)
      .executeTakeFirst()
    if (!token) throw new ScimTokenError('not_found', 404)
    if (!before?.revoked_at) await audit(trx, input, 'scim_token.revoked', token.id)
    return token
  })
}

/** The caller must pass the actual request pathname; never call this for another protocol. */
export async function authenticateScimToken(
  db: Db,
  input: { path: string; authorization: string | null; organizationId: string; enabled: boolean },
) {
  const base = `/scim/v2/${input.organizationId}`
  if (
    !input.enabled ||
    !isUuid(input.organizationId) ||
    !(input.path === base || input.path.startsWith(`${base}/`))
  )
    return null
  const match = /^Bearer[ \t]+(scim_[A-Za-z0-9_-]{43})[ \t]*$/i.exec(input.authorization ?? '')
  if (!match?.[1]) return null
  const digest = hash(match[1])
  // One conditional UPDATE serializes last-use with revoke/rotate and never resurrects a key.
  const row = await db
    .updateTable('scim_provisioning_tokens')
    .set({ last_used_at: sql`clock_timestamp()` })
    .where('organization_id', '=', input.organizationId)
    .where('revoked_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('token_hash', '=', digest),
        eb.and([
          eb('previous_token_hash', '=', digest),
          eb('previous_valid_until', '>', sql<Date>`clock_timestamp()`),
        ]),
      ]),
    )
    .returning(['id as tokenId', 'organization_id as organizationId'])
    .executeTakeFirst()
  return row ?? null
}
