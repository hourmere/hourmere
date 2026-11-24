import type { Principal } from '@hourmere/auth'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { type CalendarDeps, lockUser, readTokens, tokenAad } from './index.ts'
import { hasMicrosoftCalendarListAccess, MicrosoftCalendarError } from './microsoft.ts'

/** Publish only complete calendar views. Booking checks read the local snapshot without Graph I/O. */
export async function syncMicrosoftCalendar(
  deps: CalendarDeps,
  calendarId: string,
  signal = AbortSignal.timeout(60_000),
  principal?: Principal,
) {
  if (!deps.microsoft) return
  const { client, encryptionKey } = deps.microsoft
  const clock = deps.now ?? Date.now
  const ownership = deps.db
    .selectFrom('calendars as c')
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select(['cc.id as connectionId', 'cc.user_id as userId'])
    .where('c.id', '=', calendarId)
    .where('cc.provider', '=', 'microsoft')
  const owner = await (principal
    ? ownership.where('cc.user_id', '=', principal.user.id)
    : ownership
  ).executeTakeFirst()
  if (!owner) {
    if (principal) throw new DomainError('not_found', 'calendar_not_found')
    return
  }
  const failure = await deps.db.transaction().execute(async (trx) => {
    // Match list refresh's lock order so rotated credentials and disconnects serialize.
    if (principal) await lockUser(trx, principal, clock, 'key_share')
    else
      await trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', owner.userId)
        .forKeyShare()
        .execute()
    const connection = await trx
      .selectFrom('calendar_connections')
      .select(['credentials', 'external_account_id', 'scopes', 'status'])
      .where('id', '=', owner.connectionId)
      .where('user_id', '=', owner.userId)
      .where('provider', '=', 'microsoft')
      .forUpdate()
      .executeTakeFirst()
    const calendar = await trx
      .selectFrom('calendars')
      .select(['external_id', 'time_zone', 'check_conflicts', 'sync_state'])
      .where('id', '=', calendarId)
      .where('connection_id', '=', owner.connectionId)
      .executeTakeFirst()
    if (!connection || !calendar) {
      if (principal) throw new DomainError('not_found', 'calendar_not_found')
      return
    }
    if (!calendar.check_conflicts) {
      if (principal) throw new DomainError('conflict', 'calendar_sync_disabled')
      return
    }
    try {
      if (connection.status !== 'active') return new MicrosoftCalendarError('needs_reauth')
      if (!hasMicrosoftCalendarListAccess(connection.scopes))
        throw new MicrosoftCalendarError('permissions_missing')
      const state = calendar.sync_state
      if (
        state &&
        typeof state === 'object' &&
        !Array.isArray(state) &&
        typeof state.retryAt === 'string' &&
        state.retryAt > new Date(clock()).toISOString()
      ) {
        if (principal) return new MicrosoftCalendarError('provider_unavailable', 429)
        return
      }
      const key = calendarEncryptionKey(encryptionKey)
      let previous: ReturnType<typeof readTokens>
      try {
        previous = readTokens(
          key,
          owner.userId,
          connection.external_account_id,
          connection.credentials,
          'microsoft',
        )
      } catch {
        throw new MicrosoftCalendarError('needs_reauth')
      }
      let accessToken = previous.accessToken
      if (previous.expiresAt <= clock() + 60_000) {
        const next = await client.refresh(previous.refreshToken, signal)
        const scopes = next.scopes ?? connection.scopes
        await trx
          .updateTable('calendar_connections')
          .set({
            scopes,
            credentials: encryptCredential(
              key,
              tokenAad(owner.userId, connection.external_account_id, 'microsoft'),
              JSON.stringify({
                accessToken: next.accessToken,
                refreshToken: next.refreshToken ?? previous.refreshToken,
                expiresAt: next.expiresAt,
              }),
            ),
          })
          .where('id', '=', owner.connectionId)
          .execute()
        if (!hasMicrosoftCalendarListAccess(scopes))
          throw new MicrosoftCalendarError('permissions_missing')
        accessToken = next.accessToken
      }
      const now = Temporal.Instant.fromEpochMilliseconds(clock())
      const day = now.toZonedDateTimeISO('UTC').startOfDay().toInstant()
      const start = day.subtract({ hours: 72 })
      const end = day.add({ hours: 403 * 24 })
      const events = await client.busyEvents(accessToken, calendar.external_id, start, end, signal)
      await trx
        .deleteFrom('calendar_busy')
        .where('calendar_id', '=', calendarId)
        .$if(events.length > 0, (query) =>
          query.where(
            'external_event_id',
            'not in',
            events.map((event) => event.id),
          ),
        )
        .execute()
      if (events.length)
        await trx
          .insertInto('calendar_busy')
          .values(
            events.map((event) => {
              // Graph timestamps can have 100 ns precision. Round outward to PostgreSQL precision.
              const from = event.start.round({ smallestUnit: 'microsecond', roundingMode: 'floor' })
              const to = event.end.round({ smallestUnit: 'microsecond', roundingMode: 'ceil' })
              return {
                calendar_id: calendarId,
                external_event_id: event.id,
                period: sql<string>`tstzrange(${from.toString()}::timestamptz,${to.toString()}::timestamptz,'[)')`,
              }
            }),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['calendar_id', 'external_event_id'])
              .doUpdateSet((eb) => ({
                period: eb.ref('excluded.period'),
                all_day_start: null,
                all_day_end: null,
              }))
              .whereRef('calendar_busy.period', 'is distinct from', 'excluded.period'),
          )
          .execute()
      await trx
        .updateTable('calendars')
        .set({
          sync_state: JSON.stringify({
            version: 2,
            start: start.toString(),
            end: end.toString(),
            timeZone: calendar.time_zone,
          }),
          last_synced_at: new Date(now.epochMilliseconds),
          sync_error: null,
        })
        .where('id', '=', calendarId)
        .execute()
      await trx
        .updateTable('calendar_connections')
        .set({ last_error: null })
        .where('id', '=', owner.connectionId)
        .where('last_error', '=', 'provider_unavailable')
        .execute()
    } catch (error) {
      if (!(error instanceof MicrosoftCalendarError)) throw error
      await trx
        .updateTable('calendar_connections')
        .set({
          last_error: error.code,
          ...(error.code !== 'provider_unavailable' ? { status: 'needs_reauth' } : {}),
        })
        .where('id', '=', owner.connectionId)
        .execute()
      await trx
        .updateTable('calendars')
        .set({
          sync_error: error.code,
          ...(error.retryAfterMs !== undefined && {
            sync_state: JSON.stringify({
              retryAt: new Date(clock() + error.retryAfterMs).toISOString(),
            }),
          }),
        })
        .where('id', '=', calendarId)
        .execute()
      return error
    }
  })
  if (failure) throw failure
}
