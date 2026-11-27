import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { productRoutes } from '../server.ts'
import { issueBulkPageProof } from '../team-booking-bulk-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'
import { teamBookingBulkPreviewRoutes } from './team-booking-bulk-preview.ts'
import { teamBookingRoutes } from './team-bookings.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = 'synthetic-bulk-booking-selection-test-secret'
const listPath = '/api/v1/team/bookings'
const previewPath = `${listPath}/bulk-cancellations/preview`
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

describe.skipIf(!serverUrl)('team booking bulk selection and preview', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let resolveCaller: ReturnType<typeof createCallerResolver>
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
    enabled = application([
      teamBookingRoutes({ db, notify, bulkSelectionSecret: secret }),
      teamBookingBulkPreviewRoutes({ db, bulkSelectionSecret: secret }),
    ])
    data = await seed()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function application(routes: Parameters<typeof createApp>[0]['routes']) {
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller,
      routes,
    })
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
        .selectAll()
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
    const descending = await page(manager, { order: 'desc', limit: '1' })
    expect(descending.data.map(({ id }) => id)).toEqual([third])
    expect((await page(otherManager)).data.map(({ id }) => id)).toEqual([foreign])
    const newSession = await session(owner, team.id)
    for (const [actor, token, ids] of [
      [manager, firstPage.bulkPageToken, [first, second]],
      [manager, firstPage.bulkPageToken, [first, foreign]],
      [manager, firstPage.bulkPageToken, [first, randomUUID()]],
      [manager, secondPage.bulkPageToken, [first]],
      [manager, searched.bulkPageToken, [second]],
      [manager, descending.bulkPageToken, [first]],
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

  it('reports a paid successor, a departed required host and other preview skips in page order', async () => {
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
    // A legacy cross-team link must not influence the local booking's preview.
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
      { bookingId: native, code: 'eligible' },
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
      }
    }
    expect(await receiptCount()).toBe(before)
  })

  it('keeps proof and preview inaccessible in the production route composition', async () => {
    const product = application(
      productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
    )
    const { manager, first } = data
    const headers = headersFor(manager)
    const ordinary = await enabled.request(listPath, { headers })
    expect(ordinary.status).toBe(200)
    expect(await ordinary.json()).not.toHaveProperty('bulkPageToken')
    const listResponse = await product.request(`${listPath}?bulkSelection=true`, { headers })
    expect(listResponse.status).toBe(200)
    const listBody = (await listResponse.json()) as object
    expect(Object.keys(listBody).sort()).toEqual(['data', 'nextCursor'])
    const { bulkPageToken } = await page(manager)
    const before = await receiptCount()
    headers.set('content-type', 'application/json')
    const previewResponse = await product.request(previewPath, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pageToken: bulkPageToken, bookingIds: [first] }),
    })
    expect(previewResponse.status).toBe(404)
    expect(await receiptCount()).toBe(before)
  })
})
