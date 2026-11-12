import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  BRAND_LOGO_MAX_BYTES,
  BrandingUpdateInput,
  getBranding,
  getBrandLogo,
  setBranding,
  uploadBrandLogo,
} from '@hourmere/scheduling'
import {
  authenticated,
  callerWithBodyLimit,
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextAccess,
  organizationContextWriteLock,
} from '../team-management.ts'

export const BrandingView = z
  .object({
    brandLogo: z.string().nullable(),
    brandPrimaryColor: z.string().nullable(),
    buttonTextColor: z
      .string()
      .nullable()
      .openapi({ description: 'Readable button text, currently #FFFFFF or #000000' }),
    backgroundContrast: z.number().nullable().openapi({
      description: 'WCAG contrast against white (#FFFFFF), not light or dark page themes',
    }),
    buttonTextContrast: z.number().nullable(),
  })
  .openapi('Branding')
export const BrandingUpdate = BrandingUpdateInput
const headers = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Expected organization. Required for session writes; stale context is rejected. Ignored for API keys.',
  }),
})
const errors = errorResponses({
  400: 'invalid_brand_logo, brand_logo_too_large or invalid_request',
  403: 'insufficient_role, team_management_access_denied or forbidden',
  404: 'brand_logo_not_found',
  409: 'organization_context_changed',
})
export function brandingRoutes(deps: ServiceDeps): RouteModule {
  const writeContext = (principal: Principal, expected?: string) => ({
    ...serviceContext(deps, principal),
    prepareOrganizationWrite: async (trx: Db) => {
      await organizationContextWriteLock(principal)(trx)
      await organizationContextAccess(principal, expected, true)(trx, principal.organization.id)
    },
    authorizeOrganizationWrite: organizationContextAccess(principal, expected, true, 'key share'),
  })
  const readContext = async (principal: Principal, expected?: string) => {
    await organizationContextAccess(principal, expected)(deps.db, principal.organization.id)
    return serviceContext(deps, principal)
  }
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/branding',
        operationId: 'getBranding',
        tags: ['Branding'],
        summary: 'Read current organization branding (personal owner or team owner/admin)',
        security: authenticated,
        middleware: caller,
        request: { headers },
        responses: {
          200: {
            description:
              'Stored branding with WCAG contrast against white and automatically selected button text',
            content: json(BrandingView),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await getBranding(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/branding',
        operationId: 'setBranding',
        tags: ['Branding'],
        summary: 'Set current organization branding',
        security: authenticated,
        middleware: caller,
        request: { headers, body: { required: true, content: json(BrandingUpdate) } },
        responses: {
          200: {
            description: 'Updated branding; omitted fields preserved, null clears',
            content: json(BrandingView),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await setBranding(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('json'),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/branding/logo',
        operationId: 'uploadBrandLogo',
        tags: ['Branding'],
        summary: 'Upload and attach a logo, replacing the previous image',
        description:
          'Raw PNG, JPEG or WebP, at most 512 KiB and 2048 pixels per dimension; animation rejected. Decoded and re-encoded as PNG, also limited to 512 KiB. One stored image per organization.',
        security: authenticated,
        middleware: callerWithBodyLimit(caller, BRAND_LOGO_MAX_BYTES),
        request: {
          headers,
          body: {
            required: true,
            content: {
              'image/png': { schema: z.string().openapi({ format: 'binary' }) },
              'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) },
              'image/webp': { schema: z.string().openapi({ format: 'binary' }) },
            },
          },
        },
        responses: {
          200: { description: 'Updated branding', content: json(BrandingView) },
          413: { description: 'payload_too_large', content: json(ErrorBody) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await uploadBrandLogo(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            Buffer.from(await c.req.arrayBuffer()),
            c.req.header('content-type')?.split(';')[0]?.trim() ?? '',
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/branding/logo/{hash}',
        operationId: 'getBrandLogo',
        tags: ['Branding'],
        summary: 'Read the current organization’s normalized logo',
        security: authenticated,
        middleware: caller,
        request: { headers, params: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }) },
        responses: {
          200: {
            description: 'Normalized PNG; private and not cached',
            content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } },
          },
          ...errors,
        },
      }),
      async (c) => {
        const data = await getBrandLogo(
          await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').hash,
        )
        return new Response(new Uint8Array(data), {
          headers: {
            'Content-Type': 'image/png',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'private, no-store',
            'Content-Disposition': 'inline; filename="logo.png"',
          },
        })
      },
    )
  }
}
