import { apiKey } from '@better-auth/api-key'
import { type InterfaceLanguage, resolveAdminLanguage } from '@hourmere/core/language'
import { createDb, type Db, guardPoolErrors } from '@hourmere/db'
import { type Mailer, magicLinkEmail } from '@hourmere/mail'
import { betterAuth } from 'better-auth'
import type { DBTransactionAdapter } from 'better-auth/adapters'
import { APIError } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins/magic-link'
import { organization } from 'better-auth/plugins/organization'
import type { GoogleOptions, MicrosoftOptions } from 'better-auth/social-providers'
import pg from 'pg'
import { parse } from 'pg-connection-string'
import { API_KEY_RATE_LIMIT } from './api-keys.ts'
import type { Principal } from './caller.ts'
import { API_KEY_PREFIX } from './caller.ts'
import { sanitizeInitialDisplayName } from './display-name.ts'
import { beforeHook } from './hooks.ts'
import type { ReserveInvitationEmail } from './invitations.ts'
import { betterAuthLog, logMailFailure } from './log.ts'
import { confirmLink, SIGN_IN_PATH } from './magic-link.ts'
import { mcpOAuthPlugins } from './mcp-oauth.ts'
import { serializeOrganizationContext } from './organization-context.ts'
import { organizationOperationRecords } from './organization-operations.ts'
import { ensurePersonalOrganization, organizationGuards } from './organizations.ts'
import { hasAccount, maySignUp, type SignupPolicy, signupConnectionOptions } from './signup.ts'
import { createTeamRolePolicy } from './team-role-policy.ts'

export { InvalidApiKeyError, requireActiveApiKey } from './api-key-principal.ts'
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
export { DISPLAY_NAME_MAX_LENGTH } from './display-name.ts'
export {
  type InvitationEligibilityDenial,
  type InvitationResendDenial,
  invitationEligibilityDenial,
  invitationRecipientIsMember,
  invitationResendDenial,
  type ResendInvitation,
  type ResendInvitationDelivery,
} from './invitation-resend.ts'
export { escapeControlCharacters, redactLogDetails } from './log.ts'
export { MAGIC_LINK_CONFIRM_PATH, MAGIC_LINK_VERIFY_PARAMS } from './magic-link.ts'
export {
  type BoundMcpOAuthIntent,
  createMcpOAuthResolver,
  hasMcpOAuthIntent,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_SCOPES,
  mcpOAuthUrls,
  withMcpOAuthIntent,
} from './mcp-oauth.ts'
export {
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
} from './member-departure.ts'
export { ensurePersonalOrganization } from './organizations.ts'
export {
  assertSignupEnforced,
  EMAIL_DOMAIN,
  hasAccount,
  maySignUp,
  SIGNUP_MODES,
  type SignupMode,
  type SignupPolicy,
} from './signup.ts'
export {
  checkTeamManagementAccess,
  TeamManagementError,
  type TeamManager,
  teamRoles,
} from './team-management.ts'

/** Separate lock connections cannot starve the handler's auth/application query pools. */
class AuthPool extends pg.Pool {
  readonly organizationLocks: pg.Pool

  constructor(config: pg.PoolConfig) {
    super(config)
    this.organizationLocks = new pg.Pool({ ...config, max: 2 })
    guardPoolErrors(this.organizationLocks, ' (organization context)')
  }

  override end(): Promise<void>
  override end(callback: () => void): void
  override end(callback?: () => void): Promise<void> | void {
    const closing = Promise.all([super.end(), this.organizationLocks.end()]).then(() => {})
    if (callback) {
      void closing.then(callback, callback)
      return
    }
    return closing
  }
}

/**
 * Better Auth owns the `auth` schema (its own table and column naming). Its pool only
 * sees that schema; application tables live in `public` and reference auth rows by id.
 * After changing plugins, regenerate the SQL with `npm run auth:sql` and add it as a
 * migration in packages/db/migrations.
 *
 * Its connections also carry the sign-up policy, which the database enforces when a user is
 * inserted; pass createAuth the same policy, and check the settings arrive with
 * assertSignupEnforced before serving requests.
 */
export function createAuthPool(databaseUrl: string, signup: SignupPolicy): pg.Pool {
  // Parsed here, the way node-postgres parses it, instead of passed as connectionString:
  // node-postgres lets an `options` parameter in the URL replace the options given beside it,
  // which would drop the sign-up settings and turn the database check off. The URL's options
  // still apply, after our search_path (so they may change it) and before the sign-up
  // settings (so they cannot).
  const config = parse(databaseUrl)
  const options = ['-c search_path=auth', config.options, signupConnectionOptions(signup)]
    .filter(Boolean)
    .join(' ')
  const pool = new AuthPool({ ...(config as pg.PoolConfig), options })
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
  /** Scheduling owns safe self departure. Omission disables native self departure. */
  leaveTeamMember?:
    | ((
        principal: Principal,
        teamId: string,
        expectedOrganizationId: string,
      ) => Promise<{ organizationId: string }>)
    | undefined
  /** Where people reach Hourmere (PUBLIC_URL); sign-in links and cookies are built from it. */
  baseURL: string
  secret: string
  /** Sends the sign-in links. */
  mailer: Mailer
  /**
   * Production delivery queues every request uniformly before any account/policy lookup.
   * Omitted only by standalone auth fixtures and schema generation, which use direct mail.
   * The URL already uses the scanner-safe confirmation page and a fragment token.
   */
  queueSignInEmail?:
    | ((request: { email: string; url: string; language?: InterfaceLanguage }) => Promise<void>)
    | undefined
  /** Invitation admission uses its own recipient domain under the shared mail-budget lock. */
  reserveInvitationEmail?: ReserveInvitationEmail | undefined
  /** Who may create an account (SIGNUP); the same policy the pool was created with. */
  signup: SignupPolicy
  /** Each provider is enabled only when configured. */
  socialProviders?: { google?: OAuthClient | undefined; microsoft?: OAuthClient | undefined }
  /**
   * Better Auth provider options applied over ours. Tests use it to replace the provider's
   * token check and profile lookup; production configuration does not set it.
   */
  /** Optional MCP OAuth authorization server, separate from social/calendar providers. */
  mcpOAuth?: boolean | undefined
  /** Injected only by isolated client-metadata tests; runtime uses the pinned DNS transport. */
  mcpMetadataFetcher?: Parameters<typeof mcpOAuthPlugins>[2]
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
  queueSignInEmail,
  reserveInvitationEmail,
  signup,
  socialProviders = {},
  socialProviderOptions = {},
  mcpOAuth = false,
  mcpMetadataFetcher,
  leaveTeamMember,
}: AuthConfig) {
  const lockPool = (pool as Partial<AuthPool>).organizationLocks
  if (!lockPool) throw new Error('createAuth requires a pool created by createAuthPool')
  const { google, microsoft } = socialProviders
  const teamRolePolicy = createTeamRolePolicy(db, leaveTeamMember)
  const auth = betterAuth({
    database: pool,
    disabledPaths: [
      // Hourmere uses social providers only for sign-in. Browser sessions must not read
      // or refresh their credentials or manage linked accounts through unused endpoints.
      '/account-info',
      '/get-access-token',
      '/refresh-token',
      '/link-social',
      '/list-accounts',
      // Consent changes must also retire Hourmere's grant generation and refresh tokens.
      ...(mcpOAuth ? ['/token', '/oauth2/delete-consent', '/oauth2/update-consent'] : []),
    ],
    baseURL,
    secret,
    // The OAuth attack surface is the same for every NODE_ENV.
    ...(mcpOAuth ? { rateLimit: { enabled: true } } : {}),
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: new URL(baseURL).protocol === 'https:',
      // Better Auth turns origin checks off when NODE_ENV is "test"; keep them on so tests
      // exercise the same CSRF protection as production.
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    logger: { log: betterAuthLog },
    onAPIError: {
      // Unexpected errors go to the caller (the server's error handler logs them on one
      // escaped line) instead of being printed raw by Better Auth's router.
      throw: true,
      // Where sign-in failures go when Better Auth does not know the app's errorCallbackURL,
      // e.g. an OAuth callback whose state is missing or forged (or expired, for a sign-in
      // started without one): the app's sign-in page, which explains the code, instead of
      // Better Auth's own error page. A fixed URL on our origin, so nothing in the request can
      // point it elsewhere; Better Auth adds only ?error=CODE (and error_description, which
      // the page never shows).
      errorURL: new URL(SIGN_IN_PATH, baseURL).href,
    },
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
          // Omit incremental authorization so a prior Calendar grant in the same Google
          // project cannot widen this identity-only sign-in grant.
          includeGrantedScopes: false,
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
      account: {
        // Sign-in ID tokens contain identity claims needed only during authentication.
        // Google sign-in/linking needs no refresh token: Hourmere renews its own session.
        // Clear even an unexpected provider token or a legacy value on repeat sign-in.
        // Other retained OAuth tokens keep Better Auth's encryption.
        create: {
          before: async (account) => ({
            data: {
              ...account,
              idToken: null,
              ...(account.providerId === 'google' && {
                refreshToken: null,
                refreshTokenExpiresAt: null,
              }),
            },
          }),
        },
        update: {
          before: async (account) => ({
            data: {
              ...account,
              idToken: null,
            },
          }),
        },
      },
      user: {
        create: {
          before: async (user) => {
            // Every new user passes here, whatever the route (email link, Google, Microsoft),
            // so this is where the sign-up policy applies. Better Auth runs this outside the
            // insert's transaction, so two first sign-ups at the same moment could both pass;
            // the database checks again inside it (migration 0006) and lets only one through.
            if (!(await maySignUp(db, signup, user.email))) {
              throw new APIError('FORBIDDEN', {
                code: 'SIGNUP_DISABLED',
                message:
                  'This Hourmere instance does not accept new accounts for this email address. Ask its administrator for access.',
              })
            }
            // Every account starts from a proven email address. A provider that does not vouch
            // for the address (Microsoft often does not) could otherwise create an account for
            // someone else's email and mint API keys in it before the owner ever signs in.
            if (!user.emailVerified) {
              throw new APIError('FORBIDDEN', {
                code: 'EMAIL_NOT_VERIFIED',
                message:
                  'This sign-in provider did not confirm your email address. Sign in with an email link first; you can use this provider afterwards if it confirms the address.',
              })
            }
            return { data: { ...user, name: sanitizeInitialDisplayName(user.name) } }
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
    hooks: { before: beforeHook(db, teamRolePolicy.before, reserveInvitationEmail) },
    plugins: [
      {
        id: 'sign-in-token-updates',
        init(ctx) {
          // Better Auth 1.7.10 passes only the patch to update.before, without its id or
          // selector. Refresh patches also omit providerId. Read the stored provider at
          // the adapter boundary, where the actual selector is available, before writing.
          const guard = (adapter: DBTransactionAdapter): DBTransactionAdapter => {
            const update = adapter.update
            adapter.update = async (request) => {
              if (request.model === 'account') {
                const account = await adapter.findOne<{ providerId: string }>({
                  model: 'account',
                  where: request.where,
                  select: ['providerId'],
                })
                if (account?.providerId === 'google') {
                  return update({
                    ...request,
                    update: { ...request.update, refreshToken: null, refreshTokenExpiresAt: null },
                  })
                }
              }
              return update(request)
            }
            return adapter
          }
          const adapter = ctx.adapter
          guard(adapter)
          const transaction = adapter.transaction
          adapter.transaction = (callback) => transaction((trx) => callback(guard(trx)))
          // The only account updateMany path is updatePassword, whose selector fixes
          // providerId to credential; Hourmere does not enable password authentication.
        },
      },
      ...(mcpOAuth ? mcpOAuthPlugins(db, baseURL, mcpMetadataFetcher) : []),
      organizationOperationRecords(),
      {
        id: 'team-role-policy',
        init(ctx) {
          // Wrap the operation recorder last: HTTP role changes use the policy's locked
          // application transaction for both the member update and its attribution.
          // An outer native recorder would hold an organization FK lock on a separate
          // connection while this policy waits for that organization's write lock.
          const adapter = ctx.adapter
          teamRolePolicy.adapter(adapter)
          const transaction = adapter.transaction
          adapter.transaction = (callback) =>
            transaction((trx) => callback(teamRolePolicy.adapter(trx)))
        },
      },
      organization({
        // An invitation is accepted only by someone who proved they own the invited address.
        requireEmailVerificationOnInvitation: true,
        organizationHooks: organizationGuards(db),
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
        sendMagicLink: async ({ email, url }, ctx) => {
          const headers = ctx?.headers ?? ctx?.request?.headers
          const language = resolveAdminLanguage({
            cookie: headers?.get('cookie') ?? undefined,
            acceptLanguage: headers?.get('accept-language') ?? undefined,
          })
          // No address-dependent reads or SMTP work on the production request path.
          if (queueSignInEmail) {
            await queueSignInEmail({ email, url: confirmLink(url), language })
            return
          }
          // Standalone auth fixtures/schema generation use the direct-mail fallback.
          // No email to an address that has no account and may not create one: the link could
          // only fail. The request is answered the same either way, so this does not tell
          // anyone whether an address has an account.
          if (!(await maySignUp(db, signup, email)) && !(await hasAccount(db, email))) return
          const message = magicLinkEmail({
            to: email,
            url: confirmLink(url),
            expiresInMinutes: MAGIC_LINK_MINUTES,
            language,
          })
          // Sent after the answer, for any address: waiting for SMTP would make an address that
          // gets an email answer later than one that does not, and an SMTP failure would answer
          // with an error only for those. A failure is logged instead (nothing retries it yet).
          setImmediate(() => {
            void Promise.resolve()
              .then(() => mailer.send(message))
              .catch(logMailFailure)
          })
        },
      }),
    ],
  })
  auth.handler = teamRolePolicy.handler(
    serializeOrganizationContext(createDb(lockPool), auth.handler, (headers) =>
      auth.api.getSession({ headers }),
    ),
  )
  return auth
}

export type Auth = ReturnType<typeof createAuth>
