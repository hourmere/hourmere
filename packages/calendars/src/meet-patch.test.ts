import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  cancelManagedBooking,
  createPublicBooking,
  getManagedBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryBookingConference, writeBookingConference } from './conferences.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = Temporal.Instant.from('2030-11-04T09:00:00Z')
const JOIN = 'https://meet.google.com/abc-defg-hij'

describe.skipIf(!serverUrl)('Meet import then conference PATCH recovery (real PostgreSQL)', () => {
  let owned: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof calendarTestSession>>,
    provider: ReturnType<typeof fakeGoogle>,
    deps: CalendarDeps,
    ctx: PublicContext
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    owner = await calendarTestSession(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('profiles').execute()
    await db.deleteFrom('schedules').execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => NOW.epochMilliseconds,
    }
    ctx = { db, now: () => NOW, automaticMeet: true }
    const account = 'fake-google-organizer'
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: owner.user.id,
        provider: 'google',
        external_account_id: account,
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(owner.user.id, account),
          JSON.stringify({
            accessToken: 'fake-access',
            refreshToken: 'fake-refresh',
            expiresAt: NOW.epochMilliseconds + 86_400_000,
          }),
        ),
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'owned@example.com',
        name: 'Synthetic private calendar',
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: owner.user.id,
        handle: 'patch-host',
        time_zone: 'UTC',
        destination_calendar_id: calendar.id,
      })
      .execute()
    const fixtures = createFixtures(db)
    await fixtures.schedule(owner.user.id, { timeZone: 'UTC' })
    await fixtures.eventType(owner.organization.id, owner.user.id, {
      slug: 'meet',
      location: { kind: 'google_meet', autoCreate: true },
    })
  })
  const book = () =>
    createPublicBooking(ctx, {
      handle: 'patch-host',
      slug: 'meet',
      start: START,
      invitee: { name: 'Synthetic Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
      idempotencyKey: 'patch-booking',
    })
  const intent = () => db.selectFrom('booking_conferences').selectAll().executeTakeFirstOrThrow()
  const due = async () => {
    await db
      .updateTable('booking_conferences')
      .set({ next_attempt_at: new Date(NOW.epochMilliseconds), lease_until: null })
      .execute()
  }
  const imports = () => provider.calls.filter((call) => call.init.method === 'POST')
  const patches = () => provider.calls.filter((call) => call.init.method === 'PATCH')
  const conferencePatches = () =>
    patches().filter((call) => JSON.parse(String(call.init.body)).conferenceData)
  const work = async (id: string) => {
    await due()
    await writeBookingConference(deps, id)
  }
  const ready = async () => {
    const b = await book()
    await work(b.booking.id)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    return b
  }
  const request = (requestId: string) => ({
    conferenceData: {
      createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' as const } },
    },
  })

  it('becomes ready when import-only conference requests stay pending forever', async () => {
    const b = await book()
    for (let attempt = 0; attempt < 4; attempt++) await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBe(JOIN)
    expect(imports()).toHaveLength(1)
    expect(provider.controls.conferenceRequests.size).toBe(1)
  })

  it('creates a private root copy then one guarded conference PATCH and becomes ready by polling', async () => {
    const b = await book()
    const initial = await intent()
    await work(b.booking.id)
    expect(imports()).toHaveLength(1)
    expect(imports()[0]?.url.pathname).toBe(
      '/calendar/v3/calendars/owned%40example.com/events/import',
    )
    expect(JSON.parse(String(imports()[0]?.init.body))).toMatchObject({
      iCalUID: `${b.booking.id}@hourmere`,
      status: 'confirmed',
      start: { dateTime: START.toString({ fractionalSecondDigits: 3 }) },
    })
    expect(JSON.parse(String(imports()[0]?.init.body))).not.toHaveProperty('conferenceData')
    expect(conferencePatches()).toHaveLength(1)
    const patch = conferencePatches()[0]
    expect(patch?.url.pathname).toBe('/calendar/v3/calendars/owned%40example.com/events/event-1')
    expect(patch?.url.search).toBe('?sendUpdates=none&conferenceDataVersion=1')
    expect(JSON.parse(String(patch?.init.body))).toEqual(request(initial.request_id))
    expect(await intent()).toMatchObject({ state: 'pending', external_event_id: 'event-1' })
    expect(new Headers(patch?.init.headers).get('if-match')).toBe('"v1"')
    for (const call of [...imports(), ...patches()])
      expect(JSON.parse(String(call.init.body))).not.toHaveProperty('attendees')
    expect(provider.calls.some((call) => call.init.method === 'DELETE')).toBe(false)
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'ready',
      external_event_id: 'event-1',
      conference_patch_request_id: initial.request_id,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBe(JOIN)
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(1)
  })

  it('recovers a lost import response without a second import', async () => {
    const b = await book()
    const original = provider.client.importEvent
    vi.spyOn(provider.client, 'importEvent').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new TypeError('synthetic lost import response')
    })
    await work(b.booking.id)
    expect(await intent()).toMatchObject({ state: 'failed', error_code: 'ambiguous_create' })
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    await work(b.booking.id)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(1)
  })

  it('recovers a crash after import before conference PATCH using the known event', async () => {
    const b = await book()
    const create = vi.spyOn(provider.client, 'createConferenceEvent')
    create.mockRejectedValueOnce(new TypeError('synthetic crash before PATCH'))
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'pending',
      external_event_id: 'event-1',
      create_started: true,
      conference_patch_request_id: null,
    })
    expect(conferencePatches()).toHaveLength(0)
    await work(b.booking.id)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(1)
  })

  it('replays the same durable UUID after a lost PATCH response without a second conference', async () => {
    provider.controls.conferencePollsBeforeReady = 4
    const b = await book()
    const original = provider.client.createConferenceEvent
    vi.spyOn(provider.client, 'createConferenceEvent').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new TypeError('synthetic lost PATCH response')
    })
    await work(b.booking.id)
    const initial = await intent()
    expect(initial).toMatchObject({
      state: 'pending',
      external_event_id: 'event-1',
      conference_patch_request_id: null,
    })
    for (let attempt = 0; attempt < 4; attempt++) await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(conferencePatches()).toHaveLength(2)
    expect(conferencePatches().map((call) => JSON.parse(String(call.init.body)))).toEqual([
      request(initial.request_id),
      request(initial.request_id),
    ])
    expect(provider.controls.conferenceRequests.size).toBe(1)
    expect(imports()).toHaveLength(1)
  })

  it.each([429, 404])(
    'PATCH HTTP %s preserves the imported event and never permits another import',
    async (status) => {
      const b = await book()
      provider.controls.eventPatchStatus = status
      await work(b.booking.id)
      const failed = await intent()
      expect(failed.external_event_id).toBe('event-1')
      expect(failed.create_started).toBe(true)
      provider.controls.eventPatchStatus = 200
      if (failed.state === 'failed')
        await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
      await work(b.booking.id)
      await work(b.booking.id)
      expect((await intent()).state).toBe('ready')
      expect(imports()).toHaveLength(1)
    },
  )

  it('converges an old import-created pending request using the same intent UUID', async () => {
    const b = await book()
    const initial = await intent()
    const old = await provider.client.importEvent(
      'fake-access',
      'owned@example.com',
      {
        iCalUID: `${b.booking.id}@hourmere`,
        summary: 'Legacy pending',
        start: { dateTime: START.toString() },
        end: { dateTime: START.add({ minutes: 30 }).toString() },
        sequence: 0,
        status: 'confirmed',
        transparency: 'opaque',
        ...request(initial.request_id),
      },
      AbortSignal.timeout(1000),
    )
    await db
      .updateTable('booking_conferences')
      .set({ create_started: true, external_event_id: old.id, attempts: 11 })
      .execute()
    for (let poll = 0; poll < 20; poll++)
      expect(
        (
          await provider.client.getConferenceEvent(
            'fake-access',
            'owned@example.com',
            old.id,
            AbortSignal.timeout(1000),
          )
        ).conferenceData?.createRequest?.status?.statusCode,
      ).toBe('pending')
    await work(b.booking.id)
    expect((await intent()).state).toBe('pending')
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(1)
    expect(JSON.parse(String(conferencePatches()[0]?.init.body))).toEqual(
      request(initial.request_id),
    )
    expect(provider.controls.conferenceRequests.size).toBe(1)
  })

  it('bounds pending polling and does not rotate a still-pending request on retry', async () => {
    provider.controls.conferencePollsBeforeReady = 100
    const b = await book()
    const initial = await intent()
    for (let attempt = 0; attempt < 12; attempt++) await work(b.booking.id)
    expect((await intent()).state).toBe('failed')
    expect(conferencePatches()).toHaveLength(1)
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    await work(b.booking.id)
    expect((await intent()).request_id).toBe(initial.request_id)
    expect(conferencePatches()).toHaveLength(1)
    expect(imports()).toHaveLength(1)
  })

  it('keeps an already ready legacy conference with NULL PATCH acknowledgement even on retry', async () => {
    const b = await ready()
    await db
      .updateTable('booking_conferences')
      .set({
        state: 'pending',
        conference_patch_request_id: null,
        retry_conference: true,
      })
      .execute()
    const original = await intent()
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBe(JOIN)
    expect(conferencePatches()).toHaveLength(1)
    expect(imports()).toHaveLength(1)
    expect((await intent()).request_id).toBe(original.request_id)
    expect(provider.controls.conferenceRequests.size).toBe(1)
  })

  it('retains the known event and conference URL across move and cancel without attendees or DELETE', async () => {
    const b = await ready()
    const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
      start: START.add({ hours: 1 }),
    })
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect((await getManagedBooking(ctx, moved.manageToken as string)).location?.url).toBe(JOIN)
    await cancelManagedBooking(ctx, moved.manageToken as string)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(1)
    expect(patches()).toHaveLength(3)
    for (const patch of patches()) {
      expect(patch.url.search).toBe('?sendUpdates=none&conferenceDataVersion=1')
      expect(patch.url.pathname.endsWith('/event-1')).toBe(true)
      expect(new Headers(patch.init.headers).get('if-match')).not.toBeNull()
      expect(JSON.parse(String(patch.init.body))).not.toHaveProperty('attendees')
    }
    expect(JSON.parse(String(patches()[2]?.init.body))).toHaveProperty('status', 'cancelled')
    expect(provider.calls.some((call) => call.init.method === 'DELETE')).toBe(false)
  })

  it('refuses conference creation without an ETag and safely retries the known event', async () => {
    const b = await book()
    const original = provider.client.importEvent
    vi.spyOn(provider.client, 'importEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args)
      return { ...event, etag: undefined }
    })
    await work(b.booking.id)
    expect((await intent()).state).toBe('pending')
    expect(conferencePatches()).toHaveLength(0)
    await work(b.booking.id)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
  })

  it('does not acknowledge a provider response for another conference request', async () => {
    const b = await book()
    const original = provider.client.createConferenceEvent
    vi.spyOn(provider.client, 'createConferenceEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args)
      return {
        ...event,
        conferenceData: {
          ...event.conferenceData,
          createRequest: { requestId: crypto.randomUUID(), status: { statusCode: 'pending' } },
        },
      }
    })
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      conference_patch_request_id: null,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
  })

  it('does not acknowledge a malformed PATCH result and explicit retry converges with the same UUID', async () => {
    provider.controls.conferencePollsBeforeReady = 4
    const b = await book()
    const original = provider.client.createConferenceEvent
    vi.spyOn(provider.client, 'createConferenceEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args)
      return { ...event, conferenceData: undefined }
    })
    await work(b.booking.id)
    const failed = await intent()
    expect(failed).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      conference_patch_request_id: null,
    })
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    for (let poll = 0; poll < 4; poll++) await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect((await intent()).request_id).toBe(failed.request_id)
    expect(conferencePatches()).toHaveLength(2)
    expect(conferencePatches().map((call) => JSON.parse(String(call.init.body)))).toEqual([
      request(failed.request_id),
      request(failed.request_id),
    ])
    expect(imports()).toHaveLength(1)
  })

  it('a stale request completion cannot acknowledge a newer durable UUID', async () => {
    const b = await book()
    const replacement = crypto.randomUUID()
    const original = provider.client.createConferenceEvent
    vi.spyOn(provider.client, 'createConferenceEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args)
      await db.updateTable('booking_conferences').set({ request_id: replacement }).execute()
      return event
    })
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'pending',
      request_id: replacement,
      conference_patch_request_id: null,
      external_event_id: 'event-1',
      lease_id: null,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
  })

  it('lease expiry after an accepted PATCH replays the original UUID and converges', async () => {
    provider.controls.conferencePollsBeforeReady = 3
    const b = await book()
    const replacement = crypto.randomUUID()
    const original = provider.client.createConferenceEvent
    vi.spyOn(provider.client, 'createConferenceEvent').mockImplementationOnce(async (...args) => {
      const event = await original(...args)
      await db.updateTable('booking_conferences').set({ lease_id: replacement }).execute()
      return event
    })
    await work(b.booking.id)
    const stale = await intent()
    expect(stale).toMatchObject({
      state: 'pending',
      lease_id: replacement,
      conference_patch_request_id: null,
      external_event_id: 'event-1',
    })
    for (let poll = 0; poll < 3; poll++) await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(provider.controls.conferenceRequests.size).toBe(1)
    expect(conferencePatches()).toHaveLength(2)
    expect(conferencePatches().map((call) => JSON.parse(String(call.init.body)))).toEqual([
      request(stale.request_id),
      request(stale.request_id),
    ])
  })

  it.each([false, true])(
    'does not revive a remotely cancelled event with changed times=%s',
    async (changedTimes) => {
      const b = await ready()
      const stored = provider.controls.storedEvents.get('event-1')
      if (!stored) throw Error('Synthetic event missing')
      provider.controls.storedEvents.set('event-1', {
        ...stored,
        status: 'cancelled',
        ...(changedTimes ? { start: { dateTime: START.add({ hours: 2 }).toString() } } : {}),
      })
      await db.updateTable('booking_conferences').set({ state: 'pending' }).execute()
      const before = patches().length
      await work(b.booking.id)
      expect(await intent()).toMatchObject({ state: 'failed', error_code: 'invalid_response' })
      expect(patches()).toHaveLength(before)
      expect(imports()).toHaveLength(1)
      expect(provider.controls.storedEvents.get('event-1')?.status).toBe('cancelled')
    },
  )

  it('reports PATCH conference failure and durably rotates the request only on an explicit failure retry', async () => {
    provider.controls.conferenceOutcome = 'failure'
    const b = await book()
    await work(b.booking.id)
    await work(b.booking.id)
    const failed = await intent()
    expect(failed).toMatchObject({ state: 'failed', error_code: 'conference_failed' })
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    const retry = await intent()
    expect(retry.request_id).not.toBe(failed.request_id)
    provider.controls.conferenceOutcome = 'success'
    await work(b.booking.id)
    await work(b.booking.id)
    expect((await intent()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(conferencePatches()).toHaveLength(2)
    expect(JSON.parse(String(conferencePatches()[1]?.init.body))).toEqual(request(retry.request_id))
  })
})
