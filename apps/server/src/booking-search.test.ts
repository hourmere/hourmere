// The booking list's search and cancelled view through REST, MCP (as the CLI calls it) and the
// team route, over a throwaway database: one service, the same rows, bounds and scope.
import { randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { type OpenApiDoc, openApiDocument, syntheticSessionCookie } from './routes/test-app.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:3000'
const NOW = Temporal.Instant.from('2026-11-01T00:00:00Z')
type Page = { data: { id: string; status: string }[]; nextCursor: string | null }

describe.skipIf(!serverUrl)('booking search through REST, MCP and CLI', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  const principals = new Map<string, Principal>()
  let ids: Record<
    | 'ada'
    | 'strategy'
    | 'adaCancelled'
    | 'otherCancelled'
    | 'percent'
    | 'lookalike'
    | 'strangerAda'
    | 'teamAda'
    | 'teamCancelled'
    | 'teamOther',
    string
  >
  let tokens: Record<'host' | 'stranger' | 'ownerKey' | 'ownerSession' | 'memberSession', string>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => {
        const authorization = headers.get('authorization')
        const token =
          authorization === null
            ? /(?:^|;\s*)hourmere_test_session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1]
            : /^Bearer (\S+)$/.exec(authorization)?.[1]
        const principal = token === undefined ? undefined : principals.get(token)
        return principal &&
          (authorization === null ? principal.kind === 'session' : principal.kind !== 'session')
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      publicUrl: PUBLIC_URL,
      routes: [bookingRoutes({ db, now: () => NOW }), teamBookingRoutes({ db, now: () => NOW })],
      mcp: mcpEndpoint({ tools: bookingTools({ db, now: () => NOW }) }),
    })

    const f = createFixtures(db)
    const [host, stranger, owner, member] = await Promise.all(
      ['Host', 'Stranger', 'Owner', 'Member'].map((name) => createTestUser(db, name)),
    )
    if (!host || !stranger || !owner || !member) throw new Error('Missing test users')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
      { user: host, role: 'member' },
    ])
    const personal = host.principal.organization.id
    const strategy = await f.eventType(personal, host.id, { title: 'Strategy Session' })
    const at = (day: number, hour: number) =>
      `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00Z`
    const book = (
      organizationId: string,
      hostId: string,
      start: string,
      name: string,
      options: { status?: 'confirmed' | 'cancelled'; eventTypeId?: string } = {},
    ) =>
      f.booking(organizationId, [hostId], start, start.replace(':00Z', ':30Z'), {
        ...options,
        attendee: { name, email: `${name.toLowerCase().replaceAll(/\W+/g, '.')}@example.com` },
      })
    ids = {
      ada: await book(personal, host.id, at(2, 9), 'Ada Lovelace'),
      strategy: await book(personal, host.id, at(2, 10), 'Grace Hopper', {
        eventTypeId: strategy,
      }),
      adaCancelled: await book(personal, host.id, at(3, 9), 'Ada King', { status: 'cancelled' }),
      otherCancelled: await book(personal, host.id, at(3, 10), 'Dorothy Vaughan', {
        status: 'cancelled',
      }),
      percent: await book(personal, host.id, at(4, 9), '100% Club'),
      lookalike: await book(personal, host.id, at(4, 10), '1000 Club'),
      strangerAda: await book(stranger.principal.organization.id, stranger.id, at(2, 9), 'Ada'),
      teamAda: await book(team.id, owner.id, at(5, 9), 'Ada Team Invitee'),
      teamCancelled: await book(team.id, owner.id, at(5, 10), 'Ada Gone', {
        status: 'cancelled',
      }),
      teamOther: await book(team.id, owner.id, at(5, 11), 'Someone Else'),
    }

    const key = (principal: Principal) => {
      const token = `hm_${randomUUID()}`
      principals.set(token, principal)
      return token
    }
    const session = async (user: typeof owner) => {
      const organization = team.as(user).organization
      const { id } = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token: randomBytes(24).toString('base64url'),
          expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
          updatedAt: new Date(),
          activeOrganizationId: organization.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return key({ kind: 'session', sessionId: id, user, organization })
    }
    tokens = {
      host: key(host.principal),
      stranger: key(stranger.principal),
      ownerKey: key(team.as(owner)),
      ownerSession: await session(owner),
      memberSession: await session(member),
    }
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function rest(path: string, token: string) {
    const credentials = token.startsWith('hm_') && principals.get(token)?.kind !== 'session'
    const response = await app.request(path, {
      headers: credentials
        ? { authorization: `Bearer ${token}` }
        : { cookie: syntheticSessionCookie(token) },
    })
    return { status: response.status, body: (await response.json()) as Page & { error?: string } }
  }

  /** Every page through REST, carrying the cursor with unchanged filters. */
  async function restPages(path: string, query: Record<string, string>, token = tokens.host) {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const params = new URLSearchParams({ ...query, limit: '1', ...(cursor ? { cursor } : {}) })
      const { status, body } = await rest(`${path}?${params}`, token)
      expect(status, JSON.stringify(body)).toBe(200)
      seen.push(...body.data.map((booking) => booking.id))
      cursor = body.nextCursor
    } while (cursor)
    return seen
  }

  async function cli(input: Record<string, unknown>, token = tokens.host) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: ['list', '--input', '-'],
      env: { HOURMERE_URL: PUBLIC_URL, HOURMERE_API_KEY: token },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (url, init) => app.request(String(url), init),
    })
    return {
      code,
      data: stdout ? (JSON.parse(stdout) as Page) : undefined,
      error: stderr ? (JSON.parse(stderr) as { error: string; message?: string }) : undefined,
    }
  }

  /** Every page through the CLI (and so MCP list_bookings). */
  async function cliPages(input: Record<string, unknown>, token = tokens.host) {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const { code, data, error } = await cli(
        { ...input, limit: 1, ...(cursor ? { cursor } : {}) },
        token,
      )
      expect(code, JSON.stringify(error)).toBe(0)
      seen.push(...(data?.data ?? []).map((booking) => booking.id))
      cursor = data?.nextCursor ?? null
    } while (cursor)
    return seen
  }

  it('returns the same cancelled view and search results through REST, MCP and CLI', async () => {
    const cases: [Record<string, string>, string[]][] = [
      [{ status: 'cancelled' }, [ids.adaCancelled, ids.otherCancelled]],
      [{ q: 'ada' }, [ids.ada, ids.adaCancelled]],
      [{ q: 'ADA', status: 'cancelled' }, [ids.adaCancelled]],
      [{ q: 'ada', status: 'confirmed' }, [ids.ada]],
      [{ q: 'strategy session' }, [ids.strategy]],
      [{ q: 'GRACE.HOPPER@EXAMPLE' }, [ids.strategy]],
      [{ q: '100%' }, [ids.percent]],
      [{ q: '%' }, [ids.percent]],
      [{ q: '  club ' }, [ids.percent, ids.lookalike]],
      [{ q: 'ada', order: 'desc' }, [ids.adaCancelled, ids.ada]],
      [{ q: 'nobody' }, []],
    ]
    for (const [query, expected] of cases) {
      expect(await restPages('/api/v1/bookings', query), JSON.stringify(query)).toEqual(expected)
      expect(await cliPages(query), JSON.stringify(query)).toEqual(expected)
    }
    // Statuses in the cancelled view really are cancelled.
    const { body } = await rest('/api/v1/bookings?status=cancelled', tokens.host)
    expect(body.data.map((booking) => booking.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('refuses a search that is too long or has control characters on every interface', async () => {
    const longest = 'a'.repeat(100)
    expect((await rest(`/api/v1/bookings?q=${longest}`, tokens.host)).status).toBe(200)
    expect((await rest(`/api/v1/bookings?q=%20${longest}%20`, tokens.host)).status).toBe(200)
    for (const q of [`${longest}a`, 'Ada%00', 'Ada%0ALovelace']) {
      const answer = await rest(`/api/v1/bookings?q=${q}`, tokens.host)
      expect(answer.status, q).toBe(400)
      expect(answer.body.error).toBe('invalid_request')
      const team = await rest(`/api/v1/team/bookings?q=${q}`, tokens.ownerSession)
      expect(team.status, q).toBe(400)
    }
    expect(await cli({ q: longest })).toMatchObject({ code: 0 })
    for (const q of [`${longest}a`, 'Ada\u0000', 'Ada\nLovelace']) {
      const refused = await cli({ q })
      expect(refused.code, JSON.stringify(q)).not.toBe(0)
      expect(refused.data).toBeUndefined()
      expect(refused.error?.error).toBe('invalid_request')
    }
  })

  it('keeps search inside the caller scope, including the team rules', async () => {
    // Another organization's identical invitee never appears, through any interface.
    expect(await restPages('/api/v1/bookings', { q: 'ada' }, tokens.stranger)).toEqual([
      ids.strangerAda,
    ])
    expect(await cliPages({ q: 'ada' }, tokens.stranger)).toEqual([ids.strangerAda])
    // Acting in the team, the owner's key sees only what the owner hosts there.
    expect(await restPages('/api/v1/bookings', { q: 'ada' }, tokens.ownerKey)).toEqual([
      ids.teamAda,
      ids.teamCancelled,
    ])
    // The team view: owners/admins only, this team only, with the same filters.
    expect(await restPages('/api/v1/team/bookings', { q: 'ada' }, tokens.ownerSession)).toEqual([
      ids.teamAda,
      ids.teamCancelled,
    ])
    expect(
      await restPages(
        '/api/v1/team/bookings',
        { q: 'ADA', status: 'cancelled' },
        tokens.ownerSession,
      ),
    ).toEqual([ids.teamCancelled])
    // A member without team-management access, and any API key, are refused outright.
    for (const token of [tokens.memberSession, tokens.ownerKey]) {
      const refused = await rest('/api/v1/team/bookings?q=ada', token)
      expect(refused.status).toBe(403)
      expect(refused.body.error).toBe('team_management_access_denied')
    }
  })

  it('documents q as a bounded, optional list parameter and keeps it out of CSV export', async () => {
    const doc: OpenApiDoc = await openApiDocument(app)
    type Parameter = { name: string; in: string; required?: boolean; schema: unknown }
    const parameter = (path: string, name: string) =>
      (doc.paths[path]?.get?.parameters as Parameter[] | undefined)?.find(
        (p) => p.in === 'query' && p.name === name,
      )
    for (const path of ['/api/v1/bookings', '/api/v1/team/bookings']) {
      expect(parameter(path, 'q')).toMatchObject({
        required: false,
        schema: { type: 'string', maxLength: 100 },
      })
      expect(parameter(path, 'status')).toMatchObject({
        schema: { type: 'string', enum: ['confirmed', 'cancelled'] },
      })
    }
    expect(parameter('/api/v1/bookings/export.csv', 'q')).toBeUndefined()
  })
})
