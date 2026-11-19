import { inspect } from 'node:util'
import type { CheckoutOperation } from '@hourmere/scheduling'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStripePaymentProvider } from './stripe-checkout.ts'
import { StripeConfig } from './stripe-config.ts'

const apiKey = ['rk', 'test', 'synthetic'.repeat(4)].join('_')
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const accountId = 'acct_hourmerefixture'
const referenceTime = Date.parse('2026-11-18T18:00:00.123Z')
const expiry = '2026-11-18T18:30:00.123Z'
const stripeExpiresAt = Date.parse('2026-11-18T18:30:16Z') / 1000
const attempt = {
  attemptId: '37754d11-23d4-4031-bf53-d32a8e1f568d',
  bookingId: '03223ea4-e9c7-4792-ad68-2c869067dd4b',
  accountId,
  mode: 'test',
  amountMinor: 4242,
  currency: 'jpy',
  expiresAt: expiry,
  idempotencyKey: 'checkout_37754d11-23d4-4031-bf53-d32a8e1f568d',
  startedAt: '2026-11-18T18:00:00.234Z',
} satisfies CheckoutOperation

const session = {
  id: 'cs_test_hourmerefixture',
  object: 'checkout.session',
  livemode: false,
  mode: 'payment',
  ui_mode: 'hosted_page',
  amount_total: attempt.amountMinor,
  currency: attempt.currency,
  expires_at: stripeExpiresAt,
  client_reference_id: attempt.attemptId,
  metadata: {
    hourmere_checkout_attempt_id: attempt.attemptId,
    hourmere_booking_id: attempt.bookingId,
  },
  status: 'open',
  url: 'https://checkout.stripe.com/c/pay/cs_test_hourmerefixture',
}

function stubStripe(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://api.stripe.com')
    expect(new Headers(init?.headers).has('Stripe-Account')).toBe(false)
    expect(init?.redirect).toBe('error')
    return handler(url, init)
  })
  const provider = createStripePaymentProvider(
    new StripeConfig(accountId, 'test', apiKey, signingSecret),
    'https://scheduling.example',
    http,
  )
  return { provider, http }
}

const ownAccount = () => Response.json({ id: accountId, object: 'account' })

describe('Stripe Checkout adapter via the SDK HTTP transport', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(referenceTime))
  afterEach(() => vi.restoreAllMocks())

  it('creates a hosted immediate card payment from the hold snapshot and retained key', async () => {
    const { provider, http } = stubStripe((url) => {
      if (url.pathname === '/v1/account') return ownAccount()
      expect(url.pathname).toBe('/v1/checkout/sessions')
      return Response.json(session)
    })
    expect(http).not.toHaveBeenCalled()
    await expect(provider.createCheckout(attempt)).resolves.toEqual({
      sessionId: session.id,
      url: session.url,
    })
    expect(http).toHaveBeenCalledTimes(2)
    const request = http.mock.calls[1]?.[1]
    expect(request?.method).toBe('POST')
    const headers = new Headers(request?.headers)
    expect(headers.get('Idempotency-Key')).toBe(attempt.idempotencyKey)
    const body = new URLSearchParams(String(request?.body))
    expect(Object.fromEntries(body)).toMatchObject({
      mode: 'payment',
      ui_mode: 'hosted_page',
      'allowed_payment_method_types[0]': 'card',
      'adaptive_pricing[enabled]': 'false',
      'automatic_tax[enabled]': 'false',
      'payment_intent_data[capture_method]': 'automatic',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][unit_amount]': String(attempt.amountMinor),
      'line_items[0][price_data][currency]': attempt.currency,
      expires_at: String(stripeExpiresAt),
      success_url: 'https://scheduling.example/',
      cancel_url: 'https://scheduling.example/',
      client_reference_id: attempt.attemptId,
      'metadata[hourmere_checkout_attempt_id]': attempt.attemptId,
      'metadata[hourmere_booking_id]': attempt.bookingId,
    })
    expect(
      [...body.keys()].filter((key) => key.startsWith('allowed_payment_method_types')),
    ).toEqual(['allowed_payment_method_types[0]'])
    expect(body.has('customer_email')).toBe(false)
  })

  it('checks the local attempt mode and account before issuing requests', async () => {
    const { provider, http } = stubStripe(ownAccount)
    const error = { code: 'payment_provider_binding_mismatch' }
    await expect(provider.createCheckout({ ...attempt, mode: 'live' })).rejects.toMatchObject(error)
    await expect(
      provider.findCheckout({ ...attempt, accountId: 'acct_other' }),
    ).rejects.toMatchObject(error)
    expect(http).not.toHaveBeenCalled()
  })

  it('rejects a credential from another account before creating a Session', async () => {
    const { provider, http } = stubStripe(() =>
      Response.json({ id: 'acct_other', object: 'account' }),
    )
    await expect(provider.createCheckout(attempt)).rejects.toMatchObject({
      code: 'payment_provider_binding_mismatch',
    })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('checks that enough of the hold remains after verifying the account', async () => {
    const { provider, http } = stubStripe(() => {
      vi.mocked(Date.now).mockReturnValue(referenceTime + 5000)
      return ownAccount()
    })
    await expect(provider.createCheckout(attempt)).rejects.toMatchObject({
      code: 'payment_checkout_window_too_short',
    })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it.each([{ livemode: true }, { amount_total: 1234 }, { currency: 'usd' }])(
    'rejects a Session with a mismatched binding: %j',
    async (override) => {
      const { provider } = stubStripe((url) =>
        url.pathname === '/v1/account' ? ownAccount() : Response.json({ ...session, ...override }),
      )
      await expect(provider.createCheckout(attempt)).rejects.toMatchObject({
        code: 'payment_provider_binding_mismatch',
      })
    },
  )

  it('reconciles against a bounded Session creation range and can recover a closed Session ID', async () => {
    const unrelated = {
      ...session,
      id: 'cs_test_unrelated',
      client_reference_id: 'unrelated',
      metadata: {},
    }
    const closed = { ...session, status: 'expired', url: null }
    const { provider, http } = stubStripe((url, init) => {
      if (url.pathname === '/v1/account') return ownAccount()
      expect(init?.method).toBe('GET')
      if (url.pathname.endsWith(session.id)) return Response.json(closed)
      expect(url.pathname).toBe('/v1/checkout/sessions')
      expect(url.searchParams.get('created[gte]')).toBe(
        String(Math.floor(referenceTime / 1000) - 5),
      )
      expect(url.searchParams.get('created[lte]')).toBe(String(stripeExpiresAt - 1800))
      if (url.searchParams.get('starting_after') === unrelated.id)
        return Response.json({ object: 'list', data: [closed], has_more: false })
      return Response.json({ object: 'list', data: [unrelated], has_more: true })
    })
    const recovered = { sessionId: session.id, url: null }
    await expect(provider.findCheckout(attempt)).resolves.toEqual(recovered)
    await expect(provider.retrieveCheckout(attempt, session.id)).resolves.toEqual(recovered)
    expect(http).toHaveBeenCalledTimes(5)
  })

  it('treats a duplicate opaque attempt reference as an inconclusive reconciliation', async () => {
    const { provider } = stubStripe((url) =>
      url.pathname === '/v1/account'
        ? ownAccount()
        : Response.json({
            object: 'list',
            data: [session, { ...session, id: 'cs_test_duplicate' }],
            has_more: false,
          }),
    )
    await expect(provider.findCheckout(attempt)).rejects.toMatchObject({
      code: 'payment_checkout_reconciliation_inconclusive',
    })
  })

  it('removes provider request and response details from errors and issues no SDK retries', async () => {
    const { provider, http } = stubStripe((url) =>
      url.pathname === '/v1/account'
        ? ownAccount()
        : Response.json(
            {
              error: { type: 'api_error', message: `private response ${apiKey} ${signingSecret}` },
            },
            { status: 500 },
          ),
    )
    const error = await provider.createCheckout(attempt).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ message: 'Stripe checkout request failed' })
    expect(inspect(error).includes(apiKey)).toBe(false)
    expect(inspect(error).includes(signingSecret)).toBe(false)
    expect(http).toHaveBeenCalledTimes(2)
  })

  it('leaves an ambiguous connection reset for reconciliation without replaying the POST', async () => {
    const { provider, http } = stubStripe((url) => {
      if (url.pathname === '/v1/account') return ownAccount()
      throw Object.assign(new Error('Connection reset after POST'), { code: 'ECONNRESET' })
    })
    await expect(provider.createCheckout(attempt)).rejects.toThrow('Stripe checkout request failed')
    expect(http).toHaveBeenCalledTimes(2)
  })
})
