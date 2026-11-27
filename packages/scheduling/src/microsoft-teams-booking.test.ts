import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listPublicSlots } from './availability.ts'
import { createPublicBooking, createPublicTeamBooking } from './bookings.ts'
import type { PublicContext } from './context.ts'
import { createFixtures } from './testing.ts'

const now = () => Temporal.Instant.from('2026-11-01T12:00Z')
const start = Temporal.Instant.from('2026-11-02T09:00Z')
const invitee = { name: 'Guest', email: 'guest@example.test', timeZone: 'UTC' }
const location = { kind: 'microsoft_teams' }

describe.skipIf(!process.env.DATABASE_URL)('Microsoft Teams booking admission', () => {
  let owned: TestDatabase
  let db: Db
  let ctx: PublicContext
  let f: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'teams_admission',
    })
    db = createDb(owned.pool)
    ctx = { db, now, microsoftCalendarEnabled: true }
    f = createFixtures(db)
  })
  afterAll(async () => owned?.drop())

  async function availableHost() {
    const host = await f.host()
    await f.schedule(host.userId)
    const { calendarId } = await f.calendarBusy(host.userId, [], { checkConflicts: false })
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active', scopes: ['Calendars.ReadWrite'] })
      .where('user_id', '=', host.userId)
      .execute()
    await db
      .updateTable('calendars')
      .set({ access_role: 'owner' })
      .where('id', '=', calendarId)
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calendarId })
      .where('user_id', '=', host.userId)
      .execute()
    return host
  }

  it('rejects a forced collective Teams configuration at booking time even with writable destinations', async () => {
    const [first, second] = await Promise.all([availableHost(), availableHost()])
    const handle = 'collective-teams'
    const organizationId = await f.organization(handle)
    for (const host of [first, second]) await f.member(host.userId, organizationId)
    const slug = 'teams'
    const eventTypeId = await f.eventType(organizationId, null, {
      slug,
      location,
      hosts: [{ userId: first.userId }, { userId: second.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'collective' })
      .where('id', '=', eventTypeId)
      .execute()

    await expect(
      createPublicTeamBooking(ctx, { handle, slug, start, invitee }),
    ).rejects.toMatchObject({
      code: 'location_unavailable',
    })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', eventTypeId)
        .execute(),
    ).toEqual([])
  })

  it('refuses Teams slots and booking when Microsoft calendars are disabled', async () => {
    const host = await availableHost()
    const slug = 'teams'
    const eventTypeId = await f.eventType(host.organizationId, host.userId, { slug, location })
    const address = { handle: host.handle, slug, start }
    const query = { ...address, end: start.add({ hours: 1 }) }
    const disabled = { ...ctx, microsoftCalendarEnabled: false }

    await expect(listPublicSlots(disabled, query)).rejects.toMatchObject({
      code: 'location_unavailable',
    })
    await expect(createPublicBooking(disabled, { ...address, invitee })).rejects.toMatchObject({
      code: 'location_unavailable',
    })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', eventTypeId)
        .execute(),
    ).toEqual([])

    expect(await listPublicSlots(ctx, query)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ start: start.toString({ fractionalSecondDigits: 3 }) }),
      ]),
    )
    await expect(createPublicBooking(ctx, { ...address, invitee })).resolves.toMatchObject({
      booking: { status: 'confirmed', location },
    })
  })
})
