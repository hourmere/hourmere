import '@hono/zod-openapi'
import { createHmac, randomBytes } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { TeamAdminBookingListItemSchema } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { publicRoutes } from './routes/public.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { productTools } from './server.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4397'
const secret = randomBytes(32).toString('base64')
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')

type Settings = { name: string; slug: string }
const forbiddenChanges = { name: 'Must not save', slug: 'forbidden-team-address' }

describe.skipIf(!serverUrl)('team settings through HTTP and PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_settings' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
      routes: [
        publicRoutes({ db, now }),
        bookingRoutes({ db, now }),
        teamBookingRoutes({ db, now }),
      ],
      mcp: mcpEndpoint({ tools: productTools({ db }) }),
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function sessionFor(userId: string, activeOrganizationId: string) {
    const token = randomBytes(24).toString('base64url')
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        activeOrganizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture() {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(
      db,
      [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: member, role: 'member' },
      ],
      '原来的团队 100% / München',
    )
    const adminSession = await sessionFor(admin.id, team.id)
    return {
      team: team.as(owner).organization,
      ownerId: owner.id,
      adminId: admin.id,
      ownerCookie: (await sessionFor(owner.id, team.id)).cookie,
      adminCookie: adminSession.cookie,
      adminSessionId: adminSession.id,
      memberCookie: (await sessionFor(member.id, team.id)).cookie,
    }
  }

  function update(
    teamId: string,
    cookie: string,
    data: Partial<Settings>,
    expected: Partial<Settings>,
    headers: Record<string, string> = {},
  ) {
    return app.request('/api/auth/organization/update', {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        [EXPECTED_ORGANIZATION_HEADER]: teamId,
        ...(expected.name !== undefined && {
          'x-expected-team-name': encodeURIComponent(expected.name),
        }),
        ...(expected.slug !== undefined && {
          'x-expected-team-slug': encodeURIComponent(expected.slug),
        }),
        ...headers,
      },
      body: JSON.stringify({ organizationId: teamId, data }),
    })
  }

  function settings(teamId: string) {
    return db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
  }

  function slugRequest(path: 'create' | 'check-slug', cookie: string, slug: string) {
    return app.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(
        path === 'create'
          ? { name: 'New team', slug, keepCurrentActiveOrganization: true }
          : { slug },
      ),
    })
  }

  function updates(teamId: string) {
    return db
      .selectFrom('audit_events')
      .select(['actor_id', 'details'])
      .where('organization_id', '=', teamId)
      .where('action', '=', 'organization.updated')
      .orderBy('id')
      .execute()
  }

  async function expectUnchanged(team: Settings & { id: string }) {
    expect(await settings(team.id)).toEqual({ name: team.name, slug: team.slug })
    expect(await updates(team.id)).toEqual([])
    expect(
      await db
        .selectFrom('team_slug_reservations')
        .select('slug')
        .where('organization_id', '=', team.id)
        .execute(),
    ).toEqual([])
  }

  async function waitForBlockedBy(blocker: number | undefined) {
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
          ) AS blocked`,
          [blocker],
        )
        expect(result.rows[0]?.blocked).toBe(true)
      },
      { timeout: 3000, interval: 10 },
    )
  }

  async function expectSlugError(response: Response, code: string) {
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code })
  }

  it('changes public links only for address edits and preserves existing bookings and history', async () => {
    const f = await fixture()
    const events = createFixtures(db)
    await events.schedule(f.ownerId, { timeZone: 'UTC' })
    const eventTypeId = await events.eventType(f.team.id, null, {
      slug: 'intro',
      title: 'Team introduction',
      location: { kind: 'phone', number: '+14155550123' },
      hosts: [{ userId: f.ownerId }],
    })
    const historical = await events.booking(
      f.team.id,
      [f.ownerId],
      '2026-10-26T09:00:00Z',
      '2026-10-26T09:30:00Z',
      { eventTypeId, status: 'cancelled' },
    )
    const publicPath = (address: string) => `/api/v1/public/teams/${address}/intro`
    async function expectPublic(team: Settings) {
      const response = await app.request(publicPath(team.slug))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ title: 'Team introduction', team })
    }
    const book = (address: string, start: string) =>
      app.request(`${publicPath(address)}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start,
          invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
        }),
      })
    const history = async (id: string) => {
      const response = await app.request(`/api/v1/team/bookings/${id}`, {
        headers: { cookie: f.adminCookie, [EXPECTED_ORGANIZATION_HEADER]: f.team.id },
      })
      expect(response.status).toBe(200)
      return TeamAdminBookingListItemSchema.parse(await response.json())
    }

    await expectPublic({ name: f.team.name, slug: f.team.slug })
    const created = await book(f.team.slug, '2026-11-02T09:00:00Z')
    expect(created.status).toBe(201)
    const { booking, manageToken } = (await created.json()) as {
      booking: { id: string; eventTypeId: string }
      manageToken: string
    }
    expect(booking.eventTypeId).toBe(eventTypeId)
    expect(manageToken).toBeTypeOf('string')
    const manage = async () => {
      const response = await app.request('/api/v1/bookings/manage', {
        headers: { 'x-manage-token': manageToken },
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const manageBefore = await manage()
    expect(manageBefore).toMatchObject({ id: booking.id, status: 'confirmed' })
    const activeBefore = await history(booking.id)
    const historyBefore = await history(historical)
    const originalEvent = { id: eventTypeId, publicBookingPath: `/team/${f.team.slug}/intro` }
    expect(activeBefore).toMatchObject({
      id: booking.id,
      status: 'confirmed',
      eventType: originalEvent,
    })
    expect(historyBefore).toMatchObject({
      id: historical,
      status: 'cancelled',
      eventType: originalEvent,
    })

    const renamed = { name: '新团队', slug: f.team.slug }
    const savedName = await update(f.team.id, f.adminCookie, { name: renamed.name }, f.team)
    expect(savedName.status).toBe(200)
    await expectPublic(renamed)
    expect(await manage()).toEqual(manageBefore)
    expect(await history(booking.id)).toEqual(activeBefore)
    expect(await history(historical)).toEqual(historyBefore)

    const edited = { name: '新团队名称', slug: 'new-public-address' }
    const saved = await update(f.team.id, f.adminCookie, edited, renamed)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ id: f.team.id, ...edited })
    expect(await settings(f.team.id)).toEqual(edited)
    expect(await updates(f.team.id)).toEqual([
      { actor_id: f.adminId, details: { nameChanged: true } },
      {
        actor_id: f.adminId,
        details: { oldSlug: f.team.slug, newSlug: edited.slug, nameChanged: true },
      },
    ])

    await expectPublic(edited)
    const old = await app.request(publicPath(f.team.slug))
    expect(old.status).toBe(404)
    expect(old.headers.get('location')).toBeNull()
    expect(await old.json()).toMatchObject({ error: 'event_type_not_found' })
    expect((await book(f.team.slug, '2026-11-02T11:00:00Z')).status).toBe(404)
    expect(await manage()).toEqual(manageBefore)
    for (const [id, before] of [
      [booking.id, activeBefore],
      [historical, historyBefore],
    ] as const) {
      expect(await history(id)).toEqual({
        ...before,
        eventType: { ...before.eventType, publicBookingPath: `/team/${edited.slug}/intro` },
      })
    }
    const replacement = await book(edited.slug, '2026-11-02T11:00:00Z')
    expect(replacement.status).toBe(201)
    expect(await replacement.json()).toMatchObject({ booking: { eventTypeId } })
  })

  it('rejects a stale form after a concurrent edit and accepts its freshly loaded values', async () => {
    const f = await fixture()
    const changes = await Promise.all([
      update(f.team.id, f.ownerCookie, { name: 'Owner edit', slug: 'owner-address' }, f.team),
      update(f.team.id, f.adminCookie, { name: 'Admin edit', slug: 'admin-address' }, f.team),
    ])
    expect(changes.map((response) => response.status).sort()).toEqual([200, 409])
    const conflict = changes.find((response) => response.status === 409)
    expect(await conflict?.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
    const saved = changes.find((response) => response.status === 200)
    const current = await settings(f.team.id)
    expect(await saved?.json()).toMatchObject(current)

    const retry = await update(f.team.id, f.adminCookie, { name: 'Reloaded edit' }, current)
    expect(retry.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ ...current, name: 'Reloaded edit' })
  })

  it.each([{ name: 'Changed name' }, { slug: 'changed-address' }])(
    'detects stale settings when only one value changed (%o)',
    async (change: Partial<Settings>) => {
      const f = await fixture()
      const current = { name: f.team.name, slug: f.team.slug, ...change }
      const saved = await update(f.team.id, f.ownerCookie, change, f.team)
      expect(saved.status).toBe(200)

      const refused = await update(f.team.id, f.adminCookie, { name: 'Stale edit' }, f.team)
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
      expect(await settings(f.team.id)).toEqual(current)
    },
  )

  it('requires a valid, complete baseline when one is supplied and preserves existing callers', async () => {
    const f = await fixture()
    const partial = await update(
      f.team.id,
      f.ownerCookie,
      { name: 'Partial' },
      { slug: f.team.slug },
    )
    expect(partial.status).toBe(409)
    expect(await partial.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })

    const invalid = await update(
      f.team.id,
      f.ownerCookie,
      { name: 'Invalid baseline' },
      { name: '\0', slug: f.team.slug },
    )
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toMatchObject({ code: 'TEAM_SETTINGS_CHANGED' })
    expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })

    const native = await update(f.team.id, f.ownerCookie, { name: 'Native update' }, {})
    expect(native.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ name: 'Native update', slug: f.team.slug })
  })

  it('refuses a plain member before revealing whether team details changed', async () => {
    const f = await fixture()
    const stale = { ...f.team, name: 'Older team name' }
    for (const expected of [f.team, stale, {}]) {
      const denied = await update(f.team.id, f.memberCookie, forbiddenChanges, expected)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    }
    await expectUnchanged(f.team)
  })

  it('does not let managers edit another team with either expected team ID', async () => {
    const target = await fixture()
    const other = await fixture()
    const denied = await update(target.team.id, other.adminCookie, forbiddenChanges, target.team)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })

    const conflict = await update(target.team.id, other.adminCookie, forbiddenChanges, other.team, {
      [EXPECTED_ORGANIZATION_HEADER]: other.team.id,
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'ORGANIZATION_CONTEXT_CHANGED' })
    await expectUnchanged(target.team)
    await expectUnchanged(other.team)
  })

  it.each(['revoked', 'expired'] as const)('refuses a %s session at entry', async (state) => {
    const f = await fixture()
    if (state === 'revoked') {
      const signOut = await app.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie: f.adminCookie, origin, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(signOut.status).toBe(200)
    } else {
      await db
        .updateTable('auth.session')
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where('id', '=', f.adminSessionId)
        .execute()
    }
    const denied = await update(f.team.id, f.adminCookie, forbiddenChanges, f.team)
    expect(denied.status).toBe(401)
    await expectUnchanged(f.team)
  })

  it.each(['demoted', 'removed', 'revoked', 'expired'] as const)(
    'refuses an admin whose authority is %s while the update waits for the team lock',
    async (state) => {
      const f = await fixture()
      const attempted = { ...forbiddenChanges, slug: `${forbiddenChanges.slug}-${state}` }
      const holder = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [f.team.id])
        const result = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        pending = Promise.resolve(update(f.team.id, f.adminCookie, attempted, f.team))
        // The update reaches the persistence boundary with a valid admin session. Commit the
        // authority change before releasing that boundary, so the write must recheck it.
        await waitForBlockedBy(result.rows[0]?.pid)
        if (state === 'demoted') {
          await holder.query(
            `UPDATE auth.member SET role = 'member' WHERE "organizationId" = $1 AND "userId" = $2`,
            [f.team.id, f.adminId],
          )
        } else if (state === 'removed') {
          await holder.query(
            'DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = $2',
            [f.team.id, f.adminId],
          )
        } else if (state === 'revoked') {
          await holder.query('DELETE FROM auth.session WHERE id = $1', [f.adminSessionId])
        } else {
          await holder.query(
            `UPDATE auth.session SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = $1`,
            [f.adminSessionId],
          )
        }
        await holder.query('COMMIT')

        const denied = await pending
        expect(denied.status).toBe(403)
        expect(await denied.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
        await expectUnchanged(f.team)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.allSettled(pending ? [pending] : [])
      }
    },
  )

  it('rejects an owner API key at the team details endpoint even with an owner session cookie', async () => {
    const f = await fixture()
    const { key } = await auth.api.createApiKey({
      body: { userId: f.ownerId, metadata: { organizationId: f.team.id, scope: 'full' } },
    })
    const headers = { authorization: `Bearer ${key}` }
    const identity = await app.request('/api/v1/me', { headers })
    expect(identity.status).toBe(200)
    expect(await identity.json()).toMatchObject({
      organization: { id: f.team.id },
      principal: { kind: 'api_key', apiKeyScope: 'full' },
    })
    for (const cookie of [f.ownerCookie, '']) {
      const denied = await update(f.team.id, cookie, forbiddenChanges, f.team, headers)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ code: 'SESSION_REQUIRED' })
    }
    await expectUnchanged(f.team)
  })

  it('offers no team details mutation through MCP or CLI, even to an owner API key', async () => {
    const f = await fixture()
    const { key } = await auth.api.createApiKey({
      body: { userId: f.ownerId, metadata: { organizationId: f.team.id, scope: 'full' } },
    })
    async function rpc(method: string, params: Record<string, unknown> = {}) {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data ? data.slice(6) : text)
    }
    const discovery = await rpc('tools/list')
    expect(discovery.result.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'whoami' })]),
    )
    expect(discovery.result.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'update_team_details' })]),
    )
    const refusal = await rpc('tools/call', {
      name: 'update_team_details',
      arguments: { organizationId: f.team.id, ...forbiddenChanges },
    })
    expect(refusal).toMatchObject({ error: { code: -32602 } })

    let requests = 0
    let stderr = ''
    const code = await runCli({
      argv: ['team', 'settings', '--input', '-'],
      env: { HOURMERE_URL: origin, HOURMERE_API_KEY: key },
      stdin: (async function* () {
        yield JSON.stringify({ organizationId: f.team.id, ...forbiddenChanges })
      })(),
      stdout: vi.fn(),
      stderr: (text) => {
        stderr += text
      },
      fetch: async (input, init) => {
        requests += 1
        return app.request(input, init)
      },
    })
    expect(code).toBe(1)
    expect(JSON.parse(stderr)).toEqual({ error: 'invalid_command' })
    expect(requests).toBe(0)
    await expectUnchanged(f.team)
  })

  it('refuses a reserved slug without changing the team name', async () => {
    const f = await fixture()
    const denied = await update(
      f.team.id,
      f.adminCookie,
      { ...forbiddenChanges, slug: 'API' },
      f.team,
    )
    await expectSlugError(denied, 'ORGANIZATION_SLUG_RESERVED')
    await expectUnchanged(f.team)
  })

  it('lets an owner edit the name of a team with a legacy reserved address', async () => {
    const f = await fixture()
    const legacy = { name: f.team.name, slug: 'privacy' }
    await db.updateTable('auth.organization').set(legacy).where('id', '=', f.team.id).execute()

    const response = await update(f.team.id, f.ownerCookie, { name: 'Renamed legacy team' }, legacy)
    expect(response.status).toBe(200)
    expect(await settings(f.team.id)).toEqual({ name: 'Renamed legacy team', slug: legacy.slug })
    expect(await updates(f.team.id)).toEqual([
      { actor_id: f.ownerId, details: { nameChanged: true } },
    ])
  })

  it.each(['two words', 'nested/team', 'acme%20', 'tеam', 'a'.repeat(65), 'team\0space'])(
    'validates slug format on both native writes (%j)',
    async (slug) => {
      const f = await fixture()
      const refused = await update(
        f.team.id,
        f.ownerCookie,
        { name: 'Must not save', slug },
        f.team,
      )
      await expectSlugError(refused, 'ORGANIZATION_SLUG_INVALID')
      await expectSlugError(
        await slugRequest('create', f.ownerCookie, slug),
        'ORGANIZATION_SLUG_INVALID',
      )
      expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })
      expect(await updates(f.team.id)).toEqual([])
      await expect(
        db.selectFrom('auth.organization').select('id').where('name', '=', 'New team').execute(),
      ).resolves.toEqual([])
    },
  )

  it('normalizes valid mixed-case slugs on creation and update', async () => {
    const f = await fixture()
    const created = await slugRequest('create', f.ownerCookie, 'NeW-TEAM')
    expect(created.status).toBe(200)
    const { id, slug } = (await created.json()) as { id: string; slug: string }
    expect(slug).toBe('new-team')
    expect(await settings(id)).toEqual({ name: 'New team', slug: 'new-team' })
    await expectSlugError(
      await slugRequest('check-slug', f.ownerCookie, 'NEw-TEAM'),
      'ORGANIZATION_SLUG_ALREADY_TAKEN',
    )

    const renamed = await update(f.team.id, f.ownerCookie, { slug: 'MiXeD-Case' }, f.team)
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ slug: 'mixed-case' })
    expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: 'mixed-case' })
    expect(await updates(f.team.id)).toEqual([
      { actor_id: f.ownerId, details: { oldSlug: f.team.slug, newSlug: 'mixed-case' } },
    ])
  })

  it('returns the address-in-use error for a case-collision race with a legacy spelling', async () => {
    const f = await fixture()
    const rival = await createTestTeam(db, [])
    const slug = 'raced-public-address'
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('UPDATE auth.organization SET slug = $1 WHERE id = $2', [
        'Raced-Public-Address',
        rival.id,
      ])
      const result = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const blocker = result.rows[0]?.pid
      pending = Promise.resolve(
        update(f.team.id, f.ownerCookie, { name: 'Must not save', slug }, f.team),
      )
      // The rival's uncommitted, case-variant slug is invisible to the native precheck.
      await waitForBlockedBy(blocker)
      await holder.query('COMMIT')

      const raced = await pending
      const taken = await update(f.team.id, f.ownerCookie, { slug }, f.team)
      for (const refused of [raced, taken]) {
        await expectSlugError(refused, 'ORGANIZATION_SLUG_ALREADY_TAKEN')
      }
      expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: f.team.slug })
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending ? [pending] : [])
    }
  })

  it('allows the releasing team to reclaim its address and another team to take it after expiry', async () => {
    const f = await fixture()
    const rival = await fixture()
    const legacy = { name: f.team.name, slug: 'Legacy-Reclaim-Team' }
    const lowercase = legacy.slug.toLowerCase()
    await db.updateTable('auth.organization').set(legacy).where('id', '=', f.team.id).execute()
    await createFixtures(db).eventType(f.team.id, null, {
      slug: 'intro',
      hosts: [{ userId: f.ownerId }],
    })
    const load = (slug: string) => app.request(`/api/v1/public/teams/${slug}/intro`)
    expect((await load(legacy.slug)).status).toBe(200)
    expect((await load(lowercase)).status).toBe(404)
    const renamed = { name: f.team.name, slug: 'reservation-replacement' }
    expect((await update(f.team.id, f.ownerCookie, renamed, legacy)).status).toBe(200)

    const { held } = await db
      .selectFrom('team_slug_reservations')
      .select(
        sql<boolean>`expires_at BETWEEN clock_timestamp() + interval '2159 hours'
          AND clock_timestamp() + interval '2160 hours'`.as('held'),
      )
      .where('organization_id', '=', f.team.id)
      .where('slug', '=', lowercase)
      .executeTakeFirstOrThrow()
    expect(held).toBe(true)
    await expectSlugError(
      await update(rival.team.id, rival.ownerCookie, { slug: lowercase }, rival.team),
      'ORGANIZATION_SLUG_ALREADY_TAKEN',
    )
    await expectSlugError(
      await slugRequest('create', rival.ownerCookie, legacy.slug.toUpperCase()),
      'ORGANIZATION_SLUG_ALREADY_TAKEN',
    )
    await expectSlugError(
      await slugRequest('check-slug', rival.ownerCookie, legacy.slug.toUpperCase()),
      'ORGANIZATION_SLUG_ALREADY_TAKEN',
    )
    expect((await update(f.team.id, f.ownerCookie, { slug: legacy.slug }, renamed)).status).toBe(
      200,
    )
    expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: lowercase })
    expect((await load(lowercase)).status).toBe(200)
    expect((await load(legacy.slug)).status).toBe(404)

    await db
      .updateTable('team_slug_reservations')
      .set({ expires_at: sql<Date>`clock_timestamp() - interval '1 second'` })
      .where('slug', '=', renamed.slug)
      .execute()
    const available = await slugRequest('check-slug', rival.ownerCookie, renamed.slug)
    expect(available.status).toBe(200)
    expect(await available.json()).toEqual({ status: true })
    expect(
      (await update(rival.team.id, rival.ownerCookie, { slug: renamed.slug }, rival.team)).status,
    ).toBe(200)
    expect(await settings(rival.team.id)).toEqual({ name: rival.team.name, slug: renamed.slug })
  })

  it('checks the newly committed hold when a create races the address release', async () => {
    const f = await fixture()
    const rival = await fixture()
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('UPDATE auth.organization SET slug = $1 WHERE id = $2', [
        'released-in-race',
        f.team.id,
      ])
      const result = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const blocker = result.rows[0]?.pid
      // The old exact spelling is still visible to Better Auth's precheck. Use a case
      // variant so the request reaches the persistence boundary while the rename is open.
      pending = Promise.resolve(slugRequest('create', rival.ownerCookie, f.team.slug.toUpperCase()))
      await waitForBlockedBy(blocker)
      await holder.query('COMMIT')
      await expectSlugError(await pending, 'ORGANIZATION_SLUG_ALREADY_TAKEN')
      expect(await settings(f.team.id)).toEqual({ name: f.team.name, slug: 'released-in-race' })
      await expect(
        db.selectFrom('auth.organization').select('id').where('slug', '=', f.team.slug).execute(),
      ).resolves.toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending ? [pending] : [])
    }
  })
})
