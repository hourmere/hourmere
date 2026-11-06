import { z } from 'zod'
import { defineJob } from './index.ts'

/** Always drain existing holds, including after the operator disables new admission. */
export function paymentHoldsExpiryJob(expire: () => Promise<unknown>) {
  return defineJob({
    name: 'payment-holds-expiry-v1',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 55,
    schedule: { cron: '* * * * *', payload: {} },
    handler: async (_, { signal }) => {
      if (signal.aborted) return
      await expire()
    },
  })
}
