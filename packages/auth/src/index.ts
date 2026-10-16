import { apiKey } from '@better-auth/api-key'
import type { Db } from '@hourmere/db'
import { type Mailer, magicLinkEmail } from '@hourmere/mail'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins/magic-link'
import { organization } from 'better-auth/plugins/organization'
import pg from 'pg'
import { API_KEY_PREFIX } from './caller.ts'
import { ensurePersonalOrganization, isMember, isUuid } from './organizations.ts'

export {
  API_KEY_PREFIX,
  type CallerOrganization,
  type CallerResolver,
  type CallerResult,
  type CallerUser,
  createCallerResolver,
  type Principal,
} from './caller.ts'
export { ensurePersonalOrganization } from './organizations.ts'

/**
 * Better Auth owns the `auth` schema (its own table and column naming). Its pool only
 * sees that schema; application tables live in `public` and reference auth rows by id.
 * After changing plugins, regenerate the SQL with `npm run auth:sql` and add it as a
 * migration in packages/db/migrations.
 */
export function createAuthPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=auth' })
  // Same reason as createPool in @hourmere/db: an unhandled idle-client error would kill
  // the process.
  pool.on('error', (err) => console.error(`idle Postgres client error (auth): ${err.message}`))
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
}

const MAGIC_LINK_MINUTES = 5

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * API keys belong to a user and act in one organization, stored in the key's metadata as
 * `organizationId`: the personal organization unless the creator names another
 * organization they belong to. Keys always carry the `hm_` prefix.
 */
function apiKeyOrganizationHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    const creating = ctx.path === '/api-key/create'
    if (!creating && ctx.path !== '/api-key/update') return
    const body: unknown = ctx.body
    // Malformed bodies are left to the endpoint's own validation.
    if (!isRecord(body)) return
    if (creating && body.prefix !== undefined && body.prefix !== API_KEY_PREFIX) {
      throw new APIError('BAD_REQUEST', { message: `API keys always start with ${API_KEY_PREFIX}` })
    }
    if (!creating && body.metadata === undefined) return
    const metadata = body.metadata ?? {}
    if (!isRecord(metadata)) return
    const session = await getSessionFromCtx(ctx)
    // body.userId counts only in server-side calls (auth.api.*); the endpoint refuses it from
    // clients, and without a user it answers 401 itself.
    const fromServer = !ctx.request && typeof body.userId === 'string' ? body.userId : undefined
    const userId = session?.user.id ?? fromServer
    if (!userId || !isUuid(userId)) return
    const requested = metadata.organizationId
    if (requested === undefined) {
      const organizationId = await ensurePersonalOrganization(db, userId)
      return { context: { body: { ...body, metadata: { ...metadata, organizationId } } } }
    }
    if (typeof requested !== 'string' || !(await isMember(db, userId, requested))) {
      throw new APIError('FORBIDDEN', {
        message: 'metadata.organizationId must be an organization you are a member of',
      })
    }
  })
}

export function createAuth({
  pool,
  db,
  baseURL,
  secret,
  mailer,
  socialProviders = {},
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
    },
    // Sign-in providers' OAuth tokens are stored encrypted, not in plain text.
    account: { encryptOAuthTokens: true },
    // Passwordless: email magic links and social sign-in only (emailAndPassword stays off).
    // Sign-in asks only for identity; calendar access is a separate connection.
    socialProviders: {
      ...(google && { google: { clientId: google.clientId, clientSecret: google.clientSecret } }),
      ...(microsoft && {
        microsoft: {
          clientId: microsoft.clientId,
          clientSecret: microsoft.clientSecret,
          disableDefaultScope: true,
          scope: ['openid', 'profile', 'email'],
          // The photo needs the Graph User.Read scope; Better Auth would store it in the user
          // row as a data URL.
          disableProfilePhoto: true,
        },
      }),
    },
    databaseHooks: {
      user: {
        create: {
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
    hooks: { before: apiKeyOrganizationHook(db) },
    plugins: [
      organization(),
      apiKey({ defaultPrefix: API_KEY_PREFIX, enableMetadata: true }),
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
