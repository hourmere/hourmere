import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoEnabled } from '../sso.ts'
import {
  CreateSsoProviderInput,
  createSsoProvider,
  DeleteSsoProviderInput,
  deleteSsoProvider,
  type SsoDraftDeps,
  UpdateSsoProviderInput,
  updateSsoProvider,
} from '../sso-drafts.ts'
import {
  LinkSsoAccountInput,
  linkSsoAccount,
  type OidcProviderTestDeps,
  TestSsoProviderInput,
  testSsoProvider,
} from '../sso-oidc-sign-in.ts'
import { teamManagementSessionCaller } from '../team-management.ts'

export const SsoProviderDraft = z
  .object({
    id: z.uuid(),
    protocol: z.string(),
    revision: z.number().int(),
    enabled: z.boolean(),
    displayName: z.string(),
    issuer: z.string(),
    clientId: z.string().nullable(),
    hasClientSecret: z.boolean(),
    validationStatus: z.string(),
    testStatus: z.string(),
  })
  .openapi('SsoProviderDraft')
const ProviderResult = z.object({ provider: SsoProviderDraft })
export const FreshProofChallenge = ErrorBody.extend({
  attemptId: z.uuid().optional(),
  proofMethods: z.array(z.string()).optional(),
  expiresAt: z.iso.datetime().optional(),
}).openapi('SsoFreshProofChallenge')

/** Browser-only trust changes; no corresponding machine tools or commands exist. */
export function ssoDraftRoutes(deps: SsoDraftDeps & OidcProviderTestDeps): RouteModule {
  const enabled: MiddlewareHandler<CallerEnv> = async (c, next) => {
    requireSsoEnabled(deps.capabilities)
    let input: unknown
    try {
      input = await c.req.json()
    } catch (error) {
      // Let session authorization precede ordinary malformed-body validation.
      if (!(error instanceof SyntaxError)) throw error
    }
    if (
      input &&
      typeof input === 'object' &&
      (('protocol' in input && input.protocol === 'saml') || 'saml' in input)
    )
      throw new DomainError('not_found', 'sso_disabled')
    await next()
  }
  const oidcEnabled: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    requireSsoEnabled(deps.capabilities, 'oidc')
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
      409: 'organization_context_changed or sso_configuration_changed',
    }),
    403: {
      description:
        'team_management_access_denied or sso_reauthentication_required; retry the exact input after completing fresh proof',
      content: json(FreshProofChallenge),
    },
  }
  return ({ app, caller }) => {
    const sessionMiddleware = [
      exactOrigin,
      teamManagementSessionCaller(caller),
      sessionOnly,
    ] as const
    const middleware = [enabled, ...sessionMiddleware] as const
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/providers',
        operationId: 'createSsoProvider',
        tags: ['SSO'],
        summary: 'Create a disabled SSO provider draft',
        description:
          'Verified team owner/admin browser session with fresh proof only. Secrets are write-only. OIDC and SAML are being built and remain unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          body: { required: true, content: json(CreateSsoProviderInput) },
        },
        responses: {
          201: { description: 'Safe provider draft', content: json(ProviderResult) },
          ...errors,
        },
      }),
      async (c) => {
        const result = await createSsoProvider(
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
        path: '/api/v1/team/sso/providers/{providerId}/test',
        operationId: 'testSsoProvider',
        tags: ['SSO'],
        summary: 'Start a browser-bound OIDC test of a disabled SSO provider',
        description:
          'Verified team owner/admin browser session with fresh proof and expected revision. Follow the authorization URL in the same browser and check the provider inventory for the result. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [oidcEnabled, ...sessionMiddleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          params: z.object({ providerId: z.uuidv7() }),
          body: { required: true, content: json(TestSsoProviderInput) },
        },
        responses: {
          200: {
            description: 'Authorization URL and test attempt ID',
            content: json(z.object({ url: z.url(), attemptId: z.uuid() })),
          },
          ...errors,
        },
      }),
      async (c) => {
        const result = await testSsoProvider(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
        )
        if (result.status === 'proof_required') {
          if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
          return c.json(result.body, 403)
        }
        const { setCookie, ...body } = result.value
        c.header('Set-Cookie', setCookie, { append: true })
        return c.json(body, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/providers/{providerId}/link',
        operationId: 'linkSsoAccount',
        tags: ['SSO'],
        summary: 'Start explicit linking of the caller’s OIDC identity',
        description:
          'Current team member browser session with independent mailbox proof. Follow the authorization URL in the same browser and explicitly complete the pending link. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [oidcEnabled, ...sessionMiddleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description: 'Required for writes and must match the current team.',
            }),
          }),
          params: z.object({ providerId: z.uuidv7() }),
          body: { required: true, content: json(LinkSsoAccountInput) },
        },
        responses: {
          ...errors,
          200: {
            description: 'Authorization URL and link attempt ID',
            content: json(z.object({ url: z.url(), attemptId: z.uuid() })),
          },
          409: {
            description:
              'organization_context_changed, sso_configuration_changed or sso_domain_unverified',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const result = await linkSsoAccount(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
        )
        if (result.status === 'proof_required') {
          if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
          return c.json(result.body, 403)
        }
        const { setCookie, ...body } = result.value
        c.header('Set-Cookie', setCookie, { append: true })
        return c.json(body, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/team/sso/providers/{providerId}',
        operationId: 'updateSsoProvider',
        tags: ['SSO'],
        summary: 'Update an SSO provider draft',
        description:
          'Verified team owner/admin browser session with fresh proof and expected revision. Omitted secrets are preserved; replacements are never returned. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          params: z.object({ providerId: z.uuid() }),
          body: { required: true, content: json(UpdateSsoProviderInput) },
        },
        responses: {
          200: { description: 'Safe provider draft', content: json(ProviderResult) },
          ...errors,
        },
      }),
      async (c) => {
        const result = await updateSsoProvider(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
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
        path: '/api/v1/team/sso/providers/{providerId}',
        operationId: 'deleteSsoProvider',
        tags: ['SSO'],
        summary: 'Retire an SSO provider',
        description:
          'Verified team owner/admin browser session with fresh proof and expected revision. An authorized repeat retirement is idempotent. SSO remains unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: z.object({
            'X-Expected-Organization-Id': z.string().optional().openapi({
              description:
                'Required for writes; must match the current team. Missing or stale context returns 409.',
            }),
          }),
          params: z.object({ providerId: z.uuid() }),
          body: { required: true, content: json(DeleteSsoProviderInput) },
        },
        responses: {
          200: {
            description: 'Provider retired',
            content: json(z.object({ deleted: z.boolean() })),
          },
          ...errors,
        },
      }),
      async (c) => {
        const result = await deleteSsoProvider(
          deps,
          c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
  }
}
