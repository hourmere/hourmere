import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import {
  confirmOwnershipTransfer,
  createOwnershipTransfer,
  declineOwnershipTransfer,
  type OwnershipTransferDeps,
  revokeOwnershipTransfer,
  viewOwnershipTransfer,
} from '../ownership-transfer.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

const basePath = '/api/v1/teams/{teamId}/ownership-transfer'
const teamParams = z.object({ teamId: z.uuid() })
const offerParams = teamParams.extend({ transferId: z.uuid() })
const expectedContext = z.object({
  'x-expected-organization-id': z
    .string()
    .optional()
    .openapi({
      description:
        'Must match the path team and current session. Reload if the active team changed.',
      param: { required: true },
    }),
})
const deadline = z.object({ id: z.uuid(), expiresAt: z.iso.datetime() })
const participant = z.object({ displayName: z.string() })
const visibleOffer = deadline.extend({
  state: z.enum(['pending', 'confirmed', 'revoked', 'expired', 'invalidated']),
  action: z.enum(['revoke', 'confirm']).optional(),
  initiator: participant.optional(),
  recipient: participant.optional(),
})
const confirmed = z.object({
  initiator: z.object({ membershipId: z.uuid(), role: z.literal('admin') }),
  recipient: z.object({ membershipId: z.uuid(), role: z.literal('owner') }),
})
const revoked = z.object({ state: z.literal('revoked') })
const sessionSecurity = [{ session: [] }]
const tags = ['Team members']
const responseErrors = {
  400: { description: 'Invalid request', content: json(ErrorBody) },
  403: {
    description: 'Verified team browser session required; Authorization headers are denied',
    content: json(ErrorBody),
  },
  404: { description: 'ownership_transfer_disabled', content: json(ErrorBody) },
  409: {
    description: 'organization_context_changed: reload the active team',
    content: json(ErrorBody),
  },
}
const proofError = {
  description:
    'Team access denied, or sso_reauthentication_required: complete the challenge and retry the exact input with proofAttemptId',
  content: json(FreshProofChallenge),
}
const budgetError = {
  description: 'The team transfer budget is exhausted; retry after the indicated delay',
  headers: {
    'Retry-After': { schema: { type: 'integer' as const }, description: 'Seconds until retry' },
  },
  content: json(ErrorBody),
}
const offerConflict = {
  description:
    'organization_context_changed or ownership_transfer_unavailable: refresh the active team and offer',
  content: json(ErrorBody),
}

export function ownershipTransferRoutes(deps?: OwnershipTransferDeps): RouteModule {
  const disabled = () => new DomainError('not_found', 'ownership_transfer_disabled')
  const requireEnabled = () => {
    if (!deps) throw disabled()
    return deps
  }
  const origin = deps && new URL(deps.publicUrl).origin
  const guard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    requireEnabled()
    if (c.req.method === 'POST' && c.req.header('origin') !== origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }

  return ({ app, caller }) => {
    const middleware = [guard, teamManagementSessionCaller(caller)] as const
    app.openapi(
      createRoute({
        method: 'get',
        path: basePath,
        operationId: 'getOwnershipTransfer',
        summary: 'Read the active team ownership offer visible to the caller',
        description:
          'Only the original participants can read names or check the terminal state of an already known offer. Another owner can see the pending offer deadline and revoke it.',
        tags,
        security: sessionSecurity,
        middleware: [...middleware] as const,
        request: {
          params: teamParams,
          headers: expectedContext,
          query: z.object({ transferId: z.uuid().optional() }),
        },
        responses: {
          ...responseErrors,
          200: {
            description: 'Caller-visible offer, if any',
            content: json(z.object({ offer: visibleOffer.nullable() })),
          },
        },
      }),
      async (c) =>
        c.json(
          {
            offer: await viewOwnershipTransfer(
              requireEnabled(),
              c.var.principal,
              c.req.raw.headers,
              c.req.valid('param').teamId,
              c.req.valid('query').transferId,
            ),
          },
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: basePath,
        operationId: 'createOwnershipTransfer',
        summary: 'Offer ownership of the active team to a current member',
        description:
          'Requires a current owner, exact same-instance Origin, and fresh proof. Roles change only when the recipient confirms.',
        tags,
        security: sessionSecurity,
        middleware: [...middleware] as const,
        request: {
          params: teamParams,
          headers: expectedContext,
          body: {
            required: true,
            content: json(
              z.strictObject({ targetMembershipId: z.uuid(), proofAttemptId: z.uuid().optional() }),
            ),
          },
        },
        responses: {
          ...responseErrors,
          201: { description: 'Pending offer and UTC deadline', content: json(deadline) },
          403: proofError,
          409: {
            description:
              'organization_context_changed, ownership_transfer_pending or scim_managed_resource',
            content: json(ErrorBody),
          },
          429: budgetError,
        },
      }),
      async (c) => {
        const result = await createOwnershipTransfer(
          requireEnabled(),
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').teamId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 201)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: `${basePath}/{transferId}/confirm`,
        operationId: 'confirmOwnershipTransfer',
        summary: 'Accept an ownership offer as its named recipient',
        description:
          'Requires exact same-instance Origin and fresh proof. Both team roles are updated together.',
        tags,
        security: sessionSecurity,
        middleware: [...middleware] as const,
        request: {
          params: offerParams,
          headers: expectedContext,
          body: {
            required: true,
            content: json(z.strictObject({ proofAttemptId: z.uuid().optional() })),
          },
        },
        responses: {
          ...responseErrors,
          200: { description: 'Resulting memberships and roles', content: json(confirmed) },
          403: proofError,
          409: {
            description:
              'organization_context_changed, ownership_transfer_unavailable or sso_recovery_required',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const { teamId, transferId } = c.req.valid('param')
        const result = await confirmOwnershipTransfer(
          requireEnabled(),
          c.var.principal,
          c.req.raw.headers,
          teamId,
          transferId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: `${basePath}/{transferId}/revoke`,
        operationId: 'revokeOwnershipTransfer',
        summary: 'Revoke an ownership offer as a current owner',
        description: 'Requires exact same-instance Origin. No role changes take effect.',
        tags,
        security: sessionSecurity,
        middleware: [...middleware] as const,
        request: { params: offerParams, headers: expectedContext },
        responses: {
          ...responseErrors,
          200: { description: 'The offer was revoked', content: json(revoked) },
          409: offerConflict,
          429: budgetError,
        },
      }),
      async (c) => {
        const { teamId, transferId } = c.req.valid('param')
        return c.json(
          await revokeOwnershipTransfer(
            requireEnabled(),
            c.var.principal,
            c.req.raw.headers,
            teamId,
            transferId,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: `${basePath}/{transferId}/decline`,
        operationId: 'declineOwnershipTransfer',
        summary: 'Decline an ownership offer as its named recipient',
        description:
          'Requires exact same-instance Origin. The offer closes without changing either role.',
        tags,
        security: sessionSecurity,
        middleware: [...middleware] as const,
        request: { params: offerParams, headers: expectedContext },
        responses: {
          ...responseErrors,
          200: { description: 'The offer closed as revoked', content: json(revoked) },
          409: offerConflict,
        },
      }),
      async (c) => {
        const { teamId, transferId } = c.req.valid('param')
        return c.json(
          await declineOwnershipTransfer(
            requireEnabled(),
            c.var.principal,
            c.req.raw.headers,
            teamId,
            transferId,
          ),
          200,
        )
      },
    )
  }
}
