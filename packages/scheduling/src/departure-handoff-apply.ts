import { createHash } from 'node:crypto'
import {
  checkTeamManagementAccess,
  lockSharedTeamSsoProof,
  ssoHardOff,
  TeamManagementError,
  type TeamSsoCapabilities,
  teamSession,
  withScimResources,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import {
  checkTeamWriteDeadline,
  recordTeamWriteOrganizationLock,
  teamWriteTransaction,
} from '@hourmere/db/team-write'
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
  lockOffer(trx: Transaction<Database>, key: HandoffKey): Promise<DepartureHandoffOffer | undefined>
  commitHandoff(
    trx: Transaction<Database>,
    key: HandoffKey,
    evidence: {
      version: number
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

interface ApplyInput {
  teamId: string
  expectedOrganizationId: string
  bookingId: string
  offerId: string
  version: number
}

interface ApplyContext extends ServiceContext {
  notify: BookingNotifier
  /** Only the session advisory lock. Team row locks belong to the apply transaction. */
  lockOrganizationContext?: (trx: Db) => Promise<void>
}

const bookingNotFound = () => new DomainError('not_found', 'booking_not_found', 'No such booking')
const offerNotFound = () => new DomainError('not_found', 'handoff_offer_not_found')
const offerChanged = () => new DomainError('conflict', 'handoff_offer_changed')
const ssoRequired = (): never => {
  throw new DomainError('forbidden', 'sso_required')
}

function rethrowTeamManagementError(error: unknown): never {
  if (!(error instanceof TeamManagementError)) throw error
  throw new DomainError(
    error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
    error.code,
  )
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
  offer: DepartureHandoffOffer,
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

async function readTerms(
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
  const { termsDigest, recipientKeys } = await readTerms(
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
  if (ctx.principal.kind !== 'session')
    throw new DomainError('forbidden', 'team_management_access_denied')
  const capabilities = withScimResources(
    ssoCapabilities,
    ctx.scimResourcesEnabled || ctx.principal.scimResourcesEnabled,
  )
  const principal = capabilities.scimResourcesEnabled
    ? { ...ctx.principal, scimResourcesEnabled: true as const }
    : ctx.principal

  return teamWriteTransaction(
    ctx.db.transaction().setIsolationLevel('read committed'),
    async (trx) => {
      await ctx.lockOrganizationContext?.(trx)
      const actor = await checkTeamManagementAccess(trx, principal, input.teamId, 'share', {
        expectedOrganizationId: input.expectedOrganizationId,
        allowPersonal: false,
      }).catch(rethrowTeamManagementError)
      recordTeamWriteOrganizationLock(trx, actor.organizationId)
      const deadline = await lockSharedTeamSsoProof(
        trx,
        capabilities,
        { userId: principal.user.id, sessionId: principal.sessionId },
        actor.organizationId,
        ssoRequired,
      )

      if (!isUuid(input.bookingId)) throw bookingNotFound()
      const source = await trx
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', input.bookingId)
        .where('organization_id', '=', actor.organizationId)
        .forUpdate()
        .executeTakeFirst()
      if (!source) throw bookingNotFound()
      if (!isUuid(input.offerId)) throw offerNotFound()
      const key = {
        organizationId: actor.organizationId,
        sourceBookingId: source.id,
        offerId: input.offerId.toLowerCase(),
      }
      const offer = await store.lockOffer(trx, key)
      if (!offer) throw offerNotFound()
      if (
        !Number.isSafeInteger(input.version) ||
        input.version < 1 ||
        offer.version !== input.version
      )
        throw offerChanged()
      if (offer.committed) {
        await checkTeamWriteDeadline(trx, deadline, ssoRequired)
        await teamSession(trx, principal, false).catch(rethrowTeamManagementError)
        return {
          sourceBookingId: source.id,
          replacementBookingId: offer.committed.replacementBookingId,
        }
      }
      if (offer.state !== 'live') throw offerChanged()

      const writeContext = {
        ...ctx,
        db: trx,
        principal,
        scimResourcesEnabled: capabilities.scimResourcesEnabled,
      }
      const eligibilityInput = { bookingId: source.id, departingUserId: offer.departingUserId }
      const preliminary = await getDepartureHandoffEligibility(
        writeContext,
        actor.organizationId,
        eligibilityInput,
      )
      await lockHosts(trx, [offer.departingUserId.toLowerCase(), preliminary.candidateUserId])
      const eligible = await getDepartureHandoffEligibility(
        writeContext,
        actor.organizationId,
        eligibilityInput,
        ctx.now(),
        true,
      )
      const { event, candidateUserId } = eligible
      if (candidateUserId !== preliminary.candidateUserId || event.id !== preliminary.event.id)
        throw offerChanged()

      const terms = await readTerms(
        writeContext,
        actor.organizationId,
        { bookingId: source.id, ...offer },
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
      await cancelTeamBookingInTransaction(trx, actor, source.id, () => now, {
        notify: ctx.notify,
        sessionId: principal.sessionId,
        seriesOccurrenceId: null,
        meetingPollLinked: false,
      })
      await requireOfferedSlot(trx, {
        eventTypeId: event.id,
        hostUserId: candidateUserId,
        start: terms.start,
        end: terms.end,
        now,
        durationMinutes: terms.duration,
        excludeBookingId: source.id,
      })
      const { id } = await insertBooking(trx, {
        organizationId: actor.organizationId,
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
      await auditBooking(trx, actor.organizationId, id, 'booking.created', {
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
        version: offer.version,
        applyingUserId: actor.userId,
        appliedAt: now.toString(),
        recipientIds,
        replacementBookingId: id,
      })
      assertOfferLive(offer, eligible.source.start, terms.start, ctx.now())
      await checkTeamWriteDeadline(trx, deadline, ssoRequired)
      await teamSession(trx, principal, false).catch(rethrowTeamManagementError)
      return { sourceBookingId: source.id, replacementBookingId: id }
    },
  )
}
