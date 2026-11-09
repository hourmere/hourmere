import { createRoute, z } from '@hono/zod-openapi'
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
  rotateScimToken,
  ScimTokenError,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

const Token = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    createdByUserId: z.string().nullable(),
    rotatedByUserId: z.string().nullable(),
    rotatedAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    previousValidUntil: z.string().nullable(),
  })
  .openapi('ScimProvisioningToken')
const Issued = z.object({ token: Token, secret: z.string() }).openapi('IssuedScimProvisioningToken')
const params = z.object({ organizationId: z.uuid() })
const itemParams = params.extend({ id: z.uuid() })
const headers = z.object({ 'x-expected-organization-id': z.uuid() })

/** Credential administration follows API key management's strict session-only boundary. */
export function provisioningTokenRoutes({
  db,
  enabled = false,
}: {
  db: Db
  enabled?: boolean
}): RouteModule {
  return ({ app, caller }) => {
    const boundary = createMiddleware(async (c, next) => {
      c.header('Cache-Control', 'private, no-store')
      c.header('Referrer-Policy', 'no-referrer')
      if (!enabled && c.req.method === 'POST')
        return c.json({ error: 'scim_provisioning_disabled' }, 404)
      if (c.req.raw.headers.has('authorization')) return c.json({ error: 'session_required' }, 403)
      await next()
    })
    const session = createMiddleware<CallerEnv>(async (c, next) => {
      const principal = c.var.principal
      if (
        principal.kind !== 'session' ||
        principal.organization.personal ||
        principal.organization.id !== c.req.param('organizationId')
      ) {
        return c.json({ error: 'scim_token_access_denied' }, 403)
      }
      if (
        !['GET', 'HEAD'].includes(c.req.method) &&
        c.req.header('x-expected-organization-id') !== principal.organization.id
      ) {
        return c.json({ error: 'organization_context_changed' }, 409)
      }
      await next()
    })
    const limit = rateLimit(createRateLimiter({ limit: 30, windowSeconds: 60 }))
    const middleware: [typeof boundary, typeof limit, typeof caller, typeof session] = [
      boundary,
      limit,
      caller,
      session,
    ]
    const common = {
      tags: ['SCIM provisioning tokens'],
      security: [{ session: [] }],
      middleware,
      description:
        'Browser-session-only provisioning credential administration. Requires a current verified owner/admin of the active non-personal organization; creating and rotating require an owner. Listing and revoking remain available when SCIM is disabled. Any Authorization header is refused. Writes require X-Expected-Organization-Id equal to the path organization. Secrets appear only in create/rotate responses; no SCIM resources are available yet.',
    }
    const errors = errorResponses({
      400: 'invalid_request or scim_token_invalid_input',
      403: 'session_required or scim_token_access_denied or scim_token_forbidden or forbidden',
      404: 'scim_provisioning_disabled or scim_token_not_found',
      409: 'organization_context_changed or scim_token_conflict (active token limit, revoked token or active rotation overlap)',
    })
    if (errors[401]) errors[401].description = 'unauthorized: a valid browser session is required'
    if (errors[429])
      errors[429].description = 'rate_limited: request budget exhausted; retry after Retry-After'
    const actor = (principal: CallerEnv['Variables']['principal'], organizationId: string) => {
      if (principal.kind !== 'session') throw new ScimTokenError('forbidden', 403)
      return { organizationId, userId: principal.user.id, sessionId: principal.sessionId }
    }
    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: '/api/v1/organizations/{organizationId}/provisioning-tokens',
        operationId: 'listScimProvisioningTokens',
        summary: 'List provisioning token metadata',
        request: {
          params,
          query: z.object({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            after: z.uuid().optional(),
          }),
        },
        responses: {
          200: {
            description: 'Metadata only; never secrets or hashes',
            content: json(z.object({ tokens: z.array(Token), nextCursor: z.uuid().nullable() })),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await listScimTokens(db, {
            ...actor(c.var.principal, c.req.valid('param').organizationId),
            ...c.req.valid('query'),
          }),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: '/api/v1/organizations/{organizationId}/provisioning-tokens',
        operationId: 'createScimProvisioningToken',
        summary: 'Create a provisioning token',
        request: {
          params,
          headers,
          body: {
            required: true,
            content: json(z.strictObject({ name: z.string().trim().min(1).max(100) })),
          },
        },
        responses: {
          201: {
            description: 'Save this secret now; it cannot be retrieved again',
            content: json(Issued),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await createScimToken(db, {
            ...actor(c.var.principal, c.req.valid('param').organizationId),
            ...c.req.valid('json'),
          }),
          201,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: '/api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate',
        operationId: 'rotateScimProvisioningToken',
        summary: 'Rotate a provisioning token with bounded overlap',
        request: {
          params: itemParams,
          headers,
          body: {
            required: true,
            content: json(
              z.strictObject({ overlapSeconds: z.number().int().min(0).max(86400).default(3600) }),
            ),
          },
        },
        responses: {
          200: {
            description:
              'One-time replacement secret; previous secret accepted until previousValidUntil',
            content: json(Issued),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await rotateScimToken(db, {
            ...actor(c.var.principal, c.req.valid('param').organizationId),
            tokenId: c.req.valid('param').id,
            ...c.req.valid('json'),
          }),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'delete',
        path: '/api/v1/organizations/{organizationId}/provisioning-tokens/{id}',
        operationId: 'revokeScimProvisioningToken',
        summary: 'Permanently revoke both token generations',
        request: { params: itemParams, headers },
        responses: {
          200: {
            description: 'Revoked metadata; revocation is idempotent',
            content: json(z.object({ token: Token })),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          {
            token: await revokeScimToken(db, {
              ...actor(c.var.principal, c.req.valid('param').organizationId),
              tokenId: c.req.valid('param').id,
            }),
          },
          200,
        ),
    )
  }
}
