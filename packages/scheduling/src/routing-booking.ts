import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { findOneTimeEventType } from './availability.ts'
import { DomainError } from './errors.ts'
import { isUuid, jsonb } from './internal.ts'
import { InvalidStoredQuestionsError } from './questions.ts'
import type { RoutingContinuationContext } from './routing-continuation.ts'
import { loadRoutingTargetEvents, routingTargetProblem } from './routing-form-targets.ts'
import {
  isRoutingReceiptToken,
  routingReceiptCheckedAt,
  validateRoutingReceiptSnapshot,
} from './routing-receipt.ts'
import { openRoutingAnswers, routingTokenDigest } from './routing-receipt-crypto.ts'

export const routedBookingUnavailable = () => new DomainError('conflict', 'routing_unavailable')

export function routingBookingTokenDigest(secret: string | undefined, token: string) {
  if (secret && isRoutingReceiptToken(token))
    return routingTokenDigest(secret, 'continuation', token)
}

export function findRoutingBookingReplayEvidence(
  db: Db,
  request: {
    fingerprint: Buffer
    key: string
    apiKeyId: string | null
    oauthConsentId?: string | null | undefined
  },
) {
  return db
    .selectFrom('booking_routing as r')
    .innerJoin('bookings as b', (join) =>
      join.onRef('b.id', '=', 'r.booking_id').onRef('b.organization_id', '=', 'r.organization_id'),
    )
    .select(['r.booking_id', 'r.organization_id'])
    .where('r.replay_fingerprint', '=', request.fingerprint)
    .where('b.idempotency_key', '=', request.key)
    .where('b.api_key_id', request.apiKeyId === null ? 'is' : '=', request.apiKeyId)
    .where(
      'b.oauth_consent_id',
      request.oauthConsentId == null ? 'is' : '=',
      request.oauthConsentId ?? null,
    )
    .executeTakeFirst()
}

/** A nonlocking lookup to discover the organization and hosts before taking booking locks. */
export async function findRoutingBookingReceipt(
  ctx: RoutingContinuationContext,
  tokenDigest: string,
) {
  const receipt = await ctx.db
    .selectFrom('routing_receipts as r')
    .innerJoin('routing_forms as f', (join) =>
      join.onRef('f.id', '=', 'r.form_id').onRef('f.organization_id', '=', 'r.organization_id'),
    )
    .select([
      'r.id as receiptId',
      'r.organization_id as organizationId',
      'r.form_id as formId',
      sql<string | null>`r.resolved_target ->> 'eventTypeId'`.as('eventTypeId'),
    ])
    .where('r.token_hash', '=', tokenDigest)
    .where('r.consumed_booking_id', 'is', null)
    .where('r.expires_at', '>', routingReceiptCheckedAt(ctx.receiptNow))
    .where('f.enabled', '=', true)
    .where('f.archived_at', 'is', null)
    .executeTakeFirst()
  if (!receipt?.eventTypeId || !isUuid(receipt.eventTypeId)) throw routedBookingUnavailable()
  return { ...receipt, eventTypeId: receipt.eventTypeId, tokenDigest }
}

type RoutingBookingReceipt = Awaited<ReturnType<typeof findRoutingBookingReceipt>>

export interface RoutingBookingClaim {
  receipt: RoutingBookingReceipt
  secret: string
  receiptNow: RoutingContinuationContext['receiptNow']
  replayFingerprint: Buffer | undefined
}

export async function findRoutingBookingEvent(
  db: Db,
  { eventTypeId, organizationId }: RoutingBookingReceipt,
  options?: { lock?: boolean },
) {
  try {
    const event = await findOneTimeEventType(db, eventTypeId, options)
    if (!event || event.organizationId !== organizationId) throw routedBookingUnavailable()
    // On the locked pass this allowlist reads the same event protected by the booking lock.
    const targets = await loadRoutingTargetEvents(db, [eventTypeId])
    if (routingTargetProblem(organizationId, targets.get(eventTypeId)))
      throw routedBookingUnavailable()
    return event
  } catch (error) {
    if (error instanceof InvalidStoredQuestionsError) throw routedBookingUnavailable()
    throw error
  }
}

/** After the ordinary organization, host and event locks, take the form then receipt. */
export async function lockRoutingBookingReceipt(db: Db, claim: RoutingBookingClaim) {
  const { receipt, secret, receiptNow } = claim
  const form = await db
    .selectFrom('routing_forms')
    .select('id')
    .where('id', '=', receipt.formId)
    .where('organization_id', '=', receipt.organizationId)
    .where('enabled', '=', true)
    .where('archived_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (!form) throw routedBookingUnavailable()

  const locked = await db
    .selectFrom('routing_receipts')
    .select('id')
    .where('id', '=', receipt.receiptId)
    .where('organization_id', '=', receipt.organizationId)
    .where('form_id', '=', receipt.formId)
    .where('token_hash', '=', receipt.tokenDigest)
    .where('consumed_booking_id', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!locked) throw routedBookingUnavailable()

  // Check expiry in a fresh statement after waiting for the locks.
  const row = await db
    .selectFrom('routing_receipts as r')
    .innerJoin('routing_form_versions as v', (join) =>
      join
        .onRef('v.id', '=', 'r.version_id')
        .onRef('v.form_id', '=', 'r.form_id')
        .onRef('v.organization_id', '=', 'r.organization_id'),
    )
    .select([
      'r.version_id as versionId',
      'r.resolved_target as resolvedTarget',
      'r.answers_ciphertext as ciphertext',
      'r.matched_rule_id as matchedRuleId',
      'r.resolved_rule_id as resolvedRuleId',
      'v.version_number as versionNumber',
      'v.questions',
    ])
    .where('r.id', '=', locked.id)
    .where('r.expires_at', '>', routingReceiptCheckedAt(receiptNow))
    .executeTakeFirst()
  if (!row) throw routedBookingUnavailable()
  const decrypted = openRoutingAnswers(
    secret,
    'continuation',
    { ...receipt, versionId: row.versionId },
    row.ciphertext,
  )
  if (decrypted === undefined) throw routedBookingUnavailable()
  const { sources, target, answers } = validateRoutingReceiptSnapshot(
    row.questions,
    row.resolvedTarget,
    decrypted,
  )
  if (target.eventTypeId !== receipt.eventTypeId) throw routedBookingUnavailable()

  return {
    receiptId: locked.id,
    snapshot: {
      organization_id: receipt.organizationId,
      form_id: receipt.formId,
      version_id: row.versionId,
      version_number: row.versionNumber,
      matched_rule_id: row.matchedRuleId,
      resolved_rule_id: row.resolvedRuleId,
      questions: jsonb(sources),
      answers: jsonb(answers),
      replay_fingerprint: claim.replayFingerprint ?? null,
    },
  }
}

export async function consumeRoutingBookingReceipt(
  db: Db,
  { receiptId, snapshot }: Awaited<ReturnType<typeof lockRoutingBookingReceipt>>,
  bookingId: string,
) {
  await db
    .updateTable('routing_receipts')
    .set({ consumed_booking_id: bookingId, answers_ciphertext: null })
    .where('id', '=', receiptId)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('booking_routing')
    .values({ ...snapshot, booking_id: bookingId })
    .execute()
}

/** Copy provenance within the move; the original booking keeps the receipt and replay. */
export async function copyBookingRoutingSnapshot(
  db: Db,
  previous: { id: string; organization_id: string },
  bookingId: string,
) {
  const attribution = [
    'organization_id',
    'form_id',
    'version_id',
    'version_number',
    'matched_rule_id',
    'resolved_rule_id',
    'questions',
    'answers',
  ] as const
  await db
    .insertInto('booking_routing')
    .columns(['booking_id', ...attribution])
    .expression((eb) =>
      eb
        .selectFrom('booking_routing')
        .select([sql<string>`${bookingId}::uuid`.as('booking_id'), ...attribution])
        .where('booking_id', '=', previous.id)
        .where('organization_id', '=', previous.organization_id),
    )
    .returning('booking_id')
    .executeTakeFirstOrThrow()
}
