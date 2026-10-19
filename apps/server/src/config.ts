import { EMAIL_DOMAIN, SIGNUP_MODES, type SignupPolicy } from '@hourmere/auth'
import { calendarEncryptionKey } from '@hourmere/calendars'
import { conferenceEncryptionKey } from '@hourmere/conferences'
import { embedOrigin } from '@hourmere/core/embed'
import { isSingleLineText } from '@hourmere/scheduling/text'
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

// Policy links describe this instance's operator, so self-hosted installations have no default.
const policyUrl = (name: string) =>
  optional(
    z
      .string()
      .max(2048, `${name} must be at most 2048 characters`)
      .refine((value) => isSingleLineText(value) && !/\s/u.test(value), {
        error: `${name} must not contain whitespace or control characters`,
      })
      .pipe(z.url({ protocol: /^https?$/, error: `${name} must be an HTTP(S) URL` }))
      .refine(
        (value) => URL.canParse(value) && !new URL(value).username && !new URL(value).password,
        { error: `${name} must not contain credentials` },
      ),
  )

const schema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => URL.canParse(v), {
        message:
          'DATABASE_URL is not a valid URL (percent-encode special characters in the password, or leave the password out and set PGPASSWORD)',
      }),
    EMBED_ALLOWED_ORIGINS: optional(
      z
        .string()
        .max(16384)
        .transform((s) =>
          s
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        )
        .refine((list) => list.length <= 32 && list.every((v) => embedOrigin(v) !== undefined), {
          error:
            'EMBED_ALLOWED_ORIGINS must contain at most 32 exact HTTPS origins (loopback HTTP is allowed); no wildcards or paths',
        })
        .transform((list) => [...new Set(list.map((v) => embedOrigin(v) as string))]),
    ).transform((v) => v ?? []),
    ZOOM_MEETINGS_ENABLED: optional(z.enum(['true', 'false'])).transform((v) => v === 'true'),
    GOOGLE_MEET_ENABLED: optional(z.enum(['true', 'false'])).transform((v) => v === 'true'),
    WEBHOOKS_ENABLED: optional(z.enum(['true', 'false'])).transform((v) => v === 'true'),
    WEBHOOK_ENCRYPTION_KEY: optional(
      z.string().refine(
        (value) => {
          const bytes = Buffer.from(value, 'base64')
          return bytes.length === 32 && bytes.toString('base64') === value
        },
        { error: 'WEBHOOK_ENCRYPTION_KEY must be 32 random bytes encoded as base64' },
      ),
    ),
    MCP_OAUTH_ENABLED: optional(z.enum(['true', 'false'])).transform((v) => v === 'true'),
    PORT: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? Number.NaN : value),
      z.coerce.number().int().min(0).max(65535).default(3000),
    ),
    // Where people reach Hourmere: sign-in links, OAuth redirects and cookies are built from it.
    PUBLIC_URL: optional(
      z
        .url({ protocol: /^https?$/, error: 'PUBLIC_URL must be an http(s) URL' })
        .refine((v) => new URL(v).pathname === '/' && !new URL(v).search, {
          error: 'PUBLIC_URL must not have a path: Hourmere is served at the root of its domain',
        }),
    ),
    // Public attribution points to the hosted service, independently of this instance.
    HOSTED_SIGNUP_URL: optional(
      z.url({ protocol: /^https?$/ }).refine(
        (value) => {
          const url = new URL(value)
          return !url.username && !url.password && !url.search && !url.hash
        },
        {
          error: 'HOSTED_SIGNUP_URL must be an HTTP(S) URL without credentials, query or fragment',
        },
      ),
    ).transform((value) => value ?? 'https://hourmere.com'),
    PRIVACY_POLICY_URL: policyUrl('PRIVACY_POLICY_URL'),
    TERMS_URL: policyUrl('TERMS_URL'),
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
    GOOGLE_CALENDAR_CLIENT_ID: optional(z.string().trim().min(1)),
    GOOGLE_CALENDAR_CLIENT_SECRET: optional(z.string().trim().min(1)),
    CALENDAR_ENCRYPTION_KEY: optional(
      z.string().refine(
        (value) => {
          try {
            calendarEncryptionKey(value)
            return true
          } catch {
            return false
          }
        },
        { error: 'CALENDAR_ENCRYPTION_KEY must be 32 random bytes encoded as base64' },
      ),
    ),
    ZOOM_CLIENT_ID: optional(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,256}$/),
    ),
    ZOOM_CLIENT_SECRET: optional(
      z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => isSingleLineText(value) && !/\s/u.test(value), {
          error: 'ZOOM_CLIENT_SECRET must be a nonempty single-line value',
        }),
    ),
    ZOOM_WEBHOOK_SECRET_TOKEN: optional(
      z
        .string()
        .min(16, 'ZOOM_WEBHOOK_SECRET_TOKEN must have at least 16 characters')
        .max(1024)
        .refine((value) => isSingleLineText(value) && !/\s/u.test(value), {
          error: 'ZOOM_WEBHOOK_SECRET_TOKEN must be a nonempty single-line value',
        }),
    ),
    CONFERENCE_ENCRYPTION_KEY: optional(
      z.string().refine(
        (value) => {
          try {
            conferenceEncryptionKey(value)
            return true
          } catch {
            return false
          }
        },
        { error: 'CONFERENCE_ENCRYPTION_KEY must be 32 random bytes encoded as base64' },
      ),
    ),
    MICROSOFT_CLIENT_ID: optional(z.string()),
    MICROSOFT_CLIENT_SECRET: optional(z.string()),
    MICROSOFT_CALENDAR_CLIENT_ID: optional(z.string().trim().min(1)),
    MICROSOFT_CALENDAR_CLIENT_SECRET: optional(z.string().trim().min(1)),
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
    if (c.PORT === 0 && !c.PUBLIC_URL)
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_URL'],
        message: 'PUBLIC_URL is required when PORT=0 selects an OS-assigned listening port',
      })
    if (c.EMBED_ALLOWED_ORIGINS.length && c.PUBLIC_URL && !embedOrigin(c.PUBLIC_URL))
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_URL'],
        message: 'Embedding requires an HTTPS PUBLIC_URL except on loopback development hosts',
      })
    if (
      c.GOOGLE_MEET_ENABLED &&
      (!c.GOOGLE_CALENDAR_CLIENT_ID ||
        !c.GOOGLE_CALENDAR_CLIENT_SECRET ||
        !c.CALENDAR_ENCRYPTION_KEY)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_MEET_ENABLED'],
        message: 'Automatic Google Meet requires Google Calendar write configuration',
      })
    if (c.WEBHOOKS_ENABLED && !c.WEBHOOK_ENCRYPTION_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_ENCRYPTION_KEY'],
        message: 'Webhooks require WEBHOOK_ENCRYPTION_KEY',
      })
    if (c.MCP_OAUTH_ENABLED && c.PUBLIC_URL) {
      const url = new URL(c.PUBLIC_URL)
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message: 'MCP OAuth requires HTTPS except on loopback development hosts',
        })
    }
    if (c.MICROSOFT_CALENDAR_CLIENT_ID || c.MICROSOFT_CALENDAR_CLIENT_SECRET) {
      for (const key of [
        'MICROSOFT_CALENDAR_CLIENT_ID',
        'MICROSOFT_CALENDAR_CLIENT_SECRET',
        'CALENDAR_ENCRYPTION_KEY',
      ] as const) {
        if (!c[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'Microsoft Calendar requires MICROSOFT_CALENDAR_CLIENT_ID, MICROSOFT_CALENDAR_CLIENT_SECRET and CALENDAR_ENCRYPTION_KEY together',
          })
      }
      if (c.PUBLIC_URL) {
        const url = new URL(c.PUBLIC_URL)
        if (
          url.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message: 'Microsoft Calendar requires HTTPS except on loopback development hosts',
          })
      }
    }
    if (c.GOOGLE_CALENDAR_CLIENT_ID || c.GOOGLE_CALENDAR_CLIENT_SECRET) {
      for (const key of [
        'GOOGLE_CALENDAR_CLIENT_ID',
        'GOOGLE_CALENDAR_CLIENT_SECRET',
        'CALENDAR_ENCRYPTION_KEY',
      ] as const) {
        if (!c[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'Google Calendar requires GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET and CALENDAR_ENCRYPTION_KEY together',
          })
      }
      if (c.PUBLIC_URL) {
        const url = new URL(c.PUBLIC_URL)
        if (
          url.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message: 'Google Calendar requires HTTPS except on loopback development hosts',
          })
      }
    }
    if (
      c.CALENDAR_ENCRYPTION_KEY &&
      ([c.WEBHOOK_ENCRYPTION_KEY, c.BETTER_AUTH_SECRET].includes(c.CALENDAR_ENCRYPTION_KEY) ||
        Buffer.from(c.CALENDAR_ENCRYPTION_KEY, 'base64').equals(Buffer.from(c.BETTER_AUTH_SECRET)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['CALENDAR_ENCRYPTION_KEY'],
        message:
          'Use an independent CALENDAR_ENCRYPTION_KEY, separate from authentication and webhook keys',
      })
    if (
      c.CONFERENCE_ENCRYPTION_KEY &&
      ([c.CALENDAR_ENCRYPTION_KEY, c.WEBHOOK_ENCRYPTION_KEY, c.BETTER_AUTH_SECRET].includes(
        c.CONFERENCE_ENCRYPTION_KEY,
      ) ||
        Buffer.from(c.CONFERENCE_ENCRYPTION_KEY, 'base64').equals(
          Buffer.from(c.BETTER_AUTH_SECRET),
        ))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['CONFERENCE_ENCRYPTION_KEY'],
        message:
          'Use an independent CONFERENCE_ENCRYPTION_KEY, separate from authentication, calendar and webhook keys',
      })
    if (
      c.ZOOM_MEETINGS_ENABLED &&
      !(c.ZOOM_CLIENT_ID && c.ZOOM_CLIENT_SECRET && c.CONFERENCE_ENCRYPTION_KEY)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['ZOOM_MEETINGS_ENABLED'],
        message: 'Automatic Zoom meetings require separately configured Zoom credentials',
      })
    if (c.ZOOM_CLIENT_ID || c.ZOOM_CLIENT_SECRET) {
      for (const key of [
        'ZOOM_CLIENT_ID',
        'ZOOM_CLIENT_SECRET',
        'CONFERENCE_ENCRYPTION_KEY',
      ] as const)
        if (!c[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'Zoom connections require ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET and CONFERENCE_ENCRYPTION_KEY together',
          })
      if (c.PUBLIC_URL) {
        const url = new URL(c.PUBLIC_URL)
        if (
          url.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['PUBLIC_URL'],
            message:
              'Zoom connections require HTTPS except on loopback development hosts; actual client redirect acceptance must be verified separately',
          })
      }
    }
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
