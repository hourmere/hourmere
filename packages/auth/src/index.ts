import { apiKey } from '@better-auth/api-key'
import { type Db, guardPoolErrors } from '@hourmere/db'
import { type Mailer, magicLinkEmail } from '@hourmere/mail'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins/magic-link'
import { organization } from 'better-auth/plugins/organization'
import type { GoogleOptions, MicrosoftOptions } from 'better-auth/social-providers'
import pg from 'pg'
import { API_KEY_RATE_LIMIT } from './api-keys.ts'
import { API_KEY_PREFIX } from './caller.ts'
import { beforeHook } from './hooks.ts'
import { betterAuthLog } from './log.ts'
import { ensurePersonalOrganization, personalOrganizationGuards } from './organizations.ts'

export { API_KEY_RATE_LIMIT } from './api-keys.ts'
export {
  API_KEY_PREFIX,
  type CallerOrganization,
  type CallerResolver,
  type CallerResult,
  type CallerUser,
  createCallerResolver,
  type Principal,
} from './caller.ts'
export { escapeControlCharacters } from './log.ts'
export { ensurePersonalOrganization } from './organizations.ts'

/**
 * Better Auth owns the `auth` schema (its own table and column naming). Its pool only
 * sees that schema; application tables live in `public` and reference auth rows by id.
 * After changing plugins, regenerate the SQL with `npm run auth:sql` and add it as a
 * migration in packages/db/migrations.
 */
export function createAuthPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=auth' })
  // Same reason as createPool in @hourmere/db: an unhandled client error would kill the
  // process.
  guardPoolErrors(pool, ' (auth)')
  return pool
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface AuthConfig {
  /** Better Auth's own pool, from createAuthPool. */
  pool: pg.Pool
  /** The application database, for the personal organization and membership checks. */
  db: Db
  /** Where people reach Hourmere (PUBLIC_URL); sign-in links and cookies are built from it. */
  baseURL: string
  secret: string
  /** Sends the sign-in links. */
  mailer: Mailer
  /** Each provider is enabled only when configured. */
  socialProviders?: { google?: OAuthClient | undefined; microsoft?: OAuthClient | undefined }
  /**
   * Better Auth provider options applied over ours. Tests use it to replace the provider's
   * token check and profile lookup; production configuration does not set it.
   */
  socialProviderOptions?: { google?: Partial<GoogleOptions>; microsoft?: Partial<MicrosoftOptions> }
}

const MAGIC_LINK_MINUTES = 5

/**
 * The only header Better Auth reads the client IP from (rate limiting, session records).
 * The server sets it from the TCP peer and trusted proxies and drops any value a client sends.
 */
export const CLIENT_IP_HEADER = 'x-hourmere-client-ip'

export function createAuth({
  pool,
  db,
  baseURL,
  secret,
  mailer,
  socialProviders = {},
  socialProviderOptions = {},
}: AuthConfig) {
  const { google, microsoft } = socialProviders
  return betterAuth({
    database: pool,
    baseURL,
    secret,
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: new URL(baseURL).protocol === 'https:',
      // Better Auth turns origin checks off when NODE_ENV is "test"; keep them on so tests
      // exercise the same CSRF protection as production.
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    logger: { log: betterAuthLog },
    // Unexpected errors go to the caller (the server's error handler logs them on one escaped
    // line) instead of being printed raw by Better Auth's router.
    onAPIError: { throw: true },
    // Sign-in providers' OAuth tokens are stored encrypted, not in plain text.
    account: { encryptOAuthTokens: true },
    // Passwordless: email magic links and social sign-in only (emailAndPassword stays off).
    // Sign-in asks only for identity; calendar access is a separate connection.
    //
    // requireEmailVerification: no session for an account whose email is not verified, on
    // sign-in as well as sign-up. New accounts are verified by construction (see the user
    // hook below), but an old unverified account's provider login could otherwise finish
    // after its real owner proved the address (which revokes sessions) and hand out a fresh
    // session in what is now the owner's verified account. Better Auth checks the account as
    // it loaded it at the start of the login.
    socialProviders: {
      ...(google && {
        google: {
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          requireEmailVerification: true,
          ...socialProviderOptions.google,
        },
      }),
      ...(microsoft && {
        microsoft: {
          clientId: microsoft.clientId,
          clientSecret: microsoft.clientSecret,
          disableDefaultScope: true,
          scope: ['openid', 'profile', 'email'],
          // The photo needs the Graph User.Read scope; Better Auth would store it in the user
          // row as a data URL.
          disableProfilePhoto: true,
          requireEmailVerification: true,
          ...socialProviderOptions.microsoft,
        },
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Every account starts from a proven email address. A provider that does not vouch
          // for the address (Microsoft often does not) could otherwise create an account for
          // someone else's email and mint API keys in it before the owner ever signs in.
          before: async (user) => {
            if (!user.emailVerified) {
              throw new APIError('FORBIDDEN', {
                code: 'EMAIL_NOT_VERIFIED',
                message:
                  'This sign-in provider did not confirm your email address. Sign in with an email link first; you can use this provider afterwards if it confirms the address.',
              })
            }
          },
          // Runs after the user row is committed.
          after: async (user) => {
            await ensurePersonalOrganization(db, user.id)
          },
        },
      },
      session: {
        create: {
          // Also repairs a user whose personal organization could not be created at sign-up.
          before: async (session) => {
            if ((session as { activeOrganizationId?: string | null }).activeOrganizationId) return
            return {
              data: { activeOrganizationId: await ensurePersonalOrganization(db, session.userId) },
            }
          },
        },
      },
    },
    hooks: { before: beforeHook(db) },
    plugins: [
      organization({
        // An invitation is accepted only by someone who proved they own the invited address.
        requireEmailVerificationOnInvitation: true,
        organizationHooks: personalOrganizationGuards(db),
      }),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        enableMetadata: true,
        rateLimit: { enabled: true, ...API_KEY_RATE_LIMIT },
      }),
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        // Only a hash is stored, so a database leak does not expose usable links.
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await mailer.send(
            magicLinkEmail({ to: email, url, expiresInMinutes: MAGIC_LINK_MINUTES }),
          )
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
