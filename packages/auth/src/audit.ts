import { AsyncLocalStorage } from 'node:async_hooks'
import { runWithTransaction, tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { Database } from '@hourmere/db'
import { writeAuditEvent, writeSsoAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import type { BetterAuthPlugin } from 'better-auth'
import type { DBTransactionAdapter } from 'better-auth/adapters'
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  revokeOtherSessions,
  revokeSession,
  revokeSessions,
  signOut,
} from 'better-auth/api'
import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import {
  API_KEY_ORGANIZATION_CHANGED_MESSAGE,
  API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
  API_KEY_TEAM_AUTHORIZATION_REVIEW_MESSAGE,
} from './api-key-errors.ts'
import { isApiKeyScope } from './api-key-metadata.ts'
import {
  currentSessionTeamCeiling,
  customCredentialPermissions,
  lockCustomRoleMaster,
  TEAM_AUTHORIZATION_REVIEW_HEADER,
  teamAuthorizationFacts,
} from './custom-role-credentials.ts'
import { mcpOAuthForcedConsentReference } from './mcp-oauth.ts'
import { isUuid } from './organizations.ts'

const transactions = new AsyncLocalStorage<{
  trx: Transaction<Database>
  failure?: unknown
  closing?: boolean
  pending: Set<Promise<unknown>>
}>()
export const withAuthAuditTransaction = <T>(
  trx: Transaction<Database>,
  operation: () => Promise<T>,
) =>
  transactions.run({ trx, pending: new Set() }, async () => {
    const outcome = await operation().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    )
    const state = transactions.getStore()
    if (state) state.closing = true
    // Native bulk endpoints use Promise.all. Its first rejection must not release the
    // transaction while sibling adapter operations still have queries to submit.
    while (state?.pending.size) await Promise.allSettled([...state.pending])
    if (!outcome.ok) throw outcome.error
    if (state?.failure) throw state.failure
    return outcome.value
  })

type Row = Record<string, unknown>
type Condition = { field: string; operator?: string; value: unknown }
/** Better Auth wipes a refresh family when a revoked token is presented to either path. */
const refreshFamilyPaths = ['/oauth2/revoke', '/oauth2/token']

/**
 * Request validation accepts any UUID spelling and Postgres compares uuid values without
 * case, while Better Auth writes with the stored lowercase id. Compare the canonical form.
 */
const sameId = (left: unknown, right: unknown) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase()

function keyOrganization(row: Row | undefined) {
  const raw = row?.metadata
  const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw
  const organizationId = metadata?.organizationId
  return typeof organizationId === 'string' && isUuid(organizationId)
    ? organizationId.toLowerCase()
    : undefined
}

/** Audit native persistence, never a response hook: failures roll back the changed row. */
export function authAuditRecords(
  scimResourcesEnabled = false,
  customRolesEnabled = false,
): BetterAuthPlugin {
  const sessionEndpoints = {
    revokeSession: Object.assign((context: Parameters<typeof revokeSession>[0]) => {
      if (!context?.context) return revokeSession(context)
      return runWithTransaction(context.context.adapter, async () => {
        return revokeSession(context)
      })
    }, revokeSession) as typeof revokeSession,
    revokeSessions: Object.assign((context: Parameters<typeof revokeSessions>[0]) => {
      if (!context?.context) return revokeSessions(context)
      return runWithTransaction(context.context.adapter, async () => {
        return revokeSessions(context)
      })
    }, revokeSessions) as typeof revokeSessions,
    revokeOtherSessions: Object.assign((context: Parameters<typeof revokeOtherSessions>[0]) => {
      if (!context?.context) return revokeOtherSessions(context)
      return runWithTransaction(context.context.adapter, async () => {
        return revokeOtherSessions(context)
      })
    }, revokeOtherSessions) as typeof revokeOtherSessions,
    signOut: Object.assign((context: Parameters<typeof signOut>[0]) => {
      if (!context?.context) return signOut(context)
      return runWithTransaction(context.context.adapter, async () => {
        return signOut(context)
      })
    }, signOut) as typeof signOut,
  }
  return {
    id: 'hourmere-auth-audit',
    endpoints: sessionEndpoints,
    hooks: {
      before: [
        {
          matcher: (context) => context.path === '/sign-out',
          handler: createAuthMiddleware(async (context) => {
            context.context.session = await getSessionFromCtx(context)
          }),
        },
      ],
    },
    init(ctx) {
      // Revocation and refresh find the presented refresh token before any family
      // invalidation.
      const presentedRefreshTokens = new WeakMap<object, Row>()
      // Family access-token deletion waits for the family's refresh-token transaction.
      const deferredFamilyAccessTokens = new WeakMap<object, { model: string }>()
      const wrap = (adapter: DBTransactionAdapter, inTransaction: boolean) => {
        // Synthetic adapters in unit harnesses may omit reads.
        const findOne = adapter.findOne?.bind(adapter)
        if (findOne)
          adapter.findOne = (async (request: Parameters<DBTransactionAdapter['findOne']>[0]) => {
            const reviewedGrant = mcpOAuthForcedConsentReference()
            if (
              reviewedGrant &&
              request.model === 'oauthConsent' &&
              request.where?.some(
                (item) => item.field === 'referenceId' && item.value === reviewedGrant,
              )
            )
              return null
            const found = await findOne<Row>(request)
            const endpoint = tryGetCurrentAuthEndpointContext()
            if (
              found &&
              endpoint &&
              refreshFamilyPaths.includes(endpoint.path ?? '') &&
              request.model === 'oauthRefreshToken' &&
              (request.where as Condition[] | undefined)?.some(
                (condition) => condition.field === 'token',
              )
            )
              presentedRefreshTokens.set(endpoint, found)
            return found
          }) as DBTransactionAdapter['findOne']
        for (const method of [
          'create',
          'update',
          'updateMany',
          'incrementOne',
          'delete',
          'deleteMany',
          'consumeOne',
        ] as const) {
          const original = adapter[method].bind(adapter)
          // The adapter's generic return types vary by operation; preserve them at this boundary.
          const wrapped = async (request: { model: string; [key: string]: unknown }) => {
            const endpoint = tryGetCurrentAuthEndpointContext()
            const path = endpoint?.path ?? ''
            const where = (request.where as Condition[] | undefined) ?? []
            // Presenting a reused refresh token (to revoke or to refresh) invalidates the
            // client's whole family for that user: first the family's access tokens, then
            // its refresh tokens, by client and user. One event per grant, written with the
            // refresh tokens, records the family.
            const familyPath = refreshFamilyPaths.includes(path)
            const refreshFamily =
              familyPath &&
              request.model === 'oauthRefreshToken' &&
              method === 'deleteMany' &&
              where.some((condition) => condition.field === 'clientId') &&
              where.some((condition) => condition.field === 'userId')
            const familyAccessTokens =
              familyPath &&
              request.model === 'oauthAccessToken' &&
              method === 'deleteMany' &&
              where.some(
                (condition) => condition.field === 'refreshId' && condition.operator === 'in',
              )
            // Native key endpoints also bulk-delete expired keys across the instance.
            // Expiry housekeeping is not a user management action; audit only the target.
            const relevant =
              (request.model === 'apikey' &&
                ((path === '/api-key/create' && method === 'create') ||
                  (['/api-key/update', '/api-key/delete'].includes(path) &&
                    ['update', 'delete'].includes(method) &&
                    where.some(
                      (condition) =>
                        condition.field === 'id' && sameId(condition.value, endpoint?.body?.keyId),
                    )))) ||
              (request.model === 'oauthClient' && method === 'create') ||
              (request.model === 'oauthConsent' && (method === 'create' || method === 'update')) ||
              refreshFamily ||
              (['oauthRefreshToken', 'oauthAccessToken'].includes(request.model) &&
                path === '/oauth2/revoke' &&
                !familyAccessTokens) ||
              (request.model === 'session' &&
                ['delete', 'deleteMany', 'consumeOne'].includes(method) &&
                [
                  '/revoke-session',
                  '/revoke-sessions',
                  '/revoke-other-sessions',
                  '/sign-out',
                ].includes(path)) ||
              (request.model === 'account' && (path === '/unlink-account' || method === 'create'))
            if (familyAccessTokens && !inTransaction && endpoint) {
              // Better Auth deletes these on the base adapter, committed on their own just
              // before the refresh tokens. Run the deletion inside the refresh tokens'
              // transaction instead, so the deletions and the family events commit together.
              // Never hold this connection while asking the pool for another.
              deferredFamilyAccessTokens.set(endpoint, request)
              return 0
            }
            if (!relevant) return (original as (r: unknown) => Promise<unknown>)(request)
            if (!inTransaction) {
              return ctx.adapter.transaction((trx) =>
                (trx[method] as (r: unknown) => Promise<unknown>)(request),
              )
            }
            const state = transactions.getStore()
            const trx = state?.trx
            if (!trx) throw new Error('Auth audit requires the native transaction')
            try {
              const selectedRows = async () => {
                const rows: Row[] = []
                for (let offset = 0; ; offset += 100) {
                  const page = await adapter.findMany<Row>({
                    model: request.model,
                    where: request.where as Parameters<
                      DBTransactionAdapter['findMany']
                    >[0]['where'],
                    limit: 100,
                    offset,
                    sortBy: { field: 'id', direction: 'asc' },
                  })
                  rows.push(...page)
                  if (page.length < 100)
                    return [...new Map(rows.map((row) => [row.id, row])).values()]
                }
              }
              let before = method === 'create' ? [] : await selectedRows()
              // When resource handlers are enabled, a lifecycle write can revoke keys even
              // for a team whose SCIM connection first appears during this request.
              const writesKeyBinding =
                request.model === 'apikey' &&
                (method === 'create' ||
                  (method === 'update' && Object.hasOwn((request.update ?? {}) as Row, 'metadata')))
              const lockKeyOrganizations =
                request.model === 'apikey' && (scimResourcesEnabled || writesKeyBinding)
              const proposedKey = lockKeyOrganizations
                ? ((request.data ?? request.update) as Row | undefined)
                : undefined
              const keyTarget = keyOrganization(proposedKey)
              const keyOrganizations = new Set<string>()
              if (lockKeyOrganizations) {
                if (keyTarget) keyOrganizations.add(keyTarget)
                for (const row of before) {
                  const source = keyOrganization(row)
                  if (source) keyOrganizations.add(source)
                }
                if (keyOrganizations.size) {
                  // A move touches both teams. Lock them in ID order before the key row,
                  // matching SCIM suspension and SSO delegation changes.
                  await trx
                    .selectFrom('auth.organization')
                    .select('id')
                    .where('id', 'in', [...keyOrganizations])
                    .where(({ not, exists, selectFrom }) =>
                      not(
                        exists(
                          selectFrom('personal_organizations')
                            .select('organization_id')
                            .whereRef('organization_id', '=', 'auth.organization.id'),
                        ),
                      ),
                    )
                    .orderBy('id')
                    .forKeyShare()
                    .execute()
                }
              }
              if (before.length) {
                // Lock every candidate, then recheck selectors after concurrent mutations.
                await sql`SELECT id FROM ${sql.table(`auth.${request.model}`)}
                WHERE id IN (${sql.join(before.map((row) => String(row.id)))})
                ORDER BY id FOR UPDATE`.execute(trx)
                const lockedIds = new Set(before.map((row) => row.id))
                before = (await selectedRows()).filter((row) => lockedIds.has(row.id))
              }
              if (lockKeyOrganizations) {
                for (const row of before) {
                  const source = keyOrganization(row)
                  if (source && !keyOrganizations.has(source))
                    throw new APIError('CONFLICT', {
                      message: API_KEY_ORGANIZATION_CHANGED_MESSAGE,
                    })
                }
                if (keyTarget) {
                  const owner =
                    method === 'create' ? proposedKey?.referenceId : before[0]?.referenceId
                  // The membership hook ran before the lock. Take a fresh snapshot so a
                  // key cannot be created or moved into a team during its suspension.
                  if (typeof owner === 'string' && isUuid(owner)) {
                    const { suspended } = await trx
                      .selectNoFrom(
                        scimSuspended(keyTarget, owner, scimResourcesEnabled).as('suspended'),
                      )
                      .executeTakeFirstOrThrow()
                    if (suspended)
                      throw new APIError('FORBIDDEN', {
                        message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
                      })
                  }
                }
              }
              let keyCeiling: Awaited<ReturnType<typeof teamAuthorizationFacts>> | undefined
              if (writesKeyBinding && keyTarget) {
                const owner =
                  method === 'create' ? proposedKey?.referenceId : before[0]?.referenceId
                const source = keyOrganization(before[0])
                if (typeof owner === 'string' && isUuid(owner)) {
                  // Recheck live membership after both organization locks and the key lock.
                  const membership = await trx
                    .selectFrom('auth.member')
                    .select('id')
                    .where('organizationId', '=', keyTarget)
                    .where('userId', '=', owner)
                    .executeTakeFirst()
                  if (!membership)
                    throw new APIError('FORBIDDEN', {
                      message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
                    })
                  if (method === 'update' && source !== keyTarget) {
                    const boundary = await trx
                      .selectFrom('team_member_authorizations')
                      .select('member_id')
                      .where('user_id', '=', owner)
                      .where('generation', '>', 1)
                      .where('organization_id', 'in', source ? [source, keyTarget] : [keyTarget])
                      .executeTakeFirst()
                    const pinned =
                      before[0] &&
                      (await trx
                        .selectFrom('team_credential_authorizations')
                        .select('id')
                        .where('api_key_id', '=', String(before[0].id))
                        .executeTakeFirst())
                    if (pinned || boundary)
                      throw new APIError('CONFLICT', {
                        message: API_KEY_ORGANIZATION_CHANGED_MESSAGE,
                      })
                  }
                  if (method === 'create') {
                    const affected = await trx
                      .selectFrom('team_member_authorizations')
                      .select('generation')
                      .where('member_id', '=', membership.id)
                      .where('generation', '>', 1)
                      .executeTakeFirst()
                    if (affected) {
                      const master = await lockCustomRoleMaster(trx)
                      const headers = endpoint?.request?.headers
                      const reviewed = headers?.get(TEAM_AUTHORIZATION_REVIEW_HEADER)
                      const session = endpoint?.context.session
                      const facts =
                        master &&
                        (await teamAuthorizationFacts(
                          trx,
                          keyTarget,
                          owner,
                          customRolesEnabled,
                          scimResourcesEnabled,
                        ))
                      if (
                        !facts ||
                        !reviewed ||
                        !session ||
                        headers?.get('origin') !== new URL(endpoint.context.baseURL).origin ||
                        !(await currentSessionTeamCeiling(trx, facts, session.session.id, reviewed))
                      )
                        throw new APIError('FORBIDDEN', {
                          message: API_KEY_TEAM_AUTHORIZATION_REVIEW_MESSAGE,
                        })
                      keyCeiling = facts
                    }
                  }
                }
              }
              const presented =
                refreshFamily && endpoint ? presentedRefreshTokens.get(endpoint) : undefined
              if (
                endpoint &&
                presented &&
                where.some(
                  (condition) =>
                    condition.field === 'clientId' && condition.value === presented.clientId,
                ) &&
                !before.some((row) => sameId(row.id, presented.id))
              ) {
                // SCIM removed the presented token while the provider was using it.
                // The provider will refuse it, but its fallback family deletion
                // would also revoke tokens for the client's surviving grants.
                deferredFamilyAccessTokens.delete(endpoint)
                return 0
              }
              // Bind mutation to the locked snapshot. A session created concurrently after
              // that snapshot must not be deleted without its own audit event.
              const actualRequest =
                method === 'create'
                  ? request
                  : {
                      ...request,
                      where: [
                        ...((request.where as unknown[]) ?? []),
                        {
                          field: 'id',
                          operator: 'in',
                          value: before.length
                            ? before.map((row) => row.id)
                            : ['00000000-0000-0000-0000-000000000000'],
                        },
                      ],
                    }
              const deferred = refreshFamily && endpoint && deferredFamilyAccessTokens.get(endpoint)
              if (deferred && endpoint) {
                deferredFamilyAccessTokens.delete(endpoint)
                await (original as (r: unknown) => Promise<unknown>)(deferred)
              }
              const result = await (original as (r: unknown) => Promise<unknown>)(actualRequest)
              if (refreshFamily) {
                if (!before.length) return result
                if (!presented) throw new Error('OAuth family audit requires the presented token')
                const clientId = String(before[0]?.clientId)
                // Better Auth wipes the presenting client's family even when the revoked token
                // belongs to another client. That token's grant then lost nothing and its
                // organization gets no event naming this client.
                const presentedGrant =
                  presented.clientId === clientId &&
                  before.some((row) => sameId(row.referenceId, presented.referenceId))
                    ? String(presented.referenceId)
                    : undefined
                // The presented grant is the target and credential. Other grants of the same
                // client and user lose their tokens too; their organizations get their own
                // event without the presenting grant, because it may belong to another tenant.
                const grants = [
                  ...(presentedGrant ? [presentedGrant] : []),
                  ...new Set(
                    before
                      .map((row) => String(row.referenceId))
                      .filter((grantId) => !presentedGrant || !sameId(grantId, presentedGrant)),
                  ),
                ]
                for (const grantId of grants) {
                  const grant = await trx
                    .selectFrom('mcp_oauth_grants')
                    .select('organization_id')
                    .where('id', '=', grantId)
                    .executeTakeFirst()
                  await writeAuditEvent(trx, {
                    organizationId: grant?.organization_id ?? null,
                    actor: { type: 'oauth_client', id: clientId },
                    credential:
                      grantId === presentedGrant
                        ? { type: 'oauth', clientId, grantId }
                        : { type: 'none' },
                    action: 'oauth.token_revoked',
                    targetType: 'oauth_grant',
                    targetId: grantId,
                    details: { familySize: before.length },
                  })
                }
                return result
              }
              const rows = method === 'create' ? [result as Row] : before
              for (const row of rows) {
                if (!row) continue
                const session = endpoint?.context.session
                const userId = session?.user.id
                let organizationId: string | null = null
                let action: Parameters<typeof writeAuditEvent>[1]['action']
                let details: Record<string, unknown> = {}
                let targetType = request.model
                let targetId = String(row.id)
                if (request.model === 'apikey') {
                  const raw = row.metadata
                  const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw
                  organizationId = metadata?.organizationId ?? null
                  if (!organizationId) {
                    const personal = await trx
                      .selectFrom('personal_organizations')
                      .select('organization_id')
                      .where('user_id', '=', String(row.referenceId))
                      .executeTakeFirstOrThrow()
                    organizationId = personal.organization_id
                  }
                  const patch = request.update as Row | undefined
                  if (method === 'update' && result && patch && Object.hasOwn(patch, 'metadata')) {
                    const rawUpdated = (result as Row).metadata
                    const updated =
                      typeof rawUpdated === 'string' ? JSON.parse(rawUpdated) : rawUpdated
                    if (!sameId(organizationId, updated?.organizationId)) {
                      // The adapter has locked the key. Any bind that won that lock has
                      // committed, and any later bind must recheck the new organization.
                      const binding = await trx
                        .deleteFrom('sso_delegation_bindings')
                        .where('api_key_id', '=', targetId)
                        .returning(['id', 'organization_id', 'provider_id'])
                        .executeTakeFirst()
                      if (binding) {
                        const provider = await trx
                          .selectFrom('sso_providers')
                          .select(['protocol', 'revision'])
                          .where('id', '=', binding.provider_id)
                          .where('organization_id', '=', binding.organization_id)
                          .executeTakeFirstOrThrow()
                        await writeSsoAuditEvent(trx, {
                          organizationId: binding.organization_id,
                          actor: userId
                            ? { type: 'user', id: userId }
                            : { type: 'system', id: 'auth' },
                          credential: session
                            ? { type: 'session', id: session.session.id }
                            : { type: 'none' },
                          action: 'sso_delegation.revoked',
                          targetType: 'sso_delegation',
                          targetId: binding.id,
                          details: {
                            method: z.enum(['oidc', 'saml']).parse(provider.protocol),
                            providerId: binding.provider_id,
                            revision: provider.revision,
                            reason: 'key_moved_team',
                          },
                        })
                      }
                    }
                  }
                  action =
                    method === 'create'
                      ? 'api_key.created'
                      : method === 'delete' ||
                          (request.update as Row | undefined)?.enabled === false
                        ? 'api_key.revoked'
                        : (request.update as Row | undefined)?.enabled === true &&
                            row.enabled === false
                          ? 'api_key.reenabled'
                          : 'api_key.updated'
                  if (method === 'create') {
                    const scope = metadata?.scope ?? 'full'
                    details = { scope }
                    if (keyCeiling && isApiKeyScope(scope)) {
                      await trx
                        .insertInto('team_credential_authorizations')
                        .values({
                          ...keyCeiling.ceiling,
                          api_key_id: targetId,
                          permission_ids: customCredentialPermissions(keyCeiling, scope),
                        })
                        .execute()
                    }
                  }
                } else if (request.model === 'oauthClient') {
                  action = 'oauth.client_registered'
                  targetId = String(row.clientId)
                } else if (
                  request.model === 'oauthConsent' ||
                  request.model === 'oauthRefreshToken' ||
                  request.model === 'oauthAccessToken'
                ) {
                  const grant = await trx
                    .selectFrom('mcp_oauth_grants')
                    .select('organization_id')
                    .where('id', '=', String(row.referenceId))
                    .executeTakeFirst()
                  if (!grant && request.model === 'oauthConsent')
                    throw new Error('OAuth consent audit requires its organization grant')
                  // Browser disconnect deletes the grant before a client can revoke its
                  // already revoked refresh token. Preserve native family invalidation.
                  organizationId = grant?.organization_id ?? null
                  action =
                    request.model === 'oauthConsent'
                      ? 'oauth.consent_granted'
                      : 'oauth.token_revoked'
                  targetId = String(row.referenceId)
                  targetType = 'oauth_grant'
                } else {
                  const personal = await trx
                    .selectFrom('personal_organizations')
                    .select('organization_id')
                    .where('user_id', '=', String(row.userId))
                    .executeTakeFirst()
                  // Initial signup has no organization yet; it is not a method change.
                  if (!personal && request.model === 'account' && method === 'create') continue
                  if (!personal) throw new Error('Auth audit requires a personal organization')
                  organizationId = personal.organization_id
                  action =
                    request.model === 'session'
                      ? 'session.revoked'
                      : method === 'create'
                        ? 'sign_in_method.added'
                        : 'sign_in_method.removed'
                }
                try {
                  await writeAuditEvent(trx, {
                    organizationId,
                    actor:
                      request.model === 'oauthRefreshToken' || request.model === 'oauthAccessToken'
                        ? { type: 'oauth_client', id: String(row.clientId) }
                        : userId
                          ? { type: 'user', id: userId }
                          : request.model === 'oauthClient'
                            ? { type: 'anonymous' }
                            : request.model === 'account'
                              ? { type: 'user', id: String(row.userId) }
                              : { type: 'system', id: 'auth' },
                    credential:
                      request.model === 'oauthRefreshToken' || request.model === 'oauthAccessToken'
                        ? {
                            type: 'oauth',
                            clientId: String(row.clientId),
                            grantId: String(row.referenceId),
                          }
                        : session
                          ? { type: 'session', id: session.session.id }
                          : { type: 'none' },
                    action,
                    targetType,
                    targetId,
                    details,
                  })
                } catch (error) {
                  // Native sign-out catches database errors; never turn an audit failure into success.
                  if (state) state.failure = error
                  throw error
                }
              }
              return result
            } catch (error) {
              if (state) state.failure = error
              throw error
            }
          }
          Object.assign(adapter, {
            [method]: (request: Parameters<typeof wrapped>[0]) => {
              const state = transactions.getStore()
              // Native delete hooks can still be finishing a pre-delete read when a
              // sibling fails. Never admit their later mutation after closing begins.
              if (state?.closing) return Promise.reject(new Error('Auth transaction is closing'))
              const pending = wrapped(request)
              if (state) {
                state.pending.add(pending)
                void pending.then(
                  () => state.pending.delete(pending),
                  () => state.pending.delete(pending),
                )
              }
              return pending
            },
          })
        }
        return adapter
      }
      wrap(ctx.adapter, false)
      const transaction = ctx.adapter.transaction
      ctx.adapter.transaction = (callback) => transaction((trx) => callback(wrap(trx, true)))
    },
  }
}
