import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { runTool } from './mcp/tools.ts'
import { analyticsRoutes } from './routes/analytics.ts'

const serverUrl = process.env.DATABASE_URL
const range = { startDate: '2026-10-01', endDate: '2026-10-02', timeZone: 'America/New_York' }
const query = new URLSearchParams(range).toString()
const later = () => Temporal.Instant.from('2026-12-01T00:00:00Z')
const credentials = [
  { kind: 'session', sessionId: 'test' },
  ...(['read', 'bookings', 'full'] as const).map((apiKeyScope) => ({
    kind: 'api_key' as const,
    apiKeyScope,
    apiKeyId: 'test',
  })),
  { kind: 'oauth', oauthConsentId: 'test', clientId: 'test', scopes: ['mcp:tools'] },
] as const

describe.skipIf(!serverUrl)('no-show activity through REST, MCP and CLI', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  let caller: Principal
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'noshow_parity' })
    db = createDb(owned.pool)
    const deps = { db, now: later }
    app = createApp({
      publicUrl: 'http://localhost:4186',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
      routes: [analyticsRoutes(deps)],
      mcp: mcpEndpoint({
        tools: bookingTools(deps),
        oauth: {
          resolve: async () =>
            caller.kind === 'oauth'
              ? { ok: true, principal: caller }
              : { ok: false, error: 'invalid_token' },
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function cli(input: unknown) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: ['booking-activity', '--input', '-'],
      env: { HOURMERE_URL: 'http://localhost:4186', HOURMERE_API_KEY: 'hm_synthetic' },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (url, init) => {
        if (caller.kind !== 'oauth') return app.request(url, init)
        const headers = new Headers(init?.headers)
        headers.set('authorization', 'Bearer synthetic.oauth.token')
        return app.request(url, { ...init, headers })
      },
    })
    return { code, stdout, stderr }
  }
  const tool = () => {
    const found = bookingTools({ db, now: later }).find(
      (candidate) => candidate.name === 'get_booking_activity',
    )
    if (!found) throw new Error('Missing get_booking_activity')
    return found
  }
  // The marking service and its permissions are covered with the scheduling package; here a
  // stored marker is enough to compare the three read surfaces.
  async function marked(org: string, host: TestUser, start: string) {
    const booking = await createFixtures(db).booking(
      org,
      [host.id],
      start,
      Temporal.Instant.from(start).add({ minutes: 30 }).toString(),
    )
    await db
      .updateTable('booking_attendees')
      .set({ no_show_marked_at: '2026-11-01T00:00:00Z', no_show_marked_by: host.id })
      .where('booking_id', '=', booking)
      .execute()
  }

  it('returns the same no-show count everywhere and denies the same callers', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    // 2026-10-01T03:30Z is still 2026-09-30 in New York: outside the report.
    await marked(team.id, member, '2026-10-01T03:30:00Z')
    await marked(team.id, member, '2026-10-01T04:30:00Z')
    await marked(owner.principal.organization.id, owner, '2026-10-02T15:00:00Z')
    const teamReport = {
      ...range,
      totals: { created: 0, rescheduled: 0, cancelled: 0, noShows: 1 },
      data: [
        { date: '2026-10-01', created: 0, rescheduled: 0, cancelled: 0, noShows: 1 },
        { date: '2026-10-02', created: 0, rescheduled: 0, cancelled: 0, noShows: 0 },
      ],
    }
    const personalReport = {
      ...range,
      totals: { created: 0, rescheduled: 0, cancelled: 0, noShows: 1 },
      data: [
        { date: '2026-10-01', created: 0, rescheduled: 0, cancelled: 0, noShows: 0 },
        { date: '2026-10-02', created: 0, rescheduled: 0, cancelled: 0, noShows: 1 },
      ],
    }
    const actors = [
      { principal: owner.principal, report: personalReport },
      { principal: team.as(owner), report: teamReport },
      { principal: team.as(admin), report: teamReport },
      { principal: team.as(member), report: null },
    ]
    for (const actor of actors)
      for (const credential of credentials) {
        caller = { ...actor.principal, ...credential } as Principal
        const label = `${actor.principal.organization.personal ? 'personal' : 'team'}/${caller.user.id === member.id ? 'member' : 'manager'}/${credential.kind}${'apiKeyScope' in credential ? `:${credential.apiKeyScope}` : ''}`
        const scopeDenied = credential.kind === 'api_key' && credential.apiKeyScope === 'bookings'
        const error = scopeDenied
          ? 'insufficient_scope'
          : actor.report === null
            ? 'insufficient_role'
            : undefined
        // OAuth grants authenticate MCP only.
        if (credential.kind !== 'oauth') {
          const headers =
            credential.kind === 'session'
              ? { origin: 'http://localhost:4186' }
              : { authorization: 'Bearer synthetic' }
          const response = await app.request(`/api/v1/analytics/bookings?${query}`, { headers })
          expect(response.status, label).toBe(error ? 403 : 200)
          const body = await response.json()
          if (error) expect(body, label).toMatchObject({ error })
          else expect(body, label).toEqual(actor.report)
        }
        const agent = caller
        if (agent.kind === 'session') continue
        const result = await runTool(tool(), range, { caller: agent, rateLimit: () => {} }, () => {
          throw new Error('Unexpected MCP tool error')
        })
        expect(result.isError === true, label).toBe(error !== undefined)
        if (error)
          expect(result.content, label).toEqual([
            { type: 'text', text: expect.stringContaining(error) },
          ])
        else expect(result.structuredContent, label).toEqual(actor.report)
        const command = await cli(range)
        expect(command.code, label).toBe(error ? 1 : 0)
        if (error) expect(JSON.parse(command.stderr), label).toMatchObject({ error })
        else expect(JSON.parse(command.stdout), label).toEqual(actor.report)
      }
  })

  it('refuses an organization override and an unbounded range on every surface', async () => {
    const owner = await createTestUser(db)
    const other = await createTestUser(db)
    const key = {
      ...owner.principal,
      kind: 'api_key' as const,
      apiKeyScope: 'read' as const,
      apiKeyId: 'test',
    }
    caller = key
    const headers = { authorization: 'Bearer synthetic' }
    for (const input of [
      { ...range, organizationId: other.principal.organization.id },
      { ...range, endDate: '2027-01-01' },
    ]) {
      const rest = await app.request(`/api/v1/analytics/bookings?${new URLSearchParams(input)}`, {
        headers,
      })
      expect(rest.status).toBe(400)
      const result = await runTool(tool(), input, { caller: key, rateLimit: () => {} }, () => {
        throw new Error('Unexpected MCP tool error')
      })
      expect(result.isError).toBe(true)
      const command = await cli(input)
      expect(command.code).toBe(1)
      expect(command.stdout).toBe('')
    }
  })
})
