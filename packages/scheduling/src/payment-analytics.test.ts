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

function copy(before: string): typeof getBookingActivity {
  let source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8')
  expect(source.includes(before)).toBe(true)
  source = stripTypeScriptTypes(source.replace(before, '').replace(/^import .*\n/gm, ''))
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
  it.each([
    "AND (b.payment_hold_expires_at IS NULL OR b.status = 'confirmed')",
    'AND b.payment_hold_expires_at IS NULL',
  ])('detects removal of activity predicate %s', async (before) => {
    await expect(verify(copy(before))).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
