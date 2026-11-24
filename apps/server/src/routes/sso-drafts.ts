import { createRoute, z } from '@hono/zod-openapi'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { DEFAULT_BODY_LIMIT, routeBodyLimit } from '../body-limit.ts'
import type { CallerEnv } from '../caller.ts'
import { ErrorBody, errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoEnabled, requireSsoRetained } from '../sso.ts'
import {
  ActivateSsoProviderInput,
  activateSsoProvider,
  CreateSsoProviderInput,
  createSsoProvider,
  DeleteSsoProviderInput,
  deleteSsoProvider,
  guardSsoDraftInput,
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
import { samlProviderRequestMaximumBytes } from '../sso-saml-configuration.ts'
import { ssoRecoveryWritePrincipal } from '../sso-write-middleware.ts'
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
const repairHeaders = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description: 'Required. Identifies the active team or the team of a live recovery grant.',
  }),
})
export const FreshProofChallenge = ErrorBody.extend({
  attemptId: z.uuid().optional(),
  proofMethods: z.array(z.string()).optional(),
  expiresAt: z.iso.datetime().optional(),
}).openapi('SsoFreshProofChallenge')

/** Browser-only trust changes; no corresponding machine tools or commands exist. */
export function ssoDraftRoutes(deps: SsoDraftDeps & OidcProviderTestDeps): RouteModule {
  const draftEnabled: MiddlewareHandler<CallerEnv> = async (_c, next) => {
    requireSsoEnabled(deps.capabilities)
    await next()
  }
  const draftBody: MiddlewareHandler<CallerEnv> = async (c, next) => {
    const body = await c.req.arrayBuffer()
    let input: unknown
    try {
      input = await c.req.json()
    } catch (error) {
      // Let the route validator report ordinary malformed JSON.
      if (!(error instanceof SyntaxError)) throw error
    }
    const protocol = guardSsoDraftInput(deps.capabilities, input)
    if (protocol !== 'saml' && body.byteLength > DEFAULT_BODY_LIMIT) throw new HTTPException(413)
    await next()
  }
  const retained: MiddlewareHandler<CallerEnv> = async (_c, next) => {
    requireSsoRetained(deps.capabilities)
    await next()
  }
  const testEnabled: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    requireSsoEnabled(deps.capabilities)
    await next()
  }
  const activationEnabled: MiddlewareHandler<CallerEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    requireSsoRetained(deps.capabilities)
    if (!deps.capabilities.ssoOidcEnabled && !deps.capabilities.ssoSamlEnabled) {
      let input: unknown
      try {
        input = await c.req.json()
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      if (input && typeof input === 'object' && 'enabled' in input && input.enabled === true)
        requireSsoEnabled(deps.capabilities)
    }
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
    const middleware = [
      routeBodyLimit(samlProviderRequestMaximumBytes),
      draftEnabled,
      ...sessionMiddleware,
      draftBody,
    ] as const
    const deleteMiddleware = [retained, ...sessionMiddleware] as const
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/providers',
        operationId: 'createSsoProvider',
        tags: ['SSO'],
        summary: 'Create a disabled SSO provider draft',
        description:
          'Verified team owner/admin browser session with fresh proof. An enrolled owner can spend one recovery grant on an enforced team. Provider credentials and raw metadata are write-only. Returns 404 sso_disabled when the requested protocol is off. SAML is unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: repairHeaders,
          body: { required: true, content: json(CreateSsoProviderInput) },
        },
        responses: {
          201: { description: 'Safe provider draft', content: json(ProviderResult) },
          ...errors,
          413: { description: 'payload_too_large', content: json(ErrorBody) },
        },
      }),
      async (c) => {
        const recovery = ssoRecoveryWritePrincipal(c)
        const result = await createSsoProvider(
          deps,
          recovery ?? c.var.principal,
          c.req.raw.headers,
          c.req.valid('json'),
          recovery !== undefined,
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
        summary: 'Start a browser-bound SSO provider test',
        description:
          'Verified team owner/admin browser session with fresh administration proof and expected revision. An enrolled owner can spend one recovery grant on an enforced team to test a provider, including an enabled provider. Follow the authorization URL in the same browser and check the provider inventory for the result. Returns 404 sso_disabled when the provider protocol is off.',
        security: [{ session: [] }],
        middleware: [testEnabled, ...sessionMiddleware] as const,
        request: {
          headers: repairHeaders,
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
        const recovery = ssoRecoveryWritePrincipal(c)
        const result = await testSsoProvider(
          deps,
          recovery ?? c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
          recovery !== undefined,
        )
        if (result.status === 'proof_required') {
          if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
          return c.json(result.body, 403)
        }
        const { setCookie, setTestCookie, ...body } = result.value
        c.header('Set-Cookie', setCookie, { append: true })
        if (setTestCookie) c.header('Set-Cookie', setTestCookie, { append: true })
        return c.json(body, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/providers/{providerId}/activation',
        operationId: 'activateSsoProvider',
        tags: ['SSO'],
        summary: 'Enable or disable an SSO provider',
        description:
          'Verified team owner browser session with fresh administration proof. An enrolled owner can spend one recovery grant on an enforced team. Enabling requires a passed test of the current revision and a positively rechecked, unexpired linked domain. An enforced team must keep a usable provider. When the provider protocol is off, enabling returns 404 sso_disabled and disabling stays available.',
        security: [{ session: [] }],
        middleware: [activationEnabled, ...sessionMiddleware] as const,
        request: {
          headers: repairHeaders,
          params: z.object({ providerId: z.uuid() }),
          body: { required: true, content: json(ActivateSsoProviderInput) },
        },
        responses: {
          ...errors,
          200: { description: 'Safe provider summary', content: json(ProviderResult) },
          409: {
            description:
              'organization_context_changed, sso_configuration_changed, sso_test_required, sso_domain_unverified or sso_last_provider',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const recovery = ssoRecoveryWritePrincipal(c)
        const result = await activateSsoProvider(
          deps,
          recovery ?? c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
          recovery !== undefined,
        )
        if (result.setCookie) c.header('Set-Cookie', result.setCookie, { append: true })
        if (result.status === 'proof_required') return c.json(result.body, 403)
        return c.json(result.value, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/sso/providers/{providerId}/link',
        operationId: 'linkSsoAccount',
        tags: ['SSO'],
        summary: 'Start explicit linking of the caller’s SSO identity',
        description:
          'Current team member browser session with independent mailbox proof. Follow the authorization URL in the same browser and explicitly complete the pending link. Returns 404 sso_disabled when the provider protocol is off.',
        security: [{ session: [] }],
        middleware: [testEnabled, ...sessionMiddleware] as const,
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
        const { setCookie, stateCookie, ...body } = result.value
        c.header('Set-Cookie', setCookie, { append: true })
        if (stateCookie) c.header('Set-Cookie', stateCookie, { append: true })
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
          'Verified team owner/admin browser session with fresh proof and expected revision. An enrolled owner can spend one recovery grant on an enforced team. Omitted secrets are preserved. Provider credentials and raw metadata are write-only. Returns 404 sso_disabled when the requested protocol is off. SAML is unavailable.',
        security: [{ session: [] }],
        middleware: [...middleware] as const,
        request: {
          headers: repairHeaders,
          params: z.object({ providerId: z.uuid() }),
          body: { required: true, content: json(UpdateSsoProviderInput) },
        },
        responses: {
          200: { description: 'Safe provider draft', content: json(ProviderResult) },
          ...errors,
          413: { description: 'payload_too_large', content: json(ErrorBody) },
        },
      }),
      async (c) => {
        const recovery = ssoRecoveryWritePrincipal(c)
        const result = await updateSsoProvider(
          deps,
          recovery ?? c.var.principal,
          c.req.raw.headers,
          c.req.valid('param').providerId,
          c.req.valid('json'),
          recovery !== undefined,
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
          'Verified team owner/admin browser session with fresh proof and expected revision. An enforced team must keep a usable provider. An authorized repeat retirement is idempotent. Stays available while SSO_OIDC_ENABLED is off.',
        security: [{ session: [] }],
        middleware: [...deleteMiddleware] as const,
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
          409: {
            description:
              'organization_context_changed, sso_configuration_changed or sso_last_provider',
            content: json(ErrorBody),
          },
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
