import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { startServer } from './server.ts'

const scenarios = [
  {
    name: 'the own-host exception',
    publicUrl: 'https://127.0.0.1',
    allowIpHosts: false,
    target: 'https://127.0.0.1/thanks',
  },
  {
    name: 'the operator IP-host exception',
    publicUrl: 'https://hourmere.example.test',
    allowIpHosts: true,
    target: 'https://192.0.2.1/thanks',
  },
] as const
const cases = scenarios.flatMap((scenario) =>
  (['mcp', 'cli'] as const).map((transport) => ({ ...scenario, transport })),
)

function withoutMcpPolicy(): Promise<typeof import('./server.ts')> {
  const location = new URL('./server.ts', import.meta.url)
  const source = readFileSync(location, 'utf8')
  const property = '        successRedirectPolicy,\n'
  const anchor = `      tools: productTools({\n        db,\n        slotSnippetsEnabled: config.SLOT_SNIPPETS_ENABLED,\n        waitlistSecret: config.BETTER_AUTH_SECRET,\n        publicUrl: config.PUBLIC_URL,\n        followUpHostNotesEnabled: config.FOLLOW_UP_HOST_NOTES_ENABLED,\n${property}`
  expect(source.includes(anchor), 'mutation matches production MCP policy wiring').toBe(true)
  // Compile a source copy so concurrent tests keep using the original production module.
  const javascript = stripTypeScriptTypes(
    source.replace(anchor, anchor.replace(property, '')),
  ).replace(/((?:from|import)\s*)'([^']+)'/g, (_, prefix: string, specifier: string) => {
    const resolved = specifier.startsWith('.')
      ? new URL(specifier, location).href
      : import.meta.resolve(specifier)
    return `${prefix}'${resolved}'`
  })
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!process.env.DATABASE_URL)('production redirect policy parity', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  let key: string
  const secret = randomBytes(32).toString('base64')
  const signup = { mode: 'closed', allowedDomains: [] } as const

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    const db = createDb(owned.pool)
    const host = await createFixtures(db).host()
    authPool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: 'https://127.0.0.1',
      secret,
      mailer: { send: async () => {} },
      signup,
    })
    key = (
      await auth.api.createApiKey({
        body: { userId: host.userId, metadata: { scope: 'full' } },
      })
    ).key
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function verifyPolicy(
    scenario: (typeof cases)[number],
    start: typeof startServer = startServer,
  ) {
    const spies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      server = await start({
        DATABASE_URL: owned.url,
        PORT: '0',
        PUBLIC_URL: scenario.publicUrl,
        SUCCESS_REDIRECT_ALLOW_IP_HOSTS: String(scenario.allowIpHosts),
        BETTER_AUTH_SECRET: secret,
        HOURMERE_ROLE: 'web',
        SIGNUP: signup.mode,
      })
      const origin = `http://127.0.0.1:${server.port}`
      const event = () => ({
        slug: `policy-${randomUUID()}`,
        title: 'Configured redirect policy',
        durationMinutes: 30,
        successRedirect: { url: scenario.target },
      })
      const rest = await fetch(`${origin}/api/v1/event-types`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(event()),
      })
      expect(rest.status, 'REST accepts the configured exception').toBe(201)
      const saved = (await rest.json()) as { successRedirect: { url: string } }
      expect(saved.successRedirect.url).toBe(scenario.target)

      if (scenario.transport === 'mcp') {
        const client = new Client({ name: 'redirect-policy-test', version: '1.0.0' })
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${key}` } },
            }),
          )
          const result = await client.callTool({ name: 'create_event_type', arguments: event() })
          expect(result.isError, 'MCP accepts the same configured exception as REST').toBeFalsy()
          expect(result.structuredContent).toHaveProperty('successRedirect', saved.successRedirect)
        } finally {
          await client.close()
        }
      } else {
        let stdout = ''
        let stderr = ''
        const code = await runCli({
          argv: ['create-event', '--input', '-', '--success-redirect-url', scenario.target],
          env: { HOURMERE_URL: origin, HOURMERE_API_KEY: key },
          stdin: (async function* () {
            const { successRedirect: _, ...input } = event()
            yield JSON.stringify(input)
          })(),
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        })
        expect(code, 'CLI accepts the same configured exception as REST').toBe(0)
        expect(stderr).toBe('')
        expect(JSON.parse(stdout)).toHaveProperty('successRedirect', saved.successRedirect)
      }
    } finally {
      try {
        await server?.close()
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    }
  }

  it.each(cases)(
    'shares $name between REST and $transport through real start() wiring',
    async (scenario) => {
      await verifyPolicy(scenario)
    },
    20_000,
  )

  it.each(cases)(
    'detects removed production MCP policy for $name over $transport',
    async (scenario) => {
      const copy = await withoutMcpPolicy()
      await expect(verifyPolicy(scenario, copy.startServer)).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining(
          `${scenario.transport.toUpperCase()} accepts the same configured exception as REST`,
        ),
      })
    },
    20_000,
  )
})
