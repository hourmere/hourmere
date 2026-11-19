import { randomBytes } from 'node:crypto'
import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { getPublicRoutingForm, routingRequestKey } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'
import {
  RoutingSubmission,
  RoutingSubmissionResponse,
  routingFormsGuard,
  submitPublicRoutingForm,
} from '../routing-forms.ts'
import { ROUTING_FORMS_DISABLED, RoutingFormQuestion } from './routing-forms.ts'

const slug = z.string().openapi({ example: 'consultation' })
export const PersonalRoutingFormAddress = z.strictObject({
  handle: z.string().openapi({ example: 'ada' }),
  slug,
})
export const TeamRoutingFormAddress = z.strictObject({
  teamSlug: z.string().openapi({ example: 'advisory-team' }),
  slug,
})

export const PublicRoutingForm = z
  .object({
    versionId: z.guid(),
    title: z.string(),
    description: z.string().optional(),
    questions: z.array(RoutingFormQuestion),
  })
  .openapi('PublicRoutingForm')

export function publicRoutingFormRoutes({
  db,
  pageLimit,
  submissionRateLimit = PUBLIC_RATE_LIMITS.routingSubmission,
  routingFormsEnabled,
  routingSecret,
  publicUrl,
}: {
  db: Db
  pageLimit: MiddlewareHandler
  submissionRateLimit?: RateLimit | undefined
  routingFormsEnabled: boolean
  routingSecret?: string | undefined
  publicUrl: string
}): RouteModule {
  const security: Record<string, string[]>[] = [{}, { apiKey: [] }]
  const submissionBucket = createRateLimiter(submissionRateLimit)
  // Off fixtures and OpenAPI generation can omit a server secret.
  const submissionKey = routingSecret ?? randomBytes(32).toString('base64url')
  const submissionLimit = rateLimit(
    {
      hit: (key) =>
        submissionBucket.hit(routingRequestKey(submissionKey, 'routingSubmission', key)),
    },
    { beforeBodyLimit: true },
  )
  const metadataRoute = {
    method: 'get' as const,
    tags: ['Public'],
    description: `${ROUTING_FORMS_DISABLED} Reads the current published version and its ordered questions for an enabled form. Anonymous access is allowed. A supplied bearer must be a valid read, bookings or full API key.`,
    security,
    middleware: [pageLimit, routingFormsGuard(routingFormsEnabled)],
    responses: {
      200: { description: 'Public routing form metadata', content: json(PublicRoutingForm) },
      404: {
        description: 'routing_forms_disabled or routing_form_not_found',
        content: json(ErrorBody),
      },
      429: {
        description: 'rate_limited; see Retry-After',
        content: json(ErrorBody),
      },
    },
  }
  const submissionRoute = {
    method: 'post' as const,
    tags: ['Public'],
    description: `${ROUTING_FORMS_DISABLED} Routes answers for the specified published version and returns a message or an expiring continuation with its private URL. Fetch the current public form again after routing_form_changed. Anonymous access is allowed. A supplied bearer must be a valid bookings or full API key.`,
    security,
    middleware: [submissionLimit, routingFormsGuard(routingFormsEnabled)],
    responses: {
      200: { description: 'Routing outcome', content: json(RoutingSubmissionResponse) },
      400: {
        description: 'invalid_request or invalid_routing_answers',
        content: json(ErrorBody),
      },
      404: {
        description: 'routing_forms_disabled or routing_form_not_found',
        content: json(ErrorBody),
      },
      409: {
        description: 'routing_form_changed or routing_unavailable',
        content: json(ErrorBody),
      },
      413: { description: 'payload_too_large (maximum 65,536 bytes)', content: json(ErrorBody) },
      429: {
        description: 'rate_limited; see Retry-After when present',
        content: json(ErrorBody),
      },
    },
  }
  const body = { required: true, content: json(RoutingSubmission) }
  const submission = { db, routingFormsEnabled, routingSecret, publicUrl }

  return ({ app }) => {
    app.openapi(
      createRoute({
        ...metadataRoute,
        path: '/api/v1/public/-/routing/{handle}/{slug}',
        operationId: 'getPublicRoutingForm',
        summary: 'Read a public personal routing form',
        request: { params: PersonalRoutingFormAddress },
      }),
      async (c) => c.json(await getPublicRoutingForm(db, c.req.valid('param')), 200),
    )
    app.openapi(
      createRoute({
        ...submissionRoute,
        path: '/api/v1/public/-/routing/{handle}/{slug}/route',
        operationId: 'routeLead',
        summary: 'Submit answers to a public personal routing form',
        request: { params: PersonalRoutingFormAddress, body },
      }),
      async (c) =>
        c.json(
          await submitPublicRoutingForm(submission, c.req.valid('param'), c.req.valid('json')),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...submissionRoute,
        path: '/api/v1/public/-/routing/teams/{teamSlug}/{slug}/route',
        operationId: 'routeTeamLead',
        summary: 'Submit answers to a public team routing form',
        request: { params: TeamRoutingFormAddress, body },
      }),
      async (c) =>
        c.json(
          await submitPublicRoutingForm(submission, c.req.valid('param'), c.req.valid('json')),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...metadataRoute,
        path: '/api/v1/public/-/routing/teams/{teamSlug}/{slug}',
        operationId: 'getPublicTeamRoutingForm',
        summary: 'Read a public team routing form',
        request: { params: TeamRoutingFormAddress },
      }),
      async (c) => c.json(await getPublicRoutingForm(db, c.req.valid('param')), 200),
    )
  }
}
