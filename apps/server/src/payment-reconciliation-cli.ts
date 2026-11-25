// Run as an instance operator with the server's database and Stripe configuration.
import { parseArgs } from 'node:util'
import { createDb, createPool } from '@hourmere/db'
import { paymentReconciliationPage, reconcileStripePayments } from './payment-reconciliation.ts'
import { loadStripeConfig } from './stripe-config.ts'
import { createStripeReconciliationProvider } from './stripe-reconciliation.ts'

const usage =
  'Usage: node apps/server/src/payment-reconciliation-cli.ts [--limit 1..50] [--after CURSOR]'

async function main() {
  let options: Parameters<typeof paymentReconciliationPage>[0]
  try {
    const { values } = parseArgs({
      options: { limit: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean' } },
    })
    if (values.help) {
      console.log(usage)
      return 0
    }
    if (values.limit !== undefined && !/^\d{1,2}$/.test(values.limit))
      throw new Error('Invalid limit')
    options = {
      limit: values.limit === undefined ? undefined : Number(values.limit),
      after: values.after,
    }
    paymentReconciliationPage(options)
  } catch {
    console.error(usage)
    return 1
  }

  const url = process.env.DATABASE_URL
  const config = loadStripeConfig(process.env)
  if (!url || !config) {
    console.error('Payment reconciliation requires the instance database and Stripe configuration.')
    return 1
  }
  const db = createDb(createPool(url))
  try {
    const report = await reconcileStripePayments(
      db,
      createStripeReconciliationProvider(config),
      options,
    )
    console.log(JSON.stringify(report))
    return report.stripeError ? 1 : 0
  } finally {
    await db.destroy()
  }
}

try {
  process.exitCode = await main()
} catch {
  // Database and SDK errors can contain private data. Keep those details out of output.
  console.error(
    'Payment reconciliation did not complete. Check the instance database and Stripe configuration.',
  )
  process.exitCode = 1
}
