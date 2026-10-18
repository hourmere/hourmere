// Real loopback HTTP, Better Auth keys and sessions, MCP transport and CLI over owned PG.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { publicRoutes } from './routes/public.ts'

const bootstrap = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const BASE = 'http://localhost:5173'
const secret = randomBytes(32).toString('base64')
const required = <T>(v: T | undefined | null): T => {
  if (v == null) throw Error('Missing fixture')
  return v
}

describe.skipIf(!bootstrap)('round robin through HTTP, real authentication, MCP and CLI', () => {
  let owned: TestDatabase, db: Db, authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>, server: ReturnType<typeof serve>, url: string
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: BASE,
      secret,
      signup,
      mailer: {
        send: async () => {
          throw Error('Real mail forbidden')
        },
      },
    })
    const plenty = { limit: 100_000, windowSeconds: 60 }
    const rateLimits = { page: plenty, slots: plenty, book: plenty, manage: plenty }
    const app = createApp({
      publicUrl: BASE,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [
        eventTypeRoutes({ db, now }),
        publicRoutes({ db, now, rateLimits }),
        bookingRoutes({ db, now, rateLimits }),
      ],
      mcp: mcpEndpoint({ tools: bookingTools({ db, now, rateLimits }) }),
    })
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server?.close((e) => (e ? reject(e) : resolve())))
    await authPool?.end()
    await owned?.drop()
  })
  async function setup() {
    const owner = await createTestUser(db, 'Round owner'),
      member = await createTestUser(db, 'Round member')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'admin' },
    ])
    const f = createFixtures(db)
    await f.schedule(owner.id, { timeZone: 'UTC' })
    await f.schedule(member.id, { timeZone: 'UTC' })
    const key = await auth.api.createApiKey({
      body: { userId: owner.id, name: 'round-test', metadata: { organizationId: team.id } },
    })
    const token = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        userId: member.id,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: team.id,
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const session = {
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      origin: BASE,
    }
    const headers = { authorization: `Bearer ${key.key}` }
    const created = await api(
      'POST',
      '/api/v1/event-types',
      {
        slug: 'round',
        title: 'Round-robin call',
        durationMinutes: 30,
        schedulingType: 'round_robin',
        hosts: [{ userId: owner.id }, { userId: member.id }],
      },
      headers,
    )
    expect(created.status).toBe(201)
    const event = (await created.json()) as { id: string; roundRobinActive: boolean }
    expect(event.roundRobinActive).toBe(false)
    return {
      owner,
      member,
      team,
      key,
      headers,
      session,
      event,
      path: `/api/v1/public/teams/${team.as(owner).organization.slug}/round`,
    }
  }
  const api = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url}${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  const activate = (
    s: Awaited<ReturnType<typeof setup>>,
    headers: Record<string, string> = s.headers,
  ) => api('POST', `/api/v1/event-types/${s.event.id}/round-robin/activate`, {}, headers)
  async function waitForBlocker(pid: number) {
    for (let n = 0; n < 200; n++) {
      const r = await owned.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
        [pid],
      )
      if (r.rows[0]?.n) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw Error('No PostgreSQL lock waiter')
  }

  it('requires explicit activation and preserves actual winner through REST, MCP and CLI replay', async () => {
    const s = await setup()
    expect((await api('GET', s.path)).status).toBe(404)
    expect(
      (
        await api(
          'PATCH',
          `/api/v1/event-types/${s.event.id}`,
          { title: 'Ordinary save' },
          s.headers,
        )
      ).status,
    ).toBe(200)
    expect((await api('GET', s.path)).status).toBe(404)
    const activationPath = `/api/v1/event-types/${s.event.id}/round-robin/activate`
    expect((await api('POST', activationPath, {})).status).toBe(401)
    expect((await api('POST', activationPath, { enabled: true }, s.headers)).status).toBe(400)
    expect(
      (
        await api(
          'POST',
          activationPath,
          {},
          { ...s.session, origin: 'https://foreign.example.com' },
        )
      ).status,
    ).toBe(403)
    expect((await activate(s, s.session)).status).toBe(200)
    const page = (await (await api('GET', s.path)).json()) as {
      schedulingType: string
      hosts?: unknown
    }
    expect(page.schedulingType).toBe('round_robin')
    expect(page.hosts).toBeUndefined()
    for (const user of [s.owner, s.member]) {
      expect(JSON.stringify(page)).not.toContain(user.id)
      expect(JSON.stringify(page)).not.toContain(user.email)
    }
    const client = new Client({ name: 'round-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: s.headers },
      }),
    )
    try {
      const teamSlug = s.team.as(s.owner).organization.slug
      const slotsResult = await client.callTool({
        name: 'find_available_slots',
        arguments: {
          teamSlug,
          slug: 'round',
          timeZone: 'UTC',
          startDate: '2026-11-02',
          endDate: '2026-11-02',
        },
      })
      expect(slotsResult.isError).toBeFalsy()
      const slots = slotsResult.structuredContent as { slots: { start: string }[] }
      const input = {
        teamSlug,
        slug: 'round',
        start: required(slots.slots[0]).start,
        idempotencyKey: randomUUID(),
        invitee: { name: 'Synthetic', email: 'synthetic@example.com', timeZone: 'UTC' },
      }
      const created = await client.callTool({ name: 'create_booking', arguments: input })
      expect(created.isError).toBeFalsy()
      const booked = created.structuredContent as {
        booking: { id: string; assignedHost: { name: string; timeZone: string } }
        manageToken: string
      }
      expect(Object.keys(booked.booking.assignedHost).sort()).toEqual(['name', 'timeZone'])
      const replay = await client.callTool({ name: 'create_booking', arguments: input })
      expect(replay.structuredContent).toMatchObject({ booking: booked.booking, replayed: true })
      let stdout = '',
        stderr = ''
      const exit = await runCli({
        argv: ['book', '--input', '-'],
        env: { HOURMERE_URL: url, HOURMERE_API_KEY: s.key.key },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (s) => {
          stdout += s
        },
        stderr: (s) => {
          stderr += s
        },
      })
      expect(exit, stderr).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ booking: booked.booking, replayed: true })
      expect(stdout + stderr).not.toContain(s.key.key)
      expect(
        await db
          .selectFrom('booking_hosts')
          .select('user_id')
          .where('booking_id', '=', booked.booking.id)
          .execute(),
      ).toHaveLength(1)
      expect(
        (
          await db
            .selectFrom('round_robin_state')
            .select('next_sequence')
            .where('event_type_id', '=', s.event.id)
            .executeTakeFirst()
        )?.next_sequence,
      ).toBe('1')
      const managed = await api('GET', '/api/v1/bookings/manage', undefined, {
        'x-manage-token': booked.manageToken,
      })
      expect(((await managed.json()) as { assignedHost: unknown }).assignedHost).toEqual(
        booked.booking.assignedHost,
      )
    } finally {
      await client.close()
    }
  })

  for (const kind of ['key', 'session'] as const)
    it(`rechecks ${kind} authority after real HTTP activation waits on event configuration`, async () => {
      const s = await setup()
      const actor = kind === 'key' ? s.owner : s.member
      const blocker = await owned.pool.connect()
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM event_types WHERE id=$1 FOR UPDATE', [s.event.id])
      const pid = required(
        (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0],
      ).pid
      const pending = activate(s, kind === 'key' ? s.headers : s.session)
      try {
        await waitForBlocker(pid)
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('organizationId', '=', s.team.id)
          .where('userId', '=', actor.id)
          .execute()
        await blocker.query('COMMIT')
        const refused = await pending
        expect(refused.status).toBe(403)
        expect(await refused.json()).toMatchObject({ error: 'insufficient_role' })
        expect((await api('GET', s.path)).status).toBe(404)
        expect(
          await db
            .selectFrom('round_robin_state')
            .selectAll()
            .where('event_type_id', '=', s.event.id)
            .execute(),
        ).toEqual([])
      } finally {
        await blocker.query('ROLLBACK').catch(() => {})
        blocker.release()
        await pending
      }
    })
})
