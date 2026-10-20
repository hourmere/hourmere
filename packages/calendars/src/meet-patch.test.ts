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
  const legacyPending = async () => {
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
    return { b, initial, old }
  }

  it('becomes ready without relying on import-created conference requests', async () => {
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

  it.each(['conference', 'reschedule', 'cancel'] as const)(
    'treats HTTP 400 from a known-event %s PATCH as terminal until host retry',
    async (operation) => {
      const b = operation === 'conference' ? await book() : await ready()
      let currentBookingId = b.booking.id
      if (operation === 'reschedule') {
        const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
          start: START.add({ hours: 1 }),
        })
        currentBookingId = moved.booking.id
      } else if (operation === 'cancel') await cancelManagedBooking(ctx, b.manageToken as string)
      const originalId = (await intent()).request_id
      provider.controls.eventPatchStatus = 400
      await work(b.booking.id)
      expect(await intent()).toMatchObject({
        state: 'failed',
        error_code: 'invalid_response',
        external_event_id: 'event-1',
        request_id: originalId,
        create_started: true,
      })
      const stoppedCalls = provider.calls.length
      await work(b.booking.id)
      expect(provider.calls).toHaveLength(stoppedCalls)
      expect(imports()).toHaveLength(1)
      provider.controls.eventPatchStatus = 200
      await retryBookingConference({ ...ctx, principal: owner }, currentBookingId)
      await work(b.booking.id)
      await work(b.booking.id)
      expect(await intent()).toMatchObject({ state: 'ready', request_id: originalId })
      expect(imports()).toHaveLength(1)
    },
  )

  it('converges an old import-created pending request using the same intent UUID', async () => {
    provider.controls.importedConferenceRequestMode = 'process_duplicate'
    const { b, initial, old } = await legacyPending()
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

  it('exhausts ignored import-created requests and host retry only polls the same UUID', async () => {
    provider.controls.importedConferenceRequestMode = 'ignore_duplicate'
    const { b, initial } = await legacyPending()
    for (let attempt = 0; attempt < 12; attempt++) await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'failed',
      error_code: 'conference_pending_timeout',
      attempts: 12,
      request_id: initial.request_id,
      conference_patch_request_id: initial.request_id,
      external_event_id: 'event-1',
    })
    expect(provider.controls.conferenceRequests.get(initial.request_id)).toMatchObject({
      patched: false,
      polls: 0,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
    const stoppedCalls = provider.calls.length
    await work(b.booking.id)
    expect(provider.calls).toHaveLength(stoppedCalls)
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'pending',
      error_code: null,
      attempts: 0,
      request_id: initial.request_id,
      conference_patch_request_id: initial.request_id,
    })
    for (let attempt = 0; attempt < 12; attempt++) await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'failed',
      error_code: 'conference_pending_timeout',
      attempts: 12,
      request_id: initial.request_id,
    })
    expect(conferencePatches()).toHaveLength(1)
    expect(JSON.parse(String(conferencePatches()[0]?.init.body))).toEqual(
      request(initial.request_id),
    )
    expect(imports()).toHaveLength(1)
    expect(provider.controls.conferenceRequests.size).toBe(1)
  })

  it.each([false, true])(
    'repairs an exhausted import UUID on the same event, preserving late success=%s',
    async (lateSuccess) => {
      provider.controls.importedConferenceRequestMode = 'ignore_duplicate'
      provider.controls.conferencePollsBeforeReady = 2
      const { b, initial, old } = await legacyPending()
      for (let attempt = 0; attempt < 12; attempt++) await work(b.booking.id)
      const exhausted = await intent()
      expect(exhausted).toMatchObject({
        state: 'failed',
        error_code: 'conference_pending_timeout',
        attempts: 12,
        request_id: initial.request_id,
        conference_patch_request_id: initial.request_id,
        external_event_id: old.id,
        lease_id: null,
        lease_until: null,
      })

      // Follow docs/google-calendar.md's maintenance procedure with reconciliation stopped.
      const inspected = await provider.client.getConferenceEvent(
        'fake-access',
        'owned@example.com',
        old.id,
        AbortSignal.timeout(1000),
      )
      expect(inspected).toMatchObject({
        id: old.id,
        iCalUID: `${b.booking.id}@hourmere`,
        conferenceData: {
          createRequest: { requestId: initial.request_id, status: { statusCode: 'pending' } },
        },
      })
      expect(inspected.conferenceData?.entryPoints).toBeUndefined()
      const replacement = crypto.randomUUID()
      await db.transaction().execute(async (trx) => {
        const booking = await trx
          .selectFrom('bookings')
          .select(['id', 'status'])
          .where('id', '=', exhausted.booking_id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        const locked = await trx
          .selectFrom('booking_conferences')
          .selectAll()
          .where('root_booking_id', '=', exhausted.root_booking_id)
          .forUpdate()
          .executeTakeFirstOrThrow()
        expect(booking).toEqual({ id: b.booking.id, status: 'confirmed' })
        expect(locked).toEqual(exhausted)
        await trx
          .updateTable('booking_conferences')
          .set({
            request_id: replacement,
            conference_patch_request_id: null,
            error_code: null,
            lease_id: null,
            lease_until: null,
            attempts: 0,
            state: 'pending',
            next_attempt_at: new Date(NOW.epochMilliseconds),
          })
          .where('root_booking_id', '=', exhausted.root_booking_id)
          .execute()
      })
      expect(await intent()).toEqual({
        ...exhausted,
        request_id: replacement,
        conference_patch_request_id: null,
        error_code: null,
        attempts: 0,
        state: 'pending',
        next_attempt_at: new Date(NOW.epochMilliseconds),
      })

      if (lateSuccess) {
        const oldRequest = provider.controls.conferenceRequests.get(initial.request_id)
        if (!oldRequest) throw Error('Synthetic import request missing')
        oldRequest.outcome = 'success'
      }
      const beforePatch: {
        eventId: string
        sentId: string
        durableId: string | undefined
        marker: string | null | undefined
      }[] = []
      const create = provider.client.createConferenceEvent
      vi.spyOn(provider.client, 'createConferenceEvent').mockImplementation(async (...args) => {
        // This independent pool read must see the committed UUID before the provider PATCH.
        const { rows } = await owned.pool.query<{
          request_id: string
          conference_patch_request_id: string | null
        }>(
          'SELECT request_id, conference_patch_request_id FROM booking_conferences WHERE root_booking_id = $1',
          [b.booking.id],
        )
        beforePatch.push({
          eventId: args[2],
          sentId: args[4],
          durableId: rows[0]?.request_id,
          marker: rows[0]?.conference_patch_request_id,
        })
        return create(...args)
      })
      const resumedAt = provider.calls.length
      await writeBookingConference(deps, b.booking.id)
      expect(beforePatch).toEqual(
        lateSuccess
          ? []
          : [{ eventId: old.id, sentId: replacement, durableId: replacement, marker: null }],
      )
      expect(provider.calls[resumedAt]?.init.method ?? 'GET').toBe('GET')
      expect(provider.calls[resumedAt]?.url.pathname).toBe(
        `/calendar/v3/calendars/owned%40example.com/events/${old.id}`,
      )
      if (!lateSuccess) await work(b.booking.id)
      await work(b.booking.id)
      expect(await intent()).toMatchObject({
        state: 'ready',
        error_code: null,
        request_id: replacement,
        conference_patch_request_id: lateSuccess ? null : replacement,
        external_event_id: old.id,
        applied_revision: exhausted.revision,
        organizer_user_id: exhausted.organizer_user_id,
        connection_id: exhausted.connection_id,
        calendar_id: exhausted.calendar_id,
      })
      expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBe(JOIN)
      expect(imports()).toHaveLength(1)
      expect(conferencePatches().map((call) => JSON.parse(String(call.init.body)))).toEqual([
        request(initial.request_id),
        ...(lateSuccess ? [] : [request(replacement)]),
      ])
      expect(provider.controls.storedEvents.size).toBe(1)
      expect(provider.controls.conferenceRequests.size).toBe(lateSuccess ? 1 : 2)
    },
  )

  it('re-GETs after a conference PATCH 412 and converges with the same durable UUID', async () => {
    provider.controls.conferencePatchEtagRaceOnce = true
    const b = await book()
    const initial = await intent()
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'pending',
      request_id: initial.request_id,
      external_event_id: 'event-1',
      conference_patch_request_id: null,
    })
    expect(provider.controls.storedEvents.get('event-1')?.etag).toBe('"v2"')
    expect(provider.controls.conferenceRequests.size).toBe(0)
    await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'pending',
      request_id: initial.request_id,
      conference_patch_request_id: initial.request_id,
    })
    await work(b.booking.id)
    expect(await intent()).toMatchObject({ state: 'ready', request_id: initial.request_id })
    expect(conferencePatches().map((call) => JSON.parse(String(call.init.body)))).toEqual([
      request(initial.request_id),
      request(initial.request_id),
    ])
    expect(
      conferencePatches().map((call) => new Headers(call.init.headers).get('if-match')),
    ).toEqual(['"v1"', '"v2"'])
    expect(
      provider.calls
        .filter((call) => call.url.pathname.endsWith('/event-1'))
        .map((call) => call.init.method ?? 'GET'),
    ).toEqual(['PATCH', 'GET', 'PATCH', 'GET'])
    expect(
      await db.selectFrom('booking_calendar_events').select('etag').executeTakeFirstOrThrow(),
    ).toEqual({ etag: '"v3"' })
    expect(imports()).toHaveLength(1)
    expect(provider.controls.conferenceRequests.size).toBe(1)
  })

  it('bounds pending polling and does not rotate a still-pending request on retry', async () => {
    provider.controls.conferencePollsBeforeReady = 100
    const b = await book()
    const initial = await intent()
    for (let attempt = 0; attempt < 12; attempt++) await work(b.booking.id)
    expect(await intent()).toMatchObject({
      state: 'failed',
      error_code: 'conference_pending_timeout',
    })
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

describe('fake Google conditional conference updates', () => {
  it('rejects stale and reused If-Match values without changing the event or request', async () => {
    const provider = fakeGoogle()
    const event = await provider.client.importEvent(
      'fake-access',
      'owned@example.com',
      {
        iCalUID: 'conditional@hourmere',
        summary: 'Conditional conference',
        start: { dateTime: START.toString() },
        end: { dateTime: START.add({ minutes: 30 }).toString() },
        sequence: 0,
        status: 'confirmed',
        transparency: 'opaque',
      },
      AbortSignal.timeout(1000),
    )
    const imported = structuredClone(provider.controls.storedEvents.get(event.id))
    const create = (etag: string) =>
      provider.client.createConferenceEvent(
        'fake-access',
        'owned@example.com',
        event.id,
        etag,
        'same-durable-uuid',
        AbortSignal.timeout(1000),
      )
    await expect(create('"stale"')).rejects.toMatchObject({ status: 412 })
    expect(provider.controls.storedEvents.get(event.id)).toEqual(imported)
    expect(provider.controls.conferenceRequests.size).toBe(0)
    const accepted = await create(event.etag as string)
    expect(accepted.etag).toBe('"v2"')
    const updated = structuredClone(provider.controls.storedEvents.get(event.id))
    await expect(create(event.etag as string)).rejects.toMatchObject({ status: 412 })
    expect(provider.controls.storedEvents.get(event.id)).toEqual(updated)
    expect(provider.controls.conferenceRequests.get('same-durable-uuid')).toEqual({
      eventId: event.id,
      polls: 0,
      patched: true,
    })
  })
})
