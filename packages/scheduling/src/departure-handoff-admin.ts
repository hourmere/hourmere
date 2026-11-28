import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import type { Db, JsonValue } from '@hourmere/db'
import { sql } from 'kysely'
import { parseLocation } from './availability.ts'
import { automaticConference, bookingConferenceViews, conferenceRoot } from './conferences.ts'
import type { ServiceContext } from './context.ts'
import {
  type DepartureHandoffApplyStore,
  type DepartureHandoffOffer,
  departureHandoffApprovedRecipientIds,
  departureHandoffDeadline,
  getDepartureHandoffTerms,
} from './departure-handoff-apply.ts'
import {
  previewDepartureHandoffSlot,
  withDepartureHandoffRead,
} from './departure-handoff-preview.ts'
import { DomainError } from './errors.ts'
import { readTeamsMeetingLocations } from './teams-meeting-locations.ts'

export { applyDepartureHandoff } from './departure-handoff-apply.ts'

/** The admin read and apply use the same versioned offer and committed edge. */
export interface DepartureHandoffAdminStore extends DepartureHandoffApplyStore {
  /** Use the caller's authorized repeatable-read preview snapshot. */
  readLatest(
    db: Db,
    key: { organizationId: string; sourceBookingId: string },
  ): Promise<({ id: string } & DepartureHandoffOffer) | undefined>
}

export const HANDOFF_PREVIEW_ISSUES = [
  'calendar_sync_unavailable',
  'location_unavailable',
  'handoff_offer_changed',
  'handoff_source_ineligible',
  'handoff_candidate_ineligible',
] as const
type HandoffIssue = (typeof HANDOFF_PREVIEW_ISSUES)[number]
interface LiveOfferPreview {
  id: string
  version: number
  expiresAt: string
  state: 'unverified' | 'pending' | 'ready'
  outstandingApprovals?: number
}

/** Translate saved-term and provider eligibility errors at the handoff boundary. */
export function departureHandoffIssue(error: unknown): HandoffIssue | undefined {
  if (!(error instanceof DomainError)) return undefined
  if (error.code === 'invalid_duration') return 'handoff_offer_changed'
  if (
    error.code === 'invalid_location_choice' ||
    error.code.startsWith('automatic_meet_') ||
    error.code.startsWith('automatic_zoom_')
  )
    return 'location_unavailable'
  return HANDOFF_PREVIEW_ISSUES.find((code) => code === error.code)
}

const noPreview = { preview: null, receipt: null }
const empty = { ...noPreview, offer: null }

export function readDepartureHandoffAdminPreview(
  ctx: ServiceContext,
  input: { teamId: string; expectedOrganizationId: string; bookingId: string },
  store: DepartureHandoffAdminStore,
  capabilities: TeamSsoCapabilities = ssoHardOff,
  mailDeliveryAvailable = true,
) {
  return withDepartureHandoffRead(
    ctx,
    input.teamId,
    input.expectedOrganizationId,
    capabilities,
    async (read, organizationId, now) => {
      const { db } = read
      const source = await db
        .selectFrom('bookings')
        .select(['id', 'start_at', 'location', 'required_host_user_ids'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.bookingId)
        .executeTakeFirst()
      if (!source) throw new DomainError('not_found', 'booking_not_found')
      const saved = await store.readLatest(db, { organizationId, sourceBookingId: source.id })
      if (saved?.committed) {
        return {
          ...empty,
          receipt: await committedReceipt(
            db,
            organizationId,
            source,
            saved.committed,
            now,
            mailDeliveryAvailable,
          ),
        }
      }

      const departingUserId = source.required_host_user_ids[0]
      if (!source.start_at || !departingUserId || source.required_host_user_ids.length !== 1)
        return { ...empty, issue: 'handoff_source_ineligible' as const }
      const start = saved ? Temporal.Instant.from(saved.start) : undefined
      const offer = saved &&
        start && {
          id: saved.id,
          version: saved.version,
          expiresAt: departureHandoffDeadline(
            saved,
            Temporal.Instant.from(source.start_at.toISOString()),
            start,
          ).toString(),
        }
      if (offer && saved.state !== 'live')
        return { ...noPreview, offer: { ...offer, state: 'closed' as const } }
      if (offer && Temporal.Instant.compare(now, offer.expiresAt) >= 0)
        return { ...noPreview, offer: { ...offer, state: 'expired' as const } }

      let consent: LiveOfferPreview | null = offer ? { ...offer, state: 'unverified' } : null
      try {
        const proposed = {
          bookingId: source.id,
          departingUserId: saved?.departingUserId ?? departingUserId,
          ...(start && { start }),
          ...(saved && { durationMinutes: saved.durationMinutes }),
          ...(saved?.locationOptionId && { locationOptionId: saved.locationOptionId }),
        }
        if (saved && offer) {
          const terms = await getDepartureHandoffTerms(read, organizationId, {
            ...proposed,
            start: saved.start,
            durationMinutes: saved.durationMinutes,
          })
          if (
            terms.termsDigest !== saved.termsDigest ||
            Temporal.Instant.compare(now, saved.issuedAt) < 0
          )
            return { ...noPreview, offer: consent, issue: 'handoff_offer_changed' as const }
          const approved = departureHandoffApprovedRecipientIds(saved, terms.recipientKeys, now)
          const outstandingApprovals = terms.recipientKeys.length - approved.length
          consent = {
            ...offer,
            state: outstandingApprovals ? 'pending' : 'ready',
            outstandingApprovals,
          }
        }
        const slot = await previewDepartureHandoffSlot(read, organizationId, proposed, now)
        const { name: candidateName } = await db
          .selectFrom('auth.user')
          .select('name')
          .where('id', '=', slot.candidateUserId)
          .executeTakeFirstOrThrow()

        return {
          offer: consent,
          preview: {
            candidateName,
            start: slot.start,
            end: slot.end,
            evaluatedAt: slot.evaluatedAt,
            locationKind: slot.locationKind,
            availability: slot.availability,
          },
          receipt: null,
        }
      } catch (error) {
        const issue = departureHandoffIssue(error)
        if (!issue) throw error
        return { ...noPreview, offer: consent, issue }
      }
    },
  )
}

type ConferenceState = 'pending' | 'ready' | 'failed' | 'not_required' | 'unknown'
type CleanupState = 'pending' | 'complete' | 'unresolved'
export const HANDOFF_MAIL_STATES = ['pending', 'accepted', 'incomplete', 'unavailable'] as const
type MailState = (typeof HANDOFF_MAIL_STATES)[number]

async function committedReceipt(
  db: Db,
  organizationId: string,
  source: { id: string; location: JsonValue },
  committed: { replacementBookingId: string },
  now: Temporal.Instant,
  mailDeliveryAvailable: boolean,
) {
  // Scope the edge's destination as well as its source, even if the backing store
  // already enforces same-team foreign keys. Project status, never provider identifiers.
  const replacement = await db
    .selectFrom('bookings')
    .select(['id', 'location', 'status', 'start_at'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', committed.replacementBookingId)
    .where('rescheduled_from_id', 'is', null)
    .executeTakeFirst()
  if (!replacement) throw new DomainError('not_found', 'handoff_offer_not_found')

  const views = await bookingConferenceViews(db, [source.id, replacement.id])
  const oldStatus = views.get(source.id)?.conference?.status
  const oldConferenceCleanup = await readCleanupState(db, source, oldStatus)
  return {
    sourceBookingId: source.id,
    replacementBookingId: replacement.id,
    conference: await readNewConferenceState(
      db,
      replacement,
      views.get(replacement.id)?.conference?.status,
    ),
    ...(oldConferenceCleanup && { oldConferenceCleanup }),
    mail: await readHandoffMailState(db, source.id, replacement, now, mailDeliveryAvailable),
  }
}

async function readHandoffMailState(
  db: Db,
  sourceId: string,
  replacement: { id: string; status: string; start_at: Date | null },
  now: Temporal.Instant,
  mailDeliveryAvailable: boolean,
) {
  const receipts = await db
    .selectFrom('booking_attendees as a')
    .leftJoin('booking_notifications as n', (join) =>
      join
        .onRef('n.booking_id', '=', 'a.booking_id')
        .on('n.message_key', '=', '')
        .on('n.recipient', '=', sql<string>`'attendee:' || a.id`)
        .on(
          'n.kind',
          '=',
          sql<string>`CASE WHEN a.booking_id = ${sourceId} THEN 'cancelled' ELSE 'confirmed' END`,
        ),
    )
    .select(['a.booking_id', 'n.outcome'])
    .where('a.booking_id', 'in', [sourceId, replacement.id])
    .execute()
  const outbox = await db
    .selectFrom('booking_conference_notifications')
    .select(['exhausted_at', 'skipped_at'])
    .where('booking_id', '=', replacement.id)
    .where('kind', '=', 'confirmed')
    .executeTakeFirst()
  function state(bookingId: string, closed = false): MailState {
    const outcomes = receipts
      .filter((row) => row.booking_id === bookingId)
      .map((row) => row.outcome)
    if (outcomes.length > 0 && outcomes.every((outcome) => outcome === 'sent')) return 'accepted'
    if (closed || !outcomes.length || outcomes.some((outcome) => outcome && outcome !== 'sent'))
      return 'incomplete'
    return mailDeliveryAvailable ? 'pending' : 'unavailable'
  }
  const confirmationClosed =
    replacement.status !== 'confirmed' ||
    replacement.start_at === null ||
    replacement.start_at.getTime() <= now.epochMilliseconds ||
    Boolean(outbox?.exhausted_at || outbox?.skipped_at)
  return {
    cancellation: state(sourceId),
    confirmation: state(replacement.id, confirmationClosed),
  }
}

async function readNewConferenceState(
  db: Db,
  replacement: { id: string; location: JsonValue; status: string },
  status?: 'pending' | 'ready' | 'failed',
): Promise<ConferenceState> {
  if (replacement.status !== 'confirmed') return 'unknown'
  if (status) return status
  const location = parseLocation(replacement.location)
  if (location?.kind === 'microsoft_teams') {
    const teams = (await readTeamsMeetingLocations(db, [replacement])).get(replacement.id)
    if (teams?.status === 'ready') return 'ready'
    if (teams?.status === 'join_url_pending') {
      const target = await db
        .selectFrom('booking_calendar_targets')
        .select('root_booking_id')
        .where('root_booking_id', '=', replacement.id)
        .where('microsoft_writeback', 'is not', null)
        .executeTakeFirst()
      // An admitted Teams root has a target at commit. A disconnect can remove it.
      return target ? 'pending' : 'failed'
    }
    return teams ? 'failed' : 'unknown'
  }
  return automaticConference(location) ? 'unknown' : 'not_required'
}

async function readCleanupState(
  db: Db,
  source: { id: string; location: JsonValue },
  status?: 'pending' | 'ready' | 'failed',
): Promise<CleanupState | undefined> {
  if (status === 'failed') return 'unresolved'
  const microsoft = parseLocation(source.location)?.kind === 'microsoft_teams'
  const root = await conferenceRoot(db, source.id)
  if (!root) return 'unresolved'

  const pinned = await db
    .selectFrom('departure_handoff_calendar_cleanup as cleanup')
    .leftJoin('calendars as calendar', (join) =>
      join
        .onRef('calendar.id', '=', 'cleanup.calendar_id')
        .onRef('calendar.connection_id', '=', 'cleanup.connection_id'),
    )
    .select(['cleanup.status', 'cleanup.provider', 'calendar.id as connected'])
    .where('cleanup.source_booking_id', '=', source.id)
    .execute()
  const copyStates = pinned.map(({ status, connected }) =>
    connected || status === 'complete' ? status : 'unresolved',
  )
  if (!pinned.some(({ provider }) => provider === 'microsoft')) {
    // Older staged receipts predate destination snapshots.
    const outlook = await db
      .selectFrom('booking_calendar_targets')
      .select([
        sql<string | null>`microsoft_writeback->>'status'`.as('status'),
        sql<boolean>`microsoft_writeback->>'revision' LIKE '%:false'`.as('cleanup'),
      ])
      .where('root_booking_id', '=', root)
      .where('microsoft_writeback', 'is not', null)
      .executeTakeFirst()
    if (outlook)
      copyStates.push(
        outlook.cleanup && outlook.status === 'succeeded'
          ? 'complete'
          : outlook.cleanup && outlook.status === 'failed'
            ? 'unresolved'
            : 'pending',
      )
    else if (microsoft) copyStates.push('unresolved')
  }
  if (status) {
    const mirrors = await db
      .selectFrom('booking_conference_mirrors')
      .select('state')
      .where('root_booking_id', '=', root)
      .where('calendar_id', 'is not', null)
      .execute()
    if (mirrors.some(({ state }) => state === 'failed')) return 'unresolved'
    if (mirrors.some(({ state }) => state === 'pending')) copyStates.push('pending')
  }
  if (copyStates.includes('unresolved')) return 'unresolved'
  if (status === 'pending' || copyStates.includes('pending')) return 'pending'
  if (status === 'ready' || copyStates.length) return 'complete'
  return automaticConference(parseLocation(source.location)) ? 'unresolved' : undefined
}
