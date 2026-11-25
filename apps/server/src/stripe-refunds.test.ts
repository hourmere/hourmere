import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { StripeConfig } from './stripe-config.ts'
import { createStripeRefundProvider } from './stripe-refunds.ts'

const accountId = 'acct_hourmerefixture'
const apiKey = ['rk', 'test', 'synthetic'.repeat(4)].join('_')
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const obligationId = '37754d11-23d4-4031-bf53-d32a8e1f568d'
const input = {
  obligationId,
  accountId,
  mode: 'test',
  paymentReference: 'pi_synthetic',
  amountMinor: 4242,
  currency: 'jpy',
  idempotencyKey: `hourmere_refund_${obligationId}`,
  canDispatch: async () => true,
}

// https://docs.stripe.com/api/refunds/create
// https://docs.stripe.com/api/refunds/object
const refund = {
  id: 're_synthetic',
  object: 'refund',
  amount: input.amountMinor,
  currency: input.currency,
  payment_intent: input.paymentReference,
  metadata: { hourmere_refund_obligation_id: input.obligationId },
  status: 'pending',
}

function stubStripe(handler: (url: URL, init?: RequestInit) => Response) {
  const transport = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target))
    expect(url.origin).toBe('https://api.stripe.com')
    expect(new Headers(init?.headers).has('Stripe-Account')).toBe(false)
    expect(init?.redirect).toBe('error')
    return handler(url, init)
  })
  const provider = createStripeRefundProvider(
    new StripeConfig(accountId, 'test', apiKey, signingSecret),
    transport,
  )
  return { provider, transport }
}

const ownAccount = () => Response.json({ object: 'account', id: accountId })

describe('Stripe Refund adapter via the SDK HTTP transport', () => {
  it('submits the exact retained amount for the PaymentIntent with a stable key and binding', async () => {
    const { provider, transport } = stubStripe((url) => {
      if (url.pathname === '/v1/account') return ownAccount()
      expect(url.pathname).toBe('/v1/refunds')
      return Response.json(refund)
    })
    expect(transport).not.toHaveBeenCalled()
    await expect(provider.createRefund(input)).resolves.toEqual({
      id: refund.id,
      obligationId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paymentReference: input.paymentReference,
      state: 'pending',
    })
    expect(transport).toHaveBeenCalledTimes(2)
    const request = transport.mock.calls[1]?.[1]
    expect(request?.method).toBe('POST')
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe(input.idempotencyKey)
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      amount: String(input.amountMinor),
      payment_intent: input.paymentReference,
      'metadata[hourmere_refund_obligation_id]': input.obligationId,
    })
  })

  it('checks the obligation and credential account before any refund write', async () => {
    const { provider, transport } = stubStripe(() =>
      Response.json({ object: 'account', id: 'acct_other' }),
    )
    await expect(provider.createRefund({ ...input, mode: 'live' })).rejects.toMatchObject({
      transient: false,
    })
    expect(transport).not.toHaveBeenCalled()
    await expect(provider.createRefund(input)).rejects.toMatchObject({ transient: false })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('skips the refund write if the lease expires during account verification', async () => {
    const { provider, transport } = stubStripe(() => ownAccount())
    await expect(
      provider.createRefund({ ...input, canDispatch: async () => false }),
    ).rejects.toMatchObject({ transient: true })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it.each([
    { amount: 1 },
    { payment_intent: 'pi_other' },
    { livemode: true },
    { currency: 'usd' },
    { metadata: {} },
    { status: null },
  ])('fails closed for a mismatched refund response: %j', async (override) => {
    const { provider } = stubStripe((url) =>
      url.pathname === '/v1/account' ? ownAccount() : Response.json({ ...refund, ...override }),
    )
    await expect(provider.createRefund(input)).rejects.toMatchObject({ transient: false })
  })

  // https://docs.stripe.com/api/errors
  it.each([
    [429, 'rate_limit_error', true],
    [500, 'api_error', true],
    [400, 'invalid_request_error', false],
  ])(
    'classifies HTTP %i and never exposes the SDK error or retries inside the adapter',
    async (status, type, transient) => {
      const { provider, transport } = stubStripe((url) =>
        url.pathname === '/v1/account'
          ? ownAccount()
          : Response.json(
              { error: { type, message: `private diagnostic ${apiKey} ${signingSecret}` } },
              { status },
            ),
      )
      const failure = await provider.createRefund(input).catch((error: unknown) => error)
      expect(failure).toMatchObject({ transient })
      expect(inspect(failure)).not.toContain(apiKey)
      expect(inspect(failure)).not.toContain(signingSecret)
      expect(transport).toHaveBeenCalledTimes(2)
    },
  )

  it('returns ambiguous transport failures to the durable worker for a bounded retry', async () => {
    const { provider, transport } = stubStripe((url) => {
      if (url.pathname === '/v1/account') return ownAccount()
      throw Object.assign(new Error('synthetic connection reset'), { code: 'ECONNRESET' })
    })
    await expect(provider.createRefund(input)).rejects.toMatchObject({ transient: true })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('treats a gateway response without a Stripe error body as transient', async () => {
    const { provider, transport } = stubStripe((url) =>
      url.pathname === '/v1/account' ? ownAccount() : new Response('Bad gateway', { status: 502 }),
    )
    await expect(provider.createRefund(input)).rejects.toMatchObject({ transient: true })
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
