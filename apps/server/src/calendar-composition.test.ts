import { createHmac, randomBytes } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { calendarTestSession } from '../../../packages/calendars/src/testing.ts'
import { startServer } from './server.ts'

describe.skipIf(!process.env.DATABASE_URL)('calendar server composition', () => {
  it('enables Microsoft authorization and its callback on the real web server', async () => {
    const database = await createTestDatabase(process.env.DATABASE_URL as string)
    const logs = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const secret = randomBytes(32).toString('base64')
    try {
      const db = createDb(database.pool)
      const owner = await calendarTestSession(db)
      const session = await db
        .selectFrom('auth.session')
        .select('token')
        .where('id', '=', owner.sessionId)
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(session.token).digest('base64')
      const server = await startServer({
        DATABASE_URL: database.url,
        BETTER_AUTH_SECRET: secret,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        HOURMERE_ROLE: 'web',
        GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-google-client',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-google-secret',
        MICROSOFT_CALENDAR_CLIENT_ID: 'synthetic-microsoft-client',
        MICROSOFT_CALENDAR_CLIENT_SECRET: 'synthetic-microsoft-secret',
        CALENDAR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      })
      try {
        const request = (path: string, method = 'GET') =>
          fetch(`http://127.0.0.1:${server.port}${path}`, {
            method,
            redirect: 'manual',
            headers: {
              cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
              origin: 'http://localhost',
              'content-type': 'application/json',
            },
            ...(method === 'POST' ? { body: '{}' } : {}),
          })
        const list = await request('/api/v1/calendar-connections')
        expect(list.status).toBe(200)
        expect(await list.json()).toMatchObject({ googleEnabled: true, microsoftEnabled: true })
        const authorize = await request('/api/v1/calendar-connections/microsoft/authorize', 'POST')
        expect(authorize.status).toBe(200)
        const { authorizationUrl } = (await authorize.json()) as { authorizationUrl: string }
        expect(new URL(authorizationUrl).host).toBe('login.microsoftonline.com')
        const callback = await request('/api/calendar/microsoft/callback?state=x&code=y')
        expect(callback.status).toBe(303)
        expect(callback.headers.get('location')).toBe(
          '/app/calendars?connection=invalid_state&provider=microsoft',
        )
      } finally {
        await server.close()
      }
    } finally {
      for (const log of logs) log.mockRestore()
      await database.drop()
    }
  })
})
