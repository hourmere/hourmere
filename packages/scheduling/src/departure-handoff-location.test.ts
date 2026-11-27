import { randomUUID } from 'node:crypto'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findOneTimeEventType } from './availability.ts'
import { getDepartureHandoffLocation } from './departure-handoff-location.ts'
import type { LocationOption } from './location-options.ts'
import { createFixtures } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('departure handoff location eligibility', () => {
  let database: TestDatabase
  let db: Db

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
  })

  afterAll(async () => {
    await database?.drop()
  })

  async function repairedEvent(locations: LocationOption[]) {
    const fixtures = createFixtures(db)
    const candidateUserId = await fixtures.user('Replacement host')
    const otherUserId = await fixtures.user('Former host')
    const organizationId = await fixtures.organization()
    await fixtures.member(candidateUserId, organizationId)
    const eventTypeId = await fixtures.eventType(organizationId, null, {
      hosts: [{ userId: candidateUserId }],
    })
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify(locations) })
      .where('id', '=', eventTypeId)
      .execute()

    async function readEvent() {
      const event = await findOneTimeEventType(db, eventTypeId)
      if (!event) throw new Error('Expected a bookable replacement event')
      return event
    }

    return { candidateUserId, otherUserId, eventTypeId, readEvent }
  }

  async function calendarDestination(
    userId: string,
    provider: 'google' | 'microsoft',
    scopes: string[],
  ) {
    const { id: connectionId } = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider,
        external_account_id: randomUUID(),
        status: 'active',
        credentials: Buffer.from('synthetic-cache-only-credential'),
        scopes,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: calendarId } = await db
      .insertInto('calendars')
      .values({
        connection_id: connectionId,
        external_id: randomUUID(),
        name: 'Private test calendar',
        access_role: 'owner',
        supports_google_meet: provider === 'google',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: userId,
        handle: `host-${userId.slice(0, 8)}-${userId.slice(-12)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendarId,
      })
      .execute()
    return { connectionId, calendarId }
  }

  async function zoomConnection(userId: string) {
    return (
      await db
        .insertInto('conference_connections')
        .values({
          user_id: userId,
          provider: 'zoom',
          external_user_id: randomUUID(),
          mode: 'meetings',
          status: 'active',
          credentials: Buffer.from('synthetic-cache-only-credential'),
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
    ).id
  }

  it('requires Microsoft calendars to be enabled even with an eligible Teams destination', async () => {
    const { candidateUserId, eventTypeId, otherUserId, readEvent } = await repairedEvent([
      { id: 'teams', kind: 'microsoft_teams' },
    ])
    const { connectionId } = await calendarDestination(candidateUserId, 'microsoft', [
      'Calendars.ReadWrite',
    ])
    const { calendarId: otherCalendar } = await calendarDestination(otherUserId, 'microsoft', [
      'Calendars.ReadWrite',
    ])
    const event = await readEvent()
    const enabled = { db, microsoftCalendarEnabled: true }
    const unavailable = { kind: 'conflict', code: 'location_unavailable' }
    await expect(getDepartureHandoffLocation(enabled, event)).resolves.toBe('microsoft_teams')
    await expect(
      getDepartureHandoffLocation({ db, microsoftCalendarEnabled: false }, event),
    ).rejects.toMatchObject(unavailable)
    await expect(getDepartureHandoffLocation({ db }, event)).rejects.toMatchObject(unavailable)

    await db
      .updateTable('event_type_hosts')
      .set({ destination_calendar_id: otherCalendar })
      .where('event_type_id', '=', eventTypeId)
      .execute()
    await expect(getDepartureHandoffLocation(enabled, event)).rejects.toMatchObject(unavailable)
    await db
      .updateTable('event_type_hosts')
      .set({ destination_calendar_id: null })
      .where('event_type_id', '=', eventTypeId)
      .execute()
    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['Calendars.Read'] })
      .where('id', '=', connectionId)
      .execute()
    await expect(getDepartureHandoffLocation(enabled, event)).rejects.toMatchObject(unavailable)
  })

  it('requires the replacement host’s own Meet-capable writable destination', async () => {
    const { candidateUserId, otherUserId, readEvent } = await repairedEvent([
      { id: 'meet', kind: 'google_meet', autoCreate: true },
    ])
    await calendarDestination(otherUserId, 'google', [...GOOGLE_CALENDAR_SYNC_SCOPES])
    const event = await readEvent()
    const enabled = { db, automaticMeet: true }
    const unavailable = { kind: 'conflict', code: 'automatic_meet_unavailable' }
    await expect(getDepartureHandoffLocation(enabled, event)).rejects.toMatchObject(unavailable)

    const { calendarId } = await calendarDestination(candidateUserId, 'google', [
      ...GOOGLE_CALENDAR_SYNC_SCOPES,
    ])
    await expect(getDepartureHandoffLocation(enabled, event)).resolves.toBe('google_meet')
    await expect(getDepartureHandoffLocation({ db }, event)).rejects.toMatchObject({
      code: 'automatic_meet_disabled',
    })
    await db
      .updateTable('calendars')
      .set({ supports_google_meet: false })
      .where('id', '=', calendarId)
      .execute()
    await expect(getDepartureHandoffLocation(enabled, event)).rejects.toMatchObject(unavailable)
  })

  it('requires the replacement host’s eligible Zoom meetings grant', async () => {
    const { candidateUserId, otherUserId, eventTypeId, readEvent } = await repairedEvent([
      { id: 'zoom', kind: 'zoom', autoCreate: true },
    ])
    const enabled = { db, automaticZoom: true }
    const unavailable = { kind: 'conflict', code: 'automatic_zoom_unavailable' }

    async function configure(id: string) {
      await db
        .updateTable('event_types')
        .set({ zoom_connection_id: id })
        .where('id', '=', eventTypeId)
        .execute()
      return readEvent()
    }

    const oldEvent = await configure(await zoomConnection(otherUserId))
    await expect(getDepartureHandoffLocation(enabled, oldEvent)).rejects.toMatchObject(unavailable)
    const connectionId = await zoomConnection(candidateUserId)
    const repaired = await configure(connectionId)
    await expect(getDepartureHandoffLocation(enabled, repaired)).resolves.toBe('zoom')
    await expect(getDepartureHandoffLocation({ db }, repaired)).rejects.toMatchObject({
      code: 'automatic_zoom_disabled',
    })
    await db
      .updateTable('conference_connections')
      .set({ status: 'needs_reauth', credentials: null })
      .where('id', '=', connectionId)
      .execute()
    await expect(getDepartureHandoffLocation(enabled, repaired)).rejects.toMatchObject(unavailable)
  })

  it('selects current logistics while withholding saved contact and location details', async () => {
    const { readEvent } = await repairedEvent([
      { id: 'call', kind: 'phone', askInvitee: true },
      { id: 'office', kind: 'in_person', address: 'Private office address', isDefault: true },
      { id: 'link', kind: 'link', url: 'https://example.test/private-conference' },
      { id: 'manual', kind: 'google_meet' },
      { id: 'teams', kind: 'microsoft_teams' },
    ])
    const event = await readEvent()
    await expect(getDepartureHandoffLocation({ db }, event)).resolves.toBe('in_person')
    await expect(getDepartureHandoffLocation({ db }, event, 'call', '+12025550100')).resolves.toBe(
      'phone',
    )
    for (const option of ['call', 'link', 'manual', 'teams']) {
      await expect(getDepartureHandoffLocation({ db }, event, option)).rejects.toMatchObject({
        code: 'location_unavailable',
      })
    }
    await expect(getDepartureHandoffLocation({ db }, event, 'old')).rejects.toMatchObject({
      code: 'invalid_location_choice',
    })
  })
})
