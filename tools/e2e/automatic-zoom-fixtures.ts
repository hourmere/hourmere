import { createHmac, randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createApp } from '../../apps/server/src/app.ts'
import { productRoutes } from '../../apps/server/src/server.ts'
import { createAuth, createAuthPool, createCallerResolver } from '../../packages/auth/src/index.ts'
import { writeBookingCalendar } from '../../packages/calendars/src/booking-events.ts'
import { writeBookingConference } from '../../packages/calendars/src/conferences.ts'
import { encryptCredential } from '../../packages/calendars/src/credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../packages/calendars/src/google.ts'
import { tokenAad } from '../../packages/calendars/src/index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../packages/calendars/src/testing.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../packages/conferences/src/testing.ts'
import { createZoomConferenceWork } from '../../packages/conferences/src/worker.ts'
import { zoomScopes } from '../../packages/conferences/src/zoom.ts'
import { createDb, createPool } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { textHasUrl } from '../../packages/mail/src/booking-link-testing.ts'
import type { MailMessage } from '../../packages/mail/src/index.ts'
import {
  dispatchConferenceNotifications,
  sendBookingNotification,
} from '../../packages/notifications/src/index.ts'
import type { BookingEvent } from '../../packages/scheduling/src/context.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import { test as base, expect } from './fixtures.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'

interface ZoomMeetingApp {
  url: string
  personalPath: string
  teamPath: string
  eventPath: string
  configure: (team?: boolean) => Promise<void>
  signIn: (kind: 'personal' | 'team' | 'foreign') => Promise<void>
  advance: (mode?: 'ready' | 'lost' | 'unsafe') => Promise<void>
  failAccountRead: (fail: boolean) => void
  foreignAndKey: () => Promise<{
    foreign: number
    key: number
    privateKey: number
    foreignKey: number
    foreignKeyError: string
  }>
  state: () => Promise<{
    roots: number
    meetings: number
    posts: number
    patches: number
    deletes: number
    requestMail: number
    cancelMail: number
    mailSafe: boolean
    rootStable: boolean
    mirrors: string[]
    ordinaryCopies: number
    ordinarySafe: boolean
    calendars: number
    hostPath: string
  }>
}
export const test = base.extend<{
  zoomMeetingApp: ZoomMeetingApp
  automaticZoom: boolean
  zoomMirror: boolean
}>({
  automaticZoom: [true, { option: true }],
  zoomMirror: [false, { option: true }],
  zoomMeetingApp: async ({ context, automaticZoom, zoomMirror }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap)
      throw new Error('HOURMERE_E2E_BOOTSTRAP_URL must bootstrap helper-owned databases')
    const owned = await createTestDatabase(bootstrap)
    let listener: OwnedListener | undefined, authPool: ReturnType<typeof createAuthPool> | undefined
    try {
      listener = await listenOwned(createHttpServer())
      const { server, url } = listener,
        db = createDb(owned.pool),
        f = createFixtures(db)
      const host = await f.host({ handle: 'zoom-booking', name: 'Settings', timeZone: 'UTC' }),
        other = await f.host({ handle: null, name: 'Other Admin', timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      const team = await f.organization('ZoomTeam')
      await f.member(host.userId, team, 'owner')
      await f.member(other.userId, team, 'admin')
      const events: BookingEvent[] = [],
        sent: MailMessage[] = [],
        signup = { mode: 'closed', allowedDomains: [] } as const,
        secret = randomBytes(32).toString('base64')
      authPool = createAuthPool(owned.url, signup)
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: url,
        secret,
        signup,
        mailer: {
          send: async () => {
            throw new Error('No real mail')
          },
        },
      })
      async function session(userId: string, organizationId: string) {
        const token = randomBytes(24).toString('base64url')
        await db
          .insertInto('auth.session')
          .values({
            userId,
            activeOrganizationId: organizationId,
            token,
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600000),
          })
          .execute()
        return encodeURIComponent(
          `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`,
        )
      }
      const cookies = {
        personal: await session(host.userId, host.organizationId),
        team: await session(host.userId, team),
        foreign: await session(other.userId, team),
      }
      const provider = fakeZoom(url),
        google = fakeGoogle()
      if (zoomMirror) {
        const account = 'synthetic-zoom-mirror'
        const connection = await db
          .insertInto('calendar_connections')
          .values({
            user_id: host.userId,
            provider: 'google',
            external_account_id: account,
            account_email: 'calendar@hourmere.invalid',
            credentials: encryptCredential(
              Buffer.from(TEST_CALENDAR_KEY, 'base64'),
              tokenAad(host.userId, account),
              JSON.stringify({
                accessToken: 'synthetic-calendar-access',
                refreshToken: 'synthetic-calendar-refresh',
                expiresAt: Date.now() + 86400000,
              }),
            ),
            scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const calendar = await db
          .insertInto('calendars')
          .values({
            connection_id: connection.id,
            external_id: 'synthetic-mirror',
            name: 'Synthetic ordinary calendar',
            access_role: 'owner',
            supports_google_meet: true,
            check_conflicts: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: calendar.id })
          .where('user_id', '=', host.userId)
          .execute()
      }
      const zoom = {
        client: provider.client,
        encryptionKey: TEST_CONFERENCE_KEY,
        meetingsEnabled: automaticZoom,
      }
      const app = createApp({
        publicUrl: url,
        embedOrigins: [url],
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        webDist:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
        routes: productRoutes({
          db,
          publicUrl: url,
          socialProviders: {},
          automaticZoom,
          zoomConference: zoom,
          notify: async (_trx, event) => {
            events.push(event)
          },
        }),
      })
      const request = (
        path: string,
        kind: keyof typeof cookies = 'personal',
        body?: unknown,
        method = body === undefined ? 'GET' : 'POST',
      ) =>
        app.request(path, {
          method,
          headers: {
            cookie: `better-auth.session_token=${cookies[kind]}`,
            ...(body === undefined ? {} : { origin: url, 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      async function connect(mode: 'identity' | 'meetings', id: string, name: string) {
        provider.controls.identity.id = id
        provider.controls.identity.display_name = name
        provider.controls.token.scope = zoomScopes(mode).join(' ')
        const response = await request(
          `/api/v1/conference-connections/zoom/${mode === 'meetings' ? 'authorize-meetings' : 'authorize'}`,
          'personal',
          {},
        )
        expect(response.status).toBe(200)
        const authUrl = new URL((await response.json()).authorizationUrl)
        const callback = await request(
          `/api/conference/zoom/callback?${new URLSearchParams({ state: authUrl.searchParams.get('state') ?? '', code: 'synthetic-code' })}`,
        )
        expect(callback.status).toBe(303)
        return (
          await db
            .selectFrom('conference_connections')
            .select('id')
            .where('external_user_id', '=', id)
            .executeTakeFirstOrThrow()
        ).id
      }
      // OAuth adapter/state, encrypted credentials and actual session checks are real; transport is synthetic.
      const pin = automaticZoom
        ? await connect('meetings', 'synthetic-zoom-identity', 'Settings')
        : null
      if (automaticZoom) {
        await connect('meetings', 'synthetic-second-own', 'Another own Zoom account')
        await connect('identity', 'synthetic-identity-only', 'Identity only account')
        provider.controls.identity.id = 'synthetic-zoom-identity'
        provider.controls.identity.display_name = 'Settings'
        provider.controls.token.scope = zoomScopes('meetings').join(' ')
      }
      const personal = await f.eventType(host.organizationId, host.userId, {
        slug: 'call',
        title: 'Synthetic Zoom call',
        location: { kind: 'zoom' },
      })
      await f.eventType(team, null, {
        hosts: [{ userId: host.userId }],
        slug: 'call',
        title: 'Team Zoom call',
        location: { kind: 'zoom' },
      })
      server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))
      let external = 0,
        privateListFailure = false
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url())
        if (target.origin === url) {
          if (
            privateListFailure &&
            target.pathname === '/api/v1/conference-connections' &&
            route.request().method() === 'GET'
          )
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'synthetic-unavailable' }),
            })
          return route.continue()
        }
        external++
        await route.abort('blockedbyclient')
      })
      const deps = {
        db,
        zoomConferenceWork: createZoomConferenceWork({ db, zoom }, provider.meetings),
        ...(zoomMirror && { google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY } }),
      }
      const mail = {
        db,
        publicUrl: url,
        secret,
        now: () => Temporal.Now.instant(),
        mailer: {
          send: async (message: MailMessage) => {
            sent.push(message)
          },
        },
      }
      let firstMeeting: string | null = null
      await use({
        url,
        personalPath: '/zoom-booking/call',
        teamPath: '/team/ZoomTeam/call',
        eventPath: `/app/event-types/${personal}`,
        configure: async (teamEvent = false) => {
          const id = (
            await db
              .selectFrom('event_types')
              .select('id')
              .where('organization_id', '=', teamEvent ? team : host.organizationId)
              .where('slug', '=', 'call')
              .executeTakeFirstOrThrow()
          ).id
          const result = await request(
            `/api/v1/event-types/${id}`,
            teamEvent ? 'team' : 'personal',
            { location: { kind: 'zoom', autoCreate: true }, zoomConnectionId: pin },
            'PATCH',
          )
          expect(result.status).toBe(200)
        },
        signIn: async (kind) => {
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: cookies[kind],
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ])
        },
        failAccountRead: (fail) => {
          privateListFailure = fail
        },
        advance: async (mode = 'ready') => {
          provider.controls.meetingHook =
            mode === 'ready'
              ? undefined
              : async (_target, init) => {
                  if (init.method !== 'POST') throw new Error('Fixture mode expects a sole POST')
                  const value = {
                    ...JSON.parse(String(init.body)),
                    id: 81234567890,
                    host_id: 'synthetic-zoom-identity',
                    join_url: 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1',
                  }
                  provider.controls.storedMeetings.set('81234567890', value)
                  if (mode === 'lost') throw new TypeError('Synthetic accepted lost response')
                  return Response.json({ ...value, join_url: 'https://evil.invalid/j/81234567890' })
                }
          for (const event of events.splice(0))
            await sendBookingNotification(
              mail,
              event.bookingId,
              event.type === 'created' ? 'confirmed' : event.type,
            )
          const root = await db
            .selectFrom('booking_conferences')
            .select('root_booking_id')
            .executeTakeFirstOrThrow()
          await writeBookingConference(deps, root.root_booking_id)
          await writeBookingCalendar(deps, root.root_booking_id)
          await dispatchConferenceNotifications(mail)
          const c = await db
            .selectFrom('booking_conferences')
            .select('zoom_meeting_id')
            .executeTakeFirstOrThrow()
          firstMeeting ??= c.zoom_meeting_id
        },
        foreignAndKey: async () => {
          const id = (
            await db
              .selectFrom('event_types')
              .select('id')
              .where('organization_id', '=', team)
              .executeTakeFirstOrThrow()
          ).id
          const foreign = await request(
            `/api/v1/event-types/${id}`,
            'foreign',
            { location: { kind: 'zoom', autoCreate: true }, zoomConnectionId: pin },
            'PATCH',
          )
          const foreignKey = await auth.api.createApiKey({
            body: {
              userId: other.userId,
              name: 'Synthetic admin key',
              metadata: { organizationId: team },
            },
          })
          const foreignKeyResult = await app.request(`/api/v1/event-types/${id}`, {
            method: 'PATCH',
            headers: {
              authorization: `Bearer ${foreignKey.key}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              location: { kind: 'zoom', autoCreate: true },
              zoomConnectionId: pin,
            }),
          })
          const key = await auth.api.createApiKey({
            body: {
              userId: host.userId,
              name: 'Synthetic Zoom key',
              metadata: { organizationId: team },
            },
          })
          const keyResult = await app.request(`/api/v1/event-types/${id}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              location: { kind: 'zoom', autoCreate: true },
              zoomConnectionId: pin,
            }),
          })
          const privateKey = await app.request('/api/v1/conference-connections', {
            headers: { authorization: `Bearer ${key.key}` },
          })
          return {
            foreign: foreign.status,
            key: keyResult.status,
            privateKey: privateKey.status,
            foreignKey: foreignKeyResult.status,
            foreignKeyError: (await foreignKeyResult.json()).error,
          }
        },
        state: async () => {
          const roots = await db.selectFrom('booking_conferences').selectAll().execute(),
            c = roots[0]
          const copies = await db.selectFrom('booking_conference_mirrors').select('state').execute()
          const meetings = provider.controls.storedMeetings
          return {
            roots: roots.length,
            meetings: meetings.size,
            posts: provider.calls.filter(
              (c) => c.init.method === 'POST' && c.url.endsWith('/users/me/meetings'),
            ).length,
            patches: provider.calls.filter((c) => c.init.method === 'PATCH').length,
            deletes: provider.calls.filter((c) => c.init.method === 'DELETE').length,
            requestMail: sent.filter((m) =>
              m.attachments?.some((a) => a.content.includes('METHOD:REQUEST')),
            ).length,
            cancelMail: sent.filter((m) =>
              m.attachments?.some((a) => a.content.includes('METHOD:CANCEL')),
            ).length,
            mailSafe: sent
              .filter((m) => m.attachments?.some((a) => a.content.includes('METHOD:REQUEST')))
              .every(
                (m) =>
                  m.sensitive &&
                  textHasUrl(
                    m.text,
                    'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1',
                  ) &&
                  m.attachments?.every((a) => a.content.includes(`${c?.root_booking_id}@hourmere`)),
              ),
            rootStable: !c || !firstMeeting || c.zoom_meeting_id === firstMeeting,
            mirrors: copies.map((c) => c.state),
            ordinaryCopies: google.controls.storedEvents.size,
            ordinarySafe: [...google.controls.storedEvents.values()].every(
              (e) =>
                !e.conferenceData &&
                !e.attendees &&
                e.location === 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1' &&
                e.iCalUID === `${c?.root_booking_id}@hourmere`,
            ),
            calendars: (await db.selectFrom('calendars').select('id').execute()).length,
            hostPath: `/app/bookings/${c?.booking_id}`,
          }
        },
      })
      expect(external, 'All non-loopback browser requests must remain blocked').toBe(0)
    } finally {
      try {
        await listener?.close()
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned.drop()
          const verification = createPool(owned.url)
          try {
            let absent = false
            try {
              await verification.query('SELECT 1')
            } catch (e) {
              absent = (e as { code?: string }).code === '3D000'
            }
            expect(absent, 'Own Zoom meeting database must be absent').toBe(true)
          } finally {
            await verification.end()
          }
          await listener?.assertClosed()
          console.log('Automatic Zoom fixture cleanup verified: fresh 3D000, owned listener closed')
        }
      }
    }
  },
})
export { expect, fillInvitee, pickSlot } from './fixtures.ts'
