import type { CheckoutOperation, CheckoutSession, PaymentProvider } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import Stripe from 'stripe'
import type { StripeConfig } from './stripe-config.ts'

const STRIPE_MIN_LIFETIME_SECONDS = 30 * 60
const STRIPE_EXPIRY_GRACE_SECONDS = 15
const MAX_HOLD_AGE_SECONDS = 5
const REQUEST_TIMEOUT_MS = 3000
const MAX_RECONCILIATION_PAGES = 3
const RECONCILIATION_CLOCK_SKEW_SECONDS = 5

// Stripe requires at least 30 minutes from its creation time. Hourmere holds are already
// committed by then and retain their original deadline. Only the provider deadline gets grace.
function stripeExpiry(input: CheckoutOperation): number {
  return Math.ceil(Date.parse(input.expiresAt) / 1000) + STRIPE_EXPIRY_GRACE_SECONDS
}

function bindingMismatch(): DomainError {
  return new DomainError('conflict', 'payment_provider_binding_mismatch')
}

function reconciliationInconclusive(): DomainError {
  return new DomainError('conflict', 'payment_checkout_reconciliation_inconclusive')
}

async function stripeRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch {
    // SDK errors can echo credentials, request data or provider responses.
    throw new Error('Stripe checkout request failed')
  }
}

function boundSession(input: CheckoutOperation, session: Stripe.Checkout.Session): CheckoutSession {
  if (
    !/^cs_[A-Za-z0-9_]+$/.test(session.id) ||
    session.livemode !== (input.mode === 'live') ||
    session.mode !== 'payment' ||
    session.ui_mode !== 'hosted_page' ||
    session.amount_total !== input.amountMinor ||
    session.currency !== input.currency ||
    session.expires_at !== stripeExpiry(input) ||
    session.client_reference_id !== input.attemptId ||
    session.metadata?.hourmere_checkout_attempt_id !== input.attemptId ||
    session.metadata?.hourmere_booking_id !== input.bookingId
  )
    throw bindingMismatch()

  if (session.status !== 'open' || session.url === null) return { sessionId: session.id, url: null }
  const url = URL.parse(session.url)
  if (url?.protocol !== 'https:' || url.username || url.password) throw bindingMismatch()
  return { sessionId: session.id, url: session.url }
}

/** Server-only factory. Creating a provider performs no network I/O. */
export function createStripePaymentProvider(
  config: StripeConfig,
  publicUrl: string,
  transport: typeof fetch = fetch,
): PaymentProvider {
  const origin = URL.parse(publicUrl)
  if (
    !origin ||
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error('Stripe Checkout requires a valid PUBLIC_URL')
  const returnUrl = new URL('/', origin).href
  const { accountId, mode } = config
  const stripe = new Stripe(config.apiKey(), {
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      try {
        return await transport(input, { ...init, redirect: 'error' })
      } catch {
        // Stripe retries some socket error codes even with maxNetworkRetries set to zero.
        // An ambiguous create must return to the hold service for reconciliation.
        throw new Error('Stripe checkout transport failed')
      }
    }),
    maxNetworkRetries: 0,
    telemetry: false,
    timeout: REQUEST_TIMEOUT_MS,
  })

  async function verifyAccount(input: CheckoutOperation) {
    if (input.accountId !== accountId || input.mode !== mode) throw bindingMismatch()
    // Check the credential's own account. A Connect header could select another merchant.
    const account = await stripeRequest(() => stripe.accounts.retrieveCurrent())
    if (account.id !== accountId) throw bindingMismatch()
  }

  return {
    accountId,
    mode,
    async createCheckout(input) {
      await verifyAccount(input)
      const latestStart =
        Date.parse(input.expiresAt) - (STRIPE_MIN_LIFETIME_SECONDS - MAX_HOLD_AGE_SECONDS) * 1000
      if (Date.now() >= latestStart)
        throw new DomainError('conflict', 'payment_checkout_window_too_short')
      const session = await stripeRequest(() =>
        stripe.checkout.sessions.create(
          {
            mode: 'payment',
            ui_mode: 'hosted_page',
            allowed_payment_method_types: ['card'],
            adaptive_pricing: { enabled: false },
            automatic_tax: { enabled: false },
            payment_intent_data: { capture_method: 'automatic' },
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: input.currency,
                  unit_amount: input.amountMinor,
                  product_data: { name: 'Booking' },
                },
              },
            ],
            expires_at: stripeExpiry(input),
            success_url: returnUrl,
            cancel_url: returnUrl,
            client_reference_id: input.attemptId,
            metadata: {
              hourmere_checkout_attempt_id: input.attemptId,
              hourmere_booking_id: input.bookingId,
            },
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      )
      return boundSession(input, session)
    },
    async findCheckout(input) {
      await verifyAccount(input)
      const created = {
        gte: Math.floor(Date.parse(input.startedAt) / 1000) - RECONCILIATION_CLOCK_SKEW_SECONDS,
        lte: stripeExpiry(input) - STRIPE_MIN_LIFETIME_SECONDS,
      }
      let cursor: string | undefined
      let found: CheckoutSession | null = null
      for (let page = 0; page < MAX_RECONCILIATION_PAGES; page++) {
        const sessions = await stripeRequest(() =>
          stripe.checkout.sessions.list({ created, limit: 100, starting_after: cursor }),
        )
        for (const session of sessions.data) {
          if (
            session.client_reference_id !== input.attemptId &&
            session.metadata?.hourmere_checkout_attempt_id !== input.attemptId
          )
            continue
          if (found) throw reconciliationInconclusive()
          found = boundSession(input, session)
        }
        if (!sessions.has_more) return found
        cursor = sessions.data.at(-1)?.id
        if (!cursor) break
      }
      throw reconciliationInconclusive()
    },
    async retrieveCheckout(input, sessionId) {
      await verifyAccount(input)
      const session = await stripeRequest(() => stripe.checkout.sessions.retrieve(sessionId))
      if (session.id !== sessionId) throw bindingMismatch()
      return boundSession(input, session)
    },
  }
}
