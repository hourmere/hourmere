import '@hono/zod-openapi'
import { createHmac, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotificationJob,
  bookingNotifier,
  hasPendingHandoffCancellation,
  type NotificationQueue,
} from '@hourmere/notifications'
import type { BookingNotifier } from '@hourmere/scheduling'
import type { EnqueueDepartureHandoffEmail } from '@hourmere/scheduling/departure-handoff-proposals'
import type { EnqueueDepartureHandoffRun } from '@hourmere/scheduling/departure-handoff-queue'
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
  let stopJobs: (() => Promise<void>) | undefined

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
    try {
      await stopJobs?.()
    } finally {
      await pool?.end()
      await owned?.drop()
    }
  })

  function application(
    options: {
      notifier?: boolean
      enabled?: boolean
      microsoft?: ReturnType<typeof fakeMicrosoft>
      enqueue?: EnqueueDepartureHandoffEmail
      smtpConfigured?: boolean
      enqueueRun?: EnqueueDepartureHandoffRun
      mailQueue?: NotificationQueue
    } = {},
  ) {
    const readLatest = vi.fn(storage.store.readLatest)
    const notify = vi.fn<BookingNotifier>(
      options.mailQueue ? bookingNotifier(options.mailQueue) : async () => {},
    )
    const resolveCaller = vi.fn(createCallerResolver({ auth, db }))
    const app = createApp({
      publicUrl: origin,
      authHandler: auth.handler,
      checkDb: async () => {},
      resolveCaller,
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
            ...(options.mailQueue && { hasPendingCancellation: hasPendingHandoffCancellation }),
            ...(options.enqueue && { enqueue: options.enqueue }),
            ...(options.enqueueRun && { enqueueRun: options.enqueueRun }),
          },
        }),
      }),
    })
    return { app, readLatest, notify, resolveCaller }
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
  const runs = '/api/v1/team/bookings/handoff-runs'
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
        enqueueDepartureHandoffRun: unexpected,
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
    const runId = randomUUID()
    for (const response of [
      await app.request(offers(f.base), post(f.headers, { departingUserId: f.departing.id })),
      await app.request(path, { headers: f.headers }),
      await app.request(`${path}/withdraw`, post(f.headers)),
      await app.request(
        `${path}/resend`,
        post({ ...f.headers, 'idempotency-key': randomUUID() }, { version: 1, recipientId }),
      ),
      await app.request(runs, post(f.headers, { runId, departingUserId: f.departing.id })),
      await app.request(`${runs}/${runId}`, { headers: f.headers }),
      await app.request(`${runs}/${runId}/control`, post(f.headers, { action: 'stop' })),
    ]) {
      await expectError(response, 404, 'handoffs_disabled')
    }
    await expectUnchanged(f)
  })

  it('binds the staged run to a live team management session and returns only the receipt', async () => {
    const f = await fixture()
    const other = await fixture()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.departing.id)
      .execute()
    const enqueueRun = vi.fn<EnqueueDepartureHandoffRun>(async () => randomUUID())
    const { app, notify } = application({ enqueueRun })
    const runId = randomUUID()
    const body = { runId, departingUserId: f.departing.id }
    const runPath = `${runs}/${runId}`
    await expectError(
      await app.request(runs, post({ ...f.headers, authorization: 'Bearer synthetic' }, body)),
      403,
      'team_management_access_denied',
    )
    await expectError(
      await app.request(runs, post({ ...f.headers, origin: 'https://elsewhere.example' }, body)),
      403,
      'forbidden',
    )
    await expectError(
      await app.request(runs, post({ cookie: f.headers.cookie }, body)),
      409,
      'organization_context_changed',
    )
    expect(enqueueRun).not.toHaveBeenCalled()

    const start = await app.request(runs, post(f.headers, body))
    expect(start.status).toBe(200)
    expect(start.headers.get('cache-control')).toBe('no-store')
    const receipt = {
      id: runId,
      departingUserId: f.departing.id,
      state: 'running',
      failureCode: null,
      items: [
        {
          sourceBookingId: f.booking.id,
          offerId: f.input.offerId,
          version: 1,
          outcome: 'pending',
          replacementBookingId: null,
        },
      ],
    }
    expect(await start.json()).toEqual(receipt)
    const replay = await app.request(runs, post(f.headers, body))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
    expect(enqueueRun).toHaveBeenCalledTimes(1)
    await expectError(
      await app.request(runPath, { headers: other.headers }),
      404,
      'handoff_run_not_found',
    )
    await expectError(
      await app.request(`${runPath}/control`, post(other.headers, { action: 'stop' })),
      404,
      'handoff_run_not_found',
    )
    const status = await app.request(runPath, { headers: f.headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual(receipt)

    for (const [action, state] of [
      ['pause', 'paused'],
      ['resume', 'running'],
      ['stop', 'stopped'],
    ] as const) {
      const result = await app.request(`${runPath}/control`, post(f.headers, { action }))
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ state })
    }
    const stopped = await app.request(runPath, { headers: f.headers })
    expect(await stopped.json()).toMatchObject({
      state: 'stopped',
      items: [{ outcome: 'stopped' }],
    })
    expect(notify).not.toHaveBeenCalled()
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

  it('requires a browser management session for proposal status, resend and withdrawal', async () => {
    const f = await fixture('pending')
    const other = await fixture('pending')
    const enqueue = vi.fn<EnqueueDepartureHandoffEmail>(async () => randomUUID())
    const { app, resolveCaller } = application({ enqueue })
    const recipient = await db
      .selectFrom('departure_handoff_recipients')
      .select('id')
      .where('source_booking_id', '=', f.booking.id)
      .where('decision', 'is', null)
      .executeTakeFirstOrThrow()
    const requestKey = randomUUID()
    const actions = [
      (path: string, headers: Record<string, string>) => app.request(path, { headers }),
      (path: string, headers: Record<string, string>) =>
        app.request(
          `${path}/resend`,
          post(
            { ...headers, 'idempotency-key': requestKey },
            { version: 1, recipientId: recipient.id },
          ),
        ),
      (path: string, headers: Record<string, string>) =>
        app.request(`${path}/withdraw`, post(headers)),
    ]
    const credentialHeaders: Record<string, string>[] = [
      { 'x-expected-organization-id': f.team.id },
      { ...f.headers, authorization: 'Bearer synthetic-invalid-agent' },
      { ...f.headers, authorization: '' },
    ]
    const provisioningHeaders = { ...f.headers, authorization: 'Bearer scim_synthetic' }
    credentialHeaders.push(provisioningHeaders)
    const member = await handoffTestSession(db, f.candidate, f.team.as(f.candidate).organization)
    credentialHeaders.push({ ...f.headers, cookie: await cookie(member) })
    for (const scope of ['full', 'read', 'bookings'] as const) {
      const { key } = await auth.api.createApiKey({
        body: { userId: f.owner.id, metadata: { scope, organizationId: f.team.id } },
      })
      const authorization = `Bearer ${key}`
      const result = await resolveCaller(new Headers({ authorization }))
      if (!result.ok || result.principal.kind !== 'api_key') throw new Error('Invalid fixture key')
      expect(result.principal.organization.id).toBe(f.team.id)
      credentialHeaders.push(
        { 'x-expected-organization-id': f.team.id, authorization },
        { ...f.headers, authorization },
      )
    }
    resolveCaller.mockClear()

    const path = `${offers(f.base)}/${f.input.offerId}`
    const otherPath = `${offers(other.base)}/${other.input.offerId}`
    const missingPath = `${offers(`/api/v1/team/bookings/${randomUUID()}`)}/${other.input.offerId}`
    for (const request of actions) {
      for (const headers of credentialHeaders) {
        await expectError(await request(path, headers), 403, 'team_management_access_denied')
      }
      await expectError(
        await request(path, { ...other.headers, 'x-expected-organization-id': f.team.id }),
        403,
        'team_management_access_denied',
      )
      const missing = await request(missingPath, f.headers)
      const foreign = await request(otherPath, f.headers)
      expect(missing.status).toBe(404)
      expect(foreign.status).toBe(missing.status)
      expect(await foreign.json()).toEqual(await missing.json())
    }
    const live = await app.request(path, { headers: f.headers })
    expect(live.status).toBe(200)
    expect(await live.json()).toMatchObject({
      state: 'live',
      recipients: expect.arrayContaining([expect.objectContaining({ resendAvailable: true })]),
    })
    await expectError(
      await app.request('/api/v1/me', { headers: provisioningHeaders }),
      401,
      'unauthorized',
    )
    expect(resolveCaller.mock.calls.some(([headers]) => headers.has('authorization'))).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
    await expectUnchanged(f)
    await expectUnchanged(other)
  })

  it('projects safe proposal status and revokes links even when the mail queue is unavailable', async () => {
    const f = await fixture('pending')
    const { app } = application()
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.candidate.id)
      .execute()
    const admin = await handoffTestSession(db, f.candidate, f.team.as(f.candidate).organization)
    const headers = { ...f.headers, cookie: await cookie(admin) }
    const pending = await db
      .updateTable('departure_handoff_recipients')
      .set({ token_digest: 'a'.repeat(64) })
      .where('source_booking_id', '=', f.booking.id)
      .where('decision', 'is', null)
      .returning('id')
      .executeTakeFirstOrThrow()
    const path = `${offers(f.base)}/${f.input.offerId}`
    const read = await app.request(path, { headers })
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('no-store')
    const recipients = await db
      .selectFrom('departure_handoff_recipients as recipient')
      .innerJoin('booking_attendees as attendee', (join) =>
        join
          .onRef('attendee.booking_id', '=', 'recipient.source_booking_id')
          .onRef('attendee.email', '=', 'recipient.recipient_key'),
      )
      .select(['recipient.id', 'attendee.id as attendeeId', 'recipient.decision'])
      .where('recipient.source_booking_id', '=', f.booking.id)
      .orderBy('recipient.id')
      .execute()
    const projection = {
      id: f.input.offerId,
      version: 1,
      expiresAt: expect.any(String),
      state: 'live',
      recipients: recipients.map(({ id, attendeeId, decision }) => ({
        id,
        attendeeIds: [attendeeId],
        decision: decision ?? 'pending',
        delivery: 'not_requested',
        resendAvailable: false,
      })),
    }
    expect(recipients).toHaveLength(2)
    expect(await read.json()).toEqual(projection)
    const withdrawn = await app.request(`${path}/withdraw`, post(headers))
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.headers.get('cache-control')).toBe('no-store')
    expect(await withdrawn.json()).toEqual({
      ...projection,
      state: 'withdrawn',
    })
    expect(
      await db
        .selectFrom('departure_handoff_recipients')
        .select('token_digest')
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ token_digest: null })
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
    const mailQueue = createJobs({
      connectionString: owned.url,
      definitions: [
        bookingNotificationJob({
          db,
          secret,
          publicUrl: origin,
          mailer: { send: async () => {} },
        }),
      ],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    stopJobs = () => mailQueue.stop()
    await mailQueue.start()
    const { app, notify } = application({ mailQueue })
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
    expect(
      await (await read(application({ smtpConfigured: false, mailQueue }).app)).json(),
    ).toMatchObject({
      receipt: { mail: { cancellation: 'unavailable', confirmation: 'unavailable' } },
    })

    const jobKey = `${sourceBookingId}:cancelled`
    for (const state of ['retry', 'active', 'failed', 'cancelled', 'completed']) {
      const updated = await owned.pool.query(
        `UPDATE pgboss.job SET state = $1 WHERE name = $2 AND singleton_key = $3`,
        [state, BOOKING_NOTIFICATION_JOB, jobKey],
      )
      expect(updated.rowCount).toBe(1)
      expect(await (await read()).json()).toMatchObject({
        receipt: {
          mail: {
            cancellation: state === 'retry' || state === 'active' ? 'pending' : 'incomplete',
            confirmation: 'pending',
          },
        },
      })
    }
    await owned.pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
      BOOKING_NOTIFICATION_JOB,
      jobKey,
    ])
    expect(await (await read()).json()).toMatchObject({
      receipt: { mail: { cancellation: 'incomplete', confirmation: 'pending' } },
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
