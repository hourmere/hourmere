import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestUser } from '../../../packages/scheduling/src/testing.ts'
import { startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('server embed capability configuration', () => {
  let testDb: TestDatabase
  let hostCookie: string
  const secret = 'embed-capability-test-secret-at-least-32-characters'

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    const db = createDb(testDb.pool)
    const host = await createTestUser(db)
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId: host.id,
        token,
        activeOrganizationId: host.principal.organization.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    hostCookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function verify(configured: string, start: typeof startServer = startServer) {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    try {
      const server = await start({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        BETTER_AUTH_SECRET: secret,
        EMBED_ALLOWED_ORIGINS: configured,
        HOURMERE_ROLE: 'web',
        SIGNUP: 'closed',
      })
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/instance`)
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toHaveProperty('embedEnabled', Boolean(configured))
        expect(body).not.toHaveProperty('embedAllowedOrigins')
        const privatePath = `http://127.0.0.1:${server.port}/api/v1/instance/embed`
        const anonymous = await fetch(privatePath)
        expect(anonymous.status).toBe(401)
        expect((await anonymous.text()).includes('embedAllowedOrigins')).toBe(false)
        const host = await fetch(privatePath, { headers: { cookie: hostCookie } })
        expect(host.status).toBe(200)
        expect(host.headers.get('cache-control')).toBe('private, no-store')
        expect(await host.json()).toEqual({
          publicUrl: 'http://localhost',
          embedAllowedOrigins: configured
            ? ['https://www.example.com', 'https://blog.example.com']
            : [],
        })
      } finally {
        await server.close()
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  const configured = 'https://WWW.example.com:443, https://blog.example.com'

  it('publishes only the capability publicly and normalized origins to a real host session', async () => {
    await verify('')
    await verify(configured)
  })

  async function sourceCopy(replacement?: [string, string]) {
    const location = new URL('./server.ts', import.meta.url)
    let source = readFileSync(location, 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation matches server embed wiring').toBe(true)
      source = source.replace(...replacement)
    }
    const javascript = stripTypeScriptTypes(source).replace(
      /((?:from|import)\s*)'([^']+)'/g,
      (_, prefix: string, specifier: string) => {
        const resolved = specifier.startsWith('.')
          ? new URL(specifier, location).href
          : import.meta.resolve(specifier)
        return `${prefix}'${resolved}'`
      },
    )
    return import(
      `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    ) as Promise<typeof import('./server.ts')>
  }

  it('passes the server wiring assertion with an unmodified source copy', async () => {
    const copy = await sourceCopy()
    await verify(configured, copy.startServer)
  })

  it('detects dropping normalized embed origins from server configuration', async () => {
    const copy = await sourceCopy([
      '        embedAllowedOrigins: config.EMBED_ALLOWED_ORIGINS,\n',
      '',
    ])
    await expect(verify(configured, copy.startServer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('embedEnabled'),
    })
  })
})
