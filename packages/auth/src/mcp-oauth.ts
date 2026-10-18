// OAuth authorization for MCP is independent from Google/Microsoft calendar connections.
// The provider handles PKCE, signed continuations, client discovery and token rotation.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import type { Db } from '@hourmere/db'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import {
  createDpopReplayStore,
  enforceDpopBinding,
  getConfirmationJkt,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from 'better-auth/oauth2'
import { jwt } from 'better-auth/plugins/jwt'
import { sql } from 'kysely'
import type { Principal } from './caller.ts'
import type { Auth } from './index.ts'
import { isUuid } from './organizations.ts'

export const MCP_OAUTH_SCOPE = 'mcp:tools'
export const MCP_OAUTH_SCOPES = [MCP_OAUTH_SCOPE, 'offline_access']
const OFFLINE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const hashOAuthToken = (token: string) => createHash('sha256').update(token).digest('base64url')
const invalidGrant = () =>
  new APIError('BAD_REQUEST', {
    error: 'invalid_grant',
    error_description: 'Connection expired or revoked',
  })

/** Created and checked by the session-authenticated broker; never supplied by a client. */
export interface BoundMcpOAuthIntent {
  id: string
  userId: string
  sessionId: string
  organizationId: string
  grantId: string
}
const intents = new AsyncLocalStorage<Readonly<BoundMcpOAuthIntent>>()

export function withMcpOAuthIntent<T>(intent: BoundMcpOAuthIntent, fn: () => T): T {
  return intents.run(Object.freeze({ ...intent }), fn)
}

export function hasMcpOAuthIntent(): boolean {
  return intents.getStore() !== undefined
}

export function mcpOAuthUrls(baseUrl: string) {
  const origin = new URL(baseUrl).origin
  return { issuer: `${origin}/api/auth`, resource: `${origin}/mcp` }
}

const refused = () =>
  new APIError('FORBIDDEN', {
    code: 'MCP_ORGANIZATION_SELECTION_REQUIRED',
    message: 'Select an organization in the MCP connection flow',
  })

async function requireMembership(
  db: Db,
  userId: string,
  organizationId: string,
  refusal = refused,
) {
  if (!isUuid(userId) || !isUuid(organizationId)) throw refusal()
  const row = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select('m.id')
    .where('m.userId', '=', userId)
    .where('m.organizationId', '=', organizationId)
    .where('u.emailVerified', '=', true)
    .executeTakeFirst()
  if (!row) throw refusal()
}

/** Activity survives revocation so cleanup can distinguish an abandoned registration. */
async function touchClient(db: Db, clientId: string) {
  const now = new Date()
  await db
    .insertInto('mcp_oauth_client_activity')
    .values({ client_id: clientId, consented_at: now, last_used_at: now })
    .onConflict((oc) =>
      oc
        .column('client_id')
        .doUpdateSet({ last_used_at: now })
        .where('mcp_oauth_client_activity.last_used_at', '<', new Date(now.getTime() - 86400000)),
    )
    .execute()
}

async function currentConsent(db: Db, grantId: string, userId: string, clientId?: string) {
  const consent = await db
    .selectFrom('mcp_oauth_grants as g')
    .innerJoin('auth.oauthConsent as c', (j) => j.on(sql<boolean>`c."referenceId" = g.id::text`))
    .select(['g.organization_id', 'g.client_id', 'c.createdAt', 'c.scopes', 'c.resources'])
    .where('g.id', '=', grantId)
    .where('g.user_id', '=', userId)
    .whereRef('c.userId', '=', 'g.user_id')
    .whereRef('c.clientId', '=', 'g.client_id')
    .$if(clientId !== undefined, (q) => q.where('g.client_id', '=', clientId as string))
    .executeTakeFirst()
  if (!consent || new Date(consent.createdAt).getTime() + OFFLINE_LIFETIME_MS <= Date.now())
    throw invalidGrant()
  return consent
}

function offlineAccessLifecycle(db: Db, resource: string): BetterAuthPlugin {
  return {
    id: 'hourmere-mcp-offline-access',
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === '/oauth2/token' && ctx.body?.grant_type === 'refresh_token',
          handler: createAuthMiddleware(async (ctx) => {
            if (typeof ctx.body?.refresh_token !== 'string') return
            const refresh = await db
              .selectFrom('auth.oauthRefreshToken')
              .select(['referenceId', 'userId', 'clientId', 'scopes'])
              .where('token', '=', hashOAuthToken(ctx.body.refresh_token))
              .executeTakeFirst()
            // Unknown tokens and client authentication remain the provider's responsibility.
            if (!refresh) return
            if (!refresh.referenceId || !isUuid(refresh.referenceId)) throw invalidGrant()
            const consent = await currentConsent(
              db,
              refresh.referenceId,
              refresh.userId,
              refresh.clientId,
            )
            if (
              !Array.isArray(consent.scopes) ||
              !consent.scopes.includes(MCP_OAUTH_SCOPE) ||
              (Array.isArray(refresh.scopes) &&
                refresh.scopes.includes('offline_access') &&
                !consent.scopes.includes('offline_access')) ||
              !Array.isArray(consent.resources) ||
              !consent.resources.includes(resource)
            )
              throw invalidGrant()
            // Check even lost-response replay, which bypasses customAccessTokenClaims.
            await requireMembership(db, refresh.userId, consent.organization_id, invalidGrant)
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/oauth2/token',
          handler: createAuthMiddleware(async (ctx) => {
            const response = ctx.context.returned as { refresh_token?: unknown } | undefined
            if (typeof response?.refresh_token !== 'string') return
            // Better Auth rotates with a fresh relative TTL. Cap the persisted token before
            // returning it, using the original consent time rather than the rotation time.
            await db
              .updateTable('auth.oauthRefreshToken as r')
              .from('auth.oauthConsent as c')
              .set({
                expiresAt: sql<Date>`least(r."expiresAt", c."createdAt" + interval '720 hours')`,
              })
              .whereRef('r.referenceId', '=', 'c.referenceId')
              .whereRef('r.userId', '=', 'c.userId')
              .whereRef('r.clientId', '=', 'c.clientId')
              .where('r.token', '=', hashOAuthToken(response.refresh_token))
              .execute()
          }),
        },
      ],
    },
  }
}

export function mcpOAuthPlugins(
  db: Db,
  baseUrl: string,
  metadataFetcher = fetchClientMetadataResource,
) {
  const { issuer, resource } = mcpOAuthUrls(baseUrl)
  return [
    jwt({ jwt: { issuer }, disableSettingJwtHeader: true }),
    mcp({
      resource,
      loginPage: '/oauth/authorize',
      consentPage: '/oauth/consent',
      scopes: MCP_OAUTH_SCOPES,
      grantTypes: ['authorization_code', 'refresh_token'],
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      // Explicit format lets the lifecycle guard look up hashed tokens without decoding.
      storeTokens: { hash: async (value) => hashOAuthToken(value) },
      refreshTokenReuseInterval: 30,
      codeExpiresIn: 300,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
      allowPublicClientPrelogin: true,
      // Administrative client/resource APIs are not part of connecting a user's app.
      clientPrivileges: async () => false,
      resourcePrivileges: async () => false,
      postLogin: {
        page: '/oauth/authorize',
        shouldRedirect: async ({ user, session }) => {
          const intent = intents.getStore()
          return !intent || intent.userId !== user.id || intent.sessionId !== session.id
        },
        consentReferenceId: async ({ user, session }) => {
          const intent = intents.getStore()
          if (!intent || intent.userId !== user.id || intent.sessionId !== session.id)
            throw refused()
          await requireMembership(db, user.id, intent.organizationId)
          return intent.grantId
        },
      },
      customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
        if (!user || !referenceId || !isUuid(referenceId)) throw refused()
        const grant = await db
          .selectFrom('mcp_oauth_grants')
          .select('organization_id')
          .where('id', '=', referenceId)
          .where('user_id', '=', user.id)
          .executeTakeFirst()
        if (!grant) throw refused()
        await requireMembership(db, user.id, grant.organization_id)
        const consent = await currentConsent(db, referenceId, user.id)
        if (
          !Array.isArray(consent.scopes) ||
          !consent.scopes.includes(MCP_OAUTH_SCOPE) ||
          (scopes.includes('offline_access') && !consent.scopes.includes('offline_access')) ||
          !Array.isArray(consent.resources) ||
          !consent.resources.includes(resource)
        )
          throw invalidGrant()
        await touchClient(db, consent.client_id)
        return {
          'https://hourmere.com/organization': grant.organization_id,
          'https://hourmere.com/grant': referenceId,
        }
      },
    }),
    cimd({ fetchClientMetadataResource: metadataFetcher, metadataProfile: 'mcp-2026-07-28' }),
    offlineAccessLifecycle(db, resource),
  ] as const
}

/** Only MCP accepts these tokens; the REST resolver deliberately remains unchanged. */
export function createMcpOAuthResolver({
  auth,
  db,
  publicUrl,
}: {
  auth: Auth
  db: Db
  publicUrl: string
}) {
  const { issuer, resource } = mcpOAuthUrls(publicUrl)
  return async (
    request: Request,
  ): Promise<
    | { ok: true; principal: Extract<Principal, { kind: 'oauth' }> }
    | { ok: false; error: 'invalid_token' | 'insufficient_scope' }
  > => {
    const invalid = { ok: false, error: 'invalid_token' } as const
    const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'))
    if (
      !authorization ||
      !['Bearer', 'DPoP'].includes(authorization.scheme) ||
      authorization.token.length > 16384 ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(authorization.token)
    )
      return invalid
    // jose's malformed-header decoder also throws an untyped TypeError. Validate only
    // bounded JSON structure here, before any infrastructure is touched.
    try {
      const parts = authorization.token.split('.')
      const header: unknown = JSON.parse(
        Buffer.from(parts[0] as string, 'base64url').toString('utf8'),
      )
      const claims: unknown = JSON.parse(
        Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
      )
      if (
        !header ||
        typeof header !== 'object' ||
        Array.isArray(header) ||
        !claims ||
        typeof claims !== 'object' ||
        Array.isArray(claims)
      )
        return invalid
      const h = header as Record<string, unknown>
      if (
        h.alg !== 'EdDSA' ||
        h.typ !== 'at+jwt' ||
        typeof h.kid !== 'string' ||
        h.kid.length > 128
      )
        return invalid
    } catch {
      return invalid
    }
    // Resolve infrastructure outside the validation catch: a database outage is a 500.
    const jwks = await auth.api.getJwks()
    let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>
    try {
      payload = await verifyJwsAccessToken(authorization.token, {
        jwksFetch: async () => jwks,
        verifyOptions: {
          issuer,
          audience: resource,
          typ: 'at+jwt',
          algorithms: ['EdDSA'],
          requiredClaims: ['exp', 'iat', 'sub', 'client_id', 'scope'],
          maxTokenAge: 300,
          clockTolerance: 5,
        },
      })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (
        typeof code === 'string' &&
        code.startsWith('ERR_J') &&
        !['ERR_JWKS_INVALID', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'ERR_JWKS_TIMEOUT'].includes(code)
      )
        return invalid
      throw error
    }
    if (
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat > 305 ||
      payload.exp <= payload.iat ||
      (payload.cnf !== undefined && !getConfirmationJkt(payload.cnf))
    )
      return invalid
    const context = await auth.$context
    try {
      await enforceDpopBinding({
        payload,
        authorization,
        proofJwt: request.headers.get('dpop'),
        method: request.method,
        url: new URL(new URL(request.url).pathname, publicUrl).href,
        replayStore: createDpopReplayStore(context.internalAdapter),
      })
    } catch (error) {
      if (isDpopBindingError(error)) return invalid
      throw error
    }
    const organizationId = payload['https://hourmere.com/organization'],
      grantId = payload['https://hourmere.com/grant']
    if (
      typeof payload.sub !== 'string' ||
      !isUuid(payload.sub) ||
      typeof organizationId !== 'string' ||
      !isUuid(organizationId) ||
      typeof grantId !== 'string' ||
      !isUuid(grantId) ||
      typeof payload.client_id !== 'string' ||
      typeof payload.scope !== 'string'
    )
      return invalid
    const scopes = payload.scope.split(' ')
    // offline_access explicitly authorizes use after browser sign-out or session expiry.
    if (!scopes.includes('offline_access') && payload.sid !== undefined) {
      if (typeof payload.sid !== 'string' || !isUuid(payload.sid)) return invalid
      const active = await db
        .selectFrom('auth.session')
        .select('id')
        .where('id', '=', payload.sid)
        .where('userId', '=', payload.sub)
        .where('expiresAt', '>', new Date())
        .executeTakeFirst()
      if (!active) return invalid
    }
    if (!scopes.includes(MCP_OAUTH_SCOPE)) return { ok: false, error: 'insufficient_scope' }
    const row = await db
      .selectFrom('mcp_oauth_grants as g')
      .innerJoin('auth.oauthConsent as c', (j) => j.on(sql<boolean>`c."referenceId" = g.id::text`))
      .innerJoin('auth.oauthClient as a', 'a.clientId', 'g.client_id')
      .innerJoin('auth.member as m', (j) =>
        j.onRef('m.userId', '=', 'g.user_id').onRef('m.organizationId', '=', 'g.organization_id'),
      )
      .innerJoin('auth.user as u', 'u.id', 'g.user_id')
      .innerJoin('auth.organization as o', 'o.id', 'g.organization_id')
      .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
      .select([
        'c.id',
        'c.createdAt',
        'u.id as userId',
        'u.name',
        'u.email',
        'o.id as organizationId',
        'o.name as organizationName',
        'o.slug',
        'p.user_id as personalOwnerId',
        'c.scopes',
        'c.resources',
      ])
      .where('g.id', '=', grantId)
      .where('g.user_id', '=', payload.sub)
      .where('g.organization_id', '=', organizationId)
      .where('g.client_id', '=', payload.client_id)
      .whereRef('c.clientId', '=', 'g.client_id')
      .whereRef('c.userId', '=', 'g.user_id')
      .where('u.emailVerified', '=', true)
      .where(sql<boolean>`a.disabled IS DISTINCT FROM true`)
      .executeTakeFirst()
    if (
      !row ||
      new Date(row.createdAt).getTime() + OFFLINE_LIFETIME_MS <= Date.now() ||
      !Array.isArray(row.scopes) ||
      !row.scopes.includes(MCP_OAUTH_SCOPE) ||
      (scopes.includes('offline_access') && !row.scopes.includes('offline_access')) ||
      !Array.isArray(row.resources) ||
      !row.resources.includes(resource)
    )
      return invalid
    await touchClient(db, payload.client_id)
    return {
      ok: true,
      principal: {
        kind: 'oauth',
        oauthConsentId: row.id,
        clientId: payload.client_id,
        scopes,
        user: { id: row.userId, name: row.name, email: row.email },
        organization: {
          id: row.organizationId,
          name: row.organizationName,
          slug: row.slug,
          personal: row.personalOwnerId !== null,
        },
      },
    }
  }
}
