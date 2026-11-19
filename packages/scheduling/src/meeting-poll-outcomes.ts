import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

/** The first booking update is zero, counting each move and then a final cancellation. */
export function meetingPollBookingUpdateSequence(depth: number, status: 'confirmed' | 'cancelled') {
  return status === 'cancelled' ? depth : depth - 1
}

export async function enqueueMeetingPollOutcomes(
  trx: Db,
  poll: { id: string; organization_id: string },
  at: string,
  kind: 'selected' | 'booking_update',
  sequence = 0,
) {
  // Selected voters receive ordinary booking mail, including calendar invitations.
  await trx
    .insertInto('meeting_poll_deliveries')
    .columns([
      'organization_id',
      'poll_id',
      'voter_id',
      'kind',
      'sequence',
      'due_at',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('meeting_poll_voters')
        .select(['organization_id', 'poll_id', 'id'])
        .select([
          sql<string>`${kind}::text`.as('kind'),
          sql<number>`${sequence}::integer`.as('sequence'),
          sql`${at}::timestamptz`.as('due_at'),
          sql`${at}::timestamptz`.as('created_at'),
          sql`${at}::timestamptz`.as('updated_at'),
        ])
        .where('organization_id', '=', poll.organization_id)
        .where('poll_id', '=', poll.id)
        .where('selected_booking_role', 'is', null)
        .where('withdrawn_at', 'is', null)
        .where((eb) =>
          eb.or([eb('verified_at', 'is not', null), eb('invited_at', 'is not', null)]),
        ),
    )
    .execute()
}

/** Called by the ordinary booking write with its booking lock held. */
export async function enqueueMeetingPollBookingUpdate(
  trx: Db,
  organizationId: string,
  bookingId: string,
  status: 'confirmed' | 'cancelled',
  at: Temporal.Instant,
) {
  // Keep the original poll link. Follow predecessors to it and take the poll lock
  // before checking retained voters. A poll worker reads bookings without locking them.
  const { rows } = await sql<{ id: string; organization_id: string; depth: number }>`
    WITH RECURSIVE chain (id, rescheduled_from_id, depth) AS (
      SELECT id, rescheduled_from_id, 0 FROM bookings
       WHERE id = ${bookingId} AND organization_id = ${organizationId}
      UNION ALL
      SELECT b.id, b.rescheduled_from_id, c.depth + 1
        FROM bookings b JOIN chain c ON b.id = c.rescheduled_from_id
       WHERE b.organization_id = ${organizationId}
    ) CYCLE id SET is_cycle USING path
    SELECT p.id, p.organization_id, c.depth
      FROM chain c JOIN meeting_polls p ON p.booking_id = c.id
     WHERE p.organization_id = ${organizationId} AND p.status = 'scheduled' AND NOT c.is_cycle
     FOR UPDATE OF p`.execute(trx)
  const poll = rows[0]
  if (!poll) return
  await enqueueMeetingPollOutcomes(
    trx,
    poll,
    at.toString(),
    'booking_update',
    meetingPollBookingUpdateSequence(poll.depth, status),
  )
}
