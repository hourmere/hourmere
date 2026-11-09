import type { EventType } from '@hourmere/scheduling'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

// The browser's actual load/serialize path is exercised against REST and a disposable DB.
describe.skipIf(!process.env.DATABASE_URL)('collapsed event editor persistence', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await app?.drop()
  })

  it('preserves every configured field and host row when only the title changes', async () => {
    // Runtime import keeps the browser TS/DOM compilation boundary separate from the server.
    const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
    const { draftFromEventType, toPatchInput } = await import(formModule)
    const user = await createTestUser(app.db)
    const schedule = await createFixtures(app.db).schedule(user.id)
    const client = app.as(user.principal)
    const created = await client.post('/api/v1/event-types', {
      title: 'Configured consultation',
      slug: 'configured-consultation',
      description: 'Detailed description',
      durationMinutes: 45,
      allowedDurationsMinutes: [15, 45, 90],
      slotStepMinutes: 15,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 20,
      minimumNoticeMinutes: 120,
      bookingWindowDays: 42,
      maxBookingsPerDay: 2,
      maxBookingsPerWeek: 5,
      maxBookingsPerMonth: 12,
      scheduleId: schedule,
      position: 7,
      isActive: false,
      isHidden: true,
      allowGuests: true,
      locations: [
        { id: 'office', kind: 'in_person', address: '1 Main Street', label: 'Office' },
        { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
      ],
      questions: [
        {
          id: 'topic',
          label: 'Topic',
          type: 'select',
          required: true,
          options: ['Planning', 'Review'],
        },
        { id: 'details', label: 'Details', type: 'long_text', required: false },
      ],
      waitlist: { enabled: true },
      notifications: {
        reminders: [
          {
            id: 'early',
            offsetMinutes: 60,
            recipients: { invitee: true, host: false, guests: false },
          },
        ],
        followUps: [
          {
            id: 'later',
            offsetMinutes: 120,
            recipients: { invitee: false, host: true, guests: false },
          },
        ],
      },
      successRedirect: {
        url: 'https://example.com/thanks',
        parameters: ['eventTypeSlug', 'start'],
        includeInviteePersonalData: false,
        allowEmbedParent: true,
      },
    })
    expect(created.status).toBe(201)
    const event = created.body as EventType
    const before = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow()
    const hosts = await app.db
      .selectFrom('event_type_hosts')
      .selectAll()
      .where('event_type_id', '=', event.id)
      .execute()
    const baseline = draftFromEventType(event)
    const updated = await client.patch(
      `/api/v1/event-types/${event.id}`,
      toPatchInput({ ...baseline, title: 'Renamed consultation' }, baseline),
    )
    expect(updated.status).toBe(200)
    const ignoreMetadata = ({ title: _title, updatedAt: _updated, ...rest }: EventType) => rest
    expect(ignoreMetadata(updated.body as EventType)).toEqual(ignoreMetadata(event))
    expect((await client.get(`/api/v1/event-types/${event.id}`)).body).toEqual(updated.body)
    const after = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow()
    expect({ ...after, title: before.title, updated_at: before.updated_at }).toEqual(before)
    expect(after.title).toBe('Renamed consultation')
    expect(
      await app.db
        .selectFrom('event_type_hosts')
        .selectAll()
        .where('event_type_id', '=', event.id)
        .execute(),
    ).toEqual(hosts)
  })

  it('preserves internal group mode and seat capacity even though the editor does not configure them', async () => {
    const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
    const { draftFromEventType, toPatchInput } = await import(formModule)
    const user = await createTestUser(app.db)
    const client = app.as(user.principal)
    const created = await client.post('/api/v1/event-types', {
      title: 'Group session',
      slug: 'group-session',
      durationMinutes: 30,
    })
    expect(created.status).toBe(201)
    const id = (created.body as EventType).id
    await app.db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 17 })
      .where('id', '=', id)
      .execute()
    const loaded = (await client.get(`/api/v1/event-types/${id}`)).body as EventType
    const before = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const baseline = draftFromEventType(loaded)
    const updated = await client.patch(
      `/api/v1/event-types/${id}`,
      toPatchInput({ ...baseline, title: 'Renamed group' }, baseline),
    )
    expect(updated.status).toBe(200)
    expect({
      ...(updated.body as EventType),
      title: loaded.title,
      updatedAt: loaded.updatedAt,
    }).toEqual(loaded)
    const after = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect({ ...after, title: before.title, updated_at: before.updated_at }).toEqual(before)
    expect(after).toMatchObject({
      title: 'Renamed group',
      booking_mode: 'group',
      group_capacity: 17,
    })
  })
})
