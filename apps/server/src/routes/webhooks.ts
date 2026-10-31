import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  updateWebhook,
  WEBHOOK_EVENTS,
  WebhookCreateInput,
  type WebhookSettings,
  WebhookUpdateInput,
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

const Webhook = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Webhook')
const Secret = z.object({
  secret: z
    .string()
    .openapi({ description: 'Shown only once; store securely. Never returned by lists.' }),
})
const Delivery = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    eventType: z.enum(WEBHOOK_EVENTS),
    bookingId: z.uuid(),
    status: z.enum(['pending', 'delivered', 'failed', 'skipped']),
    attempts: z.number().int(),
    httpStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastAttemptAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
  })
  .openapi('WebhookDelivery')
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
  400: 'invalid_webhook or invalid_request',
  403: `insufficient_role for API keys or session reads without the context header; team_management_access_denied for session context checks, including ordinary-member writes; ${CROSS_ORIGIN_WRITE}`,
  404: 'webhook_not_found',
  409: 'webhooks_disabled, webhook_limit_reached or organization_context_changed',
})

/** Organization-wide outbound booking events; ordinary hosts have no administrative access. */
export function webhookRoutes(deps: ServiceDeps & WebhookSettings): RouteModule {
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
        path: '/api/v1/webhooks',
        tags: ['Webhooks'],
        operationId: 'listWebhooks',
        summary: 'List the current organization’s webhooks (owner/admin)',
        security: authenticated,
        middleware: caller,
        request: { headers: ExpectedReadHeaders },
        responses: {
          200: { description: 'Endpoints, without secrets', content: json(z.array(Webhook)) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await listWebhooks(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/webhooks',
        tags: ['Webhooks'],
        operationId: 'createWebhook',
        summary: 'Create a webhook and reveal its signing secret once',
        description:
          'Public HTTPS destinations by default. Operators may allow exact private HTTP(S) targets. URL checks do not resolve DNS; every delivery revalidates all resolved addresses. Destinations are immutable.',
        security: authenticated,
        middleware: caller,
        request: {
          headers: ExpectedWriteHeaders,
          body: { required: true, content: json(WebhookCreateInput) },
        },
        responses: {
          201: {
            description: 'Endpoint and one-time secret',
            content: json(Secret.extend({ webhook: Webhook })),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await createWebhook(
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
        path: '/api/v1/webhooks/{id}',
        tags: ['Webhooks'],
        operationId: 'updateWebhook',
        summary: 'Change event subscriptions or pause a webhook',
        security: authenticated,
        middleware: caller,
        request: {
          params: Params,
          headers: ExpectedWriteHeaders,
          body: { required: true, content: json(WebhookUpdateInput) },
        },
        responses: { 200: { description: 'Updated endpoint', content: json(Webhook) }, ...errors },
      }),
      async (c) =>
        c.json(
          await updateWebhook(
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
        path: '/api/v1/webhooks/{id}',
        tags: ['Webhooks'],
        operationId: 'deleteWebhook',
        summary: 'Delete a webhook and its retained deliveries',
        security: authenticated,
        middleware: caller,
        request: { params: Params, headers: ExpectedWriteHeaders },
        responses: {
          204: { description: 'Deleted; pending delivery jobs safely skip' },
          ...errors,
        },
      }),
      async (c) => {
        await deleteWebhook(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
        )
        return c.body(null, 204)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/webhooks/{id}/rotate-secret',
        tags: ['Webhooks'],
        operationId: 'rotateWebhookSecret',
        summary: 'Replace the signing secret and reveal it once',
        security: authenticated,
        middleware: caller,
        request: { params: Params, headers: ExpectedWriteHeaders },
        responses: {
          200: { description: 'New one-time secret', content: json(Secret) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await rotateWebhookSecret(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            deps,
            c.req.valid('param').id,
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/webhooks/{id}/deliveries',
        tags: ['Webhooks'],
        operationId: 'listWebhookDeliveries',
        summary: 'Page through thirty days of delivery metadata',
        security: authenticated,
        middleware: caller,
        request: {
          params: Params,
          headers: ExpectedReadHeaders,
          query: z.object({ after: z.string().optional() }),
        },
        responses: {
          200: {
            description: 'Newest first, at most fifty; no payloads or signatures',
            content: json(z.object({ data: z.array(Delivery), nextAfter: z.string().nullable() })),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await listWebhookDeliveries(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('query').after,
          ),
          200,
        ),
    )
  }
}
