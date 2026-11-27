import { createRoute, z } from '@hono/zod-openapi'
import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import { type BookingNotifier, DomainError, LOCATION_KINDS } from '@hourmere/scheduling'
import {
  applyDepartureHandoff,
  type DepartureHandoffAdminStore,
  departureHandoffIssue,
  HANDOFF_PREVIEW_ISSUES,
  readDepartureHandoffAdminPreview,
} from '@hourmere/scheduling/departure-handoff-admin'
import type { MiddlewareHandler } from 'hono'
import { routeBodyLimit } from '../body-limit.ts'
import type { CallerEnv } from '../caller.ts'
import {
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  organizationContextWriteLock,
  teamManagementAccess,
} from '../team-management.ts'

export interface DepartureHandoffs {
  store: DepartureHandoffAdminStore
  now?: () => Temporal.Instant
}

const Receipt = z
  .object({ sourceBookingId: z.uuid(), replacementBookingId: z.uuid() })
  .openapi('DepartureHandoffReceipt')

const Preview = z
  .object({
    offer: z
      .object({
        id: z.uuid(),
        version: z.number().int().positive(),
        expiresAt: z.iso.datetime(),
        state: z.enum(['unverified', 'pending', 'ready', 'expired', 'closed']),
        outstandingApprovals: z.number().int().nonnegative().optional(),
      })
      .nullable(),
    preview: z
      .object({
        candidateName: z.string(),
        start: z.iso.datetime(),
        end: z.iso.datetime(),
        evaluatedAt: z.iso.datetime(),
        locationKind: z.enum(LOCATION_KINDS).nullable(),
        availability: z.enum(['available', 'unavailable']),
      })
      .nullable(),
    issue: z.enum(HANDOFF_PREVIEW_ISSUES).optional(),
    receipt: z
      .object({
        ...Receipt.shape,
        conference: z.enum(['pending', 'ready', 'failed', 'not_required', 'unknown']),
        oldConferenceCleanup: z.enum(['pending', 'complete', 'unresolved']).optional(),
      })
      .nullable(),
  })
  .openapi('DepartureHandoffPreview')

const Headers = z.object({
  'x-expected-organization-id': z
    .string()
    .optional()
    .openapi({
      description:
        'Required team where the booking was opened. Reload if the active space changed.',
      param: { required: true },
    }),
})

export function departureHandoffRoutes(
  deps: ServiceDeps & {
    handoffs?: DepartureHandoffs | undefined
    notify?: BookingNotifier | undefined
    capabilities?: TeamSsoCapabilities
  },
): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    const writeMiddleware: [...typeof access.middleware, MiddlewareHandler<CallerEnv>] = [
      ...access.middleware,
      routeBodyLimit(1024),
    ]
    const { handoffs, notify, capabilities = ssoHardOff } = deps
    const context = (principal: Parameters<typeof serviceContext>[1]) =>
      serviceContext({ ...deps, now: handoffs?.now ?? deps.now }, principal)
    const disabled = () => new DomainError('not_found', 'handoffs_disabled')
    const errors = errorResponses({
      400: 'Invalid request',
      403: 'Verified team owner/admin browser session required. Authorization headers are denied.',
      404: 'Handoffs are disabled or the source or offer is unavailable in the current team.',
      409: `${ORGANIZATION_CONTEXT_CHANGED}; the current booking, offer, consent or slot changed`,
    })
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/bookings/{id}/handoff-preview',
        operationId: 'previewDepartureHandoff',
        summary: 'Preview one booking handoff and read its current consent or receipt',
        description:
          'Reads one exact slot on the event type’s current grid. Does not reserve time, send consent links, or change a booking. Returns limited consent counts or a safe committed status from the same team. Staged and disabled unless a handoff store and booking notifier are wired in.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: { params: z.object({ id: z.uuid() }), headers: Headers },
        responses: {
          200: { description: 'Current handoff preview or status', content: json(Preview) },
          ...errors,
        },
      }),
      async (c) => {
        if (!handoffs || !notify) throw disabled()
        const { principal } = c.var
        return c.json(
          await readDepartureHandoffAdminPreview(
            context(principal),
            {
              teamId: principal.organization.id,
              expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '',
              bookingId: c.req.valid('param').id,
            },
            handoffs.store,
            capabilities,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply',
        operationId: 'applyDepartureHandoff',
        summary: 'Apply an explicitly approved booking handoff',
        description:
          'Requires a current owner/admin browser session and a same-origin write. Rechecks team authority, exact version, all recipient approvals, the currently offered slot and meeting eligibility in one transaction. Replays return the same limited receipt. Provider and mail work runs after commit.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          params: z.object({ id: z.uuid(), offerId: z.uuid() }),
          headers: Headers,
          body: {
            required: true,
            content: json(z.strictObject({ version: z.number().int().positive() })),
          },
        },
        responses: {
          200: { description: 'Committed handoff receipt', content: json(Receipt) },
          ...errors,
          503: {
            description: 'Required calendar availability is unknown',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        if (!handoffs || !notify) throw disabled()
        const { principal } = c.var
        const { id, offerId } = c.req.valid('param')
        return c.json(
          await applyDepartureHandoff(
            {
              ...context(principal),
              notify,
              lockOrganizationContext: organizationContextWriteLock(principal),
            },
            {
              teamId: principal.organization.id,
              expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '',
              bookingId: id,
              offerId,
              version: c.req.valid('json').version,
            },
            handoffs.store,
            capabilities,
          ).catch((error: unknown) => {
            const issue = departureHandoffIssue(error)
            if (issue && error instanceof DomainError && issue !== error.code)
              throw new DomainError('conflict', issue)
            throw error
          }),
          200,
        )
      },
    )
  }
}
