import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineJob } from './index.ts'
import { paymentHoldsExpiryJob } from './payment-holds.ts'

function copy(before?: string, after = ''): typeof paymentHoldsExpiryJob {
  let source = readFileSync(new URL('./payment-holds.ts', import.meta.url), 'utf8')
  if (before) {
    expect(source.includes(before)).toBe(true)
    source = source.replace(before, after)
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function('z', 'defineJob', `${source}; return paymentHoldsExpiryJob`)(z, defineJob)
}

async function verify(factory: typeof paymentHoldsExpiryJob) {
  const expire = vi.fn(async () => 0)
  const job = factory(expire)
  expect(job.schedule).toEqual({ cron: '* * * * *', payload: {} })
  expect(job.payload.safeParse({ paymentReference: 'synthetic' }).success).toBe(false)
  const controller = new AbortController()
  const run = { id: 'synthetic', attempt: 1, signal: controller.signal }
  await job.handler({}, run)
  expect(expire).toHaveBeenCalledTimes(1)
  controller.abort()
  await job.handler({}, run)
  expect(expire).toHaveBeenCalledTimes(1)
}

it('runs recurring hold expiry with an empty payload and respects shutdown', async () => {
  await verify(paymentHoldsExpiryJob)
})

it.each([
  ['expiry dispatch', 'await expire()', ''],
  ['shutdown', 'if (signal.aborted) return', ''],
  ['private payload', 'z.strictObject({})', 'z.object({})'],
])('detects removal of %s in a source copy', async (_name, before, after) => {
  await expect(verify(copy(before, after))).rejects.toMatchObject({ name: 'AssertionError' })
})
