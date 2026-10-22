import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  activateRoundRobin,
  cancelManagedBooking,
  createEventType,
  createPublicTeamBooking,
  getHostBooking,
  listPublicTeamSlots,
  type PublicContext,
  rescheduleManagedBooking,
  type ServiceContext,
  updateEventType,
} from '@hourmere/scheduling'
import { googleWriteDestination } from '@hourmere/scheduling/conferences'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotificationRetryError, sendBookingNotification } from '../../notifications/src/index.ts'
import { writeBookingCalendar } from './booking-events.ts'
import { retryConferenceMirror } from './conference-mirrors.ts'
import { retryBookingConference, writeBookingConference } from './conferences.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z'),
  START = Temporal.Instant.from('2030-11-04T09:00:00Z'),
  URL = 'https://meet.google.com/abc-defg-hij'
const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
describe.skipIf(!serverUrl)('multi-host Meet identity and pinned mirrors (real PostgreSQL)', () => {
  let owned: TestDatabase,
    db: Db,
    users: TestUser[],
    team: Awaited<ReturnType<typeof createTestTeam>>,
    ctx: PublicContext,
    admin: ServiceContext,
    deps: CalendarDeps,
    provider: ReturnType<typeof fakeGoogle>,
    sent: MailMessage[],
    slug: string
  let copies: Map<string, Record<string, unknown>>,
    calls: { method: string; calendar: string; value: Record<string, unknown> }[]
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
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
    users = await Promise.all(['Host A', 'Host B', 'Host C'].map((n) => createTestUser(db, n)))
    team = await createTestTeam(
      db,
      users.map((user, i) => ({ user, role: i === 0 ? 'owner' : 'member' })),
    )
    slug = team.as(users[0] as TestUser).organization.slug as string
    const f = createFixtures(db)
    for (const [i, u] of users.entries()) {
      await db
        .insertInto('profiles')
        .values({ user_id: u.id, handle: `mh-${u.id}`, time_zone: 'UTC' })
        .execute()
      await f.schedule(u.id, { timeZone: 'UTC' })
      if (i < 2) await destination(u)
    }
    provider = fakeGoogle()
    copies = new Map()
    calls = []
    sent = []
    provider.controls.eventHook = async (url, init) => {
      const calendar = decodeURIComponent(url.pathname.split('/')[4] as string),
        id = url.pathname.split('/').at(-1) as string
      const value = init.body ? JSON.parse(String(init.body)) : undefined
      if (init.method === 'POST') {
        calls.push({ method: 'POST', calendar, value })
        const result = {
          ...value,
          id: `copy${calls.length}`,
          etag: '"v1"',
          ...(value.conferenceData
            ? {
                conferenceData: {
                  createRequest: { status: { statusCode: 'success' } },
                  conferenceSolution: { key: { type: 'hangoutsMeet' } },
                  entryPoints: [{ entryPointType: 'video', uri: URL }],
                },
              }
            : {}),
        }
        copies.set(`${calendar}/${result.id}`, result)
        return Response.json(result)
      }
      if (init.method === 'PATCH') {
        calls.push({ method: 'PATCH', calendar, value })
        const old = copies.get(`${calendar}/${id}`)
        const result = {
          ...old,
          ...value,
          id,
          etag: '"v2"',
          ...(value.conferenceData
            ? {
                conferenceData: {
                  createRequest: {
                    ...value.conferenceData.createRequest,
                    status: { statusCode: 'success' },
                  },
                  conferenceSolution: { key: { type: 'hangoutsMeet' } },
                  entryPoints: [{ entryPointType: 'video', uri: URL }],
                },
              }
            : {}),
        }
        copies.set(`${calendar}/${id}`, result)
        return Response.json(result)
      }
      if (url.searchParams.has('iCalUID'))
        return Response.json({
          items: [...copies.entries()]
            .filter(
              ([key, v]) =>
                key.startsWith(`${calendar}/`) && v.iCalUID === url.searchParams.get('iCalUID'),
            )
            .map(([, v]) => v),
        })
      const found = copies.get(`${calendar}/${id}`)
      return found ? Response.json(found) : Response.json({}, { status: 404 })
    }
    deps = {
      db,
      now: () => NOW.epochMilliseconds,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    ctx = { db, now: () => NOW, automaticMeet: true }
    admin = { ...ctx, principal: team.as(users[0] as TestUser) }
  })
  async function destination(u: TestUser) {
    const account = `google-${u.id}`
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: u.id,
        provider: 'google',
        external_account_id: account,
        account_email: 'untrusted-oauth@example.net',
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(u.id, account),
          JSON.stringify({
            accessToken: 'fake',
            refreshToken: 'fake',
            expiresAt: NOW.epochMilliseconds + 86400000,
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
        external_id: `cal-${u.id}`,
        name: 'Synthetic',
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calendar.id })
      .where('user_id', '=', u.id)
      .execute()
    return { calendar: calendar.id, connection: connection.id }
  }
  async function event(mode: 'collective' | 'round_robin' = 'collective') {
    // Deliberately select the lexicographically last host, proving hosts[0] is not authority.
    const selected = [...users.slice(0, 2)]
      .sort((a, b) => a.id.localeCompare(b.id))
      .at(-1) as TestUser
    const e = await createEventType(admin, {
      slug: 'meet',
      title: 'Team session',
      durationMinutes: 30,
      schedulingType: mode,
      hosts: users.map((u) => ({ userId: u.id })),
      location: { kind: 'google_meet', autoCreate: true },
      ...(mode === 'collective' ? { conferenceOrganizer: { userId: selected.id } } : {}),
    })
    if (mode === 'round_robin') await activateRoundRobin(admin, e.id)
    return { e, selected }
  }
  const book = (key = 'key', context = ctx) =>
    createPublicTeamBooking(context, {
      handle: slug,
      slug: 'meet',
      start: START,
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
      idempotencyKey: key,
    })
  const intent = (id: string) =>
    db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', id)
      .executeTakeFirstOrThrow()
  const mirrors = (id: string) =>
    db
      .selectFrom('booking_conference_mirrors')
      .selectAll()
      .where('root_booking_id', '=', id)
      .orderBy('user_id')
      .execute()
  const due = async (id: string) => {
    await db
      .updateTable('booking_conference_mirrors')
      .set({ next_attempt_at: new Date(NOW.epochMilliseconds - 1), lease_until: null })
      .where('root_booking_id', '=', id)
      .execute()
    await db
      .updateTable('booking_conferences')
      .set({ next_attempt_at: new Date(NOW.epochMilliseconds - 1), lease_until: null })
      .where('root_booking_id', '=', id)
      .execute()
  }
  it('requires an explicit collective organizer; metadata saves preserve the choice', async () => {
    await expect(
      createEventType(admin, {
        slug: 'meet',
        title: 'No choice',
        durationMinutes: 30,
        schedulingType: 'collective',
        hosts: users.map((u) => ({ userId: u.id })),
        location: { kind: 'google_meet', autoCreate: true },
      }),
    ).rejects.toMatchObject({ code: 'invalid_conference_organizer' })
    const { e, selected } = await event()
    expect(e.conferenceOrganizer).toEqual({ userId: selected.id })
    expect(
      (await updateEventType({ ...admin, automaticMeet: false }, e.id, { title: 'Metadata only' }))
        .conferenceOrganizer,
    ).toEqual(e.conferenceOrganizer)
    await expect(
      updateEventType(admin, e.id, { conferenceOrganizer: { userId: (users[2] as TestUser).id } }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
  })
  it('creates one conference and up to N-1 ordinary mirrors; no-connected host still receives ICS', async () => {
    const { selected } = await event()
    const pending = book()
    await expect(pending).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    const b = await pending,
      id = b.booking.id
    expect((await intent(id)).organizer_user_id).toBe(selected.id)
    expect((await intent(id)).invitation_organizer_email).toBe(selected.email)
    expect((await mirrors(id)).map((r) => r.state).sort()).toEqual(['not_configured', 'pending'])
    expect((await mirrors(id)).find((m) => m.state === 'not_configured')).toMatchObject({
      calendar_id: null,
      connection_id: null,
    })
    await writeBookingCalendar(deps, id)
    expect(calls).toHaveLength(0)
    await writeBookingConference(deps, id)
    expect(calls).toHaveLength(2)
    await Promise.all([writeBookingCalendar(deps, id), writeBookingCalendar(deps, id)])
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    const mirror = calls.find((c) => c.method === 'POST' && c.value.location === URL)
    expect(mirror?.value).toMatchObject({ iCalUID: `${id}@hourmere`, location: URL })
    expect(mirror?.value).not.toHaveProperty('attendees')
    expect(mirror?.value).not.toHaveProperty('conferenceData')
    await sendBookingNotification(mail(), id, 'confirmed')
    await sendBookingNotification(mail(), id, 'confirmed')
    expect(sent.map((m) => m.to).sort()).toEqual(
      [...users.map((u) => u.email), 'invitee@example.com'].sort(),
    )
    for (const m of sent) {
      const ics = String(m.attachments?.[0]?.content)
      expect(ics).toContain(`ORGANIZER;CN="${selected.name}":mailto:${selected.email}`)
      expect(ics).not.toContain(`ATTENDEE;CN="${selected.name}"`)
      expect(ics).not.toContain('untrusted-oauth')
    }
    const publicText = JSON.stringify(b)
    expect(publicText).not.toContain(selected.email)
    expect(publicText).not.toContain('invitation_organizer')
    expect(publicText).not.toContain('calendarCopy')
    const noCalendar = await getHostBooking(
      { ...ctx, principal: team.as(users[2] as TestUser) },
      id,
    )
    expect(noCalendar.calendarCopy).toEqual({
      status: 'not_configured',
      errorCode: 'not_configured',
      canRetry: false,
    })
  })
  it('round robin filters Meet eligibility before choosing actual fair winner and creates no mirrors', async () => {
    const { e } = await event('round_robin')
    await db
      .updateTable('round_robin_state')
      .set({ next_sequence: '6' })
      .where('event_type_id', '=', e.id)
      .execute()
    await db
      .updateTable('event_type_hosts')
      .set({ last_assigned_sequence: '5' })
      .where('event_type_id', '=', e.id)
      .where(
        'user_id',
        'in',
        users.slice(0, 2).map((u) => u.id),
      )
      .execute()
    const slots = await listPublicTeamSlots(ctx, {
      handle: slug,
      slug: 'meet',
      start: START,
      end: START.add({ hours: 1 }),
    })
    expect(slots.length).toBeGreaterThan(0)
    const firstResult = book()
    await expect(firstResult).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    const first = await firstResult
    const c = await intent(first.booking.id)
    expect(users.slice(0, 2).map((u) => u.id)).toContain(c.organizer_user_id)
    expect(await mirrors(first.booking.id)).toHaveLength(0)
    const replay = await book()
    expect(replay.replayed).toBe(true)
    expect((await intent(first.booking.id)).organizer_user_id).toBe(c.organizer_user_id)
    const second = await book('other')
    expect((await intent(second.booking.id)).organizer_user_id).not.toBe(c.organizer_user_id)
  })
  it('round robin public slots exclude times offered only by Meet-ineligible hosts', async () => {
    await event('round_robin')
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify({}) })
      .where(
        'user_id',
        'in',
        users.slice(0, 2).map((u) => u.id),
      )
      .execute()
    expect(
      await listPublicTeamSlots(ctx, {
        handle: slug,
        slug: 'meet',
        start: START,
        end: START.add({ hours: 1 }),
      }),
    ).toEqual([])
  })
  it('collective public slots recheck the selected organizer destination', async () => {
    const { selected } = await event()
    await db
      .updateTable('calendars')
      .set({ supports_google_meet: false })
      .where('external_id', '=', `cal-${selected.id}`)
      .execute()
    await expect(
      listPublicTeamSlots(ctx, {
        handle: slug,
        slug: 'meet',
        start: START,
        end: START.add({ hours: 1 }),
      }),
    ).rejects.toMatchObject({ code: 'automatic_meet_unavailable' })
  })
  it('round robin rejects a fixed conference organizer even when that host is eligible', async () => {
    await expect(
      createEventType(admin, {
        slug: 'meet',
        title: 'Invalid fixed choice',
        durationMinutes: 30,
        schedulingType: 'round_robin',
        hosts: users.map((u) => ({ userId: u.id })),
        location: { kind: 'google_meet', autoCreate: true },
        conferenceOrganizer: { userId: (users[0] as TestUser).id },
      }),
    ).rejects.toMatchObject({ code: 'invalid_conference_organizer' })
  })
  it('only the pinned collective organizer can retry a failed root', async () => {
    const { selected } = await event(),
      b = await book()
    await db
      .updateTable('booking_conferences')
      .set({ state: 'failed', error_code: 'provider_unavailable' })
      .where('root_booking_id', '=', b.booking.id)
      .execute()
    const other = users.find((u) => u.id !== selected.id) as TestUser
    await expect(
      retryBookingConference({ ...ctx, principal: team.as(other) }, b.booking.id),
    ).rejects.toMatchObject({ code: 'conference_not_found' })
    expect((await intent(b.booking.id)).state).toBe('failed')
    await retryBookingConference({ ...ctx, principal: team.as(selected) }, b.booking.id)
    expect((await intent(b.booking.id)).state).toBe('pending')
  })
  it.each([
    { status: 400, error: 'invalid_response' },
    { status: 401, error: 'needs_reauth' },
    { status: 403, error: 'permissions_missing' },
    { status: 429, error: null },
    { status: 403, reason: 'rateLimitExceeded', error: null },
    { status: 403, reason: 'userRateLimitExceeded', error: null },
  ])(
    'known rejected mirror import $status ($reason) permits a later create',
    async ({ status, reason, error }) => {
      await event()
      const b = await book()
      await writeBookingConference(deps, b.booking.id)
      const original = provider.controls.eventHook
      if (!original) throw Error('Synthetic provider hook missing')
      provider.controls.eventHook = async (url, init) =>
        init.method === 'POST'
          ? Response.json({ error: { errors: [{ reason: reason ?? 'forbidden' }] } }, { status })
          : original(url, init)
      await writeBookingCalendar(deps, b.booking.id)
      const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
      expect(m).toMatchObject({
        state: error ? 'failed' : 'pending',
        error_code: error,
        create_started: false,
      })
      expect((await intent(b.booking.id)).state).toBe('ready')
      if (error)
        await retryConferenceMirror(
          { ...ctx, principal: team.as(users.find((u) => u.id === m?.user_id) as TestUser) },
          b.booking.id,
        )
      await db.updateTable('calendar_connections').set({ status: 'active' }).execute()
      provider.controls.eventHook = original
      await due(b.booking.id)
      await writeBookingCalendar(deps, b.booking.id)
      expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)).toMatchObject({
        state: 'ready',
        error_code: null,
      })
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    },
  )
  it('rejects an ordinary mirror response that contains conferenceData', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const original = provider.controls.eventHook
    if (!original) throw Error('Synthetic provider hook missing')
    provider.controls.eventHook = async (url, init) => {
      const result = await original(url, init)
      return init.method === 'POST'
        ? Response.json({
            ...((await result.json()) as Record<string, unknown>),
            conferenceData: {},
          })
        : result
    }
    await writeBookingCalendar(deps, b.booking.id)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      external_event_id: null,
    })
  })
  it('a mirror 503 import response remains ambiguous and never permits another POST', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    let posts = 0
    provider.controls.eventHook = async (_url, init) => {
      if (init.method === 'POST') {
        posts++
        return Response.json({}, { status: 503 })
      }
      return Response.json({ items: [] })
    }
    await writeBookingCalendar(deps, b.booking.id)
    const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
    expect(m).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      create_started: true,
    })
    await retryConferenceMirror(
      { ...ctx, principal: team.as(users.find((u) => u.id === m?.user_id) as TestUser) },
      b.booking.id,
    )
    await due(b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(posts).toBe(1)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)?.error_code).toBe(
      'ambiguous_create',
    )
  })
  it('notifier failure rolls back the fairness sequence, winner, snapshot, mirrors and booking atomically', async () => {
    const { e } = await event('round_robin')
    await expect(
      book('fail', {
        ...ctx,
        notify: async () => {
          throw Error('synthetic enqueue failure')
        },
      }),
    ).rejects.toThrow('synthetic enqueue failure')
    expect(
      await db.selectFrom('bookings').select('id').where('event_type_id', '=', e.id).execute(),
    ).toHaveLength(0)
    expect(
      (
        await db
          .selectFrom('round_robin_state')
          .select('next_sequence')
          .where('event_type_id', '=', e.id)
          .executeTakeFirstOrThrow()
      ).next_sequence,
    ).toBe('0')
  })
  it('a newly connected host is never bound to an existing root; existing target pins cannot change', async () => {
    await event()
    const b = await book()
    const skipped = (await mirrors(b.booking.id)).find((m) => m.state === 'not_configured')
    await destination(users[2] as TestUser)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect((await mirrors(b.booking.id)).find((m) => m.user_id === skipped?.user_id)?.state).toBe(
      'not_configured',
    )
    await expect(
      db
        .updateTable('booking_conferences')
        .set({ invitation_organizer_email: 'changed@example.com' })
        .where('root_booking_id', '=', b.booking.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db
        .updateTable('booking_conference_mirrors')
        .set({ calendar_id: null, connection_id: null, state: 'not_configured' })
        .where('root_booking_id', '=', b.booking.id)
        .where('state', '=', 'ready')
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('unknown accepted mirror POST plus empty UID lookup never authorizes another POST, even after retry', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const original = provider.controls.eventHook
    let attempts = 0
    provider.controls.eventHook = async (url, init) => {
      if (init.method === 'POST') {
        attempts++
        throw new TypeError('lost accepted response')
      }
      if (url.searchParams.has('iCalUID')) return Response.json({ items: [] })
      return (
        original ??
        (() => {
          throw Error('Synthetic provider hook missing')
        })
      )(url, init)
    }
    await writeBookingCalendar(deps, b.booking.id)
    const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
    expect(m).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      create_started: true,
    })
    await retryConferenceMirror(
      { ...ctx, principal: team.as(users.find((u) => u.id === m?.user_id) as TestUser) },
      b.booking.id,
    )
    await due(b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(attempts).toBe(1)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)?.error_code).toBe(
      'ambiguous_create',
    )
  })
  it('unknown cache/SQL errors propagate and are never treated as an unconfigured host', async () => {
    const failure = new Error('synthetic unknown database failure')
    const broken = db.withPlugin({
      transformQuery() {
        throw failure
      },
      async transformResult(args) {
        return args.result
      },
    })
    await expect(googleWriteDestination(broken, (users[0] as TestUser).id)).rejects.toBe(failure)
  })
  it('pinned organizer address changes stop REQUEST; CANCEL keeps logical identity without mailing old address', async () => {
    const { selected } = await event(),
      b = await book()
    await writeBookingConference(deps, b.booking.id)
    const next = `new-${selected.email}`
    await db
      .updateTable('auth.user')
      .set({ email: next, emailVerified: true })
      .where('id', '=', selected.id)
      .execute()
    await expect(sendBookingNotification(mail(), b.booking.id, 'confirmed')).rejects.toBeInstanceOf(
      NotificationRetryError,
    )
    expect(sent).toHaveLength(0)
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent.map((m) => m.to)).toContain(next)
    expect(sent.map((m) => m.to)).not.toContain(selected.email)
    expect(String(sent.at(-1)?.attachments?.[0]?.content)).toContain(`mailto:${selected.email}`)
  })
  it('deleted organizer never transfers; cancellation still reaches current original participants', async () => {
    const { selected } = await event(),
      b = await book()
    await db.deleteFrom('auth.user').where('id', '=', selected.id).execute()
    await writeBookingConference(deps, b.booking.id)
    expect(await intent(b.booking.id)).toMatchObject({
      state: 'failed',
      error_code: 'organizer_unavailable',
    })
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent.map((m) => m.to).sort()).toEqual(
      [
        ...users.filter((u) => u.id !== selected.id).map((u) => u.email),
        'invitee@example.com',
      ].sort(),
    )
    expect(String(sent.at(-1)?.attachments?.[0]?.content)).toContain(`mailto:${selected.email}`)
  })
  it('moves retain organizer, invitation identity, target pins, UID and shared URL through mode changes', async () => {
    const { e, selected } = await event(),
      b = await book()
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    await updateEventType(admin, e.id, {
      schedulingType: 'round_robin',
      hosts: users.map((u) => ({ userId: u.id })),
      conferenceOrganizer: null,
    })
    const moved = await rescheduleManagedBooking(ctx, b.manageToken as string, {
      start: START.add({ hours: 1 }),
    })
    await due(b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(await intent(b.booking.id)).toMatchObject({
      organizer_user_id: selected.id,
      invitation_organizer_email: selected.email,
      booking_id: moved.booking.id,
      state: 'ready',
    })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3)
    expect(
      calls.every(
        (c) => c.value.iCalUID === undefined || c.value.iCalUID === `${b.booking.id}@hourmere`,
      ),
    ).toBe(true)
    await cancelManagedBooking(ctx, moved.manageToken as string, {})
    await due(b.booking.id)
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect([...copies.values()].every((c) => c.status === 'cancelled')).toBe(true)
  })
  it('late mirror import is retained across cancellation and cleaned without an extra POST', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const entered = barrier(),
      release = barrier(),
      original = provider.controls.eventHook
    provider.controls.eventHook = async (url, init) => {
      const result = await (
        original ??
        (() => {
          throw Error('Synthetic provider hook missing')
        })
      )(url, init)
      if (init.method === 'POST') {
        entered.release()
        await release.promise
      }
      return result
    }
    const work = writeBookingCalendar(deps, b.booking.id)
    await entered.promise
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    release.release()
    await expect(work).resolves.toBeUndefined()
    await due(b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)).toMatchObject({
      state: 'ready',
      external_event_id: expect.any(String),
    })
    expect(
      [...copies.values()].filter((v) => !v.conferenceData).every((v) => v.status === 'cancelled'),
    ).toBe(true)
  })
  it('configured target disconnect retains inspectable failure rather than silently skipping or rebinding', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const m = (await mirrors(b.booking.id)).find((m) => m.connection_id)
    await db
      .deleteFrom('calendar_connections')
      .where('id', '=', m?.connection_id as string)
      .execute()
    await writeBookingCalendar(deps, b.booking.id)
    expect((await mirrors(b.booking.id)).find((r) => r.user_id === m?.user_id)).toMatchObject({
      state: 'failed',
      error_code: 'calendar_unavailable',
      connection_id: m?.connection_id,
    })
    const status = await getHostBooking(
      { ...ctx, principal: team.as(users.find((u) => u.id === m?.user_id) as TestUser) },
      b.booking.id,
    )
    expect(status.calendarCopy).toMatchObject({
      status: 'failed',
      errorCode: 'calendar_unavailable',
      canRetry: true,
    })
  })
  it('does not downgrade a TypeError from a real-PG calendar query into provider failure', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const failure = new TypeError('synthetic query programming failure')
    const broken = db.withPlugin({
      transformQuery(args) {
        if (JSON.stringify(args.node).includes('"name":"calendars"')) throw failure
        return args.node
      },
      async transformResult(args) {
        return args.result
      },
    })
    await expect(writeBookingCalendar({ ...deps, db: broken }, b.booking.id)).rejects.toBe(failure)
    const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
    expect(m).toMatchObject({ state: 'pending', create_started: true, error_code: null })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it.each(['root', 'mirror'] as const)(
    'late %s identity wakes safe CANCEL after a replacement lease reports ambiguous absence',
    async (kind) => {
      await event()
      const b = await book()
      if (kind === 'mirror') await writeBookingConference(deps, b.booking.id)
      const entered = barrier(),
        release = barrier(),
        looked = barrier(),
        original = provider.controls.eventHook
      if (!original) throw Error('Synthetic hook missing')
      provider.controls.eventHook = async (url, init) => {
        if (url.searchParams.has('iCalUID')) {
          looked.release()
          return Response.json({ items: [] })
        }
        const response = await original(url, init)
        if (init.method === 'POST') {
          entered.release()
          await release.promise
        }
        return response
      }
      const work = () =>
        kind === 'root'
          ? writeBookingConference(deps, b.booking.id)
          : writeBookingCalendar(deps, b.booking.id)
      const first = work()
      await entered.promise
      await cancelManagedBooking(ctx, b.manageToken as string, {})
      const locked = barrier(),
        unlock = barrier()
      const holder = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('bookings')
          .select('id')
          .where('id', '=', b.booking.id)
          .forUpdate()
          .execute()
        locked.release()
        await unlock.promise
      })
      await locked.promise
      const table = kind === 'root' ? 'booking_conferences' : 'booking_conference_mirrors'
      await db
        .updateTable(table)
        .set({
          lease_until: new Date(NOW.epochMilliseconds - 1),
          next_attempt_at: new Date(NOW.epochMilliseconds - 1),
        })
        .where('root_booking_id', '=', b.booking.id)
        .execute()
      const second = work()
      release.release()
      await looked.promise
      unlock.release()
      await holder
      await Promise.all([first, second])
      const state =
        kind === 'root'
          ? await intent(b.booking.id)
          : (await mirrors(b.booking.id)).find((m) => m.calendar_id)
      expect(state).toMatchObject({ state: 'pending', external_event_id: expect.any(String) })
      await due(b.booking.id)
      await work()
      expect(
        (kind === 'root'
          ? await intent(b.booking.id)
          : (await mirrors(b.booking.id)).find((m) => m.calendar_id)
        )?.state,
      ).toBe('ready')
      expect(
        [...copies.values()]
          .filter((v) => (kind === 'root' ? Boolean(v.conferenceData) : !v.conferenceData))
          .every((v) => v.status === 'cancelled'),
      ).toBe(true)
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(kind === 'root' ? 1 : 2)
    },
  )
  it('a known mirror 404 cancellation removes local busy state without another import', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
    expect(
      await db
        .selectFrom('calendar_busy')
        .select('external_event_id')
        .where('calendar_id', '=', m?.calendar_id as string)
        .execute(),
    ).toHaveLength(1)
    copies.delete(`cal-${m?.user_id}/${m?.external_event_id}`)
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    await due(b.booking.id)
    await writeBookingCalendar(deps, b.booking.id)
    expect(
      await db
        .selectFrom('calendar_busy')
        .select('external_event_id')
        .where('calendar_id', '=', m?.calendar_id as string)
        .execute(),
    ).toHaveLength(0)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)?.state).toBe('ready')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })
  it('membership withdrawal waits for the atomic booking commit, then blocks organizer REQUEST and creates no conference', async () => {
    const { selected } = await event(),
      entered = barrier(),
      release = barrier()
    const creating = book('member-race', {
      ...ctx,
      notify: async () => {
        entered.release()
        await release.promise
      },
    })
    await entered.promise
    let finished = false
    const revoking = db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', selected.id)
      .execute()
      .then(() => {
        finished = true
      })
    let observed = false
    for (let i = 0; i < 100; i++) {
      const r = await sql<{
        waiting: boolean
      }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%delete%member%') AS waiting`.execute(
        db,
      )
      if (r.rows[0]?.waiting) {
        observed = true
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(observed).toBe(true)
    expect(finished).toBe(false)
    release.release()
    const b = await creating
    await revoking
    await writeBookingConference(deps, b.booking.id)
    expect(await intent(b.booking.id)).toMatchObject({
      state: 'failed',
      error_code: 'organizer_unavailable',
    })
    expect(calls).toHaveLength(0)
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    await sendBookingNotification(mail(), b.booking.id, 'cancelled')
    expect(sent.map((m) => m.to)).not.toContain(selected.email)
  })
  it('withdrawal committed before booking rejects the full collective set without writing an intent', async () => {
    const { e, selected } = await event()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', selected.id)
      .execute()
    await expect(book()).rejects.toMatchObject({ code: 'event_type_not_found' })
    expect(
      await db.selectFrom('bookings').select('id').where('event_type_id', '=', e.id).execute(),
    ).toHaveLength(0)
  })
  it.each(['pending', 'ready', 'failed'] as const)(
    'old0021 %s roots keep current verified same-ID invitations, without fabricated snapshots or mirrors',
    async (initial) => {
      const u = users[0] as TestUser
      await createEventType(admin, {
        slug: 'meet',
        title: 'Legacy compatible',
        durationMinutes: 30,
        hosts: [{ userId: u.id }],
        location: { kind: 'google_meet' },
      })
      const b = await book()
      await db
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true, url: URL }) })
        .where('id', '=', b.booking.id)
        .execute()
      const target = await googleWriteDestination(db, u.id)
      if (!target.eligible) throw Error('Synthetic target missing')
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: b.booking.id,
          booking_id: b.booking.id,
          organization_id: team.id,
          organizer_user_id: u.id,
          calendar_id: target.calendar_id,
          connection_id: target.connection_id,
          state: initial,
          applied_revision: initial === 'ready' ? 0 : null,
          error_code: initial === 'failed' ? 'provider_unavailable' : null,
        })
        .execute()
      if (initial !== 'ready')
        await db
          .updateTable('booking_conferences')
          .set({ state: 'pending', error_code: null })
          .where('root_booking_id', '=', b.booking.id)
          .execute()
      await writeBookingConference(deps, b.booking.id)
      await sendBookingNotification(mail(), b.booking.id, 'confirmed')
      expect(sent).toHaveLength(2)
      expect(String(sent[0]?.attachments?.[0]?.content)).toContain(`mailto:${u.email}`)
      expect(await intent(b.booking.id)).toMatchObject({
        invitation_organizer_email: null,
        invitation_organizer_name: null,
      })
      expect(await mirrors(b.booking.id)).toHaveLength(0)
      sent = []
      await cancelManagedBooking(ctx, b.manageToken as string, {})
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', u.id)
        .execute()
      await sendBookingNotification(mail(), b.booking.id, 'cancelled')
      expect(sent.map((m) => m.to)).toEqual(['invitee@example.com'])
      expect(sent[0]?.attachments?.length ?? 0).toBe(0)
    },
  )
  it.each(['root', 'mirror'] as const)(
    'a %s ID arriving after an already-terminal newer lease reopens safe cleanup',
    async (kind) => {
      await event()
      const b = await book()
      if (kind === 'mirror') await writeBookingConference(deps, b.booking.id)
      const applyEntered = barrier(),
        allowApply = barrier()
      let transactions = 0
      const delayed = new Proxy(db, {
        get(target, key) {
          if (key === 'transaction')
            return () => {
              const builder = target.transaction()
              return new Proxy(builder, {
                get(t, k) {
                  if (k === 'execute')
                    return async (callback: Parameters<typeof builder.execute>[0]) => {
                      transactions++
                      if (transactions === 3) {
                        applyEntered.release()
                        await allowApply.promise
                      }
                      return t.execute(callback)
                    }
                  const v = Reflect.get(t, k)
                  return typeof v === 'function' ? v.bind(t) : v
                },
              })
            }
          const v = Reflect.get(target, key)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      const first =
        kind === 'root'
          ? writeBookingConference({ ...deps, db: delayed }, b.booking.id)
          : writeBookingCalendar({ ...deps, db: delayed }, b.booking.id)
      await applyEntered.promise
      await cancelManagedBooking(ctx, b.manageToken as string, {})
      const table = kind === 'root' ? 'booking_conferences' : 'booking_conference_mirrors'
      await db
        .updateTable(table)
        .set({
          lease_until: new Date(NOW.epochMilliseconds - 1),
          next_attempt_at: new Date(NOW.epochMilliseconds - 1),
        })
        .where('root_booking_id', '=', b.booking.id)
        .execute()
      const original = provider.controls.eventHook
      if (!original) throw Error('Synthetic hook missing')
      provider.controls.eventHook = async (url, init) =>
        url.searchParams.has('iCalUID') ? Response.json({ items: [] }) : original(url, init)
      const work = () =>
        kind === 'root'
          ? writeBookingConference(deps, b.booking.id)
          : writeBookingCalendar(deps, b.booking.id)
      await work()
      expect(
        (kind === 'root'
          ? await intent(b.booking.id)
          : (await mirrors(b.booking.id)).find((m) => m.calendar_id)
        )?.state,
      ).toBe('failed')
      allowApply.release()
      await first
      expect(
        kind === 'root'
          ? await intent(b.booking.id)
          : (await mirrors(b.booking.id)).find((m) => m.calendar_id),
      ).toMatchObject({ state: 'pending', external_event_id: expect.any(String) })
      await due(b.booking.id)
      await work()
      expect(
        (kind === 'root'
          ? await intent(b.booking.id)
          : (await mirrors(b.booking.id)).find((m) => m.calendar_id)
        )?.state,
      ).toBe('ready')
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(kind === 'root' ? 1 : 2)
    },
  )
  it('a mirror response with the wrong shared URL is retained as failed, never declared ready', async () => {
    await event()
    const b = await book()
    await writeBookingConference(deps, b.booking.id)
    const original = provider.controls.eventHook
    if (!original) throw Error('Synthetic hook missing')
    provider.controls.eventHook = async (url, init) => {
      const response = await original(url, init)
      if (init.method === 'POST') {
        const value = (await response.json()) as Record<string, unknown>
        return Response.json({ ...value, location: 'https://attacker.example/room' })
      }
      return response
    }
    await writeBookingCalendar(deps, b.booking.id)
    expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)).toMatchObject({
      state: 'failed',
      error_code: 'invalid_response',
      external_event_id: expect.any(String),
    })
    expect((await intent(b.booking.id)).state).toBe('ready')
  })
  it.each([false, true])(
    'removed instance Google configuration leaves an inspectable pinned mirror outcome (created=%s)',
    async (created) => {
      await event()
      const b = await book()
      await writeBookingConference(deps, b.booking.id)
      if (created) await writeBookingCalendar(deps, b.booking.id)
      const withoutGoogle = { db, now: () => NOW.epochMilliseconds }
      if (created) await cancelManagedBooking(ctx, b.manageToken as string, {})
      await due(b.booking.id)
      await writeBookingCalendar(withoutGoogle, b.booking.id)
      const m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
      expect(m).toMatchObject({
        state: 'failed',
        error_code: 'calendar_unavailable',
        create_started: created,
      })
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(created ? 2 : 1)
      if (!created) {
        await cancelManagedBooking(ctx, b.manageToken as string, {})
        await writeBookingCalendar(withoutGoogle, b.booking.id)
        expect((await mirrors(b.booking.id)).find((m) => m.calendar_id)?.state).toBe('ready')
      }
    },
  )
  it('private retry hints reject started confirmed meetings while retaining late cancellation cleanup', async () => {
    await event()
    const b = await book(),
      m = (await mirrors(b.booking.id)).find((m) => m.calendar_id)
    if (!m) throw Error('Synthetic pinned copy missing')
    await db
      .updateTable('booking_conference_mirrors')
      .set({ state: 'failed', error_code: 'calendar_unavailable' })
      .where('root_booking_id', '=', b.booking.id)
      .where('user_id', '=', m.user_id)
      .execute()
    const host = users.find((u) => u.id === m.user_id) as TestUser,
      late = { ...ctx, now: () => START.add({ hours: 1 }), principal: team.as(host) }
    expect((await getHostBooking(late, b.booking.id)).calendarCopy?.canRetry).toBe(false)
    await expect(retryConferenceMirror(late, b.booking.id)).rejects.toMatchObject({
      code: 'calendar_copy_not_retryable',
    })
    await cancelManagedBooking(ctx, b.manageToken as string, {})
    await db
      .updateTable('booking_conference_mirrors')
      .set({ state: 'failed', error_code: 'calendar_unavailable' })
      .where('root_booking_id', '=', b.booking.id)
      .where('user_id', '=', m.user_id)
      .execute()
    expect((await getHostBooking(late, b.booking.id)).calendarCopy?.canRetry).toBe(true)
    await expect(retryConferenceMirror(late, b.booking.id)).resolves.toBeUndefined()
  })
})
