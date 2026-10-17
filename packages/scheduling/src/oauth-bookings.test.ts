import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type BookingOrigin,
  cancelHostBooking,
  createPublicBooking,
  rescheduleHostBooking,
} from './bookings.ts'
import { createEventType } from './event-types.ts'
import { putProfile } from './profile.ts'
import { createSchedule } from './schedules.ts'
import { createTestUser, domainError, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const invitee = { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('OAuth booking attribution and retry scopes', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup() {
    const user = await createTestUser(db),
      ctx = testContext(db, user.principal, now)
    const handle = `oauth-${randomUUID().slice(0, 8)}`
    await putProfile(ctx, { handle, timeZone: 'UTC', locale: 'en' })
    await createSchedule(ctx, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
    })
    const event = await createEventType(ctx, { title: 'Call', slug: 'call', durationMinutes: 30 })
    const notify = vi.fn(async () => {})
    const pub = { db, now, notify }
    const input = (hour = 9) => ({
      handle,
      slug: event.slug,
      start: Temporal.Instant.from(`2026-11-02T${hour.toString().padStart(2, '0')}:00Z`),
      invitee,
      idempotencyKey: 'same-client-key',
    })
    const oauth = (id: string): Principal => ({
      user: user.principal.user,
      organization: user.principal.organization,
      kind: 'oauth',
      oauthConsentId: id,
      clientId: 'https://client.test/metadata.json',
      scopes: ['mcp:tools'],
    })
    return { user, ctx, pub, input, notify, oauth }
  }
  it('separates anonymous, API key and two grants even when credential UUID values coincide', async () => {
    const s = await setup(),
      id = randomUUID(),
      other = randomUUID()
    const origins: BookingOrigin[] = [
      { source: 'mcp', apiKeyId: null, oauthConsentId: id },
      { source: 'mcp', apiKeyId: null, oauthConsentId: other },
      { source: 'api', apiKeyId: id },
      { source: 'web', apiKeyId: null },
    ]
    const bookings = []
    for (let i = 0; i < origins.length; i++)
      bookings.push(await createPublicBooking(s.pub, s.input(9 + i), origins[i]))
    expect(new Set(bookings.map((result) => result.booking.id)).size).toBe(4)
    for (let i = 0; i < origins.length; i++) {
      const replay = await createPublicBooking(s.pub, s.input(9 + i), origins[i])
      expect(replay.booking.id).toBe(bookings[i]?.booking.id)
      expect(replay.replayed).toBe(true)
      expect(replay.manageToken).toBeNull()
      expect(
        (await domainError(() => createPublicBooking(s.pub, s.input(14), origins[i]))).code,
      ).toBe('idempotency_key_reused')
    }
    expect(s.notify).toHaveBeenCalledTimes(4)
    const rows = await db
      .selectFrom('bookings')
      .select(['api_key_id', 'oauth_consent_id', 'source'])
      .where(
        'id',
        'in',
        bookings.map((r) => r.booking.id),
      )
      .execute()
    expect(rows.filter((row) => row.oauth_consent_id !== null)).toHaveLength(2)
    expect(rows.filter((row) => row.api_key_id === id)).toHaveLength(1)
    expect(rows.some((row) => row.api_key_id !== null && row.oauth_consent_id !== null)).toBe(false)
  })
  it('serializes simultaneous retries of the same grant with one notification', async () => {
    const s = await setup(),
      origin: BookingOrigin = { source: 'mcp', apiKeyId: null, oauthConsentId: randomUUID() }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createPublicBooking(s.pub, s.input(), origin)),
    )
    expect(new Set(results.map((r) => r.booking.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(results.filter((r) => r.manageToken !== null)).toHaveLength(1)
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it('keeps creation attribution and records the actual OAuth reschedule/cancel actor internally', async () => {
    const s = await setup(),
      key = randomUUID(),
      firstGrant = randomUUID(),
      secondGrant = randomUUID()
    const original = await createPublicBooking(s.pub, s.input(), { source: 'api', apiKeyId: key })
    const moved = await rescheduleHostBooking(
      testContext(db, s.oauth(firstGrant), now),
      original.booking.id,
      { start: s.input(10).start },
    )
    const old = await db
      .selectFrom('bookings')
      .select([
        'source',
        'api_key_id',
        'oauth_consent_id',
        'cancelled_source',
        'cancelled_api_key_id',
        'cancelled_oauth_consent_id',
      ])
      .where('id', '=', original.booking.id)
      .executeTakeFirstOrThrow()
    expect(old).toEqual({
      source: 'api',
      api_key_id: key,
      oauth_consent_id: null,
      cancelled_source: 'mcp',
      cancelled_api_key_id: null,
      cancelled_oauth_consent_id: firstGrant,
    })
    await cancelHostBooking(testContext(db, s.oauth(secondGrant), now), moved.booking.id)
    const next = await db
      .selectFrom('bookings')
      .select([
        'source',
        'api_key_id',
        'oauth_consent_id',
        'cancelled_source',
        'cancelled_api_key_id',
        'cancelled_oauth_consent_id',
      ])
      .where('id', '=', moved.booking.id)
      .executeTakeFirstOrThrow()
    expect(next).toEqual({
      source: 'mcp',
      api_key_id: null,
      oauth_consent_id: firstGrant,
      cancelled_source: 'mcp',
      cancelled_api_key_id: null,
      cancelled_oauth_consent_id: secondGrant,
    })
    // Public booking results continue to omit internal credential identifiers.
    expect(moved.booking).not.toHaveProperty('oauthConsentId')
    expect(moved.booking).not.toHaveProperty('apiKeyId')
  })
  it('rejects mixed credentials and OAuth attribution outside the MCP source at the database boundary', async () => {
    const s = await setup()
    const made = await createPublicBooking(s.pub, s.input())
    for (const values of [
      { source: 'web', oauth_consent_id: randomUUID() },
      { source: 'mcp', oauth_consent_id: randomUUID(), api_key_id: randomUUID() },
      { cancelled_oauth_consent_id: randomUUID() },
    ]) {
      await expect(
        db.updateTable('bookings').set(values).where('id', '=', made.booking.id).execute(),
      ).rejects.toMatchObject({ code: '23514' })
    }
  })
})
