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

/**
 * The only header Better Auth reads the client IP from (rate limiting, session records).
 * The server sets it from the TCP peer and trusted proxies and drops any value a client sends.
 */
export const CLIENT_IP_HEADER = 'x-hourmere-client-ip'

/**
 * Per-key limit written into each new key. A safety net against runaway agents, not the
 * product's API limits, which belong in the API layer.
 */
export const API_KEY_RATE_LIMIT = { timeWindow: 60_000, maxRequests: 600 } as const

/**
 * Better Auth's default log format, except for rejected API keys: it logs each one as a
 * multi-line error with a stack trace. A wrong key is the caller's problem, so it becomes
 * one info line with the reason only (never the key).
 */
function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) {
  if (message.startsWith('Failed to validate API key')) {
    const code = (args[0] as { body?: { code?: unknown } } | undefined)?.body?.code
    console.info(`[auth] API key rejected: ${typeof code === 'string' ? code : 'INVALID_API_KEY'}`)
    return
  }
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`
  if (level === 'error') console.error(line, ...args)
  else if (level === 'warn') console.warn(line, ...args)
  else console.log(line, ...args)
}

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
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    logger: { log },
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
      organization({
        organizationHooks: {
          // The personal organization lives as long as its user (deleting the user deletes
          // it); without it the user would have nowhere to act.
          beforeDeleteOrganization: async ({ organization }) => {
            const personal = await db
              .selectFrom('personal_organizations')
              .select('user_id')
              .where('organization_id', '=', organization.id)
              .executeTakeFirst()
            if (personal) {
              throw new APIError('FORBIDDEN', {
                code: 'PERSONAL_ORGANIZATION',
                message: 'A personal organization cannot be deleted',
              })
            }
          },
        },
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
