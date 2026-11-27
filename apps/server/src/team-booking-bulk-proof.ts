import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Principal, TeamManager } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  DomainError,
  type ListBookingsInput,
  MAX_PAGE_SIZE,
  normalizedBookingPageIdentity,
} from '@hourmere/scheduling'
import { sql } from 'kysely'

const BULK_PAGE_LIFETIME_MS = 10 * 60_000
const MAX_SELECTED_BOOKINGS = 25
export const MAX_BULK_PAGE_TOKEN_LENGTH = 6_000

const Base64Url = /^[A-Za-z0-9_-]+$/
const Sha256Base64Url = /^[A-Za-z0-9_-]{43}$/
const BookingSelection = z
  .array(z.guid())
  .min(1)
  .max(MAX_SELECTED_BOOKINGS)
  .transform((ids) => ids.map((id) => id.toLowerCase()))
  .refine((ids) => new Set(ids).size === ids.length, 'Booking IDs must be distinct')

export const BulkPreviewSelectionSchema = z.strictObject({
  pageToken: z.string(),
  bookingIds: BookingSelection,
})

const BulkPagePayload = z.strictObject({
  userId: z.guid(),
  sessionId: z.guid(),
  organizationId: z.guid(),
  queryDigest: z.string().regex(Sha256Base64Url),
  expiresAt: z.int().positive().max(8_640_000_000_000_000),
  bookingIds: z.array(z.guid()).max(MAX_PAGE_SIZE),
})

export interface BulkPageBinding {
  userId: string
  sessionId: string
  organizationId: string
}

/** Bind an authorized team manager to the browser session used for the request. */
export function bulkPageBinding(principal: Principal, actor: TeamManager): BulkPageBinding {
  if (principal.kind !== 'session')
    throw new DomainError('forbidden', 'team_management_access_denied')
  return {
    userId: actor.userId,
    sessionId: principal.sessionId,
    organizationId: actor.organizationId,
  }
}

export async function databaseWallTime(db: Db): Promise<Date> {
  const { now } = await db
    .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
    .executeTakeFirstOrThrow()
  return now
}

function mac(secret: string, purpose: 'page' | 'query', value: string): string {
  return createHmac('sha256', secret)
    .update(`hourmere:team-booking-bulk:${purpose}:v1\0`)
    .update(value)
    .digest('base64url')
}

/** Sign the page actually returned by the list. issuedAt comes from the database clock. */
export function issueBulkPageProof(
  secret: string,
  binding: BulkPageBinding,
  query: ListBookingsInput,
  bookingIds: readonly string[],
  issuedAt: Date,
): { bulkPageToken: string; bulkPageExpiresAt: string } {
  const expiresAt = issuedAt.getTime() + BULK_PAGE_LIFETIME_MS
  const payload = {
    userId: binding.userId.toLowerCase(),
    sessionId: binding.sessionId.toLowerCase(),
    organizationId: binding.organizationId.toLowerCase(),
    queryDigest: mac(secret, 'query', normalizedBookingPageIdentity(query)),
    expiresAt,
    bookingIds: bookingIds.map((id) => id.toLowerCase()),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return {
    bulkPageToken: `${encoded}.${mac(secret, 'page', encoded)}`,
    bulkPageExpiresAt: new Date(expiresAt).toISOString(),
  }
}

const selectionChanged = () =>
  new DomainError('conflict', 'bulk_selection_changed', 'Reload the booking page and select again.')

/** Verify before any booking lookup. `now` comes from the database clock. */
export function verifyBulkPageSelection(
  secret: string,
  binding: BulkPageBinding,
  pageToken: string,
  bookingIds: readonly string[],
  now: Date,
): { bookingIds: string[]; expiresAt: Date } {
  const selection = BookingSelection.safeParse(bookingIds)
  if (!selection.success)
    throw new DomainError('invalid', 'invalid_request', 'Select 1 to 25 distinct booking IDs.')
  if (pageToken.length > MAX_BULK_PAGE_TOKEN_LENGTH) throw selectionChanged()
  const [encoded, signature, extra] = pageToken.split('.')
  if (
    !encoded ||
    !signature ||
    extra !== undefined ||
    !Base64Url.test(encoded) ||
    !Sha256Base64Url.test(signature) ||
    !timingSafeEqual(Buffer.from(mac(secret, 'page', encoded)), Buffer.from(signature))
  )
    throw selectionChanged()

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw selectionChanged()
  }
  const proof = BulkPagePayload.safeParse(payload)
  if (
    !proof.success ||
    proof.data.userId !== binding.userId.toLowerCase() ||
    proof.data.sessionId !== binding.sessionId.toLowerCase() ||
    proof.data.organizationId !== binding.organizationId.toLowerCase() ||
    proof.data.expiresAt <= now.getTime()
  )
    throw selectionChanged()

  const unseen = new Set(selection.data)
  const ordered = proof.data.bookingIds.filter((id) => unseen.delete(id))
  if (unseen.size > 0) throw selectionChanged()
  return { bookingIds: ordered, expiresAt: new Date(proof.data.expiresAt) }
}
