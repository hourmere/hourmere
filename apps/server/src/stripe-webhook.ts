import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { type BookingNotifier, recordStripePaymentEvent } from '@hourmere/scheduling'
import Stripe from 'stripe'
import { routeBodyLimit } from './body-limit.ts'
import { ErrorBody, json } from './openapi.ts'
import type { StripeConfig } from './stripe-config.ts'

const MAX_BODY_BYTES = 64 * 1024
const TOLERANCE_SECONDS = 300
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const acknowledged = { received: true } as const

export interface StripeWebhookDeps {
  db: Db
  config?: StripeConfig | undefined
  enabled: boolean
  notify?: BookingNotifier | undefined
}

const eventEnvelope = z.object({
  object: z.literal('event'),
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,200}$/),
  type: z.string(),
  livemode: z.boolean(),
  account: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  data: z.object({ object: z.unknown() }),
})

const sessionSnapshot = z.object({
  object: z.literal('checkout.session'),
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,200}$/),
  livemode: z.boolean(),
  mode: z.literal('payment'),
  // Stripe snapshot payloads use the destination's version, including older names.
  ui_mode: z.enum(['hosted_page', 'hosted']),
  status: z.string(),
  payment_status: z.string(),
  payment_intent: z.unknown(),
  amount_total: z.int().positive(),
  currency: z.string().regex(/^[a-z]{3}$/),
  expires_at: z.int().positive(),
  client_reference_id: z.uuid(),
  metadata: z.object({
    hourmere_booking_id: z.uuid(),
    hourmere_checkout_attempt_id: z.uuid(),
  }),
})

const paymentIntentId = z.string().regex(/^pi_[A-Za-z0-9_]{1,200}$/)

function checkoutObservation(event: z.infer<typeof eventEnvelope>) {
  const parsed = sessionSnapshot.safeParse(event.data.object)
  if (!parsed.success) return
  const session = parsed.data
  const { hourmere_booking_id: bookingId, hourmere_checkout_attempt_id: attemptId } =
    session.metadata
  if (session.livemode !== event.livemode || session.client_reference_id !== attemptId) return

  let paymentReference: string | null = null
  if (event.type === 'checkout.session.completed') {
    const intent = paymentIntentId.safeParse(session.payment_intent)
    if (session.status !== 'complete' || session.payment_status !== 'paid' || !intent.success)
      return
    paymentReference = intent.data
  } else if (session.status !== 'expired' || session.payment_status !== 'unpaid') {
    return
  }
  return {
    attemptId,
    bookingId,
    sessionId: session.id,
    amountMinor: session.amount_total,
    currency: session.currency,
    expiresAtSeconds: session.expires_at,
    paymentReference,
  }
}

function verifySnapshot(body: ArrayBuffer, header: string, secret: string): unknown {
  const now = Date.now()
  const parts = header.split(',').map((part) => part.trim())
  const timestamps = parts.filter((part) => part.startsWith('t='))
  const timestamp = timestamps[0]?.slice(2) ?? ''
  if (
    timestamps.length !== 1 ||
    !/^[1-9][0-9]{0,11}$/.test(timestamp) ||
    Number(timestamp) - Math.floor(now / 1000) > TOLERANCE_SECONDS
  )
    throw new Error('Invalid Stripe signature timestamp')

  // Strict UTF-8 preserves the exact bytes when the SDK encodes the string for HMAC.
  // Keep the BOM, if present, because even that byte sequence changes the signature.
  return Stripe.webhooks.constructEvent(
    utf8.decode(body),
    parts.join(','),
    secret,
    TOLERANCE_SECONDS,
    undefined,
    now,
  )
}

const stripeWebhookRoute = createRoute({
  method: 'post',
  path: '/api/webhooks/stripe',
  summary: 'Receive a signed Stripe snapshot event',
  description:
    'Stripe delivery endpoint for the configured account. Requires the exact raw body and endpoint signature. Available only when the operator enables the receiver.',
  parameters: [
    { in: 'header', name: 'Stripe-Signature', required: true, schema: { type: 'string' } },
  ],
  requestBody: {
    required: true,
    content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
  },
  middleware: [routeBodyLimit(MAX_BODY_BYTES)],
  responses: {
    200: {
      description: 'Delivery acknowledged',
      content: json(z.object({ received: z.literal(true) })),
    },
    400: { description: 'Invalid signature or event envelope', content: json(ErrorBody) },
    404: { description: 'Receiver disabled or unconfigured', content: json(ErrorBody) },
    413: { description: 'Body exceeds 64 KiB', content: json(ErrorBody) },
    503: { description: 'Delivery could not be persisted; retry', content: json(ErrorBody) },
  },
})

/** Stripe's transport is separate from browser, API key and OAuth request handling. */
export function mountStripeWebhook(app: OpenAPIHono, deps?: StripeWebhookDeps) {
  app.openapi(stripeWebhookRoute, async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!deps?.enabled || !deps.config) return c.json({ error: 'not_found' }, 404)
    const { config, db, notify } = deps
    const header = c.req.header('stripe-signature')
    if (!header) return c.json({ error: 'invalid_signature' }, 400)
    const body = await c.req.arrayBuffer()

    let snapshot: unknown
    try {
      snapshot = verifySnapshot(body, header, config.webhookSigningSecret())
    } catch {
      // The SDK's exception can contain the raw body and signature header.
      return c.json({ error: 'invalid_signature' }, 400)
    }
    const parsed = eventEnvelope.safeParse(snapshot)
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const event = parsed.data

    // Stripe omits `account` from direct account events. The endpoint secret authenticates
    // that account; reject foreign account and organization event-destination deliveries.
    if (
      event.livemode !== (config.mode === 'live') ||
      (event.account != null && event.account !== config.accountId) ||
      event.context != null
    )
      return c.json(acknowledged, 200)

    try {
      const ctx = { db, notify, now: () => Temporal.Now.instant() }
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.expired':
          await recordStripePaymentEvent(ctx, config, event.id, checkoutObservation(event))
          break
        case 'payment_intent.succeeded':
        case 'refund.updated':
        case 'refund.failed':
          // These snapshots cannot bind a Checkout Session on their own. Refund execution
          // and reconciliation will manage refund state; do not clear a pending obligation.
          await recordStripePaymentEvent(ctx, config, event.id)
          break
      }
    } catch {
      console.error('Stripe webhook processing failed')
      return c.json({ error: 'service_unavailable' }, 503)
    }
    return c.json(acknowledged, 200)
  })
}
