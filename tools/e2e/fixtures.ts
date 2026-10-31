import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
import type { RunningServer } from '../../apps/server/src/server.ts'
import { createAuth, createAuthPool } from '../../packages/auth/src/index.ts'
import { writeBookingCalendar } from '../../packages/calendars/src/booking-events.ts'
import { writeBookingConference } from '../../packages/calendars/src/conferences.ts'
import { encryptCredential } from '../../packages/calendars/src/credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../packages/calendars/src/google.ts'
import { tokenAad } from '../../packages/calendars/src/index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../packages/calendars/src/testing.ts'
import { explicitLanguage } from '../../packages/core/src/language.ts'
import { createDb, createPool } from '../../packages/db/src/index.ts'
import { createTestDatabase } from '../../packages/db/src/testing.ts'
import { icsHasLocation, textHasUrl } from '../../packages/mail/src/booking-link-testing.ts'
import type { MailMessage } from '../../packages/mail/src/index.ts'
import {
  dispatchConferenceNotifications,
  sendBookingNotification,
} from '../../packages/notifications/src/index.ts'
import { validateSuccessRedirect } from '../../packages/scheduling/src/success-redirect.ts'
import { createFixtures } from '../../packages/scheduling/src/testing.ts'
import {
  AUDIT_BOOKING_END,
  AUDIT_BOOKING_START,
  AUDIT_DESCRIPTION,
  AUDIT_EMAIL,
  AUDIT_GUEST_NAME,
  AUDIT_HOST_TIME_ZONE,
  AUDIT_NOW,
  AUDIT_OVERNIGHT_BOOKING_END,
  AUDIT_OVERNIGHT_BOOKING_START,
  AUDIT_TEAM_NAME,
  AUDIT_TITLE,
  type AuditFixtureState,
} from './audit-data.ts'
import { startFixtureServer } from './fixture-server.ts'
import { listenOwned, type OwnedListener } from './listeners.ts'
import { type ScreenshotFixtureState, seedScreenshotData } from './screenshot-data.ts'

export interface FixtureApp {
  url: string
  parentUrl: string
  personalPath: string
  configureDurations: () => Promise<void>
  configureSuccessRedirect: (allowEmbedParent: boolean) => Promise<void>
  auditState: () => Promise<AuditFixtureState>
  screenshotState: () => Promise<ScreenshotFixtureState>
  auditSignIn: (signedIn: boolean, locale?: string, space?: 'team') => Promise<void>
  auditOAuthQuery: () => Promise<string>
  teamPath: string
  collectivePath: string
  meetPath: string
  loseMirrorResponse: () => void
  multiMeetState: () => Promise<{
    organizerName: string
    mirrors: string[]
    ordinarySafe: boolean
    requests: number
    pinnedInvitation: boolean
    copies: number
  }>

  advanceMeet: (state: 'pending' | 'success' | 'failure' | 'lost') => Promise<void>
  meetState: () => Promise<{
    imports: number
    privateImports: boolean
    conferencePatches: number
    conferenceSafe: boolean
    deletes: number
    rows: number
    requests: number
    cancellations: number
    failures: number
    linkedRequests: boolean
    rootUidPreserved: boolean
    hostBookingPath: string
  }>
  roundRobinPath: string
  roundRobinState: (slug?: string) => Promise<{ sequence: string; assignedNames: string[] }>
  hostCounts: () => Promise<number[]>
  rows: () => Promise<{ source: string; status: string }[]>
  authorizeHost: (teamRole?: 'owner' | 'member') => Promise<void>
  authorizeTeamSession: () => Promise<{ teamId: string; personalId: string }>
  eventTypeTitles: () => Promise<string[]>
  bookingState: () => Promise<{
    total: number
    roots: number
    successors: number
    bookerLocales: (string | null)[]
    fingerprints: number
    originalFingerprintPreserved: boolean
  }>
}
export interface FixtureOptions {
  uiAudit: boolean
}
export const test = base.extend<{
  app: FixtureApp
  suppressFailureDom: undefined
  automaticMeet: boolean
  multiHostMeet: boolean
  uiAudit: boolean
}>({
  automaticMeet: [false, { option: true }],
  multiHostMeet: [false, { option: true }],
  uiAudit: [false, { option: true }],
  suppressFailureDom: [
    async ({ context }, use, testInfo) => {
      // Depending on context runs this teardown before its artifact finalization.
      void context
      try {
        await use(undefined)
      } finally {
        // Pinned Playwright attaches locator snapshots before its fallback-capture switch.
        // Keep the assertion, message and stack; discard only its private DOM diagnostic.
        for (const error of testInfo.errors) Reflect.deleteProperty(error, 'errorContext')
      }
    },
    { auto: true },
  ],
  app: async ({ context, automaticMeet, multiHostMeet, uiAudit }, use) => {
    const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
    if (!bootstrap)
      throw new Error(
        'Set HOURMERE_E2E_BOOTSTRAP_URL for helper-owned throwaway databases; no DATABASE_URL fallback is used',
      )
    const owned = await createTestDatabase(bootstrap)
    let app: RunningServer | undefined, parent: Server | undefined
    let authPool: ReturnType<typeof createAuthPool> | undefined
    let appListener: OwnedListener | undefined, parentListener: OwnedListener | undefined
    try {
      appListener = await listenOwned(createTcpServer({ allowHalfOpen: true }))
      const url = appListener.url,
        db = createDb(owned.pool),
        f = createFixtures(db),
        host = await f.host({ handle: 'fixture-host', name: 'Fixture Host', timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      const provider = fakeGoogle(),
        sent: MailMessage[] = []
      let meetResponse: 'pending' | 'success' | 'failure' | 'lost' = 'pending'
      const join = 'https://meet.google.com/abc-defg-hij'
      const conferenceRequests = new Map<string, { requestId: string; polls: number }>()
      let loseMirror = false
      provider.controls.eventHook = async (target, init) => {
        const values = provider.controls.storedEvents,
          calendar = decodeURIComponent(target.pathname.split('/')[4] as string)
        const describeConferenceEvent = (value: Record<string, unknown>, poll = false) => {
          const request = conferenceRequests.get(String(value.id))
          if (!request) return value
          if (poll) request.polls++
          const status = request.polls > 0 && meetResponse !== 'lost' ? meetResponse : 'pending'
          return {
            ...value,
            conferenceData: {
              createRequest: { requestId: request.requestId, status: { statusCode: status } },
              ...(status === 'success'
                ? {
                    conferenceSolution: { key: { type: 'hangoutsMeet' } },
                    entryPoints: [{ entryPointType: 'video', uri: join }],
                  }
                : {}),
            },
          }
        }
        if (init.method === 'POST') {
          const input = JSON.parse(String(init.body)),
            value = {
              ...input,
              id: multiHostMeet ? `fixture-${calendar}` : 'fixture-meet-event',
              etag: '"v1"',
              fixtureCalendar: calendar,
              // Reproduce Google: an import createRequest is accepted but stays
              // pending forever. Only a later conference PATCH starts progress.
              ...(input.conferenceData
                ? {
                    conferenceData: {
                      createRequest: {
                        ...input.conferenceData.createRequest,
                        status: { statusCode: 'pending' },
                      },
                    },
                  }
                : {}),
            }
          values.set(value.id, value)
          const ordinaryCopy = input.location === join
          if ((!ordinaryCopy && meetResponse === 'lost') || (ordinaryCopy && loseMirror))
            throw new TypeError('Synthetic lost provider response')
          return Response.json(value)
        }
        const id = target.pathname.split('/').at(-1) as string
        if (init.method === 'PATCH') {
          const previous = values.get(id)
          if (!previous) return Response.json({}, { status: 404 })
          if (new Headers(init.headers).get('if-match') !== previous.etag)
            return Response.json({}, { status: 412 })
          const input = JSON.parse(String(init.body))
          if (input.conferenceData) {
            const requestId = input.conferenceData.createRequest.requestId
            const previousRequest = conferenceRequests.get(id)
            if (!previousRequest || previousRequest.requestId !== requestId)
              conferenceRequests.set(id, { requestId, polls: 0 })
          }
          const value = describeConferenceEvent({
            ...previous,
            ...input,
            id,
            etag: `"v${provider.calls.filter((call) => call.init.method === 'PATCH').length + 1}"`,
          })
          values.set(id, value)
          return Response.json(value)
        }
        if (target.searchParams.has('iCalUID'))
          return Response.json({
            items: [...values.values()]
              .filter(
                (v) =>
                  v.iCalUID === target.searchParams.get('iCalUID') &&
                  v.fixtureCalendar === calendar,
              )
              .map((value) => describeConferenceEvent(value, true)),
          })
        const value = values.get(id)
        return value
          ? Response.json(describeConferenceEvent(value, true))
          : Response.json({}, { status: 404 })
      }
      if (automaticMeet) {
        const account = 'fixture-google-account'
        const connection = await db
          .insertInto('calendar_connections')
          .values({
            user_id: host.userId,
            provider: 'google',
            external_account_id: account,
            credentials: encryptCredential(
              Buffer.from(TEST_CALENDAR_KEY, 'base64'),
              tokenAad(host.userId, account),
              JSON.stringify({
                accessToken: 'synthetic-access',
                refreshToken: 'synthetic-refresh',
                expiresAt: Date.now() + 86_400_000,
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
            external_id: 'fixture-meet-calendar',
            name: 'Synthetic Meet calendar',
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
        await f.eventType(host.organizationId, host.userId, {
          title: 'Fixture Meet call',
          slug: 'meet',
          location: { kind: 'google_meet', autoCreate: true },
          minimumNoticeMinutes: 30,
        })
      }
      await f.eventType(host.organizationId, host.userId, {
        title: 'Fixture call',
        slug: 'call',
        allowGuests: false,
        minimumNoticeMinutes: 30,
      })
      const team = await f.organization('FixtureTeam')
      await f.member(host.userId, team, 'owner')
      await f.eventType(team, null, {
        title: 'Team fixture call',
        slug: 'call',
        allowGuests: false,
        minimumNoticeMinutes: 30,
        hosts: [{ userId: host.userId }],
      })
      const secondHost = await f.host({
        handle: null,
        name: 'Second Required Host',
        timeZone: 'UTC',
      })
      await f.schedule(secondHost.userId, { timeZone: 'UTC' })
      await f.member(secondHost.userId, team)
      const thirdHost = multiHostMeet
        ? await f.host({ handle: null, name: 'Third Unconnected Host', timeZone: 'UTC' })
        : undefined
      if (thirdHost) {
        await f.schedule(thirdHost.userId, { timeZone: 'UTC' })
        await f.member(thirdHost.userId, team)
      }
      if (multiHostMeet) {
        await db
          .insertInto('profiles')
          .values({ user_id: secondHost.userId, handle: 'fixture-second', time_zone: 'UTC' })
          .execute()
        if (!automaticMeet) throw Error('Multi-host fixture requires Meet')
        const account = 'fixture-second-google',
          connection = await db
            .insertInto('calendar_connections')
            .values({
              user_id: secondHost.userId,
              provider: 'google',
              external_account_id: account,
              credentials: encryptCredential(
                Buffer.from(TEST_CALENDAR_KEY, 'base64'),
                tokenAad(secondHost.userId, account),
                JSON.stringify({
                  accessToken: 'synthetic-second',
                  refreshToken: 'synthetic-refresh',
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
            external_id: 'fixture-second-calendar',
            name: 'Second synthetic',
            access_role: 'owner',
            supports_google_meet: true,
            check_conflicts: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: calendar.id })
          .where('user_id', '=', secondHost.userId)
          .execute()
      }
      const collectiveId = await f.eventType(team, null, {
        title: 'Collective fixture call',
        slug: 'collective',
        ...(multiHostMeet ? { location: { kind: 'google_meet', autoCreate: true } } : {}),
        minimumNoticeMinutes: 30,
        hosts: [
          { userId: host.userId },
          { userId: secondHost.userId },
          ...(thirdHost ? [{ userId: thirdHost.userId }] : []),
        ],
      })
      await db
        .updateTable('event_types')
        .set({
          scheduling_type: 'collective',
          ...(multiHostMeet ? { conference_organizer_user_id: secondHost.userId } : {}),
        })
        .where('id', '=', collectiveId)
        .execute()
      const roundId = await f.eventType(team, null, {
        title: 'Round-robin fixture call',
        ...(multiHostMeet ? { location: { kind: 'google_meet', autoCreate: true } } : {}),
        slug: 'round',
        minimumNoticeMinutes: 30,
        hosts: [{ userId: host.userId }, { userId: secondHost.userId }],
      })
      await db
        .updateTable('event_types')
        .set({ scheduling_type: 'round_robin' })
        .where('id', '=', roundId)
        .execute()
      await db
        .insertInto('round_robin_state')
        .values({ event_type_id: roundId, enabled: true })
        .execute()
      parent = createHttpServer((request, response) => {
        if (
          uiAudit &&
          process.env.CI &&
          new URL(request.url ?? '/', 'http://localhost').pathname === '/axe-canary'
        ) {
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(
            '<!doctype html><html lang="en"><head><title>Axe pipeline canary</title></head><body><main><h1>Axe pipeline canary</h1><button class="axe-canary-button"></button><img class="axe-canary-image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main></body></html>',
          )
          return
        }
        const language = new URL(request.url ?? '/', 'http://localhost').searchParams.get(
          'language',
        )
        const languageAttribute = explicitLanguage(language)
          ? ` data-hourmere-language="${language}"`
          : ''
        response.setHeader('Cache-Control', 'no-store')
        if (request.url === '/parent.js') {
          response.setHeader('Content-Type', 'application/javascript')
          response.end(
            `window.fixtureMessages=[];window.addEventListener('message',e=>{if(e.origin===${JSON.stringify(url)})window.fixtureMessages.push(e.data)});`,
          )
          return
        }
        const bookingPath =
          new URL(request.url ?? '/', 'http://localhost').pathname === '/collective'
            ? '/team/FixtureTeam/collective'
            : new URL(request.url ?? '/', 'http://localhost').pathname === '/round'
              ? '/team/FixtureTeam/round'
              : '/fixture-host/call'
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture website</title><button type="button" data-hourmere-popup${languageAttribute} data-hourmere-url="${url}${bookingPath}">Book a meeting</button><div data-hourmere-inline${languageAttribute} data-hourmere-url="${url}${bookingPath}"></div><script src="/parent.js" defer></script><script src="${url}/hourmere-embed.js" defer></script>`,
        )
      })
      parentListener = await listenOwned(parent)
      const parentUrl = parentListener.url
      const authSecret = randomBytes(32).toString('base64')
      app = await startFixtureServer(appListener, {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: authSecret,
        SIGNUP: 'closed',
        HOURMERE_ROLE: 'web',
        EMBED_ALLOWED_ORIGINS: parentUrl,
        ...(uiAudit && { MCP_OAUTH_ENABLED: 'true' }),
        ...(automaticMeet && {
          GOOGLE_MEET_ENABLED: 'true',
          GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-client',
          GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-secret',
          CALENDAR_ENCRYPTION_KEY: TEST_CALENDAR_KEY,
        }),
        WEB_DIST:
          process.env.HOURMERE_E2E_WEB_DIST ??
          fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
      })
      let externalRequests = 0
      let authorization: string | undefined
      await context.route('**/*', async (route) => {
        const requestUrl = new URL(route.request().url())
        const origin = requestUrl.origin
        if (origin === url || origin === parentUrl)
          await route.continue({
            ...(authorization &&
              origin === url &&
              requestUrl.pathname.startsWith('/api/v1/') &&
              !requestUrl.pathname.startsWith('/api/v1/public/') &&
              !requestUrl.pathname.startsWith('/api/v1/bookings/manage') && {
                headers: { ...route.request().headers(), authorization },
              }),
          })
        else {
          externalRequests++
          await route.abort('blockedbyclient')
        }
      })
      const firstFingerprints = new Map<string, Buffer>()
      let auditState: AuditFixtureState | undefined
      let screenshotState: ScreenshotFixtureState | undefined
      let auditCookie: string | undefined
      let auditSessionId: string | undefined
      let auditOAuthQuery: string | undefined
      await use({
        url,
        parentUrl,
        personalPath: '/fixture-host/call',
        configureDurations: async () => {
          await db
            .updateTable('event_types')
            .set({ allowed_durations_minutes: [15, 30, 60] })
            .where('organization_id', 'in', [host.organizationId, team])
            .where('slug', '=', 'call')
            .execute()
        },
        configureSuccessRedirect: async (allowEmbedParent) => {
          const settings = validateSuccessRedirect({
            url: 'https://continuation.example/thanks?x=%zz&flag&a;b',
            parameters: ['start'],
            allowEmbedParent,
          })
          await db
            .updateTable('event_types')
            .set({ success_redirect: JSON.stringify(settings) })
            .where('organization_id', '=', host.organizationId)
            .where('slug', '=', 'call')
            .execute()
        },
        screenshotState: async () => {
          if (auditState || automaticMeet)
            throw new Error(
              'Product screenshots require a fresh fixture without audit or Meet data',
            )
          screenshotState ??= await seedScreenshotData(db, f, host)
          return screenshotState
        },
        auditState: async () => {
          if (auditState) return auditState
          const eventTypeId = await f.eventType(host.organizationId, host.userId, {
            slug: 'layout-audit',
            title: AUDIT_TITLE,
            description: AUDIT_DESCRIPTION,
            minimumNoticeMinutes: 30,
          })
          await f.eventType(team, null, {
            slug: 'layout-audit',
            title: AUDIT_TITLE,
            description: AUDIT_DESCRIPTION,
            minimumNoticeMinutes: 30,
            hosts: [{ userId: host.userId }],
          })
          const schedule = await db
            .selectFrom('schedules')
            .select('id')
            .where('user_id', '=', host.userId)
            .where('is_default', '=', true)
            .executeTakeFirstOrThrow()
          await db
            .updateTable('schedules')
            .set({ name: 'Synthetic working hours' })
            .where('id', '=', schedule.id)
            .execute()
          await db
            .updateTable('auth.user')
            .set({ email: 'synthetic-host@hourmere.invalid' })
            .where('id', '=', host.userId)
            .execute()
          await db
            .updateTable('auth.organization')
            .set({ name: 'Synthetic organization' })
            .where('id', '=', host.organizationId)
            .execute()
          await db
            .updateTable('auth.organization')
            .set({ name: AUDIT_TEAM_NAME })
            .where('id', '=', team)
            .execute()
          await db
            .updateTable('profiles')
            .set({ time_zone: AUDIT_HOST_TIME_ZONE })
            .where('user_id', '=', host.userId)
            .execute()
          // Exercise the selected destination's zone notice with a long display name.
          // Conflict sync stays off; the web-only fixture never runs provider workers.
          const auditConnection = await db
            .insertInto('calendar_connections')
            .values({
              user_id: host.userId,
              provider: 'google',
              external_account_id: 'synthetic-audit-calendar-account',
              account_email: 'synthetic-calendar@hourmere.invalid',
              credentials: Buffer.from('synthetic-unused-calendar-credential'),
              scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          const auditCalendar = await db
            .insertInto('calendars')
            .values({
              connection_id: auditConnection.id,
              external_id: 'synthetic-audit-calendar',
              name: 'Synthetic cross-zone calendar',
              access_role: 'owner',
              time_zone: 'America/Argentina/Buenos_Aires',
              check_conflicts: false,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          await db
            .updateTable('profiles')
            .set({ destination_calendar_id: auditCalendar.id })
            .where('user_id', '=', host.userId)
            .execute()
          const bookingId = await f.booking(
            host.organizationId,
            [host.userId],
            AUDIT_BOOKING_START,
            AUDIT_BOOKING_END,
            {
              eventTypeId,
              attendee: { name: 'Synthetic long-email invitee', email: AUDIT_EMAIL },
            },
          )
          const manageToken = randomBytes(32).toString('base64url')
          await db
            .updateTable('bookings')
            .set({
              title: AUDIT_TITLE,
              created_at: AUDIT_NOW,
              manage_token_hash: createHash('sha256').update(manageToken).digest(),
            })
            .where('id', '=', bookingId)
            .execute()
          const overnightBookingId = await f.booking(
            host.organizationId,
            [host.userId],
            AUDIT_OVERNIGHT_BOOKING_START,
            AUDIT_OVERNIGHT_BOOKING_END,
            {
              eventTypeId,
              attendee: {
                name: 'Synthetic overnight invitee',
                email: 'synthetic.overnight@hourmere.invalid',
              },
            },
          )
          await db
            .updateTable('bookings')
            .set({ title: AUDIT_TITLE, created_at: AUDIT_NOW })
            .where('id', '=', overnightBookingId)
            .execute()
          const teamEventTypeId = await f.eventType(team, null, {
            slug: 'admin-layout-audit',
            title: AUDIT_TITLE,
            hosts: [{ userId: secondHost.userId }],
          })
          const teamBookingId = await f.booking(
            team,
            [secondHost.userId],
            AUDIT_BOOKING_START,
            AUDIT_BOOKING_END,
            {
              eventTypeId: teamEventTypeId,
              attendee: { name: 'Synthetic team invitee', email: AUDIT_EMAIL },
            },
          )
          await db
            .insertInto('booking_attendees')
            .values({
              booking_id: teamBookingId,
              name: AUDIT_GUEST_NAME,
              email: 'synthetic.team.guest@hourmere.invalid',
              time_zone: 'America/Argentina/Buenos_Aires',
              is_booker: false,
            })
            .execute()
          auditState = {
            organizationId: host.organizationId,
            eventTypeId,
            scheduleId: schedule.id,
            bookingId,
            manageToken,
            bookingPath: '/fixture-host/layout-audit',
            teamBookingPath: '/team/FixtureTeam/layout-audit',
          }
          return auditState
        },
        auditSignIn: async (signedIn, locale = 'en', space) => {
          // Audit pages exercise the same browser-session endpoints as people do.
          // No API-key header remains when switching back to a public/sign-in state.
          authorization = undefined
          if (!signedIn) {
            await context.clearCookies({ name: 'better-auth.session_token' })
            return
          }
          // Signed-in routes prefer the account language over the browser language.
          await db
            .updateTable('profiles')
            .set({ locale: locale === 'zh-CN' ? 'zh-CN' : 'en' })
            .where('user_id', '=', host.userId)
            .execute()
          if (!auditCookie) {
            const token = randomBytes(24).toString('base64url')
            const session = await db
              .insertInto('auth.session')
              .values({
                userId: host.userId,
                activeOrganizationId: space === 'team' ? team : host.organizationId,
                token,
                updatedAt: new Date(),
                expiresAt: new Date(
                  Math.max(Date.now(), uiAudit || screenshotState ? Date.parse(AUDIT_NOW) : 0) +
                    86_400_000,
                ),
              })
              .returning('id')
              .executeTakeFirstOrThrow()
            auditSessionId = session.id
            auditCookie = encodeURIComponent(
              `${token}.${createHmac('sha256', authSecret).update(token).digest('base64')}`,
            )
          }
          if (auditSessionId)
            await db
              .updateTable('auth.session')
              .set({ activeOrganizationId: space === 'team' ? team : host.organizationId })
              .where('id', '=', auditSessionId)
              .execute()
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: auditCookie,
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ])
        },
        auditOAuthQuery: async () => {
          if (auditOAuthQuery) return auditOAuthQuery
          if (!uiAudit) throw new Error('OAuth audit requires the UI audit fixture')
          // Each test owns its database, but Better Auth's registration limiter is
          // process-wide. Seed public client metadata rather than spending the
          // five-per-minute DCR budget for every viewport in the same worker.
          const clientId = 'synthetic-ui-audit-client'
          await db
            .insertInto('auth.oauthClient')
            .values({
              clientId,
              name: 'Synthetic audit connector',
              redirectUris: JSON.stringify(['https://hourmere.invalid/callback']),
              grantTypes: JSON.stringify(['authorization_code', 'refresh_token']),
              responseTypes: JSON.stringify(['code']),
              scopes: JSON.stringify(['mcp:tools', 'offline_access']),
              tokenEndpointAuthMethod: 'none',
              applicationType: 'web',
              requirePKCE: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .execute()
          await db
            .insertInto('auth.oauthClientResource')
            .values({ clientId, resourceId: `${url}/mcp`, createdAt: new Date() })
            .execute()
          const query = new URLSearchParams({
            client_id: clientId,
            redirect_uri: 'https://hourmere.invalid/callback',
            response_type: 'code',
            scope: 'mcp:tools offline_access',
            resource: `${url}/mcp`,
            code_challenge: 'A'.repeat(43),
            code_challenge_method: 'S256',
            state: 'synthetic-ui-audit',
          })
          const continued = await fetch(`${url}/api/auth/oauth2/authorize?${query}`, {
            redirect: 'manual',
          })
          // fetch requests receive JSON; browser navigations receive a 302.
          const continuation = continued.status === 200 ? await continued.json() : undefined
          const location =
            continued.headers.get('location') ?? continuation?.url ?? continuation?.redirect_uri
          if (![200, 302].includes(continued.status) || typeof location !== 'string')
            throw new Error('Could not prepare synthetic connector')
          const selection = new URL(location, url)
          if (selection.origin !== url || selection.pathname !== '/oauth/authorize')
            throw new Error('Unexpected synthetic connector continuation')
          auditOAuthQuery = selection.search
          return auditOAuthQuery
        },
        teamPath: '/team/FixtureTeam/call',
        collectivePath: '/team/FixtureTeam/collective',
        meetPath: '/fixture-host/meet',
        loseMirrorResponse: () => {
          loseMirror = true
        },
        multiMeetState: async () => {
          const c = await db
            .selectFrom('booking_conferences as c')
            .innerJoin('auth.user as u', 'u.id', 'c.organizer_user_id')
            .innerJoin('calendars as cal', 'cal.id', 'c.calendar_id')
            .select([
              'c.root_booking_id',
              'u.name',
              'c.invitation_organizer_email',
              'cal.external_id',
            ])
            .executeTakeFirstOrThrow()
          const mirrors = await db
            .selectFrom('booking_conference_mirrors')
            .select('state')
            .where('root_booking_id', '=', c.root_booking_id)
            .execute()
          const requests = sent.filter((m) =>
            m.attachments?.some((a) => String(a.content).includes('METHOD:REQUEST')),
          )
          const ordinary = provider.calls.filter(
            (call) =>
              ['POST', 'PATCH'].includes(call.init.method ?? '') &&
              decodeURIComponent(call.url.pathname.split('/')[4] ?? '') !== c.external_id,
          )
          return {
            organizerName: c.name,
            mirrors: mirrors.map((m) => m.state).sort(),
            copies: provider.controls.storedEvents.size,
            requests: requests.length,
            ordinarySafe: ordinary.every((call) => {
              const body = JSON.parse(String(call.init.body))
              return !body.conferenceData && !body.attendees && body.location === join
            }),
            pinnedInvitation: requests.every((m) =>
              m.attachments?.every(
                (a) =>
                  String(a.content).includes(
                    `ORGANIZER;CN="${c.name}":mailto:${c.invitation_organizer_email}`,
                  ) && !String(a.content).includes(`ATTENDEE;CN="${c.name}"`),
              ),
            ),
          }
        },
        advanceMeet: async (state) => {
          if (!automaticMeet) throw new Error('Meet fixture is not enabled')
          meetResponse = state
          await db
            .updateTable('booking_conferences')
            .set({ next_attempt_at: new Date() })
            .where('state', '=', 'pending')
            .execute()
          const intents = await db
            .selectFrom('booking_conferences')
            .select(['root_booking_id', 'booking_id'])
            .execute()
          const mail = {
            db,
            publicUrl: url,
            secret: authSecret,
            mailer: {
              send: async (message: MailMessage) => {
                sent.push(message)
              },
            },
          }
          for (const intent of intents) {
            // The fake provider needs one read after the conference PATCH. Drive
            // that transition without a wall-clock wait when readiness is requested.
            for (let attempt = 0; attempt < 2; attempt++) {
              await writeBookingConference(
                { db, google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY } },
                intent.root_booking_id,
              )
              const current = await db
                .selectFrom('booking_conferences')
                .select('state')
                .where('root_booking_id', '=', intent.root_booking_id)
                .executeTakeFirstOrThrow()
              if (current.state !== 'pending' || state === 'pending' || state === 'lost') break
              await db
                .updateTable('booking_conferences')
                .set({ next_attempt_at: new Date() })
                .where('root_booking_id', '=', intent.root_booking_id)
                .execute()
            }
            await writeBookingCalendar(
              { db, google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY } },
              intent.root_booking_id,
            )
            const row = await db
              .selectFrom('bookings')
              .select('status')
              .where('id', '=', intent.booking_id)
              .executeTakeFirstOrThrow()
            if (row.status === 'cancelled')
              await sendBookingNotification(mail, intent.booking_id, 'cancelled')
          }
          await dispatchConferenceNotifications(mail)
        },
        meetState: async () => {
          const intents = await db
            .selectFrom('booking_conferences')
            .select(['root_booking_id', 'booking_id', 'request_id', 'external_event_id'])
            .execute()
          const requests = sent.filter((message) =>
            message.attachments?.some((attachment) =>
              String(attachment.content).includes('METHOD:REQUEST'),
            ),
          )
          const eventUids = [...provider.controls.storedEvents.values()].map(
            (event) => event.iCalUID,
          )
          const imports = provider.calls.filter(
            (call) => call.init.method === 'POST' && call.url.pathname.endsWith('/import'),
          )
          const conferences = provider.calls.filter(
            (call) =>
              call.init.method === 'PATCH' && JSON.parse(String(call.init.body)).conferenceData,
          )
          return {
            imports: imports.length,
            privateImports: imports.every((call) => {
              const body = JSON.parse(String(call.init.body))
              return (
                call.url.search === '' &&
                !Object.hasOwn(body, 'attendees') &&
                !Object.hasOwn(body, 'conferenceData')
              )
            }),
            conferencePatches: conferences.length,
            conferenceSafe: conferences.every((call) => {
              const body = JSON.parse(String(call.init.body)),
                request = body.conferenceData.createRequest
              return (
                Object.keys(body).join() === 'conferenceData' &&
                Object.keys(body.conferenceData).join() === 'createRequest' &&
                Object.keys(request).sort().join() === 'conferenceSolutionKey,requestId' &&
                Object.keys(request.conferenceSolutionKey).join() === 'type' &&
                request.conferenceSolutionKey.type === 'hangoutsMeet' &&
                intents.some(
                  (intent) =>
                    request.requestId === intent.request_id &&
                    call.url.pathname.endsWith(`/events/${intent.external_event_id}`),
                ) &&
                call.url.search === '?sendUpdates=none&conferenceDataVersion=1' &&
                Boolean(new Headers(call.init.headers).get('if-match'))
              )
            }),
            deletes: provider.calls.filter((call) => call.init.method === 'DELETE').length,
            rows: intents.length,
            requests: requests.length,
            cancellations: sent.filter((message) =>
              message.attachments?.some((attachment) =>
                String(attachment.content).includes('METHOD:CANCEL'),
              ),
            ).length,
            failures: sent.filter((message) =>
              ['Meeting link needs attention:', '会议链接需要处理：'].some((prefix) =>
                message.subject.startsWith(prefix),
              ),
            ).length,
            linkedRequests: requests.every(
              (message) =>
                textHasUrl(message.text, join) &&
                message.attachments?.every((attachment) =>
                  icsHasLocation(attachment.content, join),
                ),
            ),
            rootUidPreserved:
              eventUids.length >= 1 &&
              eventUids.every((uid) => uid === `${intents[0]?.root_booking_id}@hourmere`),
            hostBookingPath: `/app/bookings/${intents[0]?.booking_id}`,
          }
        },
        roundRobinPath: '/team/FixtureTeam/round',
        roundRobinState: async (slug = 'round') => {
          const state = await db
            .selectFrom('round_robin_state as r')
            .innerJoin('event_types as e', 'e.id', 'r.event_type_id')
            .select('r.next_sequence')
            .where('e.organization_id', '=', team)
            .where('e.slug', '=', slug)
            .executeTakeFirstOrThrow()
          const assigned = await db
            .selectFrom('bookings as b')
            .innerJoin('event_types as e', 'e.id', 'b.event_type_id')
            .innerJoin('booking_hosts as h', 'h.booking_id', 'b.id')
            .innerJoin('auth.user as u', 'u.id', 'h.user_id')
            .select('u.name')
            .where('e.organization_id', '=', team)
            .where('e.slug', '=', slug)
            .orderBy('b.created_at')
            .orderBy('b.id')
            .execute()
          return { sequence: state.next_sequence, assignedNames: assigned.map((h) => h.name) }
        },
        hostCounts: async () => {
          const bookings = await db
            .selectFrom('bookings')
            .select('id')
            .orderBy('created_at')
            .execute()
          return Promise.all(
            bookings.map(
              async (booking) =>
                (
                  await db
                    .selectFrom('booking_hosts')
                    .select('user_id')
                    .where('booking_id', '=', booking.id)
                    .execute()
                ).length,
            ),
          )
        },
        authorizeTeamSession: async () => {
          authorization = undefined
          const token = randomBytes(24).toString('base64url')
          await db
            .insertInto('auth.session')
            .values({
              userId: host.userId,
              activeOrganizationId: team,
              token,
              updatedAt: new Date(),
              expiresAt: new Date(Date.now() + 86_400_000),
            })
            .execute()
          await context.addCookies([
            {
              name: 'better-auth.session_token',
              value: encodeURIComponent(
                `${token}.${createHmac('sha256', authSecret).update(token).digest('base64')}`,
              ),
              url,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ])
          return { teamId: team, personalId: host.organizationId }
        },
        eventTypeTitles: async () =>
          (await db.selectFrom('event_types').select('title').orderBy('title').execute()).map(
            (row) => row.title,
          ),
        authorizeHost: async (teamRole) => {
          const signup = { mode: 'closed', allowedDomains: [] } as const
          authPool ??= createAuthPool(owned.url, signup)
          if (teamRole)
            await db
              .updateTable('auth.member')
              .set({ role: teamRole })
              .where('organizationId', '=', team)
              .where('userId', '=', host.userId)
              .execute()
          const auth = createAuth({
            pool: authPool,
            db,
            baseURL: url,
            secret: authSecret,
            signup,
            mailer: {
              send: async () => {
                throw new Error('No mail delivery in browser fixtures')
              },
            },
          })
          const key = await auth.api.createApiKey({
            body: {
              userId: host.userId,
              name: 'synthetic-browser-fixture',
              ...(teamRole && { metadata: { organizationId: team } }),
            },
          })
          // Keep the synthetic credential in this process; only owned product API calls receive it.
          authorization = `Bearer ${key.key}`
        },
        bookingState: async () => {
          const rows = await db
            .selectFrom('bookings')
            .select(['id', 'rescheduled_from_id', 'idempotency_fingerprint'])
            .execute()
          let originalFingerprintPreserved = true
          for (const row of rows) {
            if (!row.idempotency_fingerprint) continue
            const first = firstFingerprints.get(row.id)
            if (first) originalFingerprintPreserved &&= first.equals(row.idempotency_fingerprint)
            else firstFingerprints.set(row.id, Buffer.from(row.idempotency_fingerprint))
          }
          const attendees = await db
            .selectFrom('booking_attendees')
            .select('locale')
            .where('is_booker', '=', true)
            .execute()
          return {
            total: rows.length,
            roots: rows.filter((row) => row.rescheduled_from_id === null).length,
            successors: rows.filter((row) => row.rescheduled_from_id !== null).length,
            fingerprints: rows.filter((row) => row.idempotency_fingerprint !== null).length,
            originalFingerprintPreserved,
            bookerLocales: attendees.map((row) => row.locale),
          }
        },
        rows: () =>
          db.selectFrom('bookings').select(['source', 'status']).orderBy('created_at').execute(),
      })
      expect(externalRequests, 'No external browser request is permitted').toBe(0)
    } finally {
      try {
        try {
          await parentListener?.close()
        } finally {
          try {
            await app?.close()
          } finally {
            await appListener?.close()
          }
        }
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
            } catch (error) {
              absent = (error as { code?: string }).code === '3D000'
            }
            expect(absent, 'The helper-owned database must no longer exist').toBe(true)
          } finally {
            await verification.end()
          }
          await appListener?.assertClosed()
          await parentListener?.assertClosed()
        }
      }
      console.log('Fixture cleanup verified: database absent and owned listeners closed')
    }
  },
})
export { expect }
export async function pickSlot(scope: Page | Locator | FrameLocator, page: Page) {
  for (let month = 0; month < 4; month++) {
    await expect(scope.locator('.calendar-month')).toBeVisible()
    await expect(scope.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
    const days = scope.locator('button.day-available')
    const cutoff = Temporal.Now.plainDateISO('UTC').add({ days: 2 }).toString()
    for (let index = 0; index < (await days.count()); index++) {
      const day = days.nth(index),
        date = await day.getAttribute('data-day')
      if (date && date >= cutoff) {
        await day.click()
        await scope.locator('.slots button').first().click()
        return
      }
    }
    const slots = page.waitForResponse((r) => r.url().includes('/slots') && r.status() === 200)
    await scope.getByRole('button', { name: /^(Next month|下个月)$/ }).click()
    await slots
  }
  throw new Error('No fixture availability within four months')
}
export async function fillInvitee(scope: Page | Locator | FrameLocator) {
  await scope.getByLabel(/^(Your name|你的姓名)$/, { exact: true }).fill('Fixture Invitee')
  await scope.getByLabel(/^(Email|邮箱)$/, { exact: true }).fill('fixture-invitee@hourmere.invalid')
}
