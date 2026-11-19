import type { Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import { sql } from 'kysely'
import { toInstant } from './availability.ts'
import {
  assertSeriesRevision,
  type BookingOrigin,
  cancelSeriesMemberInTransaction,
  canonicalJson,
  IDEMPOTENCY_KEY,
  normalizeReason,
  sha256,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid, timestamp } from './internal.ts'
import { resolveSeriesBookerBookingIds, resolveSeriesCapability } from './recurring-capabilities.ts'
import { MAX_RECURRING_OCCURRENCES } from './recurring-rules.ts'

export interface CancelBookingSeriesInput {
  scope: 'all' | 'following'
  fromOrdinal?: number | undefined
  expectedRevision: string
  idempotencyKey: string
  reason?: string | undefined
}

interface SeriesCancellationMember {
  id: string
  ordinal: number
  bookingId: string
  start: string
  end: string
  status: 'confirmed' | 'cancelled'
}

export interface CancelBookingSeriesResult {
  seriesId: string
  revision: string
  replayed: boolean
  affected: SeriesCancellationMember[]
  unchanged: SeriesCancellationMember[]
}

type Authority =
  | { kind: 'host'; ctx: ServiceContext; seriesId: string }
  | { kind: 'booker'; token: string }

const seriesNotFound = () => new DomainError('not_found', 'series_not_found', 'No such series')
const invalidScope = () =>
  new DomainError('invalid', 'invalid_series_scope', 'Select all or a valid following ordinal')

/** Cancels upcoming occurrences of a series hosted by the authenticated caller. */
export async function cancelHostBookingSeries(
  ctx: ServiceContext,
  seriesId: string,
  input: CancelBookingSeriesInput,
  origin?: BookingOrigin,
): Promise<CancelBookingSeriesResult> {
  if (!isUuid(seriesId)) throw seriesNotFound()
  const { principal } = ctx
  return cancelBookingSeries(ctx, { kind: 'host', ctx, seriesId }, input, {
    ...(origin ?? {
      source: principal.kind === 'api_key' ? 'api' : principal.kind === 'oauth' ? 'mcp' : 'web',
      apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
      oauthConsentId: principal.kind === 'oauth' ? principal.oauthConsentId : null,
    }),
    audit: auditActor(principal),
    actorUserId: principal.user.id,
    requestId: ctx.requestId,
  })
}

/** Cancels upcoming occurrences through the primary booker's series capability. */
export function cancelManagedBookingSeries(
  ctx: PublicContext,
  seriesManageToken: string,
  input: CancelBookingSeriesInput,
  origin: BookingOrigin = { source: 'web', apiKeyId: null },
): Promise<CancelBookingSeriesResult> {
  return cancelBookingSeries(ctx, { kind: 'booker', token: seriesManageToken }, input, origin)
}

/** Under the series lock the leaf of each chain stays current until we commit. */
function lockCurrentMembers(trx: Db, organizationId: string, seriesId: string) {
  return trx
    .selectFrom('booking_series_occurrences as o')
    .innerJoin('bookings as b', (join) =>
      join
        .onRef('b.organization_id', '=', 'o.organization_id')
        .onRef('b.series_occurrence_id', '=', 'o.id'),
    )
    .select([
      'o.id as occurrence_id',
      'o.ordinal',
      'b.id',
      'b.organization_id',
      'b.start_at',
      'b.end_at',
      'b.status',
    ])
    .where('o.organization_id', '=', organizationId)
    .where('o.series_id', '=', seriesId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('bookings as successor')
            .select('successor.id')
            .whereRef('successor.rescheduled_from_id', '=', 'b.id')
            .whereRef('successor.organization_id', '=', 'o.organization_id')
            .whereRef('successor.series_occurrence_id', '=', 'o.id'),
        ),
      ),
    )
    .orderBy('o.ordinal')
    .forUpdate('b')
    .execute()
}

type CurrentMember = Awaited<ReturnType<typeof lockCurrentMembers>>[number]

function cancellationResult(
  seriesId: string,
  revision: string,
  replayed: boolean,
  visible: CurrentMember[],
  affectedIds: string[],
): CancelBookingSeriesResult {
  const affected = new Set(affectedIds)
  const result: CancelBookingSeriesResult = {
    seriesId,
    revision,
    replayed,
    affected: [],
    unchanged: [],
  }
  for (const member of visible) {
    const cancelledHere = affected.has(member.id)
    const list = cancelledHere ? result.affected : result.unchanged
    list.push({
      id: member.occurrence_id,
      ordinal: member.ordinal,
      bookingId: member.id,
      start: timestamp(member.start_at),
      end: timestamp(member.end_at),
      status: cancelledHere || member.status === 'cancelled' ? 'cancelled' : 'confirmed',
    })
  }
  return result
}

async function hostedBookingIds(
  trx: Db,
  organizationId: string,
  userId: string,
  bookingIds: string[],
) {
  const hosts = await trx
    .selectFrom('booking_hosts as h')
    .innerJoin('auth.member as m', (join) =>
      join.onRef('m.userId', '=', 'h.user_id').on('m.organizationId', '=', organizationId),
    )
    .select('h.booking_id')
    .where('h.user_id', '=', userId)
    .where('h.booking_id', 'in', bookingIds)
    .$narrowType<{ booking_id: string }>()
    .execute()
  return hosts.map(({ booking_id }) => booking_id)
}

async function cancelBookingSeries(
  ctx: PublicContext,
  authority: Authority,
  input: CancelBookingSeriesInput,
  origin: BookingOrigin,
): Promise<CancelBookingSeriesResult> {
  const { scope, fromOrdinal, expectedRevision, idempotencyKey } = input
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey))
    throw new DomainError('invalid', 'invalid_idempotency_key', 'Invalid Idempotency-Key')
  let firstOrdinal = 1
  if (scope === 'following') {
    if (
      fromOrdinal === undefined ||
      !Number.isInteger(fromOrdinal) ||
      fromOrdinal < 1 ||
      fromOrdinal > MAX_RECURRING_OCCURRENCES
    )
      throw invalidScope()
    firstOrdinal = fromOrdinal
  } else if (scope !== 'all' || fromOrdinal !== undefined) {
    throw invalidScope()
  }
  const reason = normalizeReason(input.reason)
  const requestKey = sha256(idempotencyKey)

  return ctx.db.transaction().execute(async (trx) => {
    const target =
      authority.kind === 'host'
        ? {
            seriesId: authority.seriesId.toLowerCase(),
            organizationId: authority.ctx.principal.organization.id,
          }
        : await resolveSeriesCapability(trx, authority.token, { scope: 'manage' })
    if (!target) throw seriesNotFound()
    const { seriesId, organizationId } = target
    if (authority.kind === 'host')
      await authority.ctx.authorizeOrganizationWrite?.(trx, organizationId)

    const organization = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', organizationId)
      .forKeyShare()
      .executeTakeFirst()
    if (!organization) throw seriesNotFound()
    const series = await trx
      .selectFrom('booking_series')
      .select(['revision', 'requested_count'])
      .where('id', '=', seriesId)
      .where('organization_id', '=', organizationId)
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (!series) throw seriesNotFound()
    const members = await lockCurrentMembers(trx, organizationId, seriesId)
    if (!members.length) throw seriesNotFound()
    const bookingIds = members.map(({ id }) => id)
    const visibleIds = new Set(
      authority.kind === 'host'
        ? await hostedBookingIds(trx, organizationId, authority.ctx.principal.user.id, bookingIds)
        : await resolveSeriesBookerBookingIds(
            trx,
            authority.token,
            organizationId,
            seriesId,
            bookingIds,
          ),
    )
    const visible = members.filter(({ id }) => visibleIds.has(id))
    if (!visible.length) throw seriesNotFound()
    if (firstOrdinal > series.requested_count) throw invalidScope()
    const assertVisible = (ids: string[]) => {
      if (ids.some((id) => !visibleIds.has(id))) throw seriesNotFound()
    }

    const authorityScope = sha256(
      canonicalJson(['booking-series', ...cancellationAuthorityScope(authority, origin)]),
    )
    const fingerprint = sha256(
      canonicalJson({ seriesId, scope, fromOrdinal, expectedRevision, reason }),
    )
    const receiptKey = {
      organization_id: organizationId,
      authority_scope: authorityScope,
      operation_kind: 'bulk_cancel',
      idempotency_key: requestKey,
    } as const
    const replay = async () => {
      const receipt = await trx
        .selectFrom('booking_series_receipts')
        .select(['fingerprint', 'result_booking_ids'])
        .where((eb) => eb.and(receiptKey))
        .executeTakeFirst()
      if (!receipt) return undefined
      if (!receipt.fingerprint.equals(fingerprint))
        throw new DomainError(
          'conflict',
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request',
        )
      assertVisible(receipt.result_booking_ids)
      return cancellationResult(
        seriesId,
        series.revision,
        true,
        visible,
        receipt.result_booking_ids,
      )
    }
    const committed = await replay()
    if (committed) return committed

    const now = ctx.now()
    const affected = members.filter(
      (member) =>
        member.ordinal >= firstOrdinal &&
        member.status === 'confirmed' &&
        Temporal.Instant.compare(toInstant(member.start_at), now) > 0,
    )
    const affectedIds = affected.map(({ id }) => id)
    assertVisible(affectedIds)
    assertSeriesRevision(expectedRevision, series.revision)
    const receipt = await trx
      .insertInto('booking_series_receipts')
      .values({
        ...receiptKey,
        series_id: seriesId,
        fingerprint,
        affected_occurrence_ids: affected.map(({ occurrence_id }) => occurrence_id),
        result_booking_ids: affectedIds,
      })
      .onConflict((oc) => oc.constraint('booking_series_receipts_replay_key').doNothing())
      .returning('id')
      .executeTakeFirst()
    // The series lock serializes same-series calls. This conflict covers another
    // request by the same authority using the key on a different series.
    if (!receipt) {
      const winner = await replay()
      if (!winner) throw new Error('Missing bulk cancellation receipt after conflict')
      return winner
    }

    for (const member of affected) {
      await cancelSeriesMemberInTransaction(trx, member, now, {
        reason,
        notify: ctx.notify,
        origin,
        actorUserId: origin.actorUserId ?? null,
        asInvitee: authority.kind === 'booker',
      })
    }
    const { revision } = await trx
      .updateTable('booking_series')
      .set({ revision: sql`revision + 1` })
      .where('organization_id', '=', organizationId)
      .where('id', '=', seriesId)
      .returning('revision')
      .executeTakeFirstOrThrow()
    if (affected.length) {
      await trx
        .insertInto('booking_series_notifications')
        .values({
          // The delivery worker can find this action's affected occurrences by ID
          // even after another action advances the revision or a retry changes due_at.
          id: receipt.id,
          organization_id: organizationId,
          series_id: seriesId,
          row_type: 'outbox',
          kind: 'cancellation',
          sequence: revision,
          due_at: now.toString(),
          attempts: 0,
          outbox_state: 'pending',
        })
        .execute()
    }
    return cancellationResult(seriesId, revision, false, visible, affectedIds)
  })
}

function cancellationAuthorityScope(
  authority: Authority,
  origin: BookingOrigin,
): readonly string[] {
  if (authority.kind === 'host') {
    const principal = authority.ctx.principal
    if (principal.kind === 'oauth') return ['host', 'oauth', principal.oauthConsentId]
    if (principal.kind === 'api_key') return ['host', 'api_key', principal.apiKeyId]
    return ['host', 'session', principal.user.id]
  }
  if (origin.oauthConsentId) return ['booker', 'oauth', origin.oauthConsentId]
  if (origin.apiKeyId) return ['booker', 'api_key', origin.apiKeyId]
  return ['booker', 'anonymous']
}
