import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPublicEventType } from './availability.ts'
import * as Bookings from './bookings.ts'
import { DomainError } from './errors.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00Z')
const options = [
  { id: 'office', kind: 'in_person', address: 'Private office', label: 'Visit us' },
  { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
] as const
async function sourceCopy(before: string, after: string): Promise<typeof Bookings> {
  const url = new URL('./bookings.ts', import.meta.url)
  const original = readFileSync(url, 'utf8')
  expect(original).toContain(before)
  const source = stripTypeScriptTypes(original.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('chosen booking location', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'location_choice' })
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())
  async function setup() {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const event = await f.eventType(host.organizationId, host.userId, { slug: 'choice' })
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify(options) })
      .where('id', '=', event)
      .execute()
    return {
      event,
      ctx: { db, now },
      input: {
        handle: host.handle,
        slug: 'choice',
        start: Temporal.Instant.from('2026-11-02T09:00Z'),
        invitee: { name: 'Guest', email: 'guest@example.test', timeZone: 'Europe/Berlin' },
        locationOptionId: 'call',
        inviteePhone: '+14155550123',
        idempotencyKey: crypto.randomUUID(),
      },
    }
  }
  async function snapshot(id: string) {
    return db
      .selectFrom('bookings')
      .select(['location', 'location_option'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }
  it('publishes only choice metadata and collects a valid phone', async () => {
    const { ctx, input } = await setup()
    expect((await getPublicEventType(ctx, input)).locations).toEqual([
      { id: 'office', kind: 'in_person', label: 'Visit us' },
      { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
    ])
    for (const inviteePhone of ['', '+12', '12345678', '+14155550123\n'])
      await expect(
        Bookings.createPublicBooking(ctx, { ...input, inviteePhone }),
      ).rejects.toMatchObject({ code: 'invalid_invitee_phone' })
    await expect(
      Bookings.createPublicBooking(ctx, { ...input, locationOptionId: 'removed' }),
    ).rejects.toMatchObject({ code: 'invalid_location_choice' })
    const result = await Bookings.createPublicBooking(ctx, input)
    expect(await snapshot(result.booking.id)).toEqual({
      location_option: options[1],
      location: { kind: 'phone', number: input.inviteePhone },
    })
    expect(
      await db
        .selectFrom('booking_conferences')
        .select('root_booking_id')
        .where('booking_id', '=', result.booking.id)
        .execute(),
    ).toEqual([])
  })
  it('replays concurrent requests after configuration changes and retains the phone through move/cancel', async () => {
    const { ctx, input, event } = await setup()
    const results = await Promise.all([
      Bookings.createPublicBooking(ctx, input),
      Bookings.createPublicBooking(ctx, input),
    ])
    expect(results[0].booking.id).toBe(results[1].booking.id)
    expect(results.filter((r) => r.replayed)).toHaveLength(1)
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify([options[0]]) })
      .where('id', '=', event)
      .execute()
    const replay = await Bookings.createPublicBooking(ctx, input)
    expect(replay.replayed).toBe(true)
    expect(replay.booking.location).toEqual({ kind: 'phone', number: input.inviteePhone })
    const token = results.find((r) => r.manageToken)?.manageToken as string
    const moved = await Bookings.rescheduleManagedBooking(ctx, token, {
      start: Temporal.Instant.from('2026-11-03T09:00Z'),
    })
    expect(await snapshot(moved.booking.id)).toEqual(await snapshot(replay.booking.id))
    await Bookings.cancelManagedBooking(ctx, moved.manageToken as string)
    expect(await snapshot(moved.booking.id)).toEqual(await snapshot(replay.booking.id))
  })
  it('retains the selected office when rescheduling across a daylight-saving transition', async () => {
    const { ctx, input } = await setup()
    const spring = { ...ctx, now: () => Temporal.Instant.from('2026-03-20T12:00Z') }
    const booked = await Bookings.createPublicBooking(spring, {
      ...input,
      locationOptionId: 'office',
      start: Temporal.Instant.from('2026-03-27T09:00Z'),
    })
    const moved = await Bookings.rescheduleManagedBooking(spring, booked.manageToken as string, {
      start: Temporal.Instant.from('2026-03-30T08:00Z'),
    })
    expect(moved.booking.start).toBe('2026-03-30T08:00:00.000Z')
    expect(moved.booking.location).toEqual({ kind: 'in_person', address: 'Private office' })
    expect((await snapshot(moved.booking.id)).location_option).toEqual(options[0])
  })
  async function verifyIdentity(
    module: typeof Bookings,
    field: 'locationOptionId' | 'inviteePhone',
  ) {
    const { ctx, input } = await setup()
    await module.createPublicBooking(ctx, input)
    await expect(
      module.createPublicBooking(ctx, {
        ...input,
        [field]: field === 'locationOptionId' ? 'office' : '+14155550999',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
  }
  it.each(['locationOptionId', 'inviteePhone'] as const)(
    'fingerprints %s and detects its removal',
    async (field) => {
      await verifyIdentity(Bookings, field)
      const copy = await sourceCopy(`        ${field}: input.${field},\n`, '')
      await expect(verifyIdentity(copy, field)).rejects.toMatchObject({ name: 'AssertionError' })
      await verifyIdentity(Bookings, field)
    },
  )
  async function verifyResolvedChoice(module: typeof Bookings) {
    const { ctx, input } = await setup()
    const result = await module.createPublicBooking(ctx, { ...input, locationOptionId: 'office' })
    expect(result.booking.location).toEqual({ kind: 'in_person', address: 'Private office' })
  }
  it.each([
    ['resolved choice persistence', 'location: choice.location,', 'location: current.location,'],
    [
      'explicit option selection',
      '...(input.locationOptionId !== undefined && { optionId: input.locationOptionId }),',
      '...{},',
    ],
  ])('detects loss of %s', async (_name, before, after) => {
    await verifyResolvedChoice(Bookings)
    await expect(
      verifyResolvedChoice(await sourceCopy(before as string, after as string)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyResolvedChoice(Bookings)
  })
  async function verifySnapshot(module: typeof Bookings, move = false) {
    const { ctx, input } = await setup()
    const booked = await module.createPublicBooking(ctx, input)
    const result = move
      ? await module.rescheduleManagedBooking(ctx, booked.manageToken as string, {
          start: Temporal.Instant.from('2026-11-03T09:00Z'),
        })
      : booked
    expect((await snapshot(result.booking.id)).location_option).toEqual(options[1])
  }
  it.each([
    ['creation snapshot', 'locationOption: choice.locationOption,', 'locationOption: null,', false],
    ['reschedule snapshot', 'locationOption: old.location_option,', 'locationOption: null,', true],
  ] as const)('detects lost %s', async (_name, before, after, move) => {
    await verifySnapshot(Bookings, move)
    await expect(verifySnapshot(await sourceCopy(before, after), move)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verifySnapshot(Bookings, move)
  })
  it.each(['google_meet', 'zoom'])(
    'fails a selected unavailable %s without creating a booking',
    async (kind) => {
      const { ctx, input, event } = await setup()
      await db
        .updateTable('event_types')
        .set({ locations: JSON.stringify([options[0], { id: 'video', kind, autoCreate: true }]) })
        .where('id', '=', event)
        .execute()
      await expect(
        Bookings.createPublicBooking(ctx, { ...input, locationOptionId: 'video' }),
      ).rejects.toMatchObject({ code: 'location_unavailable' })
      expect(
        await db.selectFrom('bookings').select('id').where('event_type_id', '=', event).execute(),
      ).toEqual([])
      expect(
        (await Bookings.createPublicBooking(ctx, { ...input, locationOptionId: 'office' })).booking
          .location,
      ).toEqual({ kind: 'in_person', address: 'Private office' })
    },
  )
})

function prepareCopy(change = false) {
  const source = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function prepareChosenBookingConference(')
  let copy = source.slice(start, source.indexOf('/** Final invariant:', start))
  if (change) copy = copy.replace('!preserveLegacyErrors &&', 'false &&')
  return new Function(
    'DomainError',
    'prepareBookingConference',
    `${stripTypeScriptTypes(copy)}; return prepareChosenBookingConference`,
  )(DomainError, async () => {
    throw new DomainError('conflict', 'automatic_zoom_unavailable')
  }) as (...args: unknown[]) => Promise<void>
}
it('maps conference readiness races to the choice conflict and detects a removed boundary', async () => {
  const verify = async (prepare: ReturnType<typeof prepareCopy>) => {
    await expect(prepare({}, {}, 'booking', false)).rejects.toMatchObject({
      code: 'location_unavailable',
    })
    await expect(prepare({}, {}, 'booking', true)).rejects.toMatchObject({
      code: 'automatic_zoom_unavailable',
    })
  }
  await verify(prepareCopy())
  await expect(verify(prepareCopy(true))).rejects.toMatchObject({ name: 'AssertionError' })
  await verify(prepareCopy())
})
