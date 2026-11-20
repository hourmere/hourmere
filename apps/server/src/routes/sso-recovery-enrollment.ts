import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoEnabled } from '../sso.ts'
import {
  ACCEPT_SSO_RECOVERY_ENROLLMENT,
  AcceptSsoRecoveryEnrollmentInput,
  acceptSsoRecoveryEnrollment,
  CONFIGURE_SSO_RECOVERY,
  ConfigureSsoRecoveryInput,
  configureSsoRecovery,
  type SsoRecoveryEnrollmentDeps,
} from '../sso-recovery-enrollment.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

const path = '/api/v1/team/sso/recovery'
const headers = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description: 'Required for writes and must match the current team.',
  }),
})
const responses = {
  ...errorResponses({
    400: 'invalid_request',
    404: 'sso_disabled or sso_not_found',
    409: 'organization_context_changed or sso_configuration_changed',
  }),
  403: {
    description: 'team_management_access_denied or sso_reauthentication_required',
    content: json(FreshProofChallenge),
  },
}

export function ssoRecoveryEnrollmentRoutes(deps: SsoRecoveryEnrollmentDeps): RouteModule {
  const guard: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    requireSsoEnabled(deps.capabilities)
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  return ({ app, caller }) => {
    const middleware = [guard, teamManagementSessionCaller(caller)] as const
    app.openapi(
      createRoute({
        method: 'post',
        path,
        operationId: CONFIGURE_SSO_RECOVERY,
        tags: ['SSO'],
        summary: 'Nominate a current team owner for SSO recovery',
        description:
          'Requires a team owner browser session and fresh administration proof. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: { headers, body: { required: true, content: json(ConfigureSsoRecoveryInput) } },
        responses: {
          ...responses,
          201: {
            description: 'Pending enrollment and the resulting policy revision',
            content: json(
              z.strictObject({
                enrollmentId: z.uuid(),
                expiresAt: z.iso.datetime(),
                policyRevision: z.int().positive(),
              }),
            ),
          },
        },
      }),
      async (c) => {
        const result = await configureSsoRecovery(
          deps,
          c.var.principal,
          c.req.raw.headers,
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
        path: `${path}/{enrollmentId}/accept`,
        operationId: ACCEPT_SSO_RECOVERY_ENROLLMENT,
        tags: ['SSO'],
        summary: 'Accept the caller’s SSO recovery nomination',
        description:
          'Requires the nominated owner’s browser session and independent mailbox proof. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers,
          params: z.object({ enrollmentId: z.uuid() }),
          body: { required: true, content: json(AcceptSsoRecoveryEnrollmentInput) },
        },
        responses: {
          ...responses,
          204: { description: 'The nominee was added as a recovery owner' },
        },
      }),
      async (c) => {
        const result = await acceptSsoRecoveryEnrollment(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').enrollmentId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.body(null, 204)
      },
    )
  }
}
