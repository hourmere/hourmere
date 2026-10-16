import { EMAIL_DOMAIN, SIGNUP_MODES, type SignupPolicy } from '@hourmere/auth'
import { z } from 'zod'
import { isTrustedProxyEntry } from './client-ip.ts'
import { DEFAULT_HTTP_TIMEOUTS, type HttpTimeouts } from './http-timeouts.ts'
import { DEFAULT_HSTS_MAX_AGE } from './security-headers.ts'

// docker compose passes unset optional variables as empty strings.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

// A whole number of seconds from 1 to an hour; the cap catches milliseconds given by mistake.
const timeoutSeconds = (name: string, defaultMs: number) => {
  const error = `${name} must be a whole number of seconds from 1 to 3600`
  return z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce
      .number({ error })
      .int({ error })
      .min(1, { error })
      .max(3600, { error })
      .default(defaultMs / 1000),
  )
}

const HSTS_MAX_AGE_FORMAT = 'HSTS_MAX_AGE must be a whole number of seconds (0 or more)'

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
    // Who may create an account; existing users can always sign in. first-user suits a
    // self-hosted instance: whoever signs in first, then only SIGNUP_ALLOWED_DOMAINS.
    SIGNUP: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .enum(SIGNUP_MODES, { error: 'SIGNUP must be open, first-user or closed' })
        .default('first-user'),
    ),
    // Email domains whose addresses may always sign up, comma-separated; exact match, so
    // subdomains must be listed too.
    SIGNUP_ALLOWED_DOMAINS: optional(
      z
        .string()
        .transform((v) =>
          v
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        )
        .refine((list) => list.every((d) => EMAIL_DOMAIN.test(d)), {
          error:
            'SIGNUP_ALLOWED_DOMAINS must be comma-separated email domains such as example.com (no @, no wildcards)',
        }),
    ),
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
    // Strict-Transport-Security max-age in seconds, sent only when PUBLIC_URL is https on a
    // real host name; 0 tells browsers to forget an earlier policy.
    HSTS_MAX_AGE: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce
        .number({ error: HSTS_MAX_AGE_FORMAT })
        .int({ error: HSTS_MAX_AGE_FORMAT })
        .min(0, { error: HSTS_MAX_AGE_FORMAT })
        .default(DEFAULT_HSTS_MAX_AGE),
    ),
    // How long a client may take to send a request's headers, to send the whole request, and
    // how long an idle connection stays open between requests (see http-timeouts.ts).
    HTTP_HEADERS_TIMEOUT: timeoutSeconds('HTTP_HEADERS_TIMEOUT', DEFAULT_HTTP_TIMEOUTS.headers),
    HTTP_REQUEST_TIMEOUT: timeoutSeconds('HTTP_REQUEST_TIMEOUT', DEFAULT_HTTP_TIMEOUTS.request),
    HTTP_KEEP_ALIVE_TIMEOUT: timeoutSeconds(
      'HTTP_KEEP_ALIVE_TIMEOUT',
      DEFAULT_HTTP_TIMEOUTS.keepAlive,
    ),
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
    // Most likely meant to restrict sign-up, which open does not.
    if (c.SIGNUP === 'open' && c.SIGNUP_ALLOWED_DOMAINS?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNUP_ALLOWED_DOMAINS'],
        message:
          'SIGNUP_ALLOWED_DOMAINS has no effect with SIGNUP=open, where anyone can sign up; use SIGNUP=first-user or closed',
      })
    }
    // Node refuses to start otherwise: the whole request includes its headers.
    if (c.HTTP_HEADERS_TIMEOUT > c.HTTP_REQUEST_TIMEOUT) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTTP_HEADERS_TIMEOUT'],
        message: 'HTTP_HEADERS_TIMEOUT must not be longer than HTTP_REQUEST_TIMEOUT',
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

export type Config = Omit<
  z.infer<typeof schema>,
  | 'PUBLIC_URL'
  | 'TRUSTED_PROXIES'
  | 'SIGNUP'
  | 'SIGNUP_ALLOWED_DOMAINS'
  | 'HTTP_HEADERS_TIMEOUT'
  | 'HTTP_REQUEST_TIMEOUT'
  | 'HTTP_KEEP_ALIVE_TIMEOUT'
> & {
  PUBLIC_URL: string
  trustedProxies: string[]
  signup: SignupPolicy
  /** HTTP_*_TIMEOUT, in milliseconds. */
  httpTimeouts: HttpTimeouts
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
  const {
    TRUSTED_PROXIES,
    SIGNUP,
    SIGNUP_ALLOWED_DOMAINS,
    HTTP_HEADERS_TIMEOUT,
    HTTP_REQUEST_TIMEOUT,
    HTTP_KEEP_ALIVE_TIMEOUT,
    ...rest
  } = c
  return {
    ...rest,
    trustedProxies: TRUSTED_PROXIES ?? [],
    signup: { mode: SIGNUP, allowedDomains: SIGNUP_ALLOWED_DOMAINS ?? [] },
    httpTimeouts: {
      headers: HTTP_HEADERS_TIMEOUT * 1000,
      request: HTTP_REQUEST_TIMEOUT * 1000,
      keepAlive: HTTP_KEEP_ALIVE_TIMEOUT * 1000,
    },
    PUBLIC_URL: c.PUBLIC_URL ? new URL(c.PUBLIC_URL).origin : `http://localhost:${c.PORT}`,
    socialProviders: { ...(google && { google }), ...(microsoft && { microsoft }) },
  }
}
