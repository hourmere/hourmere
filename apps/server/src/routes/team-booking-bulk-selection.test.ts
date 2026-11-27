import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob, type Jobs } from '@hourmere/jobs'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { startServer } from '../server.ts'
import type { EnqueueBulkCancellation } from '../team-booking-bulk-admission.ts'
import { TEAM_BOOKING_BULK_JOB, TEAM_BOOKING_BULK_RECOVERY_JOB } from '../team-booking-bulk-jobs.ts'
import { issueBulkPageProof } from '../team-booking-bulk-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'
import { teamBookingBulkPreviewRoutes } from './team-booking-bulk-preview.ts'
import { teamBookingRoutes } from './team-bookings.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = 'synthetic-bulk-booking-selection-test-secret'
const listPath = '/api/v1/team/bookings'
const bulkPath = `${listPath}/bulk-cancellations`
const previewPath = `${bulkPath}/preview`
const wake = defineJob({
  name: 'test-bulk-cancellation-wake',
  payload: z.strictObject({ batchId: z.uuid() }),
})
const { signJWT } = createRequire(import.meta.resolve('@hourmere/auth'))('better-auth/plugins/jwt')

interface Session {
  userId: string
  sessionId: string
  organizationId: string
  cookie: string
}

interface BulkPage {
  data: { id: string }[]
  nextCursor: string | null
  bulkPageToken: string
  bulkPageExpiresAt: string
}

describe.skipIf(!serverUrl)('team booking bulk selection, preview and admission', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>
  let jobs: Jobs<readonly [typeof wake]>
  let enabled: ReturnType<typeof createApp>
  let data: Awaited<ReturnType<typeof seed>>
  const notify = vi.fn()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'bulk_selection' })
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
      mcpOAuth: true,
    })
    resolveCaller = createCallerResolver({ auth, db })
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [wake],
      migrate: true,
      work: false,
      maxConnections: 1,
    })
    await jobs.start()
    enabled = bulkApp()
    data = await seed()
  })

  beforeEach(async () => {
    await db.deleteFrom('team_booking_bulk_request_limits').execute()
    await db.deleteFrom('team_booking_bulk_cancellations').execute()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      try {
        await authPool?.end()
      } finally {
        await owned?.drop()
      }
    }
  })

  const enqueue: EnqueueBulkCancellation = (trx, batchId) =>
    jobs.enqueue(wake.name, { batchId }, { transaction: trx })

  function bulkApp(enqueueBulkCancellation = enqueue) {
    return application([
      teamBookingRoutes({ db, notify, bulkSelectionSecret: secret }),
      teamBookingBulkPreviewRoutes({ db, bulkSelectionSecret: secret, enqueueBulkCancellation }),
    ])
  }

  function application(routes: Parameters<typeof createApp>[0]['routes'], caller = resolveCaller) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: caller,
      routes,
    })
  }

  async function withRunningServer(
    flag: 'true' | undefined,
    verify: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>,
  ) {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    try {
      const server = await startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        HOURMERE_ROLE: 'all',
        PORT: '0',
        PUBLIC_URL: origin,
        TEAM_BOOKING_BULK_CANCELLATION_ENABLED: flag,
      })
      try {
        await verify((path, init) => fetch(`http://127.0.0.1:${server.port}${path}`, init))
      } finally {
        await server.close()
      }
    } finally {
      for (const log of logs) log.mockRestore()
    }
  }

  async function recoveryCrons() {
    const { rows } = await owned.pool.query<{ cron: string }>(
      'SELECT cron FROM pgboss.schedule WHERE name=$1',
      [TEAM_BOOKING_BULK_RECOVERY_JOB],
    )
    return rows.map(({ cron }) => cron)
  }

  async function session(user: TestUser, organizationId: string): Promise<Session> {
    const token = randomBytes(24).toString('base64url')
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      userId: user.id,
      sessionId: row.id,
      organizationId,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function seed() {
    const owner = await createTestUser(db, 'Team owner')
    const admin = await createTestUser(db, 'Team admin')
    const host = await createTestUser(db, 'Booking host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: host, role: 'member' },
    ])
    const other = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const f = createFixtures(db)
    const first = await f.booking(team.id, [host.id], '2099-01-01T09:00Z', '2099-01-01T09:30Z', {
      attendee: { name: 'Search term first', email: 'only-in-list@example.com' },
    })
    const second = await f.booking(team.id, [host.id], '2099-01-01T10:00Z', '2099-01-01T10:30Z')
    const third = await f.booking(team.id, [host.id], '2099-01-01T11:00Z', '2099-01-01T11:30Z', {
      attendee: { name: 'Search term third', email: 'also-only-in-list@example.com' },
    })
    const foreign = await f.booking(
      other.id,
      [owner.id],
      '2099-01-01T09:00Z',
      '2099-01-01T09:30Z',
      {
        attendee: { name: 'Search term foreign', email: 'foreign@example.com' },
      },
    )
    return {
      first,
      second,
      third,
      foreign,
      owner,
      team,
      other,
      admin: await session(admin, team.id),
      manager: await session(owner, team.id),
      host: await session(host, team.id),
      otherManager: await session(owner, other.id),
      personal: await session(owner, owner.principal.organization.id),
    }
  }

  function headersFor(actor?: Session, overrides?: Record<string, string>) {
    const headers = new Headers({ origin })
    if (actor) {
      headers.set('cookie', actor.cookie)
      headers.set(EXPECTED_ORGANIZATION_HEADER, actor.organizationId)
    }
    for (const [name, value] of new Headers(overrides)) headers.set(name, value)
    return headers
  }

  function list(
    actor?: Session,
    filters: Record<string, string> = {},
    headers?: Record<string, string>,
  ) {
    const query = new URLSearchParams({ bulkSelection: 'true', ...filters })
    return enabled.request(`${listPath}?${query}`, { headers: headersFor(actor, headers) })
  }

  async function page(actor: Session, filters?: Record<string, string>): Promise<BulkPage> {
    const response = await list(actor, filters)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const result = (await response.json()) as BulkPage
    expect(result.bulkPageToken).toEqual(expect.any(String))
    expect(result.bulkPageExpiresAt).toEqual(expect.any(String))
    return result
  }

  function preview(
    actor: Session | undefined,
    pageToken: string,
    bookingIds: string[],
    overrides?: Record<string, string>,
  ) {
    const headers = headersFor(actor, overrides)
    headers.set('content-type', 'application/json')
    return enabled.request(previewPath, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pageToken, bookingIds }),
    })
  }

  function confirmation(
    actor: Session | undefined,
    id: string,
    {
      app = enabled,
      body,
      overrides,
    }: {
      app?: ReturnType<typeof createApp>
      body?: string
      overrides?: Record<string, string>
    } = {},
  ) {
    const headers = headersFor(actor, overrides)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return app.request(`${bulkPath}/${id}/confirm`, {
      method: 'POST',
      headers,
      ...(body !== undefined && { body }),
    })
  }

  function status(actor: Session | undefined, id: string, app = enabled) {
    return app.request(`${bulkPath}/${id}`, { headers: headersFor(actor) })
  }

  async function previewReceipt(actor: Session, ids: string[]) {
    const proof = await page(actor)
    const response = await preview(actor, proof.bulkPageToken, ids)
    expect(response.status).toBe(200)
    return (await response.json()) as { confirmationId: string; expiresAt: string }
  }

  async function admissionEffects(id: string) {
    const events = await db
      .selectFrom('audit_events')
      .select(['request_id', 'actor_id', 'credential_id', 'details', 'action'])
      .where('target_id', '=', id)
      .execute()
    const queued = (
      await owned.pool.query<{ data: unknown }>(
        "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'batchId' = $2",
        [wake.name, id],
      )
    ).rows
    return { events, queued }
  }

  async function completeTestBatch(id: string) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('team_booking_bulk_cancellation_items')
        .set({ outcome: 'processing_failed', next_attempt_at: null })
        .where('batch_id', '=', id)
        .where('outcome', '=', 'pending')
        .execute()
      await trx
        .updateTable('team_booking_bulk_cancellations')
        .set({ state: 'completed', completed_at: sql`clock_timestamp()` })
        .where('id', '=', id)
        .execute()
    })
  }

  async function expectError(response: Response, status: number, error: string) {
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error })
  }

  async function receiptCount() {
    const { count } = await db
      .selectFrom('team_booking_bulk_cancellations')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow()
    return Number(count)
  }

  it('issues proof for one filtered page in order and stores a private server-generated preview', async () => {
    const { admin, first, third } = data
    const result = await page(admin, { q: ' Search term ', order: 'desc', limit: '2' })
    expect(result.data.map(({ id }) => id)).toEqual([third, first])
    expect(result.nextCursor).toBeNull()
    const before = await db.selectFrom('bookings').selectAll().orderBy('id').execute()
    const response = await preview(admin, result.bulkPageToken, [first.toUpperCase(), third])
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = (await response.json()) as { confirmationId: string }
    expect(body).toEqual({
      confirmationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresAt: result.bulkPageExpiresAt,
      items: [
        { bookingId: third, code: 'eligible' },
        { bookingId: first, code: 'eligible' },
      ],
    })
    const receipt = await db
      .selectFrom('team_booking_bulk_cancellations')
      .selectAll()
      .where('id', '=', body.confirmationId)
      .executeTakeFirstOrThrow()
    expect(receipt).toMatchObject({
      organization_id: admin.organizationId,
      actor_user_id: admin.userId,
      session_id: admin.sessionId,
    })
    expect(JSON.stringify(receipt)).not.toContain(result.bulkPageToken)
    expect(JSON.stringify(receipt)).not.toContain('Search term')
    expect(
      await db
        .selectFrom('team_booking_bulk_cancellation_items')
        .select(['batch_id', 'ordinal', 'booking_id', 'preview_outcome'])
        .where('batch_id', '=', receipt.id)
        .orderBy('ordinal')
        .execute(),
    ).toEqual([
      { batch_id: receipt.id, ordinal: 1, booking_id: third, preview_outcome: 'eligible' },
      { batch_id: receipt.id, ordinal: 2, booking_id: first, preview_outcome: 'eligible' },
    ])
    expect(await db.selectFrom('bookings').selectAll().orderBy('id').execute()).toEqual(before)
    for (const table of [
      'audit_events',
      'organization_operations',
      'booking_notifications',
      'payment_refund_obligations',
    ] as const) {
      const { count } = await db
        .selectFrom(table)
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow()
      expect(Number(count)).toBe(0)
    }
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects the whole selection for an unseen ID or a changed page, query, order, team, actor or session', async () => {
    const { manager, admin, otherManager, first, second, third, foreign, owner, team } = data
    const before = await receiptCount()
    const firstPage = await page(manager, { limit: '1' })
    expect(firstPage.data.map(({ id }) => id)).toEqual([first])
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    const secondPage = await page(manager, { limit: '1', cursor: firstPage.nextCursor as string })
    expect(secondPage.data.map(({ id }) => id)).toEqual([second])
    const searched = await page(manager, { q: 'Search term' })
    const descending = await page(admin, { order: 'desc', limit: '1' })
    expect(descending.data.map(({ id }) => id)).toEqual([third])
    expect((await page(otherManager)).data.map(({ id }) => id)).toEqual([foreign])
    const newSession = await session(owner, team.id)
    for (const [actor, token, ids] of [
      [manager, firstPage.bulkPageToken, [first, second]],
      [manager, firstPage.bulkPageToken, [first, foreign]],
      [manager, firstPage.bulkPageToken, [first, randomUUID()]],
      [manager, secondPage.bulkPageToken, [first]],
      [manager, searched.bulkPageToken, [second]],
      [admin, descending.bulkPageToken, [first]],
      [admin, firstPage.bulkPageToken, [first]],
      [newSession, firstPage.bulkPageToken, [first]],
      [otherManager, firstPage.bulkPageToken, [first]],
    ] as const) {
      await expectError(await preview(actor, token, [...ids]), 409, 'bulk_selection_changed')
    }
    expect(await receiptCount()).toBe(before)
  })

  it('rejects altered and expired proofs and malformed selections without creating receipts', async () => {
    const before = await receiptCount()
    const { manager, first } = data
    const { bulkPageToken } = await page(manager, { limit: '1' })
    const altered = `${bulkPageToken.startsWith('A') ? 'B' : 'A'}${bulkPageToken.slice(1)}`
    const expired = issueBulkPageProof(
      secret,
      manager,
      { limit: 1 },
      [first],
      new Date(Date.now() - 660_000),
    )
    for (const token of [altered, expired.bulkPageToken]) {
      await expectError(await preview(manager, token, [first]), 409, 'bulk_selection_changed')
    }
    for (const selection of [
      [],
      [first, first.toUpperCase()],
      ['no-valid-id'],
      Array.from({ length: 26 }, () => randomUUID()),
    ]) {
      await expectError(await preview(manager, bulkPageToken, selection), 400, 'invalid_request')
    }
    expect(await receiptCount()).toBe(before)
  })

  it('reports paid successors, imported chains and other preview skips in page order', async () => {
    const { owner, other } = data
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const actor = await session(owner, team.id)
    const departed = await createTestUser(db, 'Departed required host')
    const f = createFixtures(db)
    const started = await f.booking(team.id, [owner.id], '2020-01-01T09:00Z', '2020-01-01T09:30Z')
    const cancelled = await f.booking(
      team.id,
      [owner.id],
      '2099-01-01T09:00Z',
      '2099-01-01T09:30Z',
      { status: 'cancelled' },
    )
    const successor = await f.booking(team.id, [owner.id], '2099-01-01T10:00Z', '2099-01-01T10:30Z')
    const imported = await f.booking(
      team.id,
      [owner.id],
      '2099-01-01T11:00Z',
      '2099-01-01T11:30Z',
      { source: 'import' },
    )
    const unavailable = await f.booking(
      team.id,
      [owner.id],
      '2099-01-01T12:00Z',
      '2099-01-01T12:30Z',
    )
    const outsideTeam = await f.booking(
      team.id,
      [owner.id],
      '2099-01-01T14:00Z',
      '2099-01-01T14:30Z',
    )
    const native = await f.booking(team.id, [owner.id], '2099-01-01T15:00Z', '2099-01-01T15:30Z')
    const foreignImport = await f.booking(other.id, [], '2099-01-01T14:00Z', '2099-01-01T14:30Z', {
      source: 'import',
    })
    // A legacy link to another team's imported booking makes the local successor read-only.
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: foreignImport })
      .where('id', '=', native)
      .execute()
    const { id: hostDeparted } = await db
      .insertInto('bookings')
      .values({
        organization_id: team.id,
        start_at: '2099-01-01T13:00Z',
        end_at: '2099-01-01T13:30Z',
        required_host_user_ids: [departed.id],
        title: 'Original required host booking',
        source: 'api',
        manage_token_hash: randomBytes(32),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // A stored Checkout binding is enough even when the successor itself has no hold.
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: cancelled })
      .where('id', '=', successor)
      .execute()
    await db
      .insertInto('payment_checkout_attempts')
      .values({
        id: randomUUID(),
        booking_id: cancelled,
        current_booking_id: successor,
        account_id: 'acct_synthetic_preview',
        amount_minor: 1000,
        currency: 'usd',
        mode: 'test',
        idempotency_key: 'preview_paid_successor',
      })
      .execute()

    const proof = await page(actor)
    const ids = [
      started,
      cancelled,
      successor,
      imported,
      unavailable,
      hostDeparted,
      outsideTeam,
      native,
    ]
    expect(proof.data.map(({ id }) => id)).toEqual(ids)
    await db.deleteFrom('bookings').where('id', '=', unavailable).execute()
    await db
      .updateTable('bookings')
      .set({ organization_id: other.id })
      .where('id', '=', outsideTeam)
      .execute()
    const response = await preview(actor, proof.bulkPageToken, [...ids].reverse())
    expect(response.status).toBe(200)
    expect(((await response.json()) as { items: unknown }).items).toEqual([
      { bookingId: started, code: 'booking_started' },
      { bookingId: cancelled, code: 'already_cancelled' },
      { bookingId: successor, code: 'booking_not_supported' },
      { bookingId: imported, code: 'booking_not_supported' },
      { bookingId: unavailable, code: 'booking_unavailable' },
      { bookingId: hostDeparted, code: 'booking_host_departed' },
      { bookingId: outsideTeam, code: 'booking_unavailable' },
      { bookingId: native, code: 'booking_not_supported' },
    ])
  })

  it('authorizes the expected current team and requires a same-origin preview', async () => {
    const { manager, other, first } = data
    const { bulkPageToken } = await page(manager)
    const before = await receiptCount()
    for (const [expected, status, error] of [
      [other.id, 409, 'organization_context_changed'],
      [randomUUID(), 403, 'team_management_access_denied'],
      ['', 403, 'team_management_access_denied'],
    ] as const) {
      const headers = { [EXPECTED_ORGANIZATION_HEADER]: expected }
      await expectError(await list(manager, {}, headers), status, error)
      await expectError(await preview(manager, 'invalid-proof', [first], headers), status, error)
    }
    const missing = new Headers({
      cookie: manager.cookie,
      origin,
      'content-type': 'application/json',
    })
    await expectError(
      await enabled.request(`${listPath}?bulkSelection=true`, { headers: missing }),
      409,
      'organization_context_changed',
    )
    await expectError(
      await enabled.request(previewPath, {
        method: 'POST',
        headers: missing,
        body: JSON.stringify({ pageToken: bulkPageToken, bookingIds: [first] }),
      }),
      409,
      'organization_context_changed',
    )
    await expectError(
      await preview(manager, bulkPageToken, [first], { origin: 'https://other.example' }),
      403,
      'forbidden',
    )
    expect(await receiptCount()).toBe(before)
  })

  it('denies host-only, personal, removed, expired and unverified callers before preview', async () => {
    const before = await receiptCount()
    const { team, manager, first } = data
    const { bulkPageToken } = await page(manager)
    const removed = await createTestUser(db, 'Removed admin')
    const expired = await createTestUser(db, 'Expired admin')
    const unverified = await createTestUser(db, 'Unverified admin')
    for (const user of [removed, expired, unverified]) {
      await createFixtures(db).member(user.id, team.id, 'admin')
    }
    const removedSession = await session(removed, team.id)
    const expiredSession = await session(expired, team.id)
    const unverifiedSession = await session(unverified, team.id)
    await db
      .deleteFrom('auth.member')
      .where('userId', '=', removed.id)
      .where('organizationId', '=', team.id)
      .execute()
    await db
      .updateTable('auth.session')
      .set({ expiresAt: sql`clock_timestamp() - interval '1 minute'` })
      .where('id', '=', expiredSession.sessionId)
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', unverified.id)
      .execute()
    for (const actor of [
      undefined,
      data.host,
      data.personal,
      removedSession,
      expiredSession,
      unverifiedSession,
    ]) {
      await expectError(await list(actor), 403, 'team_management_access_denied')
      await expectError(
        await preview(actor, bulkPageToken, [first]),
        403,
        'team_management_access_denied',
      )
    }
    expect(await receiptCount()).toBe(before)
  })

  it('denies real API keys and MCP OAuth even when sent with a valid browser cookie', async () => {
    const { owner, team, manager, first } = data
    const before = await receiptCount()
    const { bulkPageToken } = await page(manager)
    const key = await auth.api.createApiKey({
      body: { userId: owner.id, metadata: { organizationId: team.id } },
    })
    const keyHeaders = { authorization: `Bearer ${key.key}` }
    expect((await resolveCaller(new Headers(keyHeaders))).ok).toBe(true)
    const clientId = 'https://bulk-selection.example/client.json'
    await db
      .insertInto('auth.oauthClient')
      .values({
        clientId,
        redirectUris: JSON.stringify(['https://bulk-selection.example/callback']),
      })
      .execute()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: owner.id, organization_id: team.id, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId: owner.id,
        referenceId: grant.id,
        scopes: JSON.stringify(['mcp:tools']),
        resources: JSON.stringify([`${origin}/mcp`]),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const iat = Math.floor(Date.now() / 1000)
    const mcp = await signJWT(
      { context: await auth.$context },
      {
        header: { typ: 'at+jwt' },
        payload: {
          sub: owner.id,
          client_id: clientId,
          scope: 'mcp:tools',
          iat,
          exp: iat + 300,
          iss: `${origin}/api/auth`,
          aud: `${origin}/mcp`,
          'https://hourmere.com/organization': team.id,
          'https://hourmere.com/grant': grant.id,
        },
      },
    )
    const mcpHeaders = { authorization: `Bearer ${mcp}` }
    expect(
      (
        await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
          new Request(`${origin}/mcp`, { headers: mcpHeaders }),
        )
      ).ok,
    ).toBe(true)
    for (const headers of [keyHeaders, mcpHeaders]) {
      for (const actor of [undefined, manager]) {
        await expectError(await list(actor, {}, headers), 403, 'team_management_access_denied')
        await expectError(
          await preview(actor, bulkPageToken, [first], headers),
          403,
          'team_management_access_denied',
        )
        await expectError(
          await confirmation(actor, randomUUID(), { overrides: headers }),
          403,
          'team_management_access_denied',
        )
        await expectError(
          await enabled.request(`${bulkPath}/${randomUUID()}`, {
            headers: headersFor(actor, headers),
          }),
          403,
          'team_management_access_denied',
        )
      }
    }
    expect(await receiptCount()).toBe(before)
  })

  it('keeps production routes and recovery off by default', async () => {
    await withRunningServer(undefined, async (request) => {
      const { manager, first } = data
      const headers = headersFor(manager)
      const response = await request(`${listPath}?bulkSelection=true`, { headers })
      expect(response.status).toBe(200)
      const listBody = (await response.json()) as object
      expect(Object.keys(listBody).sort()).toEqual(['data', 'nextCursor'])
      const { bulkPageToken } = await page(manager)
      const before = await receiptCount()
      await expectError(
        await request(previewPath, {
          method: 'POST',
          headers: headersFor(manager, { 'content-type': 'application/json' }),
          body: JSON.stringify({ pageToken: bulkPageToken, bookingIds: [first] }),
        }),
        404,
        'not_found',
      )
      const path = `${bulkPath}/${randomUUID()}`
      await expectError(
        await request(`${path}/confirm`, { method: 'POST', headers }),
        404,
        'not_found',
      )
      await expectError(await request(path, { headers }), 404, 'not_found')
      expect(await receiptCount()).toBe(before)
      expect(await recoveryCrons()).toEqual([])
    })
  })

  it('serializes parallel confirmation across web apps and replays the same batch after sign-in', async () => {
    const { manager, owner, team, first } = data
    const skipped = await createFixtures(db).booking(
      team.id,
      [owner.id],
      '2099-01-02T09:05Z',
      '2099-01-02T09:10Z',
      { status: 'cancelled' },
    )
    const { confirmationId: id, expiresAt } = await previewReceipt(manager, [skipped, first])
    const waiting = await status(manager, id)
    expect(waiting.status).toBe(200)
    expect(await waiting.json()).toEqual({ id, state: 'awaiting_confirmation', expiresAt })
    const actor = await session(owner, team.id)
    await expectError(await confirmation(actor, id), 404, 'bulk_cancellation_not_found')

    // A preview skip is frozen even if a later booking read would find it eligible.
    await db
      .updateTable('bookings')
      .set({ status: 'confirmed', cancelled_at: null })
      .where('id', '=', skipped)
      .execute()
    const replica = bulkApp()
    const answers = await Promise.all([
      confirmation(manager, id),
      confirmation(manager, id, { app: replica }),
    ])
    for (const answer of answers) {
      expect(answer.status).toBe(202)
      expect(await answer.json()).toEqual({ id, state: 'queued' })
    }
    const admitted = await status(actor, id)
    expect(admitted.status).toBe(200)
    expect(admitted.headers.get('cache-control')).toContain('no-store')
    expect(await admitted.json()).toEqual({
      id,
      state: 'queued',
      counts: {
        pending: 1,
        cancelled: 0,
        already_cancelled: 1,
        booking_started: 0,
        booking_not_supported: 0,
        booking_unavailable: 0,
        booking_host_departed: 0,
        authorization_lost: 0,
        processing_failed: 0,
      },
      items: [
        { bookingId: first, code: 'pending' },
        { bookingId: skipped, code: 'already_cancelled' },
      ],
    })
    await completeTestBatch(id)
    const replay = await confirmation(actor, id)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ id, state: 'completed' })
    expect(await admissionEffects(id)).toEqual({
      events: [
        {
          request_id: id,
          actor_id: manager.userId,
          credential_id: manager.sessionId,
          action: 'booking.bulk_cancellation_admitted',
          details: { selectedCount: 2 },
        },
      ],
      queued: [{ data: { batchId: id } }],
    })
    expect(notify).not.toHaveBeenCalled()
    await db
      .updateTable('team_booking_bulk_cancellations')
      .set({
        created_at: sql`clock_timestamp() - interval '8 days 2 minutes'`,
        admitted_at: sql`clock_timestamp() - interval '8 days 1 minute'`,
        expires_at: sql`clock_timestamp() - interval '8 days'`,
        completed_at: sql`clock_timestamp() - interval '8 days'`,
      })
      .where('id', '=', id)
      .execute()
    await expectError(await status(actor, id), 404, 'bulk_cancellation_not_found')
    await expectError(await confirmation(actor, id), 404, 'bulk_cancellation_not_found')
  })

  it('keeps confirmation receipt scope private and refuses mutable, expired and empty admissions', async () => {
    const { manager, first, owner, team, admin, host, otherManager, other } = data
    const { confirmationId: id } = await previewReceipt(manager, [first])
    const missing = randomUUID()
    for (const actor of [admin, otherManager]) {
      for (const candidate of [id, missing]) {
        await expectError(await status(actor, candidate), 404, 'bulk_cancellation_not_found')
        await expectError(await confirmation(actor, candidate), 404, 'bulk_cancellation_not_found')
      }
    }
    for (const actor of [undefined, host, data.personal]) {
      for (const candidate of [id, missing]) {
        await expectError(await status(actor, candidate), 403, 'team_management_access_denied')
        await expectError(
          await confirmation(actor, candidate),
          403,
          'team_management_access_denied',
        )
      }
    }
    await expectError(await confirmation(manager, id, { body: '{}' }), 400, 'invalid_request')
    await expectError(
      await confirmation(manager, id, { body: JSON.stringify({ bookingIds: [first] }) }),
      400,
      'invalid_request',
    )
    await expectError(
      await enabled.request(`${bulkPath}/${id}/confirm?bookingIds=${first}`, {
        method: 'POST',
        headers: headersFor(manager),
      }),
      400,
      'invalid_request',
    )
    await expectError(
      await confirmation(manager, id, { overrides: { origin: 'https://other.example' } }),
      403,
      'forbidden',
    )
    await expectError(
      await confirmation(manager, id, { overrides: { [EXPECTED_ORGANIZATION_HEADER]: other.id } }),
      409,
      'organization_context_changed',
    )
    await db
      .updateTable('team_booking_bulk_cancellations')
      .set({
        created_at: sql`clock_timestamp() - interval '2 minutes'`,
        expires_at: sql`clock_timestamp() - interval '1 minute'`,
      })
      .where('id', '=', id)
      .execute()
    await expectError(await status(manager, id), 409, 'bulk_confirmation_expired')
    await expectError(await confirmation(manager, id), 409, 'bulk_confirmation_expired')
    expect(await admissionEffects(id)).toEqual({ events: [], queued: [] })

    const cancelled = await createFixtures(db).booking(
      team.id,
      [owner.id],
      '2099-01-01T07:00Z',
      '2099-01-01T07:30Z',
      { status: 'cancelled' },
    )
    const { confirmationId } = await previewReceipt(manager, [cancelled])
    await expectError(await confirmation(manager, confirmationId), 409, 'bulk_no_eligible_bookings')
    expect(await admissionEffects(confirmationId)).toEqual({ events: [], queued: [] })
  })

  it('rolls back admission, its audit, its pending items and the durable wake together', async () => {
    const { manager, first } = data
    const { confirmationId: id } = await previewReceipt(manager, [first])
    const failing = bulkApp(async (trx, batchId) => {
      const jobId = await enqueue(trx, batchId)
      expect(jobId).toEqual(expect.any(String))
      throw new Error('Synthetic failure after inserting the wake')
    })
    await expectError(await confirmation(manager, id, { app: failing }), 500, 'internal_error')
    expect(await admissionEffects(id)).toEqual({ events: [], queued: [] })
    expect(await (await status(manager, id)).json()).toMatchObject({
      state: 'awaiting_confirmation',
    })
    const item = await db
      .selectFrom('team_booking_bulk_cancellation_items')
      .select(['outcome', 'next_attempt_at'])
      .where('batch_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(item).toEqual({ outcome: null, next_attempt_at: null })
    expect((await confirmation(manager, id)).status).toBe(202)
    await completeTestBatch(id)
  })

  it('refuses admission when the issuing session expires during a capacity lock wait', async () => {
    const { owner, team, first } = data
    const actor = await session(owner, team.id)
    const { confirmationId: id } = await previewReceipt(actor, [first])
    const resolved = await resolveCaller(headersFor(actor))
    expect(resolved.ok).toBe(true)
    // Capture the request's resolved identity before setting a short lifetime. A real
    // Better Auth read at that lifetime can renew the session before the capacity wait.
    const app = application(
      [
        teamBookingBulkPreviewRoutes({
          db,
          bulkSelectionSecret: secret,
          enqueueBulkCancellation: enqueue,
        }),
      ],
      async () => resolved,
    )
    let pending: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ pid: number }>`
          SELECT pg_backend_pid() AS pid,
            pg_advisory_xact_lock(hashtextextended('hourmere.team-booking-bulk-admission', 0))
        `.execute(trx)
        const { expiresAt } = await db
          .updateTable('auth.session')
          .set({ expiresAt: sql`clock_timestamp() + interval '2 seconds'` })
          .where('id', '=', actor.sessionId)
          .returning('expiresAt')
          .executeTakeFirstOrThrow()
        pending = Promise.resolve(confirmation(actor, id, { app }))
        await vi.waitFor(async () => {
          const blocked = await owned.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [rows[0]?.pid],
          )
          expect(blocked.rowCount).toBe(1)
        })
        await sql`
          SELECT pg_sleep(greatest(0, extract(epoch FROM (${expiresAt}::timestamptz - clock_timestamp()))) + 0.01)
        `.execute(trx)
      })
      if (!pending) throw new Error('Expected a waiting confirmation')
      await expectError(await pending, 403, 'team_management_access_denied')
    } finally {
      await pending
    }
    expect(await admissionEffects(id)).toEqual({ events: [], queued: [] })
    expect(await (await status(data.manager, id)).json()).toMatchObject({
      state: 'awaiting_confirmation',
    })
  })

  it('shares rolling admission and read budgets and the active team capacity', async () => {
    const { owner, first } = data
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const actor = await session(owner, team.id)
    const bookingId = await createFixtures(db).booking(
      team.id,
      [owner.id],
      '2099-01-03T09:00Z',
      '2099-01-03T09:30Z',
    )
    const ids = await Promise.all(
      [1, 2, 3].map(async () => (await previewReceipt(actor, [bookingId])).confirmationId),
    )
    const [firstId, secondId, thirdId] = ids as [string, string, string]
    const replica = bulkApp()
    expect((await confirmation(actor, firstId)).status).toBe(202)
    const full = await confirmation(actor, secondId, { app: replica })
    expect(Number(full.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expectError(full, 429, 'bulk_queue_full')
    expect((await confirmation(actor, firstId, { app: replica })).status).toBe(202)
    await completeTestBatch(firstId)
    expect((await confirmation(actor, secondId, { app: replica })).status).toBe(202)
    await completeTestBatch(secondId)
    const limited = await confirmation(actor, thirdId)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expectError(limited, 429, 'rate_limited')
    expect(await admissionEffects(thirdId)).toEqual({ events: [], queued: [] })
    expect(await (await status(actor, thirdId)).json()).toMatchObject({
      state: 'awaiting_confirmation',
    })

    // Existing replay and status calls share the actor's one read budget.
    await db
      .insertInto('team_booking_bulk_request_limits')
      .values(
        Array.from({ length: 27 }, () => ({
          organization_id: team.id,
          actor_user_id: actor.userId,
          kind: 'status',
        })),
      )
      .execute()
    expect((await confirmation(actor, firstId)).status).toBe(200)
    const staleAt = new Date('2020-01-01T00:00:00Z')
    await db
      .insertInto('team_booking_bulk_request_limits')
      .values(
        Array.from({ length: 41 }, (_, index) => ({
          organization_id: team.id,
          actor_user_id: index === 40 ? data.admin.userId : actor.userId,
          kind: 'status',
          created_at: staleAt,
        })),
      )
      .execute()
    const readLimited = await status(actor, secondId, replica)
    expect(Number(readLimited.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expectError(readLimited, 429, 'rate_limited')
    const stale = await db
      .selectFrom('team_booking_bulk_request_limits')
      .select('actor_user_id')
      .where('organization_id', '=', team.id)
      .where('created_at', '=', staleAt)
      .execute()
    expect(stale.filter((row) => row.actor_user_id === actor.userId)).toHaveLength(10)
    expect(stale.filter((row) => row.actor_user_id === data.admin.userId)).toHaveLength(1)

    // Three successful previews and three invalid proofs fill this team's actor budget.
    for (const app of [enabled, replica, enabled]) {
      await expectError(
        await app.request(previewPath, {
          method: 'POST',
          headers: headersFor(actor, { 'content-type': 'application/json' }),
          body: JSON.stringify({ pageToken: 'invalid-proof', bookingIds: [first] }),
        }),
        409,
        'bulk_selection_changed',
      )
    }
    const previewLimited = await preview(actor, 'invalid-proof', [first])
    expect(Number(previewLimited.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expectError(previewLimited, 429, 'rate_limited')
  })

  it('refuses new admission at instance capacity without consuming the receipt', async () => {
    const { owner } = data
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const actor = await session(owner, team.id)
    const bookingId = await createFixtures(db).booking(
      team.id,
      [owner.id],
      '2099-01-04T09:00Z',
      '2099-01-04T09:30Z',
    )
    const { confirmationId: id } = await previewReceipt(actor, [bookingId])
    const capacity = await sql<{ organization_id: string }>`
      WITH teams AS (
        INSERT INTO auth.organization (name, slug, "createdAt")
        SELECT 'Capacity fixture', gen_random_uuid()::text, statement_timestamp()
        FROM generate_series(1, 100)
        RETURNING id
      )
      INSERT INTO team_booking_bulk_cancellations
        (organization_id, actor_user_id, session_id, created_at, expires_at, state, admitted_at)
      SELECT id, ${actor.userId}, ${actor.sessionId},
        statement_timestamp() - interval '1 second',
        statement_timestamp() + interval '1 minute', 'queued', statement_timestamp()
      FROM teams
      RETURNING organization_id
    `.execute(db)
    expect(capacity.rows).toHaveLength(100)
    const full = await confirmation(actor, id)
    expect(Number(full.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expectError(full, 429, 'bulk_queue_full')
    expect(await admissionEffects(id)).toEqual({ events: [], queued: [] })
    expect(await (await status(actor, id)).json()).toMatchObject({ state: 'awaiting_confirmation' })
    const removed = capacity.rows[0]?.organization_id
    if (!removed) throw new Error('Expected a capacity fixture')
    await db.deleteFrom('auth.organization').where('id', '=', removed).execute()
    expect((await confirmation(actor, id)).status).toBe(202)
    await completeTestBatch(id)
  })

  it('wires production page proof, admission, status and recovery when explicitly enabled', async () => {
    await withRunningServer('true', async (request) => {
      const { otherManager, foreign } = data
      const headers = headersFor(otherManager)
      const ordinary = await request(listPath, { headers })
      expect(ordinary.status).toBe(200)
      expect(await ordinary.json()).not.toHaveProperty('bulkPageToken')
      const proof = await request(`${listPath}?bulkSelection=true`, { headers })
      expect(proof.status).toBe(200)
      const { bulkPageToken } = (await proof.json()) as BulkPage
      expect(bulkPageToken).toEqual(expect.any(String))

      const preview = await request(previewPath, {
        method: 'POST',
        headers: headersFor(otherManager, { 'content-type': 'application/json' }),
        body: JSON.stringify({ pageToken: bulkPageToken, bookingIds: [foreign] }),
      })
      expect(preview.status).toBe(200)
      const { confirmationId } = (await preview.json()) as { confirmationId: string }
      const path = `${bulkPath}/${confirmationId}`
      const confirmed = await request(`${path}/confirm`, { method: 'POST', headers })
      expect(confirmed.status).toBe(202)
      expect(await confirmed.json()).toEqual({ id: confirmationId, state: 'queued' })

      const status = await request(path, { headers })
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        id: confirmationId,
        items: [{ bookingId: foreign }],
      })
      const { rows } = await owned.pool.query<{ data: unknown }>(
        'SELECT data FROM pgboss.job WHERE name=$1 AND singleton_key=$2',
        [TEAM_BOOKING_BULK_JOB, confirmationId],
      )
      expect(rows).toEqual([{ data: { batchId: confirmationId } }])
      expect(await recoveryCrons()).toEqual(['* * * * *'])
    })
  })
})
