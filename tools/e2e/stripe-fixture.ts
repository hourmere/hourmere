import { createHmac, randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { runPaymentRefunds } from '@hourmere/scheduling'
import { StripeConfig } from '../../apps/server/src/stripe-config.ts'
import { createStripeRefundProvider } from '../../apps/server/src/stripe-refunds.ts'

export const CHECKOUT_FIXTURE_ORIGIN = 'https://checkout.stripe.com'

/** Local responses shaped like Stripe's documented snapshot events and API objects.
 * https://docs.stripe.com/api/checkout/sessions/object
 * https://docs.stripe.com/api/refunds/object
 * https://docs.stripe.com/webhooks/signature
 */
export function stripeFixture(appUrl: string, db: Db) {
  const accountId = 'acct_hourmerebrowserfixture'
  const apiKey = ['rk', 'test', randomBytes(24).toString('hex')].join('_')
  const secret = ['whsec', randomBytes(24).toString('hex')].join('_')
  const config = new StripeConfig(accountId, 'test', apiKey, secret)
  type Session = {
    id: string
    object: 'checkout.session'
    livemode: false
    mode: string | null
    ui_mode: string | null
    amount_total: number
    currency: string | null
    expires_at: number
    client_reference_id: string | null
    metadata: Record<string, string | null>
    status: 'open' | 'complete'
    payment_status: 'unpaid' | 'paid'
    payment_intent: string | null
    success_url: string
    cancel_url: string
    url: string | null
  }
  const sessions = new Map<string, Session>()
  let creates = 0
  let refunds = 0
  const eventIds = new Map<string, string>()

  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.stripe.com') throw new Error('Unexpected mock provider origin')
    if (init?.method === 'GET' && ['/v1/account', '/v1/accounts'].includes(url.pathname))
      return Response.json({ object: 'account', id: accountId })
    const form = new URLSearchParams(String(init?.body ?? ''))
    if (init?.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      creates++
      const id = `cs_test_fixture${creates}`
      const session: Session = {
        id,
        object: 'checkout.session',
        livemode: false,
        mode: form.get('mode'),
        ui_mode: form.get('ui_mode'),
        amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
        currency: form.get('line_items[0][price_data][currency]'),
        expires_at: Number(form.get('expires_at')),
        client_reference_id: form.get('client_reference_id'),
        metadata: {
          hourmere_booking_id: form.get('metadata[hourmere_booking_id]'),
          hourmere_checkout_attempt_id: form.get('metadata[hourmere_checkout_attempt_id]'),
        },
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: null,
        success_url: form.get('success_url') ?? '',
        cancel_url: form.get('cancel_url') ?? '',
        url: `${CHECKOUT_FIXTURE_ORIGIN}/c/pay/${id}`,
      }
      sessions.set(id, session)
      return Response.json(session)
    }
    if (init?.method === 'GET' && url.pathname === '/v1/checkout/sessions')
      return Response.json({ object: 'list', data: [...sessions.values()], has_more: false })
    if (init?.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const session = sessions.get(url.pathname.split('/').at(-1) ?? '')
      if (session) return Response.json(session)
    }
    if (init?.method === 'POST' && url.pathname === '/v1/refunds') {
      const session = [...sessions.values()].find(
        (item) => item.payment_intent && item.payment_intent === form.get('payment_intent'),
      )
      if (!session) throw new Error('Test refund did not name a paid fixture Session')
      refunds++
      return Response.json({
        id: `re_fixture${refunds}`,
        object: 'refund',
        amount: Number(form.get('amount')),
        currency: session.currency,
        payment_intent: session.payment_intent,
        status: 'succeeded',
        metadata: {
          hourmere_refund_obligation_id: form.get('metadata[hourmere_refund_obligation_id]'),
        },
      })
    }
    throw new Error('Unexpected mock Stripe operation')
  }

  function latest() {
    const value = [...sessions.values()].at(-1)
    if (!value) throw new Error('Test did not create a Checkout Session')
    return value
  }

  return {
    transport,
    env: {
      PAID_BOOKINGS_ENABLED: 'true',
      STRIPE_ACCOUNT_ID: accountId,
      STRIPE_MODE: 'test',
      STRIPE_API_KEY: apiKey,
      STRIPE_WEBHOOK_SIGNING_SECRET: secret,
    },
    checkoutSummary: () => ({
      amountMinor: latest().amount_total,
      currency: latest().currency,
      creates,
      refunds,
    }),
    returnUrl: (cancel: boolean) => {
      const target = new URL(cancel ? latest().cancel_url : latest().success_url)
      if (target.origin !== appUrl || target.pathname !== '/booking/payment')
        throw new Error('Invalid fixture Checkout return destination')
      return target.href
    },
    async complete() {
      const session = latest()
      let eventId = eventIds.get(session.id)
      if (!eventId) {
        eventId = `evt_fixture${eventIds.size + 1}`
        eventIds.set(session.id, eventId)
      }
      session.status = 'complete'
      session.payment_status = 'paid'
      session.payment_intent = `pi_fixture${eventIds.size}`
      session.url = null
      const body = JSON.stringify({
        id: eventId,
        type: 'checkout.session.completed',
        object: 'event',
        livemode: false,
        data: { object: session },
      })
      const time = Math.floor(Date.now() / 1000)
      const digest = createHmac('sha256', secret).update(`${time}.${body}`).digest('hex')
      const response = await fetch(`${appUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${time},v1=${digest}`,
        },
        body,
      })
      // Close the owned socket while keeping response data out of test output.
      await response.arrayBuffer()
      return response.status
    },
    async runRefunds() {
      await runPaymentRefunds(db, createStripeRefundProvider(config, transport))
    },
  }
}
