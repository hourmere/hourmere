import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPublicEventType, findSlots } from './availability.ts'
import {
  canonicalJson,
  createPublicBooking,
  insertBooking,
  lockHosts,
  requireOfferedSlot,
} from './bookings.ts'
import { admitGroupSlot } from './group-seat-admission.ts'
import { notificationSnapshot } from './notification-settings.ts'
import { eraseUnpaidHoldPersonalData, expirePaymentHolds } from './payment-expiry.ts'
import { confirmPaymentHold, createPaymentHold } from './payments.ts'
import { createFixtures, weekdays } from './testing.ts'

async function copy(
  file: string,
  exports: string,
  before: string,
  after: string,
): Promise<Record<string, unknown>> {
  const url = new URL(file, import.meta.url)
  let source = readFileSync(url, 'utf8')
  expect(source.includes(before)).toBe(true)
  source = stripTypeScriptTypes(source.replace(before, after))
  const bindings: Record<string, unknown> = {}
  for (const match of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = match[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (match[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      bindings[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(match[0], '')
  }
  source = source.replace(/^export \{[^}]*\} from '[^']+'\n/gm, '')
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return { ${exports} }`,
  )(...Object.values(bindings))
}

describe.skipIf(!process.env.DATABASE_URL)('payment source-copy protection mutations', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture(overdue = false) {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'paid',
      durationMinutes: 30,
    })
    let date = Temporal.Now.plainDateISO('UTC').add({ days: 3 })
    while (date.dayOfWeek !== 1) date = date.add({ days: 1 })
    const start = date
      .toZonedDateTime({ timeZone: 'Europe/Berlin', plainTime: '12:00' })
      .toInstant()
    const ctx = {
      db,
      now: () => Temporal.Now.instant(),
      paidBookingsEnabled: true,
      notify: vi.fn(async () => {}),
    }
    const input = {
      handle: host.handle,
      slug: 'paid',
      start,
      idempotencyKey: 'copy',
      invitee: { name: 'Synthetic', email: 'copy@example.com', timeZone: 'UTC' },
    }
    const q = {
      eventTypeId,
      hostUserId: host.userId,
      start,
      end: start.add({ minutes: 30 }),
      now: ctx.now(),
    }
    if (overdue)
      await db.transaction().execute((trx) =>
        insertBooking(trx, {
          organizationId: host.organizationId,
          eventTypeId,
          start,
          end: q.end,
          title: 'Expired',
          location: null,
          responses: {},
          source: 'web',
          apiKeyId: null,
          hostUserIds: [host.userId],
          hostsUseDefaultSchedule: false,
          attendees: [],
          notificationSnapshot: notificationSnapshot(null),
          manageTokenHash: null,
          paymentHoldExpiresAt: ctx.now().subtract({ minutes: 1 }).toString(),
        }),
      )
    return { ctx, input, q, host }
  }
  async function disabled(api = createPaymentHold) {
    const { ctx, input } = await fixture()
    await expect(api({ ...ctx, paidBookingsEnabled: false }, input)).rejects.toMatchObject({
      code: 'paid_bookings_disabled',
    })
  }
  async function replay(api = confirmPaymentHold) {
    const { ctx, input } = await fixture()
    const { id } = await createPaymentHold(ctx, input)
    const reference = `pi_${id.replaceAll('-', '')}`
    await api(ctx, id, reference)
    await api(ctx, id, reference)
    expect(ctx.notify).toHaveBeenCalledTimes(1)
  }
  async function deadline(api = findSlots) {
    const { q } = await fixture(true)
    expect(await api(db, { ...q, rangeStart: q.start, rangeEnd: q.end })).toHaveLength(1)
  }
  async function admission(api = requireOfferedSlot) {
    const { q } = await fixture(true)
    await api(db, q)
    const rows = await db
      .selectFrom('bookings')
      .select('status')
      .where('event_type_id', '=', q.eventTypeId)
      .execute()
    expect(rows.map((r) => r.status)).toEqual(['expired'])
  }
  async function groupAdmission(api = admitGroupSlot) {
    const { ctx, q, host } = await fixture(true)
    const eventTypeId = await createFixtures(db).eventType(host.organizationId, host.userId, {
      slug: 'group-copy',
      durationMinutes: 30,
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 2 })
      .where('id', '=', eventTypeId)
      .execute()
    const event = await findPublicEventType(db, host.handle, 'group-copy')
    if (!event) throw new Error('Missing fixture')
    await expect(
      db.transaction().execute(async (trx) => {
        await lockHosts(trx, [host.userId])
        const slot = await api(trx, {
          event,
          start: q.start,
          end: q.end,
          now: ctx.now(),
          snapshot: notificationSnapshot(null),
          bookerEmail: 'group-copy@example.com',
        })
        if (!slot) throw new Error('Missing group slot')
        return insertBooking(trx, {
          organizationId: host.organizationId,
          eventTypeId,
          start: q.start,
          end: q.end,
          title: 'Group',
          location: slot.location,
          locationOption: slot.locationOption,
          groupSlotId: slot.id,
          responses: {},
          source: 'web',
          apiKeyId: null,
          hostUserIds: [host.userId],
          hostsUseDefaultSchedule: false,
          attendees: [
            {
              name: 'Synthetic',
              email: 'group-copy@example.com',
              timeZone: 'UTC',
              locale: null,
              isBooker: true,
            },
          ],
          notificationSnapshot: notificationSnapshot(null),
        })
      }),
    ).resolves.toHaveProperty('id')
  }
  it('detects missing group admission cleanup in an isolated source copy', async () => {
    await groupAdmission()
    const mutant = await copy(
      './group-seat-admission.ts',
      'admitGroupSlot',
      'await expirePaymentHolds({ db, hostUserId: hostId })',
      '',
    )
    await expect(
      groupAdmission(mutant.admitGroupSlot as typeof admitGroupSlot),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function notificationPolicy(api = createPaymentHold) {
    const { ctx, input, q } = await fixture()
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
      .where('id', '=', q.eventTypeId)
      .execute()
    const { id } = await api(ctx, input)
    const row = await db
      .selectFrom('bookings')
      .select('notification_snapshot')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.notification_snapshot).toEqual({
      version: 1,
      executionMode: 'configurable',
      notifications: { reminders: [], followUps: [] },
    })
  }
  it('detects substituting default reminders for the event policy', async () => {
    await notificationPolicy()
    const mutant = await copy(
      './payments.ts',
      'createPaymentHold',
      'createNotificationSnapshot(model.notifications)',
      "createNotificationSnapshot({ reminders: [{ id: 'default-24h', offsetMinutes: 1440, recipients: { invitee: true, guests: true, host: true } }], followUps: [] })",
    )
    await expect(
      notificationPolicy(mutant.createPaymentHold as typeof createPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function lockedReplay(api = createPaymentHold) {
    const { ctx, input, q } = await fixture(true)
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ ...input, start: input.start.toString() }))
      .digest()
    const row = await db
      .updateTable('bookings')
      .set({
        payment_idempotency_key: input.idempotencyKey,
        idempotency_fingerprint: fingerprint,
      })
      .where('event_type_id', '=', q.eventTypeId)
      .returning('id')
      .executeTakeFirstOrThrow()
    let ready: () => void = () => {}
    const locked = new Promise<void>((resolve) => {
      ready = resolve
    })
    let release: () => void = () => {}
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve
    })
    let blockerPid = 0
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom('bookings').select('id').where('id', '=', row.id).forUpdate().execute()
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      blockerPid = (rows[0] as { pid: number }).pid
      ready()
      await releaseLock
    })
    await locked
    const replay = api(ctx, input)
    let waited = false
    try {
      for (let attempt = 0; attempt < 500; attempt++) {
        const { rows } = await sql<{
          waited: boolean
        }>`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))) AS waited`.execute(
          db,
        )
        if (rows[0]?.waited) {
          waited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally {
      release()
      await blocker
    }
    expect(waited).toBe(true)
    expect(await replay).toMatchObject({ id: row.id, status: 'expired' })
  }
  it('expires a locked replay target skipped by the cleanup batch', async () => {
    await lockedReplay()
    const mutant = await copy(
      './payments.ts',
      'createPaymentHold',
      "existing.status === 'pending_payment'",
      'false',
    )
    await expect(
      lockedReplay(mutant.createPaymentHold as typeof createPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function fullHoldWindow(api = createPaymentHold) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    const hours = [{ start: '00:00', end: '24:00' }]
    await f.schedule(host.userId, {
      timeZone: 'UTC',
      weeklyHours: { ...weekdays(...hours), saturday: hours, sunday: hours },
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'soon',
      durationMinutes: 1,
      slotStepMinutes: 1,
      minimumNoticeMinutes: 0,
    })
    const now = Temporal.Now.instant()
    const start = now.round({ smallestUnit: 'minute', roundingMode: 'ceil' }).add({ minutes: 5 })
    const ctx = { db, now: () => now, paidBookingsEnabled: true }
    // Prove that ordinary availability would admit this slot; only the payment window rejects it.
    expect(
      await findSlots(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: start,
        rangeEnd: start.add({ minutes: 1 }),
        now,
      }),
    ).toHaveLength(1)
    await expect(
      api(ctx, {
        handle: host.handle,
        slug: 'soon',
        start,
        idempotencyKey: 'full-window',
        invitee: { name: 'Synthetic', email: 'soon@example.com', timeZone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
  }
  it('requires the complete payment hold window before the meeting starts', async () => {
    await fullHoldWindow()
    const mutant = await copy(
      './payments.ts',
      'createPaymentHold',
      'if (!hasFullPaymentWindow)',
      'if (false)',
    )
    await expect(
      fullHoldWindow(mutant.createPaymentHold as typeof createPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects disabled flag removal in an isolated source copy', async () => {
    await disabled()
    const mutant = await copy(
      './payments.ts',
      'createPaymentHold',
      'if (ctx.paidBookingsEnabled !== true) throw disabled()',
      'if (false) throw disabled()',
    )
    await expect(
      disabled(mutant.createPaymentHold as typeof createPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects confirmation notification replay in an isolated source copy', async () => {
    await replay()
    const mutant = await copy(
      './payments.ts',
      'confirmPaymentHold',
      "if (confirm && row.status !== 'confirmed')",
      'if (confirm)',
    )
    await expect(
      replay(mutant.confirmPaymentHold as typeof confirmPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects missing availability deadline in an isolated source copy', async () => {
    await deadline()
    const mutant = await copy(
      './availability.ts',
      'findSlots',
      "eb('b.payment_hold_expires_at', '>', sql<Date>`clock_timestamp()`)",
      "eb('b.payment_hold_expires_at', 'is not', null)",
    )
    await expect(deadline(mutant.findSlots as typeof findSlots)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('detects missing admission cleanup in an isolated source copy', async () => {
    await admission()
    const mutant = await copy(
      './bookings.ts',
      'requireOfferedSlot',
      'await expirePaymentHolds({ db, hostUserId: q.hostUserId })',
      '',
    )
    await expect(
      admission(mutant.requireOfferedSlot as typeof requireOfferedSlot),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function keyIsolation(api = createPaymentHold) {
    const { ctx, input } = await fixture()
    const hold = await api(ctx, input)
    const ordinary = {
      ...input,
      start: input.start.add({ hours: 1 }),
      idempotencyKey: `payment:${input.idempotencyKey}`,
    }
    await expect(createPublicBooking(ctx, ordinary)).resolves.toHaveProperty(
      'booking.status',
      'confirmed',
    )
    await expect(
      createPublicBooking(ctx, { ...input, start: input.start.add({ hours: 2 }) }),
    ).resolves.toHaveProperty('booking.status', 'confirmed')
    expect((await api(ctx, input)).id).toBe(hold.id)
    // Also reserve the former prefix first, then create a distinct payment hold.
    const second = await fixture()
    await createPublicBooking(second.ctx, {
      ...second.input,
      idempotencyKey: `payment:${second.input.idempotencyKey}`,
    })
    await createPublicBooking(second.ctx, {
      ...second.input,
      start: second.input.start.add({ hours: 2 }),
    })
    await expect(
      api(second.ctx, { ...second.input, start: second.input.start.add({ hours: 1 }) }),
    ).resolves.toHaveProperty('status', 'pending_payment')
  }
  it('isolates hold keys from ordinary anonymous booking keys in both creation orders', async () => {
    await keyIsolation()
    const mutant = await copy(
      './payments.ts',
      'createPaymentHold',
      'payment_idempotency_key: key, idempotency_fingerprint: fingerprint',
      "idempotency_key: 'payment:' + key, idempotency_fingerprint: fingerprint",
    )
    await expect(
      keyIsolation(mutant.createPaymentHold as typeof createPaymentHold),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function retention(api = eraseUnpaidHoldPersonalData) {
    const { ctx, host, q } = await fixture()
    const make = async (days: number, status: 'expired' | 'cancelled' | 'pending_payment') => {
      const { id } = await db.transaction().execute((trx) =>
        insertBooking(trx, {
          organizationId: host.organizationId,
          eventTypeId: q.eventTypeId,
          start: q.start,
          end: q.end,
          title: 'Private Invitee',
          location: { kind: 'in_person', address: 'Private place' },
          responses: { private: 'Private answer' },
          source: 'web',
          apiKeyId: null,
          hostUserIds: [],
          hostsUseDefaultSchedule: false,
          attendees: [
            {
              name: 'Private Invitee',
              email: 'private@example.com',
              timeZone: 'UTC',
              locale: null,
              isBooker: true,
            },
          ],
          notificationSnapshot: notificationSnapshot(null),
          manageTokenHash: null,
          paymentHoldExpiresAt: ctx
            .now()
            .subtract({ hours: days * 24 })
            .toString(),
        }),
      )
      if (status !== 'pending_payment')
        await db
          .updateTable('bookings')
          .set({ status, cancelled_at: status === 'cancelled' ? sql`clock_timestamp()` : null })
          .where('id', '=', id)
          .execute()
      return id
    }
    const oldExpired = await make(8, 'expired')
    const oldCancelled = await make(8, 'cancelled')
    const recent = await make(6, 'expired')
    const pending = await make(8, 'pending_payment')
    const confirmed = await db
      .insertInto('bookings')
      .values({
        organization_id: host.organizationId,
        event_type_id: q.eventTypeId,
        start_at: q.start.toString(),
        end_at: q.end.toString(),
        title: 'Confirmed private',
        location: JSON.stringify({ kind: 'in_person', address: 'Confirmed private place' }),
        source: 'web',
        status: 'confirmed',
        manage_token_hash: null,
        payment_hold_expires_at: ctx
          .now()
          .subtract({ hours: 8 * 24 })
          .toString(),
        payment_reference: `pi_retention_${host.userId.replaceAll('-', '')}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: confirmed.id,
        name: 'Confirmed private',
        email: 'confirmed@example.com',
        time_zone: 'UTC',
        is_booker: true,
      })
      .execute()
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: sql`clock_timestamp()` })
      .where('id', '=', confirmed.id)
      .execute()
    for (const id of [recent, confirmed.id])
      await expect(
        db
          .updateTable('bookings')
          .set({ location_option: null, payment_pii_erased_at: sql`clock_timestamp()` })
          .where('id', '=', id)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' })
    await expect(api(db)).resolves.toBeGreaterThanOrEqual(2)
    for (const id of [oldExpired, oldCancelled]) {
      expect(
        await db
          .selectFrom('bookings')
          .select(['title', 'responses', 'location', 'payment_pii_erased_at'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        title: 'Unpaid booking',
        responses: {},
        location: null,
        payment_pii_erased_at: expect.any(Date),
      })
      expect(
        await db
          .selectFrom('booking_attendees')
          .select('id')
          .where('booking_id', '=', id)
          .execute(),
      ).toHaveLength(0)
    }
    for (const id of [recent, pending, confirmed.id]) {
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('payment_pii_erased_at')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).payment_pii_erased_at,
      ).toBeNull()
      expect(
        await db
          .selectFrom('booking_attendees')
          .select('id')
          .where('booking_id', '=', id)
          .execute(),
      ).toHaveLength(1)
    }
    expect(await api(db)).toBe(0)
    // The worker's global expiry path drains overdue holds and then erases their old PII.
    await expirePaymentHolds({ db })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('payment_pii_erased_at')
          .where('id', '=', pending)
          .executeTakeFirstOrThrow()
      ).payment_pii_erased_at,
    ).toBeInstanceOf(Date)
  }
  it.each([
    [
      'retention deadline',
      "AND b.payment_hold_expires_at <= clock_timestamp() - interval '7 days'",
      '',
    ],
    ['terminal status', "b.status IN ('expired','cancelled')", 'true'],
    ['title clearance', "title='Unpaid booking'", 'title=b.title'],
    ['answer clearance', "responses='{}'::jsonb", 'responses=b.responses'],
    ['location clearance', 'location=NULL,', 'location=b.location,'],
  ])('detects missing %s in a retention source copy', async (_name, before, after) => {
    const mutant = await copy('./payment-expiry.ts', 'eraseUnpaidHoldPersonalData', before, after)
    await expect(
      retention(mutant.eraseUnpaidHoldPersonalData as typeof eraseUnpaidHoldPersonalData),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('preserves previously confirmed holds during retention in a source copy', async () => {
    const mutant = await copy(
      './payment-expiry.ts',
      'eraseUnpaidHoldPersonalData',
      'AND b.payment_confirmed_at IS NULL',
      '',
    )
    await expect(
      retention(mutant.eraseUnpaidHoldPersonalData as typeof eraseUnpaidHoldPersonalData),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('erases only terminal unpaid hold personal data after seven days and preserves audit', async () => {
    await retention()
    const mutant = await copy(
      './payment-expiry.ts',
      'eraseUnpaidHoldPersonalData',
      'DELETE FROM booking_attendees a USING due WHERE a.booking_id=due.id',
      'DELETE FROM booking_attendees a USING due WHERE false',
    )
    await expect(
      retention(mutant.eraseUnpaidHoldPersonalData as typeof eraseUnpaidHoldPersonalData),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
