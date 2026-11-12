import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import * as availability from './availability.ts'
import * as bookings from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import * as manage from './manage.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const range = {
  start: Temporal.Instant.from('2026-11-03T08:00:00Z'),
  end: Temporal.Instant.from('2026-11-03T17:00:00Z'),
}

async function sourceCopy<T extends object>(
  name: string,
  before: string,
  after: string,
): Promise<T> {
  const location = new URL(name, import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(original.includes(before), 'mutation must match production source').toBe(true)
  const source = stripTypeScriptTypes(original.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return guardCopy<T>(
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`),
  )
}

const readonlyError = { kind: 'conflict', code: 'imported_booking_read_only' }

describe.skipIf(!serverUrl)('imported local-only booking protection', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  const notify = vi.fn()
  let ctx: PublicContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'import_readonly' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW, notify }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(successor = false) {
    notify.mockClear()
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, { slug: 'imported' })
    const service: ServiceContext = {
      ...ctx,
      principal: {
        kind: 'session',
        sessionId: randomUUID(),
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: '', slug: '', personal: true },
      },
    }
    const root = await db
      .insertInto('bookings')
      .values({
        organization_id: host.organizationId,
        event_type_id: eventTypeId,
        start_at: '2026-11-02T09:00Z',
        end_at: '2026-11-02T09:30Z',
        title: 'Imported meeting',
        source: 'import',
        import_questions: JSON.stringify([
          { id: 'notes', label: 'Historical notes', type: 'long_text', required: false },
        ]),
        responses: JSON.stringify({ notes: 'Retained source note' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const secret = randomBytes(32).toString('base64url')
    const token = { token: secret, hash: createHash('sha256').update(secret).digest() }
    const id = successor
      ? (
          await db
            .insertInto('bookings')
            .values({
              organization_id: host.organizationId,
              event_type_id: eventTypeId,
              start_at: '2026-11-03T09:00Z',
              end_at: '2026-11-03T09:30Z',
              title: 'Stale successor',
              source: 'web',
              rescheduled_from_id: root.id,
              manage_token_hash: token.hash,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id
      : root.id
    for (const bookingId of new Set([root.id, id])) {
      await db
        .insertInto('booking_hosts')
        .values({ booking_id: bookingId, user_id: host.userId })
        .execute()
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: bookingId,
          name: 'Invitee',
          email: 'invitee@example.com',
          time_zone: 'UTC',
          is_booker: true,
        })
        .execute()
    }
    return { host, id, rootId: root.id, service, token: token.token }
  }

  async function verifyCancel(module = bookings) {
    const s = await setup(true)
    await expect(module.cancelHostBooking(s.service, s.id)).rejects.toMatchObject(readonlyError)
    expect((await bookings.getHostBooking(s.service, s.id)).status).toBe('confirmed')
    expect(notify).not.toHaveBeenCalled()
  }
  async function verifyReschedule(module = bookings) {
    const s = await setup(true)
    await expect(
      module.rescheduleHostBooking(s.service, s.id, {
        start: Temporal.Instant.from('2026-11-03T10:00Z'),
      }),
    ).rejects.toMatchObject(readonlyError)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('rescheduled_from_id', '=', s.id)
        .execute(),
    ).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  }
  async function verifyManage(module = bookings) {
    const s = await setup(true)
    await expect(module.getManagedBooking(ctx, s.token)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(module.cancelManagedBooking(ctx, s.token)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(
      module.rescheduleManagedBooking(ctx, s.token, {
        start: Temporal.Instant.from('2026-11-03T10:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
    await expect(manage.listManagedSlots(ctx, s.token, range)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
  }
  async function verifySlots(module = manage) {
    const s = await setup(true)
    await expect(module.listHostBookingSlots(s.service, s.id, range)).rejects.toMatchObject(
      readonlyError,
    )
  }
  async function verifyRead(module = bookings) {
    const s = await setup(true)
    const detail = await module.getHostBooking(s.service, s.id)
    expect(detail.managementPolicy).toBe('local_only_read_only')
    expect(detail.source).toBe('web')
    const page = await module.listHostBookings(s.service)
    expect(page.data.map((b) => b.managementPolicy)).toEqual([
      'local_only_read_only',
      'local_only_read_only',
    ])
  }
  async function verifySnapshot(module = bookings) {
    const s = await setup()
    const detail = await module.getHostBooking(s.service, s.id)
    expect(detail.questions).toEqual([
      { id: 'notes', label: 'Historical notes', type: 'long_text', required: false },
    ])
    expect(detail.responses).toEqual({ notes: 'Retained source note' })
  }
  async function verifyHiddenRetries(module = bookings) {
    const s = await setup()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: s.id,
        booking_id: s.id,
        organization_id: s.host.organizationId,
        organizer_user_id: s.host.userId,
        provider: 'zoom',
        state: 'failed',
        zoom_connection_id: randomUUID(),
        zoom_user_id: 'synthetic-provider-user',
        error_code: 'provider_unavailable',
      })
      .execute()
    const detail = await module.getHostBooking(s.service, s.id)
    expect(detail.conference).toBeUndefined()
    expect(detail.conferenceCanRetry).toBeUndefined()
    expect(detail.calendarCopy).toBeUndefined()
  }
  async function verifyBusy(module = availability) {
    const s = await setup()
    const slots = await module.listPublicSlots(ctx, {
      handle: s.host.handle,
      slug: 'imported',
      start: Temporal.Instant.from('2026-11-02T08:00Z'),
      end: Temporal.Instant.from('2026-11-02T17:00Z'),
    })
    expect(slots.some((slot) => slot.start === '2026-11-02T09:00:00.000Z')).toBe(false)
    expect(slots.some((slot) => slot.start === '2026-11-02T10:00:00.000Z')).toBe(true)
  }

  it('refuses cancellation without notifying or releasing busy time', () => verifyCancel())
  it('refuses rescheduling, including stale successors, without creating another booking', () =>
    verifyReschedule())
  it('denies old management capabilities on reads, cancellation, rescheduling and slots', () =>
    verifyManage())
  it('refuses authenticated reschedule slots', () => verifySlots())
  it('labels imported booking reads and inherited policy in host details and lists', () =>
    verifyRead())
  it('retains original question labels and notes on imported host reads', () => verifySnapshot())
  it('omits stale conference and calendar retry metadata', () => verifyHiddenRetries())
  it('keeps imported records busy in normal public availability', () => verifyBusy())

  it.each([
    [
      'original question labels',
      './bookings.ts',
      'questions: parseQuestions(r.import_questions ?? [])',
      'questions: []',
      verifySnapshot,
    ],
    [
      'retry metadata',
      './bookings.ts',
      'const view = imported.has(row.id) ? undefined : conferences.get(row.id)',
      'const view = conferences.get(row.id)',
      verifyHiddenRetries,
    ],
    [
      'cancellation',
      './bookings.ts',
      'await assertBookingLocallyManaged(db, row.id)',
      'void row.id',
      verifyCancel,
    ],
    [
      'rescheduling',
      './bookings.ts',
      'await assertBookingLocallyManaged(trx, old.id)',
      'void old.id',
      verifyReschedule,
    ],
    [
      'management capabilities',
      './bookings.ts',
      'if (await isImportedBooking(db, row.id)) return undefined',
      'void row.id',
      verifyManage,
    ],
    [
      'reschedule slots',
      './manage.ts',
      'await assertBookingLocallyManaged(ctx.db, booking.id)',
      'void booking.id',
      verifySlots,
    ],
    [
      'management attribution',
      './bookings.ts',
      "...(imported.has(r.id) ? { managementPolicy: 'local_only_read_only' as const } : {}),",
      '',
      verifyRead,
    ],
  ] as const)('kills source-copy mutation of %s', async (_, path, before, after, verify) => {
    const copy = await sourceCopy<typeof bookings & typeof manage>(path, before, after)
    await expectKilled(copy, verify)
  })
  it('kills an availability mutation that ignores imported busy records', async () => {
    const copy = await sourceCopy<typeof availability>(
      './availability.ts',
      ".where('bh.active', '=', true)",
      ".where('bh.active', '=', true).where('b.source', '<>', 'import')",
    )
    await expectKilled(copy, verifyBusy)
  })
})
