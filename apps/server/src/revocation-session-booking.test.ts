import { serve } from '@hono/node-server'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { sendBookingNotification } from '@hourmere/notifications'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { productRoutes, productTools } from './server.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4389'
const secret = 'synthetic-revocation-booking-session-secret-000000000'
const paths = ['REST', 'MCP', 'CLI'] as const
type Path = (typeof paths)[number]
describe.skipIf(!bootstrap)('departed hosts and guest links through real HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  const outbox: MailMessage[] = []
  const mailer = { send: async (message: MailMessage) => void outbox.push(message) }

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'revocation_book' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // Reused by both sequential scenarios; never one pool per test.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer,
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
      mcp: mcpEndpoint({ tools: productTools({ db }) }),
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

  async function session(url: string, user: TestUser, organizationId: string) {
    const before = outbox.length
    const requested = await fetch(`${url}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: publicUrl },
      body: JSON.stringify({ email: user.email, callbackURL: '/' }),
    })
    expect(requested.status).toBe(200)
    await requested.body?.cancel()
    await vi.waitFor(() =>
      expect(outbox.slice(before).some((message) => message.to === user.email)).toBe(true),
    )
    const mail = outbox.slice(before).find((message) => message.to === user.email)
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0]
    expect(typeof link === 'string', 'sign-in email includes a confirmation link').toBe(true)
    const confirm = await pressConfirmButton(
      {
        request: (input) => {
          const target = new URL(input)
          return fetch(`${url}${target.pathname}${target.search}`, { redirect: 'manual' })
        },
      },
      new URL(link as string),
    )
    const verified = await fetch(`${url}${confirm.pathname}${confirm.search}`, {
      redirect: 'manual',
    })
    expect(verified.status).toBe(302)
    const cookie = verified.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(cookie.includes('better-auth.session_token=')).toBe(true)
    await verified.body?.cancel()
    const active = await fetch(`${url}/api/auth/organization/set-active`, {
      method: 'POST',
      headers: writeHeaders(cookie, user.principal.organization.id),
      body: JSON.stringify({ organizationId }),
    })
    expect(active.status).toBe(200)
    await active.body?.cancel()
    return cookie
  }

  async function fixture(url: string) {
    const host = await createTestUser(db, 'Departing admin')
    const owner = await createTestUser(db, 'Continuing owner')
    const team = await createTestTeam(db, [
      { user: host, role: 'admin' },
      { user: owner, role: 'owner' },
    ])
    const fixtures = createFixtures(db)
    const handle = `departing-${host.id.slice(-12)}`
    await db.insertInto('profiles').values({ user_id: host.id, handle, time_zone: 'UTC' }).execute()
    await fixtures.schedule(host.id, { timeZone: 'UTC' })
    await fixtures.eventType(host.principal.organization.id, host.id, { slug: 'personal' })
    const teamEventTypeId = await fixtures.eventType(team.id, null, {
      slug: 'team',
      hosts: [{ userId: host.id }],
    })
    const teamSlug = team.as(host).organization.slug
    const cookie = await session(url, host, team.id)
    const secondCookie = await session(url, host, team.id)
    const ownerCookie = await session(url, owner, team.id)
    const key = (
      await auth.api.createApiKey({
        body: { userId: host.id, metadata: { organizationId: host.principal.organization.id } },
      })
    ).key
    return {
      host,
      owner,
      team,
      handle,
      teamSlug,
      teamEventTypeId,
      cookie,
      secondCookie,
      ownerCookie,
      key,
    }
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

  async function booking(url: string, f: Fixture, personal = false, sequence = 0) {
    let day = Temporal.Now.zonedDateTimeISO('UTC').add({ days: 2 }).toPlainDate()
    while (day.dayOfWeek > 5) day = day.add({ days: 1 })
    for (let i = 0; i < sequence; i++) {
      day = day.add({ days: 1 })
      while (day.dayOfWeek > 5) day = day.add({ days: 1 })
    }
    const start = day.toZonedDateTime({ timeZone: 'UTC', plainTime: '10:00' }).toInstant()
    const response = await fetch(
      `${url}/api/v1/public/${personal ? `${f.handle}/personal` : `teams/${f.teamSlug}/team`}/bookings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: start.toString(),
          invitee: {
            name: 'Invitee',
            email: `invitee-${personal ? 'personal' : sequence}@example.com`,
            timeZone: 'UTC',
          },
        }),
      },
    )
    expect(response.status, 'guest booking is issued by the public booking flow').toBe(201)
    const body = (await response.json()) as { booking: { id: string }; manageToken: string }
    expect(typeof body.manageToken === 'string').toBe(true)
    const before = outbox.length
    // Run the same delivery handler as the booking-notification worker with a capturing mailer.
    await sendBookingNotification({ db, mailer, secret, publicUrl }, body.booking.id, 'confirmed')
    const mail = outbox.slice(before).find((message) => message.to.startsWith('invitee-'))
    const emailToken = mail?.text.match(/#token=([A-Za-z0-9_-]{43})&action=/)?.[1]
    expect(typeof emailToken === 'string', 'notification issues its own guest link').toBe(true)
    expect(emailToken === body.manageToken, 'response and email capabilities are distinct').toBe(
      false,
    )
    return {
      id: body.booking.id,
      responseToken: body.manageToken,
      emailToken: emailToken as string,
    }
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
        headers: writeHeaders(cookie, identity.organization.id),
        body: JSON.stringify({ organizationId: f.team.id, data: { name: 'Denied stale edit' } }),
      })
      expect(update.status).toBe(409)
      expect(await update.json()).toMatchObject({ code: 'ORGANIZATION_CONTEXT_CHANGED' })
      // HTTP also binds the explicit target to the expected context. The trusted native
      // API bypasses that consistency guard and exercises its own membership check.
      await expect(
        auth.api.updateOrganization({
          headers: new Headers({ cookie }),
          body: { organizationId: f.team.id, data: { name: 'Denied stale edit' } },
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        body: { code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' },
      })
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
      const f = await fixture(url)
      const personal = await booking(url, f, true, 12)
      const bookings: Booking[] = []
      for (let i = 0; i < paths.length * 2; i++) bookings.push(await booking(url, f, false, i))
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
      const f = await fixture(url)
      const team = await booking(url, f)
      const personal = await booking(url, f, true, 12)
      const blocked = await fetch(`${url}/api/v1/teams/${f.team.id}/leave`, {
        method: 'POST',
        headers: writeHeaders(f.cookie, f.team.id),
        body: '{}',
      })
      expect(blocked.status).toBe(409)
      privateResponse(await blocked.json(), [team.responseToken, team.emailToken])
      await cancelGuest(url, f, team, 'REST', team.responseToken)
      const deleted = await fetch(`${url}/api/v1/event-types/${f.teamEventTypeId}`, {
        method: 'DELETE',
        headers: writeHeaders(f.cookie, f.team.id),
      })
      expect(deleted.status).toBe(204)
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
})
