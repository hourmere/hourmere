import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoEnabled } from '../sso.ts'
import {
  CreateSsoDomainChallengeInput,
  createSsoDomainChallenge,
  DeleteSsoDomainInput,
  deleteSsoDomain,
  type SsoDomainDeps,
  VerifySsoDomainInput,
  verifySsoDomain,
} from '../sso-domains.ts'
import { teamManagementSessionCaller } from '../team-management.ts'

const DomainSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  generation: z.number().int(),
  status: z.string(),
})
const ChallengeResult = z.object({
  domain: DomainSummary,
  txtName: z.string(),
  txtValue: z.string(),
  expiresAt: z.iso.datetime(),
})
const VerificationResult = z.object({
  domain: DomainSummary.extend({
    verifiedAt: z.iso.datetime().nullable(),
    verificationExpiresAt: z.iso.datetime().nullable(),
    nextCheckAt: z.iso.datetime().nullable(),
  }),
})
const FreshProofChallenge = ErrorBody.extend({
  attemptId: z.uuid().optional(),
  proofMethods: z.array(z.string()).optional(),
  expiresAt: z.iso.datetime().optional(),
}).openapi('SsoFreshProofChallenge')

/** Browser-only trust changes; no corresponding machine tools or commands exist. */
export function ssoDomainRoutes(deps: SsoDomainDeps): RouteModule {
  const enabled: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    requireSsoEnabled(deps.capabilities)
    await next()
  }
  const exactOrigin: MiddlewareHandler<CallerEnv> = async (c, next) => {
    if (c.req.header('origin') !== new URL(deps.publicUrl).origin)
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  const sessionOnly: MiddlewareHandler<CallerEnv> = async (c, next) => {
    if (c.var.principal.kind !== 'session')
      throw new DomainError('forbidden', 'team_management_access_denied')
    await next()
  }
  const errors = {
    ...errorResponses({
      400: 'invalid_request',
      403: 'team_management_access_denied or sso_reauthentication_required',
      404: 'sso_disabled or sso_not_found',
      409: 'organization_context_changed, sso_configuration_changed or sso_domain_unverified',
    }),
    403: {
      description:
        'team_management_access_denied or sso_reauthentication_required; retry the exact input after completing fresh proof',
      content: json(FreshProofChallenge),
    },
  }
  return ({ app, caller }) => {
    const middleware = [
      enabled,
      exactOrigin,
      teamManagementSessionCaller(caller),
      sessionOnly,
    ] as const
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/domains',
        operationId: 'createSsoDomainChallenge',
        tags: ['SSO'],
        summary: 'Create or rotate a DNS domain challenge',
        description:
          'Verified team owner/admin browser session with fresh proof only. The TXT challenge is returned once; only its digest is stored. OIDC and SAML are being built and remain unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          body: { required: true, content: json(CreateSsoDomainChallengeInput) },
        },
        responses: {
          201: { description: 'One-time DNS challenge', content: json(ChallengeResult) },
          ...errors,
        },
      }),
      async (c) => {
        const result = await createSsoDomainChallenge(
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
        path: '/api/v1/team/sso/domains/{domainId}/verify',
        operationId: 'verifySsoDomain',
        tags: ['SSO'],
        summary: 'Verify an exact domain through trusted DNS',
        description:
          'Verified team owner/admin browser session with fresh proof and expected generation. DNS errors return unknown status. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          params: z.object({ domainId: z.uuid() }),
          body: { required: true, content: json(VerifySsoDomainInput) },
        },
        responses: {
          200: {
            description: 'Safe domain verification status',
            content: json(VerificationResult),
          },
          ...errors,
        },
      }),
      async (c) => {
        const result = await verifySsoDomain(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').domainId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/team/sso/domains/{domainId}',
        operationId: 'deleteSsoDomain',
        tags: ['SSO'],
        summary: 'Retire a domain claim',
        description:
          'Verified team owner/admin browser session with fresh proof and expected generation. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          params: z.object({ domainId: z.uuid() }),
          body: { required: true, content: json(DeleteSsoDomainInput) },
        },
        responses: {
          200: {
            description: 'Domain retired',
            content: json(z.object({ deleted: z.boolean() })),
          },
          ...errors,
        },
      }),
      async (c) => {
        const result = await deleteSsoDomain(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').domainId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
  }
}
