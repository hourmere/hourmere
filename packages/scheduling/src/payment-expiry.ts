import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

/** Drain even after disabling new holds. DB time is authoritative after row-lock waits. */
export async function expirePaymentHolds(ctx: { db: Db; hostUserId?: string }): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    WITH due AS (
      SELECT b.id FROM bookings b
      WHERE b.status='pending_payment' AND b.payment_hold_expires_at<=clock_timestamp()
      ${ctx.hostUserId ? sql`AND EXISTS (SELECT FROM booking_hosts h WHERE h.booking_id=b.id AND h.user_id=${ctx.hostUserId}::uuid)` : sql``}
      ORDER BY b.payment_hold_expires_at,b.id
      LIMIT 500 FOR UPDATE OF b SKIP LOCKED
    )
    UPDATE bookings b SET status='expired' FROM due WHERE b.id=due.id
      AND b.status='pending_payment' AND b.payment_hold_expires_at<=clock_timestamp()
    RETURNING b.id`.execute(ctx.db)
  return rows.length
}
