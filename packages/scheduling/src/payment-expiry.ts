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
  if (!ctx.hostUserId) await eraseUnpaidHoldPersonalData(ctx.db)
  return rows.length
}

/** Seven days after the original deadline, terminal never-confirmed holds retain audit only. */
export async function eraseUnpaidHoldPersonalData(db: Db): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    WITH due AS MATERIALIZED (
      SELECT b.id FROM bookings b
      WHERE b.status IN ('expired','cancelled') AND b.payment_confirmed_at IS NULL
        AND b.payment_pii_erased_at IS NULL
        AND b.payment_hold_expires_at <= clock_timestamp() - interval '7 days'
      ORDER BY b.payment_hold_expires_at,b.id
      LIMIT 500 FOR UPDATE OF b SKIP LOCKED
    ), erased_attendees AS (
      DELETE FROM booking_attendees a USING due WHERE a.booking_id=due.id
    )
    UPDATE bookings b SET title='Unpaid booking', responses='{}'::jsonb, location=NULL,
      location_option=NULL, success_redirect=NULL, manage_token_hash=NULL, cancel_reason=NULL,
      payment_pii_erased_at=clock_timestamp()
    FROM due WHERE b.id=due.id
    RETURNING b.id`.execute(db)
  return rows.length
}
