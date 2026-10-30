import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { listHostBookings } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import type { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import type { bookingRoutes } from './routes/bookings.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { productRoutes, productTools } from './server.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4387'
const secret = 'synthetic-host-scope-session-secret-00000000000000'
const transports = ['REST session', 'REST API key', 'MCP', 'CLI'] as const
type Transport = (typeof transports)[number]
type Page = { data: { id: string }[]; nextCursor: string | null }
type Factories = { routes: typeof bookingRoutes; tools: typeof bookingTools }

/** Compile only an in-memory source copy; production files remain untouched. */
async function sourceCopy<T>(
  file: string,
  exported: string,
  overrides: Record<string, unknown> = {},
  replacement?: [string, string],
): Promise<T> {
  let source = readFileSync(file, 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source)
  const bindings: Record<string, unknown> = {}
  const imports = /^import\s+\{([\s\S]*?)\}\s+from\s+'([^']+)'\n/gm
  for (const match of source.matchAll(imports)) {
    const specifier = match[2] as string
    const module = (await import(
      specifier.startsWith('.') ? new URL(specifier, pathToFileURL(resolve(file))).href : specifier
    )) as Record<string, unknown>
    for (const imported of (match[1] as string).split(',')) {
      const [name, alias = name] = imported.trim().split(/\s+as\s+/)
      if (name && alias)
        bindings[alias] = Object.hasOwn(overrides, name) ? overrides[name] : module[name]
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

async function sourceFactories(replacement?: [string, string]): Promise<Factories> {
  const service = await sourceCopy<typeof listHostBookings>(
    'packages/scheduling/src/bookings.ts',
    'listHostBookings',
    {},
    replacement,
  )
  const overrides = { listHostBookings: service }
  return {
    routes: await sourceCopy('apps/server/src/routes/bookings.ts', 'bookingRoutes', overrides),
    tools: await sourceCopy('apps/server/src/mcp/bookings.ts', 'bookingTools', overrides),
  }
}

describe.skipIf(!bootstrap)('team reads preserve host listing scope over HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>
  let cookie: string
  let key: string
  let hostIds: string[]
  let teamIds: string[]

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // One auth pool is shared by all listeners and closed before dropping the fixture DB.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    const owner = await createTestUser(db, 'Host and team owner')
    const member = await createTestUser(db, 'Another team host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const otherTeam = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const f = createFixtures(db)
    const eventTypeId = await f.eventType(team.id, null, {
      hosts: [{ userId: owner.id }, { userId: member.id }],
    })
    const mine = await f.booking(team.id, [owner.id], '2026-11-04T09:00Z', '2026-11-04T09:30Z', {
      eventTypeId,
    })
    const theirs = await f.booking(team.id, [member.id], '2026-11-04T10:00Z', '2026-11-04T10:30Z', {
      eventTypeId,
    })
    const shared = await f.booking(
      team.id,
      [owner.id, member.id],
      '2026-11-04T11:00Z',
      '2026-11-04T11:30Z',
      {
        eventTypeId,
      },
    )
    // These are hosted by the caller too, but outside the acting team.
    await f.booking(
      owner.principal.organization.id,
      [owner.id],
      '2026-11-05T09:00Z',
      '2026-11-05T09:30Z',
    )
    await f.booking(otherTeam.id, [owner.id], '2026-11-05T10:00Z', '2026-11-05T10:30Z')
    hostIds = [mine, shared]
    teamIds = [mine, theirs, shared]
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: owner.id,
        token,
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    key = (
      await auth.api.createApiKey({
        body: { userId: owner.id, metadata: { organizationId: team.id } },
      })
    ).key
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function withServer<T>(run: (url: string) => Promise<T>, copies?: Factories): Promise<T> {
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      routes: copies
        ? [copies.routes({ db }), teamBookingRoutes({ db })]
        : productRoutes({ db, socialProviders: {}, invitationMailLimits: { secret } }),
      mcp: mcpEndpoint({ tools: copies ? copies.tools({ db }) : productTools({ db }) }),
    })
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      return await run(url)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  }

  async function list(url: string, transport: Transport, cursor?: string): Promise<Page> {
    const input = { limit: 1, ...(cursor && { cursor }) }
    if (transport === 'REST session' || transport === 'REST API key') {
      const response = await fetch(
        `${url}/api/v1/bookings?${new URLSearchParams({ limit: '1', ...(cursor && { cursor }) })}`,
        {
          headers: transport === 'REST session' ? { cookie } : { authorization: `Bearer ${key}` },
        },
      )
      expect(response.status).toBe(200)
      return (await response.json()) as Page
    }
    if (transport === 'MCP') {
      const client = new Client({ name: 'host-scope-regression', version: '1' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        )
        const result = await client.callTool({ name: 'list_bookings', arguments: input })
        expect(result.isError).toBeFalsy()
        return result.structuredContent as Page
      } finally {
        await client.close()
      }
    }
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: ['list', '--input', '-'],
      env: { HOURMERE_URL: url, HOURMERE_API_KEY: key },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
    })
    expect((stdout + stderr).includes(key)).toBe(false)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    return JSON.parse(stdout) as Page
  }

  async function snapshot(url: string, transport: Transport) {
    const ids: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = await list(url, transport, cursor)
      ids.push(...page.data.map((booking) => booking.id))
      if (page.nextCursor === null) return ids
      expect(typeof page.nextCursor).toBe('string')
      cursor = page.nextCursor
    }
    throw new Error('Booking pagination did not terminate')
  }

  async function verifyScope(url: string, transport: Transport) {
    expect(await snapshot(url, transport)).toEqual(hostIds)
  }

  it('keeps exact REST, MCP and CLI result sets before and after an owner reads other members bookings', async () => {
    await withServer(async (url) => {
      const before = new Map<Transport, string[]>()
      for (const transport of transports) {
        const ids = await snapshot(url, transport)
        expect(ids).toEqual(hostIds)
        before.set(transport, ids)
      }
      const response = await fetch(`${url}/api/v1/team/bookings`, { headers: { cookie } })
      expect(response.status).toBe(200)
      const page = (await response.json()) as Page
      expect(page.data.map((booking) => booking.id)).toEqual(teamIds)
      expect(page.nextCursor).toBeNull()
      for (const transport of transports) {
        expect(await snapshot(url, transport)).toEqual(before.get(transport))
      }
    })
  })

  it('passes the HTTP scope assertions with unmodified service, route and tool source copies', async () => {
    const copies = await sourceFactories()
    await withServer(async (url) => {
      for (const transport of transports) await verifyScope(url, transport)
    }, copies)
  })

  it.each([
    ['host', ".where('bh.user_id', '=', ctx.principal.user.id)"],
    ['organization', ".where('b.organization_id', '=', ctx.principal.organization.id)"],
  ])(
    'detects removal of the %s scope in every HTTP listing with real assertion failures',
    async (_, predicate) => {
      // Compile before checking assertions: a loader error cannot count as a killed mutation.
      const copies = await sourceFactories([predicate, ''])
      await withServer(async (url) => {
        for (const transport of transports) {
          await expect(verifyScope(url, transport)).rejects.toThrow(
            expect.objectContaining({ name: 'AssertionError' }),
          )
        }
      }, copies)
    },
  )
})
