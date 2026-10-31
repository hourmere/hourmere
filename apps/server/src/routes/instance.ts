import { createRoute, z } from '@hono/zod-openapi'
import { json, type RouteModule } from '../openapi.ts'

const Instance = z
  .object({
    publicUrl: z.url().openapi({
      description: 'The public origin of this instance, configured by its operator',
    }),
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
 */
export function instanceRoutes({
  publicUrl,
  socialProviders,
  automaticMeet = false,
  automaticZoom = false,
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
    signIn: {
      email: true,
      google: socialProviders.google !== undefined,
      microsoft: socialProviders.microsoft !== undefined,
    },
  }
  return ({ app }) => {
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
  }
}
