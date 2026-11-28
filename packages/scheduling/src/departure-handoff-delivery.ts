// The mail worker shares these functions without loading scheduling or form schemas.
import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { isUuid } from './uuid.ts'

export const DEPARTURE_HANDOFF_SEND_LIMIT = 3

export function departureHandoffRecipientHash(sourceBookingId: string, recipientKey: string) {
  return createHash('sha256')
    .update(`hourmere:departure-handoff:mailbox:v1\0${sourceBookingId}\0${recipientKey}`)
    .digest('hex')
}

/** Recipient IDs are immutable and each belongs to exactly one offer version. */
export function departureHandoffTokenDigest(recipientId: string, token: string) {
  return createHash('sha256')
    .update(`hourmere:departure-handoff:consent:v1\0${recipientId}\0${token}`)
    .digest('hex')
}

/** The caller holds the source and exact offer locks. A null reason leaves the decline
 * in the recipient's immutable decision. */
export async function closeDepartureHandoffOffer(
  db: Db,
  key: { organizationId: string; sourceBookingId: string; offerId: string; version: number },
  reason: 'withdrawn' | 'superseded' | 'expired' | null,
) {
  await db
    .updateTable('departure_handoff_offers')
    .set({ state: 'closed', close_reason: reason })
    .where('organization_id', '=', key.organizationId)
    .where('source_booking_id', '=', key.sourceBookingId)
    .where('id', '=', key.offerId)
    .where('version', '=', key.version)
    .execute()
  const recipients = await db
    .updateTable('departure_handoff_recipients')
    .set({ token_digest: null })
    .where('organization_id', '=', key.organizationId)
    .where('source_booking_id', '=', key.sourceBookingId)
    .where('offer_id', '=', key.offerId)
    .where('offer_version', '=', key.version)
    .returning('id')
    .execute()
  if (recipients.length)
    await db
      .updateTable('departure_handoff_deliveries')
      .set({ state: 'skipped' })
      .where(
        'recipient_id',
        'in',
        recipients.map(({ id }) => id),
      )
      .where('state', '=', 'queued')
      .execute()
}

/** Acquire the source lock after the organization lock and before any offer or recipient. */
export async function lockDepartureHandoffSource(
  db: Db,
  organizationId: string,
  bookingId: string,
  skipLocked = false,
) {
  if (!isUuid(bookingId)) return undefined
  const source = await db
    .selectFrom('bookings')
    .select(['id', 'status'])
    .select(
      sql<string | null>`to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'start',
      ),
    )
    .where('id', '=', bookingId)
    .where('organization_id', '=', organizationId)
    .forUpdate()
    .$if(skipLocked, (query) => query.skipLocked())
    .executeTakeFirst()
  if (!source) return undefined
  // Use a fresh statement snapshot after any lock wait.
  const successor = await db
    .selectFrom('bookings')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('rescheduled_from_id', '=', source.id)
    .executeTakeFirst()
  return { ...source, hasSuccessor: Boolean(successor) }
}
