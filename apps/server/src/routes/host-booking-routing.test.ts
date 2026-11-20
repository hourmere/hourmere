import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { webhookBookingNotifier } from '@hourmere/webhooks'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { createApp } from '../app.ts'
import { bookingRoutes, HostBooking } from './bookings.ts'
import { teamBookingRoutes } from './team-bookings.ts'
import { openApiDocument, productApp, syntheticSessionCookie } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const path = '/api/v1/bookings'
const teamPath = '/api/v1/team/bookings'
const ordinaryId = 'db85cf21-4875-4db0-880e-127dd3a0a2cb'
const missingId = 'db85cf21-4875-4db0-880e-127dd3a0a2ce'
const start = '2026-11-04T09:00:00.000Z'
const end = '2026-11-04T09:30:00.000Z'
const questionId = '415bd292-8c4e-09a8-088f-367017c5399a'
const optionId = 'c71e5848-c074-0ef8-0f29-d46433ab9585'
const hostLocation = { kind: 'link', url: 'https://example.test/private-booking-room' }
const routing = {
  formId: '3a2e0460-0a5d-44fb-8b41-62f2b616259b',
  versionId: 'b3fb485e-894f-4be6-aca5-9af4d583608e',
  versionNumber: 4,
  matchedRuleId: 'fb8cb964-b053-438c-956b-4a1d5124a54e',
  resolvedRuleId: 'fallback',
  questions: [
    {
      id: questionId,
      type: 'select',
      label: 'Original question label',
      required: true,
      options: [{ id: optionId, label: 'Original option label' }],
    },
  ],
  answers: { [questionId]: optionId },
}
const okBody = async (response: Response) => {
  expect(response.status).toBe(200)
  return response.json()
}
const notFound = async (response: Response) => {
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'booking_not_found', message: 'No such booking' })
}

describe.skipIf(!serverUrl)('host booking routing detail over REST', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  let ordinaryTeamId: string
  let routed: Awaited<ReturnType<typeof routedFixture>>
  const principals = new Map<string, Principal>()
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'host_routing' })
    db = createDb(owned.pool)
    const observed = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    const ordinaryHost = await createTestUser(db, 'Host')
    const foreignUser = await createTestUser(db, 'Foreign user')
    const organizationId = ordinaryHost.principal.organization.id
    const team = await createTestTeam(db, [
      { user: ordinaryHost, role: 'owner' },
      { user: foreignUser, role: 'admin' },
    ])
    principals.set('ordinary-host', ordinaryHost.principal)
    principals.set('foreign-user', foreignUser.principal)
    principals.set('host-in-other-space', team.as(ordinaryHost))
    await session('non-host-admin', foreignUser, team.as(foreignUser).organization)
    ordinaryTeamId = await createFixtures(db).booking(
      team.id,
      [ordinaryHost.id],
      '2026-11-04T10:00:00Z',
      '2026-11-04T10:30:00Z',
    )
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('bookings')
        .values({
          id: ordinaryId,
          organization_id: organizationId,
          start_at: start,
          end_at: end,
          title: 'Ordinary booking',
          status: 'confirmed',
          source: 'api',
          created_at: now().toString(),
          responses: JSON.stringify({ topic: 'Booking answer' }),
        })
        .execute()
      await trx
        .insertInto('booking_hosts')
        .values({ booking_id: ordinaryId, user_id: ordinaryHost.id })
        .execute()
      await trx
        .insertInto('booking_attendees')
        .values({
          id: 'db85cf21-4875-4db0-880e-127dd3a0a2cc',
          booking_id: ordinaryId,
          name: 'Invitee',
          email: 'invitee@example.test',
          time_zone: 'UTC',
          is_booker: true,
        })
        .execute()
    })
    app = productApp(observed, principals, [
      bookingRoutes({ db: observed, now }),
      teamBookingRoutes({ db: observed, now }),
    ])
    routed = await routedFixture()
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function session(
    credential: string,
    user: TestUser,
    organization: Principal['organization'],
  ) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        activeOrganizationId: organization.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    principals.set(credential, {
      kind: 'session',
      sessionId: id,
      user: { id: user.id, name: user.name, email: user.email },
      organization,
    })
    return id
  }

  function get(id: string, credential?: string, base = path) {
    const principal = credential === undefined ? undefined : principals.get(credential)
    return app.request(`${base}${id === '' ? '' : `/${id}`}`, {
      headers:
        credential === undefined
          ? {}
          : principal?.kind === 'session'
            ? { cookie: syntheticSessionCookie(credential) }
            : { authorization: `Bearer ${credential}` },
    })
  }

  async function storeRoutingSnapshot(
    id: string,
    organizationId: string,
    fingerprint: Buffer | null,
  ) {
    // The historical version may have been deleted. A booked snapshot is the source of truth.
    await db
      .insertInto('booking_routing')
      .values({
        booking_id: id,
        organization_id: organizationId,
        form_id: routing.formId,
        version_id: routing.versionId,
        version_number: routing.versionNumber,
        matched_rule_id: routing.matchedRuleId,
        resolved_rule_id: routing.resolvedRuleId,
        questions: JSON.stringify(routing.questions),
        answers: JSON.stringify(routing.answers),
        replay_fingerprint: fingerprint,
      })
      .execute()
  }

  async function routedFixture() {
    const host = await createTestUser(db, 'Assigned host')
    const admin = await createTestUser(db, 'Routing team admin')
    const other = await createTestUser(db, 'Unassigned member')
    const team = await createTestTeam(db, [
      { user: host, role: 'member' },
      { user: admin, role: 'admin' },
      { user: other, role: 'member' },
    ])
    const id = await createFixtures(db).booking(team.id, [host.id], start, end)
    await storeRoutingSnapshot(id, team.id, Buffer.alloc(32, 1))
    await db
      .updateTable('bookings')
      .set({
        responses: JSON.stringify({ topic: 'Final booking answer' }),
        location: JSON.stringify(hostLocation),
      })
      .where('id', '=', id)
      .execute()
    principals.set('routed-host', team.as(host))
    principals.set('routed-host-in-personal-space', host.principal)
    principals.set('routed-admin-key', team.as(admin))
    principals.set('routed-unassigned-member', team.as(other))
    const hostSession = await session('routed-browser-host', host, team.as(host).organization)
    const adminSession = await session('routed-admin', admin, team.as(admin).organization)
    return { id, team, host, admin, hostSession, adminSession }
  }

  it('preserves the exact ordinary detail response bytes and status codes', async () => {
    const cases = [
      ['ordinary-host', ordinaryId],
      ['ordinary-host', missingId],
      ['foreign-user', ordinaryId],
      ['host-in-other-space', ordinaryId],
      ['non-host-admin', ordinaryTeamId],
      ['ordinary-host', 'not-a-uuid'],
      [undefined, ordinaryId],
    ] as const
    const responses = []
    for (const [credential, id] of cases) {
      const response = await get(id, credential)
      responses.push({ status: response.status, body: await response.text() })
    }
    expect(responses).toMatchInlineSnapshot(`
      [
        {
          "body": "{"id":"db85cf21-4875-4db0-880e-127dd3a0a2cb","eventTypeId":null,"status":"confirmed","start":"2026-11-04T09:00:00.000Z","end":"2026-11-04T09:30:00.000Z","title":"Ordinary booking","eventTypeTitle":null,"location":null,"responses":{"topic":"Booking answer"},"canManageNoShow":false,"attendees":[{"id":"db85cf21-4875-4db0-880e-127dd3a0a2cc","noShowMarkedAt":null,"noShowMarkedBy":null,"name":"Invitee","email":"invitee@example.test","timeZone":"UTC","locale":null,"isBooker":true}],"rescheduledFromId":null,"rescheduledToId":null,"cancelledAt":null,"cancelReason":null,"source":"api","createdAt":"2026-11-01T12:00:00.000Z"}",
          "status": 200,
        },
        {
          "body": "{"error":"booking_not_found","message":"No such booking"}",
          "status": 404,
        },
        {
          "body": "{"error":"booking_not_found","message":"No such booking"}",
          "status": 404,
        },
        {
          "body": "{"error":"booking_not_found","message":"No such booking"}",
          "status": 404,
        },
        {
          "body": "{"error":"booking_not_found","message":"No such booking"}",
          "status": 404,
        },
        {
          "body": "{"error":"invalid_request","message":"id: Invalid UUID"}",
          "status": 400,
        },
        {
          "body": "{"error":"unauthorized"}",
          "status": 401,
        },
      ]
    `)
  })

  it('keeps the ordinary detail SQL statement counts and skips routing storage', async () => {
    for (const [credential, id, count] of [
      ['ordinary-host', ordinaryId, 7],
      ['ordinary-host', missingId, 1],
      ['foreign-user', ordinaryId, 1],
      ['host-in-other-space', ordinaryId, 2],
      ['non-host-admin', ordinaryTeamId, 2],
      ['ordinary-host', 'not-a-uuid', 0],
      [undefined, ordinaryId, 0],
    ] as const) {
      statements.length = 0
      await get(id, credential)
      expect(statements, credential ?? 'anonymous').toHaveLength(count)
      expect(statements.some((statement) => /"booking_routing"/.test(statement))).toBe(false)
    }
  })

  it('returns the original version, rule identities and labels while routing is off', async () => {
    for (const credential of ['routed-host', 'routed-browser-host']) {
      const body = await okBody(await get(routed.id, credential))
      expect(HostBooking.safeParse(body).success).toBe(true)
      expect(body).toMatchObject({
        id: routed.id,
        responses: { topic: 'Final booking answer' },
        location: hostLocation,
      })
      expect(body).toHaveProperty('routing', routing)
    }
    expect(await okBody(await get(routed.id, 'routed-admin'))).toEqual({ id: routed.id, routing })
  })

  it('checks the live host, organization and administrator authority on each detail read', async () => {
    for (const credential of [
      'routed-host-in-personal-space',
      'routed-admin-key',
      'routed-unassigned-member',
    ]) {
      await notFound(await get(routed.id, credential))
    }

    // The resolver still supplies the original principal after the session switches spaces.
    for (const [credential, sessionId, user] of [
      ['routed-browser-host', routed.hostSession, routed.host],
      ['routed-admin', routed.adminSession, routed.admin],
    ] as const) {
      const liveSession = () => db.updateTable('auth.session').where('id', '=', sessionId)
      await liveSession().set({ activeOrganizationId: user.principal.organization.id }).execute()
      try {
        await notFound(await get(routed.id, credential))
      } finally {
        await liveSession().set({ activeOrganizationId: routed.team.id }).execute()
      }
      await okBody(await get(routed.id, credential))
    }

    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', routed.host.id)
      .execute()
    try {
      await notFound(await get(routed.id, 'routed-host'))
    } finally {
      await db
        .updateTable('auth.user')
        .set({ emailVerified: true })
        .where('id', '=', routed.host.id)
        .execute()
    }

    const hostMembership = await db
      .deleteFrom('auth.member')
      .where('userId', '=', routed.host.id)
      .where('organizationId', '=', routed.team.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    try {
      await notFound(await get(routed.id, 'routed-host'))
    } finally {
      await db.insertInto('auth.member').values(hostMembership).execute()
    }

    const adminMembership = () =>
      db
        .updateTable('auth.member')
        .where('userId', '=', routed.admin.id)
        .where('organizationId', '=', routed.team.id)
    await adminMembership().set({ role: 'member' }).execute()
    try {
      await notFound(await get(routed.id, 'routed-admin'))
    } finally {
      await adminMembership().set({ role: 'admin' }).execute()
    }
  })

  it('lets a personal host read from the effective personal session space', async () => {
    const host = await createTestUser(db, 'Personal host')
    const { organization } = host.principal
    const id = await createFixtures(db).booking(organization.id, [host.id], start, end)
    await storeRoutingSnapshot(id, organization.id, null)
    const credential = 'routed-personal-host'
    const sessionId = await session(credential, host, organization)
    const setActiveOrganization = (activeOrganizationId: string | null) =>
      db
        .updateTable('auth.session')
        .set({ activeOrganizationId })
        .where('id', '=', sessionId)
        .execute()
    for (const activeOrganizationId of [null, routed.team.id]) {
      await setActiveOrganization(activeOrganizationId)
      expect(await okBody(await get(id, credential))).toHaveProperty('routing', routing)
    }
    const team = await createTestTeam(db, [{ user: host, role: 'member' }])
    await setActiveOrganization(team.id)
    await notFound(await get(id, credential))
  })

  it('keeps routing provenance out of the host list and team administrator list and detail', async () => {
    for (const [credential, base] of [
      ['routed-host', path],
      ['routed-admin', teamPath],
    ]) {
      const page = await okBody(await get('', credential, base))
      expect(page).toHaveProperty('data', [expect.objectContaining({ id: routed.id })])
      expect(page).not.toHaveProperty('data.0.routing')
    }
    const teamDetail = await okBody(await get(routed.id, 'routed-admin', teamPath))
    expect(teamDetail).toMatchObject({ id: routed.id })
    expect(teamDetail).not.toHaveProperty('routing')
    expect(teamDetail).not.toHaveProperty('responses')
  })

  it('captures the existing minimal webhook payload for a booking with routing provenance', async () => {
    await db
      .insertInto('webhooks')
      .values({
        organization_id: routed.team.id,
        url: 'https://webhook.example.test/',
        secret_ciphertext: Buffer.from('synthetic fixture'),
        events: ['booking.created'],
      })
      .execute()
    const notify = webhookBookingNotifier({ enqueue: async () => null }, { enabled: true })
    await db
      .transaction()
      .execute((trx) =>
        notify(
          trx,
          { type: 'created', bookingId: routed.id, start: Temporal.Instant.from(start) },
          now(),
        ),
      )
    const delivery = await db
      .selectFrom('webhook_deliveries')
      .select(['event_id', 'payload'])
      .where('booking_id', '=', routed.id)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(delivery.payload)).toEqual({
      id: delivery.event_id,
      type: 'booking.created',
      occurredAt: now().toString(),
      data: {
        bookingId: routed.id,
        organizationId: routed.team.id,
        eventTypeId: null,
        start,
        end,
        status: 'confirmed',
        source: 'api',
        rescheduledFromId: null,
      },
    })
  })
})

it('documents routing only in the host detail response schema', async () => {
  const db = {} as Db
  const document = await openApiDocument(
    productApp(db, new Map(), [bookingRoutes({ db }), teamBookingRoutes({ db })]),
  )
  const response = document.paths[`${path}/{id}`]?.get?.responses['200']
  expect(response?.content?.['application/json']?.schema).toEqual({
    anyOf: [
      { $ref: '#/components/schemas/HostBooking' },
      { $ref: '#/components/schemas/TeamBookingRoutingDetail' },
    ],
  })
  const schemas = document.components.schemas
  expect(schemas.HostBooking).toMatchObject({
    allOf: [
      { $ref: '#/components/schemas/Booking' },
      {
        properties: {
          routing: expect.objectContaining({ $ref: '#/components/schemas/BookingRouting' }),
        },
      },
    ],
  })
  expect(schemas.TeamBookingRoutingDetail).toMatchObject({
    properties: {
      id: { type: 'string', format: 'uuid' },
      routing: { $ref: '#/components/schemas/BookingRouting' },
    },
    required: ['id', 'routing'],
  })
  expect(schemas.Booking).not.toHaveProperty('properties.routing')
  expect(schemas.TeamAdminBooking).not.toHaveProperty('properties.routing')
})
