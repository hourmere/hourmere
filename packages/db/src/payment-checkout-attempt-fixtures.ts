import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

export async function seedCheckoutHolds(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string; host_id: string }>(
    `WITH host AS (
       INSERT INTO auth."user" (name,email,"emailVerified")
       VALUES ('Checkout host','checkout-host@example.test',true) RETURNING id
     ), org AS (
       INSERT INTO auth.organization (name,slug,"createdAt")
       VALUES ('Checkout host','checkout-host',now()) RETURNING id
     ), event AS (
       INSERT INTO event_types (organization_id,owner_user_id,slug,title,duration_minutes)
       SELECT org.id,host.id,'consultation','Consultation',30 FROM org,host
       RETURNING id,organization_id
     ), hold AS (
       INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,status,
         payment_hold_expires_at,payment_idempotency_key,idempotency_fingerprint)
       SELECT event.organization_id,event.id,now() + offsets.slot,now() + offsets.slot + interval '30 minutes',
         'Consultation with invitee','web','pending_payment',now() + interval '30 minutes',
         offsets.key,decode(repeat('ab',32),'hex')
       FROM event CROSS JOIN (VALUES (interval '2 hours',$1::text), (interval '3 hours',$2::text)) offsets(slot,key)
       RETURNING id,start_at
     ), booker AS (
       INSERT INTO booking_attendees (booking_id,name,email,time_zone,locale,is_booker)
       SELECT id,'Invitee','invitee@example.test','America/Los_Angeles','en',true FROM hold
     )
     SELECT hold.id,host.id AS host_id FROM hold CROSS JOIN host ORDER BY start_at`,
    [randomUUID(), randomUUID()],
  )
  expect(rows).toHaveLength(2)
  const bookings = rows.map(({ id }) => id)
  await expect(
    pool.query('INSERT INTO booking_hosts (booking_id,user_id) SELECT unnest($1::uuid[]),$2', [
      bookings,
      rows[0]?.host_id,
    ]),
  ).resolves.toMatchObject({ rowCount: 2 })
  return bookings
}
