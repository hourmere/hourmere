import type { OpenAPIHono } from '@hono/zod-openapi'
import { z } from '@hono/zod-openapi'
import type { requireCaller } from './caller.ts'

// See docs/api-conventions.md.
export const ErrorBody = z
  .object({
    error: z.string().openapi({ description: 'Machine-readable code, e.g. unauthorized' }),
    message: z.string().optional().openapi({ description: 'Human-readable detail' }),
  })
  .openapi('Error')

export const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

// Typed explicitly: an inferred literal type here makes createRoute lose the middleware's
// types (c.var.principal).
export const authenticated: Record<string, string[]>[] = [{ apiKey: [] }, { session: [] }]

/** The middleware that authenticates a route and provides c.var.principal. */
export type CallerMiddleware = ReturnType<typeof requireCaller>

/**
 * A group of /api/v1 routes. The composition root (server.ts) creates each module with the
 * services it needs; createApp registers it and passes what every route shares.
 *
 * Rules for modules:
 * - Only register routes (`app.openapi(createRoute(...), handler)`); never `app.use` or
 *   `app.onError`, which would leak into routes registered after the module.
 * - Authenticated routes set both `security: authenticated` (so they are documented) and
 *   `middleware: caller` (which provides `c.var.principal`).
 * - Declare inputs as zod schemas on the route; failures answer 400 `invalid_request`.
 * - Call the service layer and let its DomainErrors propagate; createApp maps them.
 */
export type RouteModule = (shared: { app: OpenAPIHono; caller: CallerMiddleware }) => void
