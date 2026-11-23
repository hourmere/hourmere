import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoRetained } from '../sso.ts'
import { SetSsoPolicyInput, type SsoPolicyDeps, setSsoPolicy } from '../sso-policy.ts'
import { ssoRecoveryWritePrincipal } from '../sso-write-middleware.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { SsoPolicy } from './sso.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

export function ssoPolicyRoutes(deps: SsoPolicyDeps): RouteModule {
  const guard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    requireSsoRetained(deps.capabilities)
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'put',
        path: '/api/v1/team/sso/policy',
        operationId: 'setSsoPolicy',
        tags: ['SSO'],
        summary: 'Set the current team SSO policy',
        description:
          'Requires a verified team owner or administrator browser session and fresh administration proof. An enrolled owner can spend recovery authority to turn off enforcement without enabling JIT. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [guard, teamManagementSessionCaller(caller)] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required. Identifies the active team or the team of a live recovery grant.',
            }),
          }),
          body: { required: true, content: json(SetSsoPolicyInput) },
        },
        responses: {
          200: { description: 'The updated team policy', content: json(SsoPolicy) },
          ...errorResponses({
            400: 'invalid_request',
            404: 'sso_disabled',
            409: 'organization_context_changed, sso_configuration_changed, sso_domain_unverified, sso_test_required or sso_recovery_required',
          }),
          403: {
            description: 'team_management_access_denied or sso_reauthentication_required',
            content: json(FreshProofChallenge),
          },
        },
      }),
      async (c) => {
        const recovery = ssoRecoveryWritePrincipal(c)
        const result = await setSsoPolicy(
          deps,
          recovery ?? c.var.principal,
          c.req.raw.headers,
          c.req.valid('json'),
          recovery !== undefined,
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
  }
}
