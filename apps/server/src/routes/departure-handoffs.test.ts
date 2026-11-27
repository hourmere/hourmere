import '@hono/zod-openapi'
import { createHmac, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingNotifier } from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeMicrosoft, TEST_CALENDAR_KEY } from '../../../../packages/calendars/src/testing.ts'
import {
  createHandoffTestFixture,
  createHandoffTestStorage,
  HANDOFF_NOW,
  handoffTestSession,
} from '../../../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'
import { createApp } from '../app.ts'
import { productRoutes } from '../server.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4394'
const secret = 'synthetic-handoff-admin-route-test-secret-000000000000'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!serverUrl)('departure handoff browser routes', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let storage: Awaited<ReturnType<typeof createHandoffTestStorage>>

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
    storage = await createHandoffTestStorage(db)
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
        ...(options.microsoft && {
          microsoftCalendar: { client: options.microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
        }),
        ...(options.notifier !== false && { notify }),
        ...(options.enabled !== false && {
          departureHandoffs: {
            store: { ...storage.store, readLatest },
            now: () => HANDOFF_NOW,
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

  async function fixture(state: 'pending' | 'approved' | 'expired' = 'approved') {
    const f = await createHandoffTestFixture(db)
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
  const apply = (base: string, offerId: string) => `${base}/handoff-offers/${offerId}/apply`
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
      receipt: { ...receipt, conference: 'not_required' },
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
})
