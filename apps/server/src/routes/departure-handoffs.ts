import { createRoute, z } from '@hono/zod-openapi'
import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import { type BookingNotifier, DomainError, LOCATION_KINDS } from '@hourmere/scheduling'
import {
  applyDepartureHandoff,
  type DepartureHandoffAdminStore,
  departureHandoffIssue,
  HANDOFF_MAIL_STATES,
  HANDOFF_PREVIEW_ISSUES,
  type HasPendingHandoffCancellation,
  readDepartureHandoffAdminPreview,
} from '@hourmere/scheduling/departure-handoff-admin'
import {
  createDepartureHandoffProposal,
  DEPARTURE_HANDOFF_DELIVERY_STATES,
  DEPARTURE_HANDOFF_PROPOSAL_STATES,
  type EnqueueDepartureHandoffEmail,
  readDepartureHandoffProposal,
  resendDepartureHandoffProposal,
  withdrawDepartureHandoffProposal,
} from '@hourmere/scheduling/departure-handoff-proposals'
import type { EnqueueDepartureHandoffRun } from '@hourmere/scheduling/departure-handoff-queue'
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
  hasPendingCancellation?: HasPendingHandoffCancellation
  enqueue?: EnqueueDepartureHandoffEmail | undefined
  enqueueRun?: EnqueueDepartureHandoffRun | undefined
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
        mail: z.object({
          cancellation: z.enum(HANDOFF_MAIL_STATES),
          confirmation: z.enum(HANDOFF_MAIL_STATES),
        }),
      })
      .nullable(),
  })
  .openapi('DepartureHandoffPreview')

const Proposal = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    state: z.enum(DEPARTURE_HANDOFF_PROPOSAL_STATES),
    recipients: z.array(
      z.object({
        id: z.uuid(),
        attendeeIds: z.array(z.uuid()),
        decision: z.enum(['pending', 'approved', 'declined']),
        delivery: z.enum(DEPARTURE_HANDOFF_DELIVERY_STATES),
        resendAvailable: z.boolean(),
      }),
    ),
  })
  .openapi('DepartureHandoffProposal')

const Version = z.number().int().positive().max(2_147_483_647)
const BookingParams = z.object({ id: z.uuid() })
const OfferParams = BookingParams.extend({ offerId: z.uuid() })
const proposalPath = '/api/v1/team/bookings/{id}/handoff-offers' as const

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
    smtpConfigured?: boolean | undefined
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
    const writeErrors = {
      ...errors,
      413: { description: 'Request body exceeds 1024 bytes', content: json(ErrorBody) },
    }
    const proposalErrors = {
      ...writeErrors,
      503: {
        description: 'Required calendar availability or the mail outbox is unavailable',
        content: json(ErrorBody),
      },
    }
    const proposalAccess = (principal: Parameters<typeof context>[0], expected?: string) => ({
      teamId: principal.organization.id,
      expectedOrganizationId: expected ?? '',
    })
    const writeContext = (principal: Parameters<typeof context>[0]) => ({
      ...context(principal),
      lockOrganizationContext: organizationContextWriteLock(principal),
    })
    const proposalFailure = (error: unknown): never => {
      const issue = departureHandoffIssue(error)
      if (issue && error instanceof DomainError && issue !== error.code)
        throw new DomainError('conflict', issue)
      throw error
    }
    app.openapi(
      createRoute({
        method: 'post',
        path: proposalPath,
        operationId: 'createDepartureHandoffProposal',
        summary: 'Create a handoff proposal or supersede its current version',
        description:
          'Creates an offer and queues a private link for each distinct mailbox. Supply the latest offer ID and version in previous to replace an existing offer. The source remains confirmed and this does not reserve the proposed slot. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          params: BookingParams,
          headers: Headers,
          body: {
            required: true,
            content: json(
              z.strictObject({
                departingUserId: z.uuid(),
                start: z.iso.datetime({ offset: true }).optional(),
                durationMinutes: z.number().int().positive().optional(),
                locationOptionId: z.string().min(1).max(128).optional(),
                previous: z.strictObject({ offerId: z.uuid(), version: Version }).optional(),
              }),
            ),
          },
        },
        responses: {
          201: {
            description: 'Created proposal and queued delivery status',
            content: json(Proposal),
          },
          ...proposalErrors,
        },
      }),
      async (c) => {
        if (!handoffs?.enqueue) throw disabled()
        const { principal } = c.var
        c.header('Cache-Control', 'no-store')
        const result = await createDepartureHandoffProposal(
          writeContext(principal),
          {
            ...proposalAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            bookingId: c.req.valid('param').id,
            ...c.req.valid('json'),
          },
          handoffs.enqueue,
          capabilities,
        ).catch(proposalFailure)
        return c.json(result, 201)
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: `${proposalPath}/{offerId}`,
        operationId: 'readDepartureHandoffProposal',
        summary: 'Read a handoff proposal and recipient delivery status',
        description:
          'Defaults to the latest version. Returns opaque recipient IDs, matching source attendee IDs, decisions and safe delivery states. Available to a current team owner or admin even if the mail queue is unavailable. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: OfferParams,
          headers: Headers,
          query: z.object({
            version: z.coerce.number().int().positive().max(2_147_483_647).optional(),
          }),
        },
        responses: {
          200: { description: 'Current or historical proposal status', content: json(Proposal) },
          ...errors,
        },
      }),
      async (c) => {
        if (!handoffs) throw disabled()
        const { principal } = c.var
        const { id, offerId } = c.req.valid('param')
        c.header('Cache-Control', 'no-store')
        const proposal = await readDepartureHandoffProposal(
          context(principal),
          {
            ...proposalAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            bookingId: id,
            offerId,
            version: c.req.valid('query').version,
          },
          capabilities,
        )
        return c.json(
          handoffs.enqueue
            ? proposal
            : {
                ...proposal,
                recipients: proposal.recipients.map((recipient) => ({
                  ...recipient,
                  resendAvailable: false,
                })),
              },
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: `${proposalPath}/{offerId}/withdraw`,
        operationId: 'withdrawDepartureHandoffProposal',
        summary: 'Withdraw a handoff proposal version',
        description:
          'Revokes the private links for the exact version and leaves the source booking confirmed. Available even if the mail queue is unavailable. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          params: OfferParams,
          headers: Headers,
          body: { required: true, content: json(z.strictObject({ version: Version })) },
        },
        responses: {
          200: { description: 'Proposal status after withdrawal', content: json(Proposal) },
          ...writeErrors,
        },
      }),
      async (c) => {
        if (!handoffs) throw disabled()
        const { principal } = c.var
        const { id, offerId } = c.req.valid('param')
        c.header('Cache-Control', 'no-store')
        return c.json(
          await withdrawDepartureHandoffProposal(
            writeContext(principal),
            {
              ...proposalAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              bookingId: id,
              offerId,
              version: c.req.valid('json').version,
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
        path: `${proposalPath}/{offerId}/resend`,
        operationId: 'resendDepartureHandoffProposal',
        summary: 'Queue a new private link for one pending recipient',
        description:
          'Use the same Idempotency-Key to retry a request for the same recipient and version. The delivery worker revokes the older link when it claims the new send. Each mailbox can receive up to three sends for the source booking across versions. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: writeMiddleware,
        request: {
          params: OfferParams,
          headers: Headers.extend({
            'idempotency-key': z
              .uuid()
              .optional()
              .openapi({
                description: 'Random UUID scoped to this offer version and recipient.',
                param: { required: true },
              }),
          }),
          body: {
            required: true,
            content: json(z.strictObject({ version: Version, recipientId: z.uuid() })),
          },
        },
        responses: {
          200: { description: 'Proposal status after queueing or replay', content: json(Proposal) },
          ...proposalErrors,
        },
      }),
      async (c) => {
        if (!handoffs?.enqueue) throw disabled()
        const { principal } = c.var
        const { id, offerId } = c.req.valid('param')
        c.header('Cache-Control', 'no-store')
        return c.json(
          await resendDepartureHandoffProposal(
            writeContext(principal),
            {
              ...proposalAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              bookingId: id,
              offerId,
              ...c.req.valid('json'),
              requestKey: c.req.header('Idempotency-Key') ?? '',
            },
            handoffs.enqueue,
            capabilities,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/bookings/{id}/handoff-preview',
        operationId: 'previewDepartureHandoff',
        summary: 'Preview one booking handoff and read its current consent or receipt',
        description:
          'Reads one exact slot on the event type’s current grid. Does not reserve time, send consent links, or change a booking. Returns limited consent counts or a committed receipt with aggregate attendee mail status from the same team. Accepted means the mail server accepted all attendee messages of that kind. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
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
            deps.smtpConfigured,
            handoffs.hasPendingCancellation,
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
          'Requires a current owner/admin browser session and a same-origin write. Rechecks team authority, exact version, all recipient approvals, the currently offered slot and meeting eligibility in one transaction. Replays return the same limited receipt. Provider and mail work runs after commit. Requires DEPARTURE_HANDOFFS_ENABLED=true.',
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
          ).catch(proposalFailure),
          200,
        )
      },
    )
  }
}
