import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { calendarBookingNotifier } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { EnqueueOptions } from '@hourmere/jobs'
import { BOOKING_NOTIFICATION_JOB, bookingNotifier } from '@hourmere/notifications'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { WEBHOOK_DELIVERY_JOB, webhookBookingNotifier } from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { productionAppOptions } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = randomBytes(32).toString('base64')
const now = Temporal.Instant.from('2030-04-10T12:00:00Z')
const webhookSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
const unavailable = async (): Promise<never> => {
  throw new Error('The write reached an unexpected external dependency')
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!serverUrl)('team writes without an SSO policy', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  let db: Db
  let app: ReturnType<typeof createApp>
  const jobs: { name: string; payload: unknown; inTransaction: boolean }[] = []
  const queue = {
    async enqueue(name: string, payload: unknown, options?: EnqueueOptions) {
      jobs.push({ name, payload, inTransaction: Boolean(options?.transaction) })
      return null
    },
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const config = loadConfig({
      DATABASE_URL: owned.url,
      PUBLIC_URL: origin,
      BETTER_AUTH_SECRET: secret,
    })
    authPool = createAuthPool(owned.url, config.signup)
    const auth = createAuth({
      db,
      pool: authPool,
      baseURL: origin,
      secret,
      signup: config.signup,
      mailer: { send: unavailable },
    })
    const mail = bookingNotifier(queue)
    const calendar = calendarBookingNotifier(queue)
    const webhook = webhookBookingNotifier(queue, webhookSettings)
    app = createApp(
      productionAppOptions({
        config,
        db,
        auth,
        resolveCaller: createCallerResolver({ auth, db }),
        resolveMcpOAuth: unavailable,
        checkDb: unavailable,
        waitlist: { verify: unavailable, remove: unavailable },
        invitationMailLimits: { secret },
        webhookSettings,
        webhookQueue: queue,
        async notify(trx, event, at) {
          await mail(trx, event, at)
          if (!('requestId' in event)) await calendar(trx, event)
          await webhook(trx, event, at)
        },
        notifyAttendeeNoShow: unavailable,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unavailable,
        enqueueCalendarWritebackRecovery: unavailable,
        mailboxProofQueue: { enqueue: unavailable },
      }),
    )
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db, 'Team write owner')
    const member = await createTestUser(db, 'Team write member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { secret, publicUrl: origin },
        {
          userId: owner.id,
          organizationId: team.id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const headers = {
      cookie: session.cookie.split(';')[0] as string,
      origin,
      'x-expected-organization-id': team.id,
    }
    const write = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const audit = (targetId: string) =>
      db.selectFrom('audit_events').select('action').where('target_id', '=', targetId).execute()
    return { owner, member, team, headers, write, audit }
  }

  it('updates a team event’s host schedule and saves account availability in the team space', async () => {
    const { owner, team, headers, write, audit } = await fixture()
    const f = createFixtures(db)
    await f.schedule(owner.id, { timeZone: 'UTC' })
    const scheduleId = await f.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
    const eventId = await f.eventType(team.id, null, { hosts: [{ userId: owner.id }] })
    const edit = await write('PATCH', `/api/v1/event-types/${eventId}`, {
      title: 'Updated team consultation',
      scheduleId,
    })
    expect(await answer(edit)).toMatchObject({
      status: 200,
      body: { id: eventId, title: 'Updated team consultation', scheduleId },
    })
    expect(await audit(eventId)).toEqual([{ action: 'event_type.updated' }])
    expect(
      await db
        .selectFrom('event_type_hosts')
        .select('schedule_id')
        .where('event_type_id', '=', eventId)
        .execute(),
    ).toEqual([{ schedule_id: scheduleId }])

    const path = `/api/v1/schedules/${scheduleId}/availability`
    const initial = await app.request(path, { headers })
    expect(initial.status).toBe(200)
    const { version } = (await initial.json()) as { version: string }
    const input = {
      expectedVersion: version,
      name: 'Updated hours',
      timeZone: 'UTC',
      weeklyHours: { monday: [{ start: '09:00', end: '17:00' }] },
      overrides: [{ date: '2030-04-12', intervals: [] }],
    }
    expect(await answer(await write('PUT', path, input))).toMatchObject({
      status: 200,
      body: { schedule: { id: scheduleId, name: input.name }, overrides: input.overrides },
    })
    expect(await answer(await write('PUT', path, { ...input, name: 'Stale hours' }))).toEqual({
      status: 409,
      body: { error: 'schedule_conflict', message: 'Availability changed; reload before saving' },
    })
  })

  it('reschedules and cancels with the original audit, mail, calendar, and webhook effects', async () => {
    const { owner, team, write, audit } = await fixture()
    const f = createFixtures(db)
    await f.schedule(owner.id, { timeZone: 'UTC' })
    const eventId = await f.eventType(team.id, null, { hosts: [{ userId: owner.id }] })
    const bookingId = await f.booking(
      team.id,
      [owner.id],
      '2030-04-11T09:00:00Z',
      '2030-04-11T09:30:00Z',
      { eventTypeId: eventId },
    )
    const { id: webhookId } = await db
      .insertInto('webhooks')
      .values({
        organization_id: team.id,
        url: 'https://hooks.example.test/booking',
        events: ['booking.rescheduled', 'booking.cancelled'],
        secret_ciphertext: Buffer.alloc(30, 1),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const clock = vi.spyOn(Temporal.Now, 'instant').mockReturnValue(now)
    const reschedulePath = `/api/v1/bookings/${bookingId}/reschedule`
    const start = '2030-04-11T10:00:00Z'
    jobs.length = 0
    try {
      const moved = await write('POST', reschedulePath, { start })
      expect(moved.status).toBe(200)
      const body = (await moved.json()) as { booking: { id: string }; manageToken: null }
      const successorId = body.booking.id
      expect(body).toMatchObject({
        booking: { rescheduledFromId: bookingId, start: '2030-04-11T10:00:00.000Z', source: 'web' },
        manageToken: null,
      })
      const cancelPath = `/api/v1/team/bookings/${successorId}/cancel`
      const reason = 'Host unavailable'
      expect(await answer(await write('POST', cancelPath, { reason }))).toEqual({
        status: 200,
        body: { cancelled: true },
      })
      expect(await answer(await write('POST', cancelPath, {}))).toEqual({
        status: 409,
        body: { error: 'booking_already_cancelled', message: 'This booking is already cancelled' },
      })
      expect(await answer(await write('POST', reschedulePath, { start }))).toEqual({
        status: 409,
        body: { error: 'booking_cancelled', message: 'This booking is already cancelled' },
      })
      expect(
        await db
          .selectFrom('bookings')
          .select(['status', 'cancel_reason'])
          .where('id', '=', successorId)
          .executeTakeFirst(),
      ).toEqual({
        status: 'cancelled',
        cancel_reason: reason,
      })
      expect((await audit(successorId)).map((row) => row.action).sort()).toEqual([
        'booking.cancelled',
        'booking.rescheduled',
      ])
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .select(['id', 'event_type', 'booking_id', 'status'])
        .where('webhook_id', '=', webhookId)
        .orderBy('event_type')
        .execute()
      expect(deliveries).toMatchObject([
        { booking_id: successorId, event_type: 'booking.cancelled', status: 'pending' },
        { booking_id: successorId, event_type: 'booking.rescheduled', status: 'pending' },
      ])
      expect(jobs).toEqual([
        {
          name: BOOKING_NOTIFICATION_JOB,
          payload: { bookingId: successorId, kind: 'rescheduled' },
          inTransaction: true,
        },
        { name: 'booking-calendar', payload: { bookingId }, inTransaction: true },
        {
          name: WEBHOOK_DELIVERY_JOB,
          payload: { deliveryId: deliveries[1]?.id },
          inTransaction: true,
        },
        {
          name: BOOKING_NOTIFICATION_JOB,
          payload: { bookingId: successorId, kind: 'cancelled' },
          inTransaction: true,
        },
        { name: 'booking-calendar', payload: { bookingId }, inTransaction: true },
        {
          name: WEBHOOK_DELIVERY_JOB,
          payload: { deliveryId: deliveries[0]?.id },
          inTransaction: true,
        },
      ])
    } finally {
      clock.mockRestore()
    }
  })

  it('changes roles and removes members with the original handling response', async () => {
    const { member, team, write } = await fixture()
    const row = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .executeTakeFirstOrThrow()
    const eventId = await createFixtures(db).eventType(team.id, null, {
      hosts: [{ userId: member.id }],
    })
    const role = await write('POST', '/api/auth/organization/update-member-role', {
      organizationId: team.id,
      memberId: row.id,
      role: 'admin',
    })
    expect(role.status).toBe(200)
    expect(
      await db.selectFrom('auth.member').select('role').where('id', '=', row.id).executeTakeFirst(),
    ).toEqual({ role: 'admin' })
    const path = `/api/v1/team/members/${member.id}/removal`
    expect(await answer(await write('POST', path, { teamId: team.id }))).toEqual({
      status: 200,
      body: {
        operationId: expect.any(String),
        memberUserId: member.id,
        deactivatedEventTypeIds: [eventId],
      },
    })
    expect(
      await db.selectFrom('auth.member').select('id').where('id', '=', row.id).executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('event_types')
        .select('is_active')
        .where('id', '=', eventId)
        .executeTakeFirst(),
    ).toEqual({ is_active: false })
    expect(await answer(await write('POST', path, { teamId: team.id }))).toEqual({
      status: 403,
      body: { error: 'team_management_access_denied' },
    })
  })

  it('keeps team API keys usable for REST and MCP writes until revoked', async () => {
    const { team, write, audit } = await fixture()
    const keyResponse = await write('POST', '/api/auth/api-key/create', {
      name: 'Fixture team key',
      metadata: { organizationId: team.id, scope: 'full' },
    })
    expect(keyResponse.status).toBe(200)
    const { id: keyId, key } = (await keyResponse.json()) as { id: string; key: string }
    expect(key.startsWith('hm_')).toBe(true)
    const webhook = await db
      .insertInto('webhooks')
      .values({
        organization_id: team.id,
        url: 'https://hooks.example.com/updates',
        events: ['booking.created'],
        secret_ciphertext: Buffer.alloc(30, 1),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const update = () =>
      app.request(`/api/v1/webhooks/${webhook.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ isActive: false }),
      })
    expect(await answer(await update())).toMatchObject({
      status: 200,
      body: {
        id: webhook.id,
        organizationId: team.id,
        events: ['booking.created'],
        isActive: false,
      },
    })
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'update_webhook', arguments: { id: webhook.id, isActive: true } },
      }),
    })
    expect(mcp.status).toBe(200)
    const text = await mcp.text()
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    expect(JSON.parse(data ? data.slice(6) : text)).toMatchObject({
      result: { structuredContent: { id: webhook.id, organizationId: team.id, isActive: true } },
    })
    expect((await audit(webhook.id)).map((row) => row.action).sort()).toEqual([
      'webhook.paused',
      'webhook.resumed',
    ])
    expect(await answer(await write('POST', '/api/auth/api-key/delete', { keyId }))).toEqual({
      status: 200,
      body: { success: true },
    })
    expect((await audit(keyId)).map((row) => row.action).sort()).toEqual([
      'api_key.created',
      'api_key.revoked',
    ])
    expect(await answer(await update())).toEqual({ status: 401, body: { error: 'unauthorized' } })
  })
})
