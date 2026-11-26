import { createRoute, z } from '@hono/zod-openapi'
import { lockTeamSsoProof, ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import { checkTeamWriteDeadline } from '@hourmere/db/team-write'
import { DomainError } from '@hourmere/scheduling'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, json, type RouteModule, type ServiceDeps } from '../openapi.ts'
import {
  admittedBulkStates,
  bulkCancellationStatus,
  confirmBulkCancellation,
  type EnqueueBulkCancellation,
} from '../team-booking-bulk-admission.ts'
import { bulkPageBinding } from '../team-booking-bulk-proof.ts'
import { BULK_BOOKING_OUTCOMES, type BulkBookingOutcome } from '../team-booking-bulk-state.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'

export type BulkCancellationRouteDeps = ServiceDeps & {
  bulkSelectionSecret?: string
  enqueueBulkCancellation?: EnqueueBulkCancellation
  ssoCapabilities?: TeamSsoCapabilities
}

const AdmittedBulkCancellation = z
  .object({ id: z.uuid(), state: z.enum(admittedBulkStates) })
  .openapi('AdmittedBulkCancellation')
const outcomeCount = z.int().min(0).max(25)
const OutcomeCounts = z.object(
  Object.fromEntries(BULK_BOOKING_OUTCOMES.map((code) => [code, outcomeCount])) as Record<
    BulkBookingOutcome,
    typeof outcomeCount
  >,
)
const BulkCancellationStatus = z
  .union([
    z.object({
      id: z.uuid(),
      state: z.literal('awaiting_confirmation'),
      expiresAt: z.iso.datetime(),
    }),
    AdmittedBulkCancellation.extend({
      counts: OutcomeCounts,
      items: z.array(z.object({ bookingId: z.uuid(), code: z.enum(BULK_BOOKING_OUTCOMES) })),
    }),
  ])
  .openapi('BulkCancellationStatus')

const path = '/api/v1/team/bookings/bulk-cancellations/{id}'
export const bulkExpectedTeamHeader = z.object({
  'x-expected-organization-id': z
    .string()
    .optional()
    .openapi({
      description: 'Required: the team where the selection started',
      param: { required: true },
    }),
})
const errors = {
  403: {
    description:
      'team_management_access_denied: requires a current team owner/admin session without Authorization',
    content: json(ErrorBody),
  },
  404: {
    description:
      'bulk_cancellation_not_found: no receipt for this account in this team; not_found: bulk cancellation is unavailable',
    content: json(ErrorBody),
  },
}
export const bulkThrottleResponse = {
  description: 'rate_limited: rolling request limit; Retry-After gives seconds to wait',
  content: json(ErrorBody),
  headers: { 'Retry-After': { required: true, schema: { type: 'integer' as const, minimum: 1 } } },
}

export function teamBookingBulkAdmissionRoutes(deps: BulkCancellationRouteDeps): RouteModule {
  return ({ app, caller }) => {
    const { db, bulkSelectionSecret, enqueueBulkCancellation, ssoCapabilities = ssoHardOff } = deps
    const access = teamManagementAccess(db, caller)
    const hardOff = createMiddleware<CallerEnv>(async (c, next) => {
      if (!bulkSelectionSecret) return c.json({ error: 'not_found' }, 404)
      await next()
    })
    const confirmHardOff = createMiddleware<CallerEnv>(async (c, next) => {
      if (!bulkSelectionSecret || !enqueueBulkCancellation)
        return c.json({ error: 'not_found' }, 404)
      await next()
    })
    app.openapi(
      createRoute({
        method: 'post',
        path: `${path}/confirm`,
        operationId: 'confirmTeamBookingBulkCancellation',
        summary: 'Confirm a previewed team booking cancellation batch',
        description:
          'Unavailable until bulk cancellation is released. Requires a verified team owner/admin browser session and a same-origin Origin or Referer. Submit only the issued ID in the path. Repeating confirmation returns the same batch and its current state.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: [confirmHardOff, ...access.middleware] as [
          typeof confirmHardOff,
          ...typeof access.middleware,
        ],
        request: {
          params: z.object({ id: z.uuid() }),
          headers: bulkExpectedTeamHeader,
          query: z.strictObject({}),
        },
        responses: {
          200: {
            description: 'The previously admitted batch has completed',
            content: json(AdmittedBulkCancellation),
          },
          202: {
            description: 'The batch is queued or running',
            content: json(AdmittedBulkCancellation),
          },
          400: {
            description: 'invalid_request: use the issued UUID and an empty request body',
            content: json(ErrorBody),
          },
          ...errors,
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; bulk_confirmation_expired: preview expired; bulk_no_eligible_bookings: preview contains no eligible bookings`,
            content: json(ErrorBody),
          },
          413: { description: 'Request body is too large', content: json(ErrorBody) },
          429: {
            ...bulkThrottleResponse,
            description:
              'rate_limited: rolling request limit; bulk_queue_full: team or instance at capacity; Retry-After gives seconds to wait',
          },
        },
      }),
      async (c) => {
        if (!enqueueBulkCancellation) return c.json({ error: 'not_found' }, 404)
        if (await c.req.text()) return c.json({ error: 'invalid_request' }, 400)
        const principal = c.var.principal
        const result = await access.write(
          principal,
          principal.organization.id,
          (trx, actor) =>
            confirmBulkCancellation(
              trx,
              bulkPageBinding(principal, actor),
              c.req.valid('param').id,
              enqueueBulkCancellation,
            ),
          { expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '' },
        )
        if ('error' in result) {
          c.header('Retry-After', String(result.retryAfterSeconds))
          return c.json({ error: result.error }, 429)
        }
        return result.state === 'completed' ? c.json(result, 200) : c.json(result, 202)
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path,
        operationId: 'getTeamBookingBulkCancellation',
        summary: 'Read the status of a team booking cancellation batch',
        description:
          'Unavailable until bulk cancellation is released. Requires a verified team owner/admin browser session and scopes the receipt to that account and team. Admitted results retain the preview order.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: [hardOff, ...access.middleware] as [
          typeof hardOff,
          ...typeof access.middleware,
        ],
        request: { params: z.object({ id: z.uuid() }), headers: bulkExpectedTeamHeader },
        responses: {
          200: {
            description: 'Current state of the receipt or admitted batch',
            content: json(BulkCancellationStatus),
          },
          400: { description: 'invalid_request: use the issued UUID', content: json(ErrorBody) },
          ...errors,
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; bulk_confirmation_expired: preview expired`,
            content: json(ErrorBody),
          },
          429: bulkThrottleResponse,
        },
      }),
      async (c) => {
        const principal = c.var.principal
        const result = await access.write(
          principal,
          principal.organization.id,
          async (trx, actor) => {
            const binding = bulkPageBinding(principal, actor)
            const requireSsoProof = () => {
              throw new DomainError('forbidden', 'sso_required')
            }
            const deadline = await lockTeamSsoProof(
              { capabilities: ssoCapabilities },
              trx,
              { userId: binding.userId, sessionId: binding.sessionId },
              binding.organizationId,
              requireSsoProof,
              { organizationLocked: true },
            )
            const status = await bulkCancellationStatus(trx, binding, c.req.valid('param').id)
            await checkTeamWriteDeadline(trx, deadline, requireSsoProof)
            return status
          },
          { expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '' },
        )
        if (result instanceof DomainError) throw result
        if ('error' in result) {
          c.header('Retry-After', String(result.retryAfterSeconds))
          return c.json({ error: result.error }, 429)
        }
        return c.json(result, 200)
      },
    )
  }
}
