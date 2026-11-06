import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { inspect } from 'node:util'
import { z } from '@hono/zod-openapi'
import * as auth from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { type McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp, hasUnsafeJsonText } from '../app.ts'
import { redactOneTimeLogDetails } from '../one-time-link-privacy.ts'
import * as schemas from '../routes/one-time-links.ts'
import { mcpEndpoint } from './endpoint.ts'
import { oneTimeLinkTools } from './one-time-links.ts'
import {
  defineTool,
  type McpCaller,
  prepareTools,
  registerTools,
  runTool,
  type Tool,
} from './tools.ts'

type Change = readonly [string, string]
const TOKEN = 'synthetic_one_time_capability_sentinel_1234'
const HASH = 'synthetic_secret_hash'.repeat(4)
const PUBLIC_URL = 'https://hourmere.example'
const full: Extract<McpCaller, { kind: 'api_key' }> = {
  kind: 'api_key',
  apiKeyScope: 'full',
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Link host', email: 'host@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'link-host', personal: true },
}
const oauth: Extract<McpCaller, { kind: 'oauth' }> = {
  kind: 'oauth',
  user: full.user,
  organization: full.organization,
  oauthConsentId: randomUUID(),
  clientId: 'link-client',
  scopes: ['mcp:tools'],
}
const link: scheduling.OneTimeBookingLink = {
  id: randomUUID(),
  organizationId: full.organization.id,
  eventTypeId: randomUUID(),
  creatorUserId: full.user.id,
  creatorDisplayName: full.user.name,
  expiresAt: null,
  prefill: { name: null, email: null },
  state: 'active',
  bookingId: null,
  usedAt: null,
  revokedAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}
const args = {
  eventTypeId: link.eventTypeId,
  idempotencyKey: randomUUID(),
  prefill: { email: 'invitee@example.test' },
}
function compile<T>(
  file: string,
  name: string,
  bindings: Record<string, unknown>,
  change?: Change,
): T {
  let source = readFileSync(file, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(...Object.keys(bindings), `${source}; return ${name}`)(
    ...Object.values(bindings),
  ) as T
}
function factory(change?: Change, routeChange?: Change) {
  const create = vi.fn(async () => ({ ...link, token: TOKEN }))
  const list = vi.fn(async () => ({
    data: [{ ...link, token: TOKEN, token_hash: HASH, url: `${PUBLIC_URL}/book/${TOKEN}` }],
    nextAfter: null,
  }))
  const revoke = vi.fn(async () => ({
    ...link,
    state: 'revoked' as const,
    token: TOKEN,
    token_hash: HASH,
    url: `${PUBLIC_URL}/book/${TOKEN}`,
  }))
  const build = compile<typeof oneTimeLinkTools>(
    'apps/server/src/mcp/one-time-links.ts',
    'oneTimeLinkTools',
    {
      z,
      ...scheduling,
      ...schemas,
      ...(routeChange
        ? {
            CreateOneTimeLink: compile<typeof schemas.CreateOneTimeLink>(
              'apps/server/src/routes/one-time-links.ts',
              'CreateOneTimeLink',
              { z, ...scheduling, CROSS_ORIGIN_WRITE: 'cross_origin_write' },
              routeChange,
            ),
          }
        : {}),
      defineTool,
      createOneTimeBookingLink: create,
      listOneTimeBookingLinks: list,
      revokeManagedOneTimeBookingLink: revoke,
    },
    change,
  )
  return { tools: build({ db: {} as Db, publicUrl: PUBLIC_URL }), create, list, revoke }
}
function framework<T>(name: string, change?: Change): T {
  return compile<T>(
    'apps/server/src/mcp/tools.ts',
    name,
    {
      z,
      ...auth,
      DomainError: scheduling.DomainError,
      WaitlistRateLimitError: scheduling.WaitlistRateLimitError,
      inspect,
      hasUnsafeJsonText,
      redactOneTimeLogDetails,
      ProtocolError,
      ProtocolErrorCode,
    },
    change,
  )
}
const call = (tool: Tool, input: unknown, caller: McpCaller = full, logger = vi.fn()) =>
  runTool(tool, input, { caller, rateLimit: () => {} }, logger)
function body(result: Awaited<ReturnType<typeof runTool>>) {
  const first = result.content[0]
  if (first?.type !== 'text') throw Error('Expected text response')
  return JSON.parse(first.text)
}
async function verifyForwarding(change?: Change) {
  const { tools, create, list, revoke } = factory(change)
  const created = await call(tools[0] as Tool, args)
  expect(created.isError).toBeFalsy()
  expect((created.structuredContent as { url: string }).url === `${PUBLIC_URL}/book/${TOKEN}`).toBe(
    true,
  )
  expect(created.structuredContent).not.toHaveProperty('token')
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ principal: full }), args)
  const listArgs = { eventTypeId: link.eventTypeId, limit: 12 }
  const listed = await call(tools[1] as Tool, listArgs)
  expect(listed.isError).toBeFalsy()
  expect(list).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ principal: full }),
    listArgs,
  )
  expect(JSON.stringify(listed).includes(TOKEN)).toBe(false)
  expect(JSON.stringify(listed).includes(HASH)).toBe(false)
  expect(listed.structuredContent).toEqual({ data: [link], nextAfter: null })
  const revokeArgs = { eventTypeId: link.eventTypeId, id: link.id }
  const revoked = await call(tools[2] as Tool, revokeArgs)
  expect(revoked.structuredContent).toEqual({ link: { ...link, state: 'revoked' } })
  expect(revoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ principal: full }),
    revokeArgs,
  )
}
async function verifyOAuth(runner = runTool) {
  const { tools, create, list, revoke } = factory()
  for (const [tool, input] of [
    [tools[0], args],
    [tools[1], { eventTypeId: link.eventTypeId }],
    [tools[2], { eventTypeId: link.eventTypeId, id: link.id }],
  ] as const) {
    const result = await runner(
      tool as Tool,
      input,
      { caller: oauth, rateLimit: () => {} },
      vi.fn(),
    )
    expect(result.isError).toBeFalsy()
  }
  for (const service of [create, list, revoke]) expect(service).toHaveBeenCalledTimes(1)
}
async function verifyScopes(runner = runTool) {
  const { tools, create, list, revoke } = factory()
  for (const tool of tools) {
    const apiKeyScope = tool.name === 'list_one_time_links' ? 'bookings' : 'read'
    const result = await runner(
      tool,
      {},
      { caller: { ...full, apiKeyScope }, rateLimit: () => {} },
      vi.fn(),
    )
    expect(body(result).error).toBe('insufficient_scope')
  }
  for (const service of [create, list, revoke]) expect(service).not.toHaveBeenCalled()
}
async function verifyDiagnostics(change?: Change, index = 0) {
  const { tools, create, list, revoke } = factory(change)
  const logger = vi.fn()
  const service = [create, list, revoke][index]
  service?.mockRejectedValueOnce(
    new scheduling.DomainError('invalid', 'invalid_one_time_link', `${TOKEN} ${HASH}`, {
      cause: Error(`${TOKEN} ${HASH}`),
    }),
  )
  const input =
    index === 0
      ? args
      : index === 1
        ? { eventTypeId: link.eventTypeId }
        : { eventTypeId: link.eventTypeId, id: link.id }
  const result = await call(tools[index] as Tool, input, full, logger)
  expect(body(result)).toEqual({ error: 'invalid_one_time_link' })
  expect(logger).toHaveBeenCalledTimes(1)
  expect(logger.mock.calls.map(String).join(' ').includes(TOKEN)).toBe(false)
  expect(logger.mock.calls.map(String).join(' ').includes(HASH)).toBe(false)
}
function verifyStrictInputs(change?: Change) {
  const { tools } = factory(change)
  for (const [index, input] of [
    [0, args],
    [1, { eventTypeId: link.eventTypeId }],
    [2, { eventTypeId: link.eventTypeId, id: link.id }],
  ] as const) {
    const tool = tools[index] as Tool
    expect(tool.input.safeParse(input).success).toBe(true)
    expect(tool.input.safeParse({ ...input, [TOKEN]: 'unknown' }).success).toBe(false)
  }
}
function verifyListBounds(change?: Change) {
  const tool = factory(change).tools[1] as Tool
  for (const limit of [
    scheduling.ONE_TIME_LINK_PAGE_MIN - 1,
    scheduling.ONE_TIME_LINK_PAGE_MAX + 1,
    1.5,
    '2',
  ])
    expect(tool.input.safeParse({ eventTypeId: link.eventTypeId, limit }).success).toBe(false)
  expect(
    tool.input.safeParse({
      eventTypeId: link.eventTypeId,
      limit: scheduling.ONE_TIME_LINK_PAGE_MAX,
    }).success,
  ).toBe(true)
  expect(z.toJSONSchema(tool.input, { io: 'input' }).properties?.limit).toMatchObject({
    type: 'integer',
    minimum: scheduling.ONE_TIME_LINK_PAGE_MIN,
    maximum: scheduling.ONE_TIME_LINK_PAGE_MAX,
  })
}
async function verifyDiscovery(register = registerTools) {
  const names: string[] = []
  let dispatch:
    | ((request: { params: { name: string; arguments: unknown } }) => Promise<unknown>)
    | undefined
  const server = {
    registerTool(name: string) {
      names.push(name)
    },
    server: {
      setRequestHandler(_method: string, callback: typeof dispatch) {
        dispatch = callback
      },
      projectCallToolResult(result: unknown) {
        return result
      },
    },
  } as unknown as McpServer
  const { tools } = factory()
  register(server, prepareTools(tools), { ...full, apiKeyScope: 'read' }, vi.fn())
  expect(names).toEqual(['list_one_time_links'])
  for (const name of ['create_one_time_link', 'revoke_one_time_link']) {
    let result: Awaited<ReturnType<typeof runTool>> | undefined
    let failure: unknown
    try {
      result = (await dispatch?.({ params: { name, arguments: {} } })) as Awaited<
        ReturnType<typeof runTool>
      >
    } catch (error) {
      failure = error
    }
    expect(failure).toBeUndefined()
    if (!result) throw Error('Missing scope result')
    expect(body(result).error).toBe('insufficient_scope')
  }
}

describe('one-time link MCP adapters and security mutations', () => {
  it('uses shared services and returns the secret only with creation metadata', () =>
    verifyForwarding())
  it('keeps existing OAuth scheduling write access and resource authorization', () => verifyOAuth())
  it('hides disallowed writes from read keys and denies known direct calls', () =>
    verifyDiscovery())
  it.each([0, 1, 2])(
    'tool %s does not leak secrets or hashes through errors and captured logs',
    (index) => verifyDiagnostics(undefined, index),
  )
  it.each(['create_one_time_link', 'list_one_time_links', 'revoke_one_time_link'])(
    'enforces %s scopes before validation or services',
    async (name) => {
      const { tools, create, list, revoke } = factory()
      const tool = tools.find((item) => item.name === name) as Tool
      for (const apiKeyScope of name === 'list_one_time_links'
        ? (['bookings'] as const)
        : (['read'] as const)) {
        const result = await call(tool, {}, { ...full, apiKeyScope })
        expect(body(result).error).toBe('insufficient_scope')
      }
      for (const service of [create, list, revoke]) expect(service).not.toHaveBeenCalled()
    },
  )
  it('keeps strict inputs and the same expiry/prefill fields as REST', () => {
    verifyStrictInputs()
    verifyListBounds()
    const { tools } = factory()
    const create = tools[0] as Tool
    expect(
      create.input.safeParse({
        ...args,
        expiresAt: '2030-11-03T01:30:00-07:00',
        prefill: { name: 'Invitee' },
      }).success,
    ).toBe(true)
    for (const input of [
      { eventTypeId: link.eventTypeId },
      { ...args, idempotencyKey: 'space key' },
      { ...args, prefill: { extra: TOKEN } },
      { ...args, [TOKEN]: 'unknown' },
    ])
      expect(create.input.safeParse(input).success).toBe(false)
  })
  function verifyPrefillDiscovery(routeChange?: Change) {
    const prepared = prepareTools(factory(undefined, routeChange).tools)[0]
    const input = prepared?.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    expect(input).toMatchObject({
      properties: {
        prefill: {
          properties: {
            name: { maxLength: scheduling.ONE_TIME_LINK_PREFILL_NAME_MAX },
            email: { maxLength: scheduling.ONE_TIME_LINK_PREFILL_EMAIL_MAX },
          },
        },
      },
    })
  }
  it('advertises service prefill maxima in MCP discovery', () => verifyPrefillDiscovery())
  it.each(['NAME', 'EMAIL'])(
    'kills removal of scoped %s prefill metadata from MCP discovery',
    (field) => {
      expect(() =>
        verifyPrefillDiscovery([`.meta({ maxLength: ONE_TIME_LINK_PREFILL_${field}_MAX })`, '']),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    },
  )
  it('exercises unchanged source copies', async () => {
    await verifyForwarding()
    await verifyOAuth(framework<typeof runTool>('runTool'))
    await verifyScopes(framework<typeof runTool>('runTool'))
    await verifyDiscovery(framework<typeof registerTools>('registerTools'))
    await verifyDiagnostics()
    verifyStrictInputs()
    verifyListBounds()
  })
  it.each([
    [
      'creation diagnostics privacy',
      [
        'output: CreatedOneTimeLink,\n      privateInput: () => true',
        'output: CreatedOneTimeLink,\n      privateInput: () => false',
      ],
      verifyDiagnostics,
    ],
    [
      'listing diagnostics privacy',
      [
        'output: OneTimeLinkList,\n      privateInput: () => true',
        'output: OneTimeLinkList,\n      privateInput: () => false',
      ],
      (change: Change) => verifyDiagnostics(change, 1),
    ],
    [
      'revocation diagnostics privacy',
      [
        'output: z.object({ link: OneTimeLink.nullable() }),\n      privateInput: () => true',
        'output: z.object({ link: OneTimeLink.nullable() }),\n      privateInput: () => false',
      ],
      (change: Change) => verifyDiagnostics(change, 2),
    ],
    [
      'list output metadata filter',
      ['output: OneTimeLinkList,', 'output: z.any(),'],
      verifyForwarding,
    ],
    [
      'revoke output metadata filter',
      [
        'output: z.object({ link: OneTimeLink.nullable() }),',
        'output: z.object({ link: z.any() }),',
      ],
      verifyForwarding,
    ],
    [
      'create service dispatch',
      [
        'await createOneTimeBookingLink(context(call.caller), args)',
        'await createOneTimeBookingLink(context(call.caller), { ...args, eventTypeId: "wrong" })',
      ],
      verifyForwarding,
    ],
  ] as const)('kills removed %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(change)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills bypassing scope checks in direct tool execution', async () => {
    await expect(
      verifyScopes(
        framework<typeof runTool>('runTool', [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
          'requireApiKeyOperation(call.caller, `mcp:${tool.name}`)',
          'void 0',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each([
    [
      'list',
      [
        'limit: z.number().int().min(ONE_TIME_LINK_PAGE_MIN).max(ONE_TIME_LINK_PAGE_MAX).optional(),\n      }).strict()',
        'limit: z.number().int().min(ONE_TIME_LINK_PAGE_MIN).max(ONE_TIME_LINK_PAGE_MAX).optional(),\n      }).strip()',
      ],
    ],
    [
      'revoke',
      [
        'input: z.strictObject({ eventTypeId, id: z.uuid() })',
        'input: z.object({ eventTypeId, id: z.uuid() })',
      ],
    ],
  ] as const)('kills accepting unknown %s input fields', (_name, change) => {
    expect(() => verifyStrictInputs(change)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('kills removal of bounded list pages', () => {
    expect(() =>
      verifyListBounds([
        '.int().min(ONE_TIME_LINK_PAGE_MIN).max(ONE_TIME_LINK_PAGE_MAX).optional()',
        '.int().min(1).optional()',
      ]),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it.each([
    [
      'discovery',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
      ['if (!apiKeyAllows(caller, `mcp:${tool.name}`)) continue', 'if (false) continue'],
    ],
    [
      'hidden known dispatch',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
      ['if (known && !apiKeyAllows(caller, `mcp:${known.tool.name}`))', 'if (false)'],
    ],
  ] as const)('kills bypassing scope %s filtering', async (_name, change) => {
    await expect(
      verifyDiscovery(framework<typeof registerTools>('registerTools', change)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})

const bootstrap = process.env.DATABASE_URL
describe.skipIf(!bootstrap)('one-time link MCP and CLI with PostgreSQL', () => {
  let owned: Awaited<ReturnType<typeof createTestDatabase>>
  let db: Db
  let authPool: ReturnType<typeof auth.createAuthPool>
  let instance: ReturnType<typeof createApp>
  let keys: Record<'full' | 'read' | 'bookings', string>
  let eventTypeId: string
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = auth.createAuthPool(owned.url, signup)
    const authentication = auth.createAuth({
      pool: authPool,
      db,
      baseURL: PUBLIC_URL,
      secret: randomBytes(32).toString('base64'),
      signup,
      mailer: {
        send: async () => {
          throw Error('Mail forbidden')
        },
      },
    })
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ name: 'Link host', handle: 'one-time-mcp' })
    eventTypeId = await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro',
      durationMinutes: 30,
    })
    keys = {} as typeof keys
    for (const scope of ['full', 'read', 'bookings'] as const)
      keys[scope] = (
        await authentication.api.createApiKey({
          body: { userId: host.userId, metadata: { scope } },
        })
      ).key
    instance = createApp({
      publicUrl: PUBLIC_URL,
      checkDb: async () => {},
      authHandler: authentication.handler,
      resolveCaller: auth.createCallerResolver({ auth: authentication, db }),
      mcp: mcpEndpoint({ tools: oneTimeLinkTools({ db, publicUrl: PUBLIC_URL }) }),
    })
  }, 30_000)
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })
  async function rpc(tool: string, input: unknown, scope: keyof typeof keys = 'full') {
    const response = await instance.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${keys[scope]}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': tool,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: input,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const message = JSON.parse(
      text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? text,
    )
    return message.result as Awaited<ReturnType<typeof runTool>>
  }
  it('accepts service maxima and rejects maximum plus one for pages and prefill', async () => {
    for (const extra of [0, 1]) {
      const result = await rpc('list_one_time_links', {
        eventTypeId,
        limit: scheduling.ONE_TIME_LINK_PAGE_MAX + extra,
      })
      expect(Boolean(result.isError)).toBe(extra === 1)
    }
    for (const [field, maximum] of [
      ['name', scheduling.ONE_TIME_LINK_PREFILL_NAME_MAX],
      ['email', scheduling.ONE_TIME_LINK_PREFILL_EMAIL_MAX],
    ] as const) {
      for (const extra of [0, 1]) {
        const value =
          field === 'name'
            ? 'n'.repeat(maximum + extra)
            : `${'e'.repeat(maximum + extra - '@example.test'.length)}@example.test`
        const result = await rpc('create_one_time_link', {
          eventTypeId,
          idempotencyKey: randomUUID(),
          prefill: { [field]: value },
        })
        expect(Boolean(result.isError)).toBe(extra === 1)
        if (extra === 0) {
          const created = result.structuredContent as scheduling.OneTimeBookingLink
          await rpc('revoke_one_time_link', { eventTypeId, id: created.id })
          await db.deleteFrom('one_time_booking_links').where('id', '=', created.id).execute()
        }
      }
    }
  })
  it('creates once, lists metadata without capabilities, and revokes idempotently', async () => {
    const input = {
      eventTypeId,
      idempotencyKey: randomUUID(),
      expiresAt: '2030-11-03T01:30:00-07:00',
      prefill: { name: 'Invitee', email: 'INVITEE@example.test' },
    }
    const loggers = (['debug', 'log', 'info', 'warn', 'error'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    )
    try {
      const created = await rpc('create_one_time_link', input)
      expect(created.isError).toBeFalsy()
      const data = created.structuredContent as scheduling.OneTimeBookingLink & { url: string }
      const token = new URL(data.url).pathname.split('/')[2] as string
      expect(token.length).toBe(43)
      expect(data.expiresAt).toBe('2030-11-03T08:30:00.000Z')
      expect(data.prefill).toEqual({ name: 'Invitee', email: 'invitee@example.test' })
      expect(body(await rpc('create_one_time_link', input)).error).toBe(
        'one_time_link_already_created',
      )
      const stored = await db
        .selectFrom('one_time_booking_links')
        .selectAll()
        .where('id', '=', data.id)
        .executeTakeFirstOrThrow()
      const listed = await rpc('list_one_time_links', { eventTypeId }, 'read')
      const listedText = JSON.stringify(listed)
      expect(listedText.includes(token)).toBe(false)
      expect(listedText.includes(stored.token_hash)).toBe(false)
      expect(listed.structuredContent).toMatchObject({ data: [{ id: data.id, state: 'active' }] })
      for (let i = 0; i < 2; i++)
        expect(
          (await rpc('revoke_one_time_link', { eventTypeId, id: data.id })).structuredContent,
        ).toMatchObject({ link: { state: 'revoked' } })
      expect(
        await db
          .selectFrom('one_time_booking_links')
          .select('id')
          .where('event_type_id', '=', eventTypeId)
          .execute(),
      ).toHaveLength(1)
      const logs = loggers
        .flatMap((logger) => logger.mock.calls)
        .map(String)
        .join(' ')
      expect(logs.includes(token)).toBe(false)
      expect(logs.includes(stored.token_hash)).toBe(false)
    } finally {
      for (const logger of loggers) logger.mockRestore()
    }
  })
  it.each(['full', 'read', 'bookings'] as const)(
    '%s enforces each tool before services using real credentials',
    async (scope) => {
      const input = { eventTypeId, idempotencyKey: randomUUID() }
      const created = await rpc('create_one_time_link', input, scope)
      if (scope !== 'read') expect(created.isError).toBeFalsy()
      else expect(body(created).error).toBe('insufficient_scope')
      const listed = await rpc('list_one_time_links', { eventTypeId }, scope)
      if (scope === 'bookings') expect(body(listed).error).toBe('insufficient_scope')
      else expect(listed.isError).toBeFalsy()
      const revoked = await rpc('revoke_one_time_link', { eventTypeId, id: randomUUID() }, scope)
      if (scope !== 'read') expect(revoked.structuredContent).toEqual({ link: null })
      else expect(body(revoked).error).toBe('insufficient_scope')
    },
  )
  it('runs nested CLI commands through MCP and PostgreSQL without storing a URL', async () => {
    const idempotencyKey = randomUUID()
    async function cli(command: string, input: Record<string, unknown>) {
      let stdout = ''
      let stderr = ''
      const code = await runCli({
        argv: ['one-time-links', command, '--input', '-'],
        env: { HOURMERE_URL: PUBLIC_URL, HOURMERE_API_KEY: keys.full },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch: async (input, init) => instance.request(input, init),
      })
      expect((stdout + stderr).includes(keys.full)).toBe(false)
      return { code, stdout, stderr }
    }
    const created = await cli('create', { eventTypeId, idempotencyKey })
    expect(created.code).toBe(0)
    const data = JSON.parse(created.stdout)
    const token = new URL(data.url).pathname.split('/')[2] as string
    expect(created.stdout.split(token).length - 1).toBe(1)
    const listed = await cli('list', { eventTypeId })
    expect(listed.code).toBe(0)
    expect(listed.stdout.includes(token)).toBe(false)
    const revoked = await cli('revoke', { eventTypeId, id: data.id })
    expect(revoked.code).toBe(0)
    expect(JSON.parse(revoked.stdout)).toMatchObject({ link: { state: 'revoked' } })
    const duplicate = await cli('create', { eventTypeId, idempotencyKey })
    expect(duplicate.code).toBe(1)
    expect(JSON.parse(duplicate.stderr).error).toBe('one_time_link_already_created')
    expect((duplicate.stdout + duplicate.stderr).includes(token)).toBe(false)
  })
})
