import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  createOneTimeBookingLink,
  DomainError,
  getOneTimeBookingLink,
  listOneTimeBookingLinks,
  type OneTimeBookingLink,
  revokeManagedOneTimeBookingLink,
} from '@hourmere/scheduling'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  callerWithBodyLimit,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import { bookingWriteAccess, EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'

export const CreateOneTimeLink = z
  .strictObject({
    expiresAt: z.string().nullable().optional().openapi({
      description: 'A future absolute instant with an offset; omitted or null means no expiry.',
      format: 'date-time',
    }),
    prefill: z
      .strictObject({
        name: z.string().nullable().optional().openapi({ maxLength: 200 }),
        email: z.string().nullable().optional().openapi({ maxLength: 254 }),
      })
      .optional(),
  })
  .openapi('CreateOneTimeBookingLink')

export const OneTimeLink = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    eventTypeId: z.uuid(),
    creatorUserId: z.uuid(),
    creatorDisplayName: z.string().nullable().openapi({
      description:
        'Current member display name, or email for session managers allowed to view it; null when unknown.',
    }),
    expiresAt: z.string().nullable(),
    prefill: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
    state: z.enum(['active', 'used', 'expired', 'revoked']),
    bookingId: z.uuid().nullable(),
    usedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('OneTimeBookingLink')

export const CreatedOneTimeLink = OneTimeLink.extend({
  url: z.string().openapi({
    description:
      'Private booking URL shown only in this creation response. Copy it now; it cannot be recovered.',
    format: 'uri',
  }),
}).openapi('CreatedOneTimeBookingLink')
export const OneTimeLinkList = z
  .object({
    data: z.array(OneTimeLink),
    nextAfter: z.string().nullable(),
  })
  .openapi('OneTimeBookingLinkList')
export const OneTimeLinkListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.uuid().optional(),
})
const EventParams = z.object({ eventTypeId: z.uuid() })
const LinkParams = EventParams.extend({ id: z.uuid() })
const ExpectedOrganizationHeaders = z.object({
  'x-expected-organization-id': z.string().optional(),
})
const forbidden = `insufficient_role; team_management_access_denied; ${CROSS_ORIGIN_WRITE}`

/** The raw capability is used only to construct the creation response's path URL. */
export function createdOneTimeLinkResponse(
  { token, ...metadata }: OneTimeBookingLink & { token: string },
  publicUrl: string,
) {
  return { ...metadata, url: new URL(`/book/${token}`, publicUrl).href }
}

export function oneTimeLinkRoutes(deps: ServiceDeps & { publicUrl: string }): RouteModule {
  const writeContext = (principal: Principal, expectation?: string) => ({
    ...serviceContext(deps, principal),
    // Context binding permits current members; the shared link service separately
    // checks ownership of personal team events and owner/admin access to team types.
    authorizeOrganizationWrite: async (db: Db, organizationId: string) => {
      if (principal.kind === 'session' && expectation === undefined)
        throw new DomainError('conflict', 'organization_context_changed')
      await bookingWriteAccess(principal, expectation)(db, organizationId)
    },
  })
  return ({ app, caller }) => {
    const route = { security: authenticated, middleware: caller, tags: ['One-time links'] }
    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, 16_384),
        method: 'post',
        path: '/api/v1/event-types/{eventTypeId}/one-time-links',
        operationId: 'createOneTimeBookingLink',
        summary: 'Create a private one-time booking link',
        description:
          'Requires bookings or full API-key scope and permission to manage this event type. Links always receive time-ordered UUIDv7 IDs; Idempotency-Key is stored separately, scoped to this caller, credential and organization. Copy the URL now: neither the URL nor token can be retrieved again. A duplicate key never mints another link while its row is retained: the same request returns 409 one_time_link_already_created because no raw-response cache is retained; changed arguments return idempotency_key_reused. Revoked or expired unused links may be removed after retention, and event deletion removes markers. Prefill remains editable and proves no invitee identity. Limits: 1000 active unexpired links per personal owner/team, with a 200-link sub-limit for ordinary team members.',
        request: {
          params: EventParams,
          headers: ExpectedOrganizationHeaders.extend({ 'idempotency-key': z.string().optional() }),
          body: { content: json(CreateOneTimeLink), required: true },
        },
        responses: {
          201: {
            description: 'The new link, with its booking URL shown once',
            content: json(CreatedOneTimeLink),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_one_time_link, invalid_idempotency_key, event_type_inactive',
            403: forbidden,
            404: 'event_type_not_found',
            409: 'one_time_link_limit_reached, one_time_link_already_created, idempotency_key_reused, organization_context_changed',
          }),
        },
      }),
      async (c) => {
        c.header('Referrer-Policy', 'no-referrer')
        const created = await createOneTimeBookingLink(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          {
            ...c.req.valid('json'),
            eventTypeId: c.req.valid('param').eventTypeId,
            idempotencyKey: c.req.valid('header')['idempotency-key'],
          },
        )
        return c.json(createdOneTimeLinkResponse(created, deps.publicUrl), 201)
      },
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/event-types/{eventTypeId}/one-time-links',
        summary: 'List one-time link metadata',
        description:
          'Requires read or full API-key scope and permission to manage the event type. Newest links first, ordered by descending time-ordered UUIDv7 ID, including links created with Idempotency-Key. Pass nextAfter as after for the same event type. A bounded cursor page never returns tokens, digests or booking URLs. Expiry is evaluated against database wall time.',
        request: { params: EventParams, query: OneTimeLinkListQuery },
        responses: {
          200: { description: 'A bounded metadata page', content: json(OneTimeLinkList) },
          ...errorResponses({
            400: 'invalid_limit, invalid_cursor',
            403: forbidden,
            404: 'event_type_not_found',
          }),
        },
      }),
      async (c) =>
        c.json(
          await listOneTimeBookingLinks(serviceContext(deps, c.var.principal), {
            ...c.req.valid('param'),
            ...c.req.valid('query'),
          }),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/event-types/{eventTypeId}/one-time-links/{id}',
        summary: 'Get one-time link metadata',
        request: { params: LinkParams },
        responses: {
          200: {
            description: 'Metadata without a token, digest or URL',
            content: json(OneTimeLink),
          },
          ...errorResponses({
            403: forbidden,
            404: 'event_type_not_found, one_time_link_not_found',
          }),
        },
      }),
      async (c) =>
        c.json(
          await getOneTimeBookingLink(serviceContext(deps, c.var.principal), c.req.valid('param')),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'delete',
        path: '/api/v1/event-types/{eventTypeId}/one-time-links/{id}',
        operationId: 'revokeOneTimeBookingLink',
        summary: 'Revoke a one-time booking link',
        description:
          'Requires bookings or full API-key scope and event management permission. Idempotent: used, revoked and expired links retain their state and consuming booking. Unknown or unrelated link IDs return null without revealing their existence.',
        request: { params: LinkParams, headers: ExpectedOrganizationHeaders },
        responses: {
          200: {
            description: 'Safe metadata, or null for an unrelated/unknown ID',
            content: json(OneTimeLink.nullable()),
          },
          ...errorResponses({
            403: forbidden,
            404: 'event_type_not_found',
            409: 'organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await revokeManagedOneTimeBookingLink(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param'),
          ),
          200,
        ),
    )
  }
}
