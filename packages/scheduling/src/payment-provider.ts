import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export type PaymentMode = 'test' | 'live'

/** The Stripe deadline includes rounding and creation grace. Capacity uses the DB deadline. */
export function checkoutSessionExpiry(expiresAt: string): number {
  return Math.ceil(Date.parse(expiresAt) / 1000) + 15
}

/** Durable operation fields only. No attendee contact details or provider credentials. */
export interface CheckoutOperation {
  attemptId: string
  bookingId: string
  accountId: string
  mode: PaymentMode
  amountMinor: number
  currency: string
  expiresAt: string
  idempotencyKey: string
  startedAt: string
}

export interface CheckoutSession {
  sessionId: string
  /** Hosted checkout capability, available only while the Session is open. */
  url: string | null
}

/** Internal adapter boundary. Every observation must match the durable operation. */
export interface PaymentProvider {
  readonly accountId: string
  readonly mode: PaymentMode
  createCheckout(input: CheckoutOperation): Promise<CheckoutSession>
  findCheckout(input: CheckoutOperation): Promise<CheckoutSession | null>
  retrieveCheckout(input: CheckoutOperation, sessionId: string): Promise<CheckoutSession>
}

/** In-memory test double with stable operation replays and no network I/O. */
export class FakePaymentProvider implements PaymentProvider {
  private checkouts = new Map<string, { input: CheckoutOperation; result: CheckoutSession }>()
  private refunds = new Map<string, { input: string; result: { refundId: string } }>()

  readonly accountId: string
  readonly mode: PaymentMode

  constructor(accountId = 'acct_fake', mode: PaymentMode = 'test') {
    this.accountId = accountId
    this.mode = mode
  }

  private verifyBinding(input: CheckoutOperation) {
    if (input.accountId !== this.accountId || input.mode !== this.mode)
      throw new Error('Checkout account or mode mismatch')
  }

  async createCheckout(input: CheckoutOperation) {
    this.verifyBinding(input)
    const previous = this.checkouts.get(input.idempotencyKey)
    if (previous) {
      if (!isDeepStrictEqual(previous.input, input)) throw new Error('Idempotency key reused')
      return previous.result
    }
    const result = {
      sessionId: `cs_fake_${randomUUID().replaceAll('-', '')}`,
      url: 'https://checkout.invalid/fake',
    }
    this.checkouts.set(input.idempotencyKey, { input: { ...input }, result })
    return result
  }

  async findCheckout(input: CheckoutOperation) {
    this.verifyBinding(input)
    const previous = this.checkouts.get(input.idempotencyKey)
    if (!previous) return null
    if (!isDeepStrictEqual(previous.input, input)) throw new Error('Checkout binding mismatch')
    return previous.result
  }

  async retrieveCheckout(input: CheckoutOperation, sessionId: string) {
    const result = await this.findCheckout(input)
    if (result?.sessionId !== sessionId) throw new Error('Checkout Session mismatch')
    return result
  }

  async expireCheckout(_sessionId: string) {}
  async retrievePayment(_paymentReference: string) {
    return { paid: true, amountMinor: 100, currency: 'usd' }
  }
  async refund(input: { paymentReference: string; idempotencyKey: string }) {
    const previous = this.refunds.get(input.idempotencyKey)
    if (previous) {
      if (previous.input !== JSON.stringify(input)) throw new Error('Idempotency key reused')
      return previous.result
    }
    const result = { refundId: `re_fake_${this.refunds.size + 1}` }
    this.refunds.set(input.idempotencyKey, { input: JSON.stringify(input), result })
    return result
  }
  async verifyWebhook(rawBody: string, signature: string) {
    if (signature !== 'fake-valid-signature') throw new Error('Invalid signature')
    return JSON.parse(rawBody) as {
      eventId: string
      paymentReference: string
      bookingId: string
      type: 'paid' | 'failed'
      amountMinor: number
      currency: string
    }
  }
}
