import { createHash, randomBytes } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { calendarEncryptionKey, decryptCredential, encryptCredential } from './credentials.ts'
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_CALENDAR_SYNC_SCOPES,
  type GoogleCalendar,
  type GoogleCalendarClient,
  GoogleCalendarError,
  type GoogleTokens,
} from './google.ts'

export { calendarBookingNotifier } from './booking-events.ts'
export { calendarEncryptionKey } from './credentials.ts'
export {
  createGoogleCalendarClient,
  GOOGLE_CALENDAR_CALLBACK,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_CALENDAR_SYNC_SCOPES,
} from './google.ts'
export { bookingCalendarJob, calendarDispatchJob, calendarSyncJob } from './jobs.ts'
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
  db: Db
  google?: { client: GoogleCalendarClient; encryptionKey: string } | undefined
  now?: () => number
  enqueueSync?: ((calendarId: string, transaction: Db) => Promise<unknown>) | undefined
}
const storedTokens = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().finite().positive(),
})
type StoredTokens = z.infer<typeof storedTokens>
const digest = (state: string) => createHash('sha256').update(state).digest('hex')
export const tokenAad = (user: string, account: string) => `google:${user}:${account}`
const stateAad = (user: string, session: string, hash: string) => `state:${user}:${session}:${hash}`
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
const configured = (deps: CalendarDeps) => {
  if (!deps.google)
    throw new DomainError(
      'conflict',
      'google_calendar_disabled',
      'Google Calendar is not configured on this instance.',
    )
  return { client: deps.google.client, key: calendarEncryptionKey(deps.google.encryptionKey) }
}

/** All connection mutations lock the owner, including the final phase of a callback. */
export async function lockUser(db: Db, principal: SessionPrincipal, now: number) {
  const user = await db
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', principal.user.id)
    .forUpdate()
    .executeTakeFirst()
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
): StoredTokens {
  try {
    return storedTokens.parse(
      JSON.parse(decryptCredential(key, tokenAad(user, account), credentials)),
    )
  } catch {
    throw new Error('Stored calendar credentials are invalid')
  }
}
function requireScopes(scopes: string[] | undefined, access = 'list'): asserts scopes is string[] {
  const required = access === 'sync' ? GOOGLE_CALENDAR_SYNC_SCOPES : GOOGLE_CALENDAR_SCOPES
  if (!scopes || !required.every((scope) => scopes.includes(scope)))
    throw new GoogleCalendarError('permissions_missing')
}

async function saveCalendars(db: Db, connectionId: string, calendars: GoogleCalendar[]) {
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
    .select(['id', 'account_email', 'status', 'created_at', 'updated_at', 'scopes'])
    .where('user_id', '=', principal.user.id)
    .where('provider', '=', 'google')
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
    destinationCalendarId: profile?.destination_calendar_id ?? null,
    data: connections.map((connection) => ({
      id: connection.id,
      provider: 'google' as const,
      accountEmail: connection.account_email,
      status: connection.status as 'active' | 'needs_reauth' | 'revoked',
      createdAt: connection.created_at.toISOString(),
      updatedAt: connection.updated_at.toISOString(),
      syncAuthorized: GOOGLE_CALENDAR_SYNC_SCOPES.every((scope) =>
        connection.scopes.includes(scope),
      ),
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
  if (access !== 'list' && access !== 'sync')
    throw new DomainError('invalid', 'invalid_calendar_access')
  const session = requireCalendarSession(principal)
  const { client, key } = configured(deps)
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
        verifier: encryptCredential(
          key,
          stateAad(session.user.id, session.sessionId, hash),
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
  const session = requireCalendarSession(principal)
  const { client, key } = configured(deps)
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
      decryptCredential(key, stateAad(session.user.id, session.sessionId, hash), attempt.verifier),
      signal,
    )
    requireScopes(tokens.scopes, attempt.access)
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
        .where('provider', '=', 'google')
        .where('external_account_id', '=', identity.id)
        .executeTakeFirst()
      const refreshToken =
        tokens.refreshToken ??
        (previous &&
          readTokens(key, session.user.id, identity.id, previous.credentials).refreshToken)
      if (!refreshToken) throw new GoogleCalendarError('needs_reauth')
      const credentials = encryptCredential(
        key,
        tokenAad(session.user.id, identity.id),
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
          provider: 'google',
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
    })
    return 'connected'
  } catch (error) {
    if (error instanceof GoogleCalendarError) return error.code
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
      .where('provider', '=', 'google')
      .returning('id')
      .executeTakeFirst()
    if (!deleted) throw notFound()
    await trx.deleteFrom('calendar_oauth_states').where('user_id', '=', session.user.id).execute()
  })
}

/** Refresh/list under the same owner lock as disconnect and reconnect; never lose a rotation. */
export async function refreshGoogleCalendars(deps: CalendarDeps, principal: Principal, id: string) {
  const session = requireCalendarSession(principal)
  const { client, key } = configured(deps)
  if (!z.uuid().safeParse(id).success) throw notFound()
  const outcome = await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, (deps.now ?? Date.now)())
    const connection = await trx
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', session.user.id)
      .where('provider', '=', 'google')
      .executeTakeFirst()
    if (!connection) throw notFound()
    if (connection.status !== 'active') return 'needs_reauth'
    try {
      const previous = readTokens(
        key,
        session.user.id,
        connection.external_account_id,
        connection.credentials,
      )
      const signal = AbortSignal.timeout(15_000)
      const tokens: GoogleTokens =
        previous.expiresAt > (deps.now ?? Date.now)() + 60_000
          ? previous
          : await client.refresh(previous.refreshToken, signal)
      const scopes = tokens.scopes ?? connection.scopes
      requireScopes(scopes)
      const credentials = encryptCredential(
        key,
        tokenAad(session.user.id, connection.external_account_id),
        JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? previous.refreshToken,
          expiresAt: tokens.expiresAt,
        } satisfies StoredTokens),
      )
      await trx
        .updateTable('calendar_connections')
        .set({ credentials, scopes, last_error: null })
        .where('id', '=', id)
        .execute()
      // A refresh may rotate the refresh token. Keep it even when the following list
      // request fails transiently, or the next attempt would reuse the obsolete token.
      const calendars = await client.calendars(tokens.accessToken, signal)
      await saveCalendars(trx, id, calendars)
      return 'ok'
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) throw error
      if (error.code !== 'provider_unavailable')
        await trx
          .updateTable('calendar_connections')
          .set({ status: 'needs_reauth', last_error: error.code })
          .where('id', '=', id)
          .execute()
      return error.code
    }
  })
  if (outcome !== 'ok')
    throw new DomainError(
      'conflict',
      `google_calendar_${outcome}`,
      outcome === 'provider_unavailable'
        ? 'Google Calendar could not be reached. Try again shortly.'
        : 'Reconnect Google Calendar to restore access.',
    )
}
