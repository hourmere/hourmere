/** Future adapter boundary; implementations own credentials, never booking/database payloads. */
export interface PaymentProvider {
  createCheckout(input: {
    bookingId: string
    amountMinor: number
    currency: string
    expiresAt: string
    idempotencyKey: string
  }): Promise<{ sessionId: string; url: string }>
  expireCheckout(sessionId: string): Promise<void>
  retrievePayment(
    paymentReference: string,
  ): Promise<{ paid: boolean; amountMinor: number; currency: string }>
  refund(input: { paymentReference: string; idempotencyKey: string }): Promise<{ refundId: string }>
  verifyWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{
    eventId: string
    paymentReference: string
    bookingId: string
    type: 'paid' | 'failed'
    amountMinor: number
    currency: string
  }>
}

/** Deterministic in-memory test double; never performs network I/O. */
export class FakePaymentProvider implements PaymentProvider {
  private checkouts = new Map<
    string,
    { input: string; result: { sessionId: string; url: string } }
  >()
  private refunds = new Map<string, { input: string; result: { refundId: string } }>()
  async createCheckout(input: Parameters<PaymentProvider['createCheckout']>[0]) {
    const previous = this.checkouts.get(input.idempotencyKey)
    if (previous) {
      if (previous.input !== JSON.stringify(input)) throw new Error('Idempotency key reused')
      return previous.result
    }
    const result = {
      sessionId: `cs_fake_${this.checkouts.size + 1}`,
      url: 'https://checkout.invalid/fake',
    }
    this.checkouts.set(input.idempotencyKey, { input: JSON.stringify(input), result })
    return result
  }
  async expireCheckout(_sessionId: string) {}
  async retrievePayment(_paymentReference: string) {
    return { paid: true, amountMinor: 100, currency: 'usd' }
  }
  async refund(input: Parameters<PaymentProvider['refund']>[0]) {
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
    return JSON.parse(rawBody) as Awaited<ReturnType<PaymentProvider['verifyWebhook']>>
  }
}
