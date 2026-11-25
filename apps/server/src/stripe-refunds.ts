import {
  type PaymentMode,
  type PaymentRefundProvider,
  PaymentRefundProviderError,
  type StripeRefundObservation,
} from '@hourmere/scheduling'
import Stripe from 'stripe'
import { z } from 'zod'
import { createStripeClient } from './stripe-client.ts'
import type { StripeConfig } from './stripe-config.ts'

const obligationMetadata = 'hourmere_refund_obligation_id'
const refundSnapshot = z.object({
  object: z.literal('refund'),
  id: z.string().regex(/^re_[A-Za-z0-9_]{1,200}$/),
  amount: z.int().positive(),
  currency: z.string().regex(/^[a-z]{3}$/),
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9_]{1,200}$/),
  status: z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  livemode: z.boolean().optional(),
})

export function parseStripeRefundObservation(
  value: unknown,
  mode?: PaymentMode,
): StripeRefundObservation | undefined {
  const parsed = refundSnapshot.safeParse(value)
  if (!parsed.success) return
  const refund = parsed.data
  // Refund snapshots may omit livemode. The signed envelope or verified API key
  // establishes the mode independently.
  if (mode !== undefined && refund.livemode !== undefined && refund.livemode !== (mode === 'live'))
    return
  const metadataId = refund.metadata?.[obligationMetadata]
  const obligationId = metadataId === undefined ? null : z.uuid().safeParse(metadataId).data
  if (obligationId === undefined) return
  const state =
    refund.status === 'requires_action'
      ? 'pending'
      : refund.status === 'canceled'
        ? 'failed'
        : refund.status
  return {
    id: refund.id,
    obligationId,
    paymentReference: refund.payment_intent,
    amountMinor: refund.amount,
    currency: refund.currency,
    state,
  }
}

async function stripeRefundRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    // Stripe errors may contain provider payloads, credentials and request headers.
    const status = error instanceof Stripe.errors.StripeError ? error.statusCode : undefined
    const transient =
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500)
    throw new PaymentRefundProviderError(transient)
  }
}

export function createStripeRefundProvider(
  config: StripeConfig,
  transport: typeof fetch = fetch,
): PaymentRefundProvider {
  const { accountId, mode } = config
  const stripe = createStripeClient(config, transport)
  return {
    accountId,
    mode,
    async createRefund(input) {
      if (input.accountId !== accountId || input.mode !== mode)
        throw new PaymentRefundProviderError(false)
      const account = await stripeRefundRequest(() => stripe.accounts.retrieveCurrent())
      if (account.id !== accountId) throw new PaymentRefundProviderError(false)
      // The account lookup awaited I/O. Revalidate the lease before sending the write.
      if (!(await input.canDispatch().catch(() => false)))
        throw new PaymentRefundProviderError(true)
      const refund = await stripeRefundRequest(() =>
        stripe.refunds.create(
          {
            payment_intent: input.paymentReference,
            amount: input.amountMinor,
            metadata: { [obligationMetadata]: input.obligationId },
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      )
      const observed = parseStripeRefundObservation(refund, mode)
      if (
        !observed ||
        observed.obligationId !== input.obligationId ||
        observed.paymentReference !== input.paymentReference ||
        observed.amountMinor !== input.amountMinor ||
        observed.currency !== input.currency
      )
        throw new PaymentRefundProviderError(false)
      return observed
    },
  }
}
