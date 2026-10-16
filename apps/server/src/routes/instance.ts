import { createRoute, z } from '@hono/zod-openapi'
import { json, type RouteModule } from '../openapi.ts'

const Instance = z
  .object({
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
 * configuration values, only whether a feature is on.
 */
export function instanceRoutes({
  socialProviders,
}: {
  /** The configured sign-in providers (config.socialProviders); only their presence counts. */
  socialProviders: { google?: unknown; microsoft?: unknown }
}): RouteModule {
  const body: z.infer<typeof Instance> = {
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
