import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as Bookings from './bookings.ts'
import type { PublicContext } from './context.ts'
import { createFixtures } from './testing.ts'

const path = new URL('./bookings.ts', import.meta.url)
async function sourceCopy(
  change?: [string, string],
  admissionChange?: [string, string],
): Promise<typeof Bookings> {
  const original = readFileSync(path, 'utf8')
  let source = original
  if (change) {
    expect(source).toContain(change[0])
    source = source.replaceAll(...change)
    if (change[0] === 'if (receipt) {')
      source = source.replace(
        'if (receiptReplay) return receiptReplay',
        'if (false) return receiptReplay',
      )
    expect(source).not.toBe(original)
  }
  let admissionUrl: string | undefined
  if (admissionChange) {
    const admissionPath = new URL('./group-seat-admission.ts', path)
    let admission = readFileSync(admissionPath, 'utf8')
    expect(admission).toContain(admissionChange[0])
    admission = stripTypeScriptTypes(admission.replace(...admissionChange)).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('.') ? new URL(specifier, admissionPath).href : import.meta.resolve(specifier)}'`,
    )
    admissionUrl = `data:text/javascript;base64,${Buffer.from(admission).toString('base64')}`
  }
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier === './group-seat-admission.ts' && admissionUrl ? admissionUrl : specifier.startsWith('.') ? new URL(specifier, path).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
const now = Temporal.Instant.from('2027-10-31T12:00Z'),
  start = Temporal.Instant.from('2027-11-01T09:00Z')
describe.skipIf(!process.env.DATABASE_URL)('group service source-copy mutation controls', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function verify(m: typeof Bookings) {
    const f = createFixtures(db),
      host = await f.host()
    await f.schedule(host.userId)
    const event = await f.eventType(host.organizationId, host.userId, {
      slug: 'group',
      durationMinutes: 30,
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3 })
      .where('id', '=', event)
      .execute()
    const ctx: PublicContext = { db, now: () => now }
    const key = randomUUID(),
      input = {
        handle: host.handle,
        slug: 'group',
        start,
        invitee: { name: 'A', email: 'a@example.test', timeZone: 'UTC' },
        idempotencyKey: key,
      }
    const pending = m.createPublicBooking(ctx, input)
    await expect(pending).resolves.toMatchObject({ replayed: false })
    const a = await pending
    await expect(m.createPublicBooking(ctx, input)).resolves.toMatchObject({
      replayed: true,
      booking: { id: a.booking.id },
      manageToken: null,
    })
    await expect(
      m.createPublicBooking(ctx, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    const noopKey = randomUUID()
    await expect(
      m.rescheduleManagedBooking(ctx, a.manageToken ?? '', { start, idempotencyKey: noopKey }),
    ).resolves.toMatchObject({ booking: { id: a.booking.id } })
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
      .where('id', '=', event)
      .execute()
    const moveKey = randomUUID(),
      target = start.add({ hours: 1 })
    const move = m.rescheduleManagedBooking(ctx, a.manageToken ?? '', {
      start: target,
      idempotencyKey: moveKey,
    })
    await expect(move).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    const b = await move
    expect(
      (
        await db
          .selectFrom('group_slots')
          .select('host_notification_settings')
          .where('original_event_type_id', '=', event)
          .where('state', '=', 'open')
          .executeTakeFirstOrThrow()
      ).host_notification_settings,
    ).toMatchObject({ notifications: { reminders: [], followUps: [] } })
    await expect(
      m.rescheduleManagedBooking(ctx, a.manageToken ?? '', {
        start: target,
        idempotencyKey: moveKey,
      }),
    ).resolves.toMatchObject({ booking: { id: b.booking.id }, manageToken: null })
    await expect(
      m.rescheduleManagedBooking(ctx, a.manageToken ?? '', {
        start: target.add({ hours: 1 }),
        idempotencyKey: moveKey,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await expect(m.cancelManagedBooking(ctx, b.manageToken ?? '')).resolves.toMatchObject({
      status: 'cancelled',
    })
    await expect(m.cancelManagedBooking(ctx, b.manageToken ?? '')).resolves.toMatchObject({
      status: 'cancelled',
    })
    const slots = await db
      .selectFrom('group_slots')
      .select(['state', 'active_seats'])
      .where('original_event_type_id', '=', event)
      .execute()
    expect(slots.every((s) => s.state === 'retired' && s.active_seats === 0)).toBe(true)
  }
  it.each([
    ['shared occupancy', 'b.hostUserIds.length && !b.groupSlotId', 'b.hostUserIds.length'],
    [
      'private booker binding',
      "normalize_group_booker_key(${b.attendees[0]?.email ?? ''})",
      'NULL',
    ],
    ['move receipt replay', 'if (receipt) {', 'if (false && receipt) {'],
    ['receipt fingerprint', '!receipt.fingerprint.equals(fingerprint)', 'false'],
    [
      'same slot no-op',
      'if (start.equals(toInstant(old.start_at)) && end.equals(toInstant(old.end_at)))',
      'if (false)',
    ],
    ['cancel replay', "if (seat?.group_slot_id && row.status === 'cancelled')", 'if (false)'],
  ] as const)(
    'detects removing %s',
    async (_name, before, after) => {
      await verify(await sourceCopy())
      await expect(verify(await sourceCopy([before, after]))).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await verify(await sourceCopy())
    },
    30000,
  )
  it('detects using the old seat policy for a new slot host', async () => {
    await verify(await sourceCopy())
    await expect(
      verify(
        await sourceCopy(undefined, [
          'JSON.stringify(createNotificationSnapshot(config.notifications))',
          'JSON.stringify(q.snapshot)',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(await sourceCopy())
  })
})
