import { z } from 'zod'
import { isTrustedProxyEntry } from './client-ip.ts'

// docker compose passes unset optional variables as empty strings.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

const SMTP_URL_FORMAT =
  'SMTP_URL must look like smtps://user:password@host:465 or smtp://user:password@host:587, with no path (percent-encode special characters in the password)'

const schema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => URL.canParse(v), {
        message:
          'DATABASE_URL is not a valid URL (percent-encode special characters in the password, or leave the password out and set PGPASSWORD)',
      }),
    PORT: z.coerce.number().int().positive().default(3000),
    // Where people reach Hourmere: sign-in links, OAuth redirects and cookies are built from it.
    PUBLIC_URL: optional(
      z
        .url({ protocol: /^https?$/, error: 'PUBLIC_URL must be an http(s) URL' })
        .refine((v) => new URL(v).pathname === '/' && !new URL(v).search, {
          error: 'PUBLIC_URL must not have a path: Hourmere is served at the root of its domain',
        }),
    ),
    BETTER_AUTH_SECRET: z
      .string({
        error:
          'BETTER_AUTH_SECRET is required: a random string of at least 32 characters, e.g. the output of `openssl rand -base64 32`',
      })
      // Whitespace does not count: a padded short secret is still short.
      .refine((v) => v.replace(/\s/g, '').length >= 32, {
        error:
          'BETTER_AUTH_SECRET must have at least 32 non-whitespace characters; generate one with `openssl rand -base64 32`',
      }),
    // Without SMTP, emails (including sign-in links) are written to the server log.
    SMTP_URL: optional(
      z.url({ protocol: /^smtps?$/, error: SMTP_URL_FORMAT }).refine(
        (v) => {
          const u = new URL(v)
          return u.hostname !== '' && (u.pathname === '' || u.pathname === '/') && !u.hash
        },
        { error: SMTP_URL_FORMAT },
      ),
    ),
    MAIL_FROM: optional(z.string()),
    GOOGLE_CLIENT_ID: optional(z.string()),
    GOOGLE_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_CLIENT_ID: optional(z.string()),
    MICROSOFT_CLIENT_SECRET: optional(z.string()),
    // Reverse proxies in front of the app, comma-separated IPs or CIDR ranges. Only their
    // X-Forwarded-For is believed when working out the client IP (rate limiting).
    TRUSTED_PROXIES: optional(
      z
        .string()
        .transform((v) =>
          v
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean),
        )
        .refine((list) => list.every(isTrustedProxyEntry), {
          error: 'TRUSTED_PROXIES must be comma-separated IP addresses or CIDR ranges',
        }),
    ),
    // Self-hosted instances migrate on start; set to "false" to run `npm run db:migrate` yourself.
    AUTO_MIGRATE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Built web app to serve; unset in development, where Vite serves it.
    WEB_DIST: z.string().optional(),
    // What this process runs: `all` (the default: API and background jobs in one process),
    // `web` (API only, jobs are only queued) or `worker` (background jobs only, with
    // /api/health on PORT for container health checks).
    HOURMERE_ROLE: optional(
      z.enum(['all', 'web', 'worker'], {
        error: 'HOURMERE_ROLE must be all, web or worker',
      }),
    ).transform((v) => v ?? 'all'),
  })
  .superRefine((c, ctx) => {
    if (c.SMTP_URL && !c.MAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: 'MAIL_FROM is required with SMTP_URL, e.g. "Hourmere <hourmere@example.com>"',
      })
    }
    for (const provider of ['GOOGLE', 'MICROSOFT'] as const) {
      const id = c[`${provider}_CLIENT_ID`]
      const secret = c[`${provider}_CLIENT_SECRET`]
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [id ? `${provider}_CLIENT_SECRET` : `${provider}_CLIENT_ID`],
          message: `set both ${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET, or neither`,
        })
      }
    }
  })

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export type Config = Omit<z.infer<typeof schema>, 'PUBLIC_URL' | 'TRUSTED_PROXIES'> & {
  PUBLIC_URL: string
  trustedProxies: string[]
  /** Social sign-in providers whose credentials are set. */
  socialProviders: { google?: OAuthClient; microsoft?: OAuthClient }
}

function oauthClient(clientId?: string, clientSecret?: string): OAuthClient | undefined {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`)
  }
  const c = parsed.data
  const google = oauthClient(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET)
  const microsoft = oauthClient(c.MICROSOFT_CLIENT_ID, c.MICROSOFT_CLIENT_SECRET)
  const { TRUSTED_PROXIES, ...rest } = c
  return {
    ...rest,
    trustedProxies: TRUSTED_PROXIES ?? [],
    PUBLIC_URL: c.PUBLIC_URL ? new URL(c.PUBLIC_URL).origin : `http://localhost:${c.PORT}`,
    socialProviders: { ...(google && { google }), ...(microsoft && { microsoft }) },
  }
}
