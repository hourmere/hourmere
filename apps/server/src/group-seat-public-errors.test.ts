import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = '2027-11-01T09:00:00Z'

describe.skipIf(!process.env.DATABASE_URL)('public group seat error privacy', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  const notify = vi.fn()

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    app = createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [publicRoutes({ db, now: () => NOW, automaticZoom: true, notify })],
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(zoom = false) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId)
    const location = zoom
      ? { kind: 'zoom', autoCreate: true }
      : { kind: 'link', url: 'https://example.test/class' }
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'class' })
    await db
      .updateTable('event_types')
      .set({
        booking_mode: 'group',
        group_capacity: 3,
        location: JSON.stringify(location),
        locations: JSON.stringify([
          { ...location, id: 'shared', isDefault: true },
          { id: 'office', kind: 'in_person', address: 'Other room' },
        ]),
      })
      .where('id', '=', eventId)
      .execute()
    const post = (email: string, locationOptionId = 'shared') =>
      app.request(`/api/v1/public/${host.handle}/class/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: START,
          locationOptionId,
          invitee: { name: 'Guest', email, timeZone: 'UTC' },
        }),
      })
    return { eventId, post }
  }
  async function state() {
    return {
      bookings: await db
        .selectFrom('bookings')
        .select(['id', 'group_slot_id', 'status'])
        .orderBy('id')
        .execute(),
      slots: await db.selectFrom('group_slots').selectAll().orderBy('id').execute(),
      attendees: await db.selectFrom('booking_attendees').selectAll().orderBy('id').execute(),
      notifications: await db.selectFrom('booking_notifications').selectAll().execute(),
      conferences: await db.selectFrom('booking_conferences').selectAll().execute(),
      slotConferences: await db.selectFrom('group_slot_conferences').selectAll().execute(),
      hosts: await db.selectFrom('booking_hosts').selectAll().execute(),
      messages: await db.selectFrom('group_slot_host_messages').selectAll().execute(),
      receipts: await db.selectFrom('group_slot_host_mail_receipts').selectAll().execute(),
    }
  }

  it('returns byte-identical mismatched option errors for a seat holder and stranger without writes or mail', async () => {
    const { post } = await setup()
    const created = await post('holder@example.test')
    expect(created.status).toBe(201)
    const before = await state()
    const mailed = notify.mock.calls.length
    for (const option of ['office', 'unknown-option']) {
      const member = await post('holder@example.test', option)
      const stranger = await post('stranger@example.test', option)
      expect(member.status).toBe(409)
      expect(stranger.status).toBe(member.status)
      const body = await member.text()
      expect(await stranger.text()).toBe(body)
      expect(JSON.parse(body)).toMatchObject({ error: 'location_unavailable' })
      expect(await state()).toEqual(before)
      expect(notify).toHaveBeenCalledTimes(mailed)
    }
  })

  it('keeps unavailable automatic Zoom choice errors visitor-facing for a new occurrence', async () => {
    const { post } = await setup(true)
    const before = await state()
    const mailed = notify.mock.calls.length
    const response = await post('zoom-guest@example.test')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'location_unavailable',
      message: 'The chosen location is unavailable.',
    })
    expect(await state()).toEqual(before)
    expect(notify).toHaveBeenCalledTimes(mailed)
  })
})
