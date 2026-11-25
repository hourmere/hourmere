import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { runPaymentRefunds } from '@hourmere/scheduling'
import { z } from 'zod'
import type { StripeConfig } from './stripe-config.ts'
import { createStripeRefundProvider } from './stripe-refunds.ts'

/** Retained obligations drain independently of the new admission and receiver switch. */
export function paymentRefundJob(db: Db, stripe?: StripeConfig) {
  const provider = stripe ? createStripeRefundProvider(stripe) : undefined
  return defineJob({
    name: 'payment-refunds-v1',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 55,
    schedule: { cron: '* * * * *', payload: {} },
    handler: async (_, { signal }) => {
      if (!provider) return
      const { failed } = await runPaymentRefunds(db, provider, signal)
      if (failed) console.warn(`Stripe refund obligations need operator review: ${failed}`)
    },
  })
}
