import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'

/** The caller as GET /api/v1/me and the MCP `whoami` tool describe it. */
export const Me = z
  .object({
    user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
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
    }),
  })
  .openapi('Me')

export function describeCaller(p: Principal): z.infer<typeof Me> {
  return {
    user: p.user,
    organization: p.organization,
    principal: {
      kind: p.kind,
      apiKeyId: p.kind === 'api_key' ? p.apiKeyId : null,
      ...(p.kind === 'oauth' && { oauthConsentId: p.oauthConsentId }),
    },
  }
}
