import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { ensureWaitlistKey, waitlistNow, waitlistTokenHash } from './waitlist.ts'

/**
 * Bookkeeping after a new ordinary insert, in that insert's transaction. The capability
 * grants no booking privilege. Replays never reach this function, and invalid optional
 * metadata deliberately leaves the ordinary booking successful.
 */
export async function attributeWaitlistBooking(
  db: Db,
  input: {
    secret: string
    token: unknown
    eventTypeId: string
    bookingId: string
    email: string
    start: Temporal.Instant
    end: Temporal.Instant
    now?: (() => Temporal.Instant) | undefined
  },
): Promise<void> {
  if (typeof input.token !== 'string' || !/^[a-f\d-]{36}\.[A-Za-z0-9_-]{43}$/.test(input.token))
    return
  await ensureWaitlistKey(db, input.secret)
  const digest = waitlistTokenHash(input.token, 'management')
  // Lock only the one entry after the ordinary host/event locks. Self-removal and
  // disabling serialize here; one predicate checks current capability and lifecycle.
  const { rows } = await sql<{ id: string }>`SELECT e.id FROM waitlist_entries e
    JOIN waitlist_capabilities c ON c.entry_id=e.id
    JOIN event_types et ON et.id=e.event_type_id
    WHERE c.token_hash=${digest} AND c.purpose='management'
      AND c.revoked_at IS NULL AND e.event_type_id=${input.eventTypeId}
    FOR UPDATE OF e`.execute(db)
  const entry = rows[0]
  if (!entry) return
  const at = await waitlistNow(db, input.now ? new Date(input.now().epochMilliseconds) : undefined)
  const updated = await sql`UPDATE waitlist_entries e SET status='booked',
      booking_id=${input.bookingId},terminal_at=${at},terminal_reason='booked'
    WHERE e.id=${entry.id} AND e.status IN ('active','notified')
      AND e.verified_at IS NOT NULL AND e.expires_at>${at}
      AND e.email=${input.email.trim().toLowerCase()}
      AND e.window_start<=${new Date(input.start.epochMilliseconds)}
      AND e.window_end>=${new Date(input.end.epochMilliseconds)}
      AND EXISTS(SELECT FROM event_types et WHERE et.id=e.event_type_id
        AND et.waitlist_enabled AND et.is_active AND et.deleted_at IS NULL
        AND et.scheduling_type='individual')
      AND EXISTS(SELECT FROM waitlist_capabilities c WHERE c.entry_id=e.id
        AND c.token_hash=${digest} AND c.purpose='management' AND c.revoked_at IS NULL
        AND c.expires_at>${at}) RETURNING e.id`.execute(db)
  if (!updated.rows.length) return
  await sql`UPDATE waitlist_capabilities SET revoked_at=${at}
    WHERE entry_id=${entry.id} AND revoked_at IS NULL`.execute(db)
  await sql`DELETE FROM waitlist_verification_outbox WHERE entry_id=${entry.id}`.execute(db)
  await sql`UPDATE waitlist_candidates SET state='obsolete',error_code='entry_terminal',
    claim_token=NULL,lease_until=NULL,updated_at=${at}
    WHERE entry_id=${entry.id} AND state IN ('pending','processing')`.execute(db)
}
