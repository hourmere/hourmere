import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createLogMailer, type MailMessage } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createEventType,
  createPublicBooking,
  createPublicTeamBooking,
  getManagedBooking,
  type PublicContext,
  rescheduleManagedBooking,
  updateEventType,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeBookingCalendar } from '../../calendars/src/booking-events.ts'
import { retryBookingConference, writeBookingConference } from '../../calendars/src/conferences.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../calendars/src/google.ts'
import type { CalendarDeps } from '../../calendars/src/index.ts'
import { beginGoogleConnection, finishGoogleConnection } from '../../calendars/src/index.ts'
import { setCalendarDestination } from '../../calendars/src/sync.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../calendars/src/testing.ts'
import {
  dispatchConferenceNotifications,
  sendBookingNotification,
} from '../../notifications/src/index.ts'
import { conferenceEncryptionKey } from './credentials.ts'
import {
  authorizeZoomMeetings,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { credentials } from './tokens.ts'
import { createZoomConferenceWork } from './worker.ts'
import { zoomScopes } from './zoom.ts'

const serverUrl = process.env.DATABASE_URL,
  NOW = Temporal.Instant.from('2030-11-03T12:00:00Z'),
  START = '2030-11-04T09:00:00Z'
function barrier<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe.skipIf(!serverUrl)('automatic Zoom durable booking lifecycle (real Postgres)', () => {
  let owned: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    provider: ReturnType<typeof fakeZoom>,
    conference: ConferenceDeps,
    deps: CalendarDeps,
    ctx: PublicContext,
    connectionId: string,
    eventId: string
  let sent: MailMessage[]
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    owner = await conferenceTestSession(db)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2035-01-01Z') })
      .execute()
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('profiles').execute()
    await db.deleteFrom('schedules').execute()
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeZoom('http://localhost:5173', () => NOW.epochMilliseconds)
    provider.controls.token.scope = zoomScopes('meetings').join(' ')
    conference = {
      db,
      now: () => NOW.epochMilliseconds,
      zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true },
    }
    const url = new URL((await authorizeZoomMeetings(conference, owner)).authorizationUrl)
    expect(
      await finishZoomConnection(
        conference,
        owner,
        new URLSearchParams({
          state: url.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    connectionId = (
      await db.selectFrom('conference_connections').select('id').executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'zoom-host', time_zone: 'UTC' })
      .execute()
    await createFixtures(db).schedule(owner.user.id, { timeZone: 'UTC' })
    eventId = (
      await createEventType(
        { ...conference, principal: owner, now: () => NOW, automaticZoom: true },
        {
          slug: 'zoom',
          title: 'Synthetic Zoom',
          durationMinutes: 30,
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connectionId,
        },
      )
    ).id
    deps = {
      db,
      now: () => NOW.epochMilliseconds,
      zoomConferenceWork: createZoomConferenceWork(conference, provider.meetings),
    }
    ctx = { db, automaticZoom: true, now: () => NOW }
    sent = []
  })
  const row = () => db.selectFrom('booking_conferences').selectAll().executeTakeFirstOrThrow()
  const book = (key = 'same-key') =>
    createPublicBooking(ctx, {
      handle: 'zoom-host',
      slug: 'zoom',
      start: Temporal.Instant.from(START),
      invitee: { name: 'Synthetic Invitee', email: 'synthetic@example.com', timeZone: 'UTC' },
      idempotencyKey: key,
    })
  const posts = () =>
    provider.calls.filter((c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'))
  const mail = () => ({
    db,
    publicUrl: 'https://hourmere.invalid',
    now: () => NOW,
    mailer: {
      send: async (message: MailMessage) => {
        sent.push(message)
      },
    },
  })
  it('creates one pinned meeting without Google and returns no private pin or participant URL before ready', async () => {
    const b = await book(),
      retry = await book()
    expect(retry.booking.id).toBe(b.booking.id)
    expect(b.booking.conference).toEqual({ provider: 'zoom', status: 'pending', errorCode: null })
    expect(b.booking.location?.url).toBeUndefined()
    const initial = await row()
    expect(initial).toMatchObject({
      provider: 'zoom',
      zoom_connection_id: connectionId,
      zoom_user_id: 'synthetic-zoom-identity',
      calendar_id: null,
      connection_id: null,
    })
    expect(await db.selectFrom('booking_conference_mirrors').selectAll().execute()).toMatchObject([
      { user_id: owner.user.id, state: 'not_configured', calendar_id: null, connection_id: null },
    ])
    await writeBookingConference(deps, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    const ready = await row()
    expect(ready.state).toBe('ready')
    expect(ready.zoom_meeting_id).toBe('81234567890')
    expect(posts()).toHaveLength(1)
    const managed = await getManagedBooking(ctx, b.manageToken as string)
    expect(managed.location?.url).toContain('?pwd=synthetic-only.1')
    expect(JSON.stringify(managed)).not.toMatch(
      /zoom_connection_id|zoom_user_id|synthetic-private-start|synthetic-raw-passcode/,
    )
  })
  it('holds final mail/ICS until ready, deduplicates release and redacts the development mail log', async () => {
    const b = await book()
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(0)
    await writeBookingConference(deps, b.booking.id)
    await dispatchConferenceNotifications(mail())
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(2)
    expect(
      sent.every(
        (m) =>
          m.sensitive &&
          m.text.includes('https://us02web.zoom.us/j/') &&
          m.attachments?.[0]?.content.includes(`${b.booking.id}@hourmere`),
      ),
    ).toBe(true)
    const logs: string[] = []
    await createLogMailer((line) => logs.push(line)).send(sent[0] as MailMessage)
    expect(logs.join('')).not.toMatch(/synthetic-only|zoom\.us|token=|synthetic@example/)
  })
  it('reschedules and cancels the same meeting and UID, retaining pins even after event settings change', async () => {
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const first = await row()
    await updateEventType({ db, principal: owner, automaticZoom: true, now: () => NOW }, eventId, {
      location: { kind: 'zoom' },
      zoomConnectionId: null,
    })
    const moved = await rescheduleManagedBooking(
      { ...ctx, automaticZoom: false },
      b.manageToken as string,
      { start: Temporal.Instant.from('2030-11-04T11:00Z') },
    )
    expect(moved.booking.conference?.status).toBe('pending')
    expect(moved.booking.location?.url).toBeUndefined()
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      state: 'ready',
      zoom_meeting_id: first.zoom_meeting_id,
      zoom_connection_id: first.zoom_connection_id,
      booking_id: moved.booking.id,
    })
    expect(posts()).toHaveLength(1)
    expect(provider.calls.filter((c) => c.init.method === 'PATCH').map((c) => c.url)).toEqual([
      `https://api.zoom.us/v2/meetings/${first.zoom_meeting_id}`,
    ])
    await cancelManagedBooking(ctx, moved.manageToken as string)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(provider.controls.storedMeetings.size).toBe(0)
    expect(posts()).toHaveLength(1)
  })
  it('never POSTs again after an unknown accepted create, retry, cancellation or an empty provider store', async () => {
    const b = await book()
    provider.controls.meetingHook = async () => {
      throw new Error('synthetic unknown accepted create')
    }
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      create_started: true,
      zoom_meeting_id: null,
    })
    provider.controls.meetingHook = undefined
    await retryBookingConference({ db, principal: owner, now: () => NOW }, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    expect(posts()).toHaveLength(1)
    expect((await row()).error_code).toBe('ambiguous_create')
    await cancelManagedBooking(ctx, b.manageToken as string)
    await writeBookingConference(deps, b.booking.id)
    expect(posts()).toHaveLength(1)
    expect((await row()).error_code).toBe('ambiguous_create')
    expect(
      provider.calls.filter((c) => c.url.includes('/meetings') && c.init.method === 'GET'),
    ).toHaveLength(0)
  })
  it('retains a validated known ID after an unsafe response and only retries that ID', async () => {
    const b = await book()
    provider.controls.meetingHook = async (_url, init) => {
      const body = JSON.parse(String(init.body)),
        value = {
          ...body,
          id: 81234567890,
          host_id: 'synthetic-zoom-identity',
          join_url: 'https://untrusted.invalid/room',
        }
      provider.controls.storedMeetings.set('81234567890', value)
      return Response.json(value)
    }
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      zoom_meeting_id: '81234567890',
    })
    const stored = provider.controls.storedMeetings.get('81234567890') as Record<string, unknown>
    stored.join_url = 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
    provider.controls.meetingHook = undefined
    await retryBookingConference({ db, principal: owner, now: () => NOW }, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(posts()).toHaveLength(1)
  })
  it('commits the create claim before network and lets cancellation finish while POST waits, then retains the late ID for cleanup', async () => {
    const b = await book(),
      entered = barrier(),
      release = barrier<Response>()
    provider.controls.meetingHook = async () => {
      entered.resolve()
      return release.promise
    }
    const running = writeBookingConference(deps, b.booking.id)
    await entered.promise
    expect(await row()).toMatchObject({ create_started: true, zoom_meeting_id: null })
    await cancelManagedBooking(ctx, b.manageToken as string)
    release.resolve(
      Response.json({
        id: 81234567890,
        host_id: 'synthetic-zoom-identity',
        type: 2,
        join_url: 'https://zoom.us/j/81234567890',
        start_time: START,
        duration: 30,
      }),
    )
    await running
    expect(await row()).toMatchObject({ state: 'pending', zoom_meeting_id: '81234567890' })
    expect(posts()).toHaveLength(1)
    provider.controls.meetingHook = undefined
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(posts()).toHaveLength(1)
  })
  it('serializes concurrent workers and never makes a replacement POST after a lost result/expired lease', async () => {
    const b = await book()
    await Promise.all([
      writeBookingConference(deps, b.booking.id),
      writeBookingConference(deps, b.booking.id),
    ])
    expect(posts()).toHaveLength(1)
    await db
      .updateTable('booking_conferences')
      .set({
        state: 'pending',
        zoom_meeting_id: null,
        applied_revision: null,
        lease_until: null,
        next_attempt_at: new Date(NOW.epochMilliseconds),
      })
      .execute()
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('ambiguous_create')
    expect(posts()).toHaveLength(1)
  })
  it('does not replace a missing known meeting or reuse unsafe rotating credentials', async () => {
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    provider.controls.storedMeetings.clear()
    const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
      start: Temporal.Instant.from('2030-11-04T11:00Z'),
    })
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('conference_failed')
    expect(posts()).toHaveLength(1)
    await disconnectConference(conference, owner, connectionId)
    await retryBookingConference({ db, principal: owner, now: () => NOW }, moved.booking.id)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('needs_reauth')
    expect(posts()).toHaveLength(1)
  })
  it('rejects non-host/key configuration while permitting ordinary metadata/disable changes and rejects collective/round robin', async () => {
    const key = { ...owner, kind: 'api_key' as const, apiKeyId: 'synthetic-key' }
    await expect(
      updateEventType({ db, principal: key, automaticZoom: true, now: () => NOW }, eventId, {
        zoomConnectionId: null,
      }),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
    await expect(
      createEventType(
        { db, principal: key, automaticZoom: true, now: () => NOW },
        {
          slug: 'key',
          title: 'Key',
          durationMinutes: 30,
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connectionId,
        },
      ),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
    await expect(
      updateEventType({ db, principal: key, now: () => NOW }, eventId, {
        title: 'Changed metadata',
      }),
    ).resolves.toMatchObject({ title: 'Changed metadata', zoomConnectionId: connectionId })
    await expect(
      updateEventType({ db, principal: key, now: () => NOW }, eventId, {
        location: { kind: 'zoom' },
        zoomConnectionId: null,
      }),
    ).resolves.toMatchObject({ location: { kind: 'zoom' } })
    const f = createFixtures(db),
      team = await f.organization('zoom-policy-team')
    await f.member(owner.user.id, team, 'owner')
    const principal = {
      ...owner,
      organization: {
        id: team,
        name: 'zoom-policy-team',
        slug: 'zoom-policy-team',
        personal: false,
      },
    }
    await expect(
      createEventType(
        { db, principal, automaticZoom: true, now: () => NOW },
        {
          slug: 'rr',
          title: 'RR',
          durationMinutes: 30,
          schedulingType: 'round_robin',
          hosts: [{ userId: owner.user.id }],
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connectionId,
        },
      ),
    ).rejects.toMatchObject({ code: 'automatic_zoom_host_policy' })
  })
  it('pins the organizer optional Google copy at commit, uses an ordinary ready-link import and never adds a later destination', async () => {
    const google = fakeGoogle()
    google.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    const calendar: CalendarDeps = {
      db,
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => NOW.epochMilliseconds,
    }
    const auth = new URL((await beginGoogleConnection(calendar, owner, 'sync')).authorizationUrl)
    expect(
      await finishGoogleConnection(
        calendar,
        owner,
        new URLSearchParams({
          state: auth.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    const calendarId = (await db.selectFrom('calendars').select('id').executeTakeFirstOrThrow()).id
    await setCalendarDestination(calendar, owner, calendarId)
    const b = await book()
    expect(await row()).toMatchObject({ provider: 'zoom', calendar_id: null, connection_id: null })
    expect(await db.selectFrom('booking_conference_mirrors').selectAll().execute()).toMatchObject([
      { user_id: owner.user.id, calendar_id: calendarId, state: 'pending' },
    ])
    await writeBookingCalendar(calendar, b.booking.id)
    expect(
      google.calls.filter((c) => c.init.method === 'POST' && c.url.pathname.endsWith('/import')),
    ).toHaveLength(0)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(calendar, b.booking.id)
    const imports = google.calls.filter(
      (c) => c.init.method === 'POST' && c.url.pathname.endsWith('/import'),
    )
    expect(imports).toHaveLength(1)
    const payload = JSON.parse(String(imports[0]?.init.body))
    expect(payload.location).toContain('https://us02web.zoom.us/j/81234567890')
    expect(payload).not.toHaveProperty('conferenceData')
    expect(payload).not.toHaveProperty('attendees')
    expect((await row()).state).toBe('ready')
    expect(await db.selectFrom('booking_conference_mirrors').selectAll().execute()).toMatchObject([
      { state: 'ready' },
    ])
    google.controls.eventHook = async (url, init) => {
      const id = url.pathname.split('/').at(-1) as string,
        prior = google.controls.storedEvents.get(id)
      if (!prior) return Response.json({}, { status: 404 })
      if (init.method === 'PATCH') {
        const value = { ...prior, ...JSON.parse(String(init.body)), etag: '"v2"' }
        google.controls.storedEvents.set(id, value)
        return Response.json(value)
      }
      return Response.json(prior)
    }
    await db.updateTable('profiles').set({ destination_calendar_id: null }).execute()
    const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
      start: Temporal.Instant.from('2030-11-04T11:00Z'),
    })
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(calendar, b.booking.id)
    expect(await db.selectFrom('booking_conference_mirrors').selectAll().execute()).toMatchObject([
      { calendar_id: calendarId, state: 'ready' },
    ])
    expect(posts()).toHaveLength(1)
    await cancelManagedBooking(ctx, moved.manageToken as string)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(calendar, b.booking.id)
    expect(google.controls.storedEvents.get('event-1')?.status).toBe('cancelled')
  })
  it('does not attach a later Google destination to an old Zoom root or let a mirror failure hide ready Zoom', async () => {
    const original = await book()
    await writeBookingConference(deps, original.booking.id)
    // A same-key retry after readiness still identifies the original reservation.
    expect((await book()).booking.id).toBe(original.booking.id)
    expect(posts()).toHaveLength(1)
    const google = fakeGoogle()
    google.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    const calendar: CalendarDeps = {
      db,
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => NOW.epochMilliseconds,
    }
    const auth = new URL((await beginGoogleConnection(calendar, owner, 'sync')).authorizationUrl)
    expect(
      await finishGoogleConnection(
        calendar,
        owner,
        new URLSearchParams({
          state: auth.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    const calendarId = (await db.selectFrom('calendars').select('id').executeTakeFirstOrThrow()).id
    await setCalendarDestination(calendar, owner, calendarId)
    await writeBookingCalendar(calendar, original.booking.id)
    const moved = await rescheduleManagedBooking(ctx, original.manageToken as string, {
      start: Temporal.Instant.from('2030-11-04T11:00Z'),
    })
    await writeBookingConference(deps, original.booking.id)
    await writeBookingCalendar(calendar, original.booking.id)
    expect(await db.selectFrom('booking_conference_mirrors').selectAll().execute()).toMatchObject([
      { state: 'not_configured', calendar_id: null, connection_id: null },
    ])
    expect(
      google.calls.filter((c) => c.init.method === 'POST' && c.url.pathname.endsWith('/import')),
    ).toHaveLength(0)
    expect((await getManagedBooking(ctx, moved.manageToken as string)).location?.url).toContain(
      '/j/81234567890',
    )
    // A new booking commits a configured pin; a later calendar failure remains private.
    const next = await book('second-root')
    await db.updateTable('calendar_connections').set({ status: 'needs_reauth' }).execute()
    await writeBookingConference(deps, next.booking.id)
    await writeBookingCalendar(calendar, next.booking.id)
    expect(
      await db
        .selectFrom('booking_conference_mirrors')
        .selectAll()
        .where('root_booking_id', '=', next.booking.id)
        .execute(),
    ).toMatchObject([{ state: 'failed', error_code: 'needs_reauth', calendar_id: calendarId }])
    const ready = await getManagedBooking(ctx, next.manageToken as string)
    expect(ready.conference?.status).toBe('ready')
    expect(ready.location?.url).toContain('/j/')
    expect(posts()).toHaveLength(2)
    await sendBookingNotification(mail(), next.booking.id, 'confirmed')
    await dispatchConferenceNotifications(mail())
    expect(sent.some((message) => message.attachments?.length)).toBe(true)
  })
  it('retires an expired rotating token before I/O and never retries it after a malformed grant', async () => {
    const value = credentials(
      conferenceEncryptionKey(TEST_CONFERENCE_KEY),
      owner.user.id,
      connectionId,
      'synthetic-zoom-identity',
      {
        accessToken: 'expired-access',
        refreshToken: 'retire-only-once',
        expiresAt: NOW.epochMilliseconds - 1,
        scopes: zoomScopes('meetings'),
      },
      'meetings',
    )
    await db
      .updateTable('conference_connections')
      .set({ credentials: value })
      .where('id', '=', connectionId)
      .execute()
    const b = await book(),
      entered = barrier(),
      release = barrier<Response>()
    provider.controls.tokenHook = async () => {
      entered.resolve()
      return release.promise
    }
    const running = writeBookingConference(deps, b.booking.id)
    await entered.promise
    expect(
      await db
        .selectFrom('conference_connections')
        .select(['status', 'credentials'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'refreshing', credentials: null })
    release.resolve(
      Response.json({
        ...provider.controls.token,
        scope: 'user:read:user',
        refresh_token: 'unusable-new-refresh',
      }),
    )
    await running
    expect(await row()).toMatchObject({
      state: 'failed',
      error_code: 'permissions_missing',
      create_started: false,
    })
    expect(
      await db
        .selectFrom('conference_connections')
        .select(['status', 'credentials'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'needs_reauth', credentials: null })
    await retryBookingConference({ db, principal: owner, now: () => NOW }, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    const refreshCalls = provider.calls.filter(
      (c) => new URLSearchParams(String(c.init.body)).get('grant_type') === 'refresh_token',
    )
    expect(refreshCalls).toHaveLength(1)
    expect(posts()).toHaveLength(0)
  })
  it('preserves the discovered meeting ID when the provider transaction cannot commit', async () => {
    const b = await book()
    let fail = true
    const dbWithFailure = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction')
          return () => ({
            execute: async (body: (trx: Db) => Promise<unknown>) =>
              target.transaction().execute(async (trx) => {
                const result = await body(trx)
                if (fail) {
                  fail = false
                  throw new Error('synthetic provider transaction commit failure')
                }
                return result
              }),
          })
        return Reflect.get(target, prop, receiver)
      },
    }) as Db
    deps.zoomConferenceWork = createZoomConferenceWork(
      { ...conference, db: dbWithFailure },
      provider.meetings,
    )
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      state: 'pending',
      zoom_meeting_id: '81234567890',
      create_started: true,
    })
    expect(posts()).toHaveLength(1)
    await db
      .updateTable('booking_conferences')
      .set({ next_attempt_at: new Date(NOW.epochMilliseconds) })
      .execute()
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(posts()).toHaveLength(1)
  })
  it('late discovery revives an intervening failed ambiguous lease and cancellation cleans up that exact ID', async () => {
    const b = await book(),
      committed = barrier(),
      release = barrier()
    let pause = true
    const afterCommit = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction')
          return () => ({
            execute: async (body: (trx: Db) => Promise<unknown>) => {
              const result = await target.transaction().execute(body)
              if (pause) {
                pause = false
                committed.resolve()
                await release.promise
              }
              return result
            },
          })
        return Reflect.get(target, prop, receiver)
      },
    }) as Db
    deps.zoomConferenceWork = createZoomConferenceWork(
      { ...conference, db: afterCommit },
      provider.meetings,
    )
    const original = writeBookingConference(deps, b.booking.id)
    await committed.promise
    // HTTP POST and credential commit have completed, but the root has not learned the ID.
    await db
      .updateTable('booking_conferences')
      .set({ lease_until: new Date(NOW.epochMilliseconds - 1) })
      .execute()
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('failed')
    expect((await row()).error_code).toBe('ambiguous_create')
    release.resolve()
    await original
    expect(await row()).toMatchObject({
      state: 'pending',
      error_code: null,
      zoom_meeting_id: '81234567890',
    })
    await cancelManagedBooking(ctx, b.manageToken as string)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(provider.controls.storedMeetings.size).toBe(0)
    expect(posts()).toHaveLength(1)
  })
  it('a stale absence result requeues after a late known ID instead of stranding the meeting', async () => {
    const b = await book(),
      firstCommit = barrier(),
      allowFirst = barrier(),
      secondCommit = barrier(),
      allowSecond = barrier()
    let phase = 0
    const afterCommit = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction')
          return () => ({
            execute: async (body: (trx: Db) => Promise<unknown>) => {
              const result = await target.transaction().execute(body)
              const ownPhase = ++phase
              if (ownPhase === 1) {
                firstCommit.resolve()
                await allowFirst.promise
              }
              if (ownPhase === 2) {
                secondCommit.resolve()
                await allowSecond.promise
              }
              return result
            },
          })
        return Reflect.get(target, prop, receiver)
      },
    }) as Db
    deps.zoomConferenceWork = createZoomConferenceWork(
      { ...conference, db: afterCommit },
      provider.meetings,
    )
    const original = writeBookingConference(deps, b.booking.id)
    await firstCommit.promise
    await db
      .updateTable('booking_conferences')
      .set({ lease_until: new Date(NOW.epochMilliseconds - 1) })
      .execute()
    const absence = writeBookingConference(deps, b.booking.id)
    await secondCommit.promise
    allowFirst.resolve()
    await original
    expect((await row()).zoom_meeting_id).toBe('81234567890')
    allowSecond.resolve()
    await absence
    expect(await row()).toMatchObject({
      state: 'pending',
      error_code: null,
      zoom_meeting_id: '81234567890',
    })
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(posts()).toHaveLength(1)
  })
  it('withholds a previously ready Zoom link when its current conference view becomes unavailable', async () => {
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toContain('/j/')
    const member = await db
      .selectFrom('auth.member')
      .selectAll()
      .where('userId', '=', owner.user.id)
      .where('organizationId', '=', owner.organization.id)
      .executeTakeFirstOrThrow()
    try {
      await db.deleteFrom('auth.member').where('id', '=', member.id).execute()
      const managed = await getManagedBooking(ctx, b.manageToken as string)
      expect(managed.conference).toMatchObject({
        status: 'failed',
        errorCode: 'organizer_unavailable',
      })
      expect(managed.location?.url === undefined).toBe(true)
      expect(posts()).toHaveLength(1)
    } finally {
      await db
        .insertInto('auth.member')
        .values(member)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
  })
  it('withholds a late created URL after host membership withdrawal while keeping the exact ID available for cancellation cleanup', async () => {
    const member = await db
      .selectFrom('auth.member')
      .selectAll()
      .where('userId', '=', owner.user.id)
      .where('organizationId', '=', owner.organization.id)
      .executeTakeFirstOrThrow()
    const b = await book(),
      entered = barrier(),
      release = barrier<Response>()
    const value = {
      id: 81234567890,
      host_id: 'synthetic-zoom-identity',
      type: 2,
      join_url: 'https://zoom.us/j/81234567890',
      start_time: START,
      duration: 30,
    }
    provider.controls.meetingHook = async () => {
      entered.resolve()
      return release.promise
    }
    const running = writeBookingConference(deps, b.booking.id)
    await entered.promise
    try {
      await db.deleteFrom('auth.member').where('id', '=', member.id).execute()
      provider.controls.storedMeetings.set('81234567890', value)
      release.resolve(Response.json(value))
      await running
      expect(await row()).toMatchObject({
        state: 'failed',
        error_code: 'organizer_unavailable',
        zoom_meeting_id: '81234567890',
      })
      const managed = await getManagedBooking(ctx, b.manageToken as string)
      expect(managed.location?.url).toBeUndefined()
      expect(managed.conference?.errorCode).toBe('organizer_unavailable')
      await sendBookingNotification(mail(), b.booking.id, 'confirmed')
      await dispatchConferenceNotifications(mail())
      expect(sent.some((message) => message.attachments?.length)).toBe(false)
      provider.controls.meetingHook = undefined
      await cancelManagedBooking(ctx, b.manageToken as string)
      await writeBookingConference(deps, b.booking.id)
      expect((await row()).state).toBe('ready')
      expect(provider.controls.storedMeetings.size).toBe(0)
      expect(posts()).toHaveLength(1)
      expect(provider.calls.filter((c) => c.init.method === 'DELETE').map((c) => c.url)).toEqual([
        'https://api.zoom.us/v2/meetings/81234567890',
      ])
    } finally {
      release.resolve(Response.json(value))
      await running
      await db
        .insertInto('auth.member')
        .values(member)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
  })
  it('rejects a cached principal after logout before allowing private connection reactivation', async () => {
    const id = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        id,
        userId: owner.user.id,
        token: randomUUID(),
        updatedAt: new Date(),
        expiresAt: new Date('2035-01-01Z'),
      })
      .execute()
    const stale = { ...owner, sessionId: id }
    await db.deleteFrom('auth.session').where('id', '=', id).execute()
    await updateEventType({ db, principal: owner, now: () => NOW }, eventId, {
      location: { kind: 'zoom' },
    })
    await expect(
      updateEventType({ db, principal: stale, now: () => NOW, automaticZoom: true }, eventId, {
        location: { kind: 'zoom', autoCreate: true },
        zoomConnectionId: connectionId,
      }),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
  })
  it('serializes disconnect after an in-flight provider transaction without losing its validated meeting identity', async () => {
    const b = await book(),
      entered = barrier(),
      release = barrier<Response>()
    provider.controls.meetingHook = async () => {
      entered.resolve()
      return release.promise
    }
    const running = writeBookingConference(deps, b.booking.id)
    await entered.promise
    const disconnect = disconnectConference(conference, owner, connectionId)
    await vi.waitFor(async () => {
      const result = await sql<{
        blocked: boolean
      }>`SELECT exists(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND cardinality(pg_blocking_pids(a.pid))>0) AS blocked`.execute(
        db,
      )
      expect(result.rows[0]?.blocked).toBe(true)
    })
    release.resolve(
      Response.json({
        id: 81234567890,
        host_id: 'synthetic-zoom-identity',
        type: 2,
        join_url: 'https://zoom.us/j/81234567890',
        start_time: START,
        duration: 30,
      }),
    )
    await Promise.all([running, disconnect])
    expect((await row()).zoom_meeting_id).toBe('81234567890')
    expect(
      await db
        .selectFrom('conference_connections')
        .select(['status', 'credentials'])
        .where('id', '=', connectionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'disconnected', credentials: null })
    expect(posts()).toHaveLength(1)
  })
  it('supports a single-host team with its own host-authorized connection and no Google', async () => {
    const f = createFixtures(db),
      team = await f.organization('zoom-team')
    await f.member(owner.user.id, team, 'owner')
    const principal = {
      ...owner,
      organization: { id: team, name: 'zoom-team', slug: 'zoom-team', personal: false },
    }
    await createEventType(
      { db, principal, automaticZoom: true, now: () => NOW },
      {
        slug: 'team-call',
        title: 'Team Zoom',
        durationMinutes: 30,
        hosts: [{ userId: owner.user.id }],
        location: { kind: 'zoom', autoCreate: true },
        zoomConnectionId: connectionId,
      },
    )
    const b = await createPublicTeamBooking(ctx, {
      handle: 'zoom-team',
      slug: 'team-call',
      start: Temporal.Instant.from(START),
      invitee: { name: 'Team Invitee', email: 'team@example.com', timeZone: 'UTC' },
      idempotencyKey: 'team-key',
    })
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      provider: 'zoom',
      state: 'ready',
      organizer_user_id: owner.user.id,
      organization_id: team,
    })
    expect(posts()).toHaveLength(1)
  })
})
