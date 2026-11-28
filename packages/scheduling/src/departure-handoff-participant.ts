import type { Db } from '@hourmere/db'
import { type InferResult, sql } from 'kysely'
import { parseLocation } from './availability.ts'
import { lockHosts } from './bookings.ts'
import type { PublicContext } from './context.ts'
import { departureHandoffDeadline, readDepartureHandoffTerms } from './departure-handoff-apply.ts'
import {
  closeDepartureHandoffOffer,
  departureHandoffTokenDigest,
  lockDepartureHandoffSource,
} from './departure-handoff-delivery.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { DomainError } from './errors.ts'
import type { LocationKind } from './location-kinds.ts'
import type { ResponseValue } from './questions.ts'

export type DepartureHandoffParticipantContext = Pick<
  PublicContext,
  | 'db'
  | 'now'
  | 'automaticMeet'
  | 'automaticZoom'
  | 'microsoftCalendarEnabled'
  | 'scimResourcesEnabled'
>

interface ParticipantBookingTerms {
  start: string
  end: string
  timeZone: string
  hostName: string | null
  location: { kind: LocationKind; address?: string } | null
}

export interface DepartureHandoffParticipantOffer {
  version: number
  expiresAt: string
  role: 'booker' | 'guest'
  current: ParticipantBookingTerms
  proposed: ParticipantBookingTerms
  answers: { label: string; value: ResponseValue }[]
}

type Decision = 'accept' | 'decline'

const unavailable = () => new DomainError('not_found', 'handoff_offer_unavailable')
const utc = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

function capability(token: string) {
  if (token.length !== 80) throw unavailable()
  const [, id, secret] =
    /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(token) ?? []
  if (!id || !secret) throw unavailable()
  return { id, digest: departureHandoffTokenDigest(id, secret) }
}

function recipientByCapability(db: Db, token: ReturnType<typeof capability>) {
  return db
    .selectFrom('departure_handoff_recipients')
    .where('id', '=', token.id)
    .where('token_digest', '=', token.digest)
    .where('decision', 'is', null)
}

function offerForRecipient(
  db: Db,
  recipient: {
    organization_id: string
    source_booking_id: string
    offer_id: string
    offer_version: number
  },
) {
  return db
    .selectFrom('departure_handoff_offers')
    .select([
      'state',
      'version',
      'departing_user_id',
      'duration_minutes',
      'location_option_id',
      'terms_digest',
      utc('issued_at').as('issuedAt'),
      utc('expires_at').as('expiresAt'),
      utc('target_start_at').as('targetStart'),
    ])
    .where('organization_id', '=', recipient.organization_id)
    .where('source_booking_id', '=', recipient.source_booking_id)
    .where('id', '=', recipient.offer_id)
    .where('version', '=', recipient.offer_version)
}

type Offer = InferResult<ReturnType<typeof offerForRecipient>>[number]

function assertWindow(
  now: Temporal.Instant,
  issuedAt: string,
  deadline: string | Temporal.Instant,
) {
  if (Temporal.Instant.compare(now, issuedAt) < 0 || Temporal.Instant.compare(now, deadline) >= 0)
    throw unavailable()
}

async function verifiedTerms(
  ctx: DepartureHandoffParticipantContext,
  recipient: { organization_id: string; source_booking_id: string; recipient_key: string },
  offer: Offer,
  lockTerms: boolean,
) {
  const { organization_id: organizationId, source_booking_id: bookingId } = recipient
  const input = {
    bookingId,
    departingUserId: offer.departing_user_id,
    start: offer.targetStart,
    durationMinutes: offer.duration_minutes,
    ...(offer.location_option_id !== null && { locationOptionId: offer.location_option_id }),
  }
  try {
    let eligible = await getDepartureHandoffEligibility(ctx, organizationId, input)
    if (lockTerms) {
      await lockHosts(ctx.db, [offer.departing_user_id, eligible.candidateUserId])
      const locked = await getDepartureHandoffEligibility(
        ctx,
        organizationId,
        input,
        ctx.now(),
        true,
      )
      if (locked.candidateUserId !== eligible.candidateUserId) throw unavailable()
      eligible = locked
    }
    const terms = await readDepartureHandoffTerms(ctx, organizationId, input, eligible, lockTerms)
    if (terms.termsDigest !== offer.terms_digest) throw unavailable()
    const matchingAttendees = terms.attendees.filter(
      ({ email }) => email.toLowerCase() === recipient.recipient_key,
    )
    const ownBooker = matchingAttendees.find(({ isBooker }) => isBooker)
    const ownAttendee = ownBooker ?? matchingAttendees[0]
    if (!ownAttendee) throw unavailable()
    const deadline = departureHandoffDeadline(offer, eligible.source.start, terms.start)
    return { terms, eligible, ownAttendee, deadline }
  } catch (error) {
    if (error instanceof DomainError) throw unavailable()
    throw error
  }
}

function participantLocation(location: { kind: LocationKind } | null) {
  if (!location) return null
  const address = location.kind === 'in_person' && 'address' in location ? location.address : null
  return { kind: location.kind, ...(typeof address === 'string' && { address }) }
}

/** The token authorizes only this mailbox's view of the immutable proposal. A read
 * takes one snapshot of the offer and terms and never consumes or submits consent. */
export async function readDepartureHandoffParticipantOffer(
  ctx: DepartureHandoffParticipantContext,
  token: string,
): Promise<DepartureHandoffParticipantOffer> {
  const claim = capability(token)
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (db) => {
      const recipient = await recipientByCapability(db, claim)
        .select([
          'organization_id',
          'source_booking_id',
          'offer_id',
          'offer_version',
          'recipient_key',
        ])
        .executeTakeFirst()
      if (!recipient) throw unavailable()
      const offer = await offerForRecipient(db, recipient).executeTakeFirst()
      if (offer?.state !== 'live') throw unavailable()
      assertWindow(ctx.now(), offer.issuedAt, offer.expiresAt)
      const { terms, eligible, ownAttendee, deadline } = await verifiedTerms(
        { ...ctx, db },
        recipient,
        offer,
        false,
      )
      const departingHost = await db
        .selectFrom('auth.user')
        .select('name')
        .where('id', '=', offer.departing_user_id)
        .executeTakeFirst()
      assertWindow(ctx.now(), offer.issuedAt, deadline)
      return {
        version: offer.version,
        expiresAt: deadline.toString(),
        role: ownAttendee.isBooker ? 'booker' : 'guest',
        current: {
          start: eligible.source.start.toString(),
          end: eligible.source.end.toString(),
          timeZone: ownAttendee.timeZone,
          hostName: departingHost?.name.trim() || null,
          location: participantLocation(parseLocation(terms.sourceLocation)),
        },
        proposed: {
          start: terms.start.toString(),
          end: terms.end.toString(),
          timeZone: ownAttendee.timeZone,
          hostName: eligible.event.hostName.trim() || null,
          location: participantLocation(terms.location),
        },
        answers: ownAttendee.isBooker
          ? eligible.event.questions.flatMap(({ id, label }) => {
              const value = terms.responses[id]
              return value === undefined ? [] : [{ label, value }]
            })
          : [],
      }
    })
}

/** A live token and displayed version are both required. Recheck the token under
 * the lifecycle locks, where resend, withdrawal and re-version serialize with consent. */
export async function answerDepartureHandoffParticipantOffer(
  ctx: DepartureHandoffParticipantContext,
  input: { token: string; version: number; decision: Decision },
): Promise<{ decision: Decision }> {
  const claim = capability(input.token)
  if (input.decision !== 'accept' && input.decision !== 'decline') throw unavailable()

  return ctx.db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (db) => {
      const recipient = await recipientByCapability(db, claim)
        .select([
          'organization_id',
          'source_booking_id',
          'offer_id',
          'offer_version',
          'recipient_key',
        ])
        .executeTakeFirst()
      if (!recipient) throw unavailable()
      const organization = await db
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', recipient.organization_id)
        .forShare()
        .executeTakeFirst()
      if (!organization) throw unavailable()
      const source = await lockDepartureHandoffSource(
        db,
        organization.id,
        recipient.source_booking_id,
      )
      if (!source) throw unavailable()
      const offer = await offerForRecipient(db, recipient).forUpdate().executeTakeFirst()
      if (offer?.state !== 'live' || offer.version !== input.version) throw unavailable()
      assertWindow(ctx.now(), offer.issuedAt, offer.expiresAt)
      const pending = await recipientByCapability(db, claim)
        .select('id')
        .forUpdate()
        .executeTakeFirst()
      if (!pending) throw unavailable()
      const { deadline } = await verifiedTerms({ ...ctx, db }, recipient, offer, true)
      const now = ctx.now()
      assertWindow(now, offer.issuedAt, deadline)
      await db
        .updateTable('departure_handoff_recipients')
        .set({
          decision: input.decision === 'accept' ? 'approved' : 'declined',
          decided_at: now.round({ smallestUnit: 'microsecond', roundingMode: 'floor' }).toString(),
          token_digest: null,
        })
        .where('id', '=', pending.id)
        .execute()
      if (input.decision === 'decline') {
        await closeDepartureHandoffOffer(
          db,
          {
            organizationId: organization.id,
            sourceBookingId: source.id,
            offerId: recipient.offer_id,
            version: offer.version,
          },
          null,
        )
      }
      assertWindow(ctx.now(), offer.issuedAt, deadline)
      return { decision: input.decision }
    })
}
