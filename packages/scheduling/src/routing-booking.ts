import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import { findOneTimeEventType } from './availability.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { resolvedBookingHosts } from './hosts.ts'
import { isUuid, jsonb } from './internal.ts'
import { InvalidStoredQuestionsError } from './questions.ts'
import type { RoutingContinuationContext } from './routing-continuation.ts'
import type { RoutingAnswers, RoutingQuestion } from './routing-form-config.ts'
import { loadRoutingTargetEvents, routingTargetProblem } from './routing-form-targets.ts'
import {
  isRoutingReceiptToken,
  routingReceiptCheckedAt,
  validateRoutingReceiptSnapshot,
} from './routing-receipt.ts'
import { openRoutingAnswers, routingTokenDigest } from './routing-receipt-crypto.ts'

export interface RoutingBookingSnapshot {
  formId: string
  versionId: string
  versionNumber: number
  matchedRuleId: string
  resolvedRuleId: string
  questions: RoutingQuestion[]
  answers: RoutingAnswers
}

type RoutingBookingRead =
  | { access: 'host'; routing: RoutingBookingSnapshot | null }
  | { access: 'team_admin'; routing: RoutingBookingSnapshot }

/** Read provenance and current authorization from the same database snapshot. */
export async function readBookingRoutingSnapshot(
  { db, principal }: ServiceContext,
  bookingId: string,
  allowTeamAdmin: boolean,
): Promise<RoutingBookingRead | undefined> {
  const { id: userId } = principal.user
  const { id: organizationId } = principal.organization
  const row = await db
    .selectFrom('auth.member as member')
    .innerJoin('auth.user as actor', 'actor.id', 'member.userId')
    .leftJoin(resolvedBookingHosts(db).as('host'), (join) =>
      join.on('host.booking_id', '=', bookingId).onRef('host.user_id', '=', 'member.userId'),
    )
    .leftJoin('booking_routing as routing', (join) =>
      join
        .on('routing.booking_id', '=', bookingId)
        .onRef('routing.organization_id', '=', 'member.organizationId'),
    )
    .select([
      'host.user_id as hostId',
      'routing.form_id as formId',
      'routing.version_id as versionId',
      'routing.version_number as versionNumber',
      'routing.matched_rule_id as matchedRuleId',
      'routing.resolved_rule_id as resolvedRuleId',
      'routing.questions',
      'routing.answers',
    ])
    .where('member.organizationId', '=', organizationId)
    .where('member.userId', '=', userId)
    .where('actor.emailVerified', '=', true)
    .where((eb) => eb.not(scimSuspended(organizationId, userId)))
    .where((eb) => {
      const host = eb('host.user_id', 'is not', null)
      if (principal.kind !== 'session') return host
      const session = eb
        .selectFrom('auth.session as session')
        .select('session.id')
        .where('session.id', '=', principal.sessionId)
        .whereRef('session.userId', '=', 'member.userId')
        .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
      const activeOrganization = sql<string>`lower(${sql.ref('session.activeOrganizationId')})`
      if (principal.organization.personal) {
        // Session resolution falls back to personal space when there is no effective active team.
        return eb.and([
          host,
          eb.exists(
            session.where((eb) =>
              eb.or([
                eb(activeOrganization, '=', organizationId.toLowerCase()),
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('auth.member as active')
                      .select('active.userId')
                      .whereRef('active.userId', '=', 'session.userId')
                      .where((eb) =>
                        eb(
                          sql<string>`${eb.ref('active.organizationId')}::text`,
                          '=',
                          activeOrganization,
                        ),
                      )
                      .where((eb) =>
                        eb.not(scimSuspended(eb.ref('active.organizationId'), userId)),
                      ),
                  ),
                ),
              ]),
            ),
          ),
        ])
      }
      const activeTeamSession = eb.exists(
        session.where(activeOrganization, '=', organizationId.toLowerCase()),
      )
      if (!allowTeamAdmin) return eb.and([activeTeamSession, host])
      const personal = eb.exists(
        eb
          .selectFrom('personal_organizations')
          .select('organization_id')
          .whereRef('organization_id', '=', 'member.organizationId'),
      )
      // Better Auth stores exact role tokens in a comma-separated string.
      const teamAdmin = sql<boolean>`${eb.ref('member.role')} ~ '(^|,)[[:space:]]*(owner|admin)[[:space:]]*(,|$)'`
      return eb.and([
        activeTeamSession,
        eb.or([
          host,
          eb.and([eb('routing.booking_id', 'is not', null), teamAdmin, eb.not(personal)]),
        ]),
      ])
    })
    .executeTakeFirst()
  if (!row) return undefined
  const { hostId, ...snapshot } = row
  // Both JSON fields were validated when the immutable snapshot was written.
  const routing = snapshot.formId === null ? null : (snapshot as RoutingBookingSnapshot)
  if (hostId !== null) return { access: 'host', routing }
  if (routing) return { access: 'team_admin', routing }
}

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
