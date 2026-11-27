import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, errorResponses, json, type RouteModule } from '../openapi.ts'
import {
  requireSsoEnabled,
  requireSsoRetained,
  type SsoCapabilities,
  USE_SSO_RECOVERY,
} from '../sso.ts'
import {
  ACCEPT_SSO_RECOVERY_ENROLLMENT,
  AcceptSsoRecoveryEnrollmentInput,
  acceptSsoRecoveryEnrollment,
  CONFIGURE_SSO_RECOVERY,
  ConfigureSsoRecoveryInput,
  configureSsoRecovery,
  type SsoRecoveryEnrollmentDeps,
} from '../sso-recovery-enrollment.ts'
import { UseSsoRecoveryInput, useSsoRecovery } from '../sso-recovery-use.ts'
import { teamManagementSessionCaller } from '../team-management.ts'
import { FreshProofChallenge } from './sso-drafts.ts'

const path = '/api/v1/team/sso/recovery'
const headers = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description: 'Required for writes and must match the current team.',
  }),
})
const recoveryTargetHeader = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description:
      'Required. Identifies the team to recover, which can differ from the active space.',
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
  // Recovery use stays available while every protocol's setting is off; enrolling adds trust.
  const guard =
    (require: (capabilities: SsoCapabilities) => void): MiddlewareHandler<CallerEnv> =>
    async (c, next) => {
      c.header('Cache-Control', 'no-store')
      require(deps.capabilities)
      if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
        throw new DomainError('forbidden', 'team_management_access_denied')
      await next()
    }
  return ({ app, caller }) => {
    const middleware = [guard(requireSsoEnabled), teamManagementSessionCaller(caller)] as const
    const useMiddleware = [guard(requireSsoRetained), teamManagementSessionCaller(caller)] as const
    app.openapi(
      createRoute({
        method: 'post',
        path: `${path}/use`,
        operationId: USE_SSO_RECOVERY,
        tags: ['SSO'],
        summary: 'Start SSO recovery for the specified team',
        description:
          'Requires an enrolled owner’s browser session and fresh mailbox proof. Permits inspecting SSO configuration and one provider repair write or one write turning off enforcement. Stays available while both protocol settings are off.',
        security: [{ session: [] }],
        middleware: [...useMiddleware] as const,
        request: {
          headers: recoveryTargetHeader,
          body: { required: true, content: json(UseSsoRecoveryInput) },
        },
        responses: {
          ...errorResponses({
            400: 'invalid_request',
            404: 'sso_disabled',
            409: 'organization_context_changed or sso_configuration_changed',
          }),
          403: {
            description: responses[403].description,
            content: json(z.union([FreshProofChallenge, ErrorBody])),
          },
          204: { description: 'Recovery authority granted to the current browser session' },
        },
      }),
      async (c) => {
        const result = await useSsoRecovery(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path,
        operationId: CONFIGURE_SSO_RECOVERY,
        tags: ['SSO'],
        summary: 'Nominate a current team owner for SSO recovery',
        description:
          'Requires a team owner browser session and fresh administration proof. Returns 404 sso_disabled while both protocol settings are off.',
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
          'Requires the nominated owner’s browser session and independent mailbox proof. Returns 404 sso_disabled while both protocol settings are off.',
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
