import type { Db } from '@hourmere/db'
import { type InferResult, sql } from 'kysely'
import type { DepartureHandoffAdminStore } from './departure-handoff-admin.ts'
import type { DepartureHandoffOffer } from './departure-handoff-apply.ts'

interface HandoffSource {
  organizationId: string
  sourceBookingId: string
}

// Read the stored microseconds for window and terms checks. A pg Date drops them.
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const utc = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
const instant = (value: string) => Temporal.Instant.from(value).toString()

function offers(db: Db, source: HandoffSource) {
  return db
    .selectFrom('departure_handoff_offers')
    .select([
      'organization_id',
      'source_booking_id',
      'id',
      'version',
      'state',
      'departing_user_id',
      'duration_minutes',
      'location_option_id',
      'terms_digest',
      utc('issued_at').as('issued_at'),
      utc('expires_at').as('expires_at'),
      utc('target_start_at').as('target_start_at'),
    ])
    .where('organization_id', '=', source.organizationId)
    .where('source_booking_id', '=', source.sourceBookingId)
}

function receipts(db: Db, source: HandoffSource) {
  return db
    .selectFrom('departure_booking_handoffs')
    .where('organization_id', '=', source.organizationId)
    .where('source_booking_id', '=', source.sourceBookingId)
}

async function readOffer(
  db: Db,
  row: InferResult<ReturnType<typeof offers>>[number],
  replacementBookingId?: string,
): Promise<{ id: string } & DepartureHandoffOffer> {
  const recipients = replacementBookingId
    ? []
    : await db
        .selectFrom('departure_handoff_recipients')
        .select(['id', 'recipient_key', 'offer_version', utc('decided_at').as('decided_at')])
        .where('organization_id', '=', row.organization_id)
        .where('source_booking_id', '=', row.source_booking_id)
        .where('offer_id', '=', row.id)
        .where('offer_version', '=', row.version)
        .where('decision', '=', 'approved')
        .where('decided_at', 'is not', null)
        .execute()
  return {
    id: row.id,
    version: row.version,
    state: row.state === 'live' ? 'live' : 'closed',
    issuedAt: instant(row.issued_at),
    expiresAt: instant(row.expires_at),
    departingUserId: row.departing_user_id,
    start: instant(row.target_start_at),
    durationMinutes: row.duration_minutes,
    ...(row.location_option_id !== null && { locationOptionId: row.location_option_id }),
    termsDigest: row.terms_digest,
    approvals: recipients.map((recipient) => ({
      recipientId: recipient.id,
      recipientKey: recipient.recipient_key,
      version: recipient.offer_version,
      approvedAt: instant(recipient.decided_at),
    })),
    ...(replacementBookingId && { committed: { replacementBookingId } }),
  }
}

/** Apply has already locked the source booking. Consent and invalidation take the same
 * organization → source → offer order before writing these rows. */
export const departureHandoffStore: DepartureHandoffAdminStore = {
  async lockOffer(trx, key) {
    const versions = offers(trx, key).where('id', '=', key.offerId)
    const offer =
      Number.isInteger(key.version) && key.version >= 1 && key.version <= 2_147_483_647
        ? await versions.where('version', '=', key.version).forUpdate().executeTakeFirst()
        : undefined
    if (!offer) {
      const knownVersion = await versions.clearSelect().select('id').limit(1).executeTakeFirst()
      return knownVersion ? 'version_mismatch' : undefined
    }
    const receipt = await receipts(trx, key)
      .select('replacement_booking_id')
      .where('offer_id', '=', key.offerId)
      .where('offer_version', '=', key.version)
      .executeTakeFirst()
    return readOffer(trx, offer, receipt?.replacement_booking_id)
  },

  async readLatest(db, source) {
    const receipt = await receipts(db, source)
      .select(['offer_id', 'offer_version', 'replacement_booking_id'])
      .executeTakeFirst()
    const query = offers(db, source)
    const offer = await (receipt
      ? query.where('id', '=', receipt.offer_id).where('version', '=', receipt.offer_version)
      : query.orderBy('version', 'desc').limit(1)
    ).executeTakeFirst()
    return offer && readOffer(db, offer, receipt?.replacement_booking_id)
  },

  async commitHandoff(trx, key, evidence) {
    await trx
      .insertInto('departure_booking_handoffs')
      .values({
        organization_id: key.organizationId,
        source_booking_id: key.sourceBookingId,
        offer_id: key.offerId,
        offer_version: key.version,
        replacement_booking_id: evidence.replacementBookingId,
        applying_user_id: evidence.applyingUserId,
        applied_at: evidence.appliedAt,
        recipient_ids: evidence.recipientIds,
      })
      .execute()
    await trx
      .updateTable('departure_handoff_offers')
      .set({ state: 'closed' })
      .where('organization_id', '=', key.organizationId)
      .where('source_booking_id', '=', key.sourceBookingId)
      .where('id', '=', key.offerId)
      .where('version', '=', key.version)
      .execute()
  },
}
