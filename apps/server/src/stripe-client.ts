import Stripe from 'stripe'
import type { StripeConfig } from './stripe-config.ts'

const REQUEST_TIMEOUT_MS = 3000

export function createStripeClient(config: StripeConfig, transport: typeof fetch = fetch): Stripe {
  return new Stripe(config.apiKey(), {
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      try {
        return await transport(input, { ...init, redirect: 'error' })
      } catch {
        // Stripe can retry some socket errors even with maxNetworkRetries set to zero.
        // Return control to the durable operation's retry and reconciliation policies.
        throw new Error('Stripe transport failed')
      }
    }),
    maxNetworkRetries: 0,
    telemetry: false,
    timeout: REQUEST_TIMEOUT_MS,
  })
}
