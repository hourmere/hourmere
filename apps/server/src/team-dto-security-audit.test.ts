import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { catalogTools } from './mcp/catalog.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { memberDepartureImpactRoutes } from './routes/member-departure-impact.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { publicRoutes } from './routes/public.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'
import { webhookRoutes } from './routes/webhooks.ts'

const adminUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43829'
const secret = 'synthetic-team-dto-audit-secret-0000000000000000000'
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
const orgKeys = ['createdAt', 'id', 'logo', 'metadata', 'name', 'slug']
const memberKeys = ['createdAt', 'id', 'organizationId', 'role', 'userId']
const invitationKeys = [
  'createdAt',
  'email',
  'expiresAt',
  'id',
  'inviterId',
  'organizationId',
  'role',
  'status',
]
const invitationSummaryKeys = [
  'id',
  'email',
  'status',
  'invalidReason',
  'createdAt',
  'expiresAt',
  'delivery',
  'resendAllowed',
  'generation',
  'resendDeniedReason',
  'resendRetryAfterSeconds',
]
const bookingKeys = [
  'attendees',
  'cancelledAt',
  'end',
  'eventType',
  'hosts',
  'id',
  'start',
  'status',
]
const privateMarker = 'synthetic-private-dto-canary'
const eventKeys = [
  'id',
  'organizationId',
  'ownerUserId',
  'slug',
  'title',
  'description',
  'durationMinutes',
  'slotStepMinutes',
  'bufferBeforeMinutes',
  'bufferAfterMinutes',
  'minimumNoticeMinutes',
  'bookingWindowDays',
  'maxBookingsPerDay',
  'location',
  'questions',
  'isActive',
  'isHidden',
  'allowGuests',
  'position',
  'schedulingType',
  'roundRobinActive',
  'hosts',
  'conferenceOrganizer',
  'scheduleId',
  'createdAt',
  'updatedAt',
]
const hostBookingKeys = [
  'id',
  'eventTypeId',
  'status',
  'start',
  'end',
  'title',
  'eventTypeTitle',
  'location',
  'responses',
  'attendees',
  'rescheduledFromId',
  'rescheduledToId',
  'cancelledAt',
  'cancelReason',
  'source',
  'createdAt',
]
const managedBookingKeys = hostBookingKeys
  .filter((key) => key !== 'eventTypeTitle' && key !== 'rescheduledToId')
  .concat(['eventType', 'hosts'])
const slotRange = 'start=2026-11-04T00:00:00Z&end=2026-11-05T00:00:00Z'

// biome-ignore lint/suspicious/noExplicitAny: Assert exact runtime key sets independently of generated response types.
type Json = Record<string, any>
function keys(value: Json, expected: string[]) {
  expect(Object.keys(value).sort()).toEqual([...expected].sort())
}

// Every request uses the real resolver, native Better Auth endpoint and PostgreSQL.
// One helper pool (10), one auth pool (10) and its lock pool (2) are reused and closed.
describe.skipIf(!adminUrl)('team launch DTO and selector security audit', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: ReturnType<typeof createApp>
  let fixture: Awaited<ReturnType<typeof seed>>

  beforeAll(async () => {
    owned = await createTestDatabase(adminUrl as string, undefined, { tag: 'team_dto_audit' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    app = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      mcp: mcpEndpoint({
        tools: [...catalogTools({ db }), ...bookingTools({ db, now: () => now })],
      }),
      routes: [
        eventTypeRoutes({ db, now: () => now }),
        bookingRoutes({ db, now: () => now }),
        publicRoutes({ db, now: () => now }),
        analyticsRoutes({ db, now: () => now }),
        webhookRoutes({
          db,
          now: () => now,
          enabled: true,
          encryptionKey: Buffer.alloc(32, 6).toString('base64'),
        }),
        teamBookingRoutes({ db, now: () => now }),
        teamInvitationRoutes({
          db,
          invitationMailLimits: {
            secret,
            invitationInviterMaxPerHour: 100,
            invitationInviterMaxPerDay: 200,
            invitationTeamMaxPerHour: 100,
            invitationTeamMaxPerDay: 200,
            mailRecipientMaxPerHour: 100,
            mailRecipientMaxPerDay: 200,
            mailMaxPerHour: 1000,
          },
        }),
        memberDepartureImpactRoutes({ db, now: () => now }),
        memberRemovalRoutes({ db, now: () => now }),
        readinessRoutes({ db, now: () => now }),
      ],
    })
    fixture = await seed()
  })
  beforeEach(async () => {
    for (const actor of fixture.actors) {
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: fixture.team.id })
        .where('id', '=', actor.sessionId)
        .execute()
    }
  })
  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function session(user: TestUser, teamId: string) {
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: teamId,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      user,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  async function seed() {
    const users = await Promise.all(
      ['Owner', 'Admin', 'Member', 'Outsider', 'Recipient'].map((name) =>
        createTestUser(db, `Audit ${name}`),
      ),
    )
    const [owner, admin, member, outsider, recipient] = users as [
      TestUser,
      TestUser,
      TestUser,
      TestUser,
      TestUser,
    ]
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const other = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    const f = createFixtures(db)
    await db
      .insertInto('profiles')
      .values(
        [member, outsider].map((user) => ({
          user_id: user.id,
          handle: `dto-${user.id}`,
          time_zone: 'UTC',
        })),
      )
      .execute()
    await f.schedule(member.id, { timeZone: 'UTC' })
    await f.schedule(outsider.id, { timeZone: 'UTC' })
    const eventId = await f.eventType(team.id, null, {
      hosts: [{ userId: member.id }],
      title: 'Visible event',
      slug: 'dto-event',
      location: { kind: 'phone', number: '+15555550123' },
      questions: [
        {
          id: 'topic',
          type: 'select',
          label: 'Topic',
          required: true,
          options: ['Intro', 'Planning'],
        },
      ],
    })
    const otherEventId = await f.eventType(other.id, null, {
      hosts: [{ userId: outsider.id }],
      title: 'Other team event',
    })
    const bookingId = await f.booking(
      team.id,
      [member.id],
      '2026-11-04T10:00:00Z',
      '2026-11-04T10:30:00Z',
      { eventTypeId: eventId },
    )
    const otherBookingId = await f.booking(
      other.id,
      [outsider.id],
      '2026-11-04T10:00:00Z',
      '2026-11-04T10:30:00Z',
      { eventTypeId: otherEventId },
    )
    const manageToken = randomBytes(32).toString('base64url')
    await db
      .updateTable('bookings')
      .set({
        responses: JSON.stringify({ private: privateMarker }),
        location: JSON.stringify({ kind: 'link', url: `https://example.test/${privateMarker}` }),
        cancel_reason: privateMarker,
        manage_token_hash: createHash('sha256').update(manageToken).digest(),
        created_at: now.toString(),
      })
      .where('id', '=', bookingId)
      .execute()
    await f.calendarBusy(member.id, [['2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z']])
    await db.updateTable('calendars').set({ name: privateMarker }).execute()
    const webhookIds: string[] = []
    for (const [organizationId, booking] of [
      [team.id, bookingId],
      [other.id, otherBookingId],
    ] as const) {
      const webhook = await db
        .insertInto('webhooks')
        .values({
          organization_id: organizationId,
          url: 'https://hooks.example.test/',
          events: ['booking.created'],
          secret_ciphertext: Buffer.from(privateMarker),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      webhookIds.push(webhook.id)
      await db
        .insertInto('webhook_deliveries')
        .values({
          webhook_id: webhook.id,
          organization_id: organizationId,
          booking_id: booking,
          event_id: randomUUID(),
          event_type: 'booking.created',
          payload: JSON.stringify({ private: privateMarker }),
          status: 'failed',
          attempts: 1,
          http_status: 500,
          last_error: 'http_error',
        })
        .execute()
    }
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: recipient.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const otherInvitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: other.id,
        inviterId: outsider.id,
        email: `${randomUUID()}@example.test`,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const operation = await db
      .insertInto('organization_operations')
      .values({
        organization_id: team.id,
        operation: 'member_removed',
        previous_role: 'member',
        actor_user_id: owner.id,
        target_user_id: member.id,
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const otherOperation = await db
      .insertInto('organization_operations')
      .values({
        organization_id: other.id,
        operation: 'member_removed',
        previous_role: 'member',
        actor_user_id: outsider.id,
        target_user_id: owner.id,
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const actors = await Promise.all(
      [owner, admin, member, outsider].map((user) => session(user, team.id)),
    )
    const apiKeys = await Promise.all(
      [owner, admin, member, outsider].map(
        async (user, index) =>
          (
            await auth.api.createApiKey({
              body: {
                userId: user.id,
                name: 'DTO audit',
                metadata: { organizationId: index === 3 ? other.id : team.id },
              },
            })
          ).key,
      ),
    )
    return {
      team,
      other,
      owner,
      admin,
      member,
      outsider,
      recipient,
      actors,
      apiKeys,
      recipientSession: await session(recipient, recipient.principal.organization.id),
      eventId,
      otherEventId,
      bookingId,
      manageToken,
      webhookIds,
      otherBookingId,
      invitationId: invitation.id,
      otherInvitationId: otherInvitation.id,
      operationId: operation.id,
      otherOperationId: otherOperation.id,
    }
  }
  function get(path: string, actor = fixture.actors[0], headers: Record<string, string> = {}) {
    return app.request(path, { headers: { cookie: actor?.cookie ?? '', ...headers } })
  }
  const native = (path: string, actor = fixture.actors[0]) =>
    get(`/api/auth/organization/${path}`, actor)
  async function body(response: Response, status = 200): Promise<Json> {
    expect(response.status).toBe(status)
    return response.json() as Promise<Json>
  }
  function assertBooking(item: Json, list = false) {
    keys(item, bookingKeys)
    keys(item.eventType, list ? ['id', 'title', 'publicBookingPath'] : ['id', 'title'])
    for (const host of item.hosts)
      keys(host, list ? ['userId', 'name', 'timeZone', 'isCurrentMember'] : ['userId', 'name'])
    for (const attendee of item.attendees) keys(attendee, ['name', 'email', 'timeZone', 'isBooker'])
    expect(JSON.stringify(item)).not.toContain(privateMarker)
  }
  function assertEvent(item: Json) {
    keys(item, eventKeys)
    keys(item.location, ['kind', 'number'])
    expect(item.hosts).toHaveLength(1)
    for (const host of item.hosts) keys(host, ['userId'])
    expect(item.questions).toHaveLength(1)
    for (const question of item.questions)
      keys(question, ['id', 'type', 'label', 'required', 'options'])
    expect(item.conferenceOrganizer).toBeNull()
    expect(JSON.stringify(item)).not.toContain(privateMarker)
  }
  function assertSlots(page: Json) {
    keys(page, ['data'])
    expect(page.data.length).toBeGreaterThan(0)
    for (const slot of page.data) keys(slot, ['start', 'end'])
    expect(JSON.stringify(page)).not.toContain(privateMarker)
  }
  function assertHostBooking(item: Json, managed = false) {
    keys(item, managed ? managedBookingKeys : hostBookingKeys)
    keys(item.location, ['kind', 'url'])
    keys(item.responses, ['private'])
    expect(item.responses.private).toBe(privateMarker)
    for (const attendee of item.attendees)
      keys(attendee, ['name', 'email', 'timeZone', 'locale', 'isBooker'])
    if (managed) {
      keys(item.eventType, ['title', 'durationMinutes'])
      for (const host of item.hosts) keys(host, ['name'])
    }
    expect(JSON.stringify(item)).not.toContain(fixture.owner.email)
    expect(JSON.stringify(item)).not.toContain(fixture.admin.email)
    expect(JSON.stringify(item)).not.toContain(fixture.member.email)
  }

  it('records existing event configuration and host-selector DTOs for each principal role', async () => {
    for (const [index, actor] of fixture.actors.entries()) {
      const page = await body(await get('/api/v1/event-types', actor))
      keys(page, ['data'])
      expect(page.data.map((item: Json) => item.id)).toEqual(index === 3 ? [] : [fixture.eventId])
      if (index < 3) {
        for (const item of page.data) assertEvent(item)
        assertEvent(await body(await get(`/api/v1/event-types/${fixture.eventId}`, actor)))
      } else {
        const denied = await body(await get(`/api/v1/event-types/${fixture.eventId}`, actor), 404)
        keys(denied, ['error'])
        expect(denied.error).toBe('event_type_not_found')
      }
      const response = await get('/api/v1/event-type-hosts', actor)
      if (index === 2) {
        const denied = await body(response, 403)
        keys(denied, ['error', 'message'])
        expect(denied.error).toBe('insufficient_role')
      } else {
        const hosts = await body(response)
        keys(hosts, ['data', 'nextAfter'])
        for (const host of hosts.data) {
          keys(host, ['id', 'memberId', 'name'])
          const membership = await db
            .selectFrom('auth.member')
            .select(['userId', 'organizationId'])
            .where('id', '=', host.memberId)
            .executeTakeFirstOrThrow()
          expect(membership).toEqual({
            userId: host.id,
            organizationId:
              index === 3 ? fixture.outsider.principal.organization.id : fixture.team.id,
          })
        }
        expect(hosts.data.map((host: Json) => host.id).sort()).toEqual(
          (index === 3
            ? [fixture.outsider.id]
            : [fixture.owner.id, fixture.admin.id, fixture.member.id]
          ).sort(),
        )
      }
    }
  })

  it('limits full booking DTOs and reschedule slots to actual hosts regardless of management role', async () => {
    for (const [index, actor] of fixture.actors.entries()) {
      const page = await body(await get('/api/v1/bookings', actor))
      keys(page, ['data', 'nextCursor'])
      expect(page.data.map((item: Json) => item.id)).toEqual(index === 2 ? [fixture.bookingId] : [])
      for (const item of page.data) assertHostBooking(item)
      for (const path of [
        `/api/v1/bookings/${fixture.bookingId}`,
        `/api/v1/bookings/${fixture.bookingId}/slots?${slotRange}`,
      ]) {
        const response = await get(path, actor)
        if (index === 2) {
          const value = await body(response)
          if (path.includes('/slots?')) assertSlots(value)
          else assertHostBooking(value)
        } else {
          const denied = await body(response, 404)
          keys(denied, ['error', 'message'])
          expect(denied.error).toBe('booking_not_found')
        }
      }
    }
  })

  it('keeps public team event and slot DTOs identical for members, outsiders and anonymous readers', async () => {
    const slug = fixture.team.as(fixture.owner).organization.slug
    for (const actor of [...fixture.actors, undefined]) {
      const path = `/api/v1/public/teams/${slug}/dto-event`
      const request = (url: string) =>
        app.request(url, { headers: actor ? { cookie: actor.cookie } : {} })
      const event = await body(await request(path))
      keys(event, [
        'handle',
        'slug',
        'title',
        'description',
        'durationMinutes',
        'location',
        'allowGuests',
        'questions',
        'host',
        'team',
      ])
      keys(event.location, ['kind'])
      keys(event.host, ['name', 'timeZone'])
      keys(event.team, ['name', 'slug'])
      for (const question of event.questions)
        keys(question, ['id', 'type', 'label', 'required', 'options'])
      for (const user of [fixture.owner, fixture.admin, fixture.member, fixture.outsider])
        expect(JSON.stringify(event)).not.toContain(user.email)
      expect(JSON.stringify(event)).not.toContain('+15555550123')
      expect(JSON.stringify(event)).not.toContain(privateMarker)
      assertSlots(await body(await request(`${path}/slots?${slotRange}`)))
    }
  })

  it('bounds invitee manage DTOs by the capability rather than team role and never returns the capability', async () => {
    for (const actor of [...fixture.actors, undefined]) {
      const request = (path: string, token?: string) =>
        app.request(path, {
          headers: {
            ...(actor ? { cookie: actor.cookie } : {}),
            ...(token ? { 'x-manage-token': token } : {}),
          },
        })
      assertHostBooking(
        await body(await request('/api/v1/bookings/manage', fixture.manageToken)),
        true,
      )
      assertSlots(
        await body(
          await request(`/api/v1/bookings/manage/slots?${slotRange}`, fixture.manageToken),
        ),
      )
      const denied = await body(
        await request('/api/v1/bookings/manage', randomBytes(32).toString('base64url')),
        404,
      )
      keys(denied, ['error', 'message'])
      expect(denied.error).toBe('booking_not_found')
    }
  })

  it('returns aggregate analytics and bounded webhook metadata without private payloads or secrets', async () => {
    for (const [index, actor] of fixture.actors.entries()) {
      const activityResponse = await get(
        '/api/v1/analytics/bookings?startDate=2026-11-01&endDate=2026-11-01&timeZone=UTC',
        actor,
      )
      if (index === 2) {
        const denied = await body(activityResponse, 403)
        keys(denied, ['error', 'message'])
        expect(denied.error).toBe('insufficient_role')
      } else {
        const activity = await body(activityResponse)
        keys(activity, ['startDate', 'endDate', 'timeZone', 'totals', 'data'])
        keys(activity.totals, ['created', 'rescheduled', 'cancelled'])
        expect(activity.totals).toEqual({
          created: index === 3 ? 0 : 1,
          rescheduled: 0,
          cancelled: 0,
        })
        for (const day of activity.data) keys(day, ['date', 'created', 'rescheduled', 'cancelled'])
        expect(JSON.stringify(activity)).not.toContain(privateMarker)
      }
      const webhooksResponse = await get('/api/v1/webhooks', actor)
      const deliveriesResponse = await get(
        `/api/v1/webhooks/${fixture.webhookIds[0]}/deliveries`,
        actor,
      )
      if (index === 2) {
        for (const response of [webhooksResponse, deliveriesResponse]) {
          const denied = await body(response, 403)
          keys(denied, ['error', 'message'])
          expect(denied.error).toBe('insufficient_role')
        }
      } else {
        expect(webhooksResponse.status).toBe(200)
        const webhooks = (await webhooksResponse.json()) as Json[]
        expect(webhooks).toHaveLength(index === 3 ? 0 : 1)
        for (const webhook of webhooks)
          keys(webhook, [
            'id',
            'organizationId',
            'url',
            'events',
            'isActive',
            'createdAt',
            'updatedAt',
          ])
        if (index === 3) {
          const denied = await body(deliveriesResponse, 404)
          keys(denied, ['error'])
          expect(denied.error).toBe('webhook_not_found')
        } else {
          const deliveries = await body(deliveriesResponse)
          keys(deliveries, ['data', 'nextAfter'])
          expect(deliveries.data).toHaveLength(1)
          for (const delivery of deliveries.data)
            keys(delivery, [
              'id',
              'eventId',
              'eventType',
              'bookingId',
              'status',
              'attempts',
              'httpStatus',
              'lastError',
              'createdAt',
              'lastAttemptAt',
              'deliveredAt',
            ])
          expect(JSON.stringify(deliveries)).not.toContain(privateMarker)
          expect(deliveries.data[0].lastError).toBe('http_error')
        }
        expect(JSON.stringify(webhooks)).not.toContain(privateMarker)
      }
    }
  })

  it('exposes only bounded conference and caller-owned calendar-copy metadata to hosts', async () => {
    try {
      await db
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
        .where('id', '=', fixture.bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: fixture.bookingId,
          booking_id: fixture.bookingId,
          organization_id: fixture.team.id,
          organizer_user_id: fixture.member.id,
          calendar_id: randomUUID(),
          connection_id: randomUUID(),
          state: 'failed',
          error_code: 'provider_unavailable',
        })
        .execute()
      await db
        .insertInto('booking_conference_mirrors')
        .values({
          root_booking_id: fixture.bookingId,
          user_id: fixture.member.id,
          calendar_id: randomUUID(),
          connection_id: randomUUID(),
          state: 'failed',
          error_code: 'permissions_missing',
        })
        .execute()
      const host = await body(await get(`/api/v1/bookings/${fixture.bookingId}`, fixture.actors[2]))
      keys(host, [...hostBookingKeys, 'conference', 'conferenceCanRetry', 'calendarCopy'])
      keys(host.location, ['kind', 'autoCreate'])
      keys(host.conference, ['provider', 'status', 'errorCode'])
      keys(host.calendarCopy, ['status', 'errorCode', 'canRetry'])
      expect(host.conference).toEqual({
        provider: 'google_meet',
        status: 'failed',
        errorCode: 'provider_unavailable',
      })
      expect(host.calendarCopy).toEqual({
        status: 'failed',
        errorCode: 'permissions_missing',
        canRetry: true,
      })
      const managed = await body(
        await get('/api/v1/bookings/manage', fixture.actors[3], {
          'x-manage-token': fixture.manageToken,
        }),
      )
      keys(managed, [...managedBookingKeys, 'conference'])
      keys(managed.conference, ['provider', 'status', 'errorCode'])
      keys(managed.location, ['kind', 'autoCreate'])
      for (const actor of fixture.actors.slice(0, 2)) {
        const managedTeam = await body(await get('/api/v1/team/bookings', actor))
        for (const item of managedTeam.data) assertBooking(item, true)
      }
    } finally {
      await db
        .deleteFrom('booking_conferences')
        .where('root_booking_id', '=', fixture.bookingId)
        .execute()
      await db
        .updateTable('bookings')
        .set({
          location: JSON.stringify({ kind: 'link', url: `https://example.test/${privateMarker}` }),
        })
        .where('id', '=', fixture.bookingId)
        .execute()
    }
  })

  it('records exact MCP catalog, booking and public-slot DTOs through real organization-bound keys', async () => {
    for (const [index, token] of fixture.apiKeys.entries()) {
      const client = new Client({ name: 'team-dto-audit', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            fetch: async (input, init) => app.request(input, init),
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        )
        const call = async (name: string, args: Json = {}) => {
          const result = await client.callTool({ name, arguments: args })
          expect(result.isError).toBeFalsy()
          return result.structuredContent as Json
        }
        const catalog = await call('list_event_types')
        keys(catalog, ['data', 'nextAfter'])
        expect(catalog.data.map((item: Json) => item.id)).toEqual([
          index === 3 ? fixture.otherEventId : fixture.eventId,
        ])
        for (const item of catalog.data)
          keys(item, [
            'id',
            'organizationId',
            'ownerUserId',
            'slug',
            'title',
            'durationMinutes',
            'schedulingType',
            'isActive',
            'isHidden',
            'allowGuests',
            'position',
          ])
        if (index < 3) assertEvent(await call('get_event_type', { id: fixture.eventId }))
        else
          expect(
            (await client.callTool({ name: 'get_event_type', arguments: { id: fixture.eventId } }))
              .isError,
          ).toBe(true)
        const bookings = await call('list_bookings')
        keys(bookings, ['data', 'nextCursor'])
        expect(bookings.data.map((item: Json) => item.id)).toEqual(
          index === 2 ? [fixture.bookingId] : index === 3 ? [fixture.otherBookingId] : [],
        )
        if (index === 2) for (const item of bookings.data) assertHostBooking(item)
        const slots = await call('find_available_slots', {
          teamSlug: fixture.team.as(fixture.owner).organization.slug,
          slug: 'dto-event',
          startDate: '2026-11-04',
          endDate: '2026-11-04',
          timeZone: 'UTC',
        })
        keys(slots, ['eventType', 'timeZone', 'slots', 'nextAfter'])
        keys(slots.eventType, [
          'handle',
          'slug',
          'title',
          'description',
          'durationMinutes',
          'location',
          'allowGuests',
          'questions',
          'host',
          'team',
        ])
        keys(slots.eventType.location, ['kind'])
        keys(slots.eventType.host, ['name', 'timeZone'])
        keys(slots.eventType.team, ['name', 'slug'])
        for (const question of slots.eventType.questions)
          keys(question, ['id', 'type', 'label', 'required', 'options'])
        expect(slots.slots.length).toBeGreaterThan(0)
        for (const slot of slots.slots) keys(slot, ['start', 'end', 'localStart', 'localEnd'])
        expect(JSON.stringify([catalog, slots])).not.toContain(privateMarker)
      } finally {
        await client.close()
      }
    }
  })

  it.each([0, 1, 2])(
    'records exact native organization/member key sets for role index %s',
    async (index) => {
      const actor = fixture.actors[index]
      const privileged = index < 2
      const listed = await native('list', actor)
      expect(listed.status).toBe(200)
      const organizations = (await listed.json()) as Json[]
      expect(organizations.map((item) => item.id)).toContain(fixture.team.id)
      expect(organizations.map((item) => item.id)).not.toContain(fixture.other.id)
      for (const organization of organizations) keys(organization, orgKeys)
      for (const selector of [
        `organizationId=${fixture.team.id}`,
        `organizationSlug=${fixture.team.as(fixture.owner).organization.slug}`,
        '',
      ]) {
        const suffix = selector ? `?${selector}` : ''
        const organization = await body(await native(`get-organization${suffix}`, actor))
        keys(organization, orgKeys)
        expect(organization.id).toBe(fixture.team.id)
        const full = await body(await native(`get-full-organization${suffix}`, actor))
        keys(full, [...orgKeys, 'members', ...(privileged ? ['invitations'] : [])])
        const page = await body(await native(`list-members${suffix}`, actor))
        keys(page, ['members', 'total'])
        for (const members of [full.members, page.members]) {
          expect(members).toHaveLength(3)
          for (const member of members) {
            keys(member, [...memberKeys, 'user'])
            keys(member.user, privileged ? ['id', 'name', 'email', 'image'] : ['id', 'name'])
          }
        }
        if (privileged) for (const invitation of full.invitations) keys(invitation, invitationKeys)
      }
      const ownMember = await body(await native('get-active-member', actor))
      keys(ownMember, [...memberKeys, 'user'])
      keys(ownMember.user, ['id', 'name', 'email', 'image'])
      expect(ownMember.userId).toBe(actor?.user.id)
      const role = await body(
        await native(
          `get-active-member-role?organizationId=${fixture.team.id}&userId=${fixture.member.id}`,
          actor,
        ),
      )
      keys(role, ['role'])
      expect(role.role).toBe('member')
      const invitations = await native(`list-invitations?organizationId=${fixture.team.id}`, actor)
      expect(invitations.status).toBe(privileged ? 200 : 403)
      if (privileged)
        for (const invitation of (await invitations.json()) as Json[])
          keys(invitation, invitationKeys)
    },
  )

  it('returns only caller context and bounded permission/slug read results', async () => {
    for (const [index, actor] of fixture.actors.entries()) {
      const me = await body(await get('/api/v1/me', actor))
      keys(me, ['user', 'organization', 'personalOrganizationId', 'principal'])
      keys(me.user, ['id', 'name', 'email'])
      keys(me.organization, ['id', 'name', 'slug', 'personal'])
      keys(me.principal, ['kind', 'apiKeyId'])
      expect(me.user.id).toBe(actor.user.id)
      expect(me.organization.id).toBe(
        index === 3 ? actor.user.principal.organization.id : fixture.team.id,
      )
      const response = await app.request('/api/auth/organization/has-permission', {
        method: 'POST',
        headers: { cookie: actor.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: fixture.team.id,
          permissions: { invitation: ['create'] },
        }),
      })
      const permissions = await body(response, index === 3 ? 401 : 200)
      if (index !== 3) {
        keys(permissions, ['error', 'success'])
        expect(permissions).toEqual({ error: null, success: index < 2 })
      }
    }
    const slug = await body(
      await app.request('/api/auth/organization/check-slug', {
        method: 'POST',
        headers: {
          cookie: fixture.actors[0]?.cookie ?? '',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: `audit-available-${randomUUID()}` }),
      }),
    )
    keys(slug, ['status'])
    expect(slug.status).toBe(true)
  })

  it('scopes every native organization selector and role target to a current membership', async () => {
    for (const index of [0, 1, 2, 3]) {
      const actor = fixture.actors[index]
      const target = index === 3 ? fixture.team : fixture.other
      for (const endpoint of [
        'get-organization',
        'get-full-organization',
        'list-members',
        'get-active-member-role',
        'list-invitations',
      ]) {
        const response = await native(
          `${endpoint}?organizationId=${target.id}&userId=${fixture.member.id}`,
          actor,
        )
        expect(response.status, `${endpoint} role ${index}`).toBe(403)
        const error = await response.json()
        expect(JSON.stringify(error)).not.toContain(fixture.recipient.email)
      }
      for (const endpoint of [
        'get-organization',
        'get-full-organization',
        'list-members',
        'get-active-member-role',
      ]) {
        const slug = target.as(index === 3 ? fixture.owner : fixture.outsider).organization.slug
        expect((await native(`${endpoint}?organizationSlug=${slug}`, actor)).status).toBe(403)
      }
    }
    const otherRole = await native(
      `get-active-member-role?organizationId=${fixture.team.id}&userId=${fixture.outsider.id}`,
    )
    expect(otherRole.status).toBe(403)
  })

  it('limits invitation lookup and discovery to the verified recipient with exact native keys', async () => {
    const recipient = fixture.recipientSession
    const detail = await body(await native(`get-invitation?id=${fixture.invitationId}`, recipient))
    keys(detail, [...invitationKeys, 'organizationName', 'organizationSlug', 'inviterEmail'])
    expect(detail.inviterEmail).toBe(fixture.owner.email)
    const response = await native('list-user-invitations', recipient)
    expect(response.status).toBe(200)
    const invitations = (await response.json()) as Json[]
    expect(invitations).toHaveLength(1)
    keys(invitations[0] as Json, [...invitationKeys, 'organizationName'])
    for (const actor of fixture.actors)
      expect((await native(`get-invitation?id=${fixture.invitationId}`, actor)).status).toBe(403)
    expect((await native(`get-invitation?id=${fixture.otherInvitationId}`, recipient)).status).toBe(
      403,
    )
    expect(
      (await native(`list-user-invitations?email=${fixture.outsider.email}`, recipient)).status,
    ).toBe(400)
  })

  it.each([0, 1])('records exact team REST projections for manager index %s', async (index) => {
    const actor = fixture.actors[index]
    const page = await body(await get('/api/v1/team/bookings', actor))
    keys(page, ['data', 'nextCursor'])
    expect(page.data.map((item: Json) => item.id)).toEqual([fixture.bookingId])
    for (const item of page.data) assertBooking(item, true)
    const invitations = await body(await get('/api/v1/team/invitations', actor))
    keys(invitations, ['data', 'nextCursor'])
    expect(invitations.data).toHaveLength(1)
    for (const item of invitations.data) {
      keys(item, invitationSummaryKeys)
      expect(item.invalidReason).toBeNull()
      keys(item.delivery, ['state', 'attempts', 'lastAttemptAt', 'lastErrorCode'])
      expect(item.delivery).toEqual({
        state: 'unknown',
        attempts: null,
        lastAttemptAt: null,
        lastErrorCode: null,
      })
      expect(item.generation).toBe(1)
      const detail = await body(
        await get(`/api/v1/team/invitations/${item.id}`, actor, {
          'x-expected-organization-id': fixture.team.id,
        }),
      )
      keys(detail, invitationSummaryKeys)
      keys(detail.delivery, ['state', 'attempts', 'lastAttemptAt', 'lastErrorCode'])
      const { resendRetryAfterSeconds: detailRetry, ...detailStable } = detail
      const { resendRetryAfterSeconds: listRetry, ...listStable } = item
      expect(detailStable).toEqual(listStable)
      if (detailRetry !== null && listRetry !== null)
        expect(Math.abs(detailRetry - listRetry)).toBeLessThanOrEqual(1)
    }
    const impact = await body(
      await get(
        `/api/v1/team/members/${fixture.member.id}/departure-impact?teamId=${fixture.team.id}`,
        actor,
      ),
    )
    keys(impact, ['evaluatedAt', 'eventTypes', 'bookings'])
    for (const collection of [impact.eventTypes, impact.bookings])
      keys(collection, ['data', 'nextCursor', 'totalCount'])
    expect(impact.eventTypes.data).toHaveLength(1)
    keys(impact.eventTypes.data[0], [
      'id',
      'title',
      'slug',
      'schedulingType',
      'isActive',
      'reason',
      'remainingHostCount',
    ])
    expect(impact.bookings.data).toHaveLength(1)
    for (const item of impact.bookings.data) {
      const { inProgress, handling, ...booking } = item
      expect(inProgress).toBe(false)
      expect(handling).toBe('coordinate_cancellation')
      assertBooking(booking)
    }
    for (const path of [
      `member-removals/${fixture.operationId}`,
      `members/${fixture.member.id}/removal-handling`,
    ]) {
      const handling = await body(
        await get(`/api/v1/team/${path}?teamId=${fixture.team.id}`, actor),
      )
      keys(handling, ['id', 'memberUserId', 'removedAt', 'evaluatedAt', 'reason', 'bookings'])
      keys(handling.bookings, ['data', 'nextCursor', 'totalCount'])
      for (const item of handling.bookings.data) {
        const { inProgress: _inProgress, handling: _handling, ...booking } = item
        assertBooking(booking)
      }
    }
    const readiness = await body(await get(`/api/v1/teams/${fixture.team.id}/readiness`, actor))
    keys(readiness, ['organizationId', 'members', 'eventTypes'])
    for (const collection of [readiness.members, readiness.eventTypes])
      keys(collection, ['data', 'nextCursor'])
    for (const item of readiness.members.data)
      keys(item, [
        'memberId',
        'displayName',
        'summary',
        'completeness',
        'evaluatedAt',
        'reasonCodes',
        'fixKinds',
      ])
    for (const item of readiness.eventTypes.data)
      keys(item, [
        'eventTypeId',
        'enablement',
        'activation',
        'summary',
        'completeness',
        'evaluatedAt',
        'reasonCodes',
        'fixKinds',
      ])
    expect(JSON.stringify([invitations, impact, readiness])).not.toContain(privateMarker)
  })

  it('denies member/nonmember management reads and isolates crafted REST path, query, cursor and header IDs', async () => {
    const paths = [
      '/api/v1/team/bookings',
      '/api/v1/team/invitations',
      `/api/v1/team/invitations/${fixture.invitationId}`,
      `/api/v1/teams/${fixture.team.id}/readiness`,
      `/api/v1/team/member-removals/${fixture.operationId}?teamId=${fixture.team.id}`,
      `/api/v1/team/members/${fixture.member.id}/removal-handling?teamId=${fixture.team.id}`,
    ]
    for (const actor of fixture.actors.slice(2))
      for (const path of paths)
        expect(
          await body(
            await get(path, actor, { 'x-expected-organization-id': fixture.team.id }),
            403,
          ),
        ).toEqual({
          error: 'team_management_access_denied',
        })
    for (const path of paths)
      expect(
        await body(
          await get(path, fixture.actors[0], { 'x-expected-organization-id': fixture.other.id }),
          403,
        ),
      ).toEqual({ error: 'team_management_access_denied' })
    for (const path of [
      `/api/v1/teams/${fixture.other.id}/readiness`,
      `/api/v1/team/members/${fixture.outsider.id}/departure-impact?teamId=${fixture.team.id}`,
      `/api/v1/team/member-removals/${fixture.otherOperationId}?teamId=${fixture.team.id}`,
      `/api/v1/team/members/${fixture.outsider.id}/removal-handling?teamId=${fixture.team.id}`,
      `/api/v1/team/member-removals/${fixture.operationId}?teamId=${fixture.other.id}`,
      `/api/v1/team/invitations/${fixture.otherInvitationId}`,
      `/api/v1/team/invitations/${randomUUID()}`,
    ])
      expect(
        (await get(path, fixture.actors[0], { 'x-expected-organization-id': fixture.team.id }))
          .status,
      ).toBe(403)
    const cursor = Buffer.from(
      JSON.stringify([fixture.other.id, fixture.otherInvitationId]),
    ).toString('base64url')
    expect((await get(`/api/v1/team/invitations?cursor=${cursor}`)).status).toBe(400)
    const own = await body(
      await get(
        `/api/v1/team/members/${fixture.member.id}/departure-impact?teamId=${fixture.team.id}`,
        fixture.actors[2],
      ),
    )
    expect(own.bookings.data).toHaveLength(1)
    expect(
      (
        await get(
          `/api/v1/team/members/${fixture.owner.id}/departure-impact?teamId=${fixture.team.id}`,
          fixture.actors[2],
        )
      ).status,
    ).toBe(403)
  })

  it('keeps generation authority private and exposes expired replacement eligibility without renewing the old ID', async () => {
    const original = await db
      .selectFrom('auth.invitation')
      .select(['status', 'expiresAt'])
      .where('id', '=', fixture.invitationId)
      .executeTakeFirstOrThrow()
    try {
      const old = new Date(Date.now() - 120_000)
      await db
        .insertInto('invitation_deliveries')
        .values({
          invitation_id: fixture.invitationId,
          generation: 32,
          authorized_by_user_id: fixture.admin.id,
          state: 'failed',
          attempts: 2,
          last_error_code: 'smtp_permanent',
          generation_started_at: old,
          created_at: old,
          updated_at: old,
          resend_request_id: randomUUID(),
          last_job_id: randomUUID(),
        })
        .execute()
      for (const actor of fixture.actors.slice(0, 2)) {
        const current = await body(
          await get(`/api/v1/team/invitations/${fixture.invitationId}`, actor, {
            'x-expected-organization-id': fixture.team.id,
          }),
        )
        keys(current, invitationSummaryKeys)
        keys(current.delivery, ['state', 'attempts', 'lastAttemptAt', 'lastErrorCode'])
        expect(current).toMatchObject({
          generation: 32,
          status: 'pending',
          resendAllowed: false,
          resendDeniedReason: 'INVITATION_GENERATION_LIMIT',
          resendRetryAfterSeconds: null,
          delivery: { state: 'failed', attempts: 2, lastErrorCode: 'smtp_permanent' },
        })
        expect(typeof current.delivery.lastAttemptAt).toBe('string')
        expect(JSON.stringify(current)).not.toContain(fixture.admin.id)
      }
      await db
        .updateTable('auth.invitation')
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where('id', '=', fixture.invitationId)
        .execute()
      for (const actor of fixture.actors.slice(0, 2)) {
        const expired = await body(
          await get(`/api/v1/team/invitations/${fixture.invitationId}`, actor, {
            'x-expected-organization-id': fixture.team.id,
          }),
        )
        keys(expired, invitationSummaryKeys)
        keys(expired.delivery, ['state', 'attempts', 'lastAttemptAt', 'lastErrorCode'])
        expect(expired).toMatchObject({
          id: fixture.invitationId,
          status: 'expired',
          generation: 32,
          resendAllowed: true,
          resendDeniedReason: null,
          resendRetryAfterSeconds: null,
        })
        const page = await body(await get('/api/v1/team/invitations?status=expired', actor))
        keys(page, ['data', 'nextCursor'])
        expect(page.data).toHaveLength(1)
        keys(page.data[0], invitationSummaryKeys)
        expect(page.data[0]).toEqual(expired)
      }
      const canceled = await body(
        await app.request(`/api/v1/team/invitations/${fixture.invitationId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: fixture.actors[0]?.cookie ?? '',
            origin,
            'content-type': 'application/json',
            'x-expected-organization-id': fixture.team.id,
          },
          body: '{}',
        }),
      )
      keys(canceled, invitationSummaryKeys)
      keys(canceled.delivery, ['state', 'attempts', 'lastAttemptAt', 'lastErrorCode'])
      expect(canceled).toMatchObject({
        id: fixture.invitationId,
        status: 'canceled',
        generation: 32,
        resendAllowed: false,
        resendDeniedReason: 'INVITATION_INELIGIBLE',
        resendRetryAfterSeconds: null,
      })
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('id')
          .where('organizationId', '=', fixture.team.id)
          .execute(),
      ).toEqual([{ id: fixture.invitationId }])
    } finally {
      await db
        .deleteFrom('invitation_deliveries')
        .where('invitation_id', '=', fixture.invitationId)
        .execute()
      await db
        .updateTable('auth.invitation')
        .set(original)
        .where('id', '=', fixture.invitationId)
        .execute()
    }
  })

  it('refuses stale webhook creation without writing in either team or sending provider traffic', async () => {
    const actor = fixture.actors[0]
    if (!actor) throw new Error('Missing owner fixture')
    let createdId: string | undefined
    const added = await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.other.id,
        userId: fixture.owner.id,
        role: 'admin',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    try {
      const snapshot = async () => ({
        webhooks: await db
          .selectFrom('webhooks')
          .select(['id', 'organization_id'])
          .where('organization_id', 'in', [fixture.team.id, fixture.other.id])
          .orderBy('id')
          .execute(),
        deliveries: await db
          .selectFrom('webhook_deliveries')
          .select(['id', 'organization_id'])
          .where('organization_id', 'in', [fixture.team.id, fixture.other.id])
          .orderBy('id')
          .execute(),
      })
      const before = await snapshot()
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: fixture.other.id })
        .where('id', '=', actor.sessionId)
        .execute()
      // An authorized old draft must ask for a reload after a session switch.
      const response = await app.request('/api/v1/webhooks', {
        method: 'POST',
        headers: {
          cookie: actor.cookie,
          origin,
          'content-type': 'application/json',
          'x-expected-organization-id': fixture.team.id,
        },
        body: JSON.stringify({
          url: 'https://hooks.example.com/context-characterization',
          events: ['booking.created'],
        }),
      })
      const result = (await response.json()) as Json
      createdId = result.webhook?.id
      expect(response.status).toBe(409)
      expect(result).toMatchObject({ error: 'organization_context_changed' })
      expect(await snapshot()).toEqual(before)
    } finally {
      if (createdId) await db.deleteFrom('webhooks').where('id', '=', createdId).execute()
      await db.deleteFrom('auth.member').where('id', '=', added.id).execute()
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: fixture.team.id })
        .where('id', '=', actor.sessionId)
        .execute()
    }
  })
})
