import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  getHostBooking,
  getManagedBooking,
  getPublicEventType,
  type PublicContext,
  readTeamsMeetingLocations,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
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
  recordMicrosoftBookingDestinations,
  writeMicrosoftCalendar,
} from './microsoft-writeback.ts'
import { TEST_CALENDAR_KEY } from './testing.ts'

const NOW = Temporal.Instant.from('2030-03-04T08:00:00Z')
const START = Temporal.Instant.from('2030-03-06T10:00:00Z')
const NEXT = Temporal.Instant.from('2030-03-07T11:00:00Z')
const etag = 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJB"'
const updatedEtag = 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJC"'
const outlookEtag = 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJD"'
const eventId = 'AAMkAGViNDU7zAAAAAGtlAAAMh8kAAA='
const teamsJoinUrl = 'https://teams.microsoft.com/l/meetup-join/synthetic-booking/0'
const scope = 'Calendars.ReadWrite'
const invitee = { name: 'Private Invitee', email: 'invitee@example.test', timeZone: 'UTC' }
const signal = () => new AbortController().signal

type GraphTime = { dateTime: string; timeZone: 'UTC' }
type EventTimes = {
  start: GraphTime
  end: GraphTime
  body?: { contentType: 'text'; content: string }
}
type GraphEvent = EventTimes & {
  id: string
  '@odata.etag': string
  transactionId: string
  type: 'singleInstance'
  isCancelled: false
  attendees: { emailAddress: { address: string }; type: 'required' }[]
  isOnlineMeeting?: true
  onlineMeetingProvider?: 'teamsForBusiness'
  onlineMeeting?: { joinUrl: string }
}
type Call = {
  calendar: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  transactionId?: string
  id?: string
  ifMatch?: string | null
  body?: unknown
}

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
  const capabilityReads: string[] = []
  const events = new Map<string, GraphEvent>()
  const controls: {
    allowedOnlineMeetingProviders: string[]
    beforeCapabilities?: () => Response | undefined | Promise<Response | undefined>
    beforeLookup?: (calendar: string) => Response | undefined | Promise<Response | undefined>
    beforeCreate?: () => Response | undefined
    afterCreate?: () => Promise<Response | undefined>
    beforeRead?: () => Response | undefined
    beforePatch?: () => Response | undefined
    beforeDelete?: () => Response | undefined
    afterPatch?: () => Response | undefined | Promise<Response | undefined>
    omitTeamsJoinUrl?: boolean
    omitTeamsInPatchResponse?: boolean
    reconnect?: { account: string; calendars: string[]; sharedCalendars?: string[] }
  } = { allowedOnlineMeetingProviders: ['teamsForBusiness'] }
  const client = createMicrosoftCalendarClient(
    { clientId: 'fake-client', clientSecret: 'fake-secret', publicUrl: 'https://hourmere.test' },
    async (input, init) => {
      const url = new URL(String(input))
      if (
        url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token' &&
        init?.method === 'POST'
      )
        return token()
      if (url.origin === 'https://graph.microsoft.com') {
        if (controls.reconnect && url.pathname === '/oidc/userinfo')
          return Response.json({ sub: controls.reconnect.account })
        if (url.pathname === '/v1.0/me/calendars')
          return Response.json({
            value: (controls.reconnect?.calendars ?? ['outlook-selected']).map((id) => ({
              id,
              name: id,
              canEdit: true,
              canShare: !controls.reconnect?.sharedCalendars?.includes(id),
              canViewPrivateItems: true,
            })),
          })
        const calendarSegment = /^\/v1\.0\/me\/calendars\/([^/]+)$/u.exec(url.pathname)?.[1]
        if (calendarSegment && !init?.method) {
          const id = decodeURIComponent(calendarSegment)
          capabilityReads.push(id)
          return (
            (await controls.beforeCapabilities?.()) ??
            Response.json({
              id,
              allowedOnlineMeetingProviders: controls.allowedOnlineMeetingProviders,
            })
          )
        }
      }
      const [, segment, eventSegment] =
        /^\/v1\.0\/me\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/u.exec(url.pathname) ?? []
      if (url.origin !== 'https://graph.microsoft.com' || !segment)
        throw new Error('Unexpected synthetic Graph endpoint')
      const calendar = decodeURIComponent(segment)
      if (eventSegment) {
        const id = decodeURIComponent(eventSegment)
        const saved = [...events].find(
          ([key, value]) =>
            value.id === id && key === JSON.stringify([calendar, value.transactionId]),
        )
        const [key, event] = saved ?? []
        const method = init?.method ?? 'GET'
        if (method !== 'GET' && method !== 'PATCH' && method !== 'DELETE')
          throw new Error('Unexpected synthetic Graph event method')
        const ifMatch = new Headers(init?.headers).get('If-Match')
        const body = init?.body ? (JSON.parse(String(init.body)) as EventTimes) : undefined
        calls.push({ calendar, method, id, transactionId: event?.transactionId, ifMatch, body })
        const failure =
          method === 'PATCH'
            ? controls.beforePatch?.()
            : method === 'DELETE'
              ? controls.beforeDelete?.()
              : controls.beforeRead?.()
        if (failure) return failure
        if (!key || !event) return graphError(404, 'ErrorItemNotFound')
        if (method === 'GET') return Response.json(event)
        if (ifMatch !== event['@odata.etag']) return graphError(412, 'ErrorIrresolvableConflict')
        if (method === 'DELETE') {
          events.delete(key)
          return new Response(null, { status: 204 })
        }
        const updated = { ...event, ...body, '@odata.etag': updatedEtag }
        events.set(key, updated)
        if (controls.omitTeamsInPatchResponse)
          return Response.json({ id, '@odata.etag': updatedEtag })
        return (await controls.afterPatch?.()) ?? Response.json(updated)
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const transactionId = String(body.transactionId)
        calls.push({ calendar, method: 'POST', transactionId, body })
        const failure = controls.beforeCreate?.()
        if (failure) return failure
        const key = JSON.stringify([calendar, transactionId])
        if (events.has(key)) return graphError(409, 'ErrorDuplicateTransactionId')
        const event: GraphEvent = {
          id: events.size ? `outlook-${transactionId}` : eventId,
          '@odata.etag': etag,
          transactionId,
          type: 'singleInstance',
          isCancelled: false,
          attendees: [],
          start: body.start,
          end: body.end,
          ...(body.body && { body: body.body }),
          ...(body.isOnlineMeeting === true &&
            body.onlineMeetingProvider === 'teamsForBusiness' && {
              isOnlineMeeting: true,
              onlineMeetingProvider: 'teamsForBusiness',
              ...(!controls.omitTeamsJoinUrl && { onlineMeeting: { joinUrl: teamsJoinUrl } }),
            }),
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
      const failure = await controls.beforeLookup?.(calendar)
      if (failure) return failure
      const event = events.get(JSON.stringify([calendar, transactionId]))
      const fields = url.searchParams.get('$select')?.split(',') ?? []
      return Response.json({
        value: event
          ? [
              Object.fromEntries(
                Object.entries(event).filter(
                  ([name]) => name === '@odata.etag' || fields.includes(name),
                ),
              ),
            ]
          : [],
      })
    },
    now,
  )
  return {
    client,
    controls,
    calls,
    capabilityReads,
    token,
    events,
    posts: () => calls.filter((c) => c.method === 'POST'),
  }
}

function requireToken(token: string | null | undefined) {
  if (!token) throw new Error('Expected a booking management token')
  return token
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

    function context(): PublicContext {
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
      return {
        db,
        now: () => Temporal.Instant.fromEpochMilliseconds(now),
        notify: async (trx, event) => {
          if (!('requestId' in event)) await notify(trx, event)
        },
      }
    }

    function create(person = invitee, idempotencyKey?: string, start = START) {
      return createPublicBooking(context(), {
        handle: host.handle,
        slug: 'outlook-booking',
        start,
        invitee: person,
        idempotencyKey,
      })
    }

    async function book(person = invitee, idempotencyKey?: string) {
      return (await create(person, idempotencyKey)).booking.id
    }

    function chooseTeams() {
      return db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'microsoft_teams' }) })
        .where('id', '=', eventTypeId)
        .execute()
    }

    function setGroupType() {
      return db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 3 })
        .where('id', '=', eventTypeId)
        .execute()
    }

    async function slotFor(bookingId: string) {
      const slot = await db
        .selectFrom('bookings')
        .select('group_slot_id')
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow()
      if (!slot.group_slot_id) throw new Error('Expected a group occurrence')
      return slot.group_slot_id
    }

    async function bookGroup() {
      await setGroupType()
      return slotFor(await book())
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
    const busy = () =>
      db
        .selectFrom('calendar_busy')
        .select(sql<Date>`lower(period)`.as('start'))
        .where('calendar_id', '=', selected)
        .where('external_event_id', '=', eventId)
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
    const patches = () => provider.calls.filter((call) => call.method === 'PATCH')
    const deletes = () => provider.calls.filter((call) => call.method === 'DELETE')
    async function settleCancellationConflict(bookingId: string) {
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason: 'event_conflict',
        attempts: 1,
      })
      for (let attempt = 1; attempt < 6; attempt++) {
        now += 15 * 60_000
        await work({ bookingId })
      }
      expect(await state(bookingId)).toMatchObject({
        status: 'failed',
        reason: 'event_conflict',
        attempts: 6,
      })
    }

    it.each([false, true])(
      'updates the pinned copy across DST and deletes it on cancellation (Teams: %s)',
      async (teams) => {
        if (teams) await chooseTeams()
        // The same Los Angeles wall time becomes an hour earlier in UTC after the DST change.
        await db
          .updateTable('schedules')
          .set({ time_zone: 'America/Los_Angeles' })
          .where('user_id', '=', host.userId)
          .execute()
        const beforeDst = Temporal.ZonedDateTime.from('2030-03-08T09:00-08:00[America/Los_Angeles]')
        const afterDst = beforeDst.add({ days: 3 })
        const created = await create(invitee, undefined, beforeDst.toInstant())
        const bookingId = created.booking.id
        await work({ bookingId })
        expect(provider.posts()[0]?.body).toMatchObject({
          start: { dateTime: '2030-03-08T17:00:00.000', timeZone: 'UTC' },
          isOnlineMeeting: teams,
        })
        expect(provider.capabilityReads).toEqual(teams ? ['outlook-selected'] : [])
        if (teams) {
          const body = provider.posts()[0]?.body
          expect(body).toMatchObject({
            onlineMeetingProvider: 'teamsForBusiness',
            sensitivity: 'private',
          })
          expect(body).not.toHaveProperty('attendees')
          expect(body).not.toHaveProperty('location')
          expect(JSON.stringify(body)).not.toContain(invitee.email)
          expect(await state(bookingId)).toMatchObject({ teamsStatus: 'ready', teamsJoinUrl })
          const managed = await getManagedBooking(context(), requireToken(created.manageToken))
          expect(managed.location).toEqual({
            kind: 'microsoft_teams',
            status: 'ready',
            url: teamsJoinUrl,
          })
          expect(
            (await getHostBooking({ ...context(), principal: await hostSession() }, bookingId))
              .location,
          ).toEqual(managed.location)
          expect(
            JSON.stringify(
              await getPublicEventType(context(), { handle: host.handle, slug: 'outlook-booking' }),
            ),
          ).not.toContain(teamsJoinUrl)
          expect(
            JSON.stringify([...(await readMicrosoftWritebackSummary(db, [selected], now))]),
          ).not.toContain(teamsJoinUrl)
        }

        await db
          .updateTable('calendars')
          .set({
            sync_state: JSON.stringify({ microsoftPending: { position: 1 } }),
          })
          .where('id', '=', selected)
          .execute()
        await db
          .insertInto('calendar_microsoft_changes')
          .values({
            calendar_id: selected,
            position: 0,
            external_event_id: eventId,
            removes_series: false,
            is_exception: false,
          })
          .execute()
        await select(await calendar(connectionId, 'outlook-replacement'))
        provider.controls.omitTeamsInPatchResponse = teams
        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: afterDst.toInstant(),
        })
        expect(moved.booking.id).not.toBe(bookingId)
        expect(queued).toEqual([{ bookingId }, { bookingId }])
        await Promise.all([work({ bookingId }), work({ bookingId: moved.booking.id })])
        await work({ bookingId })
        expect(provider.posts()).toHaveLength(1)
        expect(patches()).toEqual([
          expect.objectContaining({
            calendar: 'outlook-selected',
            id: eventId,
            ifMatch: etag,
            body: {
              start: { dateTime: '2030-03-11T16:00:00.000', timeZone: 'UTC' },
              end: { dateTime: '2030-03-11T16:30:00.000', timeZone: 'UTC' },
            },
          }),
        ])
        expect(provider.events.size).toBe(1)
        expect(await mappings(bookingId)).toEqual([])
        expect(await mappings(moved.booking.id)).toEqual([
          { calendar_id: selected, external_event_id: eventId, etag: updatedEtag },
        ])
        expect(await busy()).toEqual([{ start: new Date(afterDst.epochMilliseconds) }])
        if (teams) {
          expect(await state(bookingId)).toMatchObject({ teamsStatus: 'ready', teamsJoinUrl })
          expect(
            (await getManagedBooking(context(), requireToken(moved.manageToken))).location,
          ).toEqual({ kind: 'microsoft_teams', status: 'ready', url: teamsJoinUrl })
          expect(
            (await getManagedBooking(context(), requireToken(created.manageToken))).location,
          ).toEqual({ kind: 'microsoft_teams' })
        }
        expect(
          await db
            .selectFrom('calendar_microsoft_changes')
            .select('position')
            .where('calendar_id', '=', selected)
            .execute(),
        ).toEqual([])
        expect(
          await db
            .selectFrom('calendars')
            .select('sync_state')
            .where('id', '=', selected)
            .executeTakeFirstOrThrow(),
        ).toEqual({ sync_state: {} })

        await cancelManagedBooking(context(), requireToken(moved.manageToken))
        expect(queued).toEqual([{ bookingId }, { bookingId }, { bookingId }])
        await Promise.all([work({ bookingId }), work({ bookingId: moved.booking.id })])
        await work({ bookingId })
        expect(deletes()).toEqual([
          expect.objectContaining({
            calendar: 'outlook-selected',
            id: eventId,
            ifMatch: updatedEtag,
          }),
        ])
        expect(provider.events.size).toBe(0)
        expect(await mappings(moved.booking.id)).toEqual([])
        expect(await busy()).toEqual([])
        const cancelled = await state(bookingId)
        expect(cancelled).toMatchObject({ status: 'succeeded' })
        if (teams) {
          expect(
            (await getManagedBooking(context(), requireToken(moved.manageToken))).location,
          ).toEqual({ kind: 'microsoft_teams' })
          expect(
            (await readTeamsMeetingLocations(db, [moved.booking])).get(moved.booking.id),
          ).toEqual({ kind: 'microsoft_teams', status: 'ready', url: teamsJoinUrl })
        } else expect(cancelled).not.toHaveProperty('teamsJoinUrl')
      },
    )

    it.each([false, true])(
      'removes a copy cancelled before the in-flight create finishes (lost response: %s)',
      async (lostResponse) => {
        const created = await create()
        const bookingId = created.booking.id
        const sent = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        provider.controls.afterCreate = async () => {
          sent.resolve()
          await release.promise
          return lostResponse ? graphError(503, 'ServiceUnavailable') : undefined
        }
        const writing = work({ bookingId })
        try {
          await Promise.race([sent.promise, writing])
          expect(provider.events.size).toBe(1)
          await cancelManagedBooking(context(), requireToken(created.manageToken))
          expect(queued).toEqual([{ bookingId }, { bookingId }])
          await Promise.all(queued.slice(1).map(work))
          expect(deletes()).toHaveLength(0)
        } finally {
          release.resolve()
          await writing
        }
        if (lostResponse) {
          now += 30_000
          await dispatch(work)
        }
        expect(provider.posts()).toHaveLength(1)
        expect(deletes()).toHaveLength(1)
        expect(provider.events.size).toBe(0)
        expect(await mappings(bookingId)).toEqual([])
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
      },
    )

    it.each([false, true])(
      'reconciles at most two writes before yielding to the queued revision (Teams: %s)',
      async (teams) => {
        if (teams) await chooseTeams()
        const created = await create()
        const bookingId = created.booking.id
        provider.controls.afterCreate = async () => {
          const moved = await rescheduleManagedBooking(
            context(),
            requireToken(created.manageToken),
            {
              start: NEXT,
            },
          )
          provider.controls.afterPatch = async () => {
            await cancelManagedBooking(context(), requireToken(moved.manageToken))
            return undefined
          }
          return undefined
        }

        await work({ bookingId })

        expect(provider.capabilityReads).toEqual(teams ? ['outlook-selected'] : [])
        expect(provider.posts()).toHaveLength(1)
        expect(patches()).toHaveLength(1)
        expect(deletes()).toHaveLength(0)
        expect(await state(bookingId)).toMatchObject({ status: 'pending' })
        expect(queued).toEqual([{ bookingId }, { bookingId }, { bookingId }])

        await work({ bookingId })
        expect(deletes()).toHaveLength(1)
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
      },
    )

    it.each([
      { teams: false, lostResponse: false },
      { teams: false, lostResponse: true },
      { teams: true, lostResponse: false },
      { teams: true, lostResponse: true },
    ])(
      'moves a copy rescheduled before the in-flight create finishes (Teams: $teams, lost response: $lostResponse)',
      async ({ teams, lostResponse }) => {
        if (teams) await chooseTeams()
        const created = await create()
        const bookingId = created.booking.id
        const sent = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        provider.controls.afterCreate = async () => {
          sent.resolve()
          await release.promise
          return lostResponse ? graphError(503, 'ServiceUnavailable') : undefined
        }
        const writing = work({ bookingId })
        let successor: string
        try {
          await Promise.race([sent.promise, writing])
          expect(provider.events.size).toBe(1)
          const moved = await rescheduleManagedBooking(
            context(),
            requireToken(created.manageToken),
            {
              start: NEXT,
            },
          )
          successor = moved.booking.id
          expect(queued).toEqual([{ bookingId }, { bookingId }])
          await Promise.all(queued.slice(1).map(work))
          expect(patches()).toHaveLength(0)
        } finally {
          release.resolve()
          await writing
        }
        if (lostResponse) {
          expect(await state(bookingId)).toMatchObject({ status: 'retrying', lookupOnly: true })
          now += 30_000
          await dispatch(work)
        }
        await work({ bookingId: successor })
        expect(provider.posts()).toHaveLength(1)
        expect(patches()).toHaveLength(1)
        expect([...provider.events.values()]).toMatchObject([
          {
            id: eventId,
            start: { dateTime: '2030-03-07T11:00:00.000', timeZone: 'UTC' },
            end: { dateTime: '2030-03-07T11:30:00.000', timeZone: 'UTC' },
          },
        ])
        expect(await mappings(bookingId)).toEqual([])
        expect(await mappings(successor)).toMatchObject([{ external_event_id: eventId }])
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
        if (teams)
          expect(await state(bookingId)).toMatchObject({ teamsStatus: 'ready', teamsJoinUrl })
      },
    )

    it('reschedules after an Outlook ETag-only change using the freshly read tag', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      const original = [...provider.events][0]
      if (!original) throw new Error('Expected the first Graph copy')
      const [key, event] = original
      provider.events.set(key, { ...event, '@odata.etag': outlookEtag })

      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      await work({ bookingId })
      expect(patches()).toMatchObject([{ id: eventId, ifMatch: outlookEtag }])
      expect(provider.events.get(key)).toMatchObject({
        start: { dateTime: '2030-03-07T11:00:00.000', timeZone: 'UTC' },
        end: { dateTime: '2030-03-07T11:30:00.000', timeZone: 'UTC' },
      })
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
      expect(await mappings(moved.booking.id)).toMatchObject([{ external_event_id: eventId }])
    })

    it('rejects an Outlook end-time edit when the stored receipt has no ETag', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      await db
        .updateTable('booking_calendar_events')
        .set({ etag: null })
        .where('booking_id', '=', bookingId)
        .where('calendar_id', '=', selected)
        .execute()
      const original = [...provider.events][0]
      if (!original) throw new Error('Expected the first Graph copy')
      const [key, event] = original
      const end = { dateTime: '2030-03-06T10:45:00.000', timeZone: 'UTC' } as const
      provider.events.set(key, { ...event, '@odata.etag': outlookEtag, end })

      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      await work({ bookingId })
      expect(patches()).toHaveLength(0)
      expect(provider.events.get(key)?.end).toEqual(end)
      expect(await state(bookingId)).toMatchObject({ status: 'failed', reason: 'event_conflict' })
      expect(await mappings(moved.booking.id)).toEqual([])
    })

    it.each([false, true])(
      'rechecks the Outlook copy once after PATCH gets 412 (time edited: %s)',
      async (timeEdited) => {
        const created = await create()
        const bookingId = created.booking.id
        await work({ bookingId })
        const original = [...provider.events][0]
        if (!original) throw new Error('Expected the first Graph copy')
        const [key, event] = original
        const end = timeEdited
          ? { dateTime: '2030-03-06T10:45:00.000', timeZone: 'UTC' as const }
          : event.end
        provider.controls.beforePatch = () => {
          provider.controls.beforePatch = undefined
          provider.events.set(key, { ...event, '@odata.etag': outlookEtag, end })
          return graphError(412, 'ErrorIrresolvableConflict')
        }

        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: NEXT,
        })
        await work({ bookingId })
        expect(
          provider.calls.filter((call) => call.method === 'GET' && call.id === eventId),
        ).toHaveLength(2)
        expect(patches().map((call) => call.ifMatch)).toEqual(
          timeEdited ? [etag] : [etag, outlookEtag],
        )
        if (timeEdited) {
          expect(provider.events.get(key)?.end).toEqual(end)
          expect(await state(bookingId)).toMatchObject({
            status: 'failed',
            reason: 'event_conflict',
          })
          expect(await mappings(moved.booking.id)).toEqual([])
        } else {
          expect(provider.events.get(key)).toMatchObject({
            start: { dateTime: '2030-03-07T11:00:00.000', timeZone: 'UTC' },
            end: { dateTime: '2030-03-07T11:30:00.000', timeZone: 'UTC' },
          })
          expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
          expect(await mappings(moved.booking.id)).toMatchObject([{ external_event_id: eventId }])
        }
      },
    )

    it('stops after one retry when Outlook keeps returning 412', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      provider.controls.beforePatch = () => graphError(412, 'ErrorIrresolvableConflict')

      await work({ bookingId })
      expect(
        provider.calls.filter((call) => call.method === 'GET' && call.id === eventId),
      ).toHaveLength(2)
      expect(patches()).toHaveLength(2)
      expect(await state(bookingId)).toMatchObject({ status: 'failed', reason: 'event_conflict' })
      expect(await mappings(moved.booking.id)).toEqual([])
    })

    it.each(['edited', 'deleted', 'turned into a meeting'])(
      'surfaces an Outlook change (%s) as a reschedule conflict and reconciles cancellation',
      async (change) => {
        const created = await create()
        const bookingId = created.booking.id
        await work({ bookingId })
        const original = [...provider.events][0]
        if (!original) throw new Error('Expected the first Graph copy')
        const [key, event] = original
        if (change === 'deleted') provider.events.delete(key)
        else
          provider.events.set(key, {
            ...event,
            '@odata.etag': updatedEtag,
            start: { dateTime: '2030-03-06T12:00:00.000', timeZone: 'UTC' },
            ...(change === 'turned into a meeting' && {
              attendees: [
                { emailAddress: { address: 'outlook-guest@example.test' }, type: 'required' },
              ],
            }),
          })
        provider.controls.reconnect = {
          account: `graph-account-${host.userId}`,
          calendars: ['outlook-selected'],
        }
        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: NEXT,
        })
        await work({ bookingId })
        expect(await state(bookingId)).toMatchObject({ reason: 'event_conflict' })
        expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId, etag }])
        expect(await mappings(moved.booking.id)).toEqual([])
        expect(provider.posts()).toHaveLength(1)

        await cancelManagedBooking(context(), requireToken(moved.manageToken))
        await work({ bookingId })
        if (change === 'turned into a meeting') {
          await settleCancellationConflict(bookingId)
          expect(deletes().some((call) => call.ifMatch === updatedEtag)).toBe(false)
          expect(provider.events.size).toBe(1)
        } else {
          expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
          expect(provider.events.size).toBe(0)
          expect(await mappings(bookingId)).toEqual([])
        }
      },
    )

    it('defers a throttled reschedule and accepts a lost PATCH response without repeating the update', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      provider.controls.beforePatch = () =>
        graphError(429, 'TooManyRequests', { 'Retry-After': '120' })
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason: 'rate_limited',
        nextAttemptAt: new Date(now + 120_000).toISOString(),
      })
      provider.controls.beforePatch = undefined
      provider.controls.afterPatch = () => graphError(503, 'ServiceUnavailable')
      now += 119_999
      await work({ bookingId })
      expect(patches()).toHaveLength(1)

      now++
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason: 'provider_unavailable',
      })
      now += 15 * 60_000
      await work({ bookingId })
      expect(provider.posts()).toHaveLength(1)
      expect(patches()).toHaveLength(2)
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
      expect(await mappings(moved.booking.id)).toMatchObject([{ etag: updatedEtag }])
    })

    it('retains a lost PATCH projection through a throttled preflight for a later successor', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      provider.controls.afterPatch = () => graphError(503, 'ServiceUnavailable')
      await work({ bookingId })
      const finalTime = NEXT.add({ hours: 1 })
      const successor = await rescheduleManagedBooking(context(), requireToken(moved.manageToken), {
        start: finalTime,
      })
      provider.controls.afterPatch = undefined
      provider.controls.beforeRead = () =>
        graphError(429, 'TooManyRequests', { 'Retry-After': '120' })
      now += 30_000
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({ status: 'retrying', reason: 'rate_limited' })
      expect(patches()).toHaveLength(1)

      provider.controls.beforeRead = undefined
      now += 120_000
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
      expect(await mappings(successor.booking.id)).toMatchObject([{ external_event_id: eventId }])
      expect(provider.posts()).toHaveLength(1)
      expect(patches()).toHaveLength(2)
      expect([...provider.events.values()]).toEqual([
        expect.objectContaining({
          start: { dateTime: '2030-03-07T12:00:00.000', timeZone: 'UTC' },
        }),
      ])
    })

    it.each([false, true])(
      'keeps the POST payload stable through ambiguous create replay and successive moves (Teams: %s)',
      async (teams) => {
        if (teams) await chooseTeams()
        const created = await create()
        const bookingId = created.booking.id
        provider.controls.beforeCreate = () => graphError(503, 'ServiceUnavailable')
        await work({ bookingId })
        provider.controls.allowedOnlineMeetingProviders = []
        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: NEXT,
        })
        provider.controls.beforeCreate = undefined
        provider.controls.afterCreate = async () => graphError(503, 'ServiceUnavailable')
        now += 30_000
        await work({ bookingId })
        const finalTime = NEXT.add({ hours: 1 })
        const successor = await rescheduleManagedBooking(
          context(),
          requireToken(moved.manageToken),
          {
            start: finalTime,
          },
        )
        provider.controls.afterCreate = undefined
        now += 30_000
        await work({ bookingId })

        expect(provider.posts()).toHaveLength(2)
        expect(provider.posts()[1]?.body).toEqual(provider.posts()[0]?.body)
        expect(provider.posts()[0]?.body).toMatchObject({ isOnlineMeeting: teams })
        expect(provider.capabilityReads).toEqual(teams ? ['outlook-selected'] : [])
        expect(patches()).toHaveLength(1)
        expect(provider.events.size).toBe(1)
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
        expect(await mappings(successor.booking.id)).toMatchObject([{ external_event_id: eventId }])
        if (teams)
          expect(await state(bookingId)).toMatchObject({ teamsStatus: 'ready', teamsJoinUrl })
      },
    )

    it('retains a cancelled copy for follow-up if the host loses ownership of its calendar', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      const calls = provider.calls.length
      await db
        .updateTable('calendars')
        .set({ access_role: 'writer' })
        .where('id', '=', selected)
        .execute()
      await cancelManagedBooking(context(), requireToken(created.manageToken))
      await work({ bookingId })
      expect(provider.calls).toHaveLength(calls)
      expect(provider.events.size).toBe(1)
      expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
      expect(await state(bookingId)).toMatchObject({
        status: 'failed',
        reason: 'calendar_unavailable',
      })
    })

    it.each([
      [401, 'InvalidAuthenticationToken', 'needs_reauth'],
      [403, 'ErrorAccessDenied', 'permissions_missing'],
    ])(
      'reports a successor cancellation blocked by Graph %s after the original time passes',
      async (status, code, reason) => {
        const created = await create()
        const bookingId = created.booking.id
        await work({ bookingId })
        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: NEXT,
        })
        await work({ bookingId })
        now = START.epochMilliseconds + 1_000
        await db
          .updateTable('calendar_connections')
          .set({ credentials: credentials(host.userId, now + 86_400_000) })
          .where('id', '=', connectionId)
          .execute()
        provider.controls.beforeDelete = () => graphError(status, code)
        await cancelManagedBooking(context(), requireToken(moved.manageToken))
        await work({ bookingId })
        await work({ bookingId })
        expect(deletes()).toHaveLength(1)
        expect(provider.events.size).toBe(1)
        expect(await mappings(moved.booking.id)).toMatchObject([{ external_event_id: eventId }])
        expect(await state(bookingId)).toMatchObject({ status: 'failed', reason })
        expect(await readMicrosoftWritebackSummary(db, [selected], now)).toEqual(
          new Map([[selected, { status: 'failed', reason }]]),
        )
        if (status === 401)
          expect(
            await db
              .selectFrom('calendar_connections')
              .select(['status', 'last_error'])
              .where('id', '=', connectionId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ status: 'needs_reauth', last_error: 'needs_reauth' })
      },
    )

    it('treats a DELETE 404 as success once the booking marker is absent', async () => {
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      provider.controls.reconnect = {
        account: `graph-account-${host.userId}`,
        calendars: ['outlook-selected'],
      }
      provider.controls.beforeDelete = () => {
        provider.events.clear()
        return graphError(404, 'ErrorItemNotFound')
      }
      await cancelManagedBooking(context(), requireToken(created.manageToken))
      await work({ bookingId })
      expect(deletes()).toHaveLength(1)
      expect(await mappings(bookingId)).toEqual([])
      expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
    })

    it.each(['owned', 'shared', 'shared private'])(
      'reconciles cancellation after Outlook moves the copy to another %s calendar',
      async (role) => {
        const created = await create()
        const bookingId = created.booking.id
        await work({ bookingId })
        const other = 'outlook-other-calendar'
        await calendar(connectionId, other)
        provider.controls.reconnect = {
          account: `graph-account-${host.userId}`,
          calendars: ['outlook-selected', other],
          sharedCalendars: role === 'owned' ? [] : [other],
        }
        const original = [...provider.events][0]
        if (!original) throw new Error('Expected the first Graph copy')
        const [key, event] = original
        provider.events.delete(key)
        const movedId = `${eventId}-after-move`
        provider.events.set(JSON.stringify([other, event.transactionId]), {
          ...event,
          id: movedId,
          '@odata.etag': updatedEtag,
        })

        const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
          start: NEXT,
        })
        await work({ bookingId })
        expect(await state(bookingId)).toMatchObject({ reason: 'event_conflict' })
        expect(provider.posts()).toHaveLength(1)
        expect(patches().every((call) => call.calendar === 'outlook-selected')).toBe(true)

        if (role === 'shared private')
          provider.controls.beforeLookup = (calendar) =>
            calendar === other ? graphError(404, 'ErrorItemNotFound') : undefined
        await cancelManagedBooking(context(), requireToken(moved.manageToken))
        await work({ bookingId })
        if (role === 'owned') {
          expect(deletes().at(-1)).toMatchObject({
            calendar: other,
            id: movedId,
            ifMatch: updatedEtag,
          })
          expect(provider.events.size).toBe(0)
          expect(await state(bookingId)).toMatchObject({ status: 'succeeded' })
          expect(await mappings(bookingId)).toEqual([])
        } else {
          await settleCancellationConflict(bookingId)
          expect(deletes().some((call) => call.calendar === other)).toBe(false)
          expect(provider.events.size).toBe(1)
          expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
        }
      },
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
        isOnlineMeeting: false,
      })
      expect(provider.capabilityReads).toEqual([])
      expect(body).not.toHaveProperty('onlineMeetingProvider')
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
      expect(provider.capabilityReads).toEqual([])
    })

    it('updates one private group copy until the last seat is cancelled', async () => {
      await setGroupType()
      const first = await create()
      const groupSlotId = await slotFor(first.booking.id)
      const second = await create({
        ...invitee,
        name: 'Second Invitee',
        email: 'second@example.test',
      })
      expect(queued.length).toBeGreaterThan(0)
      expect(
        queued.every((payload) => 'groupSlotId' in payload && payload.groupSlotId === groupSlotId),
      ).toBe(true)
      await work({ groupSlotId })
      await work({ groupSlotId })
      expect(provider.posts()).toHaveLength(1)
      expect(provider.posts()[0]?.body).toMatchObject({
        subject: 'Booking title',
        body: { contentType: 'text', content: '2' },
        sensitivity: 'private',
        isOnlineMeeting: false,
      })
      expect(provider.capabilityReads).toEqual([])
      expect(JSON.stringify(provider.posts()[0]?.body)).not.toMatch(/Invitee|@example.test/)
      const copy = await db
        .selectFrom('group_slot_calendar_events')
        .select(['calendar_id', 'external_event_id', 'etag'])
        .where('group_slot_id', '=', groupSlotId)
        .executeTakeFirstOrThrow()
      expect(copy).toEqual({ calendar_id: selected, external_event_id: eventId, etag })

      const original = [...provider.events][0]
      if (!original) throw new Error('Expected the first Graph copy')
      const [key, event] = original
      provider.events.set(key, { ...event, '@odata.etag': outlookEtag })
      await cancelManagedBooking(context(), requireToken(first.manageToken))
      await work({ groupSlotId })
      expect(patches()).toMatchObject([
        { id: eventId, ifMatch: outlookEtag, body: { body: { content: '1' } } },
      ])
      expect(provider.events.size).toBe(1)
      await cancelManagedBooking(context(), requireToken(second.manageToken))
      await work({ groupSlotId })
      expect(deletes()).toMatchObject([{ id: eventId, ifMatch: updatedEtag }])
      expect(provider.events.size).toBe(0)
      expect(
        await db
          .selectFrom('group_slot_calendar_events')
          .select('group_slot_id')
          .where('group_slot_id', '=', groupSlotId)
          .execute(),
      ).toEqual([])
      expect(provider.posts()).toHaveLength(1)
    })

    it('keeps a single group Teams meeting without rewriting its Outlook body', async () => {
      await setGroupType()
      await chooseTeams()
      const first = await create()
      const groupSlotId = await slotFor(first.booking.id)
      await work({ groupSlotId })
      const second = await create({ ...invitee, email: 'second@example.test' })
      await work({ groupSlotId })

      const ready = { kind: 'microsoft_teams', status: 'ready', url: teamsJoinUrl }
      expect(second.booking.location).toEqual(ready)
      expect(
        (await getManagedBooking(context(), requireToken(first.manageToken))).location,
      ).toEqual(ready)
      expect(provider.posts()).toHaveLength(1)
      expect(provider.posts()[0]?.body).toMatchObject({ isOnlineMeeting: true })
      expect(provider.posts()[0]?.body).not.toHaveProperty('body')
      expect(patches()).toHaveLength(0)

      await cancelManagedBooking(context(), requireToken(first.manageToken))
      await work({ groupSlotId })
      expect(deletes()).toHaveLength(0)
      await cancelManagedBooking(context(), requireToken(second.manageToken))
      await work({ groupSlotId })
      expect(deletes()).toHaveLength(1)
    })

    it('keeps the Teams URL behind host and invitee authorization', async () => {
      await chooseTeams()
      const key = 'teams-confirmation-replay'
      const created = await create(invitee, key)
      const bookingId = created.booking.id
      expect(created.booking.location).toEqual({
        kind: 'microsoft_teams',
        status: 'join_url_pending',
      })
      await work({ bookingId })
      expect((await create(invitee, key)).booking.location).toEqual({ kind: 'microsoft_teams' })

      const another = await create({ ...invitee, email: 'other@example.test' }, undefined, NEXT)
      expect(
        JSON.stringify(await getManagedBooking(context(), requireToken(another.manageToken))),
      ).not.toContain(teamsJoinUrl)
      const principal = await hostSession()
      const other = await f.host()
      await expect(
        getHostBooking(
          {
            ...context(),
            principal: {
              ...principal,
              organization: { ...principal.organization, id: other.organizationId },
            },
          },
          bookingId,
        ),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
      await expect(
        getHostBooking(
          {
            ...context(),
            principal: {
              ...principal,
              user: { ...principal.user, id: other.userId },
            },
          },
          bookingId,
        ),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
      expect(
        (await getManagedBooking(context(), requireToken(created.manageToken))).location,
      ).toEqual({ kind: 'microsoft_teams', status: 'ready', url: teamsJoinUrl })
    })

    it('preserves an Outlook edit to a group copy’s seat count', async () => {
      await setGroupType()
      const first = await create()
      const groupSlotId = await slotFor(first.booking.id)
      await book({ ...invitee, name: 'Second Invitee', email: 'second@example.test' })
      await work({ groupSlotId })
      const original = [...provider.events][0]
      if (!original) throw new Error('Expected the first Graph copy')
      const [key, event] = original
      const body = { contentType: 'text', content: '3' } as const
      provider.events.set(key, { ...event, '@odata.etag': outlookEtag, body })

      await cancelManagedBooking(context(), requireToken(first.manageToken))
      await work({ groupSlotId })
      expect(patches()).toHaveLength(0)
      expect(provider.events.get(key)?.body).toEqual(body)
      expect(await readMicrosoftWritebackSummary(db, [selected], now)).toEqual(
        new Map([[selected, { status: 'failed', reason: 'event_conflict' }]]),
      )
    })

    it('reconciles the latest group seat count after a create with a lost response', async () => {
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
      const latest = await db
        .selectFrom('group_slots')
        .select('count_revision')
        .where('id', '=', groupSlotId)
        .executeTakeFirstOrThrow()
      expect(latest.count_revision).not.toBe(initial.count_revision)
      expect(copy).toEqual({ external_event_id: eventId, count_revision: latest.count_revision })
      expect(provider.posts()).toHaveLength(1)
      expect(patches()).toMatchObject([{ body: { body: { content: '2' } } }])
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

    it.each([false, true])(
      'defers a throttled POST until Retry-After and uses the same transactionId (Teams: %s)',
      async (teams) => {
        if (teams) await chooseTeams()
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
        expect(provider.posts()[1]?.body).toEqual(provider.posts()[0]?.body)
        expect(provider.posts()[0]?.body).toMatchObject({ isOnlineMeeting: teams })
        expect(provider.events.size).toBe(1)
        expect(await state(bookingId)).toMatchObject({ status: 'succeeded', attempts: 2 })
        if (teams)
          expect(await state(bookingId)).toMatchObject({ teamsStatus: 'ready', teamsJoinUrl })
      },
    )

    it.each([
      { mailbox: 'work or school without Teams', allowed: ['skypeForBusiness'] },
      // https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0#properties
      { mailbox: 'personal Outlook', allowed: ['skypeForConsumer'] },
    ])('keeps the booking and tracks Teams unavailability for $mailbox', async ({ allowed }) => {
      await chooseTeams()
      provider.controls.allowedOnlineMeetingProviders = allowed
      const created = await create()
      const bookingId = created.booking.id
      await work({ bookingId })
      await work({ bookingId })

      expect(provider.capabilityReads).toEqual(['outlook-selected'])
      expect(provider.posts()).toHaveLength(1)
      expect(provider.posts()[0]?.body).toMatchObject({ isOnlineMeeting: false })
      expect(provider.posts()[0]?.body).not.toHaveProperty('onlineMeetingProvider')
      expect(await state(bookingId)).toMatchObject({
        status: 'succeeded',
        teamsStatus: 'teams_unavailable',
      })
      expect(await state(bookingId)).not.toHaveProperty('teamsJoinUrl')
      expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
      expect(
        (await getManagedBooking(context(), requireToken(created.manageToken))).location,
      ).toEqual({ kind: 'microsoft_teams', status: 'teams_unavailable' })

      const moved = await rescheduleManagedBooking(context(), requireToken(created.manageToken), {
        start: NEXT,
      })
      await work({ bookingId: moved.booking.id })
      expect(await state(bookingId)).toMatchObject({ teamsStatus: 'teams_unavailable' })
      expect(provider.posts()).toHaveLength(1)
      expect(provider.capabilityReads).toEqual(['outlook-selected'])
      await cancelManagedBooking(context(), requireToken(moved.manageToken))
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({ teamsStatus: 'teams_unavailable' })
      expect(provider.events.size).toBe(0)
    })

    it('keeps Teams disabled for a collective booking with two Outlook destinations', async () => {
      const cohost = await f.host({ timeZone: 'UTC' })
      const teamHandle = `${host.handle}-team`
      const team = await f.organization(teamHandle)
      await f.member(host.userId, team, 'owner')
      await f.member(cohost.userId, team)
      await f.schedule(cohost.userId, { timeZone: 'UTC' })
      const cohostCalendar = await calendar(await connect(cohost.userId), 'outlook-cohost')
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: cohostCalendar })
        .where('user_id', '=', cohost.userId)
        .execute()
      const collective = await f.eventType(team, null, {
        slug: 'outlook-booking',
        hosts: [{ userId: host.userId }, { userId: cohost.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ scheduling_type: 'collective' })
        .where('id', '=', collective)
        .execute()

      const created = await createPublicTeamBooking(context(), {
        handle: teamHandle,
        slug: 'outlook-booking',
        start: START,
        invitee,
      })
      const bookingId = created.booking.id
      // Exercise the worker's host-count check even if an invalid booking bypassed configuration.
      await db
        .deleteFrom('booking_calendar_targets')
        .where('root_booking_id', '=', bookingId)
        .execute()
      await db
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: 'microsoft_teams' }) })
        .where('id', '=', bookingId)
        .execute()
      await recordMicrosoftBookingDestinations(db, bookingId, now)
      await work({ bookingId })

      const targets = await db
        .selectFrom('booking_calendar_targets')
        .select(['calendar_id', 'microsoft_writeback'])
        .where('root_booking_id', '=', bookingId)
        .execute()
      expect(targets.map((target) => target.calendar_id).sort()).toEqual(
        [selected, cohostCalendar].sort(),
      )
      for (const { microsoft_writeback } of targets) {
        expect(microsoft_writeback).toMatchObject({ status: 'succeeded' })
        expect(microsoft_writeback).not.toHaveProperty('teamsStatus')
      }
      expect(provider.capabilityReads).toEqual([])
      expect(provider.posts()).toHaveLength(2)
      for (const post of provider.posts()) {
        expect(post.body).toMatchObject({ isOnlineMeeting: false })
        expect(post.body).not.toHaveProperty('onlineMeetingProvider')
      }
    })

    it('retries a confirmed Teams event without a join URL and can recover the same event', async () => {
      await chooseTeams()
      provider.controls.omitTeamsJoinUrl = true
      const bookingId = await book()

      await work({ bookingId })

      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        teamsStatus: 'join_url_pending',
        reason: 'provider_unavailable',
        attempts: 1,
        nextAttemptAt: new Date(now + 30_000).toISOString(),
      })
      expect(await state(bookingId)).not.toHaveProperty('teamsJoinUrl')
      expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
      for (let attempt = 1; attempt < 6; attempt++) {
        now += 15 * 60_000
        await work({ bookingId })
      }
      expect(await state(bookingId)).toMatchObject({
        status: 'failed',
        teamsStatus: 'join_url_pending',
        reason: 'provider_unavailable',
        attempts: 6,
      })
      expect(await state(bookingId)).not.toHaveProperty('nextAttemptAt')
      expect(await state(bookingId)).not.toHaveProperty('teamsJoinUrl')
      expect(provider.posts()).toHaveLength(1)

      const original = [...provider.events][0]
      if (!original) throw new Error('Expected the first Graph copy')
      const [key, event] = original
      provider.events.set(key, { ...event, onlineMeeting: { joinUrl: teamsJoinUrl } })
      await redispatchBookingCalendar(db, { enqueue: async () => null }, bookingId, now)
      await work({ bookingId })

      expect(provider.posts()).toHaveLength(1)
      expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
      expect(await state(bookingId)).toMatchObject({
        status: 'succeeded',
        teamsStatus: 'ready',
        teamsJoinUrl,
      })
    })

    it('does not mark a possible create before the Teams capability check finishes', async () => {
      await chooseTeams()
      const created = await create()
      const bookingId = created.booking.id
      const probing = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      provider.controls.beforeCapabilities = async () => {
        probing.resolve()
        await release.promise
        return undefined
      }
      const writing = work({ bookingId })
      try {
        await Promise.race([probing.promise, writing])
        expect(await state(bookingId)).toMatchObject({ teamsStatus: 'pending', lookupOnly: false })
        await cancelManagedBooking(context(), requireToken(created.manageToken))
      } finally {
        release.resolve()
        await writing
      }
      expect(provider.posts()).toEqual([])
      expect(await state(bookingId)).toBeNull()
    })

    it('records a Graph 403 during Teams capability discovery as a permission failure', async () => {
      await chooseTeams()
      provider.controls.beforeCapabilities = () => graphError(403, 'ErrorAccessDenied')
      const bookingId = await book()
      await work({ bookingId })

      expect(provider.capabilityReads).toEqual(['outlook-selected'])
      expect(provider.posts()).toEqual([])
      expect(await state(bookingId)).toMatchObject({
        status: 'failed',
        reason: 'permissions_missing',
        teamsStatus: 'pending',
      })
      expect(JSON.stringify(await state(bookingId))).not.toContain('Private Graph details')
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

    it('replays an ambiguous Teams create through the booking marker and records the join URL', async () => {
      await chooseTeams()
      const bookingId = await book()
      provider.controls.afterCreate = async () => graphError(503, 'ServiceUnavailable')
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({ status: 'retrying', lookupOnly: true })
      expect(await mappings(bookingId)).toEqual([])

      now += 30_000
      await work({ bookingId })

      expect(provider.calls.map(({ method }) => method)).toEqual(['GET', 'POST', 'GET'])
      expect(provider.posts()).toHaveLength(1)
      expect(await mappings(bookingId)).toMatchObject([{ external_event_id: eventId }])
      expect(await state(bookingId)).toMatchObject({
        status: 'succeeded',
        teamsStatus: 'ready',
        teamsJoinUrl,
      })
    })

    it('reposts a 503 after the usual Outlook backoff even when Graph sends Retry-After', async () => {
      const bookingId = await book()
      provider.controls.beforeCreate = () =>
        graphError(503, 'ServiceUnavailable', { 'Retry-After': '3600' })
      await work({ bookingId })
      expect(await state(bookingId)).toMatchObject({
        status: 'retrying',
        reason: 'provider_unavailable',
        nextAttemptAt: new Date(now + 30_000).toISOString(),
      })
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
