import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoRetained } from '../sso.ts'
import {
  REMOVE_SSO_IDENTITY_LINK,
  RemoveSsoIdentityLinkInput,
  refuseHardOffSamlLinkRemoval,
  retireSsoIdentityLink,
  type SsoIdentityRecoveryDeps,
  UNLINK_SSO_ACCOUNT,
  UnlinkSsoAccountInput,
} from '../sso-link-recovery.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

export function ssoIdentityRecoveryRoutes(deps: SsoIdentityRecoveryDeps): RouteModule {
  const guard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    requireSsoRetained(deps.capabilities)
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  const headers = z.object({
    'X-Expected-Organization-Id': z.string().optional().openapi({
      description: 'Required for writes and must match the current team.',
    }),
  })
  const removalParams = z.object({ providerId: z.uuid(), linkId: z.uuid() })
  const removalProtocolGuard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    const params = removalParams.safeParse(c.req.param())
    if (params.success)
      await refuseHardOffSamlLinkRemoval(
        deps,
        c.var.principal,
        c.req.raw.headers,
        params.data.providerId,
      )
    await next()
  }
  const responses = {
    ...errorResponses({
      400: 'invalid_request',
      404: 'sso_disabled or sso_not_found',
      409: 'organization_context_changed, sso_configuration_changed or sso_recovery_required',
    }),
    204: { description: 'The exact link was retired and its proofs revoked' },
    403: {
      description:
        'team_management_access_denied or sso_reauthentication_required; retry the exact input after completing fresh proof',
      content: json(FreshProofChallenge),
    },
  }
  return ({ app, caller }) => {
    const middleware = [guard, teamManagementSessionCaller(caller)] as const
    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/team/sso/providers/{providerId}/link',
        operationId: UNLINK_SSO_ACCOUNT,
        tags: ['SSO'],
        summary: 'Retire the caller’s exact SSO identity link',
        description:
          'Current team member browser session with independent mailbox proof and the link ID and generation from /me. Stays available while the protocol setting is off.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers,
          params: z.object({ providerId: z.uuid() }),
          body: { required: true, content: json(UnlinkSsoAccountInput) },
        },
        responses,
      }),
      async (c) => {
        const { linkId, ...input } = c.req.valid('json')
        const result = await retireSsoIdentityLink(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          linkId,
          input,
          UNLINK_SSO_ACCOUNT,
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/team/sso/providers/{providerId}/links/{linkId}',
        operationId: REMOVE_SSO_IDENTITY_LINK,
        tags: ['SSO'],
        summary: 'Retire another member’s exact SSO identity link',
        description:
          'Team owner/admin browser session with fresh administration proof and the link generation from the provider inventory. Another owner must retire an owner’s link. Stays available while the protocol setting is off.',
        security: [{ session: [] }],
        middleware: [...middleware, removalProtocolGuard] as const,
        request: {
          headers,
          params: removalParams,
          body: { required: true, content: json(RemoveSsoIdentityLinkInput) },
        },
        responses: {
          ...responses,
          403: {
            ...responses[403],
            description:
              'team_management_access_denied, sso_required or sso_reauthentication_required; retry a proof challenge with the exact input after completing fresh proof',
          },
        },
      }),
      async (c) => {
        const { providerId, linkId } = c.req.valid('param')
        const result = await retireSsoIdentityLink(
          deps,
          c.var.principal,
          c.req.raw.headers,
          providerId,
          linkId,
          c.req.valid('json'),
          REMOVE_SSO_IDENTITY_LINK,
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.body(null, 204)
      },
    )
  }
}
