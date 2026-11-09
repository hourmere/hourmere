import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createJobs, defineJob } from './index.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('disabled feature schedules', () => {
  it.each([true, false])(
    'removes persisted SMS schedule with work=%s and preserves unrelated schedules',
    async (work) => {
      const owned = await createTestDatabase(databaseUrl as string, undefined, {
        tag: 'sms_schedule',
      })
      const definitions = ['sms-retention', 'unrelated-retention'].map((name) =>
        defineJob({
          name,
          payload: z.object({}),
          schedule: { cron: '0 * * * *', payload: {} },
          async handler() {},
        }),
      )
      const enabled = createJobs({
        connectionString: owned.url,
        definitions,
        work: true,
        migrate: true,
        maxConnections: 2,
      })
      const disabled = createJobs({
        connectionString: owned.url,
        definitions: [],
        work,
        migrate: false,
        disabledSchedules: ['sms-retention'],
        maxConnections: 2,
      })
      try {
        await enabled.start()
        expect(
          (await owned.pool.query('SELECT name FROM pgboss.schedule ORDER BY name')).rows,
        ).toEqual([{ name: 'sms-retention' }, { name: 'unrelated-retention' }])
        await enabled.stop()
        await disabled.start()
        expect(
          (await owned.pool.query('SELECT name FROM pgboss.schedule ORDER BY name')).rows,
        ).toEqual([{ name: 'unrelated-retention' }])
      } finally {
        await disabled.stop()
        await enabled.stop()
        await owned.drop()
      }
    },
    20_000,
  )
  it('rejects contradictory schedule configuration', async () => {
    const jobs = createJobs({
      connectionString: 'postgres://unused/unused',
      definitions: [
        defineJob({
          name: 'sms-retention',
          payload: z.object({}),
          schedule: { cron: '0 * * * *', payload: {} },
          async handler() {},
        }),
      ],
      disabledSchedules: ['sms-retention'],
      work: false,
      migrate: true,
    })
    await expect(jobs.start()).rejects.toThrow(/cannot schedule and disable/)
  })
})
