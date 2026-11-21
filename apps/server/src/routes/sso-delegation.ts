import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoEnabled } from '../sso.ts'
import {
  BindSsoDelegationInput,
  bindSsoDelegation,
  REVOKE_SSO_DELEGATION,
  revokeSsoDelegation,
  type SsoDelegationDeps,
} from '../sso-delegation.ts'
import {
  BIND_SSO_DELEGATION,
  delegationProofCookie,
  SSO_DELEGATIONS_PATH,
} from '../sso-delegation-proof.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

export function ssoDelegationRoutes(deps: SsoDelegationDeps): RouteModule {
  const guard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    requireSsoEnabled(deps.capabilities)
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  const headers = z.object({
    'X-Expected-Organization-Id': z.string().optional().openapi({
      description: 'Required for writes and must match the current team.',
    }),
  })
  return ({ app, caller }) => {
    const middleware = [guard, teamManagementSessionCaller(caller)] as const
    app.openapi(
      createRoute({
        method: 'post',
        path: SSO_DELEGATIONS_PATH,
        operationId: BIND_SSO_DELEGATION,
        tags: ['SSO'],
        summary: 'Bind delegated SSO proof to an owned team credential',
        description: 'Requires fresh SSO step-up in the current team. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: { headers, body: { required: true, content: json(BindSsoDelegationInput) } },
        responses: {
          ...errorResponses({
            400: 'invalid_request or sso_oidc_completion_invalid',
            404: 'sso_disabled or sso_not_found',
            409: 'organization_context_changed, sso_configuration_changed or sso_domain_unverified',
          }),
          201: {
            description: 'Owned delegation ID and expiration',
            content: json(z.object({ id: z.uuid(), expiresAt: z.iso.datetime() })),
          },
          403: {
            description: 'team_management_access_denied or sso_reauthentication_required',
            content: json(FreshProofChallenge),
          },
        },
      }),
      async (c) => {
        const input = c.req.valid('json')
        const proof =
          input.proofAttemptId && delegationProofCookie(deps.publicUrl, input.proofAttemptId)
        const result = await bindSsoDelegation(
          deps,
          c.var.principal,
          c.req.raw.headers,
          input,
          proof ? getCookie(c, proof.name) : undefined,
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        if (proof) deleteCookie(c, proof.name, proof.options)
        return c.json(result.value, 201)
      },
    )
    app.openapi(
      createRoute({
        method: 'delete',
        path: `${SSO_DELEGATIONS_PATH}/{bindingId}`,
        operationId: REVOKE_SSO_DELEGATION,
        tags: ['SSO'],
        summary: 'Revoke the caller’s exact SSO delegation',
        description: 'Requires a current team browser session. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: { headers, params: z.object({ bindingId: z.uuid() }) },
        responses: {
          ...errorResponses({
            400: 'invalid_request',
            403: 'team_management_access_denied or sso_required',
            404: 'sso_disabled or sso_not_found',
            409: 'organization_context_changed',
          }),
          204: { description: 'The exact owned delegation was revoked' },
        },
      }),
      async (c) => {
        await revokeSsoDelegation(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').bindingId,
        )
        return c.body(null, 204)
      },
    )
  }
}
