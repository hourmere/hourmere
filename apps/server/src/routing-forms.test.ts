// The routing-forms hard-off guard (docs/routing-forms.md, Rollout gating and step a1b): the
// code constant in server composition, the shared REST guard and its order, the MCP
// registration helper, the effective state at /instance, and that no environment setting
// changes any of it. Every route and tool named `test-only-routing…` / `test_only_routing…`
// is defined in this file only; production composition never registers one.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createRoute, z } from '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { MiddlewareHandler } from 'hono'
import { every } from 'hono/combine'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { callTool } from '../../../tools/cli/src/client.ts'
import { createApp } from './app.ts'
import { routeBodyLimit } from './body-limit.ts'
import { loadConfig } from './config.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { defineTool, type Tool } from './mcp/tools.ts'
import { authenticated, json, type RouteModule } from './openapi.ts'
import { createRateLimiter, rateLimit } from './rate-limit.ts'
import { featureGate } from './rest-scopes.ts'
import { requireRoutingFormsEnabled, routingFormsGuard, routingFormTools } from './routing-forms.ts'
import * as server from './server.ts'

async function sourceCopy<T>(file: string, mutation?: [string, string]): Promise<T> {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0])).toBe(true)
    source = source.replace(...mutation)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

/** The module native source copies import for `file`: the same instance they share. */
function nativeModule<T>(file: string): Promise<T> {
  const location = new URL(file, import.meta.url).href
  return import(
    `data:text/javascript;base64,${Buffer.from(`export * from '${location}'`).toString('base64')}`
  )
}

afterEach(() => vi.unstubAllEnvs())

// The operator setting e4c will introduce, and the option name, in the environment.
function stubRoutingEnvironment() {
  for (const name of ['ROUTING_FORMS_ENABLED', 'routingFormsEnabled']) vi.stubEnv(name, 'true')
}

// What a caller can pass at run time despite the boolean type. Only `true` enables.
const NOT_TRUE: unknown[] = [
  false,
  undefined,
  null,
  'true',
  'TRUE',
  ' true',
  '1',
  'on',
  '',
  1,
  -1,
  0,
  Number.NaN,
  Object(true),
  { valueOf: () => true },
  { toString: () => 'true' },
  Object.create({ routingFormsEnabled: true }),
  () => true,
  Symbol('true'),
  // Prototype keys: a lookup-table guard would resolve them to Object.prototype members.
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  Object.prototype,
  // Arrays: repeated query keys and JSON bodies arrive this way.
  [],
  [true],
  ['true'],
]
// The HTTP-level checks run a representative subset; the guard function gets every value.
const NOT_TRUE_SAMPLE: unknown[] = [
  false,
  undefined,
  'true',
  1,
  Object(true),
  'constructor',
  [true],
]

const PUBLIC_URL = 'https://routing-guard.example'
const base = {
  publicUrl: PUBLIC_URL,
  checkDb: async () => {},
  authHandler: async () => new Response(null, { status: 404 }),
}
const user = { id: randomUUID(), name: 'Routing guard', email: 'routing-guard@example.test' }
const organization = { id: randomUUID(), name: 'Routing guard', slug: 'routing', personal: true }
const session: Principal = { kind: 'session', sessionId: randomUUID(), user, organization }
const apiKey = (apiKeyScope: ApiKeyScope): Principal => ({
  kind: 'api_key',
  apiKeyId: randomUUID(),
  apiKeyScope,
  user,
  organization,
})
const keys = { full: apiKey('full'), read: apiKey('read'), bookings: apiKey('bookings') }
// hm_full, hm_read and hm_bookings are valid keys of that scope, hm_limited is over its
// rate limit, the session cookie is valid, and anything else is an invalid credential.
const resolveCaller: CallerResolver = async (headers) => {
  const authorization = headers.get('authorization')
  if (authorization === 'Bearer hm_limited')
    return { ok: false, error: 'rate_limited', retryAfterSeconds: 9, setCookie: [] }
  const scope = /^Bearer hm_(full|read|bookings)$/.exec(authorization ?? '')?.[1]
  if (scope === 'full' || scope === 'read' || scope === 'bookings')
    return { ok: true, principal: keys[scope], setCookie: [] }
  if (authorization === null && headers.get('cookie') === 'routing-session=valid')
    return { ok: true, principal: session, setCookie: [] }
  return { ok: false, error: 'unauthorized', setCookie: [] }
}
const unauthorized: CallerResolver = async () => ({
  ok: false,
  error: 'unauthorized',
  setCookie: [],
})

const DISABLED = '{"error":"routing_forms_disabled"}'

describe('the routing-forms switch', () => {
  function verifyGuardFunction(guard = requireRoutingFormsEnabled) {
    expect(() => guard(true)).not.toThrow()
    for (const value of NOT_TRUE) {
      let thrown: unknown
      try {
        guard(value as boolean)
      } catch (err) {
        thrown = err
      }
      // Compared by shape, so a native source copy's DomainError class matches too.
      expect(thrown, String(value)).toMatchObject({
        name: 'DomainError',
        kind: 'not_found',
        code: 'routing_forms_disabled',
        detail: undefined,
      })
    }
  }

  it('enables only for the boolean true and refuses everything else with one code', () => {
    verifyGuardFunction()
  })

  it('detects a bypassed or truthy guard with real assertions', async () => {
    const control = await sourceCopy<typeof import('./routing-forms.ts')>('./routing-forms.ts')
    verifyGuardFunction(control.requireRoutingFormsEnabled)
    for (const mutation of [
      ["throw new DomainError('not_found', 'routing_forms_disabled')", 'return'],
      ['routingFormsEnabled !== true', '!routingFormsEnabled'],
      ['routingFormsEnabled !== true', 'routingFormsEnabled === false'],
      ["'routing_forms_disabled'", "'not_found'"],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof import('./routing-forms.ts')>(
        './routing-forms.ts',
        mutation,
      )
      expect(() => verifyGuardFunction(mutant.requireRoutingFormsEnabled)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
  })
})

// Test-only REST operations standing in for the routing operations later steps add: an
// authenticated form-manager write and an anonymous public read, both unclassified as new
// operations are until their owning step, and one borrowing the method and path of an
// existing operation classified for full-scope keys only (`PATCH /api/v1/branding`), so the
// API-key scope check the guard must precede is a real denial. Each registers only on the
// test app below; `effects` stands for every lookup and write after the guard.
type RateLimits = Pick<typeof import('./rate-limit.ts'), 'createRateLimiter' | 'rateLimit'>
function guardedRoutes(
  guard: MiddlewareHandler,
  effects: () => void,
  publicLimit: number,
  // From the module graph of the app under test, whose registration recognises them.
  limits: RateLimits = { createRateLimiter, rateLimit },
): RouteModule {
  const reached = {
    200: { description: 'Reached', content: json(z.object({ ok: z.literal(true) })) },
  }
  const body = { content: json(z.strictObject({ name: z.string().max(20) })), required: true }
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/test-only-routing/{id}',
        security: authenticated,
        middleware: [caller, guard],
        request: { params: z.object({ id: z.uuid() }), body },
        responses: reached,
      }),
      (c) => {
        effects()
        return c.json({ ok: true as const }, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/branding',
        security: authenticated,
        middleware: [caller, guard],
        request: { body },
        responses: reached,
      }),
      (c) => {
        effects()
        return c.json({ ok: true as const }, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/public/-/test-only-routing/{handle}/{slug}',
        middleware: [
          limits.rateLimit(limits.createRateLimiter({ limit: publicLimit, windowSeconds: 600 })),
          guard,
        ],
        request: {
          params: z.object({
            handle: z.string().regex(/^[a-z]{1,20}$/),
            slug: z.string().regex(/^[a-z]{1,20}$/),
          }),
        },
        responses: reached,
      }),
      (c) => {
        effects()
        return c.json({ ok: true as const }, 200)
      },
    )
  }
}

type Credential = 'session' | 'full' | 'read' | 'bookings' | 'anonymous'
const credentialHeaders: Record<Credential, Record<string, string>> = {
  // Cookie-authenticated writes come from the app itself.
  session: { cookie: 'routing-session=valid', origin: PUBLIC_URL },
  full: { authorization: 'Bearer hm_full' },
  read: { authorization: 'Bearer hm_read' },
  bookings: { authorization: 'Bearer hm_bookings' },
  anonymous: {},
}
interface Probe {
  name: string
  path: string
  init: RequestInit
  /** The status when routing is on; with it off every probe gets the guard's 404. */
  on: number
}
function guardedProbes(): Probe[] {
  const probes: Probe[] = []
  const write = (headers: Record<string, string>, payload: string, method = 'POST') => ({
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: payload,
  })
  for (const credential of ['session', 'full', 'read', 'bookings'] as const) {
    const headers = credentialHeaders[credential]
    // Unclassified operations allow full keys only; sessions keep their own authority.
    const allowed = credential === 'session' || credential === 'full'
    const scoped = (status: number) => (allowed ? status : 403)
    for (const [label, id, payload, status] of [
      ['known form', '00000000-0000-4000-8000-00000000f001', '{"name":"ada"}', 200],
      ['unknown form', randomUUID(), '{"name":"ada"}', 200],
      ['invalid id', 'not-a-uuid', '{"name":"ada"}', 400],
      ['unknown field', randomUUID(), '{"name":"ada","extra":1}', 400],
      ['malformed body', randomUUID(), '{', 400],
      ['NUL in the body', randomUUID(), '{"name":"a\\u0000"}', 400],
      ['overlong value', randomUUID(), `{"name":"${'a'.repeat(21)}"}`, 400],
    ] as const)
      probes.push({
        name: `${credential} write, ${label}`,
        path: `/api/v1/test-only-routing/${id}`,
        init: write(headers, payload),
        on: scoped(status),
      })
    probes.push({
      name: `${credential} write to a full-scope-only operation`,
      path: '/api/v1/branding',
      init: write(headers, '{"name":"ada"}', 'PATCH'),
      on: scoped(200),
    })
    // A session cookie authenticates nothing on the public read: it is an anonymous call.
    for (const [label, path, status] of [
      ['public form', '/api/v1/public/-/test-only-routing/ada/intro', 200],
      ['invalid public path', '/api/v1/public/-/test-only-routing/ADA/intro', 400],
    ] as const)
      probes.push({
        name: `${credential} read, ${label}`,
        path,
        init: { headers },
        on: credential === 'read' || credential === 'bookings' ? 403 : status,
      })
  }
  probes.push(
    {
      name: 'anonymous read, public form',
      path: '/api/v1/public/-/test-only-routing/ada/intro',
      init: {},
      on: 200,
    },
    {
      name: 'anonymous read, unknown public form',
      path: '/api/v1/public/-/test-only-routing/nobody/nothing',
      init: {},
      on: 200,
    },
  )
  return probes
}

// The transport checks and credential validation that answer before the guard, unchanged,
// whether routing is on or off.
function transportProbes(): (Omit<Probe, 'on'> & { status: number; error: string })[] {
  const form = `/api/v1/test-only-routing/${randomUUID()}`
  const publicForm = '/api/v1/public/-/test-only-routing/ada/intro'
  const write = (headers: Record<string, string>) => ({
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{"name":"ada"}',
  })
  const oversize = `{"name":"${'a'.repeat(70_000)}"}`
  return [
    { name: 'no credential', path: form, init: write({}), status: 401, error: 'unauthorized' },
    {
      name: 'invalid key',
      path: form,
      init: write({ authorization: 'Bearer hm_unknown' }),
      status: 401,
      error: 'unauthorized',
    },
    {
      name: 'key over its rate limit',
      path: form,
      init: write({ authorization: 'Bearer hm_limited' }),
      status: 429,
      error: 'rate_limited',
    },
    {
      name: 'invalid session cookie',
      path: form,
      init: write({ cookie: 'routing-session=expired', origin: PUBLIC_URL }),
      status: 401,
      error: 'unauthorized',
    },
    {
      // Part of credential validation: a cookie authenticates writes from the app only.
      name: 'cross-site cookie write',
      path: form,
      init: write({ cookie: 'routing-session=valid', origin: 'https://elsewhere.example' }),
      status: 403,
      error: 'forbidden',
    },
    {
      name: 'declared body over the limit',
      path: form,
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer hm_full',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(oversize)),
        },
        body: oversize,
      },
      status: 413,
      error: 'payload_too_large',
    },
    {
      name: 'invalid key on a public read',
      path: publicForm,
      init: { headers: { authorization: 'Bearer hm_unknown' } },
      status: 401,
      error: 'unauthorized',
    },
    {
      name: 'key over its rate limit on a public read',
      path: publicForm,
      init: { headers: { authorization: 'Bearer hm_limited' } },
      status: 429,
      error: 'rate_limited',
    },
  ]
}

/**
 * Builds the test operations behind `guardFactory(value)` for each value and checks the
 * order stated under Rollout gating: transport checks and credential validation first and
 * unchanged; then, while routing is off, the identical 404 for every caller, form, path and
 * body, before the scope check, input validation or any effect; and with `true` the request
 * reaches the scope check, validation and the handler.
 */
async function verifyRestGuard(
  guardFactory: (enabled: boolean) => MiddlewareHandler = routingFormsGuard,
  appFactory: typeof createApp = createApp,
  values: unknown[] = [false, true, ...NOT_TRUE_SAMPLE],
  limits?: RateLimits,
) {
  for (const value of values) {
    const enabled = value === true
    const effects = vi.fn()
    const app = appFactory({
      ...base,
      resolveCaller,
      routes: [guardedRoutes(guardFactory(value as boolean), effects, 1000, limits)],
    })
    let reached = 0
    for (const probe of guardedProbes()) {
      const response = await app.request(probe.path, probe.init)
      const text = await response.text()
      if (enabled) {
        expect(response.status, probe.name).toBe(probe.on)
        expect(text, probe.name).not.toBe(DISABLED)
        if (probe.on === 403)
          expect(JSON.parse(text)).toMatchObject({ error: 'insufficient_scope' })
        if (probe.on === 200) reached += 1
      } else {
        expect(response.status, `${String(value)}: ${probe.name}`).toBe(404)
        expect(text, probe.name).toBe(DISABLED)
        expect(response.headers.get('cache-control'), probe.name).toBe('no-store')
      }
    }
    for (const probe of transportProbes()) {
      const response = await app.request(probe.path, probe.init)
      expect(response.status, probe.name).toBe(probe.status)
      expect(await response.json(), probe.name).toMatchObject({ error: probe.error })
    }
    expect(effects).toHaveBeenCalledTimes(reached)
    if (!enabled) expect(reached).toBe(0)
    // Rate limits count first, refused requests included: the request over the limit gets
    // 429 instead of the guard's answer.
    const limited = appFactory({
      ...base,
      resolveCaller,
      routes: [guardedRoutes(guardFactory(value as boolean), () => {}, 2, limits)],
    })
    const statuses: number[] = []
    for (let i = 0; i < 3; i++)
      statuses.push((await limited.request('/api/v1/public/-/test-only-routing/ada/intro')).status)
    expect(statuses).toEqual(enabled ? [200, 200, 429] : [404, 404, 429])
  }
}

describe('the shared REST guard', () => {
  it('answers in the documented order with one identical refusal while off', async () => {
    await verifyRestGuard()
  }, 60_000)

  it('refuses a gated registration unless only the caller and transport limits precede it', () => {
    const register = (middleware: (caller: MiddlewareHandler) => MiddlewareHandler[]) =>
      createApp({
        ...base,
        resolveCaller,
        routes: [
          ({ app, caller }) =>
            app.openapi(
              createRoute({
                method: 'get',
                path: '/api/v1/test-only-routing/{id}',
                middleware: middleware(caller),
                request: { params: z.object({ id: z.uuid() }) },
                responses: { 200: { description: 'Reached' } },
              }),
              (c) => c.body(null, 200),
            ),
        ],
      })
    const guard = routingFormsGuard(false)
    // A per-user limit counted after authentication (like the host booking limits) would
    // answer after the hoisted guard, and a lookup before it would run first.
    const afterAuthentication: MiddlewareHandler = async (_c, next) => {
      await next()
    }
    for (const middleware of [
      (caller: MiddlewareHandler) => [guard, caller],
      (caller: MiddlewareHandler) => [guard, caller, guard],
      (caller: MiddlewareHandler) => [caller, afterAuthentication, guard],
      (caller: MiddlewareHandler) => [afterAuthentication, caller, guard],
      () => [afterAuthentication, guard],
    ])
      expect(() => register(middleware)).toThrow(
        'featureGate must come last, after only the caller, rateLimit and routeBodyLimit',
      )
    for (const middleware of [
      (caller: MiddlewareHandler) => [caller, guard],
      (caller: MiddlewareHandler) => [
        caller,
        rateLimit(createRateLimiter({ limit: 1, windowSeconds: 1 })),
        routeBodyLimit(1024),
        guard,
      ],
      () => [rateLimit(createRateLimiter({ limit: 1, windowSeconds: 1 })), guard],
      () => [guard],
    ])
      expect(() => register(middleware)).not.toThrow()
  })

  it('refuses every request when the guard is hidden from the scope binding', async () => {
    // Wrapped in a combinator, registration cannot see the guard, so it cannot be hoisted
    // before the scope check; it then refuses everything instead of running out of order.
    const effects = vi.fn()
    const app = createApp({
      ...base,
      resolveCaller,
      routes: [
        ({ app: target, caller }) =>
          target.openapi(
            createRoute({
              method: 'get',
              path: '/api/v1/test-only-routing/{id}',
              middleware: [every(caller, routingFormsGuard(true))],
              request: { params: z.object({ id: z.uuid() }) },
              responses: { 200: { description: 'Reached' } },
            }),
            (c) => {
              effects()
              return c.body(null, 200)
            },
          ),
      ],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await app.request(`/api/v1/test-only-routing/${randomUUID()}`, {
      headers: { authorization: 'Bearer hm_full' },
    })
    expect(response.status).toBe(500)
    expect(effects).not.toHaveBeenCalled()
  })

  it('treats a check that answers asynchronously as off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const effects = vi.fn()
    const app = createApp({
      ...base,
      resolveCaller,
      routes: [guardedRoutes(featureGate((async () => {}) as () => void), effects, 1000)],
    })
    for (const probe of guardedProbes()) {
      const response = await app.request(probe.path, probe.init)
      expect(response.status, probe.name).toBe(500)
    }
    expect(effects).not.toHaveBeenCalled()
  })

  it('detects a bypassed guard in a native source copy with real HTTP assertions', async () => {
    // Native source copies share their rest-scopes and DomainError modules with the native
    // app copy, so the copy's gate is the one that app's scope binding recognises.
    const nativeApp = await sourceCopy<typeof import('./app.ts')>('./app.ts')
    const control = await sourceCopy<typeof import('./routing-forms.ts')>('./routing-forms.ts')
    const nativeLimits = await nativeModule<RateLimits>('./rate-limit.ts')
    await verifyRestGuard(
      control.routingFormsGuard,
      nativeApp.createApp,
      [false, true],
      nativeLimits,
    )
    for (const mutation of [
      ["throw new DomainError('not_found', 'routing_forms_disabled')", 'return'],
      ['routingFormsEnabled !== true', '!routingFormsEnabled'],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof import('./routing-forms.ts')>(
        './routing-forms.ts',
        mutation,
      )
      await expect(
        verifyRestGuard(
          mutant.routingFormsGuard,
          nativeApp.createApp,
          [false, 'true', [true]],
          nativeLimits,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    }
  })
})

// A routing-style MCP tool defined only here; productTools never contains it.
const PROBE_TOOL = 'test_only_routing_lookup'
function probeTool(run: () => void): Tool {
  return defineTool({
    name: PROBE_TOOL,
    title: 'Test-only routing lookup',
    description: 'Defined only in the routing-forms guard test.',
    input: z.strictObject({ formId: z.uuid() }),
    output: z.object({ formId: z.uuid() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run({ formId }) {
      run()
      return { formId }
    },
  })
}

interface McpModules {
  helper: typeof routingFormTools
  createApp: typeof createApp
  mcpEndpoint: typeof mcpEndpoint
  productTools: typeof server.productTools
}
const nativeMcpModules: McpModules = {
  helper: routingFormTools,
  createApp,
  mcpEndpoint,
  productTools: server.productTools,
}

async function rpc(
  app: ReturnType<typeof createApp>,
  scope: string,
  era: 'legacy' | 'modern',
  name: string,
  args: unknown,
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer hm_${scope}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(era === 'modern' && {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
      }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(era === 'modern' && {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }),
      },
    }),
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : text)
}

async function listedTools(app: ReturnType<typeof createApp>, scope: string, era: string) {
  const client = new Client(
    { name: 'routing-guard', version: '1' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
        fetch: async (input, init) => app.request(input, init),
        requestInit: { headers: { authorization: `Bearer hm_${scope}` } },
      }),
    )
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

/**
 * Registers the probe tool through `helper(value, …)` beside the production catalogue and
 * checks tools/list and direct calls over both MCP protocol eras and the CLI client.
 */
async function verifyMcpGuard(
  modules: McpModules = nativeMcpModules,
  values: unknown[] = [false, true],
  eras: readonly ('legacy' | 'modern')[] = ['legacy', 'modern'],
) {
  // tools/list and these calls never reach the database.
  const db = {} as Db
  for (const value of values) {
    const enabled = value === true
    const run = vi.fn()
    const app = modules.createApp({
      ...base,
      resolveCaller,
      mcp: modules.mcpEndpoint({
        tools: [
          ...modules.productTools({ db, slotSnippetsEnabled: true }),
          ...modules.helper(value as boolean, [probeTool(run)]),
        ],
      }),
    })
    let reached = 0
    const refusals: Partial<Record<(typeof eras)[number], unknown>> = {}
    for (const scope of ['full', 'read', 'bookings'] as const) {
      // Unclassified, like a routing tool before its owning step: full keys only.
      const allowed = scope === 'full'
      for (const era of eras) {
        const names = await listedTools(app, scope, era)
        expect(names).toContain('whoami')
        if (enabled && allowed) expect(names).toContain(PROBE_TOOL)
        else expect(names).not.toContain(PROBE_TOOL)
        for (const args of [
          { formId: randomUUID() },
          {},
          { formId: 'not-a-uuid', extra: true },
          { formId: 'a\u0000' },
        ]) {
          const message = await rpc(app, scope, era, PROBE_TOOL, args)
          const valid = 'formId' in args && z.uuid().safeParse(args.formId).success
          if (!enabled) {
            expect(message.result, `${String(value)} ${scope} ${era}`).toMatchObject({
              isError: true,
              content: [{ type: 'text', text: DISABLED }],
            })
            expect(message.result).not.toHaveProperty('structuredContent')
            // The same result for every key and argument, per protocol era.
            refusals[era] ??= message.result
            expect(message.result).toEqual(refusals[era])
          } else if (!allowed) {
            expect(JSON.parse(message.result.content[0].text)).toMatchObject({
              error: 'insufficient_scope',
            })
          } else if (valid) {
            expect(message.result.isError).toBeFalsy()
            reached += 1
          } else {
            expect(JSON.parse(message.result.content[0].text)).toMatchObject({
              error: 'invalid_request',
            })
          }
        }
        // Unknown names keep the SDK's protocol error.
        const unknown = await rpc(app, scope, era, 'test_only_routing_unknown', {})
        expect(unknown.error).toMatchObject({ code: -32602 })
      }
      // The CLI prints a tool error's code; it sees the same refusal.
      const cli = callTool({
        url: new URL('/mcp', PUBLIC_URL),
        key: `hm_${scope}`,
        tool: PROBE_TOOL,
        input: { formId: randomUUID() },
        fetch: async (input, init) => app.request(input, init),
      })
      if (!enabled) await expect(cli).rejects.toMatchObject({ code: 'routing_forms_disabled' })
      else if (!allowed) await expect(cli).rejects.toMatchObject({ code: 'insufficient_scope' })
      else {
        await expect(cli).resolves.toHaveProperty('formId')
        reached += 1
      }
    }
    expect(run).toHaveBeenCalledTimes(reached)
    if (!enabled) expect(reached).toBe(0)
  }
}

describe('the MCP registration helper', () => {
  it('lists routing tools only while on and refuses direct calls identically while off', async () => {
    await verifyMcpGuard()
  }, 60_000)

  it('fails closed for every value but true', async () => {
    await verifyMcpGuard(nativeMcpModules, NOT_TRUE_SAMPLE, ['modern'])
  }, 60_000)

  it('treats a switch that answers asynchronously as off', async () => {
    const run = vi.fn()
    const logged = vi.fn()
    const tool = { ...probeTool(run), requireEnabled: async () => {} } as unknown as Tool
    const app = createApp({
      ...base,
      resolveCaller,
      mcp: mcpEndpoint({ tools: [tool] }),
    })
    vi.spyOn(console, 'error').mockImplementation(logged)
    expect(await listedTools(app, 'full', 'modern')).not.toContain(PROBE_TOOL)
    const message = await rpc(app, 'full', 'modern', PROBE_TOOL, { formId: randomUUID() })
    expect(message.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '{"error":"internal_error"}' }],
    })
    expect(run).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalled()
  })
})

async function verifyInstance(
  factory: typeof server.productRoutes = server.productRoutes,
  appFactory: typeof createApp = createApp,
) {
  // Route construction and these requests never connect to the database.
  const db = createDb(createPool('postgres://synthetic@127.0.0.1:9/routing-test'))
  try {
    for (const injected of [undefined, false, true, ...NOT_TRUE_SAMPLE]) {
      const app = appFactory({
        ...base,
        resolveCaller: unauthorized,
        routes: factory({
          db,
          socialProviders: {},
          invitationMailLimits: { secret: 'synthetic-routing-test-only-secret' },
          // Runtime values despite the boolean type: /instance reports what the guards do.
          ...(injected !== undefined && { routingFormsEnabled: injected as boolean }),
        }),
      })
      const response = await app.request(
        '/api/v1/instance?routingFormsEnabled=true&ROUTING_FORMS_ENABLED=true',
        { headers: { 'x-routing-forms-enabled': 'true' } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toHaveProperty('routingFormsEnabled', injected === true)
      const unknown = await app.request('/api/v1/test-only-routing/known')
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({ error: 'not_found' })
    }
  } finally {
    await db.destroy()
  }
}

describe('the hard-off constant', () => {
  it('keeps production composition off and accepts only internal test injection', async () => {
    await verifyInstance()
  })

  it('detects flipping the production constant with real instance responses', async () => {
    const control = await sourceCopy<typeof server>('./server.ts')
    await verifyInstance(control.productRoutes)
    const mutant = await sourceCopy<typeof server>('./server.ts', [
      'const routingFormsEnabled = false',
      'const routingFormsEnabled = true',
    ])
    await expect(verifyInstance(mutant.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects direct process environment reads in instance responses', async () => {
    stubRoutingEnvironment()
    const control = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts')
    await verifyInstance((options) => [
      control.instanceRoutes({ publicUrl: PUBLIC_URL, ...options }),
    ])
    const mutant = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts', [
      'routingFormsEnabled: routingFormsEnabled === true,',
      "routingFormsEnabled: process.env.ROUTING_FORMS_ENABLED === 'true',",
    ])
    await expect(
      verifyInstance((options) => [mutant.instanceRoutes({ publicUrl: PUBLIC_URL, ...options })]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects a test-only route accidentally registered in production', async () => {
    const control = await sourceCopy<typeof server>('./server.ts')
    await verifyInstance(control.productRoutes)
    const mutant = await sourceCopy<typeof server>('./server.ts', [
      'return [',
      `return [({ app }) => {
      app.get('/api/v1/test-only-routing/:id', (c) => c.json({ error: 'routing_forms_disabled' }, 404))
    },`,
    ])
    await expect(verifyInstance(mutant.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('has no configuration setting and keeps the production app options off', async () => {
    const databaseUrl = 'postgres://routing-env@127.0.0.1:9/routing-env'
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: 'synthetic-routing-config-secret-at-least-32-characters',
      PUBLIC_URL: 'http://localhost',
      ROUTING_FORMS_ENABLED: 'true',
      routingFormsEnabled: 'true',
    })
    expect(Object.keys(config).filter((key) => /routing/i.test(key))).toEqual([])
    // Assembling the app touches no database; the pool is still closed explicitly.
    const db = createDb(createPool(databaseUrl))
    const unavailable = async (): Promise<never> => {
      throw new Error('Route registration must not call a collaborator')
    }
    try {
      const app = createApp(
        server.productionAppOptions({
          config,
          db,
          auth: { handler: unavailable },
          resolveCaller: unavailable,
          resolveMcpOAuth: unavailable,
          checkDb: unavailable,
          waitlist: { verify: unavailable, remove: unavailable },
          invitationMailLimits: { secret: 'synthetic-routing-test-only-secret' },
          webhookSettings: { enabled: config.WEBHOOKS_ENABLED },
          notify: unavailable,
          notifyAttendeeNoShow: unavailable,
          googleCalendar: undefined,
          microsoftCalendar: undefined,
          zoomConference: undefined,
          enqueueCalendarSync: unavailable,
          enqueueCalendarWritebackRecovery: unavailable,
        }),
      )
      const response = await app.request('/api/v1/instance')
      expect(response.status).toBe(200)
      expect(await response.json()).toHaveProperty('routingFormsEnabled', false)
    } finally {
      await db.destroy()
    }
  })
})

// Evaluates the production module graph afresh with the setting already in the
// environment, so a read captured at module scope (not only inside startServer) is caught.
async function freshProductionModules() {
  stubRoutingEnvironment()
  vi.resetModules()
  const [server, app, guard, endpoint, limits] = await Promise.all([
    import('./server.ts'),
    import('./app.ts'),
    import('./routing-forms.ts'),
    import('./mcp/endpoint.ts'),
    import('./rate-limit.ts'),
  ])
  return { server, app, guard, endpoint, limits }
}

describe('the environment', () => {
  it('changes nothing when set before the server modules are evaluated', async () => {
    const fresh = await freshProductionModules()
    // One fresh graph for the guard, the app's DomainError handler and the MCP registry.
    await verifyInstance(fresh.server.productRoutes, fresh.app.createApp)
    await verifyRestGuard(
      fresh.guard.routingFormsGuard,
      fresh.app.createApp,
      [false, true],
      fresh.limits,
    )
    await verifyMcpGuard(
      {
        helper: fresh.guard.routingFormTools,
        createApp: fresh.app.createApp,
        mcpEndpoint: fresh.endpoint.mcpEndpoint,
        productTools: fresh.server.productTools,
      },
      [false],
      ['modern'],
    )
  }, 60_000)
})

describe.skipIf(!process.env.DATABASE_URL)('production routing hard-off startup', () => {
  it('ignores the environment, read at module scope or at startup, and serves no test route', async () => {
    const { server: freshServer } = await freshProductionModules()
    const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'routing_off',
    })
    try {
      const running = await freshServer.startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
        PUBLIC_URL: 'http://localhost',
        PORT: '0',
        HOURMERE_ROLE: 'web',
        ROUTING_FORMS_ENABLED: 'true',
        routingFormsEnabled: 'true',
      })
      try {
        const origin = `http://127.0.0.1:${running.port}`
        const response = await fetch(`${origin}/api/v1/instance`)
        expect(response.status).toBe(200)
        expect(await response.json()).toHaveProperty('routingFormsEnabled', false)
        const unknown = await fetch(`${origin}/api/v1/test-only-routing/known`)
        expect(unknown.status).toBe(404)
        expect(await unknown.json()).toEqual({ error: 'not_found' })
      } finally {
        await running.close()
      }
    } finally {
      await owned.drop()
    }
  }, 60_000)

  it('starts the real entry point with the setting on and still reports routing off', async () => {
    // index.ts is the composition root production runs (`npm start`, the Docker CMD). Only a
    // child process executes it, so module-scope reads and any override it passes into
    // startServer are observed exactly as production would observe them.
    const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'routing_entry',
    })
    // onTestFinished runs after an assertion failure, a thrown error and the test timeout
    // alike (a `finally` only covers the first two), in reverse order: the child is killed
    // first, then its database is dropped.
    onTestFinished(() => owned.drop())
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'HOURMERE_OUTBOX_DB_REGISTRY'])
      if (process.env[key]) env[key] = process.env[key]
    Object.assign(env, {
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      PUBLIC_URL: 'http://localhost',
      PORT: '0',
      HOURMERE_ROLE: 'web',
      SIGNUP: 'closed',
      ROUTING_FORMS_ENABLED: 'true',
      routingFormsEnabled: 'true',
    })
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const alive = () => child.exitCode === null && child.signalCode === null
    onTestFinished(async () => {
      // Whatever ended the test, no server process keeps listening on its port.
      if (alive()) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    // Every wait has its own deadline, well inside the test's, so a stall fails with the
    // child's output instead of the bare timeout message.
    const port = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`entry point did not listen within 30 s:\n${output}`)),
        30_000,
      )
      const settle = (settlement: () => void) => {
        clearTimeout(deadline)
        settlement()
      }
      child.stdout.on('data', () => {
        const match = /Hourmere listening on :(\d+)/.exec(output)
        if (match) settle(() => resolve(Number(match[1])))
      })
      child.once('error', (err) => settle(() => reject(err)))
      child.once('exit', (code, signal) =>
        settle(() =>
          reject(new Error(`entry point exited (${code ?? signal}) before listening:\n${output}`)),
        ),
      )
    })
    const origin = `http://127.0.0.1:${port}`
    const response = await fetch(`${origin}/api/v1/instance`, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('routingFormsEnabled', false)
    const unknown = await fetch(`${origin}/api/v1/test-only-routing/known`, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found' })
    // index.ts owns shutdown too: SIGTERM must close the server and exit cleanly, promptly.
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) }).catch(
      (err: unknown) => {
        throw err instanceof Error && err.name === 'AbortError'
          ? new Error(`entry point did not exit within 10 s of SIGTERM:\n${output}`)
          : err
      },
    )
    child.kill('SIGTERM')
    const [code] = (await exited) as [number | null, NodeJS.Signals | null]
    expect(code, output).toBe(0)
  }, 60_000)
})
