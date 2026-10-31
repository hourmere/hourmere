import type { OpenAPIHono } from '@hono/zod-openapi'
import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { QuestionSchema, type ServiceContext } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { routeBodyLimit } from './body-limit.ts'
import type { CallerEnv, requireCaller } from './caller.ts'
import { errorAliases } from './error-aliases.ts'

export const ErrorAlias = z.enum(Object.values(errorAliases)).openapi('ErrorAlias', {
  description:
    'Optional additive alias from the documented error-code set. The original error code remains unchanged throughout /api/v1. New aliases may be added; fall back to error when an alias is absent or unknown. See https://hourmere.com/docs/api-conventions for code meanings.',
})

// See https://hourmere.com/docs/api-conventions.
export const ErrorBody = z
  .object({
    error: z.string().openapi({ description: 'Machine-readable code, e.g. unauthorized' }),
    errorAlias: ErrorAlias.optional(),
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
 * `middleware` for an authenticated route that declares a body limit (routeBodyLimit). Typed
 * as a tuple: a plain array would make createRoute lose c.var.principal.
 */
export const callerWithBodyLimit = (
  caller: CallerMiddleware,
  maxBytes: number,
): [CallerMiddleware, MiddlewareHandler<CallerEnv>] => [caller, routeBodyLimit(maxBytes)]

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
 * - Read the body (the zod schema does) before anything with side effects, and never swallow
 *   a failed read: the body limit and the JSON text guard refuse a body while it is read
 *   (see checkBodyAsRead in body-limit.ts).
 * - Call the service layer and let its DomainErrors propagate; createApp maps them.
 */
export type RouteModule = (shared: { app: OpenAPIHono; caller: CallerMiddleware }) => void

/** What a route module needs to call the service layer; server.ts provides it. */
export interface ServiceDeps {
  db: Db
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
  followUpHostNotesEnabled?: ServiceContext['followUpHostNotesEnabled']
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  /** The clock; defaults to the real one. */
  now?: () => Temporal.Instant
}

/** The ServiceContext for the authenticated caller of a request. */
export function serviceContext(
  {
    db,
    now = () => Temporal.Now.instant(),
    automaticMeet,
    automaticZoom,
    successRedirectPolicy,
    followUpHostNotesEnabled,
  }: ServiceDeps,
  principal: Principal,
): ServiceContext {
  return {
    db,
    principal,
    now,
    automaticMeet,
    automaticZoom,
    successRedirectPolicy,
    followUpHostNotesEnabled,
  }
}

type ErrorStatus = 400 | 403 | 404 | 409

/**
 * Documents an authenticated route's error responses, all with the Error shape: the given
 * statuses (describe the codes a client may branch on) plus 401 and 429, which every
 * authenticated route can answer.
 */
export function errorResponses(descriptions: Partial<Record<ErrorStatus, string>>) {
  const responses: Partial<
    Record<ErrorStatus | 401 | 429, { description: string; content: ReturnType<typeof json> }>
  > = {}
  for (const [status, description] of Object.entries(descriptions)) {
    responses[Number(status) as ErrorStatus] = { description, content: json(ErrorBody) }
  }
  responses[401] = { description: 'No valid session or API key', content: json(ErrorBody) }
  responses[429] = { description: "The API key's rate limit is used up", content: json(ErrorBody) }
  return responses
}

/** Cookie-authenticated writes from another origin are refused (CSRF protection). */
export const CROSS_ORIGIN_WRITE = 'forbidden: a cookie-authenticated write from another origin'

/**
 * A booking-form question in responses (public pages and the owner-side API): the shared
 * format of questions.ts, but open, since responses may gain fields within /api/v1.
 */
export const Question = z.object(QuestionSchema.shape).openapi('Question', {
  description:
    'A booking-form field beyond name and email. Its answer goes in `responses` under `id`: text for short_text, long_text and phone; one of `options` for select; a list of distinct `options` for multi_select; true or false for checkbox (a required checkbox must be true).',
})
