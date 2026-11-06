import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { configuredSmsJobs, createConfiguredSmsService } from './sms.ts'

const base = { DATABASE_URL: 'postgres://unused/unused', BETTER_AUTH_SECRET: 'a'.repeat(32) }
const db = new Proxy({} as Db, {
  get() {
    throw new Error('unexpected database access')
  },
})

describe('SMS server wiring', () => {
  it('fails closed without database or network access and schedules no job when unconfigured', async () => {
    const config = loadConfig(base)
    expect(configuredSmsJobs(config, db)).toEqual([])
    await expect(
      createConfiguredSmsService(config, db).sendSms({
        to: '+12025550123',
        body: 'synthetic message',
        idempotencyKey: 'synthetic-job',
        organizationId: 'synthetic-org',
      }),
    ).rejects.toMatchObject({ code: 'sms_not_configured' })
  })
  it('only schedules retention when configured, without making a provider request', () => {
    const config = loadConfig({
      ...base,
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'synthetic-auth-token',
      TWILIO_FROM: '+12025550123',
      SMS_HASH_KEY: Buffer.alloc(32, 3).toString('base64'),
    })
    expect(createConfiguredSmsService(config, db).sendSms).toBeTypeOf('function')
    expect(configuredSmsJobs(config, db)).toHaveLength(1)
    expect(configuredSmsJobs(config, db)[0]).toMatchObject({ name: 'sms-retention' })
  })
})
