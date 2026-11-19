import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { getPublicRoutingForm } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { routingFormsGuard } from '../routing-forms.ts'
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
  routingFormsEnabled,
}: {
  db: Db
  pageLimit: MiddlewareHandler
  routingFormsEnabled: boolean
}): RouteModule {
  const security: Record<string, string[]>[] = [{}, { apiKey: [] }]
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
