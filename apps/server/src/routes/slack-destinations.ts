import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  createSlackDestination,
  deleteSlackDestination,
  listSlackDestinations,
  SlackCreateInput,
  SlackUpdateInput,
  testSlackDestination,
  updateSlackDestination,
  WEBHOOK_EVENTS,
  type WebhookQueue,
  type WebhookSettings,
} from '@hourmere/webhooks'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextAccess,
  organizationContextWriteLock,
} from '../team-management.ts'

export const SlackDestination = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .extend({ eventTypeId: z.uuid().nullable() })
  .openapi('SlackDestination')
const Params = z.object({ id: z.string() })
const ExpectedReadHeaders = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Optional organization where the page opened. Session reads return 409 organization_context_changed for a still-authorized expected team after switching spaces, or uniform 403 team_management_access_denied for inaccessible expected teams and any different expected personal organization. Omitted headers preserve current-organization reads. Ignored for API keys.',
  }),
})
const ExpectedWriteHeaders = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Organization where the action opened. Required for session writes, including personal organizations; missing or malformed context returns 409 organization_context_changed. A stale expected team the caller still owns/administers, or the caller’s own personal organization, returns 409. Inaccessible expected teams and another user’s personal organization receive uniform 403 team_management_access_denied. Ignored for API keys.',
  }),
})
const errors = errorResponses({
  400: 'invalid_slack_destination or invalid_request',
  403: `insufficient_role for API keys or session reads without the context header; team_management_access_denied for session context checks, including ordinary-member writes; ${CROSS_ORIGIN_WRITE}`,
  404: 'slack_destination_not_found',
  409: 'slack_unavailable, slack_destination_exists, slack_destination_disabled or organization_context_changed',
})

/** Organization-wide outbound booking events; ordinary hosts have no administrative access. */
export function slackDestinationRoutes(
  deps: ServiceDeps & WebhookSettings & { queue?: WebhookQueue },
): RouteModule {
  const writeContext = (principal: Principal, expectedOrganizationId?: string) => ({
    ...serviceContext(deps, principal),
    prepareOrganizationWrite: async (trx: Db) => {
      // Fence native context transitions before taking any user/organization locks.
      await organizationContextWriteLock(principal)(trx)
      await organizationContextAccess(
        principal,
        expectedOrganizationId,
        true,
      )(trx, principal.organization.id)
    },
    authorizeOrganizationWrite: organizationContextAccess(
      principal,
      expectedOrganizationId,
      true,
      'key share',
    ),
  })
  const readContext = async (principal: Principal, expectedOrganizationId?: string) => {
    await organizationContextAccess(principal, expectedOrganizationId)(
      deps.db,
      principal.organization.id,
    )
    return serviceContext(deps, principal)
  }
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/slack-destinations',
        tags: ['Slack'],
        operationId: 'listSlackDestinations',
        summary: 'List the current organization’s Slack destinations (owner/admin)',
        security: authenticated,
        middleware: caller,
        request: { headers: ExpectedReadHeaders },
        responses: {
          200: {
            description: 'Endpoints, without secrets',
            content: json(z.array(SlackDestination)),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await listSlackDestinations(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/slack-destinations',
        tags: ['Slack'],
        operationId: 'createSlackDestination',
        summary: 'Create a Slack destination; always return a masked URL',
        description:
          'Only supported Slack incoming-webhook HTTPS URLs are accepted. Every delivery revalidates the URL and all resolved addresses; redirects are never followed.',
        security: authenticated,
        middleware: caller,
        request: {
          headers: ExpectedWriteHeaders,
          body: { required: true, content: json(SlackCreateInput) },
        },
        responses: {
          201: {
            description: 'Destination with masked URL',
            content: json(SlackDestination),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await createSlackDestination(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            deps,
            c.req.valid('json'),
          ),
          201,
        ),
    )

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/slack-destinations/{id}',
        tags: ['Slack'],
        operationId: 'updateSlackDestination',
        summary: 'Change a Slack destination or its subscriptions',
        security: authenticated,
        middleware: caller,
        request: {
          params: Params,
          headers: ExpectedWriteHeaders,
          body: { required: true, content: json(SlackUpdateInput) },
        },
        responses: {
          200: { description: 'Updated endpoint', content: json(SlackDestination) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await updateSlackDestination(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('json'),
            deps,
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/slack-destinations/{id}',
        tags: ['Slack'],
        operationId: 'deleteSlackDestination',
        summary: 'Delete a Slack destination and its retained deliveries',
        security: authenticated,
        middleware: caller,
        request: { params: Params, headers: ExpectedWriteHeaders },
        responses: {
          204: { description: 'Deleted; pending delivery jobs safely skip' },
          ...errors,
        },
      }),
      async (c) => {
        await deleteSlackDestination(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
        )
        return c.body(null, 204)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/slack-destinations/{id}/test',
        tags: ['Slack'],
        operationId: 'testSlackDestination',
        summary: 'Queue one sample notification through the delivery outbox',
        security: authenticated,
        middleware: caller,
        request: { params: Params, headers: ExpectedWriteHeaders },
        responses: {
          202: {
            description: 'Sample queued; delivery is asynchronous',
            content: json(z.object({ deliveryId: z.uuid() })),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await testSlackDestination(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            deps,
            c.req.valid('param').id,
            deps.queue,
          ),
          202,
        ),
    )
  }
}
