import { createRoute, z } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import { authenticated, errorResponses, json, type RouteModule } from '../openapi.ts'
import { requireSsoRetained } from '../sso.ts'
import { restTeamReadAccess, ssoRecoveryReadPrincipal } from '../sso-read-routes.ts'
import { authorizeSsoRead, getSsoPolicy, listSsoProviders, type SsoReadDeps } from '../sso-reads.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from '../team-management.ts'
import { queryLimit } from './audit-log.ts'

export const SsoProviderPage = z
  .object({
    data: z.array(
      z.object({
        id: z.uuid(),
        protocol: z.string(),
        revision: z.number().int(),
        enabled: z.boolean(),
        displayName: z.string(),
        issuer: z.string(),
        clientId: z.string().nullable(),
        createdAt: z.iso.datetime(),
        validationStatus: z.string(),
        testStatus: z.string(),
        domains: z.array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            generation: z.number().int(),
            status: z.string(),
          }),
        ),
        links: z
          .array(z.object({ id: z.uuid(), generation: z.int().positive() }))
          .optional()
          .openapi({
            description: 'Opaque link IDs and generations for browser-session recovery.',
          }),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi('SsoProviderPage')
export const SsoPolicy = z
  .object({
    requireSso: z.boolean(),
    admission: z.string(),
    policyRevision: z.number().int(),
    trustGeneration: z.number().int(),
  })
  .openapi('SsoPolicy')
const recoveryReadHeaders = z.object({
  'X-Expected-Organization-Id': z.string().optional().openapi({
    description: 'Identifies the active team or the team of a live browser recovery grant.',
  }),
})

export function ssoRoutes(deps: SsoReadDeps): RouteModule {
  const enabled: MiddlewareHandler<CallerEnv> = async (_c, next) => {
    requireSsoRetained(deps.capabilities)
    await next()
  }
  const responses = errorResponses({
    400: 'invalid_request, invalid_limit or invalid_cursor',
    403: 'team_management_access_denied',
    404: 'sso_disabled',
    409: 'organization_context_changed',
  })
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/sso/providers',
        operationId: 'listSsoProviders',
        tags: ['SSO'],
        summary: 'List safe SSO provider drafts for the current team',
        description:
          'Owner/admin only; read/full API key or authorized MCP OAuth. This read remains available while both SSO protocol settings are off. Follow nextCursor for all providers. Opaque links and generations are only returned to browser sessions. Configuration, secrets, raw metadata and identity claims are never returned. Objects and status strings may gain values.',
        security: authenticated,
        middleware: [enabled, caller] as const,
        request: {
          headers: recoveryReadHeaders,
          query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
        },
        responses: {
          200: { description: 'A page of provider drafts', content: json(SsoProviderPage) },
          ...responses,
        },
      }),
      async (c) => {
        const recovery = ssoRecoveryReadPrincipal(c)
        const principal = recovery ?? c.var.principal
        await authorizeSsoRead(deps, principal)
        if (principal === c.var.principal)
          await organizationContextAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))(
            deps.db,
            principal.organization.id,
          )
        const query = c.req.valid('query')
        return c.json(
          await listSsoProviders(deps, principal, {
            ...query,
            limit: queryLimit(query.limit),
            includeRecoveryLinks: !c.req.raw.headers.has('authorization') && !recovery,
          }),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/sso/policy',
        operationId: 'getSsoPolicy',
        tags: ['SSO'],
        summary: 'Read the current team SSO policy',
        description:
          'Owner/admin only; read/full API key or authorized MCP OAuth. An unconfigured team has invitation-only admission and no SSO requirement. This read remains available while both SSO protocol settings are off.',
        security: authenticated,
        middleware: [enabled, caller] as const,
        request: { headers: recoveryReadHeaders },
        responses: {
          200: { description: 'The team policy', content: json(SsoPolicy) },
          ...responses,
        },
      }),
      async (c) => {
        const principal = ssoRecoveryReadPrincipal(c) ?? c.var.principal
        await authorizeSsoRead(deps, principal)
        if (principal !== c.var.principal) return c.json(await getSsoPolicy(deps, principal), 200)
        await organizationContextAccess(principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))(
          deps.db,
          principal.organization.id,
        )
        const access = await restTeamReadAccess(c)?.()
        return c.json(await getSsoPolicy(deps, principal, access?.policy), 200)
      },
    )
  }
}
