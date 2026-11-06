import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { startServer } from './server.ts'

describe.skipIf(!process.env.DATABASE_URL)('production waitlist discovery wiring', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function assertDiscovery(smtp: boolean, start = startServer) {
    const db = createDb(owned.pool)
    const f = createFixtures(db)
    const host = await f.host()
    const teamId = await f.organization()
    await f.member(host.userId, teamId, 'owner')
    const team = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
    for (const [org, user] of [
      [host.organizationId, host.userId],
      [teamId, null],
    ] as const) {
      const id = await f.eventType(org, user, { slug: 'intro', hosts: [{ userId: host.userId }] })
      await db
        .updateTable('event_types')
        .set({ waitlist_enabled: true })
        .where('id', '=', id)
        .execute()
    }
    const secret = randomBytes(32).toString('base64')
    const signup = { mode: 'closed', allowedDomains: [] } as const
    const authPool = createAuthPool(owned.url, signup)
    let key: string
    try {
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: 'http://localhost',
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      key = (await auth.api.createApiKey({ body: { userId: host.userId } })).key
    } finally {
      await authPool.end()
    }
    const server = await start({
      DATABASE_URL: owned.url,
      PORT: '0',
      PUBLIC_URL: 'http://localhost',
      BETTER_AUTH_SECRET: secret,
      HOURMERE_ROLE: 'web',
      ...(smtp ? { SMTP_URL: 'smtp://127.0.0.1:1', MAIL_FROM: 'test@example.test' } : {}),
    })
    const base = `http://127.0.0.1:${server.port}`
    const client = new Client({ name: 'waitlist-wiring-test', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      )
      for (const target of [{ handle: host.handle }, { teamSlug: team.slug }]) {
        const path = 'teamSlug' in target ? `teams/${target.teamSlug}` : target.handle
        const rest = await fetch(`${base}/api/v1/public/${path}/intro`)
        expect(rest.status).toBe(200)
        const expected = smtp ? { enabled: true } : undefined
        expect(((await rest.json()) as { waitlist?: unknown }).waitlist).toEqual(expected)
        const date = Temporal.Now.plainDateISO('UTC').add({ days: 1 }).toString()
        const input = { ...target, slug: 'intro', startDate: date, endDate: date, timeZone: 'UTC' }
        const result = await client.callTool({ name: 'find_available_slots', arguments: input })
        expect(result.isError).toBeFalsy()
        expect(
          (result.structuredContent as { eventType: { waitlist?: unknown } }).eventType.waitlist,
        ).toEqual(expected)
        let stdout = ''
        const code = await runCli({
          argv: ['slots', '--input', '-'],
          env: { HOURMERE_URL: base, HOURMERE_API_KEY: key },
          stdin: (async function* () {
            yield JSON.stringify(input)
          })(),
          stdout: (text) => {
            stdout += text
          },
          stderr: () => {},
        })
        expect(code).toBe(0)
        expect(JSON.parse(stdout).eventType.waitlist).toEqual(expected)
      }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it.each([true, false])(
    'REST, MCP and CLI agree with SMTP=%s through startServer',
    (smtp) => assertDiscovery(smtp),
    20_000,
  )

  it('kills dropping SMTP from the production booking-tool wiring', async () => {
    const location = new URL('./server.ts', import.meta.url)
    const source = readFileSync(location, 'utf8')
    const anchor = '...bookingTools({\n      db,\n      waitlistSecret,\n      smtpConfigured,'
    expect(source).toContain(anchor)
    const javascript = stripTypeScriptTypes(
      source.replace(anchor, anchor.replace('\n      smtpConfigured,', '')),
    ).replace(
      /((?:from|import)\s*)'([^']+)'/g,
      (_, prefix: string, specifier: string) =>
        `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
    )
    const copy: typeof import('./server.ts') = await import(
      `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    )
    await expect(assertDiscovery(true, copy.startServer)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: undefined,
      expected: { enabled: true },
    })
  }, 20_000)
})
