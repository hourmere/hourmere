import { createRoute, z } from '@hono/zod-openapi'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { errorResponses, json, type RouteModule } from '../openapi.ts'

const PublicUrl = z.url().openapi({
  description: 'The public origin of this instance, configured by its operator',
})
const EmbedConfiguration = z
  .object({
    publicUrl: PublicUrl,
    embedAllowedOrigins: z.array(z.url()).max(32).optional().openapi({
      description:
        'Exact website origins approved for embedding; empty when disabled, absent when unknown',
    }),
  })
  .openapi('EmbedConfiguration')

const Instance = z
  .object({
    publicUrl: PublicUrl,
    hostedSignupUrl: z.url().openapi({
      description: 'Hosted service destination for public attribution and sign-up links',
    }),
    privacyPolicyUrl: z.url().optional().openapi({
      description: "This instance operator's privacy policy; absent when not configured",
    }),
    termsUrl: z.url().optional().openapi({
      description: "This instance operator's terms; absent when not configured",
    }),
    automaticGoogleMeet: z.boolean().optional(),
    automaticZoom: z.boolean().optional(),
    scimProvisioningEnabled: z.boolean().optional().openapi({
      description:
        'Whether administrators may manage SCIM provisioning tokens; resources are not available yet',
    }),
    slotSnippetsEnabled: z.boolean().optional().openapi({
      description:
        'Whether hosts may copy open times; enable only after direct-slot pages are live',
    }),
    ssoOidcEnabled: z.boolean().optional().openapi({
      description: 'Whether OIDC SSO is enabled; absent when unknown',
    }),
    ssoSamlEnabled: z.boolean().optional().openapi({
      description: 'Whether SAML SSO is enabled; absent when unknown',
    }),
    routingFormsEnabled: z.boolean().optional().openapi({
      description: 'Whether routing forms are enabled; absent when unknown',
    }),
    followUpHostNotesEnabled: z.boolean().optional().openapi({
      description: 'Whether hosts may add plain-text notes to follow-up emails',
    }),
    embedEnabled: z.boolean().optional().openapi({
      description: 'Whether embedding is enabled; absent when unknown',
    }),
    signIn: z
      .object({
        email: z.boolean().openapi({ description: 'Sign-in links sent by email' }),
        google: z.boolean(),
        microsoft: z.boolean(),
      })
      .openapi({ description: 'The sign-in methods people can use on this instance' }),
  })
  .openapi('Instance')

/**
 * What this instance offers, for clients deciding what to show before anyone signs in (the
 * web app's sign-in buttons). Public and the same for every caller; it never carries
 * secrets; the public hosted sign-up destination is safe to share.
 * Only the embed capability is public; approved origins require a verified host session.
 */
export function instanceRoutes({
  publicUrl,
  socialProviders,
  automaticMeet = false,
  automaticZoom = false,
  followUpHostNotesEnabled = true,
  embedAllowedOrigins,
  scimProvisioningEnabled = false,
  slotSnippetsEnabled = false,
  ssoOidcEnabled = false,
  ssoSamlEnabled = false,
  routingFormsEnabled = false,
  hostedSignupUrl = 'https://hourmere.com',
  privacyPolicyUrl,
  termsUrl,
}: {
  /** The normalized PUBLIC_URL, independent of request or forwarded host headers. */
  publicUrl: string
  /** The configured sign-in providers (config.socialProviders); only their presence counts. */
  socialProviders: { google?: unknown; microsoft?: unknown }
  automaticMeet?: boolean
  automaticZoom?: boolean
  followUpHostNotesEnabled?: boolean
  /** Normalized EMBED_ALLOWED_ORIGINS; undefined preserves unknown capability readiness. */
  embedAllowedOrigins?: readonly string[]
  scimProvisioningEnabled?: boolean
  slotSnippetsEnabled?: boolean
  ssoOidcEnabled?: boolean
  ssoSamlEnabled?: boolean
  /** The effective routing-forms state; the server passes its hard-off constant. */
  routingFormsEnabled?: boolean
  hostedSignupUrl?: string
  privacyPolicyUrl?: string
  termsUrl?: string
}): RouteModule {
  const body: z.infer<typeof Instance> = {
    publicUrl,
    hostedSignupUrl,
    ...(privacyPolicyUrl && { privacyPolicyUrl }),
    ...(termsUrl && { termsUrl }),
    automaticGoogleMeet: automaticMeet,
    automaticZoom,
    followUpHostNotesEnabled,
    ...(embedAllowedOrigins !== undefined && { embedEnabled: embedAllowedOrigins.length > 0 }),
    slotSnippetsEnabled,
    ssoOidcEnabled,
    ssoSamlEnabled,
    routingFormsEnabled,
    scimProvisioningEnabled,
    signIn: {
      email: true,
      google: socialProviders.google !== undefined,
      microsoft: socialProviders.microsoft !== undefined,
    },
  }
  const embedConfiguration: z.infer<typeof EmbedConfiguration> = {
    publicUrl,
    ...(embedAllowedOrigins !== undefined && { embedAllowedOrigins: [...embedAllowedOrigins] }),
  }
  return ({ app, caller }) => {
    const privateHeaders = createMiddleware(async (c, next) => {
      c.header('Cache-Control', 'private, no-store')
      c.header('Vary', 'Cookie, Authorization')
      await next()
    })
    const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
      if (c.var.principal.kind !== 'session')
        return c.json({ error: 'embed_configuration_access_denied' }, 403)
      await next()
    })
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/instance',
        summary: 'What this instance offers, such as its sign-in methods',
        tags: ['Instance'],
        responses: {
          200: { description: "The instance's features", content: json(Instance) },
        },
      }),
      (c) => c.json(body, 200),
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/instance/embed',
        summary: 'Read the embed configuration for the signed-in host interface',
        description:
          'Requires a verified web session and current organization membership. Returns the operator-approved website origins to hosts generating booking widgets; these origins are never included in public instance discovery. API keys and MCP OAuth tokens cannot read this browser-session-only configuration. An absent origin list means unknown configuration; an empty list means embedding is disabled.',
        tags: ['Instance'],
        security: [{ session: [] }],
        middleware: [privateHeaders, caller, sessionOnly] as [
          typeof privateHeaders,
          typeof caller,
          typeof sessionOnly,
        ],
        responses: {
          200: {
            description: 'Private host embed configuration',
            content: json(EmbedConfiguration),
          },
          ...errorResponses({
            403: 'embed_configuration_access_denied: requires a verified web session',
          }),
        },
      }),
      (c) => c.json(embedConfiguration, 200),
    )
  }
}
