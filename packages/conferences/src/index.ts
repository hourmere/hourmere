import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import {
  conferenceEncryptionKey,
  conferenceStateAad,
  decryptConferenceCredential,
  encryptConferenceCredential,
} from './credentials.ts'
import { clearConferenceConnection } from './disconnect.ts'
import { credentials, readTokens } from './tokens.ts'
import {
  matchingZoomScopes,
  refreshZoomTokens,
  type ZoomClient,
  ZoomError,
  type ZoomIdentity,
  type ZoomMode,
  type ZoomTokens,
} from './zoom.ts'

export { conferenceEncryptionKey } from './credentials.ts'
export { deauthorizeZoomConnections } from './deauthorization.ts'
export { createZoomClient, ZOOM_CALLBACK, ZOOM_SCOPE, ZoomError } from './zoom.ts'
export const MAX_ZOOM_CONNECTIONS = 5
const STATE_LIFETIME = 10 * 60_000
export interface ConferenceDeps {
  db: Db
  zoom?: { client: ZoomClient; encryptionKey: string; meetingsEnabled?: boolean } | undefined
  now?: () => number
  timeoutMs?: number
}
type Session = Extract<Principal, { kind: 'session' }>
export function requireConferenceSession(principal: Principal): Session {
  if (principal.kind !== 'session')
    throw new DomainError(
      'forbidden',
      'conference_session_required',
      'Sign in to manage conference accounts.',
    )
  return principal
}
const clock = (deps: ConferenceDeps) => (deps.now ?? Date.now)()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = () =>
  new DomainError(
    'not_found',
    'zoom_connection_not_found',
    'This Zoom connection is not available.',
  )
const reauth = () =>
  new DomainError(
    'conflict',
    'zoom_needs_reauth',
    'Reconnect this Zoom account before refreshing it.',
  )
const limit = () =>
  new DomainError(
    'conflict',
    'zoom_connection_limit',
    'This account has reached its limit of five connected Zoom identities.',
  )
async function atConnectionLimit(db: Db, owner: string) {
  const rows = await db
    .selectFrom('conference_connections')
    .select('id')
    .where('user_id', '=', owner)
    .where('status', '!=', 'disconnected')
    .limit(MAX_ZOOM_CONNECTIONS)
    .execute()
  return rows.length >= MAX_ZOOM_CONNECTIONS
}
function configured(deps: ConferenceDeps) {
  if (!deps.zoom)
    throw new DomainError(
      'conflict',
      'zoom_disabled',
      'Zoom connections are not configured on this instance.',
    )
  return { client: deps.zoom.client, key: conferenceEncryptionKey(deps.zoom.encryptionKey) }
}
/** Every public operation locks the owner first. Session/connection/state locks follow it.
 * Provider exchanges also run under that owner lock, with one bounded deadline. */
async function lockSession(db: Db, session: Session, now: number) {
  const user = await db
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', session.user.id)
    .forUpdate()
    .executeTakeFirst()
  const current = await db
    .selectFrom('auth.session')
    .select('id')
    .where('id', '=', session.sessionId)
    .where('userId', '=', session.user.id)
    .where('expiresAt', '>', new Date(now))
    .forUpdate()
    .executeTakeFirst()
  if (!user || !current)
    throw new DomainError(
      'forbidden',
      'conference_session_required',
      'Sign in again to manage conference accounts.',
    )
}
async function sessionAlive(db: Db, session: Session, now: number) {
  return !!(await db
    .selectFrom('auth.session')
    .select('id')
    .where('id', '=', session.sessionId)
    .where('userId', '=', session.user.id)
    .where('expiresAt', '>', new Date(now))
    .executeTakeFirst())
}
function owned<T>(
  deps: ConferenceDeps,
  session: Session,
  body: (db: Db) => Promise<T>,
): Promise<T> {
  return deps.db.transaction().execute(async (db) => {
    await lockSession(db, session, clock(deps))
    return body(db)
  })
}
export async function listConferenceConnections(deps: ConferenceDeps, principal: Principal) {
  return deps.db.transaction().execute(async (db) => {
    if (principal.kind === 'session') await lockSession(db, principal, clock(deps))
    else {
      const user = await db
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', principal.user.id)
        .where('emailVerified', '=', true)
        .forUpdate()
        .executeTakeFirst()
      if (!user)
        throw new DomainError(
          'forbidden',
          'conference_access_denied',
          'This account is unavailable.',
        )
    }
    const member = await db
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', principal.user.id)
      .where('organizationId', '=', principal.organization.id)
      .forShare()
      .executeTakeFirst()
    if (!member)
      throw new DomainError(
        'forbidden',
        'conference_access_denied',
        'This organization is unavailable.',
      )
    const rows = await db
      .selectFrom('conference_connections')
      .select([
        'id',
        'provider',
        'mode',
        'account_email',
        'display_name',
        'status',
        'last_error',
        'created_at',
        'updated_at',
      ])
      .where('user_id', '=', principal.user.id)
      .where('status', '!=', 'disconnected')
      .orderBy('created_at')
      .orderBy('id')
      .limit(MAX_ZOOM_CONNECTIONS)
      .execute()
    const attempts =
      principal.kind === 'session'
        ? await db
            .selectFrom('conference_oauth_states')
            .select('state_hash')
            .where('user_id', '=', principal.user.id)
            .where('session_id', '=', principal.sessionId)
            .where('binding_version', '=', 2)
            .where('expires_at', '>', new Date(clock(deps)))
            .limit(5)
            .execute()
        : []
    return {
      zoomEnabled: !!deps.zoom,
      zoomMeetingsEnabled: deps.zoom?.meetingsEnabled === true,
      pendingAttempts: attempts.length,
      maximumConnections: MAX_ZOOM_CONNECTIONS,
      data: rows.map((row) => ({
        id: row.id,
        provider: 'zoom' as const,
        mode: row.mode as ZoomMode,
        accountEmail: row.account_email,
        displayName: row.display_name,
        status: row.status as 'active' | 'refreshing' | 'needs_reauth' | 'disconnected',
        lastError: row.last_error,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    }
  })
}
export function beginZoomConnection(deps: ConferenceDeps, principal: Principal, id?: string) {
  return beginConnection(deps, principal, id)
}
/** A distinct caller action, never an environment-driven widening of identity consent. */
export async function authorizeZoomMeetings(
  deps: ConferenceDeps,
  principal: Principal,
  id?: string,
) {
  requireConferenceSession(principal)
  if (!deps.zoom?.meetingsEnabled)
    throw new DomainError(
      'conflict',
      'zoom_meetings_disabled',
      'Automatic Zoom meetings are disabled on this instance.',
    )
  return beginConnection(deps, principal, id, 'meetings')
}
async function beginConnection(
  deps: ConferenceDeps,
  principal: Principal,
  id?: string,
  requestedMode?: ZoomMode,
) {
  const session = requireConferenceSession(principal),
    { client, key } = configured(deps)
  if (id !== undefined && !z.uuid().safeParse(id).success) throw missing()
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(32).toString('base64url'),
    hash = digest(state)
  const mode = await owned(deps, session, async (db) => {
    let mode: ZoomMode = requestedMode ?? 'identity'
    if (id) {
      const row = await db
        .selectFrom('conference_connections')
        .select(['id', 'status', 'mode'])
        .where('id', '=', id)
        .where('user_id', '=', session.user.id)
        .forUpdate()
        .executeTakeFirst()
      if (!row) throw missing()
      mode = requestedMode ?? (row.mode as ZoomMode)
      if (row.status === 'disconnected' && (await atConnectionLimit(db, session.user.id)))
        throw limit()
      // Explicit reconnection replaces existing access and invalidates an unfinished refresh.
      await db
        .updateTable('conference_connections')
        .set({ credentials: null, operation_id: null, status: 'needs_reauth', last_error: null })
        .where('id', '=', id)
        .execute()
    } else if (await atConnectionLimit(db, session.user.id)) throw limit()
    await db
      .deleteFrom('conference_oauth_states')
      .where('user_id', '=', session.user.id)
      .where('expires_at', '<=', new Date(clock(deps)))
      .execute()
    if (id)
      await db
        .deleteFrom('conference_oauth_states')
        .where('user_id', '=', session.user.id)
        .where('connection_id', '=', id)
        .execute()
    const old = await db
      .selectFrom('conference_oauth_states')
      .select('state_hash')
      .where('user_id', '=', session.user.id)
      .orderBy('created_at', 'desc')
      .orderBy('state_hash')
      .offset(4)
      .execute()
    if (old.length)
      await db
        .deleteFrom('conference_oauth_states')
        .where(
          'state_hash',
          'in',
          old.map((row) => row.state_hash),
        )
        .execute()
    await db
      .insertInto('conference_oauth_states')
      .values({
        state_hash: hash,
        user_id: session.user.id,
        session_id: session.sessionId,
        connection_id: id ?? null,
        mode,
        binding_version: 2,
        verifier: encryptConferenceCredential(
          key,
          conferenceStateAad(session.user.id, hash, session.sessionId, mode, id ?? null),
          verifier,
        ),
        expires_at: new Date(clock(deps) + STATE_LIFETIME),
      })
      .execute()
    return mode
  })
  return { authorizationUrl: client.authorizationUrl(state, verifier, mode) }
}
export type ZoomOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_state'
  | 'disabled'
  | 'provider_unavailable'
  | 'needs_reauth'
  | 'permissions_missing'
  | 'identity_mismatch'
  | 'account_in_use'
  | 'connection_limit'
  | 'mode_conflict'
/** Durable one-use claim precedes I/O. A failed commit cannot make a code redeemable again. */
export async function finishZoomConnection(
  deps: ConferenceDeps,
  principal: Principal,
  query: URLSearchParams,
): Promise<ZoomOutcome> {
  const session = requireConferenceSession(principal)
  if (!deps.zoom) return 'disabled'
  const { client, key } = configured(deps),
    state = query.get('state')
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || query.getAll('state').length !== 1)
    return 'invalid_state'
  const hash = digest(state)
  const attempt = await owned(deps, session, async (db) => {
    const row = await db
      .selectFrom('conference_oauth_states')
      .select(['verifier', 'connection_id', 'mode'])
      .where('state_hash', '=', hash)
      .where('user_id', '=', session.user.id)
      .where('session_id', '=', session.sessionId)
      .where('claimed', '=', false)
      .where('binding_version', '=', 2)
      .where('expires_at', '>', new Date(clock(deps)))
      .forUpdate()
      .executeTakeFirst()
    if (!row?.verifier) return undefined
    await db
      .updateTable('conference_oauth_states')
      .set({ claimed: true, verifier: null })
      .where('state_hash', '=', hash)
      .execute()
    return row
  })
  if (!attempt?.verifier) return 'invalid_state'
  try {
    return await owned(deps, session, async (db) => {
      const valid = await db
        .selectFrom('conference_oauth_states')
        .select(['connection_id', 'mode', 'binding_version'])
        .where('state_hash', '=', hash)
        .where('user_id', '=', session.user.id)
        .where('session_id', '=', session.sessionId)
        .where('claimed', '=', true)
        .where('expires_at', '>', new Date(clock(deps)))
        .forUpdate()
        .executeTakeFirst()
      if (
        valid?.binding_version !== 2 ||
        valid.mode !== attempt.mode ||
        valid.connection_id !== attempt.connection_id
      )
        return 'invalid_state'
      await db.deleteFrom('conference_oauth_states').where('state_hash', '=', hash).execute()
      const keys = [...query.keys()]
      if (
        query.toString().length > 8192 ||
        keys.some(
          (k) =>
            !['state', 'code', 'error', 'error_description'].includes(k) ||
            query.getAll(k).length !== 1,
        )
      )
        return 'invalid_state'
      if (query.has('error'))
        return query.get('error') === 'access_denied' && !query.has('code')
          ? 'denied'
          : 'provider_unavailable'
      const code = query.get('code')
      if (!code || code.length > 4096 || !isSingleLineText(code) || /\s/u.test(code))
        return 'invalid_state'
      try {
        const signal = AbortSignal.timeout(deps.timeoutMs ?? 15000),
          mode = attempt.mode as ZoomMode
        const verifier = decryptConferenceCredential(
          key,
          conferenceStateAad(session.user.id, hash, session.sessionId, mode, attempt.connection_id),
          attempt.verifier as Buffer,
        )
        const tokens = await client.exchange(code, verifier, signal, mode)
        if (!matchingZoomScopes(tokens.scopes, mode)) throw new ZoomError('permissions_missing')
        const identity = await client.identity(tokens.accessToken, signal)
        if (!(await sessionAlive(db, session, clock(deps)))) return 'invalid_state'
        const previous = await db
          .selectFrom('conference_connections')
          .select(['id', 'user_id', 'external_user_id', 'status', 'mode'])
          .where('provider', '=', 'zoom')
          .where('external_user_id', '=', identity.id)
          .forUpdate()
          .executeTakeFirst()
        if (previous && previous.user_id !== session.user.id) return 'account_in_use'
        if (
          previous?.mode === 'meetings' &&
          previous.status !== 'disconnected' &&
          mode === 'identity'
        ) {
          // A wrong-mode reconsent can rotate/revoke the external grant. Keep stronger local
          // intent but never pretend its old credentials remain safe or silently downgrade.
          await db
            .updateTable('conference_connections')
            .set({
              credentials: null,
              operation_id: null,
              status: 'needs_reauth',
              last_error: 'mode_conflict',
            })
            .where('id', '=', previous.id)
            .execute()
          return 'mode_conflict'
        }
        if (valid.connection_id && previous?.id !== valid.connection_id) return 'identity_mismatch'
        if (
          (!previous || previous.status === 'disconnected') &&
          (await atConnectionLimit(db, session.user.id))
        )
          return 'connection_limit'
        const id = previous?.id ?? randomUUID(),
          value = {
            account_email: identity.email,
            display_name: identity.name,
            credentials: credentials(key, session.user.id, id, identity.id, tokens, mode),
            operation_id: null,
            scopes: tokens.scopes,
            mode,
            status: 'active',
            last_error: null,
          }
        if (previous)
          await db.updateTable('conference_connections').set(value).where('id', '=', id).execute()
        else {
          const inserted = await db
            .insertInto('conference_connections')
            .values({
              id,
              user_id: session.user.id,
              provider: 'zoom',
              external_user_id: identity.id,
              ...value,
            })
            .onConflict((oc) => oc.columns(['provider', 'external_user_id']).doNothing())
            .returning('id')
            .executeTakeFirst()
          if (!inserted) return 'account_in_use'
        }
        return 'connected'
      } catch (error) {
        return error instanceof ZoomError ? error.code : 'provider_unavailable'
      }
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'conference_session_required')
      return 'invalid_state'
    // The durable claimed row stays unusable even if the database commit failed.
    return 'provider_unavailable'
  }
}
export async function disconnectConference(deps: ConferenceDeps, principal: Principal, id: string) {
  const session = requireConferenceSession(principal)
  if (!z.uuid().safeParse(id).success) throw missing()
  await owned(deps, session, async (db) => {
    const row = await db
      .selectFrom('conference_connections')
      .select('id')
      .where('id', '=', id)
      .where('user_id', '=', session.user.id)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw missing()
    await clearConferenceConnection(db, session.user.id, id)
  })
}
/** Clear old credentials in a committed claim before contacting a rotating-token endpoint.
 * Phase two uses the same owner-first lock protocol for provider I/O and final storage.
 * Retryable/provider response failures preserve the prior grant for later recovery;
 * a crash or failed final commit leaves the durable refresh claim incomplete. */
export async function refreshConference(deps: ConferenceDeps, principal: Principal, id: string) {
  const session = requireConferenceSession(principal),
    { client, key } = configured(deps)
  if (!z.uuid().safeParse(id).success) throw missing()
  const operation = randomUUID()
  const claim = await owned(deps, session, async (db) => {
    const row = await db
      .selectFrom('conference_connections')
      .select(['id', 'status', 'external_user_id', 'credentials', 'scopes', 'mode'])
      .where('id', '=', id)
      .where('user_id', '=', session.user.id)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw missing()
    if (row.status !== 'active' || !row.credentials || !row.external_user_id) return undefined
    try {
      if (!matchingZoomScopes(row.scopes, row.mode)) throw new ZoomError('permissions_missing')
      const tokens = readTokens(
        key,
        session.user.id,
        id,
        row.external_user_id,
        row.credentials,
        row.mode as ZoomMode,
      )
      await db
        .updateTable('conference_connections')
        .set({ credentials: null, operation_id: operation, status: 'refreshing', last_error: null })
        .where('id', '=', id)
        .execute()
      return {
        tokens,
        original: row.credentials,
        external: row.external_user_id,
        mode: row.mode as ZoomMode,
      }
    } catch (error) {
      if (!(error instanceof ZoomError)) throw error
      await db
        .updateTable('conference_connections')
        .set({
          credentials: null,
          operation_id: null,
          status: 'needs_reauth',
          last_error: 'credentials_unavailable',
        })
        .where('id', '=', id)
        .execute()
      return undefined
    }
  })
  if (!claim) throw reauth()
  let outcome: string
  try {
    outcome = await owned(deps, session, async (db) => {
      const row = await db
        .selectFrom('conference_connections')
        .select('id')
        .where('id', '=', id)
        .where('user_id', '=', session.user.id)
        .where('status', '=', 'refreshing')
        .where('operation_id', '=', operation)
        .forUpdate()
        .executeTakeFirst()
      if (!row) return 'needs_reauth'
      let tokens: ZoomTokens | undefined,
        recoverable = false,
        identity: ZoomIdentity | undefined,
        errorCode: string | null = null
      try {
        const signal = AbortSignal.timeout(deps.timeoutMs ?? 15000)
        tokens = await refreshZoomTokens(
          () => client.refresh(claim.tokens.refreshToken, signal, claim.mode),
          signal,
        )
        if (!matchingZoomScopes(tokens.scopes, claim.mode)) {
          tokens = undefined
          throw new ZoomError('permissions_missing')
        }
        identity = await client.identity(tokens.accessToken, signal)
        if (identity.id !== claim.external) {
          tokens = undefined
          errorCode = 'identity_mismatch'
        }
      } catch (error) {
        errorCode = error instanceof ZoomError ? error.code : 'provider_unavailable'
        recoverable = !tokens && error instanceof ZoomError && error.code === 'provider_unavailable'
        // Keep a known rotated grant after transient metadata failure; a missing grant does
        // not prove revocation, so preserve the previous credential for later recovery.
        if (errorCode !== 'provider_unavailable') tokens = undefined
      }
      if (!(await sessionAlive(db, session, clock(deps)))) {
        tokens = undefined
        recoverable = false
        errorCode = 'needs_reauth'
      }
      await db
        .updateTable('conference_connections')
        .set({
          credentials: tokens
            ? credentials(key, session.user.id, id, claim.external, tokens, claim.mode)
            : recoverable
              ? claim.original
              : null,
          operation_id: null,
          status: tokens || recoverable ? 'active' : 'needs_reauth',
          last_error: errorCode,
          ...(tokens && { scopes: tokens.scopes }),
          ...(tokens && identity && { account_email: identity.email, display_name: identity.name }),
        })
        .where('id', '=', id)
        .execute()
      return errorCode ?? 'ok'
    })
  } catch {
    throw new DomainError(
      'conflict',
      'zoom_refresh_incomplete',
      'This refresh could not be confirmed. Reconnect the Zoom account.',
    )
  }
  if (outcome !== 'ok')
    throw new DomainError(
      'conflict',
      `zoom_${outcome}`,
      'Zoom account refresh failed. Check the connection status before trying again.',
    )
}
