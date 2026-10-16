// Bookings: created from public pages, managed by invitees through their secret link, and
// listed and cancelled by hosts. Availability is always recomputed inside the transaction
// that writes, and the exclusion constraint on booking_hosts is the last word on overlaps.
import { createHash, randomBytes } from 'node:crypto'
import type { Db, Json } from '@hourmere/db'
import { type ExpressionBuilder, sql } from 'kysely'
import {
  eventTypeNotFound,
  findPublicEventType,
  findSlots,
  type Location,
  parseLocation,
  toInstant,
  toIso,
} from './availability.ts'
import type { BookingNotifier, PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { type Responses, validateResponses } from './questions.ts'
import { cleanText } from './text.ts'

export type BookingStatus = 'confirmed' | 'cancelled'
export type BookingSource = 'web' | 'embed' | 'api' | 'mcp'

export interface Attendee {
  name: string
  email: string
  timeZone: string
  locale: string | null
  /** The invitee who made the booking; the others are guests they added. */
  isBooker: boolean
}

export interface Booking {
  id: string
  eventTypeId: string | null
  status: BookingStatus
  start: string
  end: string
  title: string
  /** Where the meeting happens, with its details (number, address, link). */
  location: Location | null
  responses: Responses
  /** The invitee first, then guests. */
  attendees: Attendee[]
  /** The booking this one replaced when it was rescheduled. */
  rescheduledFromId: string | null
  cancelledAt: string | null
  cancelReason: string | null
  source: BookingSource
  createdAt: string
}

export interface BookingWithToken {
  booking: Booking
  /**
   * The booking's own manage token (it stays with this booking; emails carry their own).
   * Only its SHA-256 is stored, so it is returned once, when the booking is created; a
   * replayed request (same Idempotency-Key) gets null.
   */
  manageToken: string | null
}

export const MAX_GUESTS = 10
const MAX_NAME = 200
const MAX_EMAIL = 254
const MAX_LOCALE = 35
const MAX_REASON = 1000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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
  const email = cleanText(input.email, { max: MAX_EMAIL })
  if (email === undefined || !EMAIL.test(email)) {
    throw new DomainError('invalid', code, `${what} needs a valid email address`)
  }
  return { name, email }
}

function validateInvitee(input: InviteeInput): Attendee {
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
 * - `bookings.manage_token_hash`, the token the booking API returned: it stays with that
 *   booking. After a reschedule it shows the cancelled booking and acting on it gets
 *   `booking_cancelled`, so an agent retrying a reschedule cannot move the meeting twice.
 * - `booking_notifications.manage_token_hash`, the token in an invitee email (only emails
 *   that went out; one the mail server refused has no hash): it stands for the meeting the
 *   email was about, so it opens the latest booking of that booking's reschedule chain and
 *   a link in an older email keeps working.
 */
async function resolveManagedTarget(db: Db, hash: Buffer): Promise<ManagedTarget | undefined> {
  const { rows } = await sql<{ id: string; from_email: boolean }>`
    SELECT id, false AS from_email FROM bookings WHERE manage_token_hash = ${hash}
    UNION ALL
    SELECT booking_id, true FROM booking_notifications
     WHERE manage_token_hash = ${hash} AND outcome = 'sent'`.execute(db)
  // One hash in both tables would take 2^256 luck; the booking's own token would win.
  const row = rows.find((r) => !r.from_email) ?? rows[0]
  if (!row) return undefined
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

/** How often lockManagedBooking follows a meeting that keeps moving before giving up. */
const MAX_FOLLOW_ROUNDS = 10

/**
 * Locks (FOR UPDATE) and returns the booking a manage token acts on; call inside a
 * transaction. For an email's token, a reschedule that committed while this waited for the
 * lock has moved the meeting on, so the chain is followed again from the locked row until
 * the locked row is the latest (no reschedule can replace it while the lock is held). Each
 * further round means yet another reschedule of the meeting committed while this request
 * waited; after MAX_FOLLOW_ROUNDS of those it answers `booking_changed` (try again) rather
 * than chase the meeting indefinitely.
 */
async function lockManagedBooking(trx: Db, hash: Buffer) {
  const target = await resolveManagedTarget(trx, hash)
  if (!target) return undefined
  let id = target.id
  for (let round = 1; ; round++) {
    const row = await trx
      .selectFrom('bookings')
      .select([
        'id',
        'organization_id',
        'event_type_id',
        'status',
        'start_at',
        'title',
        'location',
        'responses',
      ])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!row || !target.fromEmail) return row
    const latest = await latestInChain(trx, id)
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
  key: string
  fingerprint: Buffer
}

/**
 * The booking an earlier request with this key created, if any. A different request
 * reusing the key is refused rather than answered with someone else's booking.
 */
async function findReplay(db: Db, scope: IdempotencyScope): Promise<BookingWithToken | undefined> {
  const row = await db
    .selectFrom('bookings')
    .select(['id', 'idempotency_fingerprint'])
    .where('organization_id', '=', scope.organizationId)
    .where('api_key_id', scope.apiKeyId === null ? 'is' : '=', scope.apiKeyId)
    .where('idempotency_key', '=', scope.key)
    .executeTakeFirst()
  if (!row) return undefined
  if (!row.idempotency_fingerprint?.equals(scope.fingerprint)) {
    throw new DomainError(
      'conflict',
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different request',
    )
  }
  return { booking: await loadBooking(db, row.id), manageToken: null }
}

const pgError = (err: unknown) =>
  (isRecord(err) ? err : {}) as { code?: unknown; constraint?: unknown }

// --- Reading bookings -------------------------------------------------------------------

const BOOKING_COLUMNS = [
  'b.id',
  'b.event_type_id',
  'b.status',
  'b.start_at',
  'b.end_at',
  'b.title',
  'b.location',
  'b.responses',
  'b.rescheduled_from_id',
  'b.cancelled_at',
  'b.cancel_reason',
  'b.source',
  'b.created_at',
] as const

interface BookingRow {
  id: string
  event_type_id: string | null
  status: string
  start_at: Date
  end_at: Date
  title: string
  location: Json | null
  responses: Json
  rescheduled_from_id: string | null
  cancelled_at: Date | null
  cancel_reason: string | null
  source: string
  created_at: Date
}

/** Adds the attendees (one query for all rows) and maps rows to the API shape. */
async function toBookings(db: Db, rows: readonly BookingRow[]): Promise<Booking[]> {
  if (!rows.length) return []
  const attendees = await db
    .selectFrom('booking_attendees')
    .select(['booking_id', 'name', 'email', 'time_zone', 'locale', 'is_booker'])
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
      name: a.name,
      email: a.email,
      timeZone: a.time_zone,
      locale: a.locale,
      isBooker: a.is_booker,
    })
    byBooking.set(a.booking_id, list)
  }
  return rows.map((r) => ({
    id: r.id,
    eventTypeId: r.event_type_id,
    status: r.status as BookingStatus,
    start: toIso(toInstant(r.start_at)),
    end: toIso(toInstant(r.end_at)),
    title: r.title,
    location: parseLocation(r.location),
    responses: (isRecord(r.responses) ? r.responses : {}) as Responses,
    attendees: byBooking.get(r.id) ?? [],
    rescheduledFromId: r.rescheduled_from_id,
    cancelledAt: r.cancelled_at && toIso(toInstant(r.cancelled_at)),
    cancelReason: r.cancel_reason,
    source: r.source as BookingSource,
    createdAt: toIso(toInstant(r.created_at)),
  }))
}

async function loadBooking(db: Db, id: string): Promise<Booking> {
  const row = await db
    .selectFrom('bookings as b')
    .select(BOOKING_COLUMNS)
    .where('b.id', '=', id)
    .executeTakeFirstOrThrow()
  const [booking] = await toBookings(db, [row])
  return booking as Booking
}

// --- Writing bookings -------------------------------------------------------------------

/**
 * Serializes booking writes per host for the rest of the transaction. The exclusion
 * constraint alone stops overlapping meetings, but not two concurrent bookings that only
 * collide through buffers or the daily limit; with the lock, the second one recomputes
 * availability after the first has committed. Sorted, so multi-host bookings cannot deadlock.
 */
async function lockHosts(db: Db, userIds: readonly string[]): Promise<void> {
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
async function requireOfferedSlot(
  db: Db,
  q: {
    eventTypeId: string
    hostUserId: string
    start: Temporal.Instant
    end: Temporal.Instant
    now: Temporal.Instant
    excludeBookingId?: string
  },
): Promise<void> {
  const slots = await findSlots(db, {
    eventTypeId: q.eventTypeId,
    hostUserId: q.hostUserId,
    rangeStart: q.start,
    rangeEnd: q.end,
    now: q.now,
    excludeBookingId: q.excludeBookingId,
  })
  if (!slots.some((s) => s.start.equals(q.start) && s.end.equals(q.end))) {
    throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
  }
}

interface NewBooking {
  organizationId: string
  eventTypeId: string | null
  start: Temporal.Instant
  end: Temporal.Instant
  title: string
  location: Location | null
  responses: Responses
  source: BookingSource
  apiKeyId: string | null
  idempotency?: { key: string; fingerprint: Buffer } | undefined
  rescheduledFromId?: string | undefined
  hostUserIds: readonly string[]
  attendees: readonly Attendee[]
}

/** Inserts a booking with its hosts and attendees; call inside a transaction. */
async function insertBooking(db: Db, b: NewBooking): Promise<{ id: string; manageToken: string }> {
  const { token, hash } = newManageToken()
  const { id } = await db
    .insertInto('bookings')
    .values({
      organization_id: b.organizationId,
      event_type_id: b.eventTypeId,
      start_at: b.start.toString(),
      end_at: b.end.toString(),
      title: b.title,
      location: b.location && JSON.stringify(b.location),
      responses: JSON.stringify(b.responses),
      manage_token_hash: hash,
      source: b.source,
      api_key_id: b.apiKeyId,
      idempotency_key: b.idempotency?.key ?? null,
      idempotency_fingerprint: b.idempotency?.fingerprint ?? null,
      rescheduled_from_id: b.rescheduledFromId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  if (b.hostUserIds.length) {
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

const bookingCancelled = () =>
  new DomainError('conflict', 'booking_cancelled', 'This booking is already cancelled')

function assertChangeable(row: { status: string; start_at: Date }, now: Temporal.Instant): void {
  if (row.status === 'cancelled') throw bookingCancelled()
  if (Temporal.Instant.compare(toInstant(row.start_at), now) <= 0) {
    throw new DomainError('conflict', 'booking_in_past', 'This booking has already started')
  }
}

async function cancelLocked(
  db: Db,
  row: { id: string; status: string; start_at: Date },
  now: Temporal.Instant,
  reason: string | null,
  notify: BookingNotifier | undefined,
): Promise<Booking> {
  assertChangeable(row, now)
  await db
    .updateTable('bookings')
    .set({ status: 'cancelled', cancelled_at: now.toString(), cancel_reason: reason })
    .where('id', '=', row.id)
    .execute()
  // In this transaction: the cancellation email exists exactly when the cancellation does.
  await notify?.(db, { type: 'cancelled', bookingId: row.id }, now)
  return loadBooking(db, row.id)
}

// --- Public booking -----------------------------------------------------------------------

export interface CreateBookingInput {
  handle: string
  slug: string
  start: Temporal.Instant
  invitee: InviteeInput
  guests?: readonly PersonInput[] | undefined
  responses?: Record<string, unknown> | undefined
  /**
   * Makes retries safe. Anonymous callers share one scope per organization, so this must
   * be random (e.g. a UUIDv4), never derived from the request.
   */
  idempotencyKey?: string | undefined
}

/**
 * Who made a booking, for the audit trail (`bookings.source` and `bookings.api_key_id`). The
 * booking page is `web` without a key; agents pass `api` or `mcp` with the key they used.
 */
export interface BookingOrigin {
  source: BookingSource
  /** The caller's API key. Idempotency keys are scoped to it; null shares one scope. */
  apiKeyId: string | null
}

const BOOKING_PAGE: BookingOrigin = { source: 'web', apiKeyId: null }

export interface CreateBookingResult extends BookingWithToken {
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
  const et = await findPublicEventType(ctx.db, input.handle, input.slug)
  if (!et) throw eventTypeNotFound()

  let scope: IdempotencyScope | undefined
  if (input.idempotencyKey !== undefined) {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new DomainError(
        'invalid',
        'invalid_idempotency_key',
        'Idempotency-Key must be 1 to 255 printable ASCII characters',
      )
    }
    const fingerprint = sha256(
      canonicalJson({
        eventTypeId: et.id,
        start: input.start.toString(),
        invitee: input.invitee,
        guests: input.guests ?? [],
        responses: input.responses ?? {},
      }),
    )
    scope = {
      organizationId: et.organizationId,
      apiKeyId: origin.apiKeyId,
      key: input.idempotencyKey,
      fingerprint,
    }
    const replay = await findReplay(ctx.db, scope)
    if (replay) return { ...replay, replayed: true }
  }

  // Fails fast before taking the lock; checked again below against the current questions.
  validateResponses(et.questions, input.responses ?? {})
  const invitee = validateInvitee(input.invitee)
  const guests = validateGuests(input.guests ?? [], invitee)

  try {
    return await ctx.db.transaction().execute(async (trx) => {
      await lockHosts(trx, [et.hostUserId])
      // A concurrent request with the same key may have committed while we waited.
      if (scope) {
        const replay = await findReplay(trx, scope)
        if (replay) return { ...replay, replayed: true }
      }
      // The event type may have changed while we waited (duration, questions, rules), and
      // waiting took time: read both again now that the host is locked.
      const current = await findPublicEventType(trx, input.handle, input.slug)
      if (!current || current.id !== et.id || current.hostUserId !== et.hostUserId) {
        throw eventTypeNotFound()
      }
      const now = ctx.now()
      const responses = validateResponses(current.questions, input.responses ?? {})
      const end = input.start.add({ minutes: current.durationMinutes })
      await requireOfferedSlot(trx, {
        eventTypeId: current.id,
        hostUserId: current.hostUserId,
        start: input.start,
        end,
        now,
      })
      const { id, manageToken } = await insertBooking(trx, {
        organizationId: current.organizationId,
        eventTypeId: current.id,
        start: input.start,
        end,
        title: `${current.title} with ${invitee.name}`,
        location: current.location,
        responses,
        source: origin.source,
        apiKeyId: origin.apiKeyId,
        idempotency: scope && { key: scope.key, fingerprint: scope.fingerprint },
        hostUserIds: [current.hostUserId],
        attendees: [invitee, ...guests],
      })
      // In this transaction, and never on the replay paths: one set of emails per booking,
      // queued only if the booking commits.
      await ctx.notify?.(trx, { type: 'created', bookingId: id, start: input.start }, now)
      return { booking: await loadBooking(trx, id), manageToken, replayed: false }
    })
  } catch (err) {
    // The same key was committed concurrently for another host (the lock did not apply).
    const { code, constraint } = pgError(err)
    if (scope && code === '23505' && constraint === 'bookings_idempotency') {
      const replay = await findReplay(ctx.db, scope)
      if (replay) return { ...replay, replayed: true }
    }
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
  return loadBooking(ctx.db, target.id)
}

/** Cancels through a manage link: `booking_cancelled` if already cancelled, `booking_in_past` once started. */
export async function cancelManagedBooking(
  ctx: PublicContext,
  token: string | undefined,
  { reason }: { reason?: string | undefined } = {},
): Promise<Booking> {
  const hash = manageTokenHash(token)
  if (!hash) throw bookingNotFound()
  const cancelReason = normalizeReason(reason)
  return ctx.db.transaction().execute(async (trx) => {
    const row = await lockManagedBooking(trx, hash)
    if (!row) throw bookingNotFound()
    return cancelLocked(trx, row, ctx.now(), cancelReason, ctx.notify)
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
  { start }: { start: Temporal.Instant },
  origin: BookingOrigin = BOOKING_PAGE,
): Promise<BookingWithToken> {
  const hash = manageTokenHash(token)
  if (!hash) throw bookingNotFound()
  return ctx.db.transaction().execute(async (trx) => {
    const old = await lockManagedBooking(trx, hash)
    if (!old) throw bookingNotFound()
    // The status cannot change while the row is locked; the time check waits for the locks.
    if (old.status === 'cancelled') throw bookingCancelled()

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
    const hostUserIds = hosts.map((h) => h.user_id)
    // Without a host there is nobody whose availability could be checked.
    if (!hostUserIds.length) {
      throw new DomainError(
        'conflict',
        'booking_has_no_host',
        'This booking has no host, so it cannot be rescheduled',
      )
    }
    await lockHosts(trx, hostUserIds)
    // Read after the locks: waiting for them takes time, and the rules may have changed.
    const now = ctx.now()
    assertChangeable(old, now)

    const eventType =
      old.event_type_id === null
        ? undefined
        : await trx
            .selectFrom('event_types')
            .select(['id', 'duration_minutes'])
            .where('id', '=', old.event_type_id)
            .where('is_active', '=', true)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
    if (!eventType) {
      throw new DomainError(
        'conflict',
        'event_type_unavailable',
        'This event type no longer takes bookings',
      )
    }
    const end = start.add({ minutes: eventType.duration_minutes })
    for (const hostUserId of hostUserIds) {
      await requireOfferedSlot(trx, {
        eventTypeId: eventType.id,
        hostUserId,
        start,
        end,
        now,
        excludeBookingId: old.id,
      })
    }

    // Cancel first: the trigger frees the old host rows, so the new time may overlap them.
    await trx
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: now.toString() })
      .where('id', '=', old.id)
      .execute()
    const { id, manageToken } = await insertBooking(trx, {
      organizationId: old.organization_id,
      eventTypeId: eventType.id,
      start,
      end,
      title: old.title,
      location: parseLocation(old.location),
      responses: (isRecord(old.responses) ? old.responses : {}) as Responses,
      source: origin.source,
      apiKeyId: origin.apiKeyId,
      rescheduledFromId: old.id,
      hostUserIds,
      attendees: attendees.map((a) => ({
        name: a.name,
        email: a.email,
        timeZone: a.time_zone,
        locale: a.locale,
        isBooker: a.is_booker,
      })),
    })
    // In this transaction: the new booking's emails. The old booking's queued ones find it
    // cancelled and replaced when they run, and send nothing.
    await ctx.notify?.(trx, { type: 'rescheduled', bookingId: id, start }, now)
    return { booking: await loadBooking(trx, id), manageToken }
  })
}

// --- Host side ----------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface ListBookingsInput {
  /** Only bookings that start at or after this instant. */
  from?: Temporal.Instant | undefined
  /** Only bookings that start before this instant. */
  to?: Temporal.Instant | undefined
  status?: BookingStatus | undefined
  /** 1–MAX_PAGE_SIZE, default DEFAULT_PAGE_SIZE. */
  limit?: number | undefined
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined
}

export interface BookingPage {
  data: Booking[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

// Postgres reads ISO 8601 instants in years 0001–9999 (no year 0000).
const EARLIEST_SQL = Temporal.Instant.from('0001-01-01T00:00:00Z')
const LATEST_SQL = Temporal.Instant.from('9999-12-31T23:59:59.999999Z')

/**
 * An instant as a bound timestamptz value with its full precision (Postgres keeps
 * microseconds and rounds beyond); a Date would cut it to milliseconds. Clamped to the years
 * Postgres reads, which changes nothing for filters: no booking lies outside them.
 */
function timestamptz<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  instant: Temporal.Instant,
) {
  const clamped =
    Temporal.Instant.compare(instant, EARLIEST_SQL) < 0
      ? EARLIEST_SQL
      : Temporal.Instant.compare(instant, LATEST_SQL) > 0
        ? LATEST_SQL
        : instant
  return eb.cast<Date>(eb.val(clamped.toString()), 'timestamptz')
}

/** `start` keeps the microseconds of start_at (see listHostBookings), so pages never overlap. */
function encodeCursor(row: { cursor_start: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.cursor_start, row.id])).toString('base64url')
}

function decodeCursor(cursor: string): { start: Temporal.Instant; id: string } {
  const invalid = () => new DomainError('invalid', 'invalid_cursor', 'cursor is not valid')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid()
  const [start, id] = parsed
  if (typeof start !== 'string' || typeof id !== 'string' || !UUID.test(id)) throw invalid()
  let instant: Temporal.Instant
  try {
    instant = Temporal.Instant.from(start)
  } catch {
    throw invalid()
  }
  // Cursors are made from stored bookings; outside these years one can only be forged.
  if (
    Temporal.Instant.compare(instant, EARLIEST_SQL) < 0 ||
    Temporal.Instant.compare(instant, LATEST_SQL) > 0
  ) {
    throw invalid()
  }
  return { start: instant, id }
}

/**
 * Bookings of the caller's organization that the caller hosts, ordered by start (then id),
 * a page at a time (keyset pagination, so pages stay stable while bookings are added).
 */
export async function listHostBookings(
  ctx: ServiceContext,
  input: ListBookingsInput = {},
): Promise<BookingPage> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new DomainError('invalid', 'invalid_limit', `limit must be from 1 to ${MAX_PAGE_SIZE}`)
  }
  const { from, to, status } = input
  if (from && to && Temporal.Instant.compare(to, from) <= 0) {
    throw new DomainError('invalid', 'invalid_range', 'to must be after from')
  }
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor)

  const rows = await ctx.db
    .selectFrom('bookings as b')
    .innerJoin('booking_hosts as bh', 'bh.booking_id', 'b.id')
    .select(BOOKING_COLUMNS)
    // start_at with its microseconds, for the cursor (node-postgres Dates have milliseconds).
    .select((eb) =>
      eb
        .fn<string>('to_char', [
          eb.fn('timezone', [eb.val('UTC'), 'b.start_at']),
          eb.val('YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        ])
        .as('cursor_start'),
    )
    .where('bh.user_id', '=', ctx.principal.user.id)
    .where('b.organization_id', '=', ctx.principal.organization.id)
    .$if(from !== undefined, (q) =>
      q.where((eb) => eb('b.start_at', '>=', timestamptz(eb, from as Temporal.Instant))),
    )
    .$if(to !== undefined, (q) =>
      q.where((eb) => eb('b.start_at', '<', timestamptz(eb, to as Temporal.Instant))),
    )
    .$if(status !== undefined, (q) => q.where('b.status', '=', status as string))
    .$if(after !== undefined, (q) =>
      q.where((eb) => {
        const start = timestamptz(eb, (after as { start: Temporal.Instant }).start)
        return eb.or([
          eb('b.start_at', '>', start),
          eb.and([eb('b.start_at', '=', start), eb('b.id', '>', (after as { id: string }).id)]),
        ])
      }),
    )
    .orderBy('b.start_at')
    .orderBy('b.id')
    .limit(limit + 1)
    .execute()

  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: await toBookings(ctx.db, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  }
}

/** A booking of the caller's organization that the caller hosts; else `booking_not_found`. */
export async function getHostBooking(ctx: ServiceContext, id: string): Promise<Booking> {
  if (!UUID.test(id)) throw bookingNotFound()
  const row = await ctx.db
    .selectFrom('bookings as b')
    .innerJoin('booking_hosts as bh', 'bh.booking_id', 'b.id')
    .select(BOOKING_COLUMNS)
    .where('b.id', '=', id)
    .where('bh.user_id', '=', ctx.principal.user.id)
    .where('b.organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (!row) throw bookingNotFound()
  const [booking] = await toBookings(ctx.db, [row])
  return booking as Booking
}

/** Cancels a booking the caller hosts, with the same rules as the invitee's link. */
export async function cancelHostBooking(
  ctx: ServiceContext,
  id: string,
  { reason }: { reason?: string | undefined } = {},
): Promise<Booking> {
  if (!UUID.test(id)) throw bookingNotFound()
  const cancelReason = normalizeReason(reason)
  return ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('bookings as b')
      .innerJoin('booking_hosts as bh', 'bh.booking_id', 'b.id')
      .select(['b.id', 'b.status', 'b.start_at'])
      .where('b.id', '=', id)
      .where('bh.user_id', '=', ctx.principal.user.id)
      .where('b.organization_id', '=', ctx.principal.organization.id)
      .forUpdate('b')
      .executeTakeFirst()
    if (!row) throw bookingNotFound()
    return cancelLocked(trx, row, ctx.now(), cancelReason, ctx.notify)
  })
}
