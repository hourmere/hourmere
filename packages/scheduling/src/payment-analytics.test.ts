import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBookingActivity } from './analytics.ts'
import { DomainError } from './errors.ts'
import { validTimeZone } from './internal.ts'
import { createTestUser, testContext } from './testing.ts'

function copy(before: string, after = ''): typeof getBookingActivity {
  let source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8')
  expect(source.includes(before)).toBe(true)
  source = stripTypeScriptTypes(source.replaceAll(before, after).replace(/^import .*\n/gm, ''))
  return new Function(
    'sql',
    'DomainError',
    'validTimeZone',
    `${source.replace(/\bexport /g, '')}; return getBookingActivity`,
  )(sql, DomainError, validTimeZone)
}

describe.skipIf(!process.env.DATABASE_URL)('unconfirmed payment activity', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verify(read = getBookingActivity) {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    for (const status of ['pending_payment', 'expired', 'cancelled']) {
      await sql`INSERT INTO bookings (organization_id,title,start_at,end_at,source,status,
        created_at,cancelled_at,payment_hold_expires_at)
        VALUES (${user.principal.organization.id}::uuid,'Synthetic hold','2040-01-01T10:00Z',
          '2040-01-01T10:30Z','web',${status},'2026-10-01T10:00Z',
          ${status === 'cancelled' ? '2026-10-01T10:01Z' : null}::timestamptz,
          '2040-01-01T09:00Z')`.execute(db)
    }
    const activity = await read(ctx, {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      timeZone: 'UTC',
    })
    expect(activity.totals).toEqual({ created: 0, rescheduled: 0, cancelled: 0 })
  }
  it('does not count unconfirmed holds as booking creation or cancellation', async () => {
    await verify()
  })
  it('detects removal of unpaid activity visibility predicates', async () => {
    await expect(
      verify(copy('AND (b.payment_hold_expires_at IS NULL OR b.payment_confirmed_at IS NOT NULL)')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function paidCancellation(read = getBookingActivity) {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const row = await sql<{ id: string }>`INSERT INTO bookings
      (organization_id,title,start_at,end_at,source,status,created_at,payment_hold_expires_at,payment_reference)
      VALUES (${user.principal.organization.id}::uuid,'Paid booking','2040-01-01T10:00Z',
        '2040-01-01T10:30Z','web','confirmed','2026-10-01T10:00Z','2040-01-01T09:00Z',
        ${`pi_${user.id}`}) RETURNING id`.execute(db)
    await sql`UPDATE bookings SET status='cancelled',cancelled_at='2026-10-01T10:01Z'
      WHERE id=${row.rows[0]?.id}::uuid`.execute(db)
    const activity = await read(ctx, {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      timeZone: 'UTC',
    })
    expect(activity.totals).toEqual({ created: 1, rescheduled: 0, cancelled: 1 })
  }
  it('counts creation and cancellation of a previously confirmed paid booking', async () => {
    await paidCancellation()
  })
  it('detects using current status instead of durable confirmation for activity', async () => {
    await expect(
      paidCancellation(copy('b.payment_confirmed_at IS NOT NULL', "b.status = 'confirmed'")),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
