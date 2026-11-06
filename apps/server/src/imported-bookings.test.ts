import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { type McpCaller, runTool } from './mcp/tools.ts'
import { bookingRoutes } from './routes/bookings.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')

describe.skipIf(!serverUrl)('imported bookings over REST, MCP and CLI', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  let caller: McpCaller
  let bookingId: string
  let tools: ReturnType<typeof bookingTools>
  const notify = vi.fn()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'import_surfaces' })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    caller = {
      kind: 'api_key',
      apiKeyScope: 'full',
      apiKeyId: randomUUID(),
      user: { id: host.userId, name: 'Host', email: 'host@example.com' },
      organization: { id: host.organizationId, name: '', slug: '', personal: true },
    }
    bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      '2026-11-02T09:00Z',
      '2026-11-02T09:30Z',
      { source: 'import' },
    )
    const deps = { db, now: () => NOW, notify }
    tools = bookingTools(deps)
    app = createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller as Principal, setCookie: [] }),
      routes: [bookingRoutes(deps)],
      mcp: mcpEndpoint({ tools }),
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  const get = (path: string) =>
    app.request(path, { headers: { authorization: 'Bearer synthetic' } })
  const post = (suffix: string, body: unknown) =>
    app.request(`/api/v1/bookings/${bookingId}/${suffix}`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('exposes local-only source and management ownership to REST host reads', async () => {
    const detail = await get(`/api/v1/bookings/${bookingId}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      source: 'import',
      managementPolicy: 'local_only_read_only',
      questions: [],
    })
    const page = await get('/api/v1/bookings')
    expect(((await page.json()) as { data: unknown[] }).data).toEqual([
      expect.objectContaining({
        id: bookingId,
        source: 'import',
        managementPolicy: 'local_only_read_only',
      }),
    ])
  })

  it.each([
    ['cancel', {}],
    ['reschedule', { start: '2026-11-02T10:00:00Z' }],
    ['request-reschedule', { idempotencyKey: crypto.randomUUID() }],
    ['conference/retry', {}],
    ['calendar-copy/retry', {}],
  ])('refuses REST %s without external work', async (suffix, body) => {
    const response = await post(suffix as string, body)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'imported_booking_read_only' })
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    'cancel_booking',
    'reschedule_booking',
    'request_reschedule',
    'retry_conference',
    'retry_calendar_copy',
  ])('refuses MCP %s with the same stable code', async (name) => {
    const tool = tools.find((tool) => tool.name === name)
    if (!tool) throw new Error('Missing booking tool')
    const result = await runTool(
      tool,
      {
        bookingId,
        ...(name === 'request_reschedule' ? { idempotencyKey: crypto.randomUUID() } : {}),
        ...(name === 'reschedule_booking' ? { start: '2026-11-02T10:00:00Z' } : {}),
      },
      { caller, rateLimit: () => {} },
      () => {
        throw new Error('Unexpected tool failure')
      },
    )
    expect(result.isError).toBe(true)
    expect(
      JSON.parse((result.content?.[0] as { text: string } | undefined)?.text ?? 'null'),
    ).toMatchObject({
      error: 'imported_booking_read_only',
    })
    expect(notify).not.toHaveBeenCalled()
  })

  async function cli(command: string, input = {}) {
    let stdout = '',
      stderr = ''
    const code = await runCli({
      argv: [command, '--input', '-'],
      env: { HOURMERE_URL: 'http://localhost:3000', HOURMERE_API_KEY: 'hm_synthetic' },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (input, init) => app.request(input, init),
    })
    return { code, stdout, stderr }
  }
  it('preserves source and policy in CLI machine-readable output', async () => {
    const result = await cli('list')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).data[0]).toMatchObject({
      source: 'import',
      managementPolicy: 'local_only_read_only',
    })
  })
  it.each(['cancel', 'reschedule', 'retry-meeting', 'retry-calendar-copy'])(
    'refuses CLI %s with a secret-free stable error',
    async (command) => {
      const result = await cli(command, {
        bookingId,
        ...(command === 'reschedule' ? { start: '2026-11-02T10:00:00Z' } : {}),
      })
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('imported_booking_read_only')
      expect(result.stderr).not.toContain('invitee@example.com')
      expect(result.stderr).not.toContain('Bearer')
    },
  )
})
