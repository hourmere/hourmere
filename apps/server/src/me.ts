import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { MeSso } from './sso-me.ts'

/** The base identity shared by GET /api/v1/me and the MCP `whoami` tool. */
export const CallerDescription = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  personalOrganizationId: z.uuid().nullable().openapi({
    description:
      "The caller's own personal organization, independent of the active organization; null when unavailable",
  }),
  organization: z
    .object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      personal: z.boolean().openapi({
        description: 'A personal organization (every user has one) rather than a team',
      }),
    })
    .openapi({ description: 'The organization the caller acts in' }),
  principal: z.object({
    kind: z.enum(['session', 'api_key', 'oauth']),
    oauthConsentId: z
      .uuid()
      .optional()
      .openapi({ description: 'The organization-bound consent used, for kind oauth' }),
    apiKeyId: z.uuid().nullable().openapi({ description: 'The key used, for kind api_key' }),
    apiKeyScope: z.enum(['full', 'read', 'bookings']).optional().openapi({
      description: 'The immutable API key scope, included only for kind api_key',
    }),
  }),
})

export const Me = CallerDescription.extend({ sso: MeSso.optional() }).openapi('Me')

export function describeCaller(p: Principal): z.infer<typeof CallerDescription> {
  return {
    user: p.user,
    personalOrganizationId: p.personalOrganizationId ?? null,
    organization: p.organization,
    principal: {
      kind: p.kind,
      apiKeyId: p.kind === 'api_key' ? p.apiKeyId : null,
      ...(p.kind === 'api_key' && { apiKeyScope: p.apiKeyScope }),
      ...(p.kind === 'oauth' && { oauthConsentId: p.oauthConsentId }),
    },
  }
}
