// Bookings: created from public pages, managed by invitees through their secret link, and
// listed, rescheduled and cancelled by hosts. Availability is always recomputed inside the transaction
// that writes, and the exclusion constraint on booking_hosts is the last word on overlaps.
import { createHash, randomBytes } from 'node:crypto'
import { parsePersistedApiKeyMetadata } from '@hourmere/auth'
import {
  type Database,
  type Db,
  importedBookingIds,
  isImportedBooking,
  type Json,
} from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import {
  eventTypeNotFound,
  findOneTimeEventType,
  findPublicEventType,
  findPublicTeamEventType,
  findSlots,
  type Location,
  type PublicEventTypeRecord,
  parseLocation,
  selectBookableLocationOption,
  selectDurationMinutes,
  toInstant,
  toIso,
} from './availability.ts'
import { bookingPageQuery, encodeBookingCursor, type ListBookingsInput } from './booking-page.ts'
import {
  automaticMeet,
  automaticZoom,
  bookingConferenceViews,
  type CalendarCopyStatus,
  type ConferenceStatus,
  cancelBookingConference,
  eligibleMeetHosts,
  prepareBookingConference,
  requireMeetDestination,
  requireZoomConnection,
  unresolvedLocation,
  withLocationAvailability,
} from './conferences.ts'
import type { BookingNotifier, PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { admitGroupSlot, lockGroupBooking } from './group-seat-admission.ts'
import { bookingHostIds, lockOrganization, resolvedBookingHosts } from './hosts.ts'
import {
  isPreservedSingleton,
  resolveLocationChoice,
  selectLocationOption,
} from './location-options.ts'
import {
  createNotificationSnapshot,
  type NotificationSnapshot,
  notificationSnapshot,
  validateNotifications,
} from './notification-settings.ts'
import {
  claimOneTimeBookingLink,
  oneTimeBookingReplayTarget,
  resolveOneTimeBookingLink,
} from './one-time-links.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import { parseQuestions, type Question, type Responses, validateResponses } from './questions.ts'
import { assignRoundRobinHost, lockRoundRobinState } from './round-robin.ts'
import {
  type BookingSuccessRedirect,
  bookingSuccessRedirect,
  type SuccessRedirect,
  validateSuccessRedirect,
} from './success-redirect.ts'
import { cleanInviteeEmail, cleanText } from './text.ts'
import { ensureWaitlistKey } from './waitlist.ts'
import { attributeWaitlistBooking } from './waitlist-booking.ts'

export type BookingStatus = 'confirmed' | 'cancelled'
export type BookingSource = 'web' | 'embed' | 'api' | 'mcp' | 'import'

export interface Attendee {
  /** Private attendance metadata: authenticated booking reads only. */
  id?: string
  noShowMarkedAt?: string | null
  noShowMarkedBy?: string | null
  name: string
  email: string
  timeZone: string
  locale: string | null
  /** The invitee who made the booking; the others are guests they added. */
  isBooker: boolean
}

export interface Booking {
  canManageNoShow?: boolean
  id: string
  isGroupSeat?: boolean
  pendingReschedule?: { id: string; expiresAt: string; note: string | null }
  eventTypeId: string | null
  status: BookingStatus
  start: string
  end: string
  title: string
  /** Authenticated host reads only: the event type's current title, or null if deleted. */
  eventTypeTitle?: string | null
  /** Where the meeting happens, with its details (number, address, link). */
  location: Location | null
  conference?: ConferenceStatus
  /** Present only in authenticated host reads, for that host alone. */
  calendarCopy?: CalendarCopyStatus
  conferenceCanRetry?: boolean
  responses: Responses
  /** Original question labels retained for imported answers, in authenticated host reads. */
  questions?: Question[]
  /** The invitee first, then guests. */
  attendees: Attendee[]
  /** Authenticated host reads only: verified current co-host names; empty means unavailable. */
  coHosts?: { name: string }[]
  /** The booking this one replaced when it was rescheduled. */
  rescheduledFromId: string | null
  /** Authenticated host reads only: the immediate successor the caller also hosts, or null. */
  rescheduledToId?: string | null
  cancelledAt: string | null
  cancelReason: string | null
  source: BookingSource
  /** Imported busy records remain managed in the original system. */
  managementPolicy?: 'local_only_read_only'
  createdAt: string
  /** Actual round-robin winner; never a pool availability map or private identity. */
  assignedHost?: { name: string; timeZone: string } | null
}

export interface BookingWithToken {
  booking: Booking
  /**
   * The invitee's own manage token; emails carry their own. Returned once on creation or
   * an invitee move. Host moves return null and transfer the existing hash to the successor,
   * keeping the invitee's link private and usable. Idempotent creation replays return null.
   */
  manageToken: string | null
}

export const MAX_GUESTS = 10
const MAX_NAME = 200
const MAX_LOCALE = 35
const MAX_REASON = 1000
// A BCP 47 language tag's shape, e.g. "en", "en-US", "zh-Hant-TW".
const LOCALE = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/
const MANAGE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const bookingNotFound = () => new DomainError('not_found', 'booking_not_found', 'No such booking')

// --- Input validation -------------------------------------------------------------------

/** An IANA zone name in its canonical spelling; UTC offsets are refused (they ignore DST). */
function validTimeZone(value: string): string | undefined {
  if (value === '' || /^[+-]/.test(value)) return undefined
  try {
    return new Temporal.ZonedDateTime(0n, value).timeZoneId
  } catch {
    return undefined
  }
}

export interface PersonInput {
  name: string
  email: string
}

export interface InviteeInput extends PersonInput {
  /** IANA time zone, e.g. `Europe/Berlin`. */
  timeZone: string
  locale?: string | undefined
}

function person(input: PersonInput, code: 'invalid_invitee' | 'invalid_guests', what: string) {
  const name = cleanText(input.name, { max: MAX_NAME })
  if (name === undefined) {
    throw new DomainError(
      'invalid',
      code,
      `${what} needs a name of 1 to ${MAX_NAME} characters on one line, without control characters`,
    )
  }
  const email = cleanInviteeEmail(input.email)
  if (email === undefined) {
    throw new DomainError('invalid', code, `${what} needs a valid email address`)
  }
  return { name, email }
}

export function validateInvitee(input: InviteeInput): Attendee {
  const { name, email } = person(input, 'invalid_invitee', 'The invitee')
  const timeZone = validTimeZone(input.timeZone)
  if (!timeZone) {
    throw new DomainError('invalid', 'invalid_time_zone', 'timeZone must be an IANA time zone name')
  }
  let locale: string | null = null
  if (input.locale !== undefined && input.locale.trim() !== '') {
    locale = cleanText(input.locale, { max: MAX_LOCALE }) ?? null
    if (locale === null || !LOCALE.test(locale)) {
      throw new DomainError(
        'invalid',
        'invalid_invitee',
        'locale must be a language tag like en-US',
      )
    }
  }
  return { name, email, timeZone, locale, isBooker: true }
}

function validateGuests(guests: readonly PersonInput[], invitee: Attendee): Attendee[] {
  if (guests.length > MAX_GUESTS) {
    throw new DomainError('invalid', 'too_many_guests', `At most ${MAX_GUESTS} guests`)
  }
  return guests.map((g) => ({
    ...person(g, 'invalid_guests', 'Each guest'),
    // Guests are invited by the invitee; their own zone is unknown until they say otherwise.
    timeZone: invitee.timeZone,
    locale: null,
    isBooker: false,
  }))
}

function normalizeReason(reason: string | undefined): string | null {
  if (reason === undefined || reason.trim() === '') return null
  const text = cleanText(reason, { multiline: true, max: MAX_REASON })
  if (text === undefined) {
    throw new DomainError(
      'invalid',
      'invalid_reason',
      `The reason may have at most ${MAX_REASON} characters and no control characters other than tabs and line breaks`,
    )
  }
  return text
}

// --- Idempotency and manage tokens --------------------------------------------------------

/** JSON with object keys sorted at every level, so equal requests serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest()

/** A new manage-link secret (32 random bytes, base64url) and the SHA-256 that is stored. */
function newManageToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: sha256(token) }
}

/**
 * The stored hash for a manage token, or undefined when it is missing or cannot be one
 * (both end in the same booking_not_found as an unknown token). Lookups go by hash, so
 * response timing says nothing useful about the secret.
 */
function manageTokenHash(token: string | undefined): Buffer | undefined {
  return token !== undefined && MANAGE_TOKEN.test(token) ? sha256(token) : undefined
}

/** The booking a manage token acts on. */
interface ManagedTarget {
  id: string
  /** The token came from an invitee email (booking_notifications), not the booking API. */
  fromEmail: boolean
}

/**
 * The booking a manage token acts on; showing and acting both start here, so they resolve
 * the same booking. The token is found by its hash in one statement that probes both places
 * a hash can be, each through its unique index, whatever the token turns out to be, so every
 * unknown token costs the same (two index probes that find nothing):
 * - `bookings.manage_token_hash`, the token the booking API returned: an invitee move leaves
 *   it on the cancelled booking, making retries safe. A host move transfers it to the
 *   successor without revealing or minting a secret, so the invitee's link keeps working.
 * - `booking_notifications.manage_token_hash`, the token in an invitee email (only emails
 *   that went out; one the mail server refused has no hash): it stands for the meeting the
 *   email was about, so it opens the latest booking of that booking's reschedule chain and
 *   a link in an older email keeps working.
 */
async function resolveManagedTarget(db: Db, hash: Buffer): Promise<ManagedTarget | undefined> {
  const { rows } = await sql<{ id: string; from_email: boolean }>`
    SELECT id, false AS from_email FROM bookings WHERE manage_token_hash = ${hash} AND (payment_hold_expires_at IS NULL OR payment_confirmed_at IS NOT NULL)
    UNION ALL
    SELECT booking_id, true FROM booking_notifications
     WHERE manage_token_hash = ${hash} AND outcome = 'sent'`.execute(db)
  // One hash in both tables would take 2^256 luck; the booking's own token would win.
  const row = rows.find((r) => !r.from_email) ?? rows[0]
  if (!row) return undefined
  if (await isImportedBooking(db, row.id)) return undefined
  if (!row.from_email) return { id: row.id, fromEmail: false }
  return { id: await latestInChain(db, row.id), fromEmail: true }
}

/**
 * The latest booking of the reschedule chain from `id` on (`id` itself if not replaced).
 * No hop limit is needed: `rescheduled_from_id` is set once, when a booking is inserted, to
 * a booking that already exists (a foreign key) and never changes, so a chain cannot loop;
 * and a reschedule locks and cancels the booking it replaces, so each booking has at most
 * one successor and the chain ends at the latest one. The CYCLE clause only keeps
 * hand-edited data from looping, and the id only orders such data's branches.
 */
async function latestInChain(db: Db, id: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    WITH RECURSIVE chain (id, depth) AS (
      SELECT ${id}::uuid, 0
      UNION ALL
      SELECT b.id, c.depth + 1
        FROM bookings b JOIN chain c ON b.rescheduled_from_id = c.id
    ) CYCLE id SET is_cycle USING path
    SELECT id FROM chain WHERE NOT is_cycle ORDER BY depth DESC, id LIMIT 1`.execute(db)
  return rows[0]?.id ?? id
}

/**
 * The predecessors retain exactly the authority needed for this count: an invitee move
 * leaves its response-token hash behind; a host move clears it when transferring that
 * hash to the successor. Count those edges, rather than all moves, without storing a
 * second counter that could disagree with the chain. Writes hold the current row lock;
 * predecessor links and hashes cannot change after they have a successor.
 */
async function inviteeRescheduleCount(db: Db, id: string): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    WITH RECURSIVE chain (id, rescheduled_from_id, manage_token_hash, organization_id) AS (
      SELECT id, rescheduled_from_id, manage_token_hash, organization_id
        FROM bookings WHERE id = ${id}
      UNION ALL
      SELECT b.id, b.rescheduled_from_id, b.manage_token_hash, b.organization_id
        FROM bookings b JOIN chain c ON b.id = c.rescheduled_from_id
       WHERE b.organization_id = c.organization_id
    ) CYCLE id SET is_cycle USING path
    SELECT count(*)::int AS count FROM chain
     WHERE id <> ${id} AND manage_token_hash IS NOT NULL AND NOT is_cycle`.execute(db)
  return rows[0]?.count ?? 0
}

/** Shared by invitee reschedule slots and the final locked write. */
export async function assertInviteeRescheduleAllowed(
  ctx: PublicContext,
  id: string,
): Promise<void> {
  if ((await inviteeRescheduleCount(ctx.db, id)) >= (ctx.bookingMaxInviteeReschedules ?? 5)) {
    throw new DomainError(
      'conflict',
      'booking_reschedule_limit',
      'This booking has been rescheduled the maximum number of times. Contact the host to change it again.',
    )
  }
}

/** How often lockManagedBooking follows a meeting that keeps moving before giving up. */
const MAX_FOLLOW_ROUNDS = 10

const RESCHEDULE_COLUMNS = [
  'id',
  'organization_id',
  'event_type_id',
  'status',
  'start_at',
  'end_at',
  'title',
  'location',
  'location_option',
  'responses',
  'required_host_user_ids',
  'hosts_use_default_schedule',
  'manage_token_hash',
  'notification_snapshot',
  'group_slot_id',
] as const

/**
 * Locks (FOR UPDATE) and returns the booking a manage token acts on; call inside a
 * transaction. For an email's token, a reschedule that committed while this waited for the
 * lock has moved the meeting on, so the chain is followed again from the locked row until
 * the locked row is the latest (no reschedule can replace it while the lock is held). Each
 * further round means yet another reschedule committed while this request waited. The
 * booking's own token is also resolved again if a host transferred its hash while this
 * waited. After MAX_FOLLOW_ROUNDS it answers `booking_changed` (try again).
 */
async function lockManagedBooking(trx: Db, hash: Buffer) {
  const target = await resolveManagedTarget(trx, hash)
  if (!target) return undefined
  let id = target.id
  for (let round = 1; ; round++) {
    const row = await trx
      .selectFrom('bookings')
      .select(RESCHEDULE_COLUMNS)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!row) return undefined
    if (!target.fromEmail && row.manage_token_hash?.equals(hash)) return row
    const latest = target.fromEmail
      ? await latestInChain(trx, id)
      : (await resolveManagedTarget(trx, hash))?.id
    if (!latest) return undefined
    if (latest === id) return row
    if (round === MAX_FOLLOW_ROUNDS) {
      throw new DomainError(
        'conflict',
        'booking_changed',
        'This booking was moved again while the request waited; try again',
      )
    }
    id = latest
  }
}

interface IdempotencyScope {
  organizationId: string
  /** The caller's API key; null for anonymous callers, who all share one scope. */
  apiKeyId: string | null
  /** OAuth grants have their own retry and audit scope, separate from keys and anonymous callers. */
  oauthConsentId?: string | null | undefined
  key: string
  fingerprint: Buffer
}

/**
 * The booking an earlier request with this key created, if any. A different request
 * reusing the key is refused rather than answered with someone else's booking.
 */
async function findReplay(
  db: Db,
  scope: IdempotencyScope,
  expectedBookingId?: string | null,
): Promise<(BookingWithToken & { successRedirect?: BookingSuccessRedirect }) | undefined> {
  let query = db
    .selectFrom('bookings')
    .select(['id', 'idempotency_fingerprint', 'success_redirect'])
    .where('payment_hold_expires_at', 'is', null)
    .where('organization_id', '=', scope.organizationId)
    .where('api_key_id', scope.apiKeyId === null ? 'is' : '=', scope.apiKeyId)
    .where(
      'oauth_consent_id',
      scope.oauthConsentId == null ? 'is' : '=',
      scope.oauthConsentId ?? null,
    )
    .where('idempotency_key', '=', scope.key)
  // A null target is an intentional no-match probe, with the same SQL shape as
  // a used-link replay. SQL equality against NULL cannot return another booking.
  if (expectedBookingId !== undefined)
    query = query.where('id', '=', sql<string>`${expectedBookingId}`)
  const row = await query.executeTakeFirst()
  if (!row) return undefined
  if (!row.idempotency_fingerprint?.equals(scope.fingerprint)) {
    throw new DomainError(
      'conflict',
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different request',
    )
  }
  return {
    booking: await loadBooking(db, row.id),
    manageToken: null,
    ...(row.success_redirect && {
      successRedirect: row.success_redirect as unknown as BookingSuccessRedirect,
    }),
  }
}

const pgError = (err: unknown) =>
  (isRecord(err) ? err : {}) as { code?: unknown; constraint?: unknown }

// --- Reading bookings -------------------------------------------------------------------

const BOOKING_COLUMNS = [
  'b.id',
  'b.group_slot_id',
  'b.event_type_id',
  'b.status',
  'b.start_at',
  'b.end_at',
  'b.title',
  'b.location',
  'b.responses',
  'b.import_questions',
  'b.rescheduled_from_id',
  'b.cancelled_at',
  'b.cancel_reason',
  'b.source',
  'b.created_at',
  'b.required_host_user_ids',
  'b.hosts_use_default_schedule',
] as const

interface BookingRow {
  id: string
  group_slot_id: string | null
  event_type_id: string | null
  status: string
  start_at: Date
  end_at: Date
  title: string
  event_type_title?: string | null
  location: Json | null
  responses: Json
  import_questions: Json
  rescheduled_from_id: string | null
  cancelled_at: Date | null
  cancel_reason: string | null
  source: string
  created_at: Date
  required_host_user_ids: string[]
  hosts_use_default_schedule: boolean
}

/** Adds the attendees (one query for all rows) and maps rows to the API shape. */
async function toBookings(
  db: Db,
  rows: readonly BookingRow[],
  host?: { userId: string; now: () => Temporal.Instant },
  readNow?: Temporal.Instant,
): Promise<Booking[]> {
  if (!rows.length) return []
  const requests = await db
    .selectFrom('booking_reschedule_requests')
    .selectAll()
    .where(
      'booking_id',
      'in',
      rows.map((r) => r.id),
    )
    .where('state', '=', 'pending')
    .execute()
  const effectiveNow = readNow ?? host?.now()
  const pending = new Map(
    requests
      .filter(
        (r) => !effectiveNow || Temporal.Instant.compare(toInstant(r.expires_at), effectiveNow) > 0,
      )
      .map((r) => [
        r.booking_id,
        { id: r.id, expiresAt: toIso(toInstant(r.expires_at)), note: r.note },
      ]),
  )
  const attendees = await db
    .selectFrom('booking_attendees')
    .select([
      'booking_id',
      'name',
      'email',
      'time_zone',
      'locale',
      'is_booker',
      'id',
      'no_show_marked_at',
      'no_show_marked_by',
    ])
    .where(
      'booking_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('is_booker', 'desc')
    .orderBy('id')
    .execute()
  const byBooking = new Map<string, Attendee[]>()
  for (const a of attendees) {
    const list = byBooking.get(a.booking_id) ?? []
    list.push({
      ...(host
        ? {
            id: a.id,
            noShowMarkedAt: a.no_show_marked_at?.toISOString() ?? null,
            noShowMarkedBy: a.no_show_marked_by,
          }
        : {}),
      name: a.name,
      email: a.email,
      timeZone: a.time_zone,
      locale: a.locale,
      isBooker: a.is_booker,
    })
    byBooking.set(a.booking_id, list)
  }
  const successors = new Map<string, string>()
  const coHosts = new Map<string, { name: string }[]>()
  if (host) {
    const otherHosts = await db
      .selectFrom('booking_hosts as h')
      .innerJoin('bookings as co_booking', 'co_booking.id', 'h.booking_id')
      .innerJoin('auth.user as u', 'u.id', 'h.user_id')
      .innerJoin('auth.member as co_member', (join) =>
        join
          .onRef('co_member.userId', '=', 'h.user_id')
          .onRef('co_member.organizationId', '=', 'co_booking.organization_id'),
      )
      .leftJoin('profiles as p', 'p.user_id', 'h.user_id')
      .select(['co_booking.id as booking_id', 'u.name', 'p.handle'])
      .where(
        'h.booking_id',
        'in',
        rows.map((row) => row.id),
      )
      .where('h.user_id', '!=', host.userId)
      .where('u.emailVerified', '=', true)
      .orderBy('h.user_id')
      .execute()
    for (const other of otherHosts) {
      const names = coHosts.get(other.booking_id) ?? []
      names.push({ name: other.name.trim() || other.handle || '' })
      coHosts.set(other.booking_id, names)
    }
    const replacements = await db
      .selectFrom('bookings as successor')
      .innerJoin('bookings as predecessor', 'predecessor.id', 'successor.rescheduled_from_id')
      .innerJoin(
        resolvedBookingHosts(db).as('successor_host'),
        'successor_host.booking_id',
        'successor.id',
      )
      .select(['predecessor.id as predecessor_id', 'successor.id'])
      .where(
        'predecessor.id',
        'in',
        rows.map((row) => row.id),
      )
      .whereRef('successor.organization_id', '=', 'predecessor.organization_id')
      .where('successor_host.user_id', '=', host.userId)
      .execute()
    for (const replacement of replacements)
      successors.set(replacement.predecessor_id, replacement.id)
  }
  // Read immutable import attribution before lifecycle hydration, preserving the
  // existing snapshot boundary for status, location and retry controls.
  const imported = await importedBookingIds(
    db,
    rows.map((row) => row.id),
  )
  // Read successor metadata before the lifecycle snapshot so no later successor read
  // can outlive the status, location and conference state returned together below.
  const conferences = await bookingConferenceViews(
    db,
    rows.map((r) => r.id),
    host?.userId,
  )
  const assigned = new Map<string, { name: string; timeZone: string }>()
  const assignedIds = rows
    .filter((row) => row.hosts_use_default_schedule && row.required_host_user_ids.length === 1)
    .map((row) => row.id)
  if (assignedIds.length) {
    const hosts = await db
      .selectFrom('booking_hosts as h')
      .innerJoin('auth.user as u', 'u.id', 'h.user_id')
      .leftJoin('profiles as p', 'p.user_id', 'h.user_id')
      .leftJoin('schedules as s', (join) =>
        join.onRef('s.user_id', '=', 'h.user_id').on('s.is_default', '=', true),
      )
      .select([
        'h.booking_id',
        'u.name',
        'p.handle',
        sql<string>`coalesce(p.time_zone,s.time_zone,'UTC')`.as('time_zone'),
      ])
      .where('h.booking_id', 'in', assignedIds)
      .$narrowType<{ booking_id: string }>()
      .execute()
    for (const host of hosts)
      assigned.set(host.booking_id, {
        name: host.name.trim() || host.handle || '',
        timeZone: host.time_zone,
      })
  }
  const now = host?.now()
  return rows.map((row) => {
    const view = imported.has(row.id) ? undefined : conferences.get(row.id)
    // Cancellation/rescheduling may commit after the first booking read, even moving
    // the conference pointer away. Hydrate lifecycle state for every booking id.
    const r = view
      ? {
          ...row,
          status: view.bookingStatus,
          cancelled_at: view.bookingCancelledAt,
          cancel_reason: view.bookingCancelReason,
        }
      : row
    const location = view ? view.location : r.location
    return {
      id: r.id,
      ...(r.group_slot_id ? { isGroupSeat: true } : {}),
      eventTypeId: r.event_type_id,
      status: r.status as BookingStatus,
      start: toIso(toInstant(r.start_at)),
      end: toIso(toInstant(r.end_at)),
      title: r.title,
      ...(host ? { eventTypeTitle: r.event_type_title ?? null } : {}),
      location: parseLocation(
        (automaticZoom(location) || automaticMeet(location)) &&
          (r.status !== 'confirmed' ||
            view?.bookingStatus !== 'confirmed' ||
            view?.conference?.status !== 'ready')
          ? unresolvedLocation(location)
          : location,
      ),
      ...(view?.conference ? { conference: view.conference } : {}),
      ...(now && view?.calendarCopy
        ? {
            calendarCopy: {
              ...view.calendarCopy,
              canRetry:
                view.calendarCopy.canRetry &&
                (r.status === 'cancelled' ||
                  Temporal.Instant.compare(toInstant(r.start_at), now) > 0),
            },
          }
        : {}),
      ...(host && view?.conferenceCanRetry !== undefined
        ? { conferenceCanRetry: view.conferenceCanRetry }
        : {}),
      responses: (isRecord(r.responses) ? r.responses : {}) as Responses,
      ...(host && imported.has(r.id)
        ? { questions: parseQuestions(r.import_questions ?? []) }
        : {}),
      ...(host
        ? {
            canManageNoShow:
              r.status === 'confirmed' &&
              !imported.has(r.id) &&
              Temporal.Instant.compare(host.now(), toInstant(r.start_at)) > 0,
          }
        : {}),
      attendees: byBooking.get(r.id) ?? [],
      ...(coHosts.has(r.id) ? { coHosts: coHosts.get(r.id) } : {}),
      ...(r.status === 'confirmed' && pending.has(r.id)
        ? { pendingReschedule: pending.get(r.id) }
        : {}),
      rescheduledFromId: r.rescheduled_from_id,
      ...(host ? { rescheduledToId: successors.get(r.id) ?? null } : {}),
      cancelledAt: r.cancelled_at && toIso(toInstant(r.cancelled_at)),
      cancelReason: r.cancel_reason,
      source: r.source as BookingSource,
      ...(imported.has(r.id) ? { managementPolicy: 'local_only_read_only' as const } : {}),
      createdAt: toIso(toInstant(r.created_at)),
      ...(r.hosts_use_default_schedule &&
        r.required_host_user_ids.length === 1 && { assignedHost: assigned.get(r.id) ?? null }),
    }
  })
}

async function loadBooking(db: Db, id: string, now?: Temporal.Instant): Promise<Booking> {
  const row = await db
    .selectFrom('bookings as b')
    .select(BOOKING_COLUMNS)
    .where('b.id', '=', id)
    .executeTakeFirstOrThrow()
  const [booking] = await toBookings(db, [row], undefined, now)
  return booking as Booking
}

// --- Writing bookings -------------------------------------------------------------------

/**
 * Resolve only against the locked configuration and the actual assigned hosts. Payment holds
 * share it so a hold stores the chosen option exactly as its confirmed booking would.
 */
export async function resolveBookingLocation(
  ctx: PublicContext,
  db: Db,
  event: PublicEventTypeRecord,
  hosts: string[],
  input: Pick<CreateBookingInput, 'locationOptionId' | 'inviteePhone'>,
) {
  const options = event.locations
  const chosen = selectLocationOption(options, input.locationOptionId)
  const organizer =
    event.schedulingType === 'collective' ? event.conferenceOrganizerUserId : hosts[0]
  const meetReady: string[] = []
  const zoomReady: string[] = []
  try {
    if (organizer && automaticMeet(chosen)) {
      await requireMeetDestination(db, organizer, event.id, ctx.automaticMeet)
      meetReady.push(organizer)
    }
    if (organizer && automaticZoom(chosen)) {
      await requireZoomConnection(db, organizer, event.zoomConnectionId, ctx.automaticZoom, true)
      zoomReady.push(organizer)
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    if (isPreservedSingleton(options, input.locationOptionId)) throw error
    throw new DomainError('conflict', 'location_unavailable', 'The chosen location is unavailable.')
  }
  // Migration 0056 and older compatibility writes keep a single location's settings as stored
  // (including historical phone formatting), whatever its option id. Booking one must not
  // turn into a configuration rewrite; choosing it explicitly stores the same snapshot.
  if (
    chosen &&
    options?.length === 1 &&
    !automaticMeet(chosen) &&
    !automaticZoom(chosen) &&
    !(chosen.kind === 'phone' && 'askInvitee' in chosen)
  ) {
    const { id: _id, label: _label, isDefault: _default, ...location } = chosen
    return { locationOption: structuredClone(chosen), location }
  }
  return resolveLocationChoice(
    options,
    {
      ...(input.locationOptionId !== undefined && { optionId: input.locationOptionId }),
      ...(input.inviteePhone !== undefined && { inviteePhone: input.inviteePhone }),
    },
    {
      schedulingType: event.schedulingType,
      hostUserIds: hosts,
      ...(hosts[0] && { assignedHostUserId: hosts[0] }),
      conferenceOrganizerUserId: event.conferenceOrganizerUserId,
      meetReadyHostUserIds: meetReady,
      zoomReadyHostUserIds: zoomReady,
    },
  )
}

/** Keep a readiness race during conference intent creation inside the choice error contract. */
async function prepareChosenBookingConference(
  ctx: PublicContext,
  db: Db,
  bookingId: string,
  preserveLegacyErrors: boolean,
): Promise<void> {
  try {
    await prepareBookingConference(ctx, db, bookingId)
  } catch (error) {
    if (
      !preserveLegacyErrors &&
      error instanceof DomainError &&
      (error.code.startsWith('automatic_meet_') || error.code.startsWith('automatic_zoom_'))
    ) {
      throw new DomainError(
        'conflict',
        'location_unavailable',
        'The chosen location is unavailable.',
      )
    }
    throw error
  }
}

/** Final invariant: a persisted phone location must contain a collected number. */
function requireCollectedPhone(location: Location | null): void {
  if (location?.kind === 'phone' && location.askInvitee === true) {
    throw new DomainError(
      'invalid',
      'invalid_invitee_phone',
      'Provide a phone number in E.164 format.',
    )
  }
}

/**
 * Serializes booking writes per host for the rest of the transaction. The exclusion
 * constraint alone stops overlapping meetings, but not two concurrent bookings that only
 * collide through buffers or day/week/month limits; with the lock, the second recomputes
 * availability after the first has committed. Sorted, so multi-host bookings cannot deadlock.
 */
export async function lockHosts(db: Db, userIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await db
      .selectNoFrom((eb) =>
        eb
          .fn('pg_advisory_xact_lock', [
            eb.fn('hashtextextended', [eb.val(`booking-host:${id}`), eb.lit(0)]),
          ])
          .as('locked'),
      )
      .execute()
  }
}

/**
 * Throws `slot_unavailable` unless the engine offers exactly [start, end) for this host now.
 * Comparing the end too catches an event type whose duration changed after the caller read it.
 */
export async function requireOfferedSlot(
  db: Db,
  q: {
    eventTypeId: string
    hostUserId: string
    start: Temporal.Instant
    end: Temporal.Instant
    now: Temporal.Instant
    durationMinutes?: number | undefined
    excludeBookingId?: string
    useDefaultSchedule?: boolean
  },
): Promise<void> {
  await expirePaymentHolds({ db, hostUserId: q.hostUserId })
  const slots = await findSlots(db, {
    eventTypeId: q.eventTypeId,
    hostUserId: q.hostUserId,
    rangeStart: q.start,
    rangeEnd: q.end,
    now: q.now,
    durationMinutes: q.durationMinutes,
    excludeBookingId: q.excludeBookingId,
    useDefaultSchedule: q.useDefaultSchedule,
  })
  if (!slots.some((s) => s.start.equals(q.start) && s.end.equals(q.end))) {
    throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
  }
}

interface NewBooking {
  paymentHoldExpiresAt?: string | undefined
  groupSlotId?: string | undefined
  locationOption?: Json | null | undefined
  successRedirect?: BookingSuccessRedirect | undefined
  organizationId: string
  eventTypeId: string | null
  start: Temporal.Instant
  end: Temporal.Instant
  title: string
  location: Location | null
  responses: Responses
  source: BookingSource
  apiKeyId: string | null
  /** OAuth grants have their own retry and audit scope, separate from keys and anonymous callers. */
  oauthConsentId?: string | null | undefined
  idempotency?: { key: string; fingerprint: Buffer } | undefined
  rescheduledFromId?: string | undefined
  hostUserIds: readonly string[]
  hostsUseDefaultSchedule: boolean
  attendees: readonly Attendee[]
  notificationSnapshot: NotificationSnapshot
  /** Present only on a host move: transfer the invitee's hash without minting a token. */
  manageTokenHash?: Buffer | null | undefined
}

/** Inserts a booking with its hosts and attendees; call inside a transaction. */
export async function insertBooking(
  db: Db,
  b: NewBooking,
): Promise<{ id: string; manageToken: string | null }> {
  const { token, hash } =
    b.manageTokenHash === undefined ? newManageToken() : { token: null, hash: b.manageTokenHash }
  const { id } = await db
    .insertInto('bookings')
    .values({
      status: b.paymentHoldExpiresAt ? 'pending_payment' : 'confirmed',
      payment_hold_expires_at: b.paymentHoldExpiresAt ?? null,
      organization_id: b.organizationId,
      group_slot_id: b.groupSlotId ?? null,
      group_booker_key: b.groupSlotId
        ? sql<string>`normalize_group_booker_key(${b.attendees[0]?.email ?? ''})`
        : null,
      ...(b.locationOption !== undefined
        ? { location_option: b.locationOption === null ? null : JSON.stringify(b.locationOption) }
        : {}),
      event_type_id: b.eventTypeId,
      success_redirect: b.successRedirect ? JSON.stringify(b.successRedirect) : null,
      start_at: b.start.toString(),
      end_at: b.end.toString(),
      title: b.title,
      location: b.location && JSON.stringify(unresolvedLocation(b.location as Json)),
      responses: JSON.stringify(b.responses),
      manage_token_hash: hash,
      source: b.source,
      api_key_id: b.apiKeyId,
      oauth_consent_id: b.oauthConsentId ?? null,
      idempotency_key: b.idempotency?.key ?? null,
      idempotency_fingerprint: b.idempotency?.fingerprint ?? null,
      rescheduled_from_id: b.rescheduledFromId ?? null,
      required_host_user_ids: [...b.hostUserIds].sort(),
      hosts_use_default_schedule: b.hostsUseDefaultSchedule,
      notification_snapshot: JSON.stringify(b.notificationSnapshot),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  if (b.hostUserIds.length && !b.groupSlotId) {
    try {
      await db
        .insertInto('booking_hosts')
        .values(b.hostUserIds.map((user_id) => ({ booking_id: id, user_id })))
        .execute()
    } catch (err) {
      // Another booking got this host's time first (an expected race, so no cause to log).
      const { code, constraint } = pgError(err)
      if (code === '23P01' && constraint === 'booking_hosts_no_overlap') {
        throw new DomainError('conflict', 'slot_taken', 'Someone else just booked this time')
      }
      throw err
    }
  }
  if (b.attendees.length) {
    await db
      .insertInto('booking_attendees')
      .values(
        b.attendees.map((a) => ({
          booking_id: id,
          name: a.name,
          email: a.email,
          time_zone: a.timeZone,
          locale: a.locale,
          is_booker: a.isBooker,
        })),
      )
      .execute()
  }
  return { id, manageToken: token }
}

export async function assertBookingLocallyManaged(db: Db, id: string): Promise<void> {
  const paid = await db
    .selectFrom('bookings')
    .select('payment_hold_expires_at')
    .where('id', '=', id)
    .executeTakeFirst()
  if (paid?.payment_hold_expires_at)
    throw new DomainError(
      'conflict',
      'paid_booking_management_unavailable',
      'Paid booking management is not available yet',
    )
  if (await isImportedBooking(db, id)) {
    throw new DomainError(
      'conflict',
      'imported_booking_read_only',
      'This imported booking is read-only and managed in the original system.',
    )
  }
}

const bookingCancelled = () =>
  new DomainError('conflict', 'booking_cancelled', 'This booking is already cancelled')

async function lockCancellationOrganization(trx: Db, organizationId: string): Promise<void> {
  // Cancellation adds no host/user FK. Lock only the operation's organization parent,
  // before the booking, without depending on the host's current identity locks.
  const row = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
    .forKeyShare()
    .executeTakeFirst()
  if (!row) throw bookingNotFound()
}

function assertChangeable(row: { status: string; start_at: Date }, now: Temporal.Instant): void {
  if (row.status === 'cancelled') throw bookingCancelled()
  if (Temporal.Instant.compare(toInstant(row.start_at), now) <= 0) {
    throw new DomainError('conflict', 'booking_in_past', 'This booking has already started')
  }
}

async function cancelLocked(
  db: Db,
  row: { id: string; organization_id: string; status: string; start_at: Date },
  now: Temporal.Instant,
  reason: string | null,
  notify: BookingNotifier | undefined,
  origin: BookingOrigin,
  actorUserId: string | null,
): Promise<Booking> {
  await assertBookingLocallyManaged(db, row.id)
  const seat = await db
    .selectFrom('bookings')
    .select('group_slot_id')
    .where('id', '=', row.id)
    .executeTakeFirst()
  if (seat?.group_slot_id && row.status === 'cancelled') return loadBooking(db, row.id)
  assertChangeable(row, now)
  await db
    .updateTable('bookings')
    .set({
      status: 'cancelled',
      cancelled_at: now.toString(),
      cancel_reason: reason,
      cancelled_source: origin.source,
      cancelled_api_key_id: origin.apiKeyId,
      cancelled_oauth_consent_id: origin.oauthConsentId ?? null,
    })
    .where('id', '=', row.id)
    .execute()
  await db
    .insertInto('organization_operations')
    .values({
      organization_id: row.organization_id,
      operation: 'booking_cancelled',
      actor_user_id: actorUserId,
      booking_id: row.id,
      source: origin.source,
      api_key_id: origin.apiKeyId,
      oauth_consent_id: origin.oauthConsentId ?? null,
      occurred_at: now.toString(),
    })
    .execute()
  await auditBooking(db, row.organization_id, row.id, 'booking.cancelled', {
    ...origin,
    actorUserId: origin.actorUserId ?? actorUserId,
  })
  await resolveRescheduleRequest(db, row.id, 'cancelled', now)
  await cancelBookingConference(db, row.id, now)
  await skipScheduledMessages(db, row.id, 'booking_cancelled')
  // In this transaction: the cancellation email exists exactly when the cancellation does.
  await notify?.(db, { type: 'cancelled', bookingId: row.id }, now)
  return loadBooking(db, row.id)
}

/** Fence queued and claimed work without deleting terminal recipient history. */
async function skipScheduledMessages(
  db: Db,
  bookingId: string,
  reason: 'booking_cancelled' | 'booking_replaced',
): Promise<void> {
  await db
    .updateTable('booking_scheduled_messages')
    .set({
      state: 'skipped',
      skip_reason: reason,
      claim_token: null,
      lease_until: null,
      updated_at: sql`clock_timestamp()`,
    })
    .where('booking_id', '=', bookingId)
    .where('state', 'in', ['pending', 'processing'])
    .execute()
}

// --- Public booking -----------------------------------------------------------------------

export interface CreateBookingInput {
  locationOptionId?: string | undefined
  inviteePhone?: string | undefined
  handle: string
  slug: string
  /** Internal service generation fence; transports introduce it separately. */
  expectedGroupSlotId?: string | undefined
  start: Temporal.Instant
  /** One of the event type's allowed durations; omitted uses its default. */
  durationMinutes?: number | undefined
  invitee: InviteeInput
  guests?: readonly PersonInput[] | undefined
  responses?: Record<string, unknown> | undefined
  /**
   * Makes retries safe. Anonymous callers share one scope per organization, so this must
   * be random (e.g. a UUIDv4), never derived from the request.
   */
  idempotencyKey?: string | undefined
  /** Optional internal attribution metadata; excluded from booking identity and privileges. */
  waitlistToken?: string | undefined
}

/**
 * Who initiated a booking change. Creation uses source/api_key_id; withdrawals use
 * cancelled_source/cancelled_api_key_id without overwriting the original attribution.
 * The booking page is web without a key; agents pass api or mcp with the key they used.
 */
export interface BookingOrigin {
  audit?: ReturnType<typeof auditActor> | undefined
  requestId?: string | undefined
  source: Exclude<BookingSource, 'import'>
  /** The caller's API key. Idempotency keys are scoped to it; null shares one scope. */
  apiKeyId: string | null
  /** OAuth grants have their own retry and audit scope, separate from keys and anonymous callers. */
  oauthConsentId?: string | null | undefined
  /** Authenticated transport identity, when known; never inferred from the invitee or host. */
  actorUserId?: string | null | undefined
}

const BOOKING_PAGE: BookingOrigin = { source: 'web', apiKeyId: null }

export interface CreateBookingResult extends BookingWithToken {
  successRedirect?: BookingSuccessRedirect | undefined
  /** True when an earlier request with the same Idempotency-Key created the booking. */
  replayed: boolean
}

/**
 * Books a public personal event type, recorded as made by `origin` (the booking page unless
 * an agent says otherwise). The start must be a slot the page offers at this moment
 * (`slot_unavailable`); a concurrent booking of the same time loses with `slot_taken`.
 * Returns the booking and its manage token.
 */
export async function createPublicBooking(
  ctx: PublicContext,
  input: CreateBookingInput,
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<CreateBookingResult> {
  const replay = await groupCreationReplay(ctx, input, origin, false)
  if (replay) return replay
  return publicBooking(ctx, input, origin, (db, options) =>
    findPublicEventType(db, input.handle, input.slug, options),
  )
}

/** Books an individual team event through the same locked transaction and idempotency path. */
export async function createPublicTeamBooking(
  ctx: PublicContext,
  input: CreateBookingInput,
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<CreateBookingResult> {
  const replay = await groupCreationReplay(ctx, input, origin, true)
  if (replay) return replay
  return publicBooking(ctx, input, origin, (db, options) =>
    findPublicTeamEventType(db, input.handle, input.slug, options),
  )
}

/** An exact group replay survives later disabling/deletion of the event configuration. */
async function groupCreationReplay(
  ctx: PublicContext,
  input: CreateBookingInput,
  origin: BookingOrigin,
  team: boolean,
): Promise<CreateBookingResult | undefined> {
  if (input.idempotencyKey === undefined) return undefined
  const query = ctx.db
    .selectFrom('event_types as e')
    .select(['e.id', 'e.organization_id'])
    .where('e.slug', '=', input.slug.toLowerCase())
    .where('e.booking_mode', '=', 'group')
  const event = team
    ? await query
        .innerJoin('auth.organization as o', 'o.id', 'e.organization_id')
        .where('o.slug', '=', input.handle.toLowerCase())
        .where('e.owner_user_id', 'is', null)
        .executeTakeFirst()
    : await query
        .innerJoin('profiles as p', 'p.user_id', 'e.owner_user_id')
        .where('p.handle', '=', input.handle.toLowerCase())
        .executeTakeFirst()
  if (!event) return undefined
  const scope = bookingIdempotency(
    { id: event.id, organizationId: event.organization_id },
    input,
    origin,
  )
  const replay = scope && (await findReplay(ctx.db, scope))
  return replay ? { ...replay, replayed: true } : undefined
}

export interface CreateOneTimeBookingInput extends Omit<CreateBookingInput, 'handle' | 'slug'> {
  token: string
}

/** A consumed link permits only an exact replay of the request that won its claim. */
export async function createOneTimeBooking(
  ctx: PublicContext,
  input: CreateOneTimeBookingInput,
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<CreateBookingResult> {
  if (origin.source === 'embed') throw new DomainError('not_found', 'one_time_link_not_found')
  const replay = await oneTimeBookingReplay(ctx, input, origin)
  if (replay) return oneTimeBookingResult(replay)
  try {
    const link = await resolveOneTimeBookingLink(ctx, input.token)
    const result = await publicBooking(
      ctx,
      input,
      origin,
      async (db, options) => {
        await resolveOneTimeBookingLink({ db }, input.token)
        return findOneTimeEventType(db, link.eventTypeId, options)
      },
      { id: link.id, token: input.token },
    )
    return oneTimeBookingResult(result)
  } catch (error) {
    // Consumption may commit between either read above and our locked transaction.
    if (
      !(error instanceof DomainError) ||
      !['one_time_link_not_found', 'event_type_not_found'].includes(error.code)
    )
      throw error
    const replay = await oneTimeBookingReplay(ctx, input, origin)
    if (replay) return oneTimeBookingResult(replay)
    throw new DomainError('not_found', 'one_time_link_not_found')
  }
}

/** Saved continuations can contain reusable event addresses, including on legacy replays. */
function oneTimeBookingResult({
  booking,
  manageToken,
  replayed,
}: CreateBookingResult): CreateBookingResult {
  return { booking, manageToken, replayed }
}

async function oneTimeBookingReplay(
  ctx: PublicContext,
  input: CreateOneTimeBookingInput,
  origin: BookingOrigin,
): Promise<CreateBookingResult | undefined> {
  const used = await oneTimeBookingReplayTarget(ctx, input.token)
  const validKey = input.idempotencyKey !== undefined && IDEMPOTENCY_KEY.test(input.idempotencyKey)
  const scope = used && validKey ? bookingIdempotency(used, input, origin, used.id) : undefined
  // Always probe: skipping this lookup for unknown, expired or revoked links
  // otherwise exposes the used state through a cheap query-count difference.
  const probe = scope ?? {
    organizationId: '00000000-0000-0000-0000-000000000000',
    apiKeyId: origin.apiKeyId,
    oauthConsentId: origin.oauthConsentId ?? null,
    key: validKey ? (input.idempotencyKey as string) : '',
    fingerprint: Buffer.alloc(32),
  }
  try {
    const replay = await findReplay(ctx.db, probe, scope && used ? used.bookingId : null)
    if (used && replay?.booking.id === used.bookingId) return { ...replay, replayed: true }
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'idempotency_key_reused') throw error
  }
  return undefined
}

function bookingIdempotency(
  et: { organizationId: string; eventTypeId: string } | { organizationId: string; id: string },
  input: Omit<CreateBookingInput, 'handle' | 'slug'>,
  origin: BookingOrigin,
  oneTimeLinkId?: string,
): IdempotencyScope | undefined {
  if (input.idempotencyKey === undefined) return undefined
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new DomainError(
      'invalid',
      'invalid_idempotency_key',
      'Idempotency-Key must be 1 to 255 printable ASCII characters',
    )
  }
  return {
    organizationId: et.organizationId,
    apiKeyId: origin.apiKeyId,
    oauthConsentId: origin.oauthConsentId ?? null,
    key: input.idempotencyKey,
    fingerprint: sha256(
      canonicalJson({
        eventTypeId: 'eventTypeId' in et ? et.eventTypeId : et.id,
        ...(oneTimeLinkId !== undefined && { oneTimeLinkId }),
        start: input.start.toString(),
        durationMinutes: input.durationMinutes,
        locationOptionId: input.locationOptionId,
        inviteePhone: input.inviteePhone,
        ...(input.expectedGroupSlotId !== undefined
          ? { expectedGroupSlotId: input.expectedGroupSlotId }
          : {}),
        invitee: input.invitee,
        guests: input.guests ?? [],
        responses: input.responses ?? {},
      }),
    ),
  }
}

async function publicBooking(
  ctx: PublicContext,
  input: Omit<CreateBookingInput, 'handle' | 'slug'>,
  origin: BookingOrigin,
  resolve: (db: Db, options?: { lock?: boolean }) => Promise<PublicEventTypeRecord | undefined>,
  oneTimeLink?: { id: string; token: string },
): Promise<CreateBookingResult> {
  const et = await resolve(ctx.db)
  const unavailable = () =>
    oneTimeLink ? new DomainError('not_found', 'one_time_link_not_found') : eventTypeNotFound()
  if (!et) throw unavailable()

  const scope = bookingIdempotency(et, input, origin, oneTimeLink?.id)
  if (scope) {
    const replay = await findReplay(ctx.db, scope)
    if (replay) return { ...replay, replayed: true }
  }

  // Fails fast before taking the lock; checked again below against the current questions.
  validateResponses(et.questions, input.responses ?? {})
  const invitee = validateInvitee(input.invitee)
  const guests = validateGuests(input.guests ?? [], invitee)

  try {
    return await ctx.db.transaction().execute(async (trx) => {
      // The accounting-key fence precedes ordinary booking locks, matching discovery
      // and preventing a key rotation from forming a host/event/key lock cycle.
      if (ctx.waitlistSecret && input.waitlistToken !== undefined) {
        await ensureWaitlistKey(trx, ctx.waitlistSecret, new Date(ctx.now().epochMilliseconds))
      }
      await lockOrganization(trx, et.organizationId)
      await lockHosts(trx, et.hostUserIds)
      // A concurrent request with the same key may have committed while we waited.
      if (scope) {
        const replay = await findReplay(trx, scope)
        if (replay) return { ...replay, replayed: true }
      }
      // The event type may have changed while we waited (duration, questions, rules), and
      // waiting took time: read both again now that the host is locked.
      const current = await resolve(trx, { lock: true })
      if (!current || current.id !== et.id || current.schedulingType !== et.schedulingType) {
        throw unavailable()
      }
      if (current.hostUserIds.join() !== et.hostUserIds.join()) {
        if (current.schedulingType === 'round_robin')
          throw new DomainError('conflict', 'booking_changed', 'The host pool changed; try again')
        throw unavailable()
      }
      if (guests.length > 0 && !current.allowGuests) {
        throw new DomainError(
          'invalid',
          'guests_not_allowed',
          'This event type does not allow guests',
        )
      }
      const now = ctx.now()
      // resolve(...lock:true) holds the event row until commit. This read sees exactly
      // the policy serialized with a concurrent full configuration replacement.
      const policy = await trx
        .selectFrom('event_types')
        .select('notifications')
        .where('id', '=', current.id)
        .executeTakeFirstOrThrow()
      const snapshot = createNotificationSnapshot(policy.notifications)
      const responses = validateResponses(current.questions, input.responses ?? {})
      const durationMinutes = selectDurationMinutes(current, input.durationMinutes)
      const end = input.start.add({ minutes: durationMinutes })
      const groupSlot = await admitGroupSlot(trx, {
        event: current,
        bookerEmail: invitee.email,
        start: input.start,
        end,
        now,
        snapshot,
        expectedSlotId: input.expectedGroupSlotId,
        locationOptionId: input.locationOptionId,
      })
      const chosenOption = groupSlot
        ? null
        : selectBookableLocationOption(current, input.locationOptionId)
      let selectedHostIds = current.hostUserIds
      if (current.schedulingType === 'round_robin') {
        await lockRoundRobinState(trx, current.id)
        const available: string[] = []
        let stale = false
        const candidates = automaticMeet(chosenOption)
          ? await withLocationAvailability(current.locations, input.locationOptionId, () =>
              eligibleMeetHosts(trx, current.eligibleHostUserIds, current.id, ctx.automaticMeet),
            )
          : current.eligibleHostUserIds
        for (const hostUserId of candidates) {
          await expirePaymentHolds({ db: trx, hostUserId })
          try {
            const slots = await findSlots(trx, {
              eventTypeId: current.id,
              hostUserId,
              rangeStart: input.start,
              rangeEnd: end,
              now,
              durationMinutes: input.durationMinutes,
              useDefaultSchedule: true,
            })
            if (slots.some((slot) => slot.start.equals(input.start) && slot.end.equals(end)))
              available.push(hostUserId)
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'calendar_sync_unavailable')
              throw error
            stale = true
          }
        }
        if (!available.length && stale)
          throw new DomainError(
            'conflict',
            'calendar_sync_unavailable',
            'The host calendars are temporarily unavailable. Try again shortly.',
          )
        selectedHostIds = [await assignRoundRobinHost(trx, current.id, available)]
      } else if (!groupSlot) {
        for (const hostUserId of current.hostUserIds)
          await requireOfferedSlot(trx, {
            eventTypeId: current.id,
            hostUserId,
            start: input.start,
            end,
            now,
            durationMinutes: input.durationMinutes,
            useDefaultSchedule: current.schedulingType === 'collective',
          })
      }
      const choice =
        groupSlot ?? (await resolveBookingLocation(ctx, trx, current, selectedHostIds, input))
      requireCollectedPhone(choice.location)
      let settings: SuccessRedirect | null = null
      if (!oneTimeLink && (origin.source === 'web' || origin.source === 'embed')) {
        try {
          settings = validateSuccessRedirect(current.successRedirect, ctx.successRedirectPolicy)
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'invalid_success_redirect')
            throw error
          // An operator can tighten policy after this target was saved. Keep booking
          // available, with no continuation. Never log the URL, its query or invitee data.
          console.warn('success_redirect_disabled', { eventTypeId: current.id })
        }
      }
      const selectedHosts = selectedHostIds.map(
        (id) => current.hosts[current.hostUserIds.indexOf(id)]?.name ?? current.hostName,
      )
      const successRedirect = bookingSuccessRedirect(settings, {
        eventTypeSlug: current.slug,
        start: toIso(input.start),
        end: toIso(end),
        timeZone: invitee.timeZone,
        hostName: selectedHosts.join(', '),
        inviteeName: invitee.name,
        inviteeEmail: invitee.email,
      })
      const { id, manageToken } = await insertBooking(trx, {
        successRedirect,
        groupSlotId: groupSlot?.id,
        organizationId: current.organizationId,
        eventTypeId: current.id,
        start: input.start,
        end,
        title: `${current.title} with ${invitee.name}`,
        location: groupSlot ? groupSlot.location : choice.location,
        locationOption: groupSlot ? groupSlot.locationOption : choice.locationOption,
        responses,
        source: origin.source,
        apiKeyId: origin.apiKeyId,
        oauthConsentId: origin.oauthConsentId ?? null,
        idempotency: scope && { key: scope.key, fingerprint: scope.fingerprint },
        hostUserIds: selectedHostIds,
        hostsUseDefaultSchedule: current.schedulingType !== 'individual',
        attendees: [invitee, ...guests],
        notificationSnapshot: snapshot,
      })
      if (oneTimeLink) await claimOneTimeBookingLink(trx, oneTimeLink.token, id)
      // In this transaction, and never on the replay paths: one set of emails per booking,
      // queued only if the booking commits.
      if (ctx.waitlistSecret && input.waitlistToken !== undefined) {
        await attributeWaitlistBooking(trx, {
          secret: ctx.waitlistSecret,
          token: input.waitlistToken,
          eventTypeId: current.id,
          bookingId: id,
          email: invitee.email,
          start: input.start,
          end,
          now: ctx.now,
        })
      }
      await auditBooking(trx, current.organizationId, id, 'booking.created', {
        ...origin,
        requestId: origin.requestId ?? ctx.requestId,
      })
      if (groupSlot?.existing) await prepareBookingConference(ctx, trx, id)
      else
        await prepareChosenBookingConference(
          ctx,
          trx,
          id,
          isPreservedSingleton(current.locations, input.locationOptionId),
        )
      await ctx.notify?.(trx, { type: 'created', bookingId: id, start: input.start }, now)
      return {
        booking: await loadBooking(trx, id),
        manageToken,
        replayed: false,
        ...(successRedirect && { successRedirect }),
      }
    })
  } catch (err) {
    // The same key was committed concurrently for another host (the lock did not apply).
    const { code, constraint } = pgError(err)
    if (scope && code === '23505' && constraint === 'bookings_idempotency') {
      const replay = await findReplay(ctx.db, scope)
      if (replay) return { ...replay, replayed: true }
    }
    if (code === '23505' && constraint === 'bookings_group_active_mailbox')
      throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
    throw err
  }
}

// --- Invitee links (manage token) ---------------------------------------------------------

/**
 * The booking behind a manage token (resolveManagedTarget says which), also once it is
 * cancelled; `booking_not_found` when the token is missing or unknown.
 */
export async function getManagedBooking(
  ctx: PublicContext,
  token: string | undefined,
): Promise<Booking> {
  const hash = manageTokenHash(token)
  const target = hash && (await resolveManagedTarget(ctx.db, hash))
  if (!target) throw bookingNotFound()
  return loadBooking(ctx.db, target.id, ctx.now())
}

/** What became of a host's request, as the invitee's request email link reports it. */
export type ManagedRescheduleRequestState =
  | 'pending'
  | 'expired'
  | 'replaced'
  | 'rescheduled'
  | 'cancelled'

const CLOSED_REQUEST_STATES: Readonly<Record<string, ManagedRescheduleRequestState>> = {
  expired: 'expired',
  replaced: 'replaced',
  // Any move resolves the request, by the invitee or by a host.
  picked: 'rescheduled',
  cancelled: 'cancelled',
}

/**
 * The request a reschedule request email's own link was sent for, and what became of it.
 * Undefined for every other manage token: only that email's token names its request, and
 * only a request of the booking the email was about.
 */
export async function managedLinkRescheduleRequest(
  ctx: PublicContext,
  token: string | undefined,
): Promise<{ id: string; state: ManagedRescheduleRequestState } | undefined> {
  const hash = manageTokenHash(token)
  if (!hash) return undefined
  const { rows } = await sql<{ id: string; state: string; expires_at: Date }>`
    SELECT r.id, r.state, r.expires_at
      FROM booking_notifications n
      JOIN booking_reschedule_requests r
        ON r.booking_id = n.booking_id AND r.id::text = n.message_key
     WHERE n.manage_token_hash = ${hash} AND n.outcome = 'sent'
       AND n.kind = 'reschedule_requested'`.execute(ctx.db)
  const row = rows[0]
  if (!row) return undefined
  // An expiry job can run late; the deadline alone closes the request.
  const state =
    row.state === 'pending'
      ? row.expires_at.getTime() > ctx.now().epochMilliseconds
        ? 'pending'
        : 'expired'
      : CLOSED_REQUEST_STATES[row.state]
  return state && { id: row.id, state }
}

/** Cancels through a manage link: `booking_cancelled` if already cancelled, `booking_in_past` once started. */
export async function cancelManagedBooking(
  ctx: PublicContext,
  token: string | undefined,
  {
    reason,
    rescheduleRequestId,
  }: { reason?: string | undefined; rescheduleRequestId?: string | undefined } = {},
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<Booking> {
  const hash = manageTokenHash(token)
  if (!hash) throw bookingNotFound()
  const cancelReason = normalizeReason(reason)
  return ctx.db.transaction().execute(async (trx) => {
    const target = await resolveManagedTarget(trx, hash)
    const parent =
      target &&
      (await trx
        .selectFrom('bookings')
        .select('organization_id')
        .where('id', '=', target.id)
        .executeTakeFirst())
    if (!parent || !target) throw bookingNotFound()
    await lockCancellationOrganization(trx, parent.organization_id)
    await lockGroupBooking(trx, target.id)
    const row = await lockManagedBooking(trx, hash)
    if (!row) throw bookingNotFound()
    if (rescheduleRequestId) {
      const request = await managedRequest(trx, row.id, rescheduleRequestId)
      if (request.state === 'cancelled') return loadBooking(trx, row.id)
      if (
        request.state !== 'pending' ||
        Temporal.Instant.compare(toInstant(request.expires_at), ctx.now()) <= 0
      )
        throw requestChanged()
    }
    return cancelLocked(
      trx,
      row,
      ctx.now(),
      cancelReason,
      ctx.notify,
      origin,
      origin.actorUserId ?? null,
    )
  })
}

/**
 * Moves a booking through its manage link: in one transaction the booking is cancelled and
 * a new one (rescheduled_from_id → old) is created at `start`, which must be offered with
 * the old booking ignored (so the new time may overlap the old one). Returns the new
 * booking with a new manage token. The token the API returned for the old booking then
 * shows the cancelled booking; tokens from emails about it open the new one. The new
 * booking is recorded as made by `origin`.
 */
export async function rescheduleManagedBooking(
  ctx: PublicContext,
  token: string | undefined,
  {
    start,
    durationMinutes,
    rescheduleRequestId,
    idempotencyKey,
    expectedGroupSlotId,
  }: {
    start: Temporal.Instant
    durationMinutes?: number | undefined
    rescheduleRequestId?: string | undefined
    idempotencyKey?: string | undefined
    expectedGroupSlotId?: string | undefined
  },
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<BookingWithToken> {
  const hash = manageTokenHash(token)
  if (!hash) throw bookingNotFound()
  return ctx.db.transaction().execute(async (trx) => {
    const receiptReplay = await groupCapabilityMoveReplay(
      trx,
      hash,
      { start, durationMinutes, idempotencyKey, expectedGroupSlotId },
      origin,
    )
    if (receiptReplay) return receiptReplay
    const target = await resolveManagedTarget(trx, hash)
    const parent =
      target &&
      (await trx
        .selectFrom('bookings')
        .select('organization_id')
        .where('id', '=', target.id)
        .executeTakeFirst())
    if (!parent || !target) throw bookingNotFound()
    await lockOrganization(trx, parent.organization_id)
    await lockGroupBooking(trx, target.id, start, durationMinutes)
    const old = await lockManagedBooking(trx, hash)
    if (!old) throw bookingNotFound()
    if (rescheduleRequestId) {
      const request = await managedRequest(trx, old.id, rescheduleRequestId)
      if (request.state === 'picked' && request.picked_booking_id) {
        const booking = await loadBooking(trx, request.picked_booking_id)
        if (
          Temporal.Instant.compare(Temporal.Instant.from(booking.start), start) !== 0 ||
          (durationMinutes !== undefined &&
            Temporal.Instant.from(booking.end)
              .since(Temporal.Instant.from(booking.start))
              .total('minutes') !== durationMinutes)
        )
          throw requestChanged()
        return { booking, manageToken: null }
      }
      if (
        request.state !== 'pending' ||
        Temporal.Instant.compare(toInstant(request.expires_at), ctx.now()) <= 0
      )
        throw requestChanged()
    }
    return replayableGroupMove(
      ctx,
      trx,
      old,
      { start, durationMinutes, idempotencyKey, expectedGroupSlotId },
      origin,
      false,
      {
        kind: 'capability',
        hash: groupMoveCapabilityAuthority(hash, origin),
      },
    )
  })
}

/** The same transactional move for a locked invitee or authenticated host booking. */
async function rescheduleLocked(
  ctx: PublicContext,
  trx: Db,
  old: NonNullable<Awaited<ReturnType<typeof lockManagedBooking>>>,
  start: Temporal.Instant,
  origin: BookingOrigin,
  carryManageToken = false,
  selectedDuration?: number | undefined,
  expectedGroupSlotId?: string | undefined,
): Promise<BookingWithToken> {
  await assertBookingLocallyManaged(trx, old.id)
  // The status cannot change while the row is locked; the time check waits for the locks.
  if (old.status === 'cancelled') throw bookingCancelled()
  if (old.group_slot_id)
    return rescheduleGroupLocked(
      ctx,
      trx,
      old,
      start,
      origin,
      carryManageToken,
      selectedDuration,
      expectedGroupSlotId,
    )
  if (!carryManageToken) await assertInviteeRescheduleAllowed({ ...ctx, db: trx }, old.id)

  const [hosts, attendees] = await Promise.all([
    trx.selectFrom('booking_hosts').select('user_id').where('booking_id', '=', old.id).execute(),
    trx
      .selectFrom('booking_attendees')
      .select(['name', 'email', 'time_zone', 'locale', 'is_booker'])
      .where('booking_id', '=', old.id)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute(),
  ])
  const hostUserIds = old.required_host_user_ids.length
    ? [...old.required_host_user_ids].sort()
    : hosts.map((h) => h.user_id).sort()
  await lockHosts(trx, hostUserIds)
  await bookingHostIds(trx, old.id, old.organization_id, old.required_host_user_ids, true)
  const eventType =
    old.event_type_id === null
      ? undefined
      : await trx
          .selectFrom('event_types')
          .select(['id', 'duration_minutes', 'allowed_durations_minutes'])
          .where('id', '=', old.event_type_id)
          .where('is_active', '=', true)
          .where('deleted_at', 'is', null)
          .forShare()
          .executeTakeFirst()
  // Settings saves can hold the event row while we wait. Sample the decision clock
  // after that lock too, for both the lifecycle cutoff and reminder minimum gap.
  const now = ctx.now()
  assertChangeable(old, now)
  if (!eventType) {
    throw new DomainError(
      'conflict',
      'event_type_unavailable',
      'This event type no longer takes bookings',
    )
  }
  // The persisted endpoints are the duration snapshot. A later default/list edit must
  // not silently change a meeting when its invitee or host only chooses another time.
  const durationMinutes =
    selectedDuration === undefined
      ? toInstant(old.end_at).since(toInstant(old.start_at)).total({ unit: 'minutes' })
      : selectDurationMinutes(
          {
            durationMinutes: eventType.duration_minutes,
            allowedDurationsMinutes: eventType.allowed_durations_minutes,
          },
          selectedDuration,
        )
  const end = start.add({ minutes: durationMinutes })
  for (const hostUserId of hostUserIds) {
    await requireOfferedSlot(trx, {
      eventTypeId: eventType.id,
      hostUserId,
      start,
      end,
      now,
      durationMinutes: selectedDuration,
      excludeBookingId: old.id,
      useDefaultSchedule: old.hosts_use_default_schedule || hostUserIds.length > 1,
    })
  }

  // Cancel first: the trigger frees the old host rows, so the new time may overlap them.
  await trx
    .updateTable('bookings')
    .set({
      status: 'cancelled',
      cancelled_at: now.toString(),
      cancelled_source: origin.source,
      cancelled_api_key_id: origin.apiKeyId,
      cancelled_oauth_consent_id: origin.oauthConsentId ?? null,
      ...(carryManageToken ? { manage_token_hash: null } : {}),
    })
    .where('id', '=', old.id)
    .execute()
  const { id, manageToken } = await insertBooking(trx, {
    organizationId: old.organization_id,
    eventTypeId: eventType.id,
    start,
    end,
    title: old.title,
    location: parseLocation(old.location),
    locationOption: old.location_option,
    responses: (isRecord(old.responses) ? old.responses : {}) as Responses,
    source: origin.source,
    apiKeyId: origin.apiKeyId,
    oauthConsentId: origin.oauthConsentId ?? null,
    rescheduledFromId: old.id,
    manageTokenHash: carryManageToken ? old.manage_token_hash : undefined,
    hostUserIds,
    hostsUseDefaultSchedule: old.hosts_use_default_schedule || hostUserIds.length > 1,
    notificationSnapshot: notificationSnapshot(old.notification_snapshot),
    attendees: attendees.map((a) => ({
      name: a.name,
      email: a.email,
      timeZone: a.time_zone,
      locale: a.locale,
      isBooker: a.is_booker,
    })),
  })
  await resolveRescheduleRequest(trx, old.id, 'picked', now)
  await trx
    .updateTable('booking_reschedule_requests')
    .set({ picked_booking_id: id })
    .where('booking_id', '=', old.id)
    .where('state', '=', 'picked')
    .where('picked_booking_id', 'is', null)
    .execute()
  await skipScheduledMessages(trx, old.id, 'booking_replaced')
  // In this transaction: the new booking's emails. The old booking's queued ones find it
  // cancelled and replaced when they run, and send nothing.
  await auditBooking(trx, old.organization_id, id, 'booking.rescheduled', {
    ...origin,
    requestId: origin.requestId ?? ctx.requestId,
  })
  await prepareBookingConference(ctx, trx, id)
  await ctx.notify?.(trx, { type: 'rescheduled', bookingId: id, start }, now)
  return { booking: await loadBooking(trx, id), manageToken }
}

function groupMoveCapabilityAuthority(hash: Buffer, origin: BookingOrigin): Buffer {
  return sha256(
    canonicalJson({
      purpose: 'group-move',
      tokenHash: hash.toString('hex'),
      apiKeyId: origin.apiKeyId,
      oauthConsentId: origin.oauthConsentId ?? null,
    }),
  )
}

/** A retained capability is reauthorized before receipt lookup, without following its chain. */
async function groupCapabilityMoveReplay(
  db: Db,
  hash: Buffer,
  input: {
    start: Temporal.Instant
    durationMinutes?: number | undefined
    idempotencyKey?: string | undefined
    expectedGroupSlotId?: string | undefined
  },
  origin: BookingOrigin,
): Promise<BookingWithToken | undefined> {
  if (input.idempotencyKey === undefined) return undefined
  const receipt = await db
    .selectFrom('group_booking_move_receipts as r')
    .select(['r.fingerprint', 'r.result_booking_id'])
    .where('r.authority_kind', '=', 'capability')
    .where('r.authority_hash', '=', groupMoveCapabilityAuthority(hash, origin))
    .where('r.request_key', '=', input.idempotencyKey)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('bookings as b')
            .select('b.id')
            .whereRef('b.organization_id', '=', 'r.organization_id')
            .where('b.manage_token_hash', '=', hash),
        ),
        eb.exists(
          eb
            .selectFrom('booking_notifications as n')
            .innerJoin('bookings as b', 'b.id', 'n.booking_id')
            .select('b.id')
            .whereRef('b.organization_id', '=', 'r.organization_id')
            .where('n.manage_token_hash', '=', hash)
            .where('n.outcome', '=', 'sent'),
        ),
      ]),
    )
    .executeTakeFirst()
  if (!receipt) return undefined
  const fingerprint = sha256(
    canonicalJson({
      start: input.start.toString(),
      durationMinutes: input.durationMinutes,
      expectedGroupSlotId: input.expectedGroupSlotId,
    }),
  )
  if (!receipt.fingerprint.equals(fingerprint))
    throw new DomainError(
      'conflict',
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different request',
    )
  return { booking: await loadBooking(db, receipt.result_booking_id), manageToken: null }
}

/** Receipt lookup precedes lifecycle/fullness checks and never recovers a raw capability. */
async function replayableGroupMove(
  ctx: PublicContext,
  trx: Db,
  old: NonNullable<Awaited<ReturnType<typeof lockManagedBooking>>>,
  input: {
    start: Temporal.Instant
    durationMinutes?: number | undefined
    idempotencyKey?: string | undefined
    expectedGroupSlotId?: string | undefined
  },
  origin: BookingOrigin,
  carry: boolean,
  authority: { kind: string; hash: Buffer; sourceId?: string },
): Promise<BookingWithToken> {
  if (old.group_slot_id && input.idempotencyKey === undefined)
    throw new DomainError(
      'invalid',
      'invalid_idempotency_key',
      'Group rescheduling requires an Idempotency-Key',
    )
  if (!old.group_slot_id || input.idempotencyKey === undefined)
    return rescheduleLocked(
      ctx,
      trx,
      old,
      input.start,
      origin,
      carry,
      input.durationMinutes,
      input.expectedGroupSlotId,
    )
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
    throw new DomainError(
      'invalid',
      'invalid_idempotency_key',
      'Idempotency-Key must be 1 to 255 printable ASCII characters',
    )
  const fingerprint = sha256(
    canonicalJson({
      sourceId: authority.sourceId,
      start: input.start.toString(),
      durationMinutes: input.durationMinutes,
      expectedGroupSlotId: input.expectedGroupSlotId,
    }),
  )
  const receipt = await trx
    .selectFrom('group_booking_move_receipts')
    .selectAll()
    .where('organization_id', '=', old.organization_id)
    .where('authority_kind', '=', authority.kind)
    .where('authority_hash', '=', authority.hash)
    .where('request_key', '=', input.idempotencyKey)
    .executeTakeFirst()
  if (receipt) {
    if (!receipt.fingerprint.equals(fingerprint))
      throw new DomainError(
        'conflict',
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different request',
      )
    return { booking: await loadBooking(trx, receipt.result_booking_id), manageToken: null }
  }
  const result = await rescheduleLocked(
    ctx,
    trx,
    old,
    input.start,
    origin,
    carry,
    input.durationMinutes,
    input.expectedGroupSlotId,
  )
  const successor = await trx
    .selectFrom('bookings')
    .select('group_slot_id')
    .where('id', '=', result.booking.id)
    .executeTakeFirstOrThrow()
  if (!successor.group_slot_id) throw new Error('Group move lost its slot binding')
  await trx
    .insertInto('group_booking_move_receipts')
    .values({
      organization_id: old.organization_id,
      authority_kind: authority.kind,
      authority_hash: authority.hash,
      request_key: input.idempotencyKey,
      fingerprint,
      source_booking_id: old.id,
      result_booking_id: result.booking.id,
      source_group_slot_id: old.group_slot_id,
      result_group_slot_id: successor.group_slot_id,
      is_noop: old.id === result.booking.id,
    })
    .execute()
  return result
}

/** A group move retires only the moving seat, then admits its successor atomically. */
async function rescheduleGroupLocked(
  ctx: PublicContext,
  trx: Db,
  old: NonNullable<Awaited<ReturnType<typeof lockManagedBooking>>>,
  start: Temporal.Instant,
  origin: BookingOrigin,
  carry: boolean,
  selectedDuration?: number,
  expectedGroupSlotId?: string | undefined,
): Promise<BookingWithToken> {
  await bookingHostIds(trx, old.id, old.organization_id, old.required_host_user_ids, true)
  const event =
    old.event_type_id && (await findOneTimeEventType(trx, old.event_type_id, { lock: true }))
  if (!event || event.hostUserIds.join() !== old.required_host_user_ids.join())
    throw new DomainError(
      'conflict',
      'event_type_unavailable',
      'This event type no longer takes bookings',
    )
  const duration =
    selectedDuration === undefined
      ? toInstant(old.end_at).since(toInstant(old.start_at)).total({ unit: 'minutes' })
      : selectDurationMinutes(event, selectedDuration)
  const end = start.add({ minutes: duration })
  const now = ctx.now()
  assertChangeable(old, now)
  if (
    expectedGroupSlotId !== undefined &&
    start.equals(toInstant(old.start_at)) &&
    end.equals(toInstant(old.end_at)) &&
    expectedGroupSlotId !== old.group_slot_id
  )
    throw new DomainError(
      'conflict',
      'group_slot_changed',
      'This slot changed; choose a time again',
    )
  if (start.equals(toInstant(old.start_at)) && end.equals(toInstant(old.end_at)))
    return { booking: await loadBooking(trx, old.id), manageToken: null }
  if (!carry) await assertInviteeRescheduleAllowed({ ...ctx, db: trx }, old.id)
  const attendees = await trx
    .selectFrom('booking_attendees')
    .selectAll()
    .where('booking_id', '=', old.id)
    .execute()
  // A survivor keeps source occupancy. Final-seat retirement releases it before the
  // exact target check; any target failure rolls this entire transaction back.
  await trx
    .updateTable('bookings')
    .set({
      status: 'cancelled',
      cancelled_at: now.toString(),
      cancelled_source: origin.source,
      cancelled_api_key_id: origin.apiKeyId,
      cancelled_oauth_consent_id: origin.oauthConsentId ?? null,
      ...(carry ? { manage_token_hash: null } : {}),
    })
    .where('id', '=', old.id)
    .execute()
  const snapshot = notificationSnapshot(old.notification_snapshot)
  const slot = await admitGroupSlot(trx, {
    event,
    start,
    end,
    now,
    snapshot,
    bookerEmail: attendees[0]?.email ?? '',
    preserveDurationBookingId: selectedDuration === undefined ? old.id : undefined,
    sourceSlotId: old.group_slot_id ?? undefined,
    expectedSlotId: expectedGroupSlotId,
  })
  if (!slot)
    throw new DomainError(
      'conflict',
      'event_type_unavailable',
      'This event type no longer takes group bookings',
    )
  const result = await insertBooking(trx, {
    organizationId: old.organization_id,
    eventTypeId: event.id,
    groupSlotId: slot.id,
    locationOption: slot.locationOption,
    start,
    end,
    title: old.title,
    location: slot.location,
    responses: old.responses as Responses,
    source: origin.source,
    apiKeyId: origin.apiKeyId,
    oauthConsentId: origin.oauthConsentId,
    rescheduledFromId: old.id,
    manageTokenHash: carry ? old.manage_token_hash : undefined,
    hostUserIds: event.hostUserIds,
    hostsUseDefaultSchedule: false,
    notificationSnapshot: snapshot,
    attendees: attendees.map((a) => ({
      name: a.name,
      email: a.email,
      timeZone: a.time_zone,
      locale: a.locale,
      isBooker: a.is_booker,
    })),
  })
  await skipScheduledMessages(trx, old.id, 'booking_replaced')
  await cancelBookingConference(trx, old.id, now)
  await auditBooking(trx, old.organization_id, result.id, 'booking.rescheduled', {
    ...origin,
    requestId: origin.requestId ?? ctx.requestId,
  })
  await prepareBookingConference(ctx, trx, result.id)
  await ctx.notify?.(trx, { type: 'rescheduled', bookingId: result.id, start }, now)
  return { booking: await loadBooking(trx, result.id), manageToken: result.manageToken }
}

// --- Host side ----------------------------------------------------------------------------

export { DEFAULT_PAGE_SIZE, type ListBookingsInput, MAX_PAGE_SIZE } from './booking-page.ts'

export interface BookingPage {
  data: Booking[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

/**
 * Bookings of the caller's organization that the caller hosts, ordered by start (then id)
 * in the requested direction (ascending by default), a stable keyset page at a time.
 */
export async function listHostBookings(
  ctx: ServiceContext,
  input: ListBookingsInput = {},
): Promise<BookingPage> {
  const { query, limit } = bookingPageQuery(ctx.db, input)
  const rows = await query
    .innerJoin(resolvedBookingHosts(ctx.db).as('bh'), 'bh.booking_id', 'b.id')
    .leftJoin('event_types as et', (join) =>
      join.onRef('et.id', '=', 'b.event_type_id').on('et.deleted_at', 'is', null),
    )
    .select(BOOKING_COLUMNS)
    .select('et.title as event_type_title')
    .where('bh.user_id', '=', ctx.principal.user.id)
    .where('b.organization_id', '=', ctx.principal.organization.id)
    .execute()

  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: await toBookings(ctx.db, page, { userId: ctx.principal.user.id, now: ctx.now }),
    nextCursor: rows.length > limit && last ? encodeBookingCursor(last) : null,
  }
}

/** A booking of the caller's organization that the caller hosts; else `booking_not_found`. */
export async function getHostBooking(ctx: ServiceContext, id: string): Promise<Booking> {
  if (!UUID.test(id)) throw bookingNotFound()
  const row = await ctx.db
    .selectFrom('bookings as b')
    .innerJoin(resolvedBookingHosts(ctx.db).as('bh'), 'bh.booking_id', 'b.id')
    .leftJoin('event_types as et', (join) =>
      join.onRef('et.id', '=', 'b.event_type_id').on('et.deleted_at', 'is', null),
    )
    .select(BOOKING_COLUMNS)
    .select('et.title as event_type_title')
    .where('b.id', '=', id)
    .where('b.status', 'in', ['confirmed', 'cancelled'])
    .where((eb) =>
      eb.or([
        eb('b.payment_hold_expires_at', 'is', null),
        eb('b.payment_confirmed_at', 'is not', null),
      ]),
    )
    .where('bh.user_id', '=', ctx.principal.user.id)
    .where('b.organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (!row) throw bookingNotFound()
  const [booking] = await toBookings(ctx.db, [row], {
    userId: ctx.principal.user.id,
    now: ctx.now,
  })
  return booking as Booking
}

/**
 * Moves a booking in the caller's organization that the caller hosts; never follows an old id.
 * Transfers the invitee's token hash to the successor and returns manageToken: null.
 */
export async function rescheduleHostBooking(
  ctx: ServiceContext,
  id: string,
  {
    start,
    durationMinutes,
    idempotencyKey,
    expectedGroupSlotId,
  }: {
    start: Temporal.Instant
    durationMinutes?: number | undefined
    idempotencyKey?: string | undefined
    expectedGroupSlotId?: string | undefined
  },
  origin?: BookingOrigin,
): Promise<BookingWithToken> {
  if (!UUID.test(id)) throw bookingNotFound()
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockOrganization(trx, ctx.principal.organization.id)
    await lockGroupBooking(trx, id, start, durationMinutes, ctx.principal.organization.id)
    const old = await trx
      .selectFrom('bookings')
      .select(RESCHEDULE_COLUMNS)
      .where('id', '=', id)
      .where('organization_id', '=', ctx.principal.organization.id)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom(resolvedBookingHosts(trx).as('booking_host'))
            .select('booking_id')
            .whereRef('booking_host.booking_id', '=', 'bookings.id')
            .where('booking_host.user_id', '=', ctx.principal.user.id),
        ),
      )
      .forUpdate()
      .executeTakeFirst()
    if (!old) throw bookingNotFound()
    return replayableGroupMove(
      ctx,
      trx,
      old,
      { start, durationMinutes, idempotencyKey, expectedGroupSlotId },
      {
        ...(origin ?? {
          source:
            ctx.principal.kind === 'api_key'
              ? 'api'
              : ctx.principal.kind === 'oauth'
                ? 'mcp'
                : 'web',
          apiKeyId: ctx.principal.kind === 'api_key' ? ctx.principal.apiKeyId : null,
          oauthConsentId: ctx.principal.kind === 'oauth' ? ctx.principal.oauthConsentId : null,
        }),
        audit: auditActor(ctx.principal),
        requestId: ctx.requestId,
      },
      true,
      {
        kind: ctx.principal.kind,
        hash: sha256(
          canonicalJson({
            purpose: 'group-move',
            userId: ctx.principal.user.id,
            organizationId: ctx.principal.organization.id,
            credential:
              ctx.principal.kind === 'api_key'
                ? ctx.principal.apiKeyId
                : ctx.principal.kind === 'oauth'
                  ? ctx.principal.oauthConsentId
                  : ctx.principal.user.id,
          }),
        ),
        sourceId: id,
      },
    )
  })
}

/** Cancels a booking the caller hosts, with the same rules as the invitee's link. */
export async function cancelHostBooking(
  ctx: ServiceContext,
  id: string,
  { reason }: { reason?: string | undefined } = {},
  origin?: BookingOrigin,
): Promise<Booking> {
  if (!UUID.test(id)) throw bookingNotFound()
  const cancelReason = normalizeReason(reason)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockCancellationOrganization(trx, ctx.principal.organization.id)
    await lockGroupBooking(trx, id, undefined, undefined, ctx.principal.organization.id)
    const row = await trx
      .selectFrom('bookings as b')
      .innerJoin(resolvedBookingHosts(trx).as('bh'), 'bh.booking_id', 'b.id')
      .select(['b.id', 'b.organization_id', 'b.status', 'b.start_at'])
      .where('b.id', '=', id)
      .where('bh.user_id', '=', ctx.principal.user.id)
      .where('b.organization_id', '=', ctx.principal.organization.id)
      .forUpdate('b')
      .executeTakeFirst()
    if (!row) throw bookingNotFound()
    return cancelLocked(
      trx,
      row,
      ctx.now(),
      cancelReason,
      ctx.notify,
      {
        ...(origin ?? {
          source:
            ctx.principal.kind === 'api_key'
              ? 'api'
              : ctx.principal.kind === 'oauth'
                ? 'mcp'
                : 'web',
          apiKeyId: ctx.principal.kind === 'api_key' ? ctx.principal.apiKeyId : null,
          oauthConsentId: ctx.principal.kind === 'oauth' ? ctx.principal.oauthConsentId : null,
        }),
        audit: auditActor(ctx.principal),
        requestId: ctx.requestId,
      },
      ctx.principal.user.id,
    )
  })
}

/**
 * Cancellation inside the shared team-management write transaction. The caller must use
 * that check's returned actor and transaction; this helper supplies no authorization of
 * its own. The caller can reload its normal minimal team projection after the write.
 * Read the clock after the booking lock, so waiting cannot extend the cancellation window.
 * Existing host and manage-token entry points keep their original access rules.
 */
export async function cancelTeamBookingInTransaction(
  trx: Transaction<Database>,
  actor: { userId: string; organizationId: string },
  id: string,
  now: () => Temporal.Instant,
  options: {
    reason?: string | undefined
    notify?: BookingNotifier | undefined
    sessionId?: string | undefined
  } = {},
): Promise<void> {
  if (!trx.isTransaction) throw new Error('Team cancellation requires a transaction')
  if (!UUID.test(id)) throw bookingNotFound()
  await lockGroupBooking(trx, id, undefined, undefined, actor.organizationId)
  const row = await trx
    .selectFrom('bookings')
    .select(['id', 'organization_id', 'status', 'start_at'])
    .where('id', '=', id)
    .where('organization_id', '=', actor.organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw bookingNotFound()
  await cancelLocked(
    trx,
    row,
    now(),
    normalizeReason(options.reason),
    options.notify,
    {
      ...BOOKING_PAGE,
      audit: {
        actor: { type: 'user', id: actor.userId },
        credential: { type: 'session', ...(options.sessionId ? { id: options.sessionId } : {}) },
      },
    },
    actor.userId,
  )
}

/** Stored UUIDs are lowercase; metadata and requests may use any UUID spelling. */
const sameUuid = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase()

async function auditBooking(
  trx: Db,
  organizationId: string,
  targetId: string,
  action:
    | 'booking.created'
    | 'booking.rescheduled'
    | 'booking.cancelled'
    | 'booking.reschedule_requested',
  origin: BookingOrigin,
) {
  const auditKeyId =
    origin.audit?.credential.type === 'api_key' ? origin.audit.credential.id : origin.apiKeyId
  const key = auditKeyId
    ? await trx
        .selectFrom('auth.apikey')
        .select(['metadata', 'referenceId'])
        .where('id', '=', auditKeyId)
        .executeTakeFirst()
    : undefined
  const auditGrantId =
    origin.audit?.credential.type === 'oauth'
      ? origin.audit.credential.grantId
      : origin.audit
        ? undefined
        : origin.oauthConsentId
  const grant = auditGrantId
    ? await trx
        .selectFrom('mcp_oauth_grants')
        .select(['client_id', 'user_id', 'organization_id'])
        .where('id', '=', auditGrantId)
        .executeTakeFirst()
    : undefined
  if (!origin.audit && origin.oauthConsentId && !grant)
    throw new Error('Missing OAuth audit identity')
  const keyMetadata = parsePersistedApiKeyMetadata(key?.metadata ?? null)
  const keyOrganizationId = auditKeyId
    ? (keyMetadata?.organizationId ??
      (key
        ? (
            await trx
              .selectFrom('personal_organizations')
              .select('organization_id')
              .where('user_id', '=', key.referenceId)
              .executeTakeFirst()
          )?.organization_id
        : undefined))
    : undefined
  // A caller authorized for another organization (or whose credential can no longer be
  // resolved to this one) is recorded without its key, user, client or grant identifiers.
  const identity =
    auditKeyId && !sameUuid(keyOrganizationId, organizationId)
      ? { actor: { type: 'external_api_key' as const }, credential: { type: 'none' as const } }
      : auditGrantId && !sameUuid(grant?.organization_id, organizationId)
        ? {
            actor: { type: 'external_oauth_client' as const },
            credential: { type: 'none' as const },
          }
        : (origin.audit ??
          (origin.apiKeyId
            ? {
                actor: { type: 'api_key' as const, id: origin.apiKeyId },
                credential: {
                  type: 'api_key' as const,
                  id: origin.apiKeyId,
                  ...(parsePersistedApiKeyMetadata(key?.metadata ?? null)?.scope
                    ? { scope: parsePersistedApiKeyMetadata(key?.metadata ?? null)?.scope }
                    : {}),
                },
              }
            : origin.oauthConsentId
              ? {
                  actor: {
                    type: 'user' as const,
                    id: grant?.user_id as string,
                  },
                  credential: {
                    type: 'oauth' as const,
                    grantId: origin.oauthConsentId,
                    ...(grant ? { clientId: grant.client_id } : {}),
                  },
                }
              : origin.actorUserId
                ? {
                    actor: { type: 'user' as const, id: origin.actorUserId },
                    credential: { type: 'session' as const },
                  }
                : { actor: { type: 'anonymous' as const }, credential: { type: 'none' as const } }))
  await writeAuditEvent(trx, {
    organizationId,
    ...identity,
    action,
    targetType: 'booking',
    targetId,
    requestId: origin.requestId,
  })
}

/** Requests expire after 48 hours, or at the original start, whichever comes first. */
export const RESCHEDULE_REQUEST_TIMEOUT_HOURS = 48

async function resolveRescheduleRequest(
  db: Db,
  bookingId: string,
  state: 'picked' | 'cancelled',
  now: Temporal.Instant,
) {
  await db
    .updateTable('booking_reschedule_requests')
    .set({ state, resolved_at: now.toString() })
    .where('booking_id', '=', bookingId)
    .where('state', '=', 'pending')
    .execute()
}

/** Share plain-text validation with transports so failures retain the public note path. */
export const RescheduleRequestNoteSchema = z
  .string()
  .max(2000)
  .superRefine((note, ctx) => {
    try {
      validateNotifications({
        reminders: [],
        followUps: [
          {
            id: 'request',
            offsetMinutes: 5,
            recipients: { host: false, invitee: true, guests: false },
            hostNote: note,
          },
        ],
      })
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'invalid_notifications') throw error
      ctx.addIssue({
        code: 'custom',
        message: error.message.replace('notifications.followUps[0].hostNote: ', ''),
      })
    }
  })

/** Host authorization and every lifecycle transition serialize on the original booking. */
export async function requestReschedule(
  ctx: ServiceContext,
  id: string,
  input: { idempotencyKey: string; note?: string | undefined },
): Promise<Booking> {
  if (!UUID.test(id)) throw bookingNotFound()
  if (!UUID.test(input.idempotencyKey))
    throw new DomainError('invalid', 'invalid_idempotency_key', 'Idempotency key must be a UUID')
  if (input.note !== undefined) {
    const parsed = z.object({ note: RescheduleRequestNoteSchema }).safeParse(input)
    if (!parsed.success)
      throw new DomainError(
        'invalid',
        'invalid_request',
        parsed.error.issues.map((issue) => `note: ${issue.message}`).join('; '),
      )
  }
  const note =
    input.note === undefined
      ? null
      : (validateNotifications({
          reminders: [],
          followUps: [
            {
              id: 'request',
              offsetMinutes: 5,
              recipients: { host: false, invitee: true, guests: false },
              hostNote: input.note,
            },
          ],
        })?.followUps[0]?.hostNote ?? null)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockOrganization(trx, ctx.principal.organization.id)
    const row = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', ctx.principal.organization.id)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('booking_hosts')
            .select('booking_id')
            .where((host) =>
              host.or([
                host('booking_hosts.booking_id', '=', host.ref('bookings.id')),
                host('booking_hosts.group_slot_id', '=', host.ref('bookings.group_slot_id')),
              ]),
            )
            .where('booking_hosts.user_id', '=', ctx.principal.user.id),
        ),
      )
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw bookingNotFound()
    await assertBookingLocallyManaged(trx, id)
    if (row.group_slot_id)
      throw new DomainError(
        'conflict',
        'booking_group_seat_unsupported',
        'Group-seat bookings do not support reschedule requests',
      )
    const previous = await trx
      .selectFrom('booking_reschedule_requests')
      .selectAll()
      .where('booking_id', '=', id)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()
    if (previous) {
      if (previous.note !== note)
        throw new DomainError(
          'conflict',
          'idempotency_key_reused',
          'This idempotency key was used for a different request',
        )
      return loadBooking(trx, id, ctx.now())
    }
    const now = ctx.now()
    assertChangeable(row, now)
    await trx
      .updateTable('booking_reschedule_requests')
      .set({ state: 'replaced', resolved_at: now.toString() })
      .where('booking_id', '=', id)
      .where('state', '=', 'pending')
      .execute()
    const deadline = now.add({ hours: RESCHEDULE_REQUEST_TIMEOUT_HOURS })
    const expires =
      Temporal.Instant.compare(deadline, toInstant(row.start_at)) < 0
        ? deadline
        : toInstant(row.start_at)
    const request = await trx
      .insertInto('booking_reschedule_requests')
      .values({
        booking_id: id,
        idempotency_key: input.idempotencyKey,
        note,
        state: 'pending',
        created_at: now.toString(),
        expires_at: expires.toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await auditBooking(trx, row.organization_id, row.id, 'booking.reschedule_requested', {
      source:
        ctx.principal.kind === 'api_key' ? 'api' : ctx.principal.kind === 'oauth' ? 'mcp' : 'web',
      apiKeyId: ctx.principal.kind === 'api_key' ? ctx.principal.apiKeyId : null,
      oauthConsentId: ctx.principal.kind === 'oauth' ? ctx.principal.oauthConsentId : null,
      audit: auditActor(ctx.principal),
      requestId: ctx.requestId,
    })
    await ctx.notify?.(
      trx,
      { type: 'reschedule_requested', bookingId: id, requestId: request.id },
      now,
    )
    return loadBooking(trx, id, ctx.now())
  })
}

/** Replayed, replaced and already resolved expiry jobs are harmless. */
export async function expireRescheduleRequest(
  ctx: Pick<PublicContext, 'db' | 'now' | 'notify'>,
  requestId: string,
): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom('booking_reschedule_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst()
    if (!request) return
    await trx
      .selectFrom('bookings')
      .select('id')
      .where('id', '=', request.booking_id)
      .forUpdate()
      .executeTakeFirst()
    const now = ctx.now()
    const expired = await trx
      .updateTable('booking_reschedule_requests')
      .set({ state: 'expired', resolved_at: now.toString() })
      .where('id', '=', requestId)
      .where('state', '=', 'pending')
      .where('expires_at', '<=', new Date(now.epochMilliseconds))
      .returning('id')
      .executeTakeFirst()
    if (expired)
      await ctx.notify?.(
        trx,
        { type: 'reschedule_request_expired', bookingId: request.booking_id, requestId },
        now,
      )
  })
}

function requestChanged() {
  return new DomainError(
    'conflict',
    'reschedule_request_changed',
    'This reschedule request has already been resolved or replaced',
  )
}
async function managedRequest(trx: Db, bookingId: string, requestId: string) {
  if (!UUID.test(requestId)) throw requestChanged()
  const request = await trx
    .selectFrom('booking_reschedule_requests')
    .selectAll()
    .where('id', '=', requestId)
    .where((eb) =>
      eb.or([eb('booking_id', '=', bookingId), eb('picked_booking_id', '=', bookingId)]),
    )
    .executeTakeFirst()
  if (!request) throw requestChanged()
  return request
}
