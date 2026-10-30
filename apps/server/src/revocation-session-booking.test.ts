import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import type { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import type { bookingRoutes } from './routes/bookings.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { productRoutes, productTools } from './server.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4389'
const secret = 'synthetic-revocation-booking-session-secret-000000000'
const paths = ['REST', 'MCP', 'CLI'] as const
type Path = (typeof paths)[number]
type Replacement = readonly [string, string]
type Copies = { routes: typeof bookingRoutes; tools: typeof bookingTools }

/** Evaluate disposable copies; mutations never change the worktree or other test workers. */
async function sourceCopy<T>(
  file: string,
  exported: string,
  overrides: Record<string, unknown> = {},
  replacements: Replacement[] = [],
): Promise<T> {
  let source = readFileSync(file, 'utf8')
  for (const [before, after] of replacements) {
    expect(source.includes(before), 'mutation must match source').toBe(true)
    source = source.replaceAll(before, after)
  }
  source = stripTypeScriptTypes(source)
  const imports = /^import\s+\{([\s\S]*?)\}\s+from\s+'([^']+)'\n/gm
  const bindings: Record<string, unknown> = {}
  for (const match of source.matchAll(imports)) {
    const specifier = match[2] as string
    const imported = (await import(
      specifier.startsWith('.') ? new URL(specifier, pathToFileURL(resolve(file))).href : specifier
    )) as Record<string, unknown>
    for (const entry of (match[1] as string).split(',')) {
      const [name, alias = name] = entry.trim().split(/\s+as\s+/)
      if (name && alias)
        bindings[alias] = Object.hasOwn(overrides, name) ? overrides[name] : imported[name]
    }
  }
  source = source
    .replace(imports, '')
    .replace(/^export \{[^}]+\} from '[^']+'\n/gm, '')
    .replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${source}; return ${exported}`)(
    ...Object.values(bindings),
  ) as T
}

async function bookingCopies(replacements: Replacement[] = []): Promise<Copies> {
  const services = await sourceCopy<Record<string, unknown>>(
    'packages/scheduling/src/bookings.ts',
    '{ listHostBookings, getHostBooking, cancelManagedBooking }',
    {},
    replacements,
  )
  return {
    routes: await sourceCopy('apps/server/src/routes/bookings.ts', 'bookingRoutes', services),
    tools: await sourceCopy('apps/server/src/mcp/bookings.ts', 'bookingTools', services),
  }
}

describe.skipIf(!bootstrap)('departed hosts and guest links through real HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'revocation_book' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // Reused by all sequential scenarios and source copies; never one pool per test.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function withServer<T>(
    run: (url: string) => Promise<T>,
    copies?: Copies,
    resolver = createCallerResolver({ auth, db }),
  ): Promise<T> {
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: resolver,
      routes: copies
        ? [
            copies.routes({ db }),
            memberLeaveRoutes({ db }),
            memberRemovalRoutes({ db }),
            teamBookingRoutes({ db }),
          ]
        : productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
      mcp: mcpEndpoint({ tools: copies ? copies.tools({ db }) : productTools({ db }) }),
    })
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    try {
      if (!server.listening) await new Promise<void>((done) => server.once('listening', done))
      return await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    } finally {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    }
  }

  async function session(user: TestUser, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }

  async function fixture() {
    const host = await createTestUser(db, 'Departing admin')
    const owner = await createTestUser(db, 'Continuing owner')
    const team = await createTestTeam(db, [
      { user: host, role: 'admin' },
      { user: owner, role: 'owner' },
    ])
    const cookie = await session(host, team.id)
    const secondCookie = await session(host, team.id)
    const ownerCookie = await session(owner, team.id)
    const key = (
      await auth.api.createApiKey({
        body: { userId: host.id, metadata: { organizationId: host.principal.organization.id } },
      })
    ).key
    return { host, owner, team, cookie, secondCookie, ownerCookie, key }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function writeHeaders(cookie: string, teamId: string) {
    return {
      cookie,
      origin: publicUrl,
      'content-type': 'application/json',
      'x-expected-organization-id': teamId,
    }
  }

  async function depart(url: string, f: Fixture, mode: 'leave' | 'remove') {
    const response = await fetch(
      `${url}${mode === 'leave' ? `/api/v1/teams/${f.team.id}/leave` : `/api/v1/team/members/${f.host.id}/removal`}`,
      {
        method: 'POST',
        headers: writeHeaders(mode === 'leave' ? f.cookie : f.ownerCookie, f.team.id),
        body: JSON.stringify(mode === 'leave' ? {} : { teamId: f.team.id }),
      },
    )
    expect(response.status).toBe(200)
    return response.json()
  }

  async function booking(f: Fixture, personal = false, sequence = 0) {
    const start = Temporal.Now.instant().add({ hours: 48 + sequence })
    const responseToken = randomBytes(32).toString('base64url')
    const emailToken = randomBytes(32).toString('base64url')
    const hash = (token: string) => createHash('sha256').update(token).digest()
    const { id, attendeeId } = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('bookings')
        .values({
          organization_id: personal ? f.host.principal.organization.id : f.team.id,
          start_at: start.toString(),
          end_at: start.add({ minutes: 30 }).toString(),
          title: 'Guest appointment',
          source: 'web',
          manage_token_hash: hash(responseToken),
          required_host_user_ids: [f.host.id],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('booking_hosts')
        .values({ booking_id: row.id, user_id: f.host.id })
        .execute()
      const attendee = await trx
        .insertInto('booking_attendees')
        .values({
          booking_id: row.id,
          name: 'Invitee',
          email: 'invitee@example.com',
          time_zone: 'UTC',
          is_booker: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { ...row, attendeeId: attendee.id }
    })
    // A synthetic sent receipt exercises the email-link lookup without contacting SMTP.
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: id,
        kind: 'confirmed',
        recipient: `attendee:${attendeeId}`,
        manage_token_hash: hash(emailToken),
      })
      .execute()
    return { id, responseToken, emailToken }
  }
  type Booking = Awaited<ReturnType<typeof booking>>

  function privateResponse(value: unknown, tokens: string[]) {
    const serialized = JSON.stringify(value)
    expect(
      tokens.some((token) => serialized.includes(token)),
      'no private token in response',
    ).toBe(false)
    expect(
      /"(?:manageToken|manage_token_hash|manageTokenHash)"\s*:/.test(serialized),
      'no private capability fields',
    ).toBe(false)
  }

  async function mcp(url: string, key: string, name: string, args: Record<string, unknown>) {
    const client = new Client({ name: 'revocation-booking', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      )
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }

  async function cli(url: string, key: string, command: string, input: Record<string, unknown>) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [command, '--input', '-'],
      env: { HOURMERE_URL: url, HOURMERE_API_KEY: key },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
    })
    expect((stdout + stderr).includes(key)).toBe(false)
    return { code, stdout, stderr }
  }

  async function cancelGuest(url: string, f: Fixture, b: Booking, transport: Path, token: string) {
    let value: unknown
    if (transport === 'REST') {
      const response = await fetch(`${url}/api/v1/bookings/manage/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-manage-token': token },
        body: '{}',
      })
      expect(response.status, 'guest cancellation remains authorized').toBe(200)
      value = await response.json()
    } else if (transport === 'MCP') {
      const result = await mcp(url, f.key, 'cancel_booking', { manageToken: token })
      expect(result.isError).toBeFalsy()
      value = result.structuredContent
      privateResponse(result, [b.responseToken, b.emailToken])
    } else {
      const result = await cli(url, f.key, 'cancel', { manageToken: token })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      value = JSON.parse(result.stdout)
    }
    privateResponse(value, [b.responseToken, b.emailToken])
    expect(value).toMatchObject({ id: b.id, status: 'cancelled' })
    expect(
      await db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', b.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'cancelled' })
  }

  async function oldSessions(url: string, f: Fixture) {
    for (const cookie of [f.cookie, f.secondCookie]) {
      const response = await fetch(`${url}/api/v1/me`, { headers: { cookie } })
      expect(response.status, 'old sessions retain personal access').toBe(200)
      const identity = (await response.json()) as { organization: { id: string } }
      expect(identity.organization.id, 'old sessions fall back from the revoked team').toBe(
        f.host.principal.organization.id,
      )
      expect(identity).toMatchObject({
        organization: { id: f.host.principal.organization.id, personal: true },
      })
      const team = await fetch(`${url}/api/v1/team/bookings?teamId=${f.team.id}`, {
        headers: { cookie },
      })
      expect(team.status).toBe(403)
      expect(await team.json()).toMatchObject({ error: 'team_management_access_denied' })
      const update = await fetch(`${url}/api/auth/organization/update`, {
        method: 'POST',
        headers: writeHeaders(cookie, f.team.id),
        body: JSON.stringify({ organizationId: f.team.id, data: { name: 'Denied stale edit' } }),
      })
      expect([403, 409].includes(update.status)).toBe(true)
      const switched = await fetch(`${url}/api/auth/organization/set-active`, {
        method: 'POST',
        headers: writeHeaders(cookie, f.team.id),
        body: JSON.stringify({ organizationId: f.team.id }),
      })
      expect(switched.ok).toBe(false)
    }
    expect(
      (
        await db
          .selectFrom('auth.organization')
          .select('name')
          .where('id', '=', f.team.id)
          .executeTakeFirstOrThrow()
      ).name,
    ).toBe('Test Team')
  }

  async function hostPrivacy(url: string, f: Fixture, personal: Booking, departed: Booking) {
    const tokens = [
      personal.responseToken,
      personal.emailToken,
      departed.responseToken,
      departed.emailToken,
    ]
    const details = await fetch(`${url}/api/v1/bookings/${personal.id}`, {
      headers: { cookie: f.secondCookie },
    })
    expect(details.status).toBe(200)
    privateResponse(await details.json(), tokens)
    const list = await fetch(`${url}/api/v1/bookings`, { headers: { cookie: f.secondCookie } })
    expect(list.status).toBe(200)
    const page = (await list.json()) as { data: { id: string }[] }
    privateResponse(page, tokens)
    expect(
      page.data.map((row) => row.id),
      'only current organization bookings',
    ).toEqual([personal.id])
    for (const method of ['GET', 'POST']) {
      const response = await fetch(
        `${url}/api/v1/bookings/${departed.id}${method === 'POST' ? '/reschedule' : ''}`,
        {
          method,
          headers: writeHeaders(f.secondCookie, f.host.principal.organization.id),
          ...(method === 'POST' && {
            body: JSON.stringify({ start: Temporal.Now.instant().add({ hours: 100 }).toString() }),
          }),
        },
      )
      expect(response.status).toBe(404)
      const value = await response.json()
      privateResponse(value, tokens)
      expect(value).toMatchObject({ error: 'booking_not_found' })
    }
    const tool = await mcp(url, f.key, 'list_bookings', {})
    expect(tool.isError).toBeFalsy()
    privateResponse(tool, tokens)
    expect((tool.structuredContent as typeof page).data.map((row) => row.id)).toEqual([personal.id])
    const terminal = await cli(url, f.key, 'list', {})
    expect(terminal.code).toBe(0)
    privateResponse(JSON.parse(terminal.stdout), tokens)
    expect((JSON.parse(terminal.stdout) as typeof page).data.map((row) => row.id)).toEqual([
      personal.id,
    ])
    for (const action of ['cancel', 'reschedule']) {
      const input = {
        bookingId: departed.id,
        ...(action === 'reschedule' && {
          start: Temporal.Now.instant().add({ hours: 100 }).toString(),
        }),
      }
      const result = await mcp(url, f.key, `${action}_booking`, input)
      expect(result.isError).toBe(true)
      privateResponse(result, tokens)
      expect(JSON.stringify(result).includes('booking_not_found')).toBe(true)
      const terminalResult = await cli(url, f.key, action, input)
      expect(terminalResult.code).toBe(1)
      expect(terminalResult.stdout).toBe('')
      privateResponse(JSON.parse(terminalResult.stderr), tokens)
      expect(JSON.parse(terminalResult.stderr)).toMatchObject({ error: 'booking_not_found' })
    }
  }

  it('revokes old admin sessions while preserving both kinds of guest links after removal', async () => {
    await withServer(async (url) => {
      const f = await fixture()
      const personal = await booking(f, true, 12)
      const bookings: Booking[] = []
      for (let i = 0; i < paths.length * 2; i++) bookings.push(await booking(f, false, i))
      const before = await fetch(`${url}/api/v1/team/bookings`, {
        headers: { cookie: f.secondCookie },
      })
      expect(before.status).toBe(200)
      privateResponse(
        await before.json(),
        bookings.flatMap((b) => [b.responseToken, b.emailToken]),
      )
      privateResponse(
        await depart(url, f, 'remove'),
        bookings.flatMap((b) => [b.responseToken, b.emailToken]),
      )
      await oldSessions(url, f)
      await hostPrivacy(url, f, personal, bookings[0] as Booking)
      for (let i = 0; i < paths.length; i++) {
        const response = bookings[i * 2] as Booking
        const email = bookings[i * 2 + 1] as Booking
        await cancelGuest(url, f, response, paths[i] as Path, response.responseToken)
        await cancelGuest(url, f, email, paths[i] as Path, email.emailToken)
      }
      await cancelGuest(url, f, personal, 'REST', personal.emailToken)
    })
  })

  it('requires handling before leave, retains canceled team links and permits personal guest cancellation', async () => {
    await withServer(async (url) => {
      const f = await fixture()
      const team = await booking(f)
      const personal = await booking(f, true, 12)
      const blocked = await fetch(`${url}/api/v1/teams/${f.team.id}/leave`, {
        method: 'POST',
        headers: writeHeaders(f.cookie, f.team.id),
        body: '{}',
      })
      expect(blocked.status).toBe(409)
      privateResponse(await blocked.json(), [team.responseToken, team.emailToken])
      await cancelGuest(url, f, team, 'REST', team.responseToken)
      privateResponse(await depart(url, f, 'leave'), [team.responseToken, team.emailToken])
      await oldSessions(url, f)
      await hostPrivacy(url, f, personal, team)
      for (const token of [team.responseToken, team.emailToken]) {
        const response = await fetch(`${url}/api/v1/bookings/manage`, {
          headers: { 'x-manage-token': token },
        })
        expect(response.status).toBe(200)
        const value = await response.json()
        privateResponse(value, [team.responseToken, team.emailToken])
        expect(value).toMatchObject({ id: team.id, status: 'cancelled' })
        const repeated = await fetch(`${url}/api/v1/bookings/manage/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-manage-token': token },
          body: '{}',
        })
        expect(repeated.status).toBe(409)
        expect(await repeated.json()).toMatchObject({ error: 'booking_cancelled' })
      }
      await cancelGuest(url, f, personal, 'CLI', personal.emailToken)
    })
  })

  async function verifyGuest(copies: Copies) {
    await withServer(async (url) => {
      const f = await fixture()
      const b = await booking(f)
      await depart(url, f, 'remove')
      await cancelGuest(url, f, b, 'REST', b.emailToken)
    }, copies)
  }

  async function verifyPrivacy(copies: Copies) {
    await withServer(async (url) => {
      const f = await fixture()
      const b = await booking(f)
      const personal = await booking(f, true, 12)
      await depart(url, f, 'remove')
      await hostPrivacy(url, f, personal, b)
    }, copies)
  }

  it('passes guest and departed-host assertions using unmodified service, route and tool copies', async () => {
    const copies = await bookingCopies()
    await verifyGuest(copies)
    await verifyPrivacy(copies)
  })

  it('detects requiring current host membership for a guest cancellation with a real assertion', async () => {
    const copies = await bookingCopies([
      [
        'await lockCancellationOrganization(trx, parent.organization_id)',
        `if (!(await trx.selectFrom('booking_hosts as h').innerJoin('auth.member as m', 'm.userId', 'h.user_id').select('h.user_id').where('h.booking_id', '=', target.id).where('m.organizationId', '=', parent.organization_id).executeTakeFirst())) throw bookingNotFound()
    await lockCancellationOrganization(trx, parent.organization_id)`,
      ],
    ])
    await expect(verifyGuest(copies)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('guest cancellation remains authorized'),
      actual: 404,
      expected: 200,
    })
  })

  it('detects exposing a management capability in host reads with a real assertion', async () => {
    const copies = await bookingCopies([
      ['id: r.id,', "id: r.id, manageToken: 'synthetic-capability-control',"],
    ])
    await expect(verifyPrivacy(copies)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('no private capability fields'),
      actual: true,
      expected: false,
    })
  })

  it('detects dropping the booking organization scope with a real assertion', async () => {
    const copies = await bookingCopies([
      [".where('b.organization_id', '=', ctx.principal.organization.id)", ''],
    ])
    await expect(verifyPrivacy(copies)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('only current organization bookings'),
    })
  })

  async function verifySessionFallback(resolver: ReturnType<typeof createCallerResolver>) {
    await withServer(
      async (url) => {
        const f = await fixture()
        await depart(url, f, 'remove')
        await oldSessions(url, f)
      },
      undefined,
      resolver,
    )
  }

  it('passes old-session fallback assertions with the unmodified resolver source copy', async () => {
    const factory = await sourceCopy<typeof createCallerResolver>(
      'packages/auth/src/caller.ts',
      'createCallerResolver',
    )
    await verifySessionFallback(factory({ auth, db }))
  })

  it('detects removing the old-session personal fallback with a real assertion', async () => {
    const factory = await sourceCopy<typeof createCallerResolver>(
      'packages/auth/src/caller.ts',
      'createCallerResolver',
      {},
      [
        [
          '(active ? await inOrganization(userId, active) : undefined) ??\n      (await inOrganization(userId, await ensurePersonalOrganization(db, userId)))',
          '(active ? await inOrganization(userId, active) : undefined)',
        ],
      ],
    )
    await expect(verifySessionFallback(factory({ auth, db }))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('old sessions retain personal access'),
      actual: 401,
      expected: 200,
    })
  })

  it('detects trusting stale session team context without current membership', async () => {
    const factory = await sourceCopy<typeof createCallerResolver>(
      'packages/auth/src/caller.ts',
      'createCallerResolver',
      {},
      [
        [
          ".innerJoin('auth.organization as o', 'o.id', 'm.organizationId')",
          ".innerJoin('auth.organization as o', (join) => join.on('o.id', '=', organizationId))",
        ],
        [".where('m.organizationId', '=', organizationId)", ''],
      ],
    )
    await expect(verifySessionFallback(factory({ auth, db }))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('old sessions fall back from the revoked team'),
    })
  })
})
