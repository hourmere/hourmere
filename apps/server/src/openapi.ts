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
 * A group of /api/v1 routes. The composition root (index.ts) creates each module with the
 * services it needs; createApp registers it and passes what every route shares.
 */
export type RouteModule = (shared: { app: OpenAPIHono; caller: CallerMiddleware }) => void
