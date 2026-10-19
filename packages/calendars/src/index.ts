import { createHash, randomBytes } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { sql } from 'kysely'
import { z } from 'zod'
import { calendarEncryptionKey, decryptCredential, encryptCredential } from './credentials.ts'
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_CALENDAR_SYNC_SCOPES,
  type GoogleCalendarClient,
  GoogleCalendarError,
} from './google.ts'
import {
  hasMicrosoftCalendarListAccess,
  type MicrosoftCalendarClient,
  MicrosoftCalendarError,
} from './microsoft.ts'
import {
  type CalendarProvider,
  CalendarProviderError,
  type CalendarTokens,
  type ProviderCalendar,
} from './provider.ts'

export { calendarBookingNotifier, redispatchBookingCalendar } from './booking-events.ts'
export { calendarEncryptionKey } from './credentials.ts'
export {
  createGoogleCalendarClient,
  GOOGLE_CALENDAR_CALLBACK,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_CALENDAR_SYNC_SCOPES,
} from './google.ts'
export {
  bookingCalendarJob,
  bookingCalendarRecoveryJob,
  calendarDispatchJob,
  calendarSyncJob,
} from './jobs.ts'
export {
  createMicrosoftCalendarClient,
  MICROSOFT_CALENDAR_CALLBACK,
  MICROSOFT_CALENDAR_SCOPES,
} from './microsoft.ts'
export {
  configureCalendar,
  setCalendarDestination,
  syncGoogleCalendar,
  syncOwnedCalendar,
} from './sync.ts'

type SessionPrincipal = Extract<Principal, { kind: 'session' }>
export function requireCalendarSession(principal: Principal): SessionPrincipal {
  if (principal.kind !== 'session')
    throw new DomainError(
      'forbidden',
      'session_required',
      'Sign in to manage calendar connections.',
    )
  return principal
}

export interface CalendarDeps {
  zoomConferenceWork?:
    | ((
        claim: import('@hourmere/scheduling/conferences').ConferenceWork,
        signal: AbortSignal,
      ) => Promise<import('@hourmere/scheduling/conferences').ConferenceResult>)
    | undefined
  db: Db
  google?: { client: GoogleCalendarClient; encryptionKey: string } | undefined
  microsoft?: { client: MicrosoftCalendarClient; encryptionKey: string } | undefined
  now?: () => number
  enqueueSync?: ((calendarId: string, transaction: Db) => Promise<unknown>) | undefined
  enqueueWritebackRecovery?:
    | ((connectionId: string, transaction: Db) => Promise<unknown>)
    | undefined
}
const storedTokens = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().finite().positive(),
})
type StoredTokens = z.infer<typeof storedTokens>
const digest = (state: string) => createHash('sha256').update(state).digest('hex')
export const tokenAad = (user: string, account: string, provider: CalendarProvider = 'google') =>
  `${provider}:${user}:${account}`
const stateAad = (user: string, session: string, hash: string, provider: CalendarProvider) =>
  `${provider === 'google' ? 'state' : 'microsoft:state'}:${user}:${session}:${hash}`
const notFound = () =>
  new DomainError(
    'not_found',
    'calendar_connection_not_found',
    'This calendar connection no longer exists.',
  )
const invalidState = () =>
  new DomainError(
    'invalid',
    'invalid_oauth_state',
    'This connection attempt has expired or was already used. Start again.',
  )
const configured = (deps: CalendarDeps, provider: CalendarProvider = 'google') => {
  const config = provider === 'google' ? deps.google : deps.microsoft
  if (!config)
    throw new DomainError(
      'conflict',
      `${provider}_calendar_disabled`,
      `${provider === 'google' ? 'Google' : 'Microsoft'} Calendar is not configured on this instance.`,
    )
  return { client: config.client, key: calendarEncryptionKey(config.encryptionKey) }
}

/** All connection mutations lock the owner, including the final phase of a callback. */
export async function lockUser(
  db: Db,
  principal: Principal,
  now: number,
  mode: 'update' | 'key_share' = 'update',
) {
  const user = await db
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', principal.user.id)
    .$call((query) => (mode === 'key_share' ? query.forKeyShare() : query.forUpdate()))
    .executeTakeFirst()
  if (principal.kind !== 'session') {
    if (!user) throw notFound()
    return
  }
  const session = await db
    .selectFrom('auth.session')
    .select('id')
    .where('id', '=', principal.sessionId)
    .where('userId', '=', principal.user.id)
    .where('expiresAt', '>', new Date(now))
    .executeTakeFirst()
  if (!user || !session)
    throw new DomainError(
      'forbidden',
      'session_required',
      'Sign in again to manage calendar connections.',
    )
}

export function readTokens(
  key: Buffer,
  user: string,
  account: string,
  credentials: Buffer,
  provider: CalendarProvider = 'google',
): StoredTokens {
  try {
    return storedTokens.parse(
      JSON.parse(decryptCredential(key, tokenAad(user, account, provider), credentials)),
    )
  } catch {
    throw new Error('Stored calendar credentials are invalid')
  }
}
function requireScopes(
  scopes: string[] | undefined,
  access = 'list',
  provider: CalendarProvider = 'google',
): asserts scopes is string[] {
  if (provider === 'microsoft') {
    if (access !== 'list' || !hasMicrosoftCalendarListAccess(scopes))
      throw new MicrosoftCalendarError('permissions_missing')
    return
  }
  const required = access === 'sync' ? GOOGLE_CALENDAR_SYNC_SCOPES : GOOGLE_CALENDAR_SCOPES
  if (!scopes || !required.every((scope) => scopes.includes(scope)))
    throw new GoogleCalendarError('permissions_missing')
}

async function saveCalendars(db: Db, connectionId: string, calendars: ProviderCalendar[]) {
  if (calendars.length) {
    await db
      .insertInto('calendars')
      .values(
        calendars.map((calendar) => ({
          connection_id: connectionId,
          external_id: calendar.id,
          name: calendar.name,
          is_primary: calendar.isPrimary,
          access_role: calendar.accessRole,
          time_zone: calendar.timeZone,
          supports_google_meet: calendar.supportsGoogleMeet ?? false,
          // Connection/listing is not busy-time sync. Do not claim conflicts are checked yet.
          check_conflicts: false,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['connection_id', 'external_id']).doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          is_primary: eb.ref('excluded.is_primary'),
          access_role: eb.ref('excluded.access_role'),
          time_zone: eb.ref('excluded.time_zone'),
          supports_google_meet: eb.ref('excluded.supports_google_meet'),
        })),
      )
      .execute()
  }
  let removed = db.deleteFrom('calendars').where('connection_id', '=', connectionId)
  if (calendars.length)
    removed = removed.where(
      'external_id',
      'not in',
      calendars.map((c) => c.id),
    )
  await removed.execute()
}

export async function listCalendarConnections(deps: CalendarDeps, principal: Principal) {
  const profile = await deps.db
    .selectFrom('profiles')
    .select('destination_calendar_id')
    .where('user_id', '=', principal.user.id)
    .executeTakeFirst()
  const connections = await deps.db
    .selectFrom('calendar_connections')
    .select([
      'id',
      'provider',
      'account_email',
      'status',
      'last_error',
      'created_at',
      'updated_at',
      'scopes',
    ])
    .where('user_id', '=', principal.user.id)
    .where('provider', 'in', ['google', 'microsoft'])
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const calendars = connections.length
    ? await deps.db
        .selectFrom('calendars')
        .select([
          'id',
          'connection_id',
          'name',
          'is_primary',
          'check_conflicts',
          'access_role',
          'last_synced_at',
          'sync_error',
        ])
        .where(
          'connection_id',
          'in',
          connections.map((c) => c.id),
        )
        .orderBy('name')
        .orderBy('id')
        .execute()
    : []
  return {
    googleEnabled: deps.google !== undefined,
    microsoftEnabled: deps.microsoft !== undefined,
    destinationCalendarId: profile?.destination_calendar_id ?? null,
    data: connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider as CalendarProvider,
      accountEmail: connection.account_email,
      status: connection.status as 'active' | 'needs_reauth' | 'revoked',
      lastError: z
        .enum(['provider_unavailable', 'needs_reauth', 'permissions_missing'])
        .nullable()
        .catch(null)
        .parse(connection.last_error),
      createdAt: connection.created_at.toISOString(),
      updatedAt: connection.updated_at.toISOString(),
      syncAuthorized:
        connection.provider === 'google' &&
        GOOGLE_CALENDAR_SYNC_SCOPES.every((scope) => connection.scopes.includes(scope)),
      calendars: calendars
        .filter((c) => c.connection_id === connection.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          isPrimary: c.is_primary,
          checkConflicts: c.check_conflicts,
          accessRole: c.access_role,
          lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
          syncError: c.sync_error,
        })),
    })),
  }
}

export async function beginGoogleConnection(
  deps: CalendarDeps,
  principal: Principal,
  access: 'list' | 'sync' = 'list',
) {
  return beginConnection(deps, principal, access, 'google')
}

export async function beginMicrosoftConnection(deps: CalendarDeps, principal: Principal) {
  return beginConnection(deps, principal, 'list', 'microsoft')
}

async function beginConnection(
  deps: CalendarDeps,
  principal: Principal,
  access: 'list' | 'sync',
  provider: CalendarProvider,
) {
  if (access !== 'list' && access !== 'sync')
    throw new DomainError('invalid', 'invalid_calendar_access')
  const session = requireCalendarSession(principal)
  const { client, key } = configured(deps, provider)
  const now = (deps.now ?? Date.now)()
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const hash = digest(state)
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, now)
    await trx
      .deleteFrom('calendar_oauth_states')
      .where('user_id', '=', session.user.id)
      .where('expires_at', '<=', new Date(now))
      .execute()
    // Bound abandoned attempts per user, including attempts from other sessions.
    const old = await trx
      .selectFrom('calendar_oauth_states')
      .select('state_hash')
      .where('user_id', '=', session.user.id)
      .orderBy('created_at', 'desc')
      .orderBy('state_hash')
      .offset(4)
      .execute()
    if (old.length)
      await trx
        .deleteFrom('calendar_oauth_states')
        .where(
          'state_hash',
          'in',
          old.map((s) => s.state_hash),
        )
        .execute()
    await trx
      .insertInto('calendar_oauth_states')
      .values({
        state_hash: hash,
        user_id: session.user.id,
        session_id: session.sessionId,
        provider,
        verifier: encryptCredential(
          key,
          stateAad(session.user.id, session.sessionId, hash, provider),
          verifier,
        ),
        access,
        expires_at: new Date(now + 10 * 60_000),
      })
      .execute()
  })
  return { authorizationUrl: client.authorizationUrl(state, verifier, access) }
}

export type ConnectionOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_state'
  | 'permissions_missing'
  | 'needs_reauth'
  | 'provider_unavailable'

/** Claim once before network I/O; failure never makes a state redeemable again. */
export async function finishGoogleConnection(
  deps: CalendarDeps,
  principal: Principal,
  query: URLSearchParams,
): Promise<ConnectionOutcome> {
  return finishConnection(deps, principal, query, 'google')
}

export async function finishMicrosoftConnection(
  deps: CalendarDeps,
  principal: Principal,
  query: URLSearchParams,
): Promise<ConnectionOutcome> {
  return finishConnection(deps, principal, query, 'microsoft')
}

async function finishConnection(
  deps: CalendarDeps,
  principal: Principal,
  query: URLSearchParams,
  provider: CalendarProvider,
): Promise<ConnectionOutcome> {
  const session = requireCalendarSession(principal)
  const { client, key } = configured(deps, provider)
  const clock = deps.now ?? Date.now
  const state = query.get('state')
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || query.getAll('state').length !== 1)
    return 'invalid_state'
  const hash = digest(state)
  const attempt = await deps.db
    .updateTable('calendar_oauth_states')
    .set({ claimed: true })
    .where('state_hash', '=', hash)
    .where('user_id', '=', session.user.id)
    .where('session_id', '=', session.sessionId)
    .where('provider', '=', provider)
    .where('claimed', '=', false)
    .where('expires_at', '>', new Date(clock()))
    .returning(['verifier', 'access'])
    .executeTakeFirst()
  if (!attempt) return 'invalid_state'
  try {
    if (query.getAll('error').length)
      return query.getAll('error').length === 1 &&
        query.get('error') === 'access_denied' &&
        !query.has('code')
        ? 'denied'
        : 'provider_unavailable'
    const code = query.get('code')
    if (
      !code ||
      code.length > 4096 ||
      !isSingleLineText(code) ||
      /\s/u.test(code) ||
      query.getAll('code').length !== 1
    )
      return 'provider_unavailable'
    const signal = AbortSignal.timeout(15_000)
    const tokens = await client.exchange(
      code,
      decryptCredential(
        key,
        stateAad(session.user.id, session.sessionId, hash, provider),
        attempt.verifier,
      ),
      signal,
    )
    requireScopes(tokens.scopes, attempt.access, provider)
    const identity = await client.identity(tokens.accessToken, signal)
    const calendars = await client.calendars(tokens.accessToken, signal)
    await deps.db.transaction().execute(async (trx) => {
      await lockUser(trx, session, clock())
      // Disconnect deletes outstanding attempts. A slow callback cannot resurrect access.
      const valid = await trx
        .deleteFrom('calendar_oauth_states')
        .where('state_hash', '=', hash)
        .where('claimed', '=', true)
        .where('expires_at', '>', new Date(clock()))
        .returning('state_hash')
        .executeTakeFirst()
      if (!valid) throw invalidState()
      const previous = await trx
        .selectFrom('calendar_connections')
        .select(['id', 'credentials'])
        .where('user_id', '=', session.user.id)
        .where('provider', '=', provider)
        .where('external_account_id', '=', identity.id)
        .executeTakeFirst()
      const refreshToken =
        tokens.refreshToken ??
        (previous &&
          readTokens(key, session.user.id, identity.id, previous.credentials, provider)
            .refreshToken)
      if (!refreshToken) throw new CalendarProviderError('needs_reauth')
      const credentials = encryptCredential(
        key,
        tokenAad(session.user.id, identity.id, provider),
        JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken,
          expiresAt: tokens.expiresAt,
        } satisfies StoredTokens),
      )
      const connection = await trx
        .insertInto('calendar_connections')
        .values({
          user_id: session.user.id,
          provider,
          external_account_id: identity.id,
          account_email: identity.email,
          credentials,
          scopes: tokens.scopes,
          status: 'active',
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'provider', 'external_account_id']).doUpdateSet({
            account_email: identity.email,
            credentials,
            scopes: tokens.scopes,
            status: 'active',
            last_error: null,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow()
      await saveCalendars(trx, connection.id, calendars)
      if (provider === 'google' && previous)
        await deps.enqueueWritebackRecovery?.(connection.id, trx)
    })
    return 'connected'
  } catch (error) {
    if (error instanceof CalendarProviderError) {
      if (error.code === 'provider_unavailable' && error.oauthError)
        console.error('Calendar OAuth token exchange failed:', provider, error.oauthError)
      return error.code
    }
    if (error instanceof DomainError && error.code === 'invalid_oauth_state') return 'invalid_state'
    throw error
  } finally {
    await deps.db.deleteFrom('calendar_oauth_states').where('state_hash', '=', hash).execute()
  }
}

export async function disconnectCalendar(deps: CalendarDeps, principal: Principal, id: string) {
  const session = requireCalendarSession(principal)
  if (!z.uuid().safeParse(id).success) throw notFound()
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, (deps.now ?? Date.now)())
    const deleted = await trx
      .deleteFrom('calendar_connections')
      .where('id', '=', id)
      .where('user_id', '=', session.user.id)
      .where('provider', 'in', ['google', 'microsoft'])
      .returning('id')
      .executeTakeFirst()
    if (!deleted) throw notFound()
    await trx.deleteFrom('calendar_oauth_states').where('user_id', '=', session.user.id).execute()
  })
}

/** Serialize rotations on the connection while keeping public booking owner locks compatible. */
export async function refreshGoogleCalendars(deps: CalendarDeps, principal: Principal, id: string) {
  return refreshCalendarProvider(deps, principal, id, 'google')
}

export async function refreshMicrosoftCalendars(
  deps: CalendarDeps,
  principal: Principal,
  id: string,
) {
  return refreshCalendarProvider(deps, principal, id, 'microsoft')
}

export async function refreshCalendarList(deps: CalendarDeps, principal: Principal, id: string) {
  if (!z.uuid().safeParse(id).success) throw notFound()
  const connection = await deps.db
    .selectFrom('calendar_connections')
    .select('provider')
    .where('id', '=', id)
    .where('user_id', '=', principal.user.id)
    .where('provider', 'in', ['google', 'microsoft'])
    .executeTakeFirst()
  if (!connection) throw notFound()
  return refreshCalendarProvider(deps, principal, id, connection.provider as CalendarProvider)
}

async function refreshCalendarProvider(
  deps: CalendarDeps,
  principal: Principal,
  id: string,
  provider: CalendarProvider,
) {
  const { client, key } = configured(deps, provider)
  if (!z.uuid().safeParse(id).success) throw notFound()
  let providerError: CalendarProviderError | undefined
  const outcome = await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, principal, (deps.now ?? Date.now)(), 'key_share')
    const connection = await trx
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', principal.user.id)
      .where('provider', '=', provider)
      .forUpdate()
      .executeTakeFirst()
    if (!connection) throw notFound()
    if (connection.status !== 'active') return 'needs_reauth'
    try {
      const previous = readTokens(
        key,
        principal.user.id,
        connection.external_account_id,
        connection.credentials,
        provider,
      )
      const signal = AbortSignal.timeout(15_000)
      const tokens: CalendarTokens =
        previous.expiresAt > (deps.now ?? Date.now)() + 60_000
          ? previous
          : await client.refresh(previous.refreshToken, signal)
      const scopes = tokens.scopes ?? connection.scopes
      requireScopes(scopes, 'list', provider)
      const credentials = encryptCredential(
        key,
        tokenAad(principal.user.id, connection.external_account_id, provider),
        JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? previous.refreshToken,
          expiresAt: tokens.expiresAt,
        } satisfies StoredTokens),
      )
      // Listing calendars proves nothing about event writes: a permissions failure recorded
      // by a booking write stays visible until the host reconnects, which queues recovery.
      await trx
        .updateTable('calendar_connections')
        .set({
          credentials,
          scopes,
          last_error: sql<string | null>`nullif(last_error, 'provider_unavailable')`,
        })
        .where('id', '=', id)
        .execute()
      // A refresh may rotate the refresh token. Keep it even when the following list
      // request fails transiently, or the next attempt would reuse the obsolete token.
      const calendars = await client.calendars(tokens.accessToken, signal)
      await saveCalendars(trx, id, calendars)
      return 'ok'
    } catch (error) {
      if (!(error instanceof CalendarProviderError)) throw error
      providerError = error
      await trx
        .updateTable('calendar_connections')
        .set({
          last_error: error.code,
          ...(error.code !== 'provider_unavailable' ? { status: 'needs_reauth' } : {}),
        })
        .where('id', '=', id)
        .execute()
      return error.code
    }
  })
  if (outcome !== 'ok')
    throw new DomainError(
      'conflict',
      `${provider}_calendar_${outcome}`,
      outcome === 'provider_unavailable'
        ? `${provider === 'google' ? 'Google' : 'Microsoft'} Calendar could not be reached. Try again shortly.`
        : `Reconnect ${provider === 'google' ? 'Google' : 'Microsoft'} Calendar to restore access.`,
      { cause: providerError },
    )
}

export { conferenceMirrorDispatchJob, retryConferenceMirror } from './conference-mirrors.ts'
export {
  bookingConferenceJob,
  conferenceBookingNotifier,
  conferenceDispatchJob,
  retryBookingConference,
  writeBookingConference,
} from './conferences.ts'
