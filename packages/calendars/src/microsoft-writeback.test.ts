import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createPublicBooking } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarBookingNotifier, redispatchBookingCalendar } from './booking-events.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import {
  beginMicrosoftConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishMicrosoftConnection,
  tokenAad,
} from './index.ts'
import { bookingCalendarJob, bookingCalendarRecoveryJob, calendarDispatchJob } from './jobs.ts'
import { createMicrosoftCalendarClient } from './microsoft.ts'
import {
  type CalendarWritePayload,
  readMicrosoftWritebackSummary,
  writeMicrosoftCalendar,
} from './microsoft-writeback.ts'
import { TEST_CALENDAR_KEY } from './testing.ts'

const NOW = Temporal.Instant.from('2030-03-04T08:00:00Z')
const START = Temporal.Instant.from('2030-03-06T10:00:00Z')
const etag = 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJB"'
const eventId = 'AAMkAGViNDU7zAAAAAGtlAAAMh8kAAA='
const scope = 'Calendars.ReadWrite'
const invitee = { name: 'Private Invitee', email: 'invitee@example.test', timeZone: 'UTC' }
const signal = () => new AbortController().signal

type GraphEvent = {
  id: string
  '@odata.etag': string
  transactionId: string
  type: 'singleInstance'
  isCancelled: false
}
type Call = { calendar: string; method: 'GET' | 'POST'; transactionId: string; body?: unknown }

function graphError(status: number, code: string, headers?: Record<string, string>) {
  return Response.json(
    {
      error: {
        code,
        message: 'Private Graph details',
        innerError: { date: '2030-03-04T08:00:00', 'request-id': 'synthetic-id' },
      },
    },
    { status, ...(headers && { headers }) },
  )
}

function graph(now: () => number) {
  const token = vi.fn(() =>
    Response.json(
      { error: 'invalid_grant', error_description: 'Private tenant details' },
      {
        status: 400,
      },
    ),
  )
  const calls: Call[] = []
  const events = new Map<string, GraphEvent>()
  const controls: {
    beforeLookup?: () => Response | undefined | Promise<Response | undefined>
    beforeCreate?: () => Response | undefined
    afterCreate?: () => Promise<Response | undefined>
    reconnect?: { account: string; calendars: string[] }
  } = {}
  const client = createMicrosoftCalendarClient(
    { clientId: 'fake-client', clientSecret: 'fake-secret', publicUrl: 'https://hourmere.test' },
    async (input, init) => {
      const url = new URL(String(input))
      if (
        url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token' &&
        init?.method === 'POST'
      )
        return token()
      if (controls.reconnect && url.origin === 'https://graph.microsoft.com') {
        if (url.pathname === '/oidc/userinfo')
          return Response.json({ sub: controls.reconnect.account })
        if (url.pathname === '/v1.0/me/calendars')
          return Response.json({
            value: controls.reconnect.calendars.map((id) => ({
              id,
              name: id,
              canEdit: true,
              canShare: true,
              canViewPrivateItems: true,
            })),
          })
      }
      const segment = /^\/v1\.0\/me\/calendars\/([^/]+)\/events$/u.exec(url.pathname)?.[1]
      if (url.origin !== 'https://graph.microsoft.com' || !segment)
        throw new Error('Unexpected synthetic Graph endpoint')
      const calendar = decodeURIComponent(segment)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const transactionId = String(body.transactionId)
        calls.push({ calendar, method: 'POST', transactionId, body })
        const failure = controls.beforeCreate?.()
        if (failure) return failure
        const key = JSON.stringify([calendar, transactionId])
        if (events.has(key)) return graphError(409, 'ErrorDuplicateTransactionId')
        const event: GraphEvent = {
          id: eventId,
          '@odata.etag': etag,
          transactionId,
          type: 'singleInstance',
          isCancelled: false,
        }
        events.set(key, event)
        return (
          (await controls.afterCreate?.()) ??
          Response.json({ '@odata.context': `${url.href}/$entity`, ...event }, { status: 201 })
        )
      }
      const transactionId = /ep\/value eq '([a-f0-9]{64})'\)$/u.exec(
        url.searchParams.get('$filter') ?? '',
      )?.[1]
      if (!transactionId) throw new Error('Missing synthetic Graph recovery filter')
      calls.push({ calendar, method: 'GET', transactionId })
      const failure = await controls.beforeLookup?.()
      if (failure) return failure
      const event = events.get(JSON.stringify([calendar, transactionId]))
      return Response.json({ value: event ? [event] : [] })
    },
    now,
  )
  return {
    client,
    controls,
    calls,
    token,
    events,
    posts: () => calls.filter((c) => c.method === 'POST'),
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Microsoft booking calendar write-back (real Postgres)',
  () => {
    let database: TestDatabase
    let db: Db
    let f: ReturnType<typeof createFixtures>
    let host: Awaited<ReturnType<typeof f.host>>
    let provider: ReturnType<typeof graph>
    let deps: CalendarDeps
    let now: number
    let connectionId: string
    let selected: string
    let eventTypeId: string
    let queued: CalendarWritePayload[]

    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(database.pool)
      f = createFixtures(db)
    })
    afterAll(async () => {
      await database?.drop()
    })

    function credentials(userId: string, expiresAt: number) {
      return encryptCredential(
        calendarEncryptionKey(TEST_CALENDAR_KEY),
        tokenAad(userId, `graph-account-${userId}`, 'microsoft'),
        JSON.stringify({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt }),
      )
    }
    async function connect(userId: string) {
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: userId,
          provider: 'microsoft',
          external_account_id: `graph-account-${userId}`,
          scopes: [scope],
          credentials: credentials(userId, now + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return connection.id
    }
    async function calendar(connection: string, name: string) {
      const row = await db
        .insertInto('calendars')
        .values({
          connection_id: connection,
          external_id: name,
          name,
          access_role: 'owner',
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    }
    const select = (calendarId: string) =>
      db
        .updateTable('profiles')
        .set({ destination_calendar_id: calendarId })
        .where('user_id', '=', host.userId)
        .execute()

    beforeEach(async () => {
      if (host)
        await db.deleteFrom('auth.organization').where('id', '=', host.organizationId).execute()
      host = await f.host({ timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      now = NOW.epochMilliseconds
      queued = []
      provider = graph(() => now)
      deps = {
        db,
        microsoft: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
        now: () => now,
      }
      connectionId = await connect(host.userId)
      selected = await calendar(connectionId, 'outlook-selected')
      await select(selected)
      eventTypeId = await f.eventType(host.organizationId, host.userId, {
        slug: 'outlook-booking',
        title: 'Booking title',
        location: { kind: 'link', url: 'https://private.example.test/meeting' },
      })
    })

    async function book(person = invitee, idempotencyKey?: string) {
      const notify = calendarBookingNotifier(
        {
          async enqueue(name, payload, options) {
            expect(name).toBe('booking-calendar')
            expect(options?.transaction).toBeDefined()
            queued.push(payload)
            return null
          },
        },
        { google: false, now: () => now },
      )
      const result = await createPublicBooking(
        {
          db,
          now: () => Temporal.Instant.fromEpochMilliseconds(now),
          notify: (trx, event) =>
            event.type === 'created' ? notify(trx, event) : Promise.resolve(),
        },
        {
          handle: host.handle,
          slug: 'outlook-booking',
          start: START,
          invitee: person,
          idempotencyKey,
        },
      )
      return result.booking.id
    }

    async function bookGroup() {
      await db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 3 })
        .where('id', '=', eventTypeId)
        .execute()
      const bookingId = await book()
      const slot = await db
        .selectFrom('bookings')
        .select('group_slot_id')
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow()
      if (!slot.group_slot_id) throw new Error('Expected a group occurrence')
      return slot.group_slot_id
    }

    async function hostSession(): Promise<Principal> {
      const user = await db
        .selectFrom('auth.user')
        .select(['id', 'name', 'email'])
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
      const organization = await db
        .selectFrom('auth.organization')
        .select(['id', 'name', 'slug'])
        .where('id', '=', host.organizationId)
        .executeTakeFirstOrThrow()
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token: `fake-session-${user.id}`,
          updatedAt: new Date(now),
          expiresAt: new Date(now + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return {
        kind: 'session',
        sessionId: session.id,
        user,
        organization: { ...organization, personal: true },
      }
    }

    const state = async (bookingId: string) => {
      const row = await db
        .selectFrom('booking_calendar_targets')
        .select('microsoft_writeback')
        .where('root_booking_id', '=', bookingId)
        .where('user_id', '=', host.userId)
        .executeTakeFirst()
      return row?.microsoft_writeback
    }
    const mappings = (bookingId: string) =>
      db
        .selectFrom('booking_calendar_events')
        .select(['calendar_id', 'external_event_id', 'etag'])
        .where('booking_id', '=', bookingId)
        .execute()
    const work = (payload: CalendarWritePayload) =>
      bookingCalendarJob(deps).handler(payload, {
        id: 'synthetic-job',
        signal: signal(),
        attempt: 1,
      })
    const dispatch = (enqueue: (payload: CalendarWritePayload) => Promise<unknown>) =>
      calendarDispatchJob(deps, async () => {}, enqueue).handler(
        {},
        { id: 'synthetic-dispatch-job', signal: signal(), attempt: 1 },
      )

    it('pins the event-type calendar and creates one private copy through concurrent jobs', async () => {
      const override = await calendar(connectionId, 'outlook-override')
      await db
        .updateTable('event_type_hosts')
        .set({ destination_calendar_id: override })
        .where('event_type_id', '=', eventTypeId)
        .execute()
      const bookingId = await book(invitee, 'same-booking-request')
      expect(queued).toEqual([{ bookingId }])
      expect(await state(bookingId)).toMatchObject({ status: 'pending', attempts: 0 })
      await db
        .updateTable('event_type_hosts')
        .set({ destination_calendar_id: null })
        .where('event_type_id', '=', eventTypeId)
        .execute()
      expect(await book(invitee, 'same-booking-request')).toBe(bookingId)
      expect(queued).toEqual([{ bookingId }])

      const sent = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      provider.controls.afterCreate = async () => {
        sent.resolve()
        await release.promise
        return undefined
      }
      const jobs = Promise.all([work({ bookingId }), work({ bookingId })])
      try {
        await Promise.race([
          sent.promise,
          jobs.then(() => {
            throw new Error('The booking job did not send a Graph creation')
          }),
        ])
        expect(await state(bookingId)).toMatchObject({
          status: 'retrying',
          attempts: 1,
          lookupOnly: true,
        })
        expect(await mappings(bookingId)).toEqual([])
      } finally {
        release.resolve()
        await jobs
      }
      await work({ bookingId })

      expect(provider.calls.map(({ calendar, method }) => [calendar, method])).toEqual([
        ['outlook-override', 'GET'],
        ['outlook-override', 'POST'],
      ])
      const body = provider.posts()[0]?.body
      expect(body).toMatchObject({
        subject: 'Booking title with Private Invitee',
        sensitivity: 'private',
        showAs: 'busy',
      })
      expect(body).not.toHaveProperty('attendees')
      expect(body).not.toHaveProperty('body')
      expect(body).not.toHaveProperty('location')
      expect(JSON.stringify(body)).not.toMatch(/invitee@example.test|private.example.test/)
      expect(provider.events.size).toBe(1)
      expect(await mappings(bookingId)).toEqual([
        { calendar_id: override, external_event_id: eventId, etag },
      ])
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 1 })
    })

    it('ignores even a persisted destination owned by someone outside the booking', async () => {
      const other = await f.host()
      const foreign = await calendar(await connect(other.userId), 'foreign-calendar')
      await select(foreign)
      const bookingId = await book()
      await work({ bookingId })
      expect(await state(bookingId)).toBeUndefined()
      expect(await mappings(bookingId)).toEqual([])
      expect(provider.calls).toEqual([])
    })

    it('writes one private group copy rather than an event per seat', async () => {
      const groupSlotId = await bookGroup()
      await book({ ...invitee, name: 'Second Invitee', email: 'second@example.test' })
      expect(queued).toEqual([{ groupSlotId }])
      await work({ groupSlotId })
      await work({ groupSlotId })
      expect(provider.posts()).toHaveLength(1)
      expect(provider.posts()[0]?.body).toMatchObject({
        subject: 'Booking title',
        body: { contentType: 'text', content: '2' },
        sensitivity: 'private',
      })
      expect(JSON.stringify(provider.posts()[0]?.body)).not.toMatch(/Invitee|@example.test/)
      const copy = await db
        .selectFrom('group_slot_calendar_events')
        .select(['calendar_id', 'external_event_id', 'etag'])
        .where('group_slot_id', '=', groupSlotId)
        .executeTakeFirstOrThrow()
      expect(copy).toEqual({ calendar_id: selected, external_event_id: eventId, etag })
    })

    it('recovers the revision sent to Graph when group seats change during the lookup', async () => {
      const groupSlotId = await bookGroup()
      const initial = await db
        .selectFrom('group_slots')
        .select('count_revision')
        .where('id', '=', groupSlotId)
        .executeTakeFirstOrThrow()
      provider.controls.beforeLookup = async () => {
        provider.controls.beforeLookup = undefined
        await book({ ...invitee, name: 'Second Invitee', email: 'second@example.test' })
        return undefined
      }
      provider.controls.afterCreate = async () => graphError(503, 'ServiceUnavailable')
      await work({ groupSlotId })
      expect(provider.posts()[0]?.body).toMatchObject({ body: { content: '1' } })

      now += 30_000
      await work({ groupSlotId })
      const copy = await db
        .selectFrom('group_slot_calendar_events')
        .select(['external_event_id', 'count_revision'])
        .where('group_slot_id', '=', groupSlotId)
        .executeTakeFirstOrThrow()
      expect(copy).toEqual({ external_event_id: eventId, count_revision: initial.count_revision })
      expect(provider.posts()).toHaveLength(1)
    })

    it('records a pending group destination as removed after its account disconnects', async () => {
      const groupSlotId = await bookGroup()
      const readSlot = () =>
        db
          .selectFrom('group_slots')
          .select(['destination_calendar_id', 'microsoft_writeback'])
          .where('id', '=', groupSlotId)
          .executeTakeFirstOrThrow()
      expect(await readSlot()).toMatchObject({
        destination_calendar_id: selected,
        microsoft_writeback: { status: 'pending', attempts: 0 },
      })

      await disconnectCalendar(deps, await hostSession(), connectionId)
      await work({ groupSlotId })
      expect(await readSlot()).toMatchObject({
        destination_calendar_id: selected,
        microsoft_writeback: { status: 'failed', reason: 'calendar_removed' },
      })
      const enqueue = vi.fn(async (_payload: CalendarWritePayload) => {})
      await dispatch(enqueue)
      expect(enqueue).not.toHaveBeenCalled()
      expect(provider.calls).toEqual([])
    })

    it.each([
      ['removed at Graph', 404, 'calendar_removed'],
      ['marked removed by sync', 0, 'calendar_removed'],
      ['read-only calendar', 0, 'calendar_unavailable'],
      ['shared writable calendar', 0, 'calendar_unavailable'],
    ])(
      'surfaces a pinned destination %s without choosing a replacement',
      async (kind, status, reason) => {
        const bookingId = await book()
        await select(await calendar(connectionId, 'outlook-replacement'))
        if (status) provider.controls.beforeLookup = () => graphError(status, 'ErrorItemNotFound')
        else
          await db
            .updateTable('calendars')
            .set(
              kind === 'marked removed by sync'
                ? { sync_error: 'calendar_removed' }
                : { access_role: kind === 'shared writable calendar' ? 'writer' : 'reader' },
            )
            .where('id', '=', selected)
            .execute()
        await work({ bookingId })
        expect(await state(bookingId)).toMatchObject({ status: 'failed', reason })
        expect(await mappings(bookingId)).toEqual([])
        expect(await readMicrosoftWritebackSummary(db, [selected], now)).toEqual(
          new Map([[selected, { status: 'failed', reason }]]),
        )
        expect(provider.posts()).toEqual([])
      },
    )

    it('defers a throttled POST until Retry-After and uses the same transactionId', async () => {
      const bookingId = await book()
      provider.controls.beforeCreate = () =>
        graphError(429, 'TooManyRequests', { 'Retry-After': '120' })
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason: 'rate_limited',
        nextAttemptAt: new Date(now + 120_000).toISOString(),
      })
      expect(await mappings(bookingId)).toEqual([])
      provider.controls.beforeCreate = () => undefined
      const enqueue = vi.fn(async (_payload: CalendarWritePayload) => {})
      now += 119_999
      await dispatch(enqueue)
      await work({ bookingId })
      expect(enqueue).not.toHaveBeenCalled()
      expect(provider.posts()).toHaveLength(1)
      now++
      await dispatch(enqueue)
      expect(enqueue).toHaveBeenCalledExactlyOnceWith({ bookingId })
      await work({ bookingId })
      expect(provider.posts()).toHaveLength(2)
      expect(provider.posts()[1]?.transactionId).toBe(provider.posts()[0]?.transactionId)
      expect(provider.events.size).toBe(1)
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 2 })
    })

    it.each([
      [403, 'ErrorAccessDenied', 'permissions_missing'],
      [503, 'ServiceUnavailable', 'outcome_unknown'],
    ])(
      'recovers a booking blocked by %s on the same calendar after OAuth reconnect',
      async (status, code, reason) => {
        const bookingId = await book()
        provider.controls.beforeCreate = () => graphError(status, code)
        for (let attempt = 0; attempt < 6; attempt++) {
          await work({ bookingId })
          now += 15 * 60_000
        }
        expect(await state(bookingId)).toMatchObject({
          status: 'failed',
          reason,
        })
        await select(await calendar(connectionId, 'outlook-replacement'))
        provider.controls.beforeCreate = () => undefined
        provider.controls.reconnect = {
          account: `graph-account-${host.userId}`,
          calendars: ['outlook-selected', 'outlook-replacement'],
        }
        provider.token.mockReturnValueOnce(
          Response.json({
            access_token: 'fake-reconnected-access',
            refresh_token: 'fake-reconnected-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
            scope,
          }),
        )
        const session = await hostSession()
        const authorization = new URL(
          (await beginMicrosoftConnection(deps, session)).authorizationUrl,
        )
        const stateToken = authorization.searchParams.get('state')
        if (!stateToken) throw new Error('Expected an OAuth state')
        await expect(
          finishMicrosoftConnection(
            deps,
            session,
            new URLSearchParams({ state: stateToken, code: 'fake-code' }),
          ),
        ).resolves.toBe('connected')
        expect(await state(bookingId)).toMatchObject({ status: 'pending', attempts: 0 })

        const priorPosts = provider.posts().length
        await work({ bookingId })
        expect(provider.posts()).toHaveLength(priorPosts + 1)
        expect(new Set(provider.posts().map((call) => call.calendar))).toEqual(
          new Set(['outlook-selected']),
        )
        expect(new Set(provider.posts().map((call) => call.transactionId)).size).toBe(1)
        expect(await mappings(bookingId)).toEqual([
          { calendar_id: selected, external_event_id: eventId, etag },
        ])
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 1 })
      },
    )

    it.each([
      [409, 'ErrorConflict', 'event_conflict'],
      [412, 'ErrorIrresolvableConflict', 'event_conflict'],
      [503, 'ServiceUnavailable', 'provider_unavailable'],
      [0, 'TimeoutError', 'provider_unavailable'],
    ])('recovers a committed Graph create after %s by lookup', async (status, code, reason) => {
      const bookingId = await book()
      provider.controls.afterCreate = async () => {
        if (status === 0) throw new DOMException('Deadline elapsed after sending POST', code)
        return graphError(status, code)
      }
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason,
        attempts: 1,
        lookupOnly: true,
      })
      expect(await mappings(bookingId)).toEqual([])
      now += 30_000
      await work({ bookingId })
      expect(provider.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET'])
      expect(new Set(provider.calls.map((c) => c.transactionId)).size).toBe(1)
      expect(provider.events.size).toBe(1)
      expect(await mappings(bookingId)).toEqual([
        { calendar_id: selected, external_event_id: eventId, etag },
      ])
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 2 })
    })

    it('reposts a 503 that created nothing after settling, with a fresh lookup and the same key', async () => {
      const bookingId = await book()
      provider.controls.beforeCreate = () => graphError(503, 'ServiceUnavailable')
      await work({ bookingId })
      expect(provider.events.size).toBe(0)
      provider.controls.beforeCreate = undefined

      now += 29_999
      await work({ bookingId })
      expect(provider.calls.map((c) => c.method)).toEqual(['GET', 'POST'])

      now++
      await Promise.all([work({ bookingId }), work({ bookingId })])
      expect(provider.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST'])
      expect(new Set(provider.calls.map((c) => c.transactionId)).size).toBe(1)
      expect(provider.posts()[1]?.body).toEqual(provider.posts()[0]?.body)
      expect(provider.events.size).toBe(1)
      expect(await mappings(bookingId)).toEqual([
        { calendar_id: selected, external_event_id: eventId, etag },
      ])
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 2 })
    })

    it('creates exactly one copy after a worker stops between claim and provider I/O', async () => {
      const bookingId = await book()
      const beginTransaction = db.transaction.bind(db)
      const transaction = vi
        .spyOn(db, 'transaction')
        .mockImplementationOnce(beginTransaction)
        .mockImplementationOnce(() => {
          throw new Error('Worker stopped after claim')
        })
      try {
        await expect(writeMicrosoftCalendar(deps, { bookingId }, signal())).rejects.toThrow(
          'Worker stopped after claim',
        )
      } finally {
        transaction.mockRestore()
      }
      expect(await state(bookingId)).toMatchObject({ status: 'retrying', attempts: 1 })
      expect(provider.calls).toEqual([])

      now += 120_000
      await Promise.all([work({ bookingId }), work({ bookingId })])
      expect(provider.calls.map((c) => c.method)).toEqual(['GET', 'POST'])
      expect(provider.events.size).toBe(1)
      expect(await mappings(bookingId)).toEqual([
        { calendar_id: selected, external_event_id: eventId, etag },
      ])
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 2 })
    })

    it.each([1, 5])('recovers one copy after %i deduplicated replays', async (replays) => {
      const bookingId = await book()
      provider.controls.afterCreate = async () => graphError(503, 'ServiceUnavailable')
      await work({ bookingId })
      expect(provider.events.size).toBe(1)

      provider.controls.beforeLookup = () => Response.json({ value: [] })
      for (let attempt = 0; attempt < replays; attempt++) {
        now += 15 * 60_000
        await work({ bookingId })
      }
      expect(provider.events.size).toBe(1)
      expect(provider.posts()).toHaveLength(replays + 1)
      if (replays === 5) {
        expect(await state(bookingId)).toMatchObject({
          status: 'failed',
          reason: 'outcome_unknown',
        })
        await bookingCalendarRecoveryJob(deps, vi.fn(), vi.fn()).handler(
          { connectionId },
          { id: 'synthetic-recovery-job', signal: signal(), attempt: 1 },
        )
      }

      now += 60_000
      provider.controls.beforeLookup = undefined
      await work({ bookingId })
      expect(provider.calls.at(-1)?.method).toBe('GET')
      expect(provider.posts()).toHaveLength(replays + 1)
      expect(new Set(provider.calls.map((c) => c.transactionId)).size).toBe(1)
      expect(await mappings(bookingId)).toEqual([
        { calendar_id: selected, external_event_id: eventId, etag },
      ])
    })

    it.each(['booking', 'connection'])(
      'bounds failed creates and resets on operator redispatch by %s',
      async (target) => {
        const bookingId = await book()
        provider.controls.beforeCreate = () => graphError(500, 'InternalServerError')
        for (let attempt = 0; attempt < 6; attempt++) {
          await work({ bookingId })
          if (attempt < 5) now += 15 * 60_000
        }
        await work({ bookingId })
        expect(provider.calls.filter((c) => c.method === 'GET')).toHaveLength(6)
        expect(provider.posts()).toHaveLength(6)
        expect(await mappings(bookingId)).toEqual([])
        expect(await state(bookingId)).toMatchObject({
          status: 'failed',
          reason: 'outcome_unknown',
          attempts: 6,
        })
        const enqueue = vi.fn(async (_payload: CalendarWritePayload) => {})
        await dispatch(enqueue)
        expect(enqueue).not.toHaveBeenCalled()

        provider.controls.beforeCreate = undefined
        if (target === 'booking') {
          await redispatchBookingCalendar(
            db,
            {
              async enqueue(_name, payload) {
                queued.push(payload)
                return null
              },
            },
            bookingId,
            now,
          )
        } else {
          await bookingCalendarRecoveryJob(deps, vi.fn(), vi.fn()).handler(
            { connectionId },
            { id: 'synthetic-recovery-job', signal: signal(), attempt: 1 },
          )
        }
        expect(await state(bookingId)).toMatchObject({ status: 'pending', attempts: 0 })
        await work({ bookingId })
        expect(provider.posts()).toHaveLength(6)
        now += 30_000
        await work({ bookingId })
        expect(provider.calls.slice(-2).map((c) => c.method)).toEqual(['GET', 'POST'])
        expect(new Set(provider.calls.map((c) => c.transactionId)).size).toBe(1)
        expect(provider.events.size).toBe(1)
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 1 })
      },
    )

    it.each([
      [401, 'InvalidAuthenticationToken', 'needs_reauth'],
      [403, 'ErrorAccessDenied', 'permissions_missing'],
      [0, 'invalid_grant', 'needs_reauth'],
      [0, 'read-only-grant', 'permissions_missing'],
    ])('surfaces revoked or missing consent (%s %s)', async (status, code, reason) => {
      const bookingId = await book()
      if (status) provider.controls.beforeCreate = () => graphError(status, code)
      else
        await db
          .updateTable('calendar_connections')
          .set(
            code === 'invalid_grant'
              ? { credentials: credentials(host.userId, now - 1000) }
              : { scopes: ['Calendars.ReadBasic'] },
          )
          .where('id', '=', connectionId)
          .execute()
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({ status: 'failed', reason })
      expect(await mappings(bookingId)).toEqual([])
      expect(provider.token).toHaveBeenCalledTimes(code === 'invalid_grant' ? 1 : 0)
      expect(provider.posts()).toHaveLength(status ? 1 : 0)
      const connection = await db
        .selectFrom('calendar_connections')
        .select(['status', 'last_error'])
        .where('id', '=', connectionId)
        .executeTakeFirstOrThrow()
      if (reason === 'needs_reauth')
        expect(connection).toEqual({ status: 'needs_reauth', last_error: 'needs_reauth' })
    })
  },
)
