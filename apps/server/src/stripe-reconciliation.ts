import { checkoutReconciliationWindow } from '@hourmere/scheduling'
import { z } from 'zod'
import { createStripeClient } from './stripe-client.ts'
import type { StripeConfig } from './stripe-config.ts'
import { parseStripeRefundObservation } from './stripe-refunds.ts'

const MAX_PAGES = 3
const PAGE_SIZE = 100
const sessionId = z.string().regex(/^cs_[A-Za-z0-9_]{1,200}$/)
const paymentIntentId = z.string().regex(/^pi_[A-Za-z0-9_]{1,200}$/)
const sessionSnapshot = z.object({
  object: z.literal('checkout.session'),
  id: sessionId,
  livemode: z.boolean(),
  mode: z.string(),
  ui_mode: z.string().nullable(),
  amount_total: z.int().nullable(),
  currency: z.string().nullable(),
  expires_at: z.int(),
  status: z.string().nullable(),
  payment_status: z.string(),
  payment_intent: paymentIntentId.nullable(),
  client_reference_id: z.string().nullable(),
  metadata: z
    .object({
      hourmere_checkout_attempt_id: z.string().optional(),
      hourmere_booking_id: z.string().optional(),
    })
    .nullable(),
})
const intentSnapshot = z.object({
  object: z.literal('payment_intent'),
  id: paymentIntentId,
  livemode: z.boolean(),
  amount: z.int(),
  amount_received: z.int(),
  currency: z.string(),
  status: z.string(),
})

type StripeReadCode =
  | 'stripe_account_mismatch'
  | 'stripe_unavailable'
  | 'stripe_response_invalid'
  | 'stripe_checkout_multiple_matches'
  | 'stripe_checkout_scan_incomplete'

export class StripeReconciliationError extends Error {
  readonly code: StripeReadCode

  constructor(code: StripeReadCode) {
    super(code)
    this.code = code
  }
}

async function stripeRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 404
    )
      return null
    // SDK errors can contain received object data and request metadata.
    throw new StripeReconciliationError('stripe_unavailable')
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new StripeReconciliationError('stripe_response_invalid')
  return result.data
}

/** Only return the fields needed for comparison. Never return Stripe payloads or Checkout URLs. */
export function createStripeReconciliationProvider(config: StripeConfig, transport?: typeof fetch) {
  const stripe = createStripeClient(config, transport)
  return {
    accountId: config.accountId,
    mode: config.mode,
    async verifyAccount() {
      const account = await stripeRead(() => stripe.accounts.retrieveCurrent())
      if (!account || account.id !== config.accountId)
        throw new StripeReconciliationError('stripe_account_mismatch')
    },
    async retrieveCheckout(id: string) {
      const parsedId = parse(sessionId, id)
      const session = await stripeRead(() => stripe.checkout.sessions.retrieve(parsedId))
      return session && parse(sessionSnapshot, session)
    },
    async findCheckout(input: { attemptId: string; startedAt: string; expiresAt: string }) {
      const created = checkoutReconciliationWindow(input)
      let startingAfter: string | undefined
      let found: z.infer<typeof sessionSnapshot> | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const list = await stripeRead(() =>
          stripe.checkout.sessions.list({
            created,
            limit: PAGE_SIZE,
            starting_after: startingAfter,
          }),
        )
        if (!list) throw new StripeReconciliationError('stripe_unavailable')
        for (const session of list.data) {
          if (
            session.client_reference_id !== input.attemptId &&
            session.metadata?.hourmere_checkout_attempt_id !== input.attemptId
          )
            continue
          if (found) throw new StripeReconciliationError('stripe_checkout_multiple_matches')
          found = parse(sessionSnapshot, session)
        }
        if (!list.has_more) return found
        const last = list.data.at(-1)?.id
        if (!last || last === startingAfter) break
        startingAfter = parse(sessionId, last)
      }
      throw new StripeReconciliationError('stripe_checkout_scan_incomplete')
    },
    async retrievePaymentIntent(id: string) {
      const parsedId = parse(paymentIntentId, id)
      const intent = await stripeRead(() => stripe.paymentIntents.retrieve(parsedId))
      return intent && parse(intentSnapshot, intent)
    },
    async listRefunds(id: string) {
      const paymentIntent = parse(paymentIntentId, id)
      const refunds: NonNullable<ReturnType<typeof parseStripeRefundObservation>>[] = []
      let startingAfter: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const list = await stripeRead(() =>
          stripe.refunds.list({
            payment_intent: paymentIntent,
            limit: PAGE_SIZE,
            starting_after: startingAfter,
          }),
        )
        if (!list) throw new StripeReconciliationError('stripe_unavailable')
        let last: string | undefined
        for (const item of list.data) {
          const refund = parseStripeRefundObservation(item, config.mode)
          if (!refund || refund.paymentReference !== paymentIntent)
            throw new StripeReconciliationError('stripe_response_invalid')
          refunds.push(refund)
          last = refund.id
        }
        if (!list.has_more) return { refunds, complete: true }
        if (!last || last === startingAfter) break
        startingAfter = last
      }
      return { refunds, complete: false }
    },
  }
}

export type StripeReconciliationProvider = ReturnType<typeof createStripeReconciliationProvider>
