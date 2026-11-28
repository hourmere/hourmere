import '@hono/zod-openapi'
import { createHmac, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingNotifier } from '@hourmere/scheduling'
import type { EnqueueDepartureHandoffEmail } from '@hourmere/scheduling/departure-handoff-proposals'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeMicrosoft, TEST_CALENDAR_KEY } from '../../../../packages/calendars/src/testing.ts'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  handoffTestRecords,
  handoffTestSession,
} from '../../../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { productionAppOptions, productRoutes } from '../server.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4394'
const secret = 'synthetic-handoff-admin-route-test-secret-000000000000'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!serverUrl)('departure handoff browser routes', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let storage: Awaited<ReturnType<typeof handoffTestRecords>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_admin' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    storage = handoffTestRecords(db)
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  function application(
    options: {
      notifier?: boolean
      enabled?: boolean
      microsoft?: ReturnType<typeof fakeMicrosoft>
      enqueue?: EnqueueDepartureHandoffEmail
      smtpConfigured?: boolean
    } = {},
  ) {
    const readLatest = vi.fn(storage.store.readLatest)
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = createApp({
      publicUrl: origin,
      authHandler: auth.handler,
      checkDb: async () => {},
      resolveCaller: createCallerResolver({ auth, db }),
      routes: productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret },
        smtpConfigured: options.smtpConfigured,
        ...(options.microsoft && {
          microsoftCalendar: { client: options.microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
        }),
        ...(options.notifier !== false && { notify }),
        ...(options.enabled !== false && {
          departureHandoffs: {
            store: { ...storage.store, readLatest },
            now: () => HANDOFF_NOW,
            ...(options.enqueue && { enqueue: options.enqueue }),
          },
        }),
      }),
    })
    return { app, readLatest, notify }
  }

  async function cookie(principal: Extract<Principal, { kind: 'session' }>) {
    const { token } = await db
      .selectFrom('auth.session')
      .select('token')
      .where('id', '=', principal.sessionId)
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  async function fixture(state: 'pending' | 'approved' | 'expired' | 'unproposed' = 'approved') {
    const f = await createHandoffTestFixture(db)
    if (state !== 'unproposed')
      await storage.offer(f.ctx, f.input, { departingUserId: f.departing.id }, (offer) => ({
        ...offer,
        ...(state === 'pending' && {
          approvals: offer.approvals.filter(
            ({ recipientKey }) => recipientKey !== 'guest@example.test',
          ),
        }),
        ...(state === 'expired' && { expiresAt: HANDOFF_NOW.toString() }),
      }))
    return {
      ...f,
      base: `/api/v1/team/bookings/${f.booking.id}`,
      headers: {
        cookie: await cookie(f.ctx.principal),
        'x-expected-organization-id': f.team.id,
      },
    }
  }

  const preview = (base: string) => `${base}/handoff-preview`
  const offers = (base: string) => `${base}/handoff-offers`
  const apply = (base: string, offerId: string) => `${offers(base)}/${offerId}/apply`
  const post = (headers: Record<string, string>, body: unknown = { version: 1 }) => ({
    method: 'POST',
    body: JSON.stringify(body),
    headers: { origin, 'content-type': 'application/json', ...headers },
  })

  async function expectError(response: Response, status: number, error: string) {
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ error })
  }

  async function expectUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toEqual([{ id: f.booking.id, status: 'confirmed' }])
    expect(await storage.receipts(f.input)).toEqual([])
  }

  it.each([{ enabled: false }, { notifier: false }])(
    'keeps the staged capability and both actions off without the complete wiring %j',
    async (options) => {
      const f = await fixture()
      const { app, readLatest } = application(options)
      const detail = await app.request(f.base, { headers: f.headers })
      expect(detail.status).toBe(200)
      expect(await detail.json()).not.toHaveProperty('departureHandoffEnabled')
      await expectError(
        await app.request(preview(f.base), { headers: f.headers }),
        404,
        'handoffs_disabled',
      )
      await expectError(
        await app.request(apply(f.base, f.input.offerId), post(f.headers)),
        404,
        'handoffs_disabled',
      )
      expect(readLatest).not.toHaveBeenCalled()
      await expectUnchanged(f)
    },
  )

  it('keeps production admission off with a saved offer and a booking notifier', async () => {
    const f = await fixture()
    const unexpected = async (): Promise<never> => {
      throw new Error('Production handoff should not dispatch work')
    }
    const config = loadConfig({
      DATABASE_URL: owned.url,
      PUBLIC_URL: origin,
      BETTER_AUTH_SECRET: secret,
    })
    const app = createApp(
      productionAppOptions({
        config,
        db,
        auth,
        resolveCaller: createCallerResolver({ auth, db }),
        resolveMcpOAuth: unexpected,
        checkDb: async () => {},
        waitlist: { verify: unexpected, remove: unexpected },
        invitationMailLimits: { secret },
        webhookSettings: { enabled: false },
        webhookQueue: { enqueue: unexpected },
        notify: unexpected,
        notifyAttendeeNoShow: unexpected,
        googleCalendar: undefined,
        microsoftCalendar: undefined,
        zoomConference: undefined,
        enqueueCalendarSync: unexpected,
        enqueueCalendarWritebackRecovery: unexpected,
        mailboxProofQueue: { enqueue: unexpected },
        scimMappingNotices: { enqueue: unexpected },
        enqueueScimInvitation: unexpected,
      }),
    )
    const detail = await app.request(f.base, { headers: f.headers })
    expect(detail.status).toBe(200)
    expect(await detail.json()).not.toHaveProperty('departureHandoffEnabled')
    await expectError(
      await app.request(preview(f.base), { headers: f.headers }),
      404,
      'handoffs_disabled',
    )
    await expectError(
      await app.request(apply(f.base, f.input.offerId), post(f.headers)),
      404,
      'handoffs_disabled',
    )
    const path = `${offers(f.base)}/${f.input.offerId}`
    const recipientId = randomUUID()
    for (const response of [
      await app.request(offers(f.base), post(f.headers, { departingUserId: f.departing.id })),
      await app.request(path, { headers: f.headers }),
      await app.request(`${path}/withdraw`, post(f.headers)),
      await app.request(
        `${path}/resend`,
        post({ ...f.headers, 'idempotency-key': randomUUID() }, { version: 1, recipientId }),
      ),
    ]) {
      await expectError(response, 404, 'handoffs_disabled')
    }
    await expectUnchanged(f)
  })

  it('authorizes the staged proposal actions and binds them to the exact team and offer version', async () => {
    const f = await fixture('unproposed')
    const enqueue = vi.fn<EnqueueDepartureHandoffEmail>(async () => randomUUID())
    const { app, notify } = application({ enqueue })
    const collection = offers(f.base)
    const body = { departingUserId: f.departing.id }

    await expectError(
      await app.request(
        collection,
        post({ ...f.headers, authorization: 'Bearer synthetic' }, body),
      ),
      403,
      'team_management_access_denied',
    )
    await expectError(
      await app.request(
        collection,
        post({ ...f.headers, origin: 'https://untrusted.example' }, body),
      ),
      403,
      'forbidden',
    )
    await expectError(
      await app.request(collection, post({ cookie: f.headers.cookie }, body)),
      409,
      'organization_context_changed',
    )
    expect(enqueue).not.toHaveBeenCalled()

    const proposed = await app.request(collection, post(f.headers, body))
    expect(proposed.status).toBe(201)
    expect(proposed.headers.get('cache-control')).toBe('no-store')
    const first = (await proposed.json()) as {
      id: string
      version: number
      recipients: { id: string; delivery: string }[]
    }
    expect(first).toMatchObject({
      id: expect.any(String),
      version: 1,
      state: 'live',
      recipients: [
        { id: expect.any(String), delivery: 'queued' },
        { id: expect.any(String), delivery: 'queued' },
      ],
    })
    expect(enqueue).toHaveBeenCalledTimes(2)
    const path = `${collection}/${first.id}`
    const current = await app.request(`${path}?version=1`, { headers: f.headers })
    expect(current.status).toBe(200)
    expect(current.headers.get('cache-control')).toBe('no-store')
    expect(await current.json()).toEqual(first)

    const member = await handoffTestSession(db, f.candidate, f.team.as(f.candidate).organization)
    const memberHeaders = { ...f.headers, cookie: await cookie(member) }
    const recipientId = first.recipients[0]?.id
    if (!recipientId) throw new Error('Missing proposal recipient')
    const resendBody = { version: 1, recipientId }
    const resendHeaders = { ...f.headers, 'idempotency-key': randomUUID() }
    await expectError(
      await app.request(path, { headers: memberHeaders }),
      403,
      'team_management_access_denied',
    )
    await expectError(
      await app.request(
        `${path}/resend`,
        post({ ...resendHeaders, authorization: '' }, resendBody),
      ),
      403,
      'team_management_access_denied',
    )
    await expectError(
      await app.request(`${path}/withdraw`, post(memberHeaders)),
      403,
      'team_management_access_denied',
    )
    await expectError(
      await app.request(`${path}/resend`, post(resendHeaders, resendBody)),
      409,
      'handoff_delivery_pending',
    )
    const other = await fixture('unproposed')
    await expectError(
      await app.request(`${offers(other.base)}/${first.id}`, { headers: f.headers }),
      404,
      'booking_not_found',
    )
    await expectError(
      await app.request(`${collection}/${randomUUID()}`, { headers: f.headers }),
      404,
      'handoff_offer_not_found',
    )

    await db
      .updateTable('departure_handoff_deliveries')
      .set({ state: 'failed' })
      .where('recipient_id', '=', recipientId)
      .execute()
    const resent = await app.request(`${path}/resend`, post(resendHeaders, resendBody))
    expect(resent.status).toBe(200)
    const replay = await app.request(`${path}/resend`, post(resendHeaders, resendBody))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(await resent.json())
    expect(enqueue).toHaveBeenCalledTimes(3)

    await db
      .updateTable('departure_handoff_recipients')
      .set({ decision: 'approved', decided_at: HANDOFF_NOW.toString() })
      .where('id', '=', recipientId)
      .execute()
    const revised = await app.request(
      collection,
      post(f.headers, { ...body, previous: { offerId: first.id, version: 1 } }),
    )
    expect(revised.status).toBe(201)
    expect(await revised.json()).toMatchObject({
      id: first.id,
      version: 2,
      state: 'live',
      recipients: [{ decision: 'pending' }, { decision: 'pending' }],
    })
    expect(
      await (await app.request(`${path}?version=1`, { headers: f.headers })).json(),
    ).toMatchObject({ version: 1, state: 'superseded' })
    await expectError(
      await app.request(
        `${path}/resend`,
        post({ ...resendHeaders, 'idempotency-key': randomUUID() }, resendBody),
      ),
      409,
      'handoff_offer_changed',
    )
    const withdrawn = await app.request(`${path}/withdraw`, post(f.headers, { version: 2 }))
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.headers.get('cache-control')).toBe('no-store')
    expect(await withdrawn.json()).toMatchObject({ version: 2, state: 'withdrawn' })
    expect(enqueue).toHaveBeenCalledTimes(5)
    expect(notify).not.toHaveBeenCalled()
    await expectUnchanged(f)
  })

  it('returns only a safe slot and approval count and refuses a crafted approval or missing guest', async () => {
    const f = await fixture('pending')
    const { app, notify } = application()
    const detail = await app.request(f.base, { headers: f.headers })
    expect(await detail.json()).toMatchObject({ departureHandoffEnabled: true })
    const response = await app.request(preview(f.base), { headers: f.headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      offer: {
        id: f.input.offerId,
        version: 1,
        expiresAt: Temporal.Instant.from(f.booking.start).toString(),
        state: 'pending',
        outstandingApprovals: 1,
      },
      preview: {
        candidateName: 'Replacement host',
        start: Temporal.Instant.from(f.booking.start).toString(),
        end: Temporal.Instant.from(f.booking.end).toString(),
        evaluatedAt: HANDOFF_NOW.toString(),
        availability: 'available',
        locationKind: null,
      },
      receipt: null,
    })
    const path = apply(f.base, f.input.offerId)
    await expectError(
      await app.request(path, post(f.headers, { version: 1, approvals: [] })),
      400,
      'invalid_request',
    )
    await expectError(await app.request(path, post(f.headers)), 409, 'handoff_consent_required')
    expect(notify).not.toHaveBeenCalled()
    await expectUnchanged(f)
  })

  it('previews approved Teams terms in a read-only snapshot and reports lost eligibility safely', async () => {
    const f = await createHandoffTestFixture(db, {
      applyContext: { microsoftCalendarEnabled: true },
    })
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: f.candidate.id,
        provider: 'microsoft',
        external_account_id: randomUUID(),
        status: 'active',
        credentials: Buffer.from('synthetic-read-only-teams-fixture'),
        scopes: ['Calendars.ReadWrite'],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: 'Private fixture calendar',
        access_role: 'owner',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: f.candidate.id,
        handle: `host-${f.candidate.id.slice(0, 8)}-${f.candidate.id.slice(-12)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendar.id,
      })
      .execute()
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify([{ id: 'teams', kind: 'microsoft_teams' }]) })
      .where('id', '=', f.eventTypeId)
      .execute()
    await storage.offer(f.ctx, f.input, { departingUserId: f.departing.id })

    const microsoft = fakeMicrosoft()
    const { app, notify } = application({ microsoft })
    const base = `/api/v1/team/bookings/${f.booking.id}`
    const headers = {
      cookie: await cookie(f.ctx.principal),
      'x-expected-organization-id': f.team.id,
    }
    const staleCalendar = await app.request(preview(base), { headers })
    expect(staleCalendar.status).toBe(200)
    expect(await staleCalendar.json()).toMatchObject({
      issue: 'calendar_sync_unavailable',
      offer: { state: 'ready', outstandingApprovals: 0 },
      preview: null,
    })
    await db
      .updateTable('calendars')
      .set({ check_conflicts: false })
      .where('id', '=', calendar.id)
      .execute()

    const current = await app.request(preview(base), { headers })
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({
      offer: { state: 'ready', outstandingApprovals: 0 },
      preview: { availability: 'available', locationKind: 'microsoft_teams' },
    })

    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['Calendars.Read'] })
      .where('id', '=', connection.id)
      .execute()
    const cannotVerify = await app.request(preview(base), { headers })
    expect(cannotVerify.status).toBe(200)
    expect(await cannotVerify.json()).toEqual({
      issue: 'location_unavailable',
      offer: {
        id: f.input.offerId,
        version: 1,
        expiresAt: Temporal.Instant.from(f.booking.start).toString(),
        state: 'unverified',
      },
      preview: null,
      receipt: null,
    })
    await expectError(
      await app.request(apply(base, f.input.offerId), post(headers)),
      409,
      'location_unavailable',
    )
    expect(microsoft.calls).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
    await expectUnchanged({ ...f, base, headers })
  })

  it('shows expiry and rejects a submit when all saved approvals were previously present', async () => {
    const f = await fixture('expired')
    const { app, notify } = application()
    const response = await app.request(preview(f.base), { headers: f.headers })
    expect(await response.json()).toEqual({
      offer: {
        id: f.input.offerId,
        version: 1,
        expiresAt: HANDOFF_NOW.toString(),
        state: 'expired',
      },
      preview: null,
      receipt: null,
    })
    await expectError(
      await app.request(apply(f.base, f.input.offerId), post(f.headers)),
      409,
      'handoff_offer_changed',
    )
    expect(notify).not.toHaveBeenCalled()
    await expectUnchanged(f)
  })

  it('requires a live manager session, a same-origin write and its original team context', async () => {
    const f = await fixture()
    const { app, readLatest, notify } = application()
    const member = await handoffTestSession(db, f.candidate, f.team.as(f.candidate).organization)
    const path = apply(f.base, f.input.offerId)
    for (const headers of [
      { ...f.headers, cookie: '' },
      { ...f.headers, cookie: await cookie(member) },
      { ...f.headers, authorization: '' },
      { ...f.headers, authorization: 'Bearer synthetic-invalid-agent' },
    ]) {
      await expectError(
        await app.request(preview(f.base), { headers }),
        403,
        'team_management_access_denied',
      )
      await expectError(
        await app.request(path, post(headers)),
        403,
        'team_management_access_denied',
      )
    }
    await expectError(
      await app.request(path, post({ ...f.headers, origin: 'https://untrusted.example' })),
      403,
      'forbidden',
    )
    await expectError(
      await app.request(path, post({ cookie: f.headers.cookie })),
      409,
      'organization_context_changed',
    )
    expect(readLatest).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    await expectUnchanged(f)
  })

  it('treats outside-team sources exactly like missing sources without consulting consent storage', async () => {
    const first = await fixture()
    const other = await fixture()
    const { app, readLatest } = application()
    for (const id of [other.booking.id, randomUUID()]) {
      const base = `/api/v1/team/bookings/${id}`
      await expectError(
        await app.request(preview(base), { headers: first.headers }),
        404,
        'booking_not_found',
      )
      await expectError(
        await app.request(apply(base, other.input.offerId), post(first.headers)),
        404,
        'booking_not_found',
      )
    }
    expect(readLatest).not.toHaveBeenCalled()
    await expectUnchanged(first)
    await expectUnchanged(other)
  })

  it('applies as a current admin, protects the exact version and only queues lifecycle work once', async () => {
    const f = await fixture()
    const admin = await handoffTestSession(db, f.candidate, f.team.as(f.candidate).organization)
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.candidate.id)
      .execute()
    const { app, notify } = application()
    const headers = { ...f.headers, cookie: await cookie(admin) }
    const path = apply(f.base, f.input.offerId)
    await expectError(
      await app.request(path, post(headers, { version: 2 })),
      409,
      'handoff_offer_changed',
    )
    const confirmed = await app.request(path, post(headers))
    expect(confirmed.status).toBe(200)
    const receipt = (await confirmed.json()) as {
      sourceBookingId: string
      replacementBookingId: string
    }
    expect(receipt).toEqual({
      sourceBookingId: f.booking.id,
      replacementBookingId: expect.any(String),
    })
    expect(await (await app.request(path, post(headers))).json()).toEqual(receipt)
    expect(await (await app.request(preview(f.base), { headers })).json()).toEqual({
      offer: null,
      preview: null,
      receipt: {
        ...receipt,
        conference: 'not_required',
        mail: { cancellation: 'pending', confirmation: 'pending' },
      },
    })
    expect(notify.mock.calls.map(([, event]) => [event.type, event.bookingId])).toEqual([
      ['cancelled', f.booking.id],
      ['created', receipt.replacementBookingId],
    ])
    expect(await storage.receipts(f.input)).toEqual([
      expect.objectContaining({
        applyingUserId: f.candidate.id,
        replacementBookingId: receipt.replacementBookingId,
      }),
    ])
    const replacement = await db
      .selectFrom('bookings')
      .select(['status', 'rescheduled_from_id', 'required_host_user_ids'])
      .where('id', '=', receipt.replacementBookingId)
      .executeTakeFirstOrThrow()
    expect(replacement).toEqual({
      status: 'confirmed',
      rescheduled_from_id: null,
      required_host_user_ids: [f.candidate.id],
    })
  })

  it('reports both attendee mail states only on the authorized handoff receipt', async () => {
    const f = await fixture()
    const { app, notify } = application()
    const path = preview(f.base)
    const applied = await app.request(apply(f.base, f.input.offerId), post(f.headers))
    expect(applied.status).toBe(200)
    const handoff = (await applied.json()) as {
      sourceBookingId: string
      replacementBookingId: string
    }
    const { sourceBookingId, replacementBookingId } = handoff
    const read = (server = app) => server.request(path, { headers: f.headers })
    const record = await db
      .selectFrom('booking_attendees')
      .select(['booking_id', 'id', 'is_booker'])
      .where('booking_id', 'in', [sourceBookingId, replacementBookingId])
      .execute()
    const cancellationRows = record.filter((row) => row.booking_id === sourceBookingId)
    const replacementBooker = record.find(
      (row) => row.booking_id === replacementBookingId && row.is_booker,
    )
    if (!replacementBooker) throw new Error('Missing replacement booker')

    // Other kinds, host notices and receipts keyed to a different attendee cannot fill either state.
    await db
      .insertInto('booking_notifications')
      .values([
        ...cancellationRows.map((row) => ({
          booking_id: sourceBookingId,
          kind: 'confirmed',
          recipient: `attendee:${row.id}`,
        })),
        {
          booking_id: replacementBookingId,
          kind: 'confirmed',
          recipient: `host:${f.candidate.id}`,
        },
        {
          booking_id: sourceBookingId,
          kind: 'cancelled',
          recipient: `attendee:${replacementBooker.id}`,
        },
      ])
      .execute()
    expect(await (await read()).json()).toMatchObject({
      receipt: { mail: { cancellation: 'pending', confirmation: 'pending' } },
    })
    expect(await (await read(application({ smtpConfigured: false }).app)).json()).toMatchObject({
      receipt: { mail: { cancellation: 'unavailable', confirmation: 'unavailable' } },
    })

    await db
      .insertInto('booking_notifications')
      .values([
        ...cancellationRows.map((row) => ({
          booking_id: sourceBookingId,
          kind: 'cancelled',
          recipient: `attendee:${row.id}`,
        })),
        {
          booking_id: replacementBookingId,
          kind: 'confirmed',
          recipient: `attendee:${replacementBooker.id}`,
          outcome: 'suppressed',
          suppression_reason: 'recipient_hourly_limit',
        },
      ])
      .execute()
    const response = await read()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      offer: null,
      preview: null,
      receipt: {
        ...handoff,
        conference: 'not_required',
        mail: { cancellation: 'accepted', confirmation: 'incomplete' },
      },
    })
    expect(notify).toHaveBeenCalledTimes(2)

    const other = await fixture('unproposed')
    await expectError(await app.request(path, { headers: other.headers }), 404, 'booking_not_found')
    await expectError(
      await app.request(path, { headers: { ...f.headers, authorization: 'Bearer forbidden' } }),
      403,
      'team_management_access_denied',
    )
  })
})
