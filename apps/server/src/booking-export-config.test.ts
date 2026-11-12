import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import type { bookingRoutes } from './routes/bookings.ts'
import { productRoutes } from './server.ts'

async function sourceCopy<T>(file: string, before: string): Promise<T> {
  const location = new URL(file, import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.split(before)).toHaveLength(2)
  const javascript = stripTypeScriptTypes(source.replace(before, '')).replace(
    /(^import\s+(?:[^'"]*?\bfrom\s*)?)'([^'\n]+)'/gm,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!process.env.DATABASE_URL)('CSV export configuration wiring', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verifyLimit(factory = productRoutes, routeFactory?: typeof bookingRoutes) {
    const first = await createTestUser(db)
    const second = await createTestUser(db)
    const config = loadConfig({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: 'synthetic-export-config-secret-at-least-32-characters',
      BOOKING_EXPORT_MAX_CONCURRENT: '1',
    })
    const options = { db, bookingExportMaxConcurrent: config.BOOKING_EXPORT_MAX_CONCURRENT }
    const app = createApp({
      publicUrl: config.PUBLIC_URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => ({
        ok: true,
        principal:
          headers.get('authorization') === 'Bearer first' ? first.principal : second.principal,
        setCookie: [],
      }),
      routes: routeFactory
        ? [routeFactory(options)]
        : factory({
            ...options,
            socialProviders: {},
            invitationMailLimits: { secret: 'synthetic-export-config-mail-secret' },
          }),
    })
    const path =
      '/api/v1/bookings/export.csv?from=2026-01-01T00%3A00%3A00Z&to=2027-01-01T00%3A00%3A00Z'
    let firstResponse: Response | undefined
    let secondResponse: Response | undefined
    try {
      firstResponse = await app.request(path, { headers: { authorization: 'Bearer first' } })
      expect(firstResponse.status).toBe(200)
      secondResponse = await app.request(path, { headers: { authorization: 'Bearer second' } })
      expect(secondResponse.status).toBe(409)
      expect(await secondResponse.json()).toMatchObject({ error: 'export_busy' })
    } finally {
      await firstResponse?.body?.cancel()
      if (!secondResponse?.bodyUsed) await secondResponse?.body?.cancel()
    }
  }

  it('applies the validated process capacity to REST exports by different users', () =>
    verifyLimit())
  it('detects removing the product route configuration forwarding', async () => {
    const mutant = await sourceCopy<typeof import('./server.ts')>(
      './server.ts',
      '      bookingExportMaxConcurrent,\n',
    )
    await expect(verifyLimit(mutant.productRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('detects removing the service context configuration forwarding', async () => {
    const mutant = await sourceCopy<typeof import('./routes/bookings.ts')>(
      './routes/bookings.ts',
      '      bookingExportMaxConcurrent,\n',
    )
    await expect(verifyLimit(productRoutes, mutant.bookingRoutes)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
