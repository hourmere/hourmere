import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import { type ConferenceDeps, deauthorizeZoomConnections } from '@hourmere/conferences'
import { routeBodyLimit } from '../body-limit.ts'
import type { RouteModule } from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

export const ZOOM_EVENTS_PATH = '/api/conference/zoom/events'
const MAX_CLOCK_SKEW_SECONDS = 300
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const eventSchema = z.object({ event: z.string().min(1).max(128), payload: z.unknown() })
const deauthorization = z.object({
  user_id: identity,
  account_id: identity,
  client_id: z.string().max(256).optional(),
  deauthorization_time: z.iso.datetime({ offset: true }).refine((value) => {
    try {
      Temporal.Instant.from(value)
      return true
    } catch {
      return false
    }
  }),
})
const challenge = z.object({ plainToken: z.string().min(1).max(1024) })

/** Zoom's protocol endpoint is independent of browser OAuth and meeting provisioning. */
export function zoomEventRoutes({
  db,
  secretToken,
  clientId,
  now = Date.now,
}: Pick<ConferenceDeps, 'db'> & {
  secretToken?: string | undefined
  clientId?: string | undefined
  now?: () => number
}): RouteModule {
  // Zoom does not retry 4xx responses; overload must remain a retryable failure.
  const limit = rateLimit(createRateLimiter({ limit: 120, windowSeconds: 60 }, { now }), {
    refusalStatus: 503,
  })
  return ({ app }) => {
    if (!secretToken) return
    app.post(
      ZOOM_EVENTS_PATH,
      async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        await next()
      },
      limit,
      routeBodyLimit(16 * 1024),
      async (c) => {
        const timestamp = c.req.header('x-zm-request-timestamp') ?? ''
        const signature = c.req.header('x-zm-signature') ?? ''
        if (
          !/^\d{1,12}$/.test(timestamp) ||
          Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS ||
          !/^v0=[a-f0-9]{64}$/.test(signature)
        )
          return c.json({ error: 'unauthorized' }, 401)

        // Authenticate the exact bytes sent, before parsing or using any payload fields.
        const body = Buffer.from(await c.req.arrayBuffer())
        const expected = createHmac('sha256', secretToken)
          .update(`v0:${timestamp}:`)
          .update(body)
          .digest()
        if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex')))
          return c.json({ error: 'unauthorized' }, 401)

        let value: unknown
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        } catch {
          return c.json({ error: 'invalid_request' }, 400)
        }
        const parsed = eventSchema.safeParse(value)
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const { event, payload } = parsed.data
        if (event === 'endpoint.url_validation') {
          const parsed = challenge.safeParse(payload)
          if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
          const { plainToken } = parsed.data
          return c.json({
            plainToken,
            encryptedToken: createHmac('sha256', secretToken).update(plainToken).digest('hex'),
          })
        }
        if (event === 'app_deauthorized') {
          const parsed = deauthorization.safeParse(payload)
          if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
          if (clientId && parsed.data.client_id !== clientId) return c.json({})
          try {
            await deauthorizeZoomConnections(
              { db },
              {
                userId: parsed.data.user_id,
                accountId: parsed.data.account_id,
                deauthorizationTime: parsed.data.deauthorization_time,
              },
            )
          } catch {
            // Database exceptions can echo bound identity values. Log only this fixed label;
            // returning a failure allows Zoom to retry without retaining an event record.
            console.error('Zoom deauthorization cleanup failed')
            return c.json({ error: 'internal_error' }, 500)
          }
        }
        return c.json({})
      },
    )
  }
}
