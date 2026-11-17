import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as Availability from './availability.ts'
import { createPublicBooking } from './bookings.ts'
import type { PublicContext } from './context.ts'
import { createFixtures } from './testing.ts'

async function sourceCopy(file: string, change?: [string, string], admissionUrl?: string) {
  const path = new URL(file, import.meta.url)
  let source = readFileSync(path, 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier === './group-seat-admission.ts' && admissionUrl ? admissionUrl : specifier.startsWith('.') ? new URL(specifier, path).href : import.meta.resolve(specifier)}'`,
  )
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  return { ...(await import(url)), sourceUrl: url }
}
const now = Temporal.Instant.from('2027-10-31T12:00Z')
const start = Temporal.Instant.from('2027-11-01T09:00Z')
describe.skipIf(!process.env.DATABASE_URL)('public group slot source-copy protections', () => {
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
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const event = await f.eventType(host.organizationId, host.userId, {
      slug: 'group',
      durationMinutes: 30,
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 2 })
      .where('id', '=', event)
      .execute()
    const ctx: PublicContext = { db, now: () => now }
    const input = { handle: host.handle, slug: 'group', start }
    const book = (email: string) =>
      createPublicBooking(ctx, {
        ...input,
        invitee: { name: 'Private attendee', email, timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      })
    await book('private@example.test')
    return { ctx, input, book }
  }
  async function verify(module: typeof Availability, full = false) {
    const f = await fixture()
    if (full) await f.book('other@example.test')
    const slots = await module.listPublicSlots(f.ctx, {
      ...f.input,
      end: start.add({ minutes: 30 }),
    })
    expect(slots).toEqual(
      full
        ? []
        : [
            {
              start: '2027-11-01T09:00:00.000Z',
              end: '2027-11-01T09:30:00.000Z',
              seatsRemaining: 1,
              capacity: 2,
            },
          ],
    )
  }
  it('accepts the original source with a free seat and a full session', async () => {
    const module = await sourceCopy('./availability.ts')
    await verify(module)
    await verify(module, true)
  })
  it.each([
    ['seat count query', 'slot.capacity - slot.active_seats', 'slot.capacity', false],
    ['full-session rule', 'slot.active_seats >= slot.capacity ||', 'false ||', true],
    [
      'public response privacy',
      'seatsRemaining: slot.capacity - slot.active_seats,',
      '...slot, seatsRemaining: slot.capacity - slot.active_seats,',
      false,
    ],
  ] as const)(
    'kills the %s mutation with real result assertions',
    async (_name, before, after, full) => {
      const module = await sourceCopy('./availability.ts', [before, after])
      await expect(verify(module, full)).rejects.toThrow(/AssertionError|expected/)
    },
  )
  it('kills removal of the last-seat conflict guard with the same concurrent result assertion', async () => {
    async function race(module: { createPublicBooking: typeof createPublicBooking }) {
      const f = await fixture()
      const results = await Promise.allSettled(
        ['race-a@example.test', 'race-b@example.test'].map((email) =>
          module.createPublicBooking(f.ctx, {
            ...f.input,
            invitee: { name: 'Racer', email, timeZone: 'UTC' },
            idempotencyKey: randomUUID(),
          }),
        ),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const loser = results.find((result) => result.status === 'rejected')
      expect(loser).toMatchObject({ status: 'rejected', reason: { code: 'slot_taken' } })
    }
    await race(await sourceCopy('./bookings.ts'))
    const admission = await sourceCopy('./group-seat-admission.ts', [
      'if (slot && slot.active_seats >= slot.capacity)',
      'if (false)',
    ])
    const mutant = await sourceCopy('./bookings.ts', undefined, admission.sourceUrl)
    await expect(race(mutant)).rejects.toThrow(/AssertionError|expected/)
  })
})
