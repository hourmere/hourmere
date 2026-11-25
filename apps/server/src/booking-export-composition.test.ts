import { createHmac, randomBytes } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('CSV export server composition', () => {
  it('applies BOOKING_EXPORT_MAX_CONCURRENT to exports by different users', async () => {
    const owned = await createTestDatabase(databaseUrl as string)
    const db = createDb(owned.pool)
    const secret = randomBytes(32).toString('base64')
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let server: RunningServer | undefined
    let first: Response | undefined
    let second: Response | undefined
    async function signIn() {
      const user = await createTestUser(db)
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: user.principal.organization.id,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    }
    try {
      const firstCookie = await signIn()
      const secondCookie = await signIn()
      server = await startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        BOOKING_EXPORT_MAX_CONCURRENT: '1',
        HOURMERE_ROLE: 'web',
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
      })
      const range = new URLSearchParams({
        from: '2026-01-01T00:00:00Z',
        to: '2027-01-01T00:00:00Z',
      })
      const url = `http://127.0.0.1:${server.port}/api/v1/bookings/export.csv?${range}`
      await db.transaction().execute(async (trx) => {
        // The header can be sent immediately. Hold the row query so HTTP buffering
        // cannot finish the first export before the second arrives.
        await sql`LOCK TABLE bookings IN ACCESS EXCLUSIVE MODE`.execute(trx)
        first = await fetch(url, { headers: { cookie: firstCookie } })
        expect(first.status).toBe(200)
        second = await fetch(url, { headers: { cookie: secondCookie } })
        expect(second.status).toBe(409)
        expect(await second.json()).toMatchObject({ error: 'export_busy' })
      })
    } finally {
      await Promise.allSettled([
        first?.bodyUsed ? undefined : first?.body?.cancel(),
        second?.bodyUsed ? undefined : second?.body?.cancel(),
      ])
      try {
        await server?.close()
      } finally {
        for (const spy of logs) spy.mockRestore()
        await owned.drop()
      }
    }
  })
})
