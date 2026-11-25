import { randomBytes } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import { expect, it, vi } from 'vitest'
import { startServer } from './server.ts'

const databaseUrl = process.env.DATABASE_URL

it.skipIf(!databaseUrl)('registers hourly SMS retention in the worker with SMS off', async () => {
  const owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sms_ret_app' })
  const spies = (['log', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  )
  try {
    const server = await startServer({
      DATABASE_URL: owned.url,
      HOURMERE_ROLE: 'worker',
      PORT: '0',
      PUBLIC_URL: 'http://localhost',
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      SIGNUP: 'closed',
    })
    try {
      const { rows } = await owned.pool.query(
        'SELECT name, cron, data FROM pgboss.schedule WHERE name = $1',
        ['sms-retention'],
      )
      expect(rows).toEqual([{ name: 'sms-retention', cron: '23 * * * *', data: {} }])
    } finally {
      await server.close()
    }
  } finally {
    for (const spy of spies) spy.mockRestore()
    await owned.drop()
  }
})
