import { createRoute, z } from '@hono/zod-openapi'
import type { TeamSsoCapabilities } from '@hourmere/auth'
import {
  controlDepartureHandoffRun,
  DEPARTURE_HANDOFF_ITEM_OUTCOMES,
  DEPARTURE_HANDOFF_RUN_STATES,
  MAX_DEPARTURE_HANDOFF_RUN_ITEMS,
  readDepartureHandoffRun,
  startDepartureHandoffRun,
} from '@hourmere/scheduling/departure-handoff-queue'
import { DomainError } from '@hourmere/scheduling/errors'
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
import type { DepartureHandoffs } from './departure-handoffs.ts'

const path = '/api/v1/team/bookings/handoff-runs' as const
const runPath = `${path}/{runId}` as const
const params = z.object({ runId: z.uuid() })
const headers = z.object({
  'x-expected-organization-id': z
    .string()
    .optional()
    .openapi({
      description: 'Send the active team ID as X-Expected-Organization-Id.',
      param: { required: true },
    }),
})
const run = z
  .object({
    id: z.uuid(),
    departingUserId: z.uuid(),
    state: z.enum(DEPARTURE_HANDOFF_RUN_STATES),
    failureCode: z
      .enum(['departed_member_returned', 'authorization_lost', 'run_expired'])
      .nullable(),
    items: z
      .array(
        z.object({
          sourceBookingId: z.uuid(),
          offerId: z.uuid(),
          version: z.number().int().positive(),
          outcome: z.enum(DEPARTURE_HANDOFF_ITEM_OUTCOMES),
          replacementBookingId: z.uuid().nullable(),
        }),
      )
      .max(MAX_DEPARTURE_HANDOFF_RUN_ITEMS),
  })
  .openapi('DepartureHandoffRun')

export function departureHandoffRunRoutes(
  deps: ServiceDeps & {
    handoffs?: DepartureHandoffs | undefined
    capabilities: TeamSsoCapabilities
  },
): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    const writeMiddleware: [...typeof access.middleware, MiddlewareHandler<CallerEnv>] = [
      ...access.middleware,
      routeBodyLimit(1024),
    ]
    const { capabilities, handoffs } = deps
    const requireQueue = () => {
      if (!handoffs?.enqueueRun) throw new DomainError('not_found', 'handoffs_disabled')
      return handoffs.enqueueRun
    }
    const context = (principal: Parameters<typeof serviceContext>[1]) => ({
      ...serviceContext({ ...deps, now: handoffs?.now ?? deps.now }, principal),
      lockOrganizationContext: organizationContextWriteLock(principal),
    })
    const scope = (principal: Parameters<typeof serviceContext>[1], expected?: string) => ({
      teamId: principal.organization.id,
      expectedOrganizationId: expected ?? '',
    })
    const response = {
      200: { description: 'Current run and per-booking results', content: json(run) },
      ...errorResponses({
        400: 'Invalid request',
        403: 'A verified team owner or admin browser session is required. Authorization headers are denied.',
        404: 'Handoffs are disabled or this run is unavailable in the current team.',
        409: `${ORGANIZATION_CONTEXT_CHANGED}; the run cannot be started or changed`,
      }),
      503: {
        description: 'The handoff queue is temporarily unavailable.',
        content: json(ErrorBody),
      },
    }
    app.openapi(
      createRoute({
        method: 'post',
        path,
        operationId: 'startDepartureHandoffRun',
        summary: 'Start a bounded departure handoff run',
        description:
          'Explicitly opts into processing eligible, approved offers for a departed team member. Retry the same request with the same runId. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          headers,
          body: {
            required: true,
            content: json(z.strictObject({ runId: z.uuid(), departingUserId: z.uuid() })),
          },
        },
        responses: response,
      }),
      async (c) => {
        const enqueue = requireQueue()
        const { principal } = c.var
        c.header('Cache-Control', 'no-store')
        return c.json(
          await startDepartureHandoffRun(
            context(principal),
            {
              ...scope(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              ...c.req.valid('json'),
            },
            enqueue,
            capabilities,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: runPath,
        operationId: 'readDepartureHandoffRun',
        summary: 'Read a departure handoff run',
        description:
          'Returns the bounded run receipt without private participant or provider details. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: { params, headers },
        responses: response,
      }),
      async (c) => {
        requireQueue()
        const { principal } = c.var
        c.header('Cache-Control', 'no-store')
        return c.json(
          await readDepartureHandoffRun(
            context(principal),
            {
              ...scope(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              ...c.req.valid('param'),
            },
            capabilities,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: `${runPath}/control`,
        operationId: 'controlDepartureHandoffRun',
        summary: 'Pause, resume or stop a departure handoff run',
        description:
          'A pause or stop takes effect before the next booking transaction. Resume continues only a paused run. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          params,
          headers,
          body: {
            required: true,
            content: json(z.strictObject({ action: z.enum(['pause', 'resume', 'stop']) })),
          },
        },
        responses: response,
      }),
      async (c) => {
        const enqueue = requireQueue()
        const { principal } = c.var
        c.header('Cache-Control', 'no-store')
        return c.json(
          await controlDepartureHandoffRun(
            context(principal),
            {
              ...scope(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              ...c.req.valid('param'),
              ...c.req.valid('json'),
            },
            enqueue,
            capabilities,
          ),
          200,
        )
      },
    )
  }
}
