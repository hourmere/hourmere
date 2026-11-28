import '@hono/zod-openapi'
// Independent accepted operation table, exercised through real key authentication and
// every composed REST route. Providers use the repository transport fake only.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  API_KEY_REST_OPERATIONS,
  type ApiKeyScope,
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import {
  beginGoogleConnection,
  configureCalendar,
  finishGoogleConnection,
} from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createRoutingForm,
  getScheduleAvailability,
  publishRoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { createSlackDestination, createWebhook } from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import {
  calendarTestSession,
  fakeGoogle,
  TEST_CALENDAR_KEY,
} from '../../../packages/calendars/src/testing.ts'
import { createOneTimeBookingLink } from '../../../packages/scheduling/src/one-time-links.ts'
import { createApp } from './app.ts'
import { productRoutes } from './server.ts'

const scopes = ['full', 'read', 'bookings'] as const
const customRoleOperations = [
  'GET /api/v1/teams/{teamId}/permissions',
  'GET /api/v1/teams/{teamId}/roles',
  'POST /api/v1/teams/{teamId}/roles',
  'GET /api/v1/teams/{teamId}/roles/{roleId}',
  'PATCH /api/v1/teams/{teamId}/roles/{roleId}',
  'DELETE /api/v1/teams/{teamId}/roles/{roleId}',
  'PUT /api/v1/teams/{teamId}/members/{memberId}/custom-role',
] as const
// Do not derive expectations from the production registry being tested.
const classes = {
  booking_read: [
    'GET /api/v1/meeting-polls',
    'GET /api/v1/meeting-polls/{id}',
    'GET /api/v1/meeting-polls/{id}/results',
    'POST /api/v1/public/meeting-polls/read',
    'POST /api/v1/open-time-snippets',
    'GET /api/v1/book/{token}',
    'GET /api/v1/book/{token}/slots',
    'GET /api/v1/bookings',
    'GET /api/v1/bookings/{id}/attendees',
    'GET /api/v1/group-occurrences/{id}/attendees',
    'GET /api/v1/bookings/{id}',
    'GET /api/v1/bookings/{id}/slots',
    'GET /api/v1/bookings/manage',
    'GET /api/v1/bookings/manage/slots',
    'GET /api/v1/event-types',
    'GET /api/v1/event-types/{id}',
    'GET /api/v1/me',
    'GET /api/v1/profile',
    'GET /api/v1/public/{handle}',
    'GET /api/v1/public/-/routing/{handle}/{slug}',
    'GET /api/v1/public/-/routing/teams/{teamSlug}/{slug}',
    'GET /api/v1/public/{handle}/{slug}',
    'GET /api/v1/public/{handle}/{slug}/slots',
    'POST /api/v1/public/checkout/status',
    'GET /api/v1/public/teams/{handle}/{slug}',
    'GET /api/v1/public/teams/{handle}',
    'GET /api/v1/public/teams/{handle}/{slug}/slots',
  ],
  booking_write: [
    'POST /api/v1/meeting-polls',
    'POST /api/v1/meeting-polls/{id}/invitations',
    'POST /api/v1/meeting-polls/{id}/invitations/{voterId}/resend',
    'DELETE /api/v1/meeting-polls/{id}/voters/{voterId}',
    'POST /api/v1/meeting-polls/{id}/remove-unverified',
    'POST /api/v1/meeting-polls/{id}/rotate-link',
    'POST /api/v1/meeting-polls/{id}/close',
    'POST /api/v1/meeting-polls/{id}/cancel',
    'DELETE /api/v1/meeting-polls/{id}',
    'POST /api/v1/meeting-polls/{id}/finalize',
    'POST /api/v1/public/-/routing/{handle}/{slug}/route',
    'POST /api/v1/public/-/routing/teams/{teamSlug}/{slug}/route',
    'POST /api/v1/routing-continuations/resolve',
    'POST /api/v1/routing-continuations/slots',
    'POST /api/v1/routing-continuations/bookings',
    'POST /api/v1/public/meeting-polls/enroll',
    'POST /api/v1/public/meeting-polls/recover',
    'POST /api/v1/public/meeting-polls/verify',
    'POST /api/v1/public/meeting-polls/vote',
    'POST /api/v1/public/meeting-polls/withdraw',
    'POST /api/v1/public/meeting-polls/reminder-opt-out',

    'POST /api/v1/event-types/{eventTypeId}/one-time-links',
    'DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'POST /api/v1/book/{token}/bookings',
    'POST /api/v1/bookings/{id}/calendar-copy/retry',
    'POST /api/v1/bookings/{id}/cancel',
    'POST /api/v1/group-occurrences/{id}/cancel',
    'PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show',
    'POST /api/v1/bookings/{id}/conference/retry',
    'POST /api/v1/bookings/{id}/reschedule',
    'POST /api/v1/bookings/{id}/request-reschedule',
    'POST /api/v1/bookings/manage/cancel',
    'POST /api/v1/bookings/manage/reschedule',
    'POST /api/v1/public/{handle}/{slug}/bookings',
    'POST /api/v1/public/{handle}/{slug}/checkout',
    'POST /api/v1/public/checkout/cancel',
    'POST /api/v1/public/teams/{handle}/{slug}/bookings',
    'POST /api/v1/public/{handle}/{slug}/waitlist',
    'POST /api/v1/public/{handle}/{slug}/waitlist/resend',
    'POST /api/v1/public/teams/{handle}/{slug}/waitlist',
    'POST /api/v1/public/teams/{handle}/{slug}/waitlist/resend',
  ],
  other_read: [
    'GET /api/v1/routing-forms',
    'GET /api/v1/routing-forms/{id}',
    'GET /api/v1/branding',
    'GET /api/v1/branding/logo/{hash}',
    'GET /api/v1/bookings/export.csv',
    'GET /api/v1/slack-destinations',
    'GET /api/v1/event-types/{eventTypeId}/one-time-links',
    'GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'GET /api/v1/analytics/bookings',
    'GET /api/v1/calendar-connections',
    'GET /api/v1/conference-connections',
    'GET /api/v1/event-type-hosts',
    'GET /api/v1/event-types/{id}/waitlist',
    'GET /api/v1/event-types/{id}/waitlist/entries',
    'GET /api/v1/schedules',
    'GET /api/v1/schedules/{id}',
    'GET /api/v1/schedules/{id}/availability',
    'GET /api/v1/schedules/{id}/overrides',
    'GET /api/v1/webhooks',
    'GET /api/v1/webhooks/{id}/deliveries',
    'GET /api/v1/workflows',
    'GET /api/v1/workflows/{id}',
    'GET /api/v1/workflows/{id}/runs',
    'GET /api/v1/team/sso/providers',
    'GET /api/v1/team/sso/policy',
  ],
  audit_read: ['GET /api/v1/audit-events', 'GET /api/v1/audit-log/settings'],
  other_write: [
    'POST /api/v1/routing-forms',
    'PATCH /api/v1/routing-forms/{id}',
    'DELETE /api/v1/routing-forms/{id}',
    'POST /api/v1/routing-forms/{id}/publish',
    'POST /api/v1/routing-forms/{id}/preview',
    'POST /api/v1/workflows',
    'POST /api/v1/workflows/preview',
    'PATCH /api/v1/workflows/{id}',
    'DELETE /api/v1/workflows/{id}',
    'PUT /api/v1/audit-log/settings',
    'PATCH /api/v1/branding',
    'POST /api/v1/branding/logo',
    'POST /api/v1/slack-destinations',
    'PATCH /api/v1/slack-destinations/{id}',
    'DELETE /api/v1/slack-destinations/{id}',
    'POST /api/v1/slack-destinations/{id}/test',
    'POST /api/v1/calendar-connections/{id}/refresh',
    'PUT /api/v1/calendar-destination',
    'PATCH /api/v1/calendars/{id}',
    'POST /api/v1/calendars/{id}/sync',
    'POST /api/v1/event-types',
    'POST /api/v1/event-types/{id}/duplicate',
    'DELETE /api/v1/event-types/{id}',
    'PATCH /api/v1/event-types/{id}',
    'PUT /api/v1/event-types/{id}/notifications',
    'PUT /api/v1/event-types/{id}/waitlist',
    'DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}',
    'POST /api/v1/event-types/{id}/round-robin/activate',
    'PUT /api/v1/profile',
    'PATCH /api/v1/profile/name',
    'POST /api/v1/schedules',
    'DELETE /api/v1/schedules/{id}',
    'PATCH /api/v1/schedules/{id}',
    'PUT /api/v1/schedules/{id}/availability',
    'PUT /api/v1/schedules/{id}/overrides/{date}',
    'DELETE /api/v1/schedules/{id}/overrides/{date}',
    'POST /api/v1/schedules/default',
    'POST /api/v1/webhooks',
    'DELETE /api/v1/webhooks/{id}',
    'PATCH /api/v1/webhooks/{id}',
    'POST /api/v1/webhooks/{id}/rotate-secret',
  ],
  session_only: [
    'POST /api/v1/team/sso/domains',
    'POST /api/v1/team/sso/domains/{domainId}/verify',
    'DELETE /api/v1/team/sso/domains/{domainId}',
    'POST /api/v1/team/sso/providers',
    'PATCH /api/v1/team/sso/providers/{providerId}',
    'DELETE /api/v1/team/sso/providers/{providerId}',
    'POST /api/v1/team/sso/providers/{providerId}/test',
    'POST /api/v1/team/sso/providers/{providerId}/activation',
    'PUT /api/v1/team/sso/policy',
    'POST /api/v1/team/sso/providers/{providerId}/link',
    'DELETE /api/v1/team/sso/providers/{providerId}/link',
    'DELETE /api/v1/team/sso/providers/{providerId}/links/{linkId}',
    'POST /api/v1/team/sso/delegations',
    'DELETE /api/v1/team/sso/delegations/{bindingId}',
    'POST /api/v1/team/sso/recovery',
    'POST /api/v1/team/sso/recovery/{enrollmentId}/accept',
    'POST /api/v1/team/sso/recovery/use',
    'GET /api/v1/organizations/{organizationId}/provisioning-tokens',
    'POST /api/v1/organizations/{organizationId}/provisioning-tokens',
    'POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate',
    'DELETE /api/v1/organizations/{organizationId}/provisioning-tokens/{id}',
    'GET /api/v1/bookings/{id}/organization',
    'DELETE /api/v1/calendar-connections/{id}',
    'POST /api/v1/calendar-connections/caldav/discover',
    'POST /api/v1/calendar-connections/caldav',
    'POST /api/v1/calendar-connections/google/authorize',
    'POST /api/v1/calendar-connections/microsoft/authorize',
    'DELETE /api/v1/conference-connections/{id}',
    'POST /api/v1/conference-connections/{id}/authorize-meetings',
    'POST /api/v1/conference-connections/{id}/reconnect',
    'POST /api/v1/conference-connections/{id}/refresh',
    'POST /api/v1/conference-connections/zoom/authorize',
    'POST /api/v1/conference-connections/zoom/authorize-meetings',
    'GET /api/v1/instance/embed',
    'GET /api/v1/mcp-oauth/connections',
    'DELETE /api/v1/mcp-oauth/connections/{id}',
    'POST /api/v1/mcp-oauth/consent',
    'POST /api/v1/mcp-oauth/request',
    'POST /api/v1/mcp-oauth/select',
    'GET /api/v1/readiness/self',
    'GET /api/v1/team/bookings',
    'GET /api/v1/team/bookings/{id}',
    'POST /api/v1/team/bookings/{id}/cancel',
    'GET /api/v1/team/bookings/{id}/handoff-preview',
    'POST /api/v1/team/bookings/{id}/handoff-offers',
    'GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}',
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw',
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend',
    'POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply',
    'POST /api/v1/team/bookings/bulk-cancellations/preview',
    'POST /api/v1/team/bookings/bulk-cancellations/{id}/confirm',
    'GET /api/v1/team/bookings/bulk-cancellations/{id}',
    'GET /api/v1/team/invitations',
    'GET /api/v1/team/invitations/{invitationId}',
    'POST /api/v1/team/invitations/{invitationId}/cancel',
    'GET /api/v1/team/member-removals/{operationId}',
    'GET /api/v1/team/members/{memberUserId}/departure-impact',
    'POST /api/v1/team/members/{memberUserId}/removal',
    'GET /api/v1/team/members/{memberUserId}/removal-handling',
    'POST /api/v1/teams/{teamId}/leave',
    'GET /api/v1/teams/{teamId}/member-readiness',
    'GET /api/v1/teams/{teamId}/readiness',
    ...customRoleOperations,
  ],
  diagnostic_read: ['GET /api/v1/event-types/{id}/availability-troubleshooting'],
  public_metadata: [
    'GET /api/v1/instance',
    'GET /api/v1/openapi.json',
    'GET /api/v1/public/branding/{organizationId}/logo/{hash}',
  ],
} as const
type Class = keyof typeof classes
const allowed: Record<Class, readonly ApiKeyScope[]> = {
  booking_read: scopes,
  booking_write: ['full', 'bookings'],
  other_read: ['full', 'read'],
  other_write: ['full'],
  audit_read: ['full'],
  diagnostic_read: ['full'],
  session_only: [],
  public_metadata: scopes,
}
const cases = Object.entries(classes).flatMap(([kind, operations]) =>
  operations.flatMap((operation) =>
    scopes.map((scope) => ({ operation, kind: kind as Class, scope })),
  ),
)
const denied = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const secret = 'synthetic-rest-scope-matrix-secret-000000000000000000'
const publicUrl = 'http://localhost:4184'
const webhookSettings = { enabled: true, encryptionKey: TEST_CALENDAR_KEY }

describe.skipIf(!process.env.DATABASE_URL)(
  'every REST operation with persisted scoped keys',
  () => {
    let database: TestDatabase
    let db: Db
    let auth: Auth
    let authPool: ReturnType<typeof createAuthPool>
    let f: Fixtures
    let owner: Awaited<ReturnType<typeof calendarTestSession>>
    let teamId: string
    let mainEvent: string
    let mainWebhook: string
    let calendarId: string
    let connectionId: string
    let google: ReturnType<typeof fakeGoogle>
    let fullPrincipal: Principal
    let app: ReturnType<typeof createApp>
    let date: string
    let routeToken: string
    let routingForm: { id: string; versionId: string }
    let sequence = 0
    const keys = new Map<ApiKeyScope, string>()
    const personalKeys = new Map<ApiKeyScope, string>()

    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'scope_rest_all',
      })
      db = createDb(database.pool)
      f = createFixtures(db)
      owner = await calendarTestSession(db)
      await db
        .insertInto('profiles')
        .values({ user_id: owner.user.id, handle: 'rest-scoped-host', time_zone: 'UTC' })
        .execute()
      await f.schedule(owner.user.id, { timeZone: 'UTC' })
      teamId = await f.organization('rest-scoped-team')
      await f.member(owner.user.id, teamId, 'owner')
      mainEvent = await f.eventType(teamId, null, {
        slug: 'intro',
        hosts: [{ userId: owner.user.id }],
      })
      const personalEvent = await f.eventType(owner.organization.id, owner.user.id, {
        slug: 'intro',
      })
      const today = Temporal.Now.plainDateISO('UTC')
      date = today.add({ days: 7 + ((8 - today.dayOfWeek) % 7) }).toString()
      const signup = { mode: 'closed', allowedDomains: [] } as const
      authPool = createAuthPool(database.url, signup)
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: publicUrl,
        secret,
        signup,
        mailer: {
          send: async () => {
            throw Error('No mail delivery in scope matrix')
          },
        },
      })
      for (const scope of scopes)
        keys.set(
          scope,
          (
            await auth.api.createApiKey({
              body: { userId: owner.user.id, metadata: { scope, organizationId: teamId } },
            })
          ).key,
        )
      // Exports permit scoped keys only for the owner's personal organization.
      for (const scope of scopes)
        personalKeys.set(
          scope,
          (
            await auth.api.createApiKey({
              body: {
                userId: owner.user.id,
                metadata: { scope, organizationId: owner.organization.id },
              },
            })
          ).key,
        )
      const resolveCaller = createCallerResolver({ auth, db })
      const resolved = await resolveCaller(
        new Headers({ authorization: `Bearer ${keys.get('full')}` }),
      )
      if (!resolved.ok) throw Error('Fixture key must authenticate')
      fullPrincipal = resolved.principal
      for (const principal of [owner, fullPrincipal]) {
        const context = { db, principal, now: () => Temporal.Now.instant() }
        const form = await createRoutingForm(context, {
          slug: 'scope-matrix',
          title: 'Public routing scope matrix',
          fallback: principal.organization.personal
            ? { kind: 'event', eventTypeId: personalEvent }
            : { kind: 'message', message: 'Thanks' },
        })
        const publication = await publishRoutingForm(context, form.id, {
          expectedRevision: form.draftRevision,
        })
        await updateRoutingForm(context, form.id, {
          expectedRevision: publication.form.draftRevision,
          enabled: true,
        })
        if (principal.organization.personal) {
          routingForm = { id: form.id, versionId: publication.version.id }
          const outcome = await submitRoutingForm(
            { db, routingFormsEnabled: true, routingSecret: secret },
            { formId: form.id, organizationId: principal.organization.id },
            { versionId: publication.version.id, answers: {} },
          )
          if (outcome.kind !== 'continuation') throw Error('Fixture must issue a continuation')
          routeToken = outcome.routeToken
        }
      }
      mainWebhook = (
        await createWebhook(
          { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
          webhookSettings,
          { url: 'https://example.com/scope-events', events: ['booking.created'] },
        )
      ).webhook.id
      google = fakeGoogle()
      google.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
      const calendar = { db, google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY } }
      const started = await beginGoogleConnection(calendar, owner, 'sync')
      expect(
        await finishGoogleConnection(
          calendar,
          owner,
          new URLSearchParams({
            state: new URL(started.authorizationUrl).searchParams.get('state') as string,
            code: 'synthetic-code',
          }),
        ),
      ).toBe('connected')
      const connected = await db
        .selectFrom('calendars')
        .select(['id', 'connection_id'])
        .executeTakeFirstOrThrow()
      calendarId = connected.id
      connectionId = connected.connection_id
      app = createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller,
        publicUrl,
        routes: productRoutes({
          db,
          slotSnippetsEnabled: true,
          teamPublicHomeOrganizationIds: [teamId],
          routingFormsEnabled: true,
          routingSecret: secret,
          scimProvisioningEnabled: true,
          // SSO reads answer sso_disabled before any scope check while hard-off; enable
          // them here so the matrix proves their scope enforcement.
          ssoOidcEnabled: true,
          mcpAuth: auth,
          publicUrl,
          googleCalendar: calendar.google,
          socialProviders: {},
          invitationMailLimits: { secret },
          waitlistSecret: secret,
          meetingPollSecret: secret,
          smtpConfigured: true,
          webhooks: webhookSettings,
          webhookQueue: { enqueue: async () => randomUUID() },
        }),
      })
    }, 30_000)
    afterAll(async () => {
      await authPool?.end()
      await database?.drop()
    })

    async function prepare(operation: string, kind: Class, scope: ApiKeyScope) {
      const [method, template] = operation.split(' ') as [string, string]
      let path = template
      let id = mainEvent
      let payload: unknown = method === 'GET' || method === 'DELETE' ? undefined : {}
      const headers: Record<string, string> = {}
      let expectedStatus = 200
      let cleanupEvent: string | undefined
      let cleanupSchedule: string | undefined
      let cleanupWebhook: string | undefined
      let cleanupOneTimeLink: string | undefined
      const start = `${date}T09:00:00Z`
      const end = `${date}T17:00:00Z`
      const nonce = `matrix-${++sequence}`
      if (template === '/api/v1/meeting-polls' && method === 'POST') {
        expectedStatus = 404
        headers['idempotency-key'] = randomUUID()
        payload = {
          eventTypeId: randomUUID(),
          candidateStarts: [start, end],
          deadlineAt: `${date}T07:00:00Z`,
          displayTimeZone: 'UTC',
          admissionMode: 'public_link',
        }
      }
      if (template.startsWith('/api/v1/meeting-polls/{id}')) {
        id = randomUUID()
        path = path.replace('{voterId}', randomUUID())
        expectedStatus = 404
        if (template.endsWith('/finalize')) {
          const voterId = randomUUID()
          headers['idempotency-key'] = randomUUID()
          payload = {
            slotId: randomUUID(),
            bookerVoterId: voterId,
            attendeeVoterIds: [voterId],
            expectedResultsRevision: 1,
            expectedBallotRevisions: { [voterId]: 1 },
            acknowledgeConditional: false,
          }
        } else if (template.endsWith('/invitations')) {
          headers['idempotency-key'] = randomUUID()
          payload = { invitees: [{ name: 'Voter', email: 'voter@example.test' }] }
        } else if (method !== 'GET') {
          if (template.endsWith('/resend') || template.endsWith('/rotate-link'))
            headers['idempotency-key'] = randomUUID()
          payload = { expectedHostRevision: 1 }
        }
      }
      if (template.startsWith('/api/v1/public/meeting-polls/')) {
        payload = template.endsWith('/recover')
          ? { pollId: randomUUID(), email: 'missing@example.test' }
          : template.endsWith('/enroll')
            ? {
                publicToken: 'unavailable',
                name: 'Voter',
                email: 'voter@example.test',
                timeZone: 'UTC',
              }
            : template.endsWith('/vote')
              ? { token: 'unavailable', votes: [], consent: true, expectedBallotRevision: 0 }
              : template.endsWith('/withdraw')
                ? { token: 'unavailable', expectedBallotRevision: 0 }
                : { token: 'unavailable' }
        expectedStatus = template.endsWith('/recover') ? 202 : 404
      }
      if (template === '/api/v1/bookings/export.csv') path += `?from=${start}&to=${end}`
      if (kind === 'session_only') {
        if (customRoleOperations.some((route) => route === operation)) {
          return {
            method,
            path: path
              .replace('{teamId}', teamId)
              .replace('{roleId}', randomUUID())
              .replace('{memberId}', randomUUID()),
            payload,
            headers,
            expectedStatus: 404,
            nativeError: 'custom_roles_disabled',
          }
        }
        if (template === '/api/v1/team/sso/policy') {
          headers.origin = publicUrl
          headers['X-Expected-Organization-Id'] = teamId
          payload = { expectedRevision: 1, requireSso: true, admission: 'invitation_only' }
        }
        if (template === '/api/v1/team/sso/recovery/use') {
          headers.origin = publicUrl
          headers['X-Expected-Organization-Id'] = teamId
          payload = { expectedRevision: 1 }
        }
        path = path
          .replaceAll('{id}', randomUUID())
          .replaceAll('{providerId}', randomUUID())
          .replaceAll('{linkId}', randomUUID())
          .replaceAll('{bindingId}', randomUUID())
          .replaceAll('{enrollmentId}', randomUUID())
          .replaceAll('{offerId}', randomUUID())
          .replaceAll('{invitationId}', randomUUID())
          .replaceAll('{operationId}', randomUUID())
          .replaceAll('{memberUserId}', owner.user.id)
          .replaceAll('{teamId}', teamId)
          .replaceAll('{organizationId}', teamId)
        const bulkCancellationOff = template.startsWith('/api/v1/team/bookings/bulk-cancellations/')
        const error = bulkCancellationOff
          ? 'not_found'
          : template === '/api/v1/bookings/{id}/organization'
            ? 'booking_not_found'
            : template === '/api/v1/readiness/self'
              ? 'readiness_access_denied'
              : template === '/api/v1/instance/embed'
                ? 'embed_configuration_access_denied'
                : template.startsWith('/api/v1/team') || template.startsWith('/api/v1/teams')
                  ? 'team_management_access_denied'
                  : template.startsWith('/api/v1/conference-connections')
                    ? 'conference_session_required'
                    : 'session_required'
        return {
          method,
          path,
          payload,
          headers,
          expectedStatus: bulkCancellationOff || error === 'booking_not_found' ? 404 : 403,
          nativeError: error,
          cleanupEvent,
          cleanupSchedule,
          cleanupWebhook,
          cleanupOneTimeLink,
        }
      }
      if (
        template.startsWith('/api/v1/bookings/') &&
        (template.includes('{id}') || template.includes('/manage'))
      ) {
        cleanupEvent = await f.eventType(teamId, null, {
          slug: nonce,
          hosts: [{ userId: owner.user.id }],
        })
        id = await f.booking(teamId, [owner.user.id], start, `${date}T09:30:00Z`, {
          eventTypeId: cleanupEvent,
        })
        const token = randomBytes(32).toString('base64url')
        await db
          .updateTable('bookings')
          .set({ manage_token_hash: createHash('sha256').update(token).digest() })
          .where('id', '=', id)
          .execute()
        headers['x-manage-token'] = token
        if (template.endsWith('/no-show')) {
          await db
            .updateTable('bookings')
            .set({ start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T09:30:00Z' })
            .where('id', '=', id)
            .execute()
          const attendee = await db
            .selectFrom('booking_attendees')
            .select('id')
            .where('booking_id', '=', id)
            .executeTakeFirstOrThrow()
          path = path.replace('{attendeeId}', attendee.id)
          payload = { noShow: true }
        }
        if (template.endsWith('/slots')) path += `?start=${start}&end=${end}`
        if (template.endsWith('/request-reschedule')) payload = { idempotencyKey: randomUUID() }
        if (template.endsWith('/reschedule')) payload = { start: `${date}T10:00:00Z` }
        if (template.endsWith('/retry')) {
          await db
            .insertInto('booking_conferences')
            .values({
              root_booking_id: id,
              booking_id: id,
              organization_id: teamId,
              organizer_user_id: owner.user.id,
              calendar_id: calendarId,
              connection_id: connectionId,
              state: 'failed',
              error_code: 'conference_failed',
              external_event_id: nonce,
            })
            .execute()
          if (template.includes('/calendar-copy/'))
            await db
              .insertInto('booking_conference_mirrors')
              .values({
                root_booking_id: id,
                user_id: owner.user.id,
                calendar_id: calendarId,
                connection_id: connectionId,
                state: 'failed',
                error_code: 'provider_unavailable',
                external_event_id: `${nonce}-copy`,
              })
              .execute()
          expectedStatus = 204
        }
      } else if (template.startsWith('/api/v1/group-occurrences/')) {
        cleanupEvent = await f.eventType(teamId, null, {
          slug: nonce,
          hosts: [{ userId: owner.user.id }],
        })
        await db
          .updateTable('event_types')
          .set({ booking_mode: 'group', group_capacity: 2 })
          .where('id', '=', cleanupEvent)
          .execute()
        const groupEventId = cleanupEvent
        const slot = await db.transaction().execute(async (trx) => {
          const created = await trx
            .insertInto('group_slots')
            .values({
              organization_id: teamId,
              event_type_id: groupEventId,
              original_event_type_id: groupEventId,
              host_user_id: owner.user.id,
              start_at: start,
              end_at: `${date}T09:30:00Z`,
              capacity: 2,
              title: 'Group matrix',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          await trx
            .updateTable('group_slots')
            .set({ state: 'retired' })
            .where('id', '=', created.id)
            .execute()
          return created
        })
        id = slot.id
      } else if (template.startsWith('/api/v1/book/{token}')) {
        cleanupEvent = await f.eventType(teamId, null, {
          slug: nonce,
          hosts: [{ userId: owner.user.id }],
        })
        const link = await createOneTimeBookingLink(
          { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
          { eventTypeId: cleanupEvent },
        )
        cleanupOneTimeLink = link.id
        path = path.replace('{token}', link.token)
        if (template.endsWith('/no-show')) {
          await db
            .updateTable('bookings')
            .set({ start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T09:30:00Z' })
            .where('id', '=', id)
            .execute()
          const attendee = await db
            .selectFrom('booking_attendees')
            .select('id')
            .where('booking_id', '=', id)
            .executeTakeFirstOrThrow()
          path = path.replace('{attendeeId}', attendee.id)
          payload = { noShow: true }
        }
        if (template.endsWith('/slots')) path += `?start=${start}&end=${end}`
        if (method === 'POST') {
          payload = {
            start,
            invitee: { name: 'Matrix invitee', email: 'matrix@example.test', timeZone: 'UTC' },
          }
          expectedStatus = 201
        }
      } else if (template === '/api/v1/routing-continuations/bookings') {
        const outcome = await submitRoutingForm(
          { db, routingFormsEnabled: true, routingSecret: secret },
          { formId: routingForm.id, organizationId: owner.organization.id },
          { versionId: routingForm.versionId, answers: {} },
        )
        if (outcome.kind !== 'continuation') throw Error('Fixture must issue a continuation')
        payload = {
          routeToken: outcome.routeToken,
          start: `${date}T${scope === 'bookings' ? '11:30' : '11:00'}:00Z`,
          invitee: { name: 'Matrix invitee', email: 'matrix@example.test', timeZone: 'UTC' },
        }
        expectedStatus = 201
      } else if (template.startsWith('/api/v1/routing-continuations/')) {
        payload = { routeToken, ...(template.endsWith('/slots') && { start, end }) }
      } else if (template.startsWith('/api/v1/public/-/routing/')) {
        path = path
          .replace('{handle}', 'rest-scoped-host')
          .replace('{teamSlug}', 'rest-scoped-team')
          .replace('{slug}', 'scope-matrix')
        if (method === 'POST') {
          const form = await db
            .selectFrom('routing_forms')
            .select('published_version_id')
            .where(
              'organization_id',
              '=',
              template.includes('/teams/') ? teamId : owner.organization.id,
            )
            .where('slug', '=', 'scope-matrix')
            .executeTakeFirstOrThrow()
          payload = { versionId: form.published_version_id, answers: {} }
        }
      } else if (template === '/api/v1/public/{handle}/{slug}/checkout') {
        path = path.replace('{handle}', 'rest-scoped-host').replace('{slug}', 'intro')
        headers['idempotency-key'] = randomUUID()
        payload = {
          start,
          invitee: { name: 'Matrix invitee', email: 'matrix@example.test', timeZone: 'UTC' },
          expectedAmountMinor: 5000,
          expectedCurrency: 'usd',
        }
        expectedStatus = 409
      } else if (template.startsWith('/api/v1/public/checkout/')) {
        payload = { token: 'unavailable' }
        expectedStatus = 404
      } else if (
        template.startsWith('/api/v1/public/') &&
        !template.startsWith('/api/v1/public/meeting-polls/')
      ) {
        const team = template.includes('/teams/')
        path = path
          .replace('{handle}', team ? 'rest-scoped-team' : 'rest-scoped-host')
          .replace('{slug}', 'intro')
        if (template.endsWith('/no-show')) {
          await db
            .updateTable('bookings')
            .set({ start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T09:30:00Z' })
            .where('id', '=', id)
            .execute()
          const attendee = await db
            .selectFrom('booking_attendees')
            .select('id')
            .where('booking_id', '=', id)
            .executeTakeFirstOrThrow()
          path = path.replace('{attendeeId}', attendee.id)
          payload = { noShow: true }
        }
        if (template.endsWith('/slots')) path += `?start=${start}&end=${end}`
        if (method === 'POST') {
          cleanupEvent = await f.eventType(
            team ? teamId : owner.organization.id,
            team ? null : owner.user.id,
            { slug: nonce, hosts: [{ userId: owner.user.id }] },
          )
          path = path.replace('/intro/', `/${nonce}/`)
          payload = {
            start,
            invitee: { name: 'Matrix invitee', email: 'matrix@example.test', timeZone: 'UTC' },
          }
          expectedStatus = 201
          if (template.includes('/waitlist')) {
            await db
              .updateTable('event_types')
              .set({ waitlist_enabled: true })
              .where('id', '=', cleanupEvent)
              .execute()
            // Every matrix caller has a real schedule: choose a future weekend to exercise empty admission.
            let day = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
            while (day.dayOfWeek !== 7) day = day.add({ days: 1 })
            payload = template.endsWith('/resend')
              ? { email: `${nonce}@example.test` }
              : {
                  email: `${nonce}@example.test`,
                  consent: true,
                  preferredWindow: {
                    start: `${day}T00:00:00Z`,
                    end: `${day.add({ days: 1 })}T00:00:00Z`,
                    timeZone: 'UTC',
                  },
                }
            expectedStatus = 202
          }
        }
      } else if (template === '/api/v1/open-time-snippets') {
        payload = { eventTypeId: mainEvent, from: start, to: end }
      } else if (template.startsWith('/api/v1/schedules')) {
        if (template.includes('{id}')) {
          cleanupSchedule = await f.schedule(owner.user.id, {
            timeZone: 'UTC',
            isDefault: false,
            ...(method === 'DELETE' && template.includes('/overrides/')
              ? { overrides: [{ date, intervals: [] }] }
              : {}),
          })
          id = cleanupSchedule
        }
        if (operation === 'POST /api/v1/schedules') {
          payload = {
            name: nonce,
            timeZone: 'UTC',
            weeklyHours: { monday: [{ start: '09:00', end: '17:00' }] },
          }
          expectedStatus = 201
        }
        if (operation === 'PATCH /api/v1/schedules/{id}') payload = { name: nonce }
        if (operation === 'PUT /api/v1/schedules/{id}/availability') {
          const snapshot = await getScheduleAvailability(
            { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
            id,
          )
          payload = {
            name: nonce,
            timeZone: snapshot.schedule.timeZone,
            weeklyHours: { monday: [{ start: '10:00', end: '16:00' }] },
            overrides: [{ date, intervals: [] }],
            expectedVersion: snapshot.version,
          }
        }
        if (operation === 'PUT /api/v1/schedules/{id}/overrides/{date}') {
          payload = { intervals: [] }
          expectedStatus = 201
        }
        if (method === 'DELETE') expectedStatus = 204
      } else if (template.includes('/one-time-links')) {
        cleanupEvent = await f.eventType(teamId, null, {
          slug: nonce,
          hosts: [{ userId: owner.user.id }],
        })
        path = path.replace('{eventTypeId}', cleanupEvent)
        if (method === 'POST') {
          headers['Idempotency-Key'] = randomUUID()
          expectedStatus = 201
        } else {
          const link = await createOneTimeBookingLink(
            { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
            { eventTypeId: cleanupEvent },
          )
          cleanupOneTimeLink = link.id
          id = link.id
        }
      } else if (template.startsWith('/api/v1/event-types')) {
        if (method !== 'GET' && template.includes('{id}')) {
          cleanupEvent = await f.eventType(teamId, null, {
            slug: nonce,
            hosts: [{ userId: owner.user.id }],
          })
          id = cleanupEvent
        }
        if (method === 'POST' && template.endsWith('/activate'))
          await db
            .updateTable('event_types')
            .set({ scheduling_type: 'round_robin' })
            .where('id', '=', id)
            .execute()
        else if (method === 'POST' && template.endsWith('/duplicate')) {
          payload = {}
          expectedStatus = 201
        } else if (method === 'POST') {
          payload = {
            slug: nonce,
            title: 'Matrix event',
            durationMinutes: 30,
            hosts: [{ userId: owner.user.id }],
          }
          expectedStatus = 201
        }
        if (method === 'PATCH') payload = { title: 'Matrix updated event' }
        if (template.endsWith('/availability-troubleshooting')) path += `?date=${date}&timeZone=UTC`
        if (operation === 'PUT /api/v1/event-types/{id}/notifications')
          payload = {
            notifications: {
              reminders: [
                {
                  id: 'one-hour',
                  offsetMinutes: 60,
                  recipients: { invitee: true, guests: false, host: true },
                },
              ],
              followUps: [
                {
                  id: 'thanks',
                  offsetMinutes: 5,
                  recipients: { invitee: true, guests: false, host: false },
                  hostNote: 'Thank you for your time.',
                },
              ],
            },
          }
        if (operation === 'PUT /api/v1/event-types/{id}/waitlist') payload = { enabled: true }
        if (method === 'DELETE') expectedStatus = 204
        if (template.includes('/waitlist/entries/{entryId}')) {
          const createdAt = new Date()
          const windowEnd = new Date(createdAt.getTime() + 172800000)
          const entry = await db
            .insertInto('waitlist_entries')
            .values({
              organization_id: teamId,
              event_type_id: id,
              recipient_hash: Buffer.alloc(32, 1),
              email: 'matrix-waitlist@example.test',
              window_start: new Date(Date.now() + 86400000),
              window_end: windowEnd,
              created_at: createdAt,
              time_zone: 'UTC',
              locale: 'en',
              consent_version: 'waitlist-v1',
              consented_at: new Date(),
              expires_at: windowEnd,
              pending_expires_at: new Date(createdAt.getTime() + 86400000),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          path = path.replace('{entryId}', entry.id)
          expectedStatus = 200
        }
      } else if (template.startsWith('/api/v1/slack-destinations')) {
        if (template.includes('{id}')) {
          const destination = await createSlackDestination(
            { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
            webhookSettings,
            {
              url: 'https://hooks.slack.com/services/Tfixture/Bfixture/matrix-secret',
              events: ['booking.created'],
            },
          )
          id = destination.id
          cleanupWebhook = id
        }
        if (operation === 'POST /api/v1/slack-destinations') {
          payload = {
            url: 'https://hooks.slack.com/services/Tfixture/Bfixture/matrix-secret',
            events: ['booking.created'],
          }
          expectedStatus = 201
        }
        if (method === 'PATCH') payload = { isActive: false }
        if (method === 'DELETE') expectedStatus = 204
        if (operation === 'POST /api/v1/slack-destinations/{id}/test') expectedStatus = 202
      } else if (template.startsWith('/api/v1/webhooks')) {
        id = mainWebhook
        if (method !== 'GET' && template.includes('{id}'))
          id = (
            await createWebhook(
              { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
              webhookSettings,
              { url: `https://example.com/${nonce}`, events: ['booking.created'] },
            )
          ).webhook.id
        if (method !== 'GET' && template.includes('{id}')) cleanupWebhook = id
        if (operation === 'POST /api/v1/webhooks') {
          payload = { url: `https://example.com/${nonce}`, events: ['booking.created'] }
          expectedStatus = 201
        }
        if (method === 'PATCH') payload = { isActive: false }
        if (method === 'DELETE') expectedStatus = 204
      } else if (template.startsWith('/api/v1/routing-forms')) {
        const input = {
          slug: nonce,
          title: 'Routing scope matrix',
          fallback: { kind: 'message', message: 'Thanks' },
        }
        if (template.includes('{id}'))
          id = (
            await createRoutingForm(
              { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
              input,
            )
          ).id
        if (template.endsWith('/preview')) {
          payload = { answers: {} }
        } else if (method === 'POST') {
          payload = template.endsWith('/publish') ? { expectedRevision: 1 } : input
          expectedStatus = 201
        }
        if (method === 'PATCH') payload = { expectedRevision: 1, title: 'Updated' }
        if (method === 'DELETE') {
          payload = { expectedRevision: 1 }
          expectedStatus = 204
        }
      } else if (template.startsWith('/api/v1/workflows')) {
        // Operator-off permits authorized recovery and rejects creation, preview and edits.
        if (operation === 'GET /api/v1/workflows') {
          path += `?ownerKind=team&ownerId=${teamId}`
        } else {
          id = randomUUID()
          expectedStatus = 404
          if (method === 'DELETE') payload = { expectedRevision: 1 }
        }
      } else if (operation === 'GET /api/v1/analytics/bookings')
        path += `?startDate=${date}&endDate=${date}&timeZone=UTC`
      else if (operation === 'PUT /api/v1/profile')
        payload = { handle: 'rest-scoped-host', timeZone: 'UTC', locale: 'en' }
      else if (operation === 'PATCH /api/v1/profile/name') payload = { name: 'Matrix host' }
      else if (operation === 'POST /api/v1/calendar-connections/{id}/refresh') {
        id = connectionId
        expectedStatus = 204
      } else if (operation === 'PUT /api/v1/calendar-destination') {
        payload = { calendarId: null }
        expectedStatus = 204
      } else if (operation === 'PATCH /api/v1/calendars/{id}') {
        id = calendarId
        payload = { checkConflicts: false }
        expectedStatus = 204
      } else if (operation === 'POST /api/v1/calendars/{id}/sync') {
        id = calendarId
        await configureCalendar(
          { db, google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY } },
          owner,
          id,
          true,
        )
        expectedStatus = 204
      }
      if (operation === 'PATCH /api/v1/branding') payload = { brandPrimaryColor: '#123456' }
      if (operation === 'PUT /api/v1/audit-log/settings') payload = { retention: 'forever' }
      if (
        operation === 'POST /api/v1/branding/logo' ||
        operation === 'GET /api/v1/branding/logo/{hash}' ||
        operation === 'GET /api/v1/public/branding/{organizationId}/logo/{hash}'
      ) {
        const { default: sharp } = await import('sharp')
        const image = await sharp({
          create: { width: 2, height: 2, channels: 4, background: '#123456' },
        })
          .png()
          .toBuffer()
        if (method === 'POST') {
          payload = image
          headers['content-type'] = 'image/png'
        } else {
          const { uploadBrandLogo } = await import('@hourmere/scheduling')
          const branding = await uploadBrandLogo(
            { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
            image,
            'image/png',
          )
          path = path
            .replace('{hash}', branding.brandLogo as string)
            .replace('{organizationId}', fullPrincipal.organization.id)
        }
      }
      path = path.replace('{id}', id).replace('{date}', date)
      return {
        method,
        path,
        payload,
        headers,
        expectedStatus,
        nativeError: undefined,
        cleanupEvent,
        cleanupSchedule,
        cleanupWebhook,
        cleanupOneTimeLink,
      }
    }

    it('covers the exact 209-operation contract and all 627 scope combinations', () => {
      const ids = Object.values(classes).flat()
      expect(ids).toHaveLength(209)
      expect(new Set(ids).size).toBe(209)
      expect([...ids].sort()).toEqual(
        API_KEY_REST_OPERATIONS.map((operation) => operation.id).sort(),
      )
      expect(cases).toHaveLength(627)
    })

    it.each(cases)('$scope $operation', async ({ operation, kind, scope }) => {
      const fixture = await prepare(operation, kind, scope)
      const beforeProvider = google.calls.length
      try {
        const response = await app.request(
          fixture.path,
          {
            method: fixture.method,
            headers: {
              authorization: `Bearer ${(operation === 'GET /api/v1/bookings/export.csv' ? personalKeys : keys).get(scope)}`,
              'content-type': 'application/json',
              ...fixture.headers,
            },
            ...(fixture.payload === undefined
              ? {}
              : {
                  body: Buffer.isBuffer(fixture.payload)
                    ? new Uint8Array(fixture.payload)
                    : JSON.stringify(fixture.payload),
                }),
          },
          { incoming: { socket: { remoteAddress: `192.0.2.${(sequence % 250) + 1}` } } },
        )
        if (kind === 'session_only') {
          expect(response.status).toBe(fixture.expectedStatus)
          const body = await response.json()
          expect(body).toMatchObject({ error: fixture.nativeError })
          if (operation === 'GET /api/v1/instance/embed') {
            expect(body).toEqual({ error: 'embed_configuration_access_denied' })
            expect(response.headers.get('vary')).toBe('Cookie, Authorization')
          }
          expect(google.calls.length).toBe(beforeProvider)
        } else if (!allowed[kind].includes(scope)) {
          expect(response.status).toBe(403)
          expect(await response.json()).toEqual(denied)
          if (operation === 'PUT /api/v1/schedules/{id}/availability') {
            const snapshot = await getScheduleAvailability(
              { db, principal: fullPrincipal, now: () => Temporal.Now.instant() },
              fixture.cleanupSchedule as string,
            )
            expect(snapshot.version).toBe(
              (fixture.payload as { expectedVersion: string }).expectedVersion,
            )
          }
          expect(google.calls.length).toBe(beforeProvider)
        } else {
          expect(response.status).toBe(fixture.expectedStatus)
          if (
            operation === 'GET /api/v1/branding/logo/{hash}' ||
            operation === 'GET /api/v1/public/branding/{organizationId}/logo/{hash}'
          ) {
            expect(response.headers.get('content-type')).toBe('image/png')
          } else if (operation === 'GET /api/v1/bookings/export.csv') {
            expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
            expect(await response.text()).toMatch(/^id,event_type_id,event_type,title,/)
          } else if (operation === 'GET /api/v1/workflows') {
            expect(await response.json()).toEqual({ data: [], nextCursor: null })
          } else if (operation.includes(' /api/v1/workflows')) {
            const error =
              fixture.method === 'GET' || fixture.method === 'DELETE'
                ? 'workflow_not_found'
                : 'workflows_disabled'
            expect(await response.json()).toMatchObject({ error })
          } else if (operation === 'POST /api/v1/meeting-polls') {
            expect(await response.json()).toEqual({ error: 'event_type_not_found' })
          } else if (operation === 'POST /api/v1/public/{handle}/{slug}/checkout') {
            expect(await response.json()).toMatchObject({ error: 'paid_bookings_disabled' })
          } else if (operation.startsWith('POST /api/v1/public/checkout/')) {
            expect(await response.json()).toMatchObject({ error: 'payment_checkout_not_found' })
          } else if (operation.includes('/meeting-polls/') && response.status === 404) {
            expect(await response.json()).toMatchObject({ error: 'poll_not_found' })
          } else if (response.status !== 204) {
            const data = await response.json()
            expect(data).not.toHaveProperty('error')
            if (operation === 'PUT /api/v1/event-types/{id}/notifications')
              expect(data).toMatchObject(fixture.payload as { notifications: unknown })
            if (operation === 'PUT /api/v1/schedules/{id}/availability') {
              const input = fixture.payload as {
                name: string
                weeklyHours: unknown
                overrides: unknown
                expectedVersion: string
              }
              expect(data).toMatchObject({
                schedule: { name: input.name, weeklyHours: input.weeklyHours },
                overrides: input.overrides,
              })
              expect(data).toHaveProperty('version', expect.stringMatching(/^[a-f0-9]{64}$/))
              expect(data).not.toHaveProperty('version', input.expectedVersion)
            }
            if (operation === 'GET /api/v1/schedules/{id}/availability') {
              expect(data).toMatchObject({
                schedule: { id: fixture.cleanupSchedule },
                overrides: [],
                version: expect.stringMatching(/^[a-f0-9]{64}$/),
              })
            }
            if (operation === 'POST /api/v1/schedules')
              await db
                .deleteFrom('schedules')
                .where('id', '=', (data as { id: string }).id)
                .execute()
            if (
              operation.startsWith('POST /api/v1/slack-destinations') ||
              operation === 'GET /api/v1/slack-destinations' ||
              operation === 'PATCH /api/v1/slack-destinations/{id}'
            )
              expect(JSON.stringify(data)).not.toContain('matrix-secret')
            if (operation === 'POST /api/v1/slack-destinations')
              await db
                .deleteFrom('webhooks')
                .where('id', '=', (data as { id: string }).id)
                .execute()
            if (operation === 'POST /api/v1/webhooks')
              await db
                .deleteFrom('webhooks')
                .where('id', '=', (data as { webhook: { id: string } }).webhook.id)
                .execute()
          }
        }
        if (operation === 'POST /api/v1/event-types/{eventTypeId}/one-time-links') {
          const issued = await db
            .selectFrom('one_time_booking_links')
            .select('id')
            .where('event_type_id', '=', fixture.cleanupEvent as string)
            .execute()
          expect(issued).toHaveLength(allowed[kind].includes(scope) ? 1 : 0)
          fixture.cleanupOneTimeLink = issued[0]?.id
        }
        if (fixture.cleanupOneTimeLink) {
          const link = await db
            .selectFrom('one_time_booking_links')
            .select(['state', 'booking_id'])
            .where('id', '=', fixture.cleanupOneTimeLink)
            .executeTakeFirstOrThrow()
          const consumed =
            operation === 'POST /api/v1/book/{token}/bookings' && allowed[kind].includes(scope)
          const revoked =
            operation === 'DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}' &&
            allowed[kind].includes(scope)
          expect(link.state).toBe(consumed ? 'used' : revoked ? 'revoked' : 'active')
          expect(link.booking_id !== null).toBe(consumed)
        }
        expect(response.headers.get('cache-control')).toBe(
          operation === 'GET /api/v1/public/branding/{organizationId}/logo/{hash}'
            ? 'public, max-age=31536000, immutable'
            : operation === 'GET /api/v1/instance/embed' ||
                operation.includes('/provisioning-tokens') ||
                operation.includes('/public/meeting-polls/') ||
                (operation === 'GET /api/v1/branding/logo/{hash}' && response.ok)
              ? 'private, no-store'
              : 'no-store',
        )
      } finally {
        // Remove the exact fixture capability before its consuming booking: used-link
        // evidence deliberately prevents deleting that booking on its own.
        if (fixture.cleanupOneTimeLink)
          await db
            .deleteFrom('one_time_booking_links')
            .where('id', '=', fixture.cleanupOneTimeLink)
            .execute()
        if (fixture.cleanupEvent)
          await db
            .deleteFrom('bookings')
            .where('event_type_id', '=', fixture.cleanupEvent)
            .execute()
        if (fixture.cleanupSchedule)
          await db.deleteFrom('schedules').where('id', '=', fixture.cleanupSchedule).execute()
        if (fixture.cleanupWebhook)
          await db.deleteFrom('webhooks').where('id', '=', fixture.cleanupWebhook).execute()
      }
    })
  },
)
