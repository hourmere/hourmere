import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { runTool } from './mcp/tools.ts'
import { instanceRoutes } from './routes/instance.ts'
import * as server from './server.ts'

const { productRoutes } = server

const base = {
  DATABASE_URL: 'postgres://slot-config@127.0.0.1:9/slot-config',
  BETTER_AUTH_SECRET: 'synthetic-slot-config-secret-at-least-32-characters',
}

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

async function verifySwitch(factory = productRoutes) {
  const db = createDb(createPool(base.DATABASE_URL))
  try {
    for (const enabled of [undefined, false, true]) {
      const app = createApp({
        publicUrl: 'https://canonical.example',
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        routes: factory({
          db,
          socialProviders: {},
          publicUrl: 'https://canonical.example',
          invitationMailLimits: { secret: 'synthetic-slot-config-mail-secret' },
          ...(enabled !== undefined && { slotSnippetsEnabled: enabled }),
        }),
      })
      const response = await app.request('https://untrusted.example/api/v1/instance')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { slotSnippetsEnabled: boolean; publicUrl: string }
      expect(body.slotSnippetsEnabled).toBe(enabled === true)
      expect(body.publicUrl).toBe('https://canonical.example')
    }
  } finally {
    await db.destroy()
  }
}

it('defaults snippets off and enables only the explicit operator opt-in', async () => {
  expect(loadConfig(base).SLOT_SNIPPETS_ENABLED).toBe(false)
  expect(loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'false' }).SLOT_SNIPPETS_ENABLED).toBe(false)
  expect(loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'true' }).SLOT_SNIPPETS_ENABLED).toBe(true)
  expect(() => loadConfig({ ...base, SLOT_SNIPPETS_ENABLED: 'yes' })).toThrow()
  await verifySwitch()
})

it('checks unmodified source copies and detects removing the release gate wiring', async () => {
  const control = await sourceCopy<typeof import('./server.ts')>('./server.ts')
  await verifySwitch(control.productRoutes)
  const mutant = await sourceCopy<typeof import('./server.ts')>('./server.ts', [
    '      slotSnippetsEnabled,\n      hostedSignupUrl,',
    '      hostedSignupUrl,',
  ])
  await expect(verifySwitch(mutant.productRoutes)).rejects.toMatchObject({ name: 'AssertionError' })
})

it('detects default-on configuration and public capabilities', async () => {
  const config = await sourceCopy<typeof import('./config.ts')>('./config.ts', [
    "(value) => value === 'true',\n    ),\n    FOLLOW_UP_HOST_NOTES_ENABLED:",
    "(value) => value !== 'false',\n    ),\n    FOLLOW_UP_HOST_NOTES_ENABLED:",
  ])
  expect(() => expect(config.loadConfig(base).SLOT_SNIPPETS_ENABLED).toBe(false)).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  const control = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts')
  const mutant = await sourceCopy<typeof import('./routes/instance.ts')>('./routes/instance.ts', [
    '  slotSnippetsEnabled = false,',
    '  slotSnippetsEnabled = true,',
  ])
  async function verifyPublic(factory: typeof instanceRoutes) {
    const app = createApp({
      publicUrl: 'https://canonical.example',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [factory({ publicUrl: 'https://canonical.example', socialProviders: {} })],
    })
    const response = await app.request('/api/v1/instance')
    expect(await response.json()).toHaveProperty('slotSnippetsEnabled', false)
  }
  await verifyPublic(instanceRoutes)
  await verifyPublic(control.instanceRoutes)
  await expect(verifyPublic(mutant.instanceRoutes)).rejects.toMatchObject({
    name: 'AssertionError',
  })
})

describe.skipIf(!process.env.DATABASE_URL)('production snippet route and tool flag wiring', () => {
  let owned: TestDatabase
  let db: Db
  let user: Awaited<ReturnType<typeof createTestUser>>
  let eventTypeId: string
  let apiKey: string
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'snippet_config',
    })
    db = createDb(owned.pool)
    user = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        handle: 'snippet-config',
        time_zone: 'UTC',
        locale: 'en',
      })
      .execute()
    const fixtures = createFixtures(db)
    await fixtures.schedule(user.id, { timeZone: 'UTC' })
    eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id)
    const signup = { mode: 'open', allowedDomains: [] } as const
    const authPool = createAuthPool(owned.url, signup)
    try {
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: 'http://localhost',
        secret: base.BETTER_AUTH_SECRET,
        signup,
        mailer: { send: async () => {} },
      })
      apiKey = (
        await auth.api.createApiKey({
          body: { userId: user.id, name: 'snippet-config', metadata: { scope: 'read' } },
        })
      ).key
    } finally {
      await authPool.end()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verifyProduction(factory = server, appFactory = createApp) {
    if (user.principal.kind !== 'api_key') throw Error('Expected API key fixture')
    const today = Temporal.Now.plainDateISO('UTC')
    const day = today.add({ days: 7 + ((8 - today.dayOfWeek) % 7) })
    const input = { eventTypeId, from: `${day}T00:00:00Z`, to: `${day.add({ days: 1 })}T00:00:00Z` }
    for (const enabled of [undefined, false, true]) {
      const options = {
        db,
        publicUrl: 'https://canonical.example',
        ...(enabled !== undefined && { slotSnippetsEnabled: enabled }),
      }
      const tools = factory.productTools(options)
      const app = appFactory({
        publicUrl: options.publicUrl,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal: user.principal, setCookie: [] }),
        routes: factory.productRoutes({
          ...options,
          socialProviders: {},
          invitationMailLimits: { secret: 'synthetic-slot-config-mail-secret' },
        }),
        mcp: mcpEndpoint({ tools }),
      })
      const response = await app.request('/api/v1/open-time-snippets', {
        method: 'POST',
        headers: { authorization: 'Bearer hm_test', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      expect(response.status).toBe(enabled === true ? 200 : 404)
      const result = await response.json()
      if (enabled === true) expect(result).toHaveProperty('slots', expect.any(Array))
      else expect(result).toHaveProperty('error', 'slot_snippets_disabled')
      const discovery = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer hm_test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(discovery.status).toBe(200)
      const text = await discovery.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      const message = JSON.parse(data ? data.slice(6) : text)
      const names = message.result.tools.map((tool: { name: string }) => tool.name)
      expect(names.includes('generate_open_time_snippet')).toBe(enabled === true)
      if (enabled === true) {
        const tool = tools.find((tool) => tool.name === 'generate_open_time_snippet')
        if (!tool) throw Error('Missing enabled snippet tool')
        const response = await runTool(
          tool,
          input,
          { caller: user.principal, rateLimit: () => {} },
          () => {},
        )
        expect(response.isError).not.toBe(true)
        expect(response.structuredContent).toEqual(result)
      }
    }
  }
  it('serves enabled snippets and keeps default/off REST unavailable and MCP undiscoverable', () =>
    verifyProduction())
  it('kills hard-coded REST and MCP flag wiring with real requests and discovery', async () => {
    const control = await sourceCopy<typeof server>('./server.ts')
    const nativeApp = await sourceCopy<typeof import('./app.ts')>('./app.ts')
    await verifyProduction(control, nativeApp.createApp)
    for (const replacement of [
      [
        'openTimeSnippetRoutes({ db, publicUrl, slotSnippetsEnabled,',
        'openTimeSnippetRoutes({ db, publicUrl, slotSnippetsEnabled: true,',
      ],
      [
        'openTimeSnippetRoutes({ db, publicUrl, slotSnippetsEnabled,',
        'openTimeSnippetRoutes({ db, publicUrl, slotSnippetsEnabled: false,',
      ],
      ['...(slotSnippetsEnabled\n', '...(true\n'],
      ['...(slotSnippetsEnabled\n', '...(false\n'],
      [
        'openTimeSnippetTools({ db, publicUrl, slotSnippetsEnabled,',
        'openTimeSnippetTools({ db, publicUrl, slotSnippetsEnabled: false,',
      ],
    ] as [string, string][]) {
      const mutant = await sourceCopy<typeof server>('./server.ts', replacement)
      await expect(verifyProduction(mutant, nativeApp.createApp)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    }
  })

  async function verifyStartup(enabled: boolean | undefined, start = server.startServer) {
    const running = await start({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: base.BETTER_AUTH_SECRET,
      PORT: '0',
      PUBLIC_URL: 'http://localhost',
      HOURMERE_ROLE: 'web',
      ...(enabled !== undefined && { SLOT_SNIPPETS_ENABLED: String(enabled) }),
    })
    try {
      const origin = `http://127.0.0.1:${running.port}`
      const today = Temporal.Now.plainDateISO('UTC')
      const day = today.add({ days: 7 + ((8 - today.dayOfWeek) % 7) })
      const input = {
        eventTypeId,
        from: `${day}T00:00:00Z`,
        to: `${day.add({ days: 1 })}T00:00:00Z`,
      }
      const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      const rest = await fetch(`${origin}/api/v1/open-time-snippets`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
      expect(rest.status).toBe(enabled === true ? 200 : 404)
      const snippet = await rest.json()
      if (enabled === true) expect(snippet).toHaveProperty('slots', expect.any(Array))
      else expect(snippet).toEqual({ error: 'slot_snippets_disabled' })
      async function rpc(method: string, params: Record<string, unknown>) {
        const response = await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        expect(response.status).toBe(200)
        const text = await response.text()
        const data = text.split('\n').find((line) => line.startsWith('data: '))
        return JSON.parse(data ? data.slice(6) : text)
      }
      const discovery = await rpc('tools/list', {})
      expect(
        discovery.result.tools.some(
          (tool: { name: string }) => tool.name === 'generate_open_time_snippet',
        ),
      ).toBe(enabled === true)
      const called = await rpc('tools/call', {
        name: 'generate_open_time_snippet',
        arguments: input,
      })
      if (enabled === true) {
        expect(called.result.isError).not.toBe(true)
        expect(called.result.structuredContent).toEqual(snippet)
      } else {
        expect(called).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32602, message: 'Tool generate_open_time_snippet not found' },
        })
      }
      let stdout = ''
      let stderr = ''
      const exit = await runCli({
        argv: ['open-time-snippet', '--json', '--input', '-'],
        env: { HOURMERE_URL: origin, HOURMERE_API_KEY: apiKey },
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
      expect(exit).toBe(enabled === true ? 0 : 1)
      if (enabled === true) {
        expect(stderr).toBe('')
        expect(JSON.parse(stdout)).toEqual(snippet)
      } else {
        expect(stdout).toBe('')
        expect(JSON.parse(stderr)).toEqual({ error: 'slot_snippets_disabled' })
      }
    } finally {
      await running.close()
    }
  }

  it.each([undefined, false, true])(
    'passes SLOT_SNIPPETS_ENABLED=%s through server startup to REST, MCP and CLI',
    async (enabled) => verifyStartup(enabled),
    20_000,
  )

  it('kills true and false hard-coding in both startup configuration pass-throughs', async () => {
    const control = await sourceCopy<typeof server>('./server.ts')
    await verifyStartup(false, control.startServer)
    await verifyStartup(true, control.startServer)
    for (const anchor of [
      '      slotSnippetsEnabled: config.SLOT_SNIPPETS_ENABLED,',
      '        slotSnippetsEnabled: config.SLOT_SNIPPETS_ENABLED,',
    ]) {
      for (const hardcoded of [true, false]) {
        const mutant = await sourceCopy<typeof server>('./server.ts', [
          `\n${anchor}`,
          `\n${anchor.replace('config.SLOT_SNIPPETS_ENABLED', String(hardcoded))}`,
        ])
        await expect(verifyStartup(!hardcoded, mutant.startServer)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      }
    }
  }, 60_000)
})
