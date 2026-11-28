// OAuth authorization for MCP is independent from Google/Microsoft calendar connections.
// The provider handles PKCE, signed continuations, client discovery and token rotation.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { mcp } from '@better-auth/mcp'
import type { Database, Db } from '@hourmere/db'
import { scimProvisioned, scimSuspended } from '@hourmere/db/scim-suspension'
import { APIError } from 'better-auth/api'
import {
  createDpopReplayStore,
  enforceDpopBinding,
  getConfirmationJkt,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from 'better-auth/oauth2'
import { jwt } from 'better-auth/plugins/jwt'
import { sql, type Transaction } from 'kysely'
import type { Principal } from './caller.ts'
import { withTeamCredential } from './custom-role-permissions.ts'
import type { Auth } from './index.ts'
import { isUuid } from './organizations.ts'
import { lockSsoDelegation, ssoDelegationStatus } from './sso-delegation-access.ts'
import { ssoHardOff, type TeamSsoCapabilities } from './team-sso.ts'

export const MCP_OAUTH_SCOPE = 'mcp:tools'
export const MCP_OAUTH_SCOPES = [MCP_OAUTH_SCOPE, 'offline_access']
export const MCP_OAUTH_CONSENT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const TEAM_AUTHORIZATION_CLAIM = 'https://hourmere.com/team-authorization'
const hashOAuthToken = (token: string) => createHash('sha256').update(token).digest('base64url')
const invalidGrant = () =>
  new APIError('BAD_REQUEST', {
    error: 'invalid_grant',
    error_description: 'Connection expired or revoked',
  })
const delegationRequired = (): never => {
  throw new APIError('FORBIDDEN', {
    error: 'sso_required',
    error_description: 'This team requires a current SSO delegation.',
  })
}

type DelegationAuthority = { organizationId: string; userId: string; credentialId: string }
const tokenIssuance = new AsyncLocalStorage<{ authority?: DelegationAuthority }>()

/** Created and checked by the session-authenticated broker; never supplied by a client. */
export interface BoundMcpOAuthIntent {
  id: string
  userId: string
  sessionId: string
  organizationId: string
  grantId: string
  atomicConsent?: boolean
  forceConsent?: boolean
}
const intents = new AsyncLocalStorage<
  Readonly<BoundMcpOAuthIntent & { transaction: Transaction<Database> | undefined }>
>()

export function withMcpOAuthIntent<T>(
  intent: BoundMcpOAuthIntent,
  fn: () => T,
  transaction?: Transaction<Database>,
): T {
  // The broker already holds an app-pool client while invoking the native provider.
  // Its membership callback must reuse that client rather than wait for a second one.
  return intents.run(Object.freeze({ ...intent, transaction }), fn)
}

export function mcpOAuthConsentTransaction() {
  const intent = intents.getStore()
  return intent?.atomicConsent ? intent.transaction : undefined
}

export function mcpOAuthForcedConsentReference() {
  const intent = intents.getStore()
  return intent?.forceConsent ? intent.grantId : undefined
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
  scimResourcesEnabled = false,
) {
  if (!isUuid(userId) || !isUuid(organizationId)) throw refusal()
  const row = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select('m.id')
    .where('m.userId', '=', userId)
    .where('m.organizationId', '=', organizationId)
    .where('u.emailVerified', '=', true)
    .where((eb) => eb.not(scimSuspended(organizationId, userId, scimResourcesEnabled)))
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

function grantDelegationStatus(capabilities: TeamSsoCapabilities) {
  return ssoDelegationStatus(
    sql.ref('grant_row.organization_id'),
    sql.ref('grant_row.user_id'),
    'oauth_grant',
    sql.ref('grant_row.id'),
    capabilities,
  ).as('ssoDelegationStatus')
}

async function currentConsent(
  db: Db,
  capabilities: TeamSsoCapabilities,
  grantId: string,
  userId: string,
  clientId?: string,
) {
  const consent = await db
    .selectFrom('mcp_oauth_grants as grant_row')
    .innerJoin('auth.oauthConsent as c', (j) =>
      j.on(sql<boolean>`c."referenceId" = grant_row.id::text`),
    )
    .select([
      'grant_row.organization_id',
      'grant_row.client_id',
      'c.createdAt',
      'c.scopes',
      'c.resources',
    ])
    .select(grantDelegationStatus(capabilities))
    .where('grant_row.id', '=', grantId)
    .where('grant_row.user_id', '=', userId)
    .whereRef('c.userId', '=', 'grant_row.user_id')
    .whereRef('c.clientId', '=', 'grant_row.client_id')
    .$if(clientId !== undefined, (q) => q.where('grant_row.client_id', '=', clientId as string))
    .executeTakeFirst()
  if (
    !consent ||
    new Date(consent.createdAt).getTime() + MCP_OAUTH_CONSENT_LIFETIME_MS <= Date.now()
  )
    throw invalidGrant()
  return consent
}

async function requireDelegation(
  db: Db,
  capabilities: TeamSsoCapabilities,
  consent: Awaited<ReturnType<typeof currentConsent>>,
  userId: string,
  credentialId: string,
) {
  if (consent.ssoDelegationStatus === null) return
  if (consent.ssoDelegationStatus === 'required') delegationRequired()
  const authority = { organizationId: consent.organization_id, userId, credentialId }
  if (consent.ssoDelegationStatus === 'valid')
    await db.transaction().execute((trx) => lockDelegation(trx, capabilities, authority))
  const issuance = tokenIssuance.getStore()
  if (issuance) issuance.authority = authority
}

async function lockDelegation(
  trx: Transaction<Database>,
  capabilities: TeamSsoCapabilities,
  authority: DelegationAuthority,
  denied = delegationRequired,
) {
  await lockSsoDelegation(trx, capabilities, { ...authority, kind: 'oauth_grant' }, denied)
}

async function checkRefresh(
  db: Db,
  resource: string,
  capabilities: TeamSsoCapabilities,
  tokenHash: string,
) {
  const refresh = await db
    .selectFrom('auth.oauthRefreshToken')
    .select(['referenceId', 'userId', 'clientId', 'scopes'])
    .where('token', '=', tokenHash)
    .executeTakeFirst()
  // Unknown tokens and client authentication remain the provider's responsibility.
  if (!refresh) return
  if (!refresh.referenceId || !isUuid(refresh.referenceId)) throw invalidGrant()
  const consent = await currentConsent(
    db,
    capabilities,
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
  await requireMembership(
    db,
    refresh.userId,
    consent.organization_id,
    invalidGrant,
    capabilities.scimResourcesEnabled === true,
  )
  await requireDelegation(db, capabilities, consent, refresh.userId, refresh.referenceId)
}

function capRefreshDeadline(db: Db, tokenHash: string) {
  // Better Auth rotates with a fresh relative TTL. Cap it to the original consent time.
  return db
    .updateTable('auth.oauthRefreshToken as r')
    .from('auth.oauthConsent as c')
    .set({ expiresAt: sql<Date>`least(r."expiresAt", c."createdAt" + interval '720 hours')` })
    .whereRef('r.referenceId', '=', 'c.referenceId')
    .whereRef('r.userId', '=', 'c.userId')
    .whereRef('r.clientId', '=', 'c.clientId')
    .where('r.token', '=', tokenHash)
    .execute()
}

const staleDelegation = new Error('SSO delegation changed during token issuance')

async function finalizeDelegatedTokens(
  db: Db,
  capabilities: TeamSsoCapabilities,
  authority: DelegationAuthority,
  accessToken: string,
  refreshHash: string | undefined,
  presentedHash: string | undefined,
) {
  const live = await db.transaction().execute(async (trx) => {
    try {
      await lockDelegation(trx, capabilities, authority, () => {
        throw staleDelegation
      })
    } catch (error) {
      if (error !== staleDelegation) throw error
      // JWTs never leave this request. Revoke any persisted opaque and refresh tokens
      // and clear the original rotation response so a later rebind cannot replay them.
      await trx
        .deleteFrom('auth.oauthAccessToken')
        .where('token', '=', hashOAuthToken(accessToken))
        .where('referenceId', '=', authority.credentialId)
        .execute()
      if (presentedHash)
        await trx
          .updateTable('auth.oauthRefreshToken')
          .set({ rotationReplayResponse: null, rotationReplayExpiresAt: null })
          .where('token', '=', presentedHash)
          .where('referenceId', '=', authority.credentialId)
          .execute()
      if (refreshHash)
        await trx
          .deleteFrom('auth.oauthRefreshToken')
          .where('token', '=', refreshHash)
          .where('referenceId', '=', authority.credentialId)
          .execute()
      return false
    }
    if (refreshHash) await capRefreshDeadline(trx, refreshHash)
    return true
  })
  if (!live) delegationRequired()
}

export function mcpOAuthPlugins(
  db: Db,
  baseUrl: string,
  metadataFetcher = fetchClientMetadataResource,
  capabilities = ssoHardOff,
) {
  const { issuer, resource } = mcpOAuthUrls(baseUrl)
  const plugins = [
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
          await requireMembership(
            intent.transaction ?? db,
            user.id,
            intent.organizationId,
            refused,
            capabilities.scimResourcesEnabled === true,
          )
          return intent.grantId
        },
      },
      // Runs after provider validation at code exchange and ordinary refresh.
      customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
        if (!user || !referenceId || !isUuid(referenceId)) throw invalidGrant()
        const grant = await db
          .selectFrom('mcp_oauth_grants as grant')
          .leftJoin(
            'team_credential_authorizations as ceiling',
            'ceiling.oauth_grant_id',
            'grant.id',
          )
          .select([
            'grant.organization_id',
            'ceiling.id as authorizationId',
            'ceiling.credential_generation',
          ])
          .where('grant.id', '=', referenceId)
          .where('grant.user_id', '=', user.id)
          .executeTakeFirst()
        if (!grant) throw invalidGrant()
        await requireMembership(
          db,
          user.id,
          grant.organization_id,
          invalidGrant,
          capabilities.scimResourcesEnabled === true,
        )
        const consent = await currentConsent(db, capabilities, referenceId, user.id)
        if (
          !Array.isArray(consent.scopes) ||
          !consent.scopes.includes(MCP_OAUTH_SCOPE) ||
          (scopes.includes('offline_access') && !consent.scopes.includes('offline_access')) ||
          !Array.isArray(consent.resources) ||
          !consent.resources.includes(resource)
        )
          throw invalidGrant()
        await requireDelegation(db, capabilities, consent, user.id, referenceId)
        await touchClient(db, consent.client_id)
        return {
          'https://hourmere.com/organization': grant.organization_id,
          'https://hourmere.com/grant': referenceId,
          ...(grant.authorizationId && {
            [TEAM_AUTHORIZATION_CLAIM]: `${grant.authorizationId}:${grant.credential_generation}`,
          }),
        }
      },
    }),
    cimd({ fetchClientMetadataResource: metadataFetcher, metadataProfile: 'mcp-2026-07-28' }),
  ] as const
  const endpoints = plugins[1].endpoints
  const token = endpoints.oauth2Token
  endpoints.oauth2Token = Object.assign((context: Parameters<typeof token>[0]) => {
    return tokenIssuance.run({}, async () => {
      const body = context?.body
      // The provider trims the grant type during validation but treats the token as opaque.
      const presentedHash =
        typeof body?.grant_type === 'string' &&
        body.grant_type.trim() === 'refresh_token' &&
        typeof body.refresh_token === 'string'
          ? hashOAuthToken(body.refresh_token)
          : undefined
      if (presentedHash) await checkRefresh(db, resource, capabilities, presentedHash)
      const result = await token(context)
      // Better Auth dispatches endpoints with returnHeaders and returnStatus enabled.
      const response =
        'response' in result
          ? (result.response as Pick<typeof result, 'access_token' | 'refresh_token'>)
          : result
      const refreshHash = response.refresh_token && hashOAuthToken(response.refresh_token)
      const authority = tokenIssuance.getStore()?.authority
      // Native issuance and replay have finished. Check reliance before letting either
      // return tokens. Keep Better Auth's single-use code and rotation semantics intact.
      if (authority && response.access_token)
        await finalizeDelegatedTokens(
          db,
          capabilities,
          authority,
          response.access_token,
          refreshHash,
          presentedHash,
        )
      else if (refreshHash) await capRefreshDeadline(db, refreshHash)
      return result
    })
  }, token) as typeof token
  return plugins
}

/** Only MCP accepts these tokens; the REST resolver deliberately remains unchanged. */
export function createMcpOAuthResolver({
  auth,
  db,
  publicUrl,
  ssoCapabilities = ssoHardOff,
  customRolesEnabled = false,
}: {
  auth: Auth
  db: Db
  publicUrl: string
  ssoCapabilities?: TeamSsoCapabilities
  customRolesEnabled?: boolean | undefined
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
      .selectFrom('mcp_oauth_grants as grant_row')
      .innerJoin('auth.oauthConsent as c', (j) =>
        j.on(sql<boolean>`c."referenceId" = grant_row.id::text`),
      )
      .innerJoin('auth.oauthClient as a', 'a.clientId', 'grant_row.client_id')
      .innerJoin('auth.member as m', (j) =>
        j
          .onRef('m.userId', '=', 'grant_row.user_id')
          .onRef('m.organizationId', '=', 'grant_row.organization_id'),
      )
      .leftJoin('team_member_authorizations as authorization', 'authorization.member_id', 'm.id')
      .innerJoin('auth.user as u', 'u.id', 'grant_row.user_id')
      .innerJoin('auth.organization as o', 'o.id', 'grant_row.organization_id')
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
        'authorization.generation as memberGeneration',
      ])
      .select(grantDelegationStatus(ssoCapabilities))
      .select((eb) => scimProvisioned(eb.ref('o.id')).as('scimProvisioned'))
      .where('grant_row.id', '=', grantId)
      .where('grant_row.user_id', '=', payload.sub)
      .where('grant_row.organization_id', '=', organizationId)
      .where('grant_row.client_id', '=', payload.client_id)
      .whereRef('c.clientId', '=', 'grant_row.client_id')
      .whereRef('c.userId', '=', 'grant_row.user_id')
      .where('u.emailVerified', '=', true)
      .where((eb) =>
        eb.not(
          scimSuspended(
            eb.ref('grant_row.organization_id'),
            eb.ref('u.id'),
            ssoCapabilities.scimResourcesEnabled === true,
          ),
        ),
      )
      .where(sql<boolean>`a.disabled IS DISTINCT FROM true`)
      .executeTakeFirst()
    if (
      !row ||
      new Date(row.createdAt).getTime() + MCP_OAUTH_CONSENT_LIFETIME_MS <= Date.now() ||
      !Array.isArray(row.scopes) ||
      !row.scopes.includes(MCP_OAUTH_SCOPE) ||
      (scopes.includes('offline_access') && !row.scopes.includes('offline_access')) ||
      !Array.isArray(row.resources) ||
      !row.resources.includes(resource)
    )
      return invalid
    await touchClient(db, payload.client_id)
    const principal = await withTeamCredential<Extract<Principal, { kind: 'oauth' }>>(
      db,
      {
        kind: 'oauth',
        oauthConsentId: row.id,
        oauthGrantId: grantId,
        ...(!scopes.includes('offline_access') &&
          typeof payload.sid === 'string' && { oauthSessionId: payload.sid }),
        ssoDelegationStatus: row.ssoDelegationStatus,
        ...(row.scimProvisioned && { scimProvisioned: true }),
        ...(ssoCapabilities.scimResourcesEnabled && { scimResourcesEnabled: true as const }),
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
      customRolesEnabled,
      row.memberGeneration ?? 1,
    )
    const option = principal.customRoleAuthorization
    const accepted = option?.credential
    if (
      accepted &&
      (payload[TEAM_AUTHORIZATION_CLAIM] !== `${accepted.authorizationId}:${accepted.generation}` ||
        (!scopes.includes('offline_access') && !principal.oauthSessionId))
    ) {
      // A legacy/online token retains its original non-versioned authority.
      principal.customRoleAuthorization = { available: option?.available === true }
    }
    return { ok: true, principal }
  }
}
