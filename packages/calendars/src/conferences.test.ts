import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createLogMailer, type MailMessage, MailRejectedError } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createEventType,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listPublicSlots,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BookingNotificationPayload,
  bookingNotificationJob,
  dispatchConferenceNotifications,
  sendBookingNotification,
} from '../../notifications/src/index.ts'
import { calendarBookingNotifier, writeBookingCalendar } from './booking-events.ts'
import { retryBookingConference, writeBookingConference } from './conferences.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishGoogleConnection,
} from './index.ts'
import { configureCalendar, setCalendarDestination, syncGoogleCalendar } from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = '2030-11-04T09:00:00Z'
const JOIN = 'https://meet.google.com/abc-defg-hij'
const future = () => new Date(NOW.epochMilliseconds)
const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
describe.skipIf(!serverUrl)('automatic Meet durable flow (real PostgreSQL)', () => {
  let owned: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof calendarTestSession>>,
    provider: ReturnType<typeof fakeGoogle>,
    deps: CalendarDeps,
    ctx: PublicContext,
    calendarId: string
  let response: 'pending' | 'success' | 'failure' | 'unsafe' = 'pending'
  let sent: MailMessage[]
  const mail = () => ({
    db,
    publicUrl: 'https://hourmere.example',
    now: () => NOW,
    mailer: {
      send: async (m: MailMessage) => {
        sent.push(m)
      },
    },
  })
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    owner = await calendarTestSession(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', owner.user.id)
      .execute()
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('profiles').execute()
    await db.deleteFrom('schedules').execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    provider.controls.pages = [
      {
        items: [
          {
            id: 'meet-calendar',
            summary: 'Meet calendar',
            accessRole: 'owner',
            conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
          },
        ],
      },
    ]
    // Restoring email proof revokes the old session by the real auth trigger. Each
    // fixture starts with a fresh synthetic sign-in rather than bypassing that guard.
    await db
      .insertInto('auth.session')
      .values({
        id: owner.sessionId,
        userId: owner.user.id,
        token: `synthetic-${owner.sessionId}`,
        updatedAt: future(),
        expiresAt: new Date('2035-01-01T00:00:00Z'),
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ expiresAt: new Date('2035-01-01T00:00:00Z') }),
      )
      .execute()
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => NOW.epochMilliseconds,
    }
    const auth = new URL((await beginGoogleConnection(deps, owner, 'sync')).authorizationUrl)
    expect(
      await finishGoogleConnection(
        deps,
        owner,
        new URLSearchParams({
          state: auth.searchParams.get('state') as string,
          code: 'synthetic-code',
        }),
      ),
    ).toBe('connected')
    calendarId = (await db.selectFrom('calendars').select('id').executeTakeFirstOrThrow()).id
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'meet-host', time_zone: 'UTC' })
      .execute()
    await setCalendarDestination(deps, owner, calendarId)
    const f = createFixtures(db)
    await f.schedule(owner.user.id)
    await f.eventType(owner.organization.id, owner.user.id, {
      slug: 'meet',
      location: { kind: 'google_meet', autoCreate: true },
    })
    ctx = { db, automaticMeet: true, now: () => NOW }
    response = 'pending'
    sent = []
    provider.controls.eventHook = async (url, init) => {
      const values = provider.controls.storedEvents
      if (init.method === 'POST') {
        const value = JSON.parse(String(init.body))
        const item = { ...value, id: 'meet-event', etag: '"v1"' }
        values.set(item.id, item)
        return Response.json(item)
      }
      if (url.searchParams.has('timeMin') || url.searchParams.has('syncToken'))
        return Response.json({
          items: [...values.values()],
          nextSyncToken: 'meet-busy-cursor',
          timeZone: 'UTC',
        })
      const id = url.pathname.split('/').at(-1) as string
      if (init.method === 'PATCH') {
        const item = {
          ...values.get(id),
          ...JSON.parse(String(init.body)),
          id,
          etag: '"v2"',
          conferenceData: conference(),
        }
        values.set(id, item)
        return Response.json(item)
      }
      if (url.searchParams.has('iCalUID'))
        return Response.json({
          items: [...values.values()]
            .filter((v) => v.iCalUID === url.searchParams.get('iCalUID'))
            .map((v) => ({ ...v, ...(v.conferenceData ? { conferenceData: conference() } : {}) })),
        })
      const item = values.get(id)
      return item
        ? Response.json({
            ...item,
            ...(item.conferenceData ? { conferenceData: conference() } : {}),
          })
        : Response.json({}, { status: 404 })
    }
  })
  const conference = () => ({
    createRequest: { status: { statusCode: response === 'unsafe' ? 'success' : response } },
    conferenceSolution: { key: { type: 'hangoutsMeet' } },
    ...(response === 'success' || response === 'unsafe'
      ? {
          entryPoints: [
            {
              entryPointType: 'video',
              uri: response === 'unsafe' ? 'https://attacker.example/room' : JOIN,
            },
          ],
        }
      : {}),
  })
  const book = (key = 'same-key', context = ctx, start = START, email = 'synthetic@example.com') =>
    createPublicBooking(context, {
      handle: 'meet-host',
      slug: 'meet',
      start: Temporal.Instant.from(start),
      invitee: { name: 'Synthetic Invitee', email, timeZone: 'UTC' },
      idempotencyKey: key,
    })
  const row = () => db.selectFrom('booking_conferences').selectAll().executeTakeFirstOrThrow()
  const due = async () => {
    await db
      .updateTable('booking_conferences')
      .set({ next_attempt_at: future(), lease_until: null })
      .execute()
  }
  const imports = () =>
    provider.calls.filter((c) => c.init.method === 'POST' && c.url.pathname.endsWith('/import'))
  const ready = async () => {
    const b = await book()
    response = 'success'
    await writeBookingConference(deps, b.booking.id)
    return b
  }

  it('requires explicit opt-in, instance capability, one host and cached Meet support', async () => {
    await expect(book('off', { ...ctx, automaticMeet: false })).rejects.toMatchObject({
      code: 'automatic_meet_disabled',
    })
    expect(await db.selectFrom('bookings').select('id').execute()).toHaveLength(0)
    await db.updateTable('calendars').set({ supports_google_meet: false }).execute()
    await expect(book()).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
    await db.updateTable('calendars').set({ supports_google_meet: true }).execute()
    await expect(
      createEventType(
        { ...ctx, principal: owner },
        {
          title: 'Unsupported',
          slug: 'unsupported',
          durationMinutes: 30,
          schedulingType: 'collective',
          hosts: [{ userId: owner.user.id }],
          location: { kind: 'google_meet', autoCreate: true },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_hosts' })
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'google_meet' }) })
      .execute()
    const legacy = await book()
    expect(legacy.booking.conference).toBeUndefined()
    expect(await db.selectFrom('booking_conferences').selectAll().execute()).toHaveLength(0)
  })
  it('commits one intent on idempotent retry, and old calendar writer never creates its root', async () => {
    const b = await book()
    const retry = await book()
    expect(retry.replayed).toBe(true)
    expect(retry.manageToken === null).toBe(true)
    expect(await db.selectFrom('booking_conferences').selectAll().execute()).toHaveLength(1)
    await db.transaction().execute(async (trx) => {
      await calendarBookingNotifier({ enqueue: async () => null })(trx, { bookingId: b.booking.id })
    })
    expect(await db.selectFrom('booking_calendar_targets').select('calendar_id').execute()).toEqual(
      [],
    )
    await writeBookingCalendar(deps, b.booking.id)
    expect(imports()).toHaveLength(0)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(imports()).toHaveLength(1)
    expect(JSON.parse(String(imports()[0]?.init.body))).not.toHaveProperty('conferenceData')
    expect((await row()).state).toBe('pending')
    expect(provider.calls.some((c) => String(c.init.body).includes('attendees'))).toBe(false)
  })
  it('releases final linked HTML/text/ICS exactly once only when current revision is ready', async () => {
    const b = await book()
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(0)
    await writeBookingConference(deps, b.booking.id)
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(0)
    response = 'success'
    await due()
    await writeBookingConference(deps, b.booking.id)
    await dispatchConferenceNotifications(mail())
    await dispatchConferenceNotifications(mail())
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect(
      sent.every(
        (m) =>
          m.text.includes(JOIN) &&
          Boolean(m.html?.includes(JOIN)) &&
          Boolean(m.attachments?.[0]?.content.includes(JOIN)),
      ),
    ).toBe(true)
    expect(
      sent.every((m) => m.attachments?.[0]?.content.includes(`${b.booking.id}@hourmere`)),
    ).toBe(true)
    const log: string[] = []
    await createLogMailer((l) => log.push(l)).send(sent[0] as MailMessage)
    expect(log.join('').includes(JOIN)).toBe(false)
    expect(log.join('').includes('#token=')).toBe(false)
  })
  it('retains event/UID/Meet URL and pinned destination through reschedule, including flag off for existing roots', async () => {
    const b = await ready()
    const original = await row()
    await db.updateTable('profiles').set({ destination_calendar_id: null }).execute()
    const moved = await rescheduleManagedBooking(
      { ...ctx, automaticMeet: false },
      b.manageToken as string,
      { start: Temporal.Instant.from('2030-11-04T11:00:00Z') },
    )
    expect(moved.booking.conference?.status).toBe('pending')
    expect(moved.booking.location?.url).toBeUndefined()
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
    await writeBookingConference(deps, b.booking.id)
    const current = await row()
    expect(current.state).toBe('ready')
    expect(current.calendar_id).toBe(original.calendar_id)
    expect(imports()).toHaveLength(1)
    const result = await getManagedBooking(ctx, moved.manageToken as string)
    expect(result.location?.url === JOIN).toBe(true)
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(0)
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(2)
    expect(sent.every((m) => m.attachments?.[0]?.content.includes('SEQUENCE:1'))).toBe(true)
  })
  it('hides the Meet URL from cancelled protected booking reads before and after cleanup', async () => {
    const b = await ready()
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url === JOIN).toBe(
      true,
    )
    await cancelManagedBooking(ctx, b.manageToken as string)
    for (const cleanup of [false, true]) {
      if (cleanup) await writeBookingConference(deps, b.booking.id)
      expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
      expect(
        (await getHostBooking({ ...ctx, principal: owner }, b.booking.id)).location?.url,
      ).toBeUndefined()
    }
  })
  it('public individual slots recheck the current Meet destination', async () => {
    const input = {
      handle: 'meet-host',
      slug: 'meet',
      start: Temporal.Instant.from(START),
      end: Temporal.Instant.from(START).add({ hours: 1 }),
    }
    expect((await listPublicSlots(ctx, input)).length).toBeGreaterThan(0)
    await db.updateTable('calendars').set({ supports_google_meet: false }).execute()
    await expect(listPublicSlots(ctx, input)).rejects.toMatchObject({
      code: 'automatic_meet_unavailable',
    })
  })
  it.each([
    { status: 400, error: 'invalid_response' },
    { status: 401, error: 'needs_reauth' },
    { status: 403, error: 'permissions_missing' },
    { status: 429, error: null },
    { status: 403, reason: 'rateLimitExceeded', error: null },
    { status: 403, reason: 'userRateLimitExceeded', error: null },
  ])(
    'known rejected import $status ($reason) permits a later create',
    async ({ status, reason, error }) => {
      const b = await book(),
        original = provider.controls.eventHook
      if (!original) throw Error('Synthetic provider hook missing')
      provider.controls.eventHook = async (url, init) =>
        init.method === 'POST'
          ? Response.json({ error: { errors: [{ reason: reason ?? 'forbidden' }] } }, { status })
          : original(url, init)
      await writeBookingConference(deps, b.booking.id)
      expect(await row()).toMatchObject({
        state: error ? 'failed' : 'pending',
        error_code: error,
        create_started: false,
      })
      expect(imports()).toHaveLength(1)
      expect((await row()).next_attempt_at.getTime()).toBeGreaterThan(NOW.epochMilliseconds)
      if (error) await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
      await db.updateTable('calendar_connections').set({ status: 'active' }).execute()
      provider.controls.eventHook = original
      response = 'success'
      await due()
      await writeBookingConference(deps, b.booking.id)
      expect(await row()).toMatchObject({ state: 'ready', error_code: null })
      expect(imports()).toHaveLength(2)
    },
  )
  it.each([500, 503])(
    'HTTP %s after import remains ambiguous and never re-POSTs',
    async (status) => {
      const b = await book()
      provider.controls.eventHook = async () => Response.json({}, { status })
      await writeBookingConference(deps, b.booking.id)
      expect(await row()).toMatchObject({
        state: 'failed',
        error_code: 'ambiguous_create',
        create_started: true,
      })
      await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
      provider.controls.eventHook = async () => Response.json({ items: [] })
      await writeBookingConference(deps, b.booking.id)
      expect(imports()).toHaveLength(1)
      expect((await row()).error_code).toBe('ambiguous_create')
    },
  )
  it('a stale result lease may preserve its event ID but cannot publish readiness or a URL', async () => {
    const b = await book(),
      entered = barrier(),
      release = barrier(),
      original = provider.controls.eventHook
    if (!original) throw Error('Synthetic provider hook missing')
    response = 'success'
    provider.controls.eventHook = async (url, init) => {
      const result = await original(url, init)
      if (init.method === 'POST') {
        entered.release()
        await release.promise
      }
      return result
    }
    const work = writeBookingConference(deps, b.booking.id)
    await entered.promise
    const replacementLease = crypto.randomUUID()
    try {
      await db.updateTable('booking_conferences').set({ lease_id: replacementLease }).execute()
    } finally {
      release.release()
    }
    await work
    expect(await row()).toMatchObject({
      state: 'pending',
      external_event_id: 'meet-event',
      lease_id: replacementLease,
      applied_revision: null,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
    expect(
      await db.selectFrom('booking_conference_notifications').selectAll().execute(),
    ).toHaveLength(0)
  })
  it('rejects an imported root event with a different logical UID', async () => {
    const b = await book(),
      original = provider.controls.eventHook
    if (!original) throw Error('Synthetic provider hook missing')
    response = 'success'
    provider.controls.eventHook = async (url, init) => {
      const result = await original(url, init)
      return init.method === 'POST'
        ? Response.json({
            ...((await result.json()) as Record<string, unknown>),
            iCalUID: 'another-root@hourmere',
          })
        : result
    }
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      external_event_id: null,
    })
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url).toBeUndefined()
  })
  it('a provider URL accompanied by an error cannot mark the root ready', async () => {
    const b = await book()
    await db.deleteFrom('booking_conferences').where('root_booking_id', '=', b.booking.id).execute()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: b.booking.id,
        booking_id: b.booking.id,
        organization_id: owner.organization.id,
        organizer_user_id: owner.user.id,
        provider: 'zoom',
        zoom_connection_id: crypto.randomUUID(),
        zoom_user_id: 'synthetic-zoom-user',
      })
      .execute()
    await writeBookingConference(
      {
        ...deps,
        zoomConferenceWork: async () => ({
          meetingId: '81234567890',
          url: 'https://zoom.us/j/81234567890',
          error: 'provider_unavailable',
        }),
      },
      b.booking.id,
    )
    expect(await row()).toMatchObject({
      state: 'pending',
      applied_revision: null,
      zoom_meeting_id: '81234567890',
    })
    expect(
      await db.selectFrom('booking_conference_notifications').selectAll().execute(),
    ).toHaveLength(0)
  })
  it('a successful URL arriving after meeting start is never stored in booking location', async () => {
    const b = await book(),
      original = provider.controls.eventHook
    if (!original) throw Error('Synthetic provider hook missing')
    let now = NOW.epochMilliseconds
    response = 'success'
    provider.controls.eventHook = async (url, init) => {
      const result = await original(url, init)
      if (init.method === 'POST') now = Temporal.Instant.from(START).epochMilliseconds
      return result
    }
    await writeBookingConference({ ...deps, now: () => now }, b.booking.id)
    expect(await row()).toMatchObject({ state: 'failed', error_code: 'meeting_started' })
    const raw = await db
      .selectFrom('bookings')
      .select('location')
      .where('id', '=', b.booking.id)
      .executeTakeFirstOrThrow()
    expect(raw.location).not.toHaveProperty('url')
    expect(
      await db.selectFrom('booking_conference_notifications').select('kind').execute(),
    ).toEqual([{ kind: 'conference_failed' }])
  })
  it('a known event deleted remotely completes cancellation cleanup on 404', async () => {
    const b = await ready()
    provider.controls.storedEvents.clear()
    await cancelManagedBooking(ctx, b.manageToken as string)
    await writeBookingConference(deps, b.booking.id)
    expect(await row()).toMatchObject({ state: 'ready', error_code: null })
    expect(await db.selectFrom('calendar_busy').selectAll().execute()).toHaveLength(0)
    expect(imports()).toHaveLength(1)
  })
  it.each(['pending', 'ready'] as const)('refuses retry of a %s root', async (state) => {
    const b = state === 'ready' ? await ready() : await book()
    await expect(
      retryBookingConference({ ...ctx, principal: owner }, b.booking.id),
    ).rejects.toMatchObject({ code: 'conference_not_retryable' })
    expect((await row()).state).toBe(state)
  })
  it('refuses retry of a failed confirmed meeting after its start', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    await expect(
      retryBookingConference(
        { ...ctx, principal: owner, now: () => Temporal.Instant.from(START) },
        b.booking.id,
      ),
    ).rejects.toMatchObject({ code: 'conference_not_retryable' })
    expect((await row()).state).toBe('failed')
  })
  it.each([503, 400, 'network', 'timeout'] as const)(
    'transient token HTTP %s retains credentials and retries with bounded backoff',
    async (status) => {
      const b = await book()
      if (typeof status === 'number') provider.controls.tokenStatus = status
      else
        provider.controls.tokenHook = async () => {
          throw status === 'timeout'
            ? new DOMException('Synthetic deadline', 'TimeoutError')
            : new TypeError('Synthetic connection reset')
        }
      provider.controls.tokenError = 'temporarily_unavailable'
      const connection = await db
        .selectFrom('calendar_connections')
        .selectAll()
        .executeTakeFirstOrThrow()
      await writeBookingConference(deps, b.booking.id)
      expect(
        await db
          .selectFrom('calendar_connections')
          .select(['status', 'credentials'])
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'active', credentials: connection.credentials })
      expect(await row()).toMatchObject({
        state: 'pending',
        create_started: false,
        error_code: null,
      })
      expect((await row()).next_attempt_at.getTime() - NOW.epochMilliseconds).toBeGreaterThan(0)
      expect((await row()).next_attempt_at.getTime() - NOW.epochMilliseconds).toBeLessThanOrEqual(
        60_000,
      )
      expect(imports()).toHaveLength(0)
      provider.controls.tokenStatus = 200
      provider.controls.tokenHook = undefined
      response = 'success'
      await due()
      await writeBookingConference(deps, b.booking.id)
      expect((await row()).state).toBe('ready')
      expect(imports()).toHaveLength(1)
    },
  )
  it('keeps unknown import lost responses in reconciliation and never exposes force-create', async () => {
    const b = await book()
    const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
    provider.controls.eventHook = async (url, init) => {
      if (init.method === 'POST') {
        await hook(url, init)
        throw new TypeError('synthetic transport disconnected')
      }
      return hook(url, init)
    }
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('ambiguous_create')
    expect((await row()).create_started).toBe(true)
    response = 'success'
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
  })
  it('zero lookup after an unknown import stays failed after safe retry without another POST', async () => {
    const b = await book()
    provider.controls.eventHook = async (_url, init) => {
      if (init.method === 'POST') throw new TypeError('synthetic timeout')
      return Response.json({ items: [] })
    }
    await writeBookingConference(deps, b.booking.id)
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('ambiguous_create')
    expect(imports()).toHaveLength(1)
  })
  it('known conference failure gets separate no-ICS notices and a new request on the same event', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    const failed = await row()
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(0)
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(2)
    expect(sent.every((m) => !m.attachments?.length && m.subject.includes('needs attention'))).toBe(
      true,
    )
    expect(sent.some((m) => m.text.includes('#token='))).toBe(true)
    response = 'success'
    await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
    expect((await row()).request_id === failed.request_id).toBe(false)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
    expect(
      provider.calls.some(
        (c) => c.init.method === 'PATCH' && c.url.searchParams.get('conferenceDataVersion') === '1',
      ),
    ).toBe(true)
  })
  it('failure logistics still reach the original invitee after host verification is revoked', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', owner.user.id)
      .execute()
    await dispatchConferenceNotifications(mail())
    await dispatchConferenceNotifications(mail())
    expect(sent.map((message) => message.to)).toEqual(['synthetic@example.com'])
    expect(sent[0]?.attachments?.length ?? 0).toBe(0)
    expect(sent[0]?.subject).toContain('needs attention')
    const token = sent[0]?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1]
    expect(typeof token).toBe('string')
    expect((await getManagedBooking(ctx, token as string)).id).toBe(b.booking.id)
    expect(
      (
        await db
          .selectFrom('booking_conference_notifications')
          .select('delivered')
          .where('booking_id', '=', b.booking.id)
          .where('kind', '=', 'conference_failed')
          .executeTakeFirstOrThrow()
      ).delivered,
    ).toBe(true)
    expect(
      (
        await db
          .selectFrom('booking_notifications')
          .select('recipient')
          .where('booking_id', '=', b.booking.id)
          .execute()
      ).every((row) => row.recipient.startsWith('attendee:')),
    ).toBe(true)
  })
  it('a deleted team organizer does not erase failure logistics, and later cancellation suppresses it', async () => {
    const f = createFixtures(db),
      gone = await f.host({ handle: null }),
      team = await f.organization()
    await f.member(owner.user.id, team, 'owner')
    await f.member(gone.userId, team)
    const event = await f.eventType(team, null, {
      slug: 'deleted-meet',
      hosts: [{ userId: gone.userId }],
      location: { kind: 'google_meet', autoCreate: true },
    })
    const id = await f.booking(team, [gone.userId], START, '2030-11-04T09:30Z', {
      eventTypeId: event,
      attendee: { name: 'Synthetic Invitee', email: 'synthetic@example.com' },
    })
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', id)
      .execute()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: team,
        organizer_user_id: gone.userId,
        state: 'failed',
        error_code: 'calendar_unavailable',
        external_event_id: 'deleted-host-event',
        create_started: true,
      })
      .execute()
    await db
      .insertInto('booking_conference_notifications')
      .values({ booking_id: id, kind: 'conference_failed', due_at: future() })
      .execute()
    await db.deleteFrom('auth.user').where('id', '=', gone.userId).execute()
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', id).execute(),
    ).toHaveLength(1)
    expect((await row()).organizer_user_id).toBe(gone.userId)
    await dispatchConferenceNotifications(mail())
    await sendBookingNotification(mail(), id, 'conference_failed')
    expect(sent.map((message) => message.to)).toEqual(['synthetic@example.com'])
    expect(sent[0]?.attachments?.length ?? 0).toBe(0)
    const token = sent[0]?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] as string
    expect((await getManagedBooking(ctx, token)).id).toBe(id)
    await cancelManagedBooking(ctx, token)
    await db
      .updateTable('booking_conference_notifications')
      .set({ delivered: false, due_at: future() })
      .where('booking_id', '=', id)
      .execute()
    await dispatchConferenceNotifications(mail())
    await sendBookingNotification(mail(), id, 'conference_failed')
    expect(sent).toHaveLength(1)
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('cancelled')
    await sendBookingNotification(mail(), id, 'cancelled')
    await sendBookingNotification(mail(), id, 'cancelled')
    expect(sent.map((message) => message.to)).toEqual([
      'synthetic@example.com',
      'synthetic@example.com',
    ])
    expect(sent[1]?.attachments?.length ?? 0).toBe(0)
    expect(sent[1]?.subject).toContain('Cancelled')
  })
  it('a cancelled new root uses pinned logical ICS without mailing its unverified organizer', async () => {
    const b = await book()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', owner.user.id)
      .execute()
    await cancelManagedBooking(ctx, b.manageToken as string)
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent.map((message) => message.to)).toEqual(['synthetic@example.com'])
    expect(sent[0]?.attachments?.length ?? 0).toBe(1)
    expect(String(sent[0]?.attachments?.[0]?.content)).toContain('METHOD:CANCEL')
    expect(String(sent[0]?.attachments?.[0]?.content)).toContain(owner.user.email)
    expect(sent[0]?.subject).toContain('Cancelled')
    expect((await getManagedBooking(ctx, b.manageToken as string)).status).toBe('cancelled')
  })
  it('a temporarily refused original invitee retains the failure outbox without a verified organizer', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', owner.user.id)
      .execute()
    let refusing = true
    const config = {
      ...mail(),
      mailer: {
        send: async (message: MailMessage) => {
          if (refusing)
            throw new MailRejectedError({
              responseCode: 450,
              enhancedCode: '4.2.0',
              atRecipient: true,
            })
          sent.push(message)
        },
      },
    }
    await dispatchConferenceNotifications(config)
    expect(sent).toHaveLength(0)
    expect(
      (
        await db
          .selectFrom('booking_conference_notifications')
          .select('delivered')
          .where('booking_id', '=', b.booking.id)
          .where('kind', '=', 'conference_failed')
          .executeTakeFirstOrThrow()
      ).delivered,
    ).toBe(false)
    expect(
      await db
        .selectFrom('booking_notifications')
        .select('recipient')
        .where('booking_id', '=', b.booking.id)
        .execute(),
    ).toHaveLength(0)
    refusing = false
    await db
      .updateTable('booking_conference_notifications')
      .set({ due_at: future() })
      .where('booking_id', '=', b.booking.id)
      .execute()
    await dispatchConferenceNotifications(config)
    await dispatchConferenceNotifications(config)
    expect(sent.map((message) => message.to)).toEqual(['synthetic@example.com'])
    expect(sent[0]?.attachments?.length ?? 0).toBe(0)
  })
  it('missing original invitee never redirects failure mail to a guest or marks its outbox delivered', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: b.booking.id,
        name: 'Guest',
        email: 'guest@example.com',
        time_zone: 'UTC',
        is_booker: false,
      })
      .execute()
    await db
      .deleteFrom('booking_attendees')
      .where('booking_id', '=', b.booking.id)
      .where('is_booker', '=', true)
      .execute()
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(0)
    expect(
      (
        await db
          .selectFrom('booking_conference_notifications')
          .select('delivered')
          .where('booking_id', '=', b.booking.id)
          .where('kind', '=', 'conference_failed')
          .executeTakeFirstOrThrow()
      ).delivered,
    ).toBe(false)
  })
  it('host verification changing after load skips only that recipient and still notifies the invitee', async () => {
    const b = await book()
    response = 'failure'
    await writeBookingConference(deps, b.booking.id)
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('UPDATE auth."user" SET "emailVerified"=false WHERE id=$1', [owner.user.id])
    const sending = dispatchConferenceNotifications(mail())
    let open = true
    try {
      let waiting = false
      for (let n = 0; n < 200 && !waiting; n++) {
        waiting = (
          await owned.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND lower(query) LIKE '%auth%user%for share%') AS waiting",
          )
        ).rows[0].waiting
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
      await blocker.query('COMMIT')
      open = false
      await sending
      expect(sent.map((message) => message.to)).toEqual(['synthetic@example.com'])
      expect(sent[0]?.attachments?.length ?? 0).toBe(0)
      expect(
        await db
          .selectFrom('booking_notifications')
          .select('recipient')
          .where('booking_id', '=', b.booking.id)
          .where('recipient', 'like', 'host:%')
          .execute(),
      ).toHaveLength(0)
    } finally {
      if (open) await blocker.query('ROLLBACK')
      blocker.release()
      await sending
    }
  })
  it('rejects unsafe join URLs without producing a final invitation or logging upstream fields', async () => {
    const b = await book()
    response = 'unsafe'
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('failed')
    expect((await row()).error_code).toBe('invalid_response')
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(0)
  })
  it('booking and intent rows remain lockable while a provider request is blocked', async () => {
    const b = await book()
    const started = barrier(),
      release = barrier()
    const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
    provider.controls.eventHook = async (u, i) => {
      if (i.method === 'POST') {
        started.release()
        await release.promise
      }
      return hook(u, i)
    }
    const work = writeBookingConference(deps, b.booking.id)
    await started.promise
    const connection = await owned.pool.connect()
    try {
      await connection.query('BEGIN')
      await connection.query("SET LOCAL lock_timeout='500ms'")
      await connection.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [b.booking.id])
      await connection.query(
        'SELECT root_booking_id FROM booking_conferences WHERE root_booking_id=$1 FOR UPDATE',
        [b.booking.id],
      )
      await connection.query('ROLLBACK')
    } finally {
      connection.release()
      release.release()
    }
    await work
  })
  it('result apply waits for booking before taking intent, proven with actual PG row locks', async () => {
    const b = await book()
    response = 'success'
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [b.booking.id])
    const work = writeBookingConference(deps, b.booking.id)
    try {
      await vi.waitFor(
        async () => {
          const r = await owned.pool.query(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%bookings%for update%'",
          )
          expect(r.rows[0].n).toBeGreaterThan(0)
        },
        { timeout: 3000 },
      )
      await blocker.query("SET LOCAL lock_timeout='500ms'")
      await blocker.query(
        'SELECT root_booking_id FROM booking_conferences WHERE root_booking_id=$1 FOR UPDATE',
        [b.booking.id],
      )
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await work
    expect((await row()).state).toBe('ready')
  })
  it('reschedule commits during an in-flight create, late results cannot release stale mail', async () => {
    const b = await book()
    const started = barrier(),
      release = barrier()
    const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
    response = 'success'
    provider.controls.eventHook = async (u, i) => {
      if (i.method === 'POST') {
        started.release()
        await release.promise
      }
      return hook(u, i)
    }
    const work = writeBookingConference(deps, b.booking.id)
    await started.promise
    let moved: Awaited<ReturnType<typeof rescheduleManagedBooking>>
    try {
      moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
        start: Temporal.Instant.from('2030-11-04T11:00:00Z'),
      })
    } finally {
      release.release()
    }
    await work
    expect((await row()).state).toBe('pending')
    expect((await row()).external_event_id).toBe('meet-event')
    expect(
      await db.selectFrom('booking_conference_notifications').selectAll().execute(),
    ).toHaveLength(0)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).booking_id).toBe(moved.booking.id)
    expect((await row()).state).toBe('ready')
    expect(imports()).toHaveLength(1)
  })
  it('cancel always sends and late create is reconciled without resurrecting confirmation', async () => {
    const b = await book()
    const started = barrier(),
      release = barrier()
    const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
    response = 'success'
    provider.controls.eventHook = async (u, i) => {
      if (i.method === 'POST') {
        started.release()
        await release.promise
      }
      return hook(u, i)
    }
    const work = writeBookingConference(deps, b.booking.id)
    await started.promise
    try {
      await cancelManagedBooking(ctx, b.manageToken as string)
      await sendBookingNotification(mail(), b.booking.id, 'cancelled')
      expect(sent).toHaveLength(2)
    } finally {
      release.release()
    }
    await work
    await writeBookingConference(deps, b.booking.id)
    await sendBookingNotification(mail(), b.booking.id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect(sent.every((m) => m.attachments?.[0]?.content.includes('METHOD:CANCEL'))).toBe(true)
    expect(provider.controls.storedEvents.get('meet-event')?.status).toBe('cancelled')
  })
  it.each([false, true])(
    'pending conference mirror does not block an overlapping reschedule (lost response: %s)',
    async (lost) => {
      await db.updateTable('event_types').set({ slot_step_minutes: 15 }).execute()
      await configureCalendar(deps, owner, calendarId, true)
      await syncGoogleCalendar(deps, calendarId)
      const b = await book()
      if (lost) {
        const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
        provider.controls.eventHook = async (u, i) => {
          if (i.method === 'POST') {
            await hook(u, i)
            throw new TypeError('synthetic lost response')
          }
          return hook(u, i)
        }
      }
      await writeBookingConference(deps, b.booking.id)
      await syncGoogleCalendar(deps, calendarId)
      if (lost) {
        await retryBookingConference({ ...ctx, principal: owner }, b.booking.id)
        await writeBookingConference(deps, b.booking.id)
      }
      expect((await row()).state).toBe('pending')
      expect(
        (
          await db
            .selectFrom('booking_calendar_events')
            .selectAll()
            .where('booking_id', '=', b.booking.id)
            .executeTakeFirstOrThrow()
        ).external_event_id,
      ).toBe('meet-event')
      expect(
        await db
          .selectFrom('calendar_busy')
          .selectAll()
          .where('external_event_id', '=', 'meet-event')
          .execute(),
      ).toHaveLength(1)
      const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
        start: Temporal.Instant.from('2030-11-04T09:15:00Z'),
      })
      expect(moved.booking.start).toBe('2030-11-04T09:15:00.000Z')
      await sendBookingNotification(mail(), moved.booking.id, 'rescheduled')
      expect(sent).toHaveLength(0)
      expect(imports()).toHaveLength(1)
    },
  )
  it('disconnect preserves intent and ready URL, but later moves fail visibly without changing destination', async () => {
    const b = await ready()
    const before = await row()
    await disconnectCalendar(deps, owner, before.connection_id as string)
    expect((await row()).state).toBe('ready')
    expect((await getManagedBooking(ctx, b.manageToken as string)).location?.url === JOIN).toBe(
      true,
    )
    const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
      start: Temporal.Instant.from('2030-11-04T11:00:00Z'),
    })
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('failed')
    expect((await row()).error_code).toBe('calendar_unavailable')
    expect((await row()).booking_id).toBe(moved.booking.id)
    expect(imports()).toHaveLength(1)
  })
  it('durable outbox releases despite an active legacy exclusive notification key', async () => {
    const b = await book()
    const started = barrier(),
      release = barrier(),
      finished = barrier()
    const definition = bookingNotificationJob(mail())
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [
        {
          ...definition,
          handler: async (payload, run) => {
            started.release()
            await release.promise
            try {
              await definition.handler(BookingNotificationPayload.parse(payload), run)
            } finally {
              finished.release()
            }
          },
        },
      ],
      work: true,
      migrate: true,
      pollingIntervalSeconds: 0.5,
      log: () => {},
    })
    await jobs.start()
    try {
      await jobs.enqueue(
        'booking-notification',
        { bookingId: b.booking.id, kind: 'confirmed' },
        { singletonKey: `${b.booking.id}:confirmed` },
      )
      await started.promise
      response = 'success'
      await writeBookingConference(deps, b.booking.id)
      expect(
        await jobs.enqueue(
          'booking-notification',
          { bookingId: b.booking.id, kind: 'confirmed' },
          { singletonKey: `${b.booking.id}:confirmed` },
        ),
      ).toBeNull()
      await dispatchConferenceNotifications(mail())
      expect(sent).toHaveLength(2)
      release.release()
      await finished.promise
      expect(sent).toHaveLength(2)
    } finally {
      release.release()
      await jobs.stop()
    }
  })
  it('token refresh failure retains a durable intent and cancellation remains usable without provider cleanup', async () => {
    const b = await book()
    provider.controls.tokenStatus = 400
    provider.controls.token.error = 'invalid_grant'
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).error_code).toBe('needs_reauth')
    expect((await row()).create_started).toBe(false)
    await cancelManagedBooking(ctx, b.manageToken as string)
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent).toHaveLength(2)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect((await row()).error_code).toBeNull()
    expect(imports()).toHaveLength(0)
  })
  it('cancel with an existing remote event and revoked credentials reports unresolved cleanup while still notifying', async () => {
    const b = await ready()
    provider.controls.tokenStatus = 400
    provider.controls.token.error = 'invalid_grant'
    await cancelManagedBooking(ctx, b.manageToken as string)
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent).toHaveLength(2)
    await writeBookingConference(deps, b.booking.id)
    expect((await row()).state).toBe('failed')
    expect((await row()).error_code).toBe('needs_reauth')
    expect(provider.controls.storedEvents.get('meet-event')?.status).toBe('confirmed')
    // Reconnecting the same identity permits explicit cleanup retry, even after the
    // meeting start. It never grants authority to create another event.
    provider.controls.tokenStatus = 200
    delete provider.controls.token.error
    await db.updateTable('calendar_connections').set({ status: 'active' }).execute()
    const late = {
      ...ctx,
      principal: owner,
      now: () => Temporal.Instant.from(START).add({ hours: 1 }),
    }
    await retryBookingConference(late, b.booking.id)
    await writeBookingConference({ ...deps, now: () => late.now().epochMilliseconds }, b.booking.id)
    expect((await row()).state).toBe('ready')
    expect(provider.controls.storedEvents.get('meet-event')?.status).toBe('cancelled')
    expect(imports()).toHaveLength(1)
    await dispatchConferenceNotifications(mail())
    expect(sent).toHaveLength(2)
  })
  it('meeting start stops provider creation and final invites, but sends a terminal logistical failure notice', async () => {
    const b = await book()
    const late = Temporal.Instant.from(START).add({ minutes: 1 })
    await writeBookingConference({ ...deps, now: () => late.epochMilliseconds }, b.booking.id)
    expect((await row()).error_code).toBe('meeting_started')
    expect(imports()).toHaveLength(0)
    await sendBookingNotification({ ...mail(), now: () => late }, b.booking.id, 'confirmed')
    expect(sent).toHaveLength(0)
    await dispatchConferenceNotifications({ ...mail(), now: () => late })
    expect(sent).toHaveLength(2)
    expect(sent.every((m) => !m.attachments?.length)).toBe(true)
  })
  it('one temporarily refused invitee does not starve another ready booking outbox', async () => {
    const first = await book('first')
    const second = await book('second', ctx, '2030-11-04T11:00:00Z', 'second@example.com')
    response = 'success'
    // Independent roots must have independent provider identities and meeting links.
    const hook = provider.controls.eventHook as NonNullable<typeof provider.controls.eventHook>
    provider.controls.eventHook = async (u, i) => {
      if (i.method === 'POST') {
        const v = JSON.parse(String(i.body))
        const item = {
          ...v,
          id: v.iCalUID.startsWith(first.booking.id) ? 'first-event' : 'second-event',
          conferenceData: conference(),
        }
        provider.controls.storedEvents.set(item.id, item)
        return Response.json(item)
      }
      return hook(u, i)
    }
    await writeBookingConference(deps, first.booking.id)
    await writeBookingConference(deps, second.booking.id)
    let refuse = true
    const config = {
      ...mail(),
      mailer: {
        send: async (m: MailMessage) => {
          if (refuse && m.to === 'synthetic@example.com')
            throw new MailRejectedError({
              responseCode: 450,
              enhancedCode: '4.2.0',
              atRecipient: true,
            })
          sent.push(m)
        },
      },
    }
    await dispatchConferenceNotifications(config)
    expect(sent).toHaveLength(3)
    expect(
      (
        await db
          .selectFrom('booking_conference_notifications')
          .select('delivered')
          .where('booking_id', '=', second.booking.id)
          .where('kind', '=', 'confirmed')
          .executeTakeFirstOrThrow()
      ).delivered,
    ).toBe(true)
    refuse = false
    await db
      .updateTable('booking_conference_notifications')
      .set({ due_at: future() })
      .where('booking_id', '=', first.booking.id)
      .execute()
    await dispatchConferenceNotifications(config)
    expect(sent).toHaveLength(4)
  })
  it('calendar400 does not revoke credentials while invalid_grant does, with no upstream body exposure', async () => {
    const b = await book()
    provider.controls.eventHook = async () => new Response('private-upstream-echo', { status: 400 })
    await writeBookingConference(deps, b.booking.id)
    expect(
      (await db.selectFrom('calendar_connections').select('status').executeTakeFirstOrThrow())
        .status,
    ).toBe('active')
    expect((await row()).error_code).toBe('invalid_response')
    expect((await row()).create_started).toBe(false)
    await db
      .updateTable('booking_conferences')
      .set({ state: 'pending', next_attempt_at: future() })
      .execute()
    provider.controls.tokenStatus = 400
    provider.controls.token.error = 'invalid_grant'
    await writeBookingConference(deps, b.booking.id)
    expect(
      (await db.selectFrom('calendar_connections').select('status').executeTakeFirstOrThrow())
        .status,
    ).toBe('needs_reauth')
    expect((await row()).error_code).toBe('needs_reauth')
  })
})
