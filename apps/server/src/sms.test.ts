import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
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
  it('fails closed without database or network access and schedules only retention when unconfigured', async () => {
    const config = loadConfig(base)
    expect(configuredSmsJobs(config, db).map((job) => job.name)).toEqual(['sms-retention'])
    await expect(
      createConfiguredSmsService(config, db).sendSms({
        to: '+12025550123',
        body: 'synthetic message',
        idempotencyKey: 'synthetic-job',
        organizationId: 'synthetic-org',
      }),
    ).rejects.toMatchObject({ code: 'sms_not_configured' })
  })
  it('schedules only retention when configured, without making a provider request', () => {
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

async function assertDisabledRetention(factory: typeof configuredSmsJobs) {
  const config = loadConfig(base)
  const owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
    tag: 'sms_disabled',
  })
  try {
    await owned.pool.query(`INSERT INTO sms_deliveries
      (key_hash, request_hash, recipient_hash, recipient_mask, organization_id,
       provider_message_id, status, created_at)
      VALUES (decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),
        decode(repeat('03',32),'hex'),'+****23','00000000-0000-4000-8000-000000000001',
        'SMsynthetic','accepted',clock_timestamp()-interval '721 hours')`)
    const jobs = factory(config, createDb(owned.pool))
    expect(jobs.map((job) => job.name)).toEqual(['sms-retention'])
    for (const job of jobs) {
      expect(job.schedule).toEqual({ cron: '23 * * * *', payload: {} })
      await job.handler({}, { id: 'synthetic', attempt: 1, signal: new AbortController().signal })
    }
    expect(
      (
        await owned.pool.query(`SELECT status,request_hash,recipient_hash,recipient_mask,
      organization_id,provider_message_id FROM sms_deliveries`)
      ).rows,
    ).toEqual([
      {
        status: 'expired',
        request_hash: null,
        recipient_hash: null,
        recipient_mask: null,
        organization_id: null,
        provider_message_id: null,
      },
    ])
  } finally {
    await owned.drop()
  }
}

describe.skipIf(!process.env.DATABASE_URL)('disabled SMS retention', () => {
  it('scrubs old details through the registered job with no SMS credentials', async () => {
    await assertDisabledRetention(configuredSmsJobs)
  }, 20_000)

  it('detects a source-copy mutation that disables retention with SMS', async () => {
    const source = readFileSync(new URL('./sms.ts', import.meta.url), 'utf8')
    const protection = 'return [smsRetentionJob({ db })]'
    expect(source).toContain(protection)
    const javascript = stripTypeScriptTypes(
      source.replace(protection, 'return _config.SMS_PROVIDER ? [smsRetentionJob({ db })] : []'),
    ).replace(
      /from '([^']+)'/g,
      (_, specifier: string) => `from '${import.meta.resolve(specifier)}'`,
    )
    const mutated = await import(
      `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    )
    await expect(assertDisabledRetention(mutated.configuredSmsJobs)).rejects.toThrow(/expected/)
  }, 20_000)
})
