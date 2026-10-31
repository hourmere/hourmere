import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiKeyScopeError, requireActiveApiKey } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { type Selectable, sql, type Transaction } from 'kysely'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { isConstraintViolation, isUuid, SQLSTATE, timestamp } from './internal.ts'
import { cleanText } from './text.ts'

/** Active, unexpired links per personal owner or team organization. */
export const ONE_TIME_BOOKING_LINK_LIMIT = 1000

export type OneTimeBookingLinkState = 'active' | 'used' | 'expired' | 'revoked'

/** Convenience form values only; possessing them never proves invitee identity. */
export interface OneTimeBookingLinkPrefill {
  name: string | null
  email: string | null
}

export interface OneTimeBookingLink {
  id: string
  organizationId: string
  eventTypeId: string
  creatorUserId: string
  expiresAt: string | null
  prefill: OneTimeBookingLinkPrefill
  state: OneTimeBookingLinkState
  bookingId: string | null
  usedAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateOneTimeBookingLinkInput {
  eventTypeId: string
  expiresAt?: string | null | undefined
  prefill?: { name?: string | null | undefined; email?: string | null | undefined } | undefined
}

/** Resolution exposes no credential digest or private administrative history. */
export type ResolvedOneTimeBookingLink = Pick<
  OneTimeBookingLink,
  'id' | 'organizationId' | 'eventTypeId' | 'prefill'
>

type LinkRow = Selectable<Database['one_time_booking_links']>
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUMMY_HASH = createHash('sha256').update('hourmere-one-time-link-miss').digest()
const linkNotFound = () => new DomainError('not_found', 'one_time_link_not_found')
const eventNotFound = () => new DomainError('not_found', 'event_type_not_found')
const insufficientRole = () => new DomainError('forbidden', 'insufficient_role')
const invalid = () => new DomainError('invalid', 'invalid_one_time_link')

/** Return the raw capability only here; every persisted value is its SHA-256 digest. */
export async function createOneTimeBookingLink(
  ctx: ServiceContext,
  input: CreateOneTimeBookingLinkInput,
): Promise<OneTimeBookingLink & { token: string }> {
  requireFullScope(ctx)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  if (!isUuid(input.eventTypeId)) throw eventNotFound()
  const expiresAt = validExpiry(input.expiresAt)
  const prefill = validPrefill(input.prefill)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, input.eventTypeId)
    await lockWriteOwner(trx, ctx)
    const event = await authorizedEvent(trx, ctx, input.eventTypeId)
    if (!event.is_active || event.deleted_at !== null)
      throw new DomainError('invalid', 'event_type_inactive')
    if (ctx.principal.kind === 'api_key') await requireActiveApiKey(trx, ctx.principal, Date.now)
    if (expiresAt !== null) {
      const { future } = await trx
        .selectNoFrom(sql<boolean>`${expiresAt}::timestamptz > clock_timestamp()`.as('future'))
        .executeTakeFirstOrThrow()
      if (!future) throw invalid()
    }
    const { count } = await trx
      .selectFrom('one_time_booking_links')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('organization_id', '=', event.organization_id)
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
      )
      .executeTakeFirstOrThrow()
    if (Number(count) >= ONE_TIME_BOOKING_LINK_LIMIT)
      throw new DomainError('conflict', 'one_time_link_limit_reached')
    const token = randomBytes(32).toString('base64url')
    const row = await trx
      .insertInto('one_time_booking_links')
      .values({
        organization_id: event.organization_id,
        event_type_id: event.id,
        creator_user_id: ctx.principal.user.id,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        prefill_name: prefill.name,
        prefill_email: prefill.email,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ...toLink(row, false), token }
  })
}

/** Unknown and every unusable capability have the same public result. */
export async function resolveOneTimeBookingLink(
  ctx: Pick<PublicContext, 'db'>,
  token: string | undefined,
): Promise<ResolvedOneTimeBookingLink> {
  const row = await lookupToken(ctx.db, token)
  if (!row || !(await publicEvent(ctx.db, row.event_type_id))) throw linkNotFound()
  const live = await liveLink(ctx.db, row.id)
  if (!live) throw linkNotFound()
  return {
    id: live.id,
    organizationId: live.organization_id,
    eventTypeId: live.event_type_id,
    prefill: { name: live.prefill_name, email: live.prefill_email },
  }
}

/** Owners can retire an active link even after its event type is disabled or deleted. */
export async function revokeOneTimeBookingLink(
  ctx: ServiceContext,
  id: string,
): Promise<OneTimeBookingLink> {
  requireFullScope(ctx)
  if (!isUuid(id)) throw linkNotFound()
  return ctx.db.transaction().execute(async (trx) => {
    const initial = await trx
      .selectFrom('one_time_booking_links')
      .select(['id', 'event_type_id'])
      .where('id', '=', id)
      .where('organization_id', '=', ctx.principal.organization.id)
      .executeTakeFirst()
    if (!initial) throw linkNotFound()
    await ctx.authorizeOrganizationWrite?.(
      trx,
      ctx.principal.organization.id,
      initial.event_type_id,
    )
    await lockWriteOwner(trx, ctx)
    await authorizedEvent(trx, ctx, initial.event_type_id)
    if (ctx.principal.kind === 'api_key') await requireActiveApiKey(trx, ctx.principal, Date.now)
    const row = await trx
      .selectFrom('one_time_booking_links')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw linkNotFound()
    if (row.state === 'active') {
      const { expired } = await trx
        .selectNoFrom(
          sql<boolean>`${row.expires_at}::timestamptz IS NOT NULL AND ${row.expires_at}::timestamptz <= clock_timestamp()`.as(
            'expired',
          ),
        )
        .executeTakeFirstOrThrow()
      if (expired) return toLink(row, true)
      const revoked = await trx
        .updateTable('one_time_booking_links')
        .set({ state: 'revoked', revoked_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      return toLink(revoked, false)
    }
    return toLink(row, false)
  })
}

/**
 * Consume only on the booking transaction's connection. A caller must let failures
 * abort that transaction; rollback restores both the booking and its link together.
 * Cancellation and rescheduling never transition a used link back to active.
 */
export async function claimOneTimeBookingLink(
  trx: Transaction<Database>,
  token: string | undefined,
  bookingId: string,
): Promise<OneTimeBookingLink> {
  if (!trx.isTransaction) throw new TypeError('A booking transaction is required')
  const initial = await lookupToken(trx, token)
  if (!initial || !isUuid(bookingId)) throw linkNotFound()
  try {
    await lockOrganization(trx, initial.organization_id)
  } catch (error) {
    if (error instanceof DomainError) throw linkNotFound()
    throw error
  }
  if (!(await publicEvent(trx, initial.event_type_id, true))) throw linkNotFound()
  const booking = await trx
    .selectFrom('bookings')
    .select('id')
    .where('id', '=', bookingId)
    .where('organization_id', '=', initial.organization_id)
    .where('event_type_id', '=', initial.event_type_id)
    .where('status', '=', 'confirmed')
    .forShare()
    .executeTakeFirst()
  if (!booking) throw linkNotFound()
  // Lock before reading wall time: a competing claim may have held the row past expiry.
  const locked = await trx
    .selectFrom('one_time_booking_links')
    .select('id')
    .where('id', '=', initial.id)
    .forUpdate()
    .executeTakeFirst()
  if (!locked) throw linkNotFound()
  try {
    const claimed = await trx
      .updateTable('one_time_booking_links')
      .set({ state: 'used', booking_id: bookingId, used_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', locked.id)
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
      )
      .returningAll()
      .executeTakeFirst()
    if (!claimed) throw linkNotFound()
    return toLink(claimed, false)
  } catch (error) {
    if (
      isConstraintViolation(
        error,
        SQLSTATE.uniqueViolation,
        'one_time_booking_links_booking_id_key',
      ) ||
      isClaimGuardViolation(error)
    )
      throw linkNotFound()
    throw error
  }
}

function requireFullScope(ctx: ServiceContext) {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')
    throw new ApiKeyScopeError()
}

/** Serialize capacity across event types and recheck the actual personal marker. */
async function lockWriteOwner(db: Db, ctx: ServiceContext) {
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (personal && personal.user_id !== ctx.principal.user.id) throw insufficientRole()
  const actor = await db
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', ctx.principal.user.id)
    .$if(personal !== undefined, (query) => query.forUpdate())
    .$if(personal === undefined, (query) => query.forShare())
    .executeTakeFirst()
  if (!actor?.emailVerified) throw insufficientRole()
  const organization = await db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', ctx.principal.organization.id)
    .forUpdate()
    .executeTakeFirst()
  if (!organization) throw eventNotFound()
}

async function authorizedEvent(db: Db, ctx: ServiceContext, eventTypeId: string) {
  const membership = await db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', ctx.principal.organization.id)
    .where('userId', '=', ctx.principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!membership) throw insufficientRole()
  const event = await db
    .selectFrom('event_types')
    .select(['id', 'organization_id', 'owner_user_id', 'is_active', 'deleted_at'])
    .where('id', '=', eventTypeId)
    .where('organization_id', '=', ctx.principal.organization.id)
    .forShare()
    .executeTakeFirst()
  if (!event || (event.owner_user_id !== null && event.owner_user_id !== ctx.principal.user.id))
    throw eventNotFound()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', event.organization_id)
    .executeTakeFirst()
  if (personal && event.owner_user_id !== personal.user_id) throw eventNotFound()
  const roles = membership.role.split(',').map((role) => role.trim())
  if (event.owner_user_id === null && !roles.includes('owner') && !roles.includes('admin'))
    throw insufficientRole()
  return event
}

/** Hidden types are deliberately eligible; current ownership and membership still apply. */
async function publicEvent(db: Db, eventTypeId: string, lock = false) {
  const query = db
    .selectFrom('event_types')
    .select(['organization_id', 'owner_user_id', 'is_active', 'deleted_at'])
    .where('id', '=', eventTypeId)
  let event = await query.executeTakeFirst()
  if (!event?.is_active || event.deleted_at !== null) return false
  // Account deletion locks the owner before cascading its event types. Take the
  // same order, then reread the event so an ownership change cannot escape the lock.
  const ownerId = event.owner_user_id
  if (ownerId !== null) {
    let ownerQuery = db.selectFrom('auth.user').select('emailVerified').where('id', '=', ownerId)
    if (lock) ownerQuery = ownerQuery.forShare()
    if (!(await ownerQuery.executeTakeFirst())?.emailVerified) return false
  }
  if (lock) {
    event = await query.forShare().executeTakeFirst()
    if (!event?.is_active || event.deleted_at !== null || event.owner_user_id !== ownerId)
      return false
  }
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', event.organization_id)
    .executeTakeFirst()
  if (personal && event.owner_user_id !== personal.user_id) return false
  if (event.owner_user_id !== null) {
    let memberQuery = db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', event.organization_id)
      .where('userId', '=', event.owner_user_id)
    if (lock) memberQuery = memberQuery.forShare()
    if (!(await memberQuery.executeTakeFirst())) return false
  }
  return true
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** One indexed digest lookup, followed by equal-length constant-time comparison on misses too. */
async function lookupToken(db: Db, token: string | undefined) {
  const valid = typeof token === 'string' && TOKEN.test(token)
  const hash = hashToken(valid ? token : '')
  const row = await db
    .selectFrom('one_time_booking_links')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst()
  const matches = timingSafeEqual(
    Buffer.from(hash, 'hex'),
    row ? Buffer.from(row.token_hash, 'hex') : DUMMY_HASH,
  )
  return valid && matches ? row : undefined
}

function liveLink(db: Db, id: string) {
  return db
    .selectFrom('one_time_booking_links')
    .selectAll()
    .where('id', '=', id)
    .where('state', '=', 'active')
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
    )
    .executeTakeFirst()
}

function toLink(row: LinkRow, expired: boolean): OneTimeBookingLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventTypeId: row.event_type_id,
    creatorUserId: row.creator_user_id,
    expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
    prefill: { name: row.prefill_name, email: row.prefill_email },
    state: row.state === 'active' && expired ? 'expired' : (row.state as OneTimeBookingLinkState),
    bookingId: row.booking_id,
    usedAt: row.used_at === null ? null : timestamp(row.used_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function validExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid()
  try {
    const instant = Temporal.Instant.from(value)
    const date = new Date(instant.epochMilliseconds)
    if (!Number.isFinite(date.getTime())) throw invalid()
    return date.toISOString()
  } catch {
    throw invalid()
  }
}

function validPrefill(value: unknown): OneTimeBookingLinkPrefill {
  if (value === undefined) return { name: null, email: null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  if (Object.keys(value).some((key) => key !== 'name' && key !== 'email')) throw invalid()
  const input = value as { name?: unknown; email?: unknown }
  const name = input.name == null ? null : cleanText(input.name, { max: 200 })
  const email = input.email == null ? null : cleanText(input.email, { max: 254 })
  if (name === undefined || email === undefined || (email !== null && !EMAIL.test(email)))
    throw invalid()
  return { name, email: email?.toLowerCase() ?? null }
}

function isClaimGuardViolation(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return (
    code === '23514' &&
    (constraint === 'one_time_booking_links_claim_expired' ||
      constraint === 'one_time_booking_links_claim_booking' ||
      constraint === 'one_time_booking_links_terminal')
  )
}
