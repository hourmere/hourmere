import type { EventType } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
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
        { id: 'call', kind: 'phone', label: 'Call me', askInvitee: true, isDefault: true },
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

  it.each(['create', 'edit'] as const)(
    'stores invitee phone collection through the %s form serializer',
    async (mode) => {
      const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
      const { emptyDraft, draftFromEventType, toInput, toPatchInput } = await import(formModule)
      const user = await createTestUser(app.db)
      const client = app.as(user.principal)
      const original =
        mode === 'edit'
          ? await client.post('/api/v1/event-types', {
              title: 'Phone consultation',
              slug: 'phone-consultation',
              durationMinutes: 30,
            })
          : null
      if (original) expect(original.status).toBe(201)
      const baseline = original ? draftFromEventType(original.body) : emptyDraft()
      const draft = {
        ...baseline,
        title: 'Phone consultation',
        slug: 'phone-consultation',
        locationKind: 'phone',
        phone: '',
        phoneAskInvitee: true,
      }
      const result = original
        ? await client.patch(
            `/api/v1/event-types/${(original.body as EventType).id}`,
            toPatchInput(draft, baseline),
          )
        : await client.post('/api/v1/event-types', toInput(draft))
      expect(result.status).toBe(mode === 'create' ? 201 : 200)
      const event = result.body as EventType
      expect(event.locations).toEqual([
        { id: draft.primaryLocationId, kind: 'phone', askInvitee: true },
      ])
      expect((await client.get(`/api/v1/event-types/${event.id}`)).body).toEqual(event)
      const stored = await app.db
        .selectFrom('event_types')
        .select('locations')
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow()
      expect(stored.locations).toEqual(event.locations)
    },
  )

  it('retains a named primary location when another option changes', async () => {
    const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
    const { draftFromEventType, toPatchInput } = await import(formModule)
    const user = await createTestUser(app.db)
    const client = app.as(user.principal)
    const created = await client.post('/api/v1/event-types', {
      title: 'Named options',
      slug: 'named-options',
      durationMinutes: 30,
      locations: [
        { id: 'call', kind: 'phone', label: 'Call me', askInvitee: true, isDefault: true },
        { id: 'office', kind: 'in_person', address: '1 Main Street', label: 'Office' },
      ],
    })
    expect(created.status).toBe(201)
    const event = created.body as EventType
    const baseline = draftFromEventType(event)
    const draft = {
      ...baseline,
      locationOptions: baseline.locationOptions.map((option: { id: string }) =>
        option.id === 'office' ? { ...option, address: '2 Main Street' } : option,
      ),
    }
    const updated = await client.patch(
      `/api/v1/event-types/${event.id}`,
      toPatchInput(draft, baseline),
    )
    expect(updated.status).toBe(200)
    expect((updated.body as EventType).locations).toEqual([
      event.locations?.[0],
      { id: 'office', kind: 'in_person', address: '2 Main Street', label: 'Office' },
    ])
    expect((await client.get(`/api/v1/event-types/${event.id}`)).body).toEqual(updated.body)
  })

  it('preserves collective team hosts, their schedules and the conference organizer', async () => {
    const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
    const { draftFromEventType, toPatchInput } = await import(formModule)
    const owner = await createTestUser(app.db)
    const member = await createTestUser(app.db)
    const team = await createTestTeam(app.db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const client = app.as(team.as(owner))
    const schedule = await createFixtures(app.db).schedule(member.id)
    const created = await client.post('/api/v1/event-types', {
      title: 'Panel',
      slug: 'panel',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts: [{ userId: owner.id }, { userId: member.id }],
      conferenceOrganizer: { userId: member.id },
    })
    expect(created.status).toBe(201)
    const eventId = (created.body as EventType).id
    await app.db
      .updateTable('event_type_hosts')
      .set({ schedule_id: schedule })
      .where('event_type_id', '=', eventId)
      .where('user_id', '=', member.id)
      .execute()
    const event = (await client.get(`/api/v1/event-types/${eventId}`)).body as EventType
    const hosts = await app.db
      .selectFrom('event_type_hosts')
      .selectAll()
      .where('event_type_id', '=', event.id)
      .orderBy('user_id')
      .execute()
    const baseline = draftFromEventType(event)
    const updated = await client.patch(
      `/api/v1/event-types/${event.id}`,
      toPatchInput({ ...baseline, title: 'Renamed panel' }, baseline),
    )
    expect(updated.status).toBe(200)
    expect({
      ...(updated.body as EventType),
      title: event.title,
      updatedAt: event.updatedAt,
    }).toEqual(event)
    expect(
      await app.db
        .selectFrom('event_type_hosts')
        .selectAll()
        .where('event_type_id', '=', event.id)
        .orderBy('user_id')
        .execute(),
    ).toEqual(hosts)
    expect(
      await app.db
        .selectFrom('event_types')
        .select('conference_organizer_user_id')
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ conference_organizer_user_id: member.id })
  })

  it.each(['zoom', 'google_meet'] as const)(
    'preserves automatic %s and its saved connection on a title-only REST update',
    async (kind) => {
      const formModule = '../../../web/src/pages/event-types/event-type-form.ts'
      const { draftFromEventType, toPatchInput } = await import(formModule)
      const user = await createTestUser(app.db)
      const client = app.as(user.principal)
      const created = await client.post('/api/v1/event-types', {
        title: 'Automatic meeting',
        slug: 'automatic-meeting',
        durationMinutes: 30,
      })
      expect(created.status).toBe(201)
      const id = (created.body as EventType).id
      // Existing provider configuration is synthetic cached data; this metadata edit must
      // preserve it even when instance conferencing is currently disabled.
      const connection =
        kind === 'zoom'
          ? await app.db
              .insertInto('conference_connections')
              .values({
                user_id: user.id,
                provider: 'zoom',
                external_user_id: user.id,
                credentials: Buffer.from('synthetic'),
                mode: 'meetings',
                status: 'active',
                scopes: [
                  'user:read:user',
                  'meeting:write:meeting',
                  'meeting:read:meeting',
                  'meeting:update:meeting',
                  'meeting:delete:meeting',
                ],
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          : null
      await app.db
        .updateTable('event_types')
        .set({
          location: JSON.stringify({ kind, autoCreate: true }),
          locations: JSON.stringify([{ id: 'conference', kind, autoCreate: true }]),
          zoom_connection_id: connection?.id ?? null,
        })
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
        toPatchInput({ ...baseline, title: 'Renamed automatic meeting' }, baseline),
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
    },
  )

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
