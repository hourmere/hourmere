import { createHash } from 'node:crypto'
import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import type { Database } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import type { Transaction } from 'kysely'
import { selectDurationMinutes } from './availability.ts'
import {
  auditBooking,
  cancelTeamBookingInTransaction,
  canonicalJson,
  insertBooking,
  lockHosts,
  requireOfferedSlot,
  resolveBookingLocation,
} from './bookings.ts'
import { cutoffsOf } from './change-deadlines.ts'
import { prepareBookingConference, unresolvedLocation } from './conferences.ts'
import type { BookingNotifier, ServiceContext } from './context.ts'
import {
  type DepartureHandoffSourceInput,
  type DepartureHandoffWriteContext,
  handoffOfferChanged as offerChanged,
  handoffOfferNotFound as offerNotFound,
  withDepartureHandoffWrite,
} from './departure-handoff-access.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { getDepartureHandoffLocation } from './departure-handoff-location.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { createNotificationSnapshot } from './notification-settings.ts'
import { validateResponses } from './questions.ts'
import { cleanInviteeEmail } from './text.ts'

interface HandoffKey {
  organizationId: string
  sourceBookingId: string
  offerId: string
  version: number
}

export interface DepartureHandoffOffer {
  version: number
  state: 'live' | 'closed'
  issuedAt: string
  expiresAt: string
  departingUserId: string
  start: string
  durationMinutes: number
  locationOptionId?: string
  termsDigest: string
  approvals: ReadonlyArray<{
    recipientId: string
    recipientKey: string
    version: number
    approvedAt: string
  }>
  committed?: { replacementBookingId: string }
}

/** Internal persistence boundary for the staged feature. Both operations use the supplied
 * transaction. The store locks the scoped offer and reads its current recipient decisions.
 * It must enforce unique source and replacement edges and persist the receipt and consent
 * references atomically. Mailbox keys identify decisions and stay in offer storage. */
export interface DepartureHandoffApplyStore {
  lockOffer(
    trx: Transaction<Database>,
    key: HandoffKey,
  ): Promise<DepartureHandoffOffer | 'version_mismatch' | undefined>
  commitHandoff(
    trx: Transaction<Database>,
    key: HandoffKey,
    evidence: {
      applyingUserId: string
      appliedAt: string
      recipientIds: string[]
      replacementBookingId: string
    },
  ): Promise<void>
}

interface TermsInput {
  bookingId: string
  departingUserId: string
  start: string
  durationMinutes: number
  locationOptionId?: string
}

interface ApplyInput extends DepartureHandoffSourceInput {
  offerId: string
  version: number
}

interface ApplyContext extends DepartureHandoffWriteContext {
  notify: BookingNotifier
}

function before(left: Temporal.Instant, right: Temporal.Instant): boolean {
  return Temporal.Instant.compare(left, right) < 0
}

function assertOfferLive(
  offer: DepartureHandoffOffer,
  sourceStart: Temporal.Instant,
  targetStart: Temporal.Instant,
  now: Temporal.Instant,
) {
  const issued = Temporal.Instant.from(offer.issuedAt)
  if (
    offer.state !== 'live' ||
    before(now, issued) ||
    !before(now, departureHandoffDeadline(offer, sourceStart, targetStart))
  )
    throw offerChanged()
}

export function departureHandoffDeadline(
  offer: Pick<DepartureHandoffOffer, 'issuedAt' | 'expiresAt'>,
  sourceStart: Temporal.Instant,
  targetStart: Temporal.Instant,
): Temporal.Instant {
  const issueLimit = Temporal.Instant.from(offer.issuedAt).add({ hours: 48 })
  return [sourceStart, targetStart, issueLimit].reduce(
    (deadline, limit) => (before(limit, deadline) ? limit : deadline),
    Temporal.Instant.from(offer.expiresAt),
  )
}

export function departureHandoffApprovedRecipientIds(
  offer: DepartureHandoffOffer,
  recipientKeys: readonly string[],
  now: Temporal.Instant,
) {
  const issued = Temporal.Instant.from(offer.issuedAt)
  const approved = new Map(
    offer.approvals
      .filter((approval) => {
        const at = Temporal.Instant.from(approval.approvedAt)
        return (
          isUuid(approval.recipientId) &&
          approval.version === offer.version &&
          !before(at, issued) &&
          !before(now, at)
        )
      })
      .map((approval) => [approval.recipientKey, approval.recipientId.toLowerCase()]),
  )
  return [...new Set(recipientKeys.flatMap((key) => approved.get(key) ?? []))]
}

export async function readDepartureHandoffTerms(
  ctx: ServiceContext,
  organizationId: string,
  input: TermsInput,
  eligible: Awaited<ReturnType<typeof getDepartureHandoffEligibility>>,
  lockMicrosoftDestination: boolean,
) {
  const { source, event, candidateUserId } = eligible
  const { db } = ctx
  const original = await db
    .selectFrom('bookings')
    .select(['title', 'responses', 'location'])
    .where('id', '=', source.id)
    .executeTakeFirstOrThrow()
  const rows = await db
    .selectFrom('booking_attendees')
    .select(['id', 'name', 'email', 'time_zone', 'locale', 'is_booker'])
    .where('booking_id', '=', source.id)
    .orderBy('id')
    .execute()

  const attendees = rows.map((row) => {
    const email = cleanInviteeEmail(row.email)
    if (!email) throw new DomainError('conflict', 'handoff_source_ineligible')
    return {
      name: row.name,
      email,
      timeZone: row.time_zone,
      locale: row.locale,
      isBooker: row.is_booker,
    }
  })
  const booker = attendees.find((attendee) => attendee.isBooker)
  if (!booker) throw new DomainError('conflict', 'handoff_source_ineligible')
  const recipientKeys = [
    ...new Set(attendees.map((attendee) => attendee.email.toLowerCase())),
  ].sort()
  const start = Temporal.Instant.from(input.start)
  const duration = selectDurationMinutes(event, input.durationMinutes)
  const end = start.add({ minutes: duration })
  const locationOptionId = input.locationOptionId ?? source.locationOptionId
  await getDepartureHandoffLocation(ctx, event, locationOptionId, source.savedInviteePhone)
  const { location, locationOption } = await resolveBookingLocation(
    ctx,
    db,
    event,
    [candidateUserId],
    {
      locationOptionId,
      inviteePhone: source.savedInviteePhone,
    },
    lockMicrosoftDestination,
  )
  const responses = validateResponses(event.questions, original.responses)
  const title = `${event.title} with ${booker.name}`
  const termsDigest = createHash('sha256')
    .update(
      canonicalJson({
        organizationId,
        eventTypeId: event.id,
        source: {
          id: source.id,
          title: original.title,
          hostUserId: input.departingUserId.toLowerCase(),
          start: source.start.toString(),
          end: source.end.toString(),
          location: unresolvedLocation(original.location),
        },
        target: {
          title,
          hostUserId: candidateUserId,
          hostTimeZone: event.hostTimeZone,
          start: start.toString(),
          end: end.toString(),
          location,
          locationOption,
        },
        attendees,
        questions: event.questions,
        responses,
      }),
    )
    .digest('hex')
  return {
    attendees,
    recipientKeys,
    start,
    end,
    duration,
    location,
    locationOption,
    responses,
    title,
    termsDigest,
  }
}

/** Shared by the future offer service and apply to bind approval to the same saved terms. */
export async function getDepartureHandoffTerms(
  ctx: ServiceContext,
  organizationId: string,
  input: TermsInput,
): Promise<{ termsDigest: string; recipientKeys: string[] }> {
  const eligible = await getDepartureHandoffEligibility(ctx, organizationId, input)
  const { termsDigest, recipientKeys } = await readDepartureHandoffTerms(
    ctx,
    organizationId,
    input,
    eligible,
    false,
  )
  return { termsDigest, recipientKeys }
}

/** Single-booking apply with an injected offer store. The notifier adds the ordinary
 * outbox work on this transaction. */
export async function applyDepartureHandoff(
  ctx: ApplyContext,
  input: ApplyInput,
  store: DepartureHandoffApplyStore,
  ssoCapabilities: TeamSsoCapabilities = ssoHardOff,
): Promise<{ sourceBookingId: string; replacementBookingId: string }> {
  return withDepartureHandoffWrite(
    ctx,
    input,
    ssoCapabilities,
    async (writeContext, source, actor) => {
      const { db: trx, principal } = writeContext
      if (!isUuid(input.offerId)) throw offerNotFound()
      const key = {
        ...source,
        offerId: input.offerId.toLowerCase(),
        version: input.version,
      }
      const offer = await store.lockOffer(trx, key)
      if (!offer) throw offerNotFound()
      if (offer === 'version_mismatch' || offer.version !== input.version) throw offerChanged()
      if (offer.committed) {
        return {
          sourceBookingId: source.sourceBookingId,
          replacementBookingId: offer.committed.replacementBookingId,
        }
      }
      if (offer.state !== 'live') throw offerChanged()

      const eligibilityInput = {
        bookingId: source.sourceBookingId,
        departingUserId: offer.departingUserId,
      }
      const preliminary = await getDepartureHandoffEligibility(
        writeContext,
        source.organizationId,
        eligibilityInput,
      )
      await lockHosts(trx, [offer.departingUserId.toLowerCase(), preliminary.candidateUserId])
      const eligible = await getDepartureHandoffEligibility(
        writeContext,
        source.organizationId,
        eligibilityInput,
        ctx.now(),
        true,
      )
      const { event, candidateUserId } = eligible
      if (candidateUserId !== preliminary.candidateUserId || event.id !== preliminary.event.id)
        throw offerChanged()

      const terms = await readDepartureHandoffTerms(
        writeContext,
        source.organizationId,
        { bookingId: source.sourceBookingId, ...offer },
        eligible,
        true,
      )
      const now = ctx.now()
      assertOfferLive(offer, eligible.source.start, terms.start, now)
      if (terms.termsDigest !== offer.termsDigest) throw offerChanged()
      const recipientIds = departureHandoffApprovedRecipientIds(offer, terms.recipientKeys, now)
      if (recipientIds.length !== terms.recipientKeys.length)
        throw new DomainError('conflict', 'handoff_consent_required')

      const policy = await trx
        .selectFrom('event_types')
        .select(['notifications', 'reschedule_cutoff_minutes', 'cancel_cutoff_minutes'])
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow()
      await cancelTeamBookingInTransaction(
        trx,
        { ...actor, organizationId: source.organizationId },
        source.sourceBookingId,
        () => now,
        {
          notify: ctx.notify,
          sessionId: actor.sessionId,
          seriesOccurrenceId: null,
          meetingPollLinked: false,
        },
      )
      await requireOfferedSlot(trx, {
        eventTypeId: event.id,
        hostUserId: candidateUserId,
        start: terms.start,
        end: terms.end,
        now,
        durationMinutes: terms.duration,
        excludeBookingId: source.sourceBookingId,
      })
      const { id } = await insertBooking(trx, {
        organizationId: source.organizationId,
        eventTypeId: event.id,
        start: terms.start,
        end: terms.end,
        title: terms.title,
        location: terms.location,
        locationOption: terms.locationOption,
        responses: terms.responses,
        source: 'web',
        apiKeyId: null,
        hostUserIds: [candidateUserId],
        hostsUseDefaultSchedule: false,
        attendees: terms.attendees,
        notificationSnapshot: createNotificationSnapshot(policy.notifications),
        changeCutoffs: cutoffsOf(policy),
      })
      await auditBooking(trx, source.organizationId, id, 'booking.created', {
        source: 'web',
        apiKeyId: null,
        audit: auditActor(principal),
        requestId: ctx.requestId,
      })
      await prepareBookingConference(ctx, trx, id)
      await ctx.notify(
        trx,
        {
          type: 'created',
          bookingId: id,
          start: terms.start,
          ...(terms.location?.kind === 'microsoft_teams' && { teamsMeeting: true }),
        },
        now,
      )
      await store.commitHandoff(trx, key, {
        applyingUserId: actor.userId,
        appliedAt: now.toString(),
        recipientIds,
        replacementBookingId: id,
      })
      assertOfferLive(offer, eligible.source.start, terms.start, ctx.now())
      return { sourceBookingId: source.sourceBookingId, replacementBookingId: id }
    },
  )
}
