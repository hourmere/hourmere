import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEventType, listEventTypeWaitlistEntries } from './event-types.ts'
import { createTestUser, testContext } from './testing.ts'
import {
  cleanupWaitlist,
  ensureWaitlistKey,
  type WaitlistContext,
  waitlistNow,
} from './waitlist.ts'

const bootstrap = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const HOUR = 3600000
const DAY = 24 * HOUR
function sourceCopy(): typeof cleanupWaitlist {
  let source = readFileSync(new URL('waitlist.ts', import.meta.url), 'utf8')
  source = source.slice(source.indexOf('export async function cleanupWaitlist('))
  expect(source.includes('.where(keepNewestReceipt)'), 'mutation matches receipt protection').toBe(
    true,
  )
  source = stripTypeScriptTypes(source.replace('.where(keepNewestReceipt)', '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(
    'ensureWaitlistKey',
    'waitlistNow',
    'sql',
    'DAY',
    'LIVE',
    `${source}; return cleanupWaitlist`,
  )(ensureWaitlistKey, waitlistNow, sql, DAY, [
    'pending_verification',
    'active',
    'notified',
  ]) as typeof cleanupWaitlist
}

describe.skipIf(!bootstrap)('waitlist latest accepted receipt retention', () => {
  let owned: TestDatabase
  let db: Db
  const secret = 'synthetic-waitlist-retained-receipt-secret'
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'waitlist_receipt' })
    db = createDb(owned.pool)
    await db
      .transaction()
      .execute((trx) => ensureWaitlistKey(trx, secret, new Date(NOW.epochMilliseconds)))
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function assertRetention(cleanup = cleanupWaitlist) {
    const user = await createTestUser(db)
    const manager = testContext(db, user.principal)
    const event = await createEventType(manager, {
      slug: 'retained',
      title: 'Retained receipt',
      durationMinutes: 30,
      waitlist: { enabled: true },
    })
    const at = (milliseconds: number) => new Date(NOW.epochMilliseconds + milliseconds)
    const entry = await db
      .insertInto('waitlist_entries')
      .values({
        organization_id: user.principal.organization.id,
        event_type_id: event.id,
        recipient_hash: randomBytes(32),
        email: 'receipt@example.test',
        name: null,
        window_start: at(DAY),
        window_end: at(40 * DAY),
        time_zone: 'UTC',
        locale: 'en',
        consent_version: 'waitlist-v1',
        consented_at: at(0),
        created_at: at(0),
        expires_at: at(30 * DAY),
        pending_expires_at: at(DAY),
        status: 'notified',
        verified_at: at(0),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const tieIds = [randomUUID(), randomUUID()].sort()
    const definitions = [
      { id: randomUUID(), accepted_at: at(HOUR), expires_at: at(DAY) },
      { id: tieIds[0] as string, accepted_at: at(2 * HOUR), expires_at: at(3 * HOUR) },
      { id: tieIds[1] as string, accepted_at: at(2 * HOUR), expires_at: at(3 * HOUR) },
      { id: randomUUID(), accepted_at: null, expires_at: at(HOUR) },
    ]
    for (const receipt of definitions) {
      const cohort = await db
        .insertInto('waitlist_cohorts')
        .values({ event_type_id: event.id, discovered_at: at(0) })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('waitlist_candidates')
        .values({
          ...receipt,
          entry_id: entry.id,
          event_type_id: event.id,
          cohort_id: cohort.id,
          slots: JSON.stringify([
            { start: at(DAY).toISOString(), end: at(DAY + HOUR).toISOString() },
          ]),
          due_at: at(0),
          state: receipt.accepted_at ? 'accepted' : 'failed',
          created_at: at(0),
          updated_at: at(0),
        })
        .execute()
    }
    let clock = NOW.add({ hours: 7 * 24 + 3 })
    const ctx: WaitlistContext = {
      db,
      secret,
      publicUrl: 'https://schedule.example',
      now: () => clock,
    }
    const receipts = () =>
      db
        .selectFrom('waitlist_candidates')
        .select(['id', 'accepted_at'])
        .where('entry_id', '=', entry.id)
        .orderBy('id')
        .execute()
    const retainedId = tieIds[1] as string
    // Newer acceptance has an earlier expiry than the old receipt; equality is due.
    expect(await receipts()).toHaveLength(4)
    for (const expected of [3, 2]) {
      await cleanup(ctx, { limit: 1 })
      const remaining = await receipts()
      expect(remaining).toHaveLength(expected)
      expect(remaining.some((receipt) => receipt.id === retainedId)).toBe(true)
    }
    expect((await listEventTypeWaitlistEntries(manager, event.id)).data[0]?.lastNotifiedAt).toBe(
      at(2 * HOUR).toISOString(),
    )
    clock = NOW.add({ hours: 8 * 24 })
    await cleanup(ctx, { limit: 1 })
    expect(await receipts()).toEqual([{ id: retainedId, accepted_at: at(2 * HOUR) }])
    expect((await listEventTypeWaitlistEntries(manager, event.id)).data[0]?.lastNotifiedAt).toBe(
      at(2 * HOUR).toISOString(),
    )
    clock = NOW.add({ hours: 30 * 24 })
    await cleanup(ctx, { limit: 1 })
    expect(await receipts()).toHaveLength(1)
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select(['status', 'email'])
        .where('id', '=', entry.id)
        .executeTakeFirst(),
    ).toEqual({ status: 'expired', email: null })
    clock = NOW.add({ hours: 37 * 24 })
    await cleanup(ctx, { limit: 1 })
    expect(
      await db.selectFrom('waitlist_entries').select('id').where('id', '=', entry.id).execute(),
    ).toEqual([])
    expect(await receipts()).toEqual([])
  }
  it('retains exactly the newest accepted receipt through bounded cleanup and cascades it at terminal plus seven days', async () => {
    await assertRetention()
  })
  it('detects source-copy omission of latest receipt preservation', async () => {
    await expect(assertRetention(sourceCopy())).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
