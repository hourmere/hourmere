import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as bookings from './bookings.ts'
import { notificationSnapshot } from './notification-settings.ts'
import { cancelPaymentHold, confirmPaymentHold } from './payments.ts'
import { createTestUser, testContext } from './testing.ts'

async function copy(before: string, after: string): Promise<typeof bookings> {
  const url = new URL('./bookings.ts', import.meta.url)
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
    `${source.replace(/\bexport /g, '')}; return { getHostBooking, cancelHostBooking, rescheduleHostBooking }`,
  )(...Object.values(bindings))
}

describe.skipIf(!process.env.DATABASE_URL)('payment foundation transport boundaries', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture() {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const start = Temporal.Now.instant().add({ hours: 72 })
    const { id, manageToken } = await db.transaction().execute((trx) =>
      bookings.insertBooking(trx, {
        organizationId: user.principal.organization.id,
        eventTypeId: null,
        start,
        end: start.add({ minutes: 30 }),
        title: 'Synthetic hold',
        location: null,
        responses: {},
        source: 'web',
        apiKeyId: null,
        hostUserIds: [user.id],
        hostsUseDefaultSchedule: false,
        attendees: [],
        notificationSnapshot: notificationSnapshot(null),
        manageTokenHash: null,
        paymentHoldExpiresAt: Temporal.Now.instant().add({ minutes: 30 }).toString(),
      }),
    )
    expect(manageToken).toBeNull()
    return { ctx, id, start }
  }
  async function hidden(api = bookings) {
    const { ctx, id } = await fixture()
    await expect(api.getHostBooking(ctx, id)).rejects.toMatchObject({ code: 'booking_not_found' })
    expect((await bookings.listHostBookings(ctx)).data).toEqual([])
    await cancelPaymentHold(ctx, id)
    await expect(api.getHostBooking(ctx, id)).rejects.toMatchObject({ code: 'booking_not_found' })
    expect((await bookings.listHostBookings(ctx)).data).toEqual([])
  }
  async function protectedMutation(api = bookings) {
    const { ctx, id, start } = await fixture()
    await confirmPaymentHold(ctx, id, `pi_${id.replaceAll('-', '')}`)
    await expect(api.cancelHostBooking(ctx, id)).rejects.toMatchObject({
      code: 'paid_booking_management_unavailable',
    })
    await expect(
      api.rescheduleHostBooking(ctx, id, { start: start.add({ hours: 24 }) }),
    ).rejects.toMatchObject({ code: 'paid_booking_management_unavailable' })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
  }
  it('hides pending and unpaid-cancelled holds from existing booking reads', async () => {
    await hidden()
  })
  it('refuses ordinary cancellation and rescheduling of confirmed paid bookings', async () => {
    await protectedMutation()
  })
  it('detects removal of the ordinary paid-management guard', async () => {
    await expect(
      protectedMutation(await copy('if (paid?.payment_hold_expires_at)', 'if (false)')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects exposing unpaid-cancelled holds through host details', async () => {
    const before =
      ".where((eb) =>\n      eb.or([eb('b.payment_hold_expires_at', 'is', null), eb('b.status', '=', 'confirmed')]),\n    )"
    await expect(hidden(await copy(before, ''))).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
