import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES, GoogleCalendarError } from './google.ts'
import { type GoogleEvent, GoogleSyncReset } from './google-events.ts'
import {
  type CalendarDeps,
  lockUser,
  readTokens,
  requireCalendarSession,
  tokenAad,
} from './index.ts'

export const SYNC_MAX_AGE_MS = 10 * 60_000
const cursor = z.object({
  version: z.literal(1),
  start: z.string(),
  end: z.string(),
  token: z.string().min(1).max(4096),
  timeZone: z.string().nullable(),
})
export type CalendarSyncState = z.infer<typeof cursor>
const failure = () => new GoogleCalendarError('provider_unavailable')

/**
 * Keep deletion/disconnect behind the owner key-share lock, and serialize token rotations
 * through this connection row. Booking verification share-locks the owner without waiting
 * for a provider network call. Network errors retain refreshed credentials on commit.
 */
export async function useGoogleConnection<T>(
  deps: CalendarDeps,
  id: string,
  signal: AbortSignal,
  work: (trx: Db, accessToken: string, userId: string) => Promise<T>,
): Promise<T | undefined> {
  if (!deps.google) return undefined
  const google = deps.google
  const owner = await deps.db
    .selectFrom('calendar_connections')
    .select('user_id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!owner) return undefined
  const result = await deps.db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', owner.user_id)
      .forKeyShare()
      .execute()
    const connection = await trx
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', id)
      .where('provider', '=', 'google')
      .forUpdate()
      .executeTakeFirst()
    if (!connection) return { ok: true as const, value: undefined }
    try {
      if (connection.status !== 'active') throw new GoogleCalendarError('needs_reauth')
      if (!GOOGLE_CALENDAR_SYNC_SCOPES.every((scope) => connection.scopes.includes(scope)))
        throw new GoogleCalendarError('permissions_missing')
      const key = calendarEncryptionKey(google.encryptionKey)
      const previous = readTokens(
        key,
        owner.user_id,
        connection.external_account_id,
        connection.credentials,
      )
      let accessToken = previous.accessToken
      if (previous.expiresAt <= (deps.now ?? Date.now)() + 60_000) {
        const next = await google.client.refresh(previous.refreshToken, signal)
        const scopes = next.scopes ?? connection.scopes
        const credentials = encryptCredential(
          key,
          tokenAad(owner.user_id, connection.external_account_id),
          JSON.stringify({
            accessToken: next.accessToken,
            refreshToken: next.refreshToken ?? previous.refreshToken,
            expiresAt: next.expiresAt,
          }),
        )
        await trx
          .updateTable('calendar_connections')
          .set({ credentials, scopes })
          .where('id', '=', id)
          .execute()
        if (!GOOGLE_CALENDAR_SYNC_SCOPES.every((scope) => scopes.includes(scope)))
          throw new GoogleCalendarError('permissions_missing')
        accessToken = next.accessToken
      }
      return { ok: true as const, value: await work(trx, accessToken, owner.user_id) }
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) throw error
      await trx
        .updateTable('calendar_connections')
        .set({
          last_error: error.code,
          ...(error.code === 'needs_reauth' ? { status: 'needs_reauth' } : {}),
        })
        .where('id', '=', id)
        .execute()
      return { ok: false as const, error }
    }
  })
  if (!result.ok) throw result.error
  return result.value
}

function eventInstant(
  value: NonNullable<GoogleEvent['start']>,
  zone: string | null,
): Temporal.Instant {
  try {
    if (value.dateTime) {
      try {
        return Temporal.Instant.from(value.dateTime)
      } catch {
        return Temporal.PlainDateTime.from(value.dateTime)
          .toZonedDateTime(value.timeZone ?? zone ?? '', { disambiguation: 'reject' })
          .toInstant()
      }
    }
    if (!value.date || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw failure()
    return Temporal.PlainDate.from(value.date)
      .toZonedDateTime(value.timeZone ?? zone ?? '')
      .toInstant()
  } catch {
    throw failure()
  }
}
export function eventPeriod(
  event: GoogleEvent,
  zone: string | null,
): { start: string; end: string } | null {
  if (
    event.status === 'cancelled' ||
    event.transparency === 'transparent' ||
    event.attendees?.some((a) => a.self && a.responseStatus === 'declined')
  )
    return null
  if (!event.start || !event.end) throw failure()
  if (Boolean(event.start.date) !== Boolean(event.end.date)) throw failure()
  const start = eventInstant(event.start, zone)
  const end = eventInstant(event.end, zone)
  if (Temporal.Instant.compare(end, start) <= 0) throw failure()
  return {
    start: start.round({ smallestUnit: 'millisecond', roundingMode: 'floor' }).toString(),
    end: end.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).toString(),
  }
}

/** Full/expanded snapshot first, then deltas. A daily new window covers the next 400 days. */
export async function syncGoogleCalendar(
  deps: CalendarDeps,
  calendarId: string,
  signal = AbortSignal.timeout(60_000),
) {
  const owned = await deps.db
    .selectFrom('calendars')
    .select('connection_id')
    .where('id', '=', calendarId)
    .executeTakeFirst()
  if (!owned || !deps.google) return
  const client = deps.google.client
  try {
    await useGoogleConnection(deps, owned.connection_id, signal, async (trx, accessToken) => {
      const calendar = await trx
        .selectFrom('calendars')
        .selectAll()
        .where('id', '=', calendarId)
        .where('check_conflicts', '=', true)
        .executeTakeFirst()
      if (!calendar) return
      const now = Temporal.Instant.fromEpochMilliseconds((deps.now ?? Date.now)())
      const day = now.toZonedDateTimeISO('UTC').toPlainDate().toZonedDateTime('UTC').toInstant()
      const start = day.subtract({ hours: 72 }).toString()
      const end = day.add({ hours: 403 * 24 }).toString()
      const saved = cursor.safeParse(calendar.sync_state)
      let incremental =
        saved.success &&
        saved.data.start === start &&
        saved.data.end === end &&
        saved.data.timeZone === calendar.time_zone
      let page: Awaited<ReturnType<typeof client.events>>
      try {
        page = await client.events(
          accessToken,
          calendar.external_id,
          { start, end, token: incremental && saved.success ? saved.data.token : undefined },
          signal,
        )
      } catch (error) {
        if (!(error instanceof GoogleSyncReset)) throw error
        incremental = false
        page = await client.events(accessToken, calendar.external_id, { start, end }, signal)
      }
      // The collection timezone is current even when the list metadata is stale. An
      // empty delta cannot re-interpret stored all-day dates, so rebuild the snapshot.
      let timeZone = page.timeZone ?? calendar.time_zone
      if (incremental && page.timeZone !== null && page.timeZone !== calendar.time_zone) {
        incremental = false
        page = await client.events(accessToken, calendar.external_id, { start, end }, signal)
        timeZone = page.timeZone ?? timeZone
      }
      // Validate every interval before changing the snapshot; partial pages never become live.
      const events = page.items.map((event) => ({
        id: event.id,
        period: eventPeriod(event, timeZone),
      }))
      if (!incremental)
        await trx.deleteFrom('calendar_busy').where('calendar_id', '=', calendarId).execute()
      for (const event of events) {
        if (
          !event.period ||
          Temporal.Instant.compare(
            Temporal.Instant.from(event.period.end),
            Temporal.Instant.from(start),
          ) <= 0 ||
          Temporal.Instant.compare(
            Temporal.Instant.from(event.period.start),
            Temporal.Instant.from(end),
          ) >= 0
        ) {
          await trx
            .deleteFrom('calendar_busy')
            .where('calendar_id', '=', calendarId)
            .where('external_event_id', '=', event.id)
            .execute()
        } else {
          await trx
            .insertInto('calendar_busy')
            .values({
              calendar_id: calendarId,
              external_event_id: event.id,
              period: sql<string>`tstzrange(${event.period.start}::timestamptz,${event.period.end}::timestamptz,'[)')`,
            })
            .onConflict((oc) =>
              oc
                .columns(['calendar_id', 'external_event_id'])
                .doUpdateSet((eb) => ({ period: eb.ref('excluded.period') })),
            )
            .execute()
        }
      }
      await trx
        .updateTable('calendars')
        .set({
          sync_state: JSON.stringify({ version: 1, start, end, token: page.token, timeZone }),
          time_zone: timeZone,
          last_synced_at: new Date(now.epochMilliseconds),
          sync_error: null,
        })
        .where('id', '=', calendarId)
        .execute()
    })
  } catch (error) {
    await deps.db
      .updateTable('calendars')
      .set({
        sync_error: error instanceof GoogleCalendarError ? error.code : 'provider_unavailable',
      })
      .where('id', '=', calendarId)
      .execute()
    throw error
  }
}

export async function configureCalendar(
  deps: CalendarDeps,
  principal: Principal,
  id: string,
  checkConflicts: boolean,
) {
  const session = requireCalendarSession(principal)
  if (!z.uuid().safeParse(id).success || typeof checkConflicts !== 'boolean')
    throw new DomainError('invalid', 'invalid_calendar_settings')
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, (deps.now ?? Date.now)())
    const row = await trx
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select(['c.id', 'cc.scopes', 'cc.status', 'c.access_role', 'c.check_conflicts'])
      .where('c.id', '=', id)
      .where('cc.user_id', '=', session.user.id)
      .where('cc.provider', '=', 'google')
      .executeTakeFirst()
    if (!row) throw new DomainError('not_found', 'calendar_not_found')
    if (checkConflicts && !row.check_conflicts) {
      const selected = await trx
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('cc.user_id', '=', session.user.id)
        .where('c.check_conflicts', '=', true)
        .executeTakeFirstOrThrow()
      if (selected.count >= 20)
        throw new DomainError(
          'conflict',
          'calendar_selection_limit',
          'Select at most 20 conflict calendars.',
        )
    }
    if (
      checkConflicts &&
      (row.status !== 'active' || !GOOGLE_CALENDAR_SYNC_SCOPES.every((s) => row.scopes.includes(s)))
    )
      throw new DomainError(
        'conflict',
        'google_calendar_permissions_missing',
        'Reconnect Google Calendar to enable synchronization.',
      )
    if (checkConflicts && row.access_role === 'freeBusyReader')
      throw new DomainError(
        'conflict',
        'calendar_events_unreadable',
        'This calendar does not allow event synchronization.',
      )
    await trx
      .updateTable('calendars')
      .set({ check_conflicts: checkConflicts })
      .where('id', '=', id)
      .execute()
    if (checkConflicts) await deps.enqueueSync?.(id, trx)
  })
}

export async function syncOwnedCalendar(deps: CalendarDeps, principal: Principal, id: string) {
  const session = requireCalendarSession(principal)
  if (!z.uuid().safeParse(id).success) throw new DomainError('not_found', 'calendar_not_found')
  if (!deps.google) throw new DomainError('conflict', 'google_calendar_disabled')
  const calendar = await deps.db
    .selectFrom('calendars as c')
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select('c.check_conflicts')
    .where('c.id', '=', id)
    .where('cc.user_id', '=', session.user.id)
    .where('cc.provider', '=', 'google')
    .executeTakeFirst()
  if (!calendar) throw new DomainError('not_found', 'calendar_not_found')
  if (!calendar.check_conflicts) throw new DomainError('conflict', 'calendar_sync_disabled')
  try {
    await syncGoogleCalendar(deps, id)
  } catch (error) {
    if (error instanceof GoogleCalendarError)
      throw new DomainError(
        'conflict',
        `google_calendar_${error.code}`,
        'Calendar synchronization could not complete. Reconnect if access has expired, or try again shortly.',
      )
    throw error
  }
}

export async function setCalendarDestination(
  deps: CalendarDeps,
  principal: Principal,
  calendarId: string | null,
) {
  const session = requireCalendarSession(principal)
  if (calendarId !== null && !z.uuid().safeParse(calendarId).success)
    throw new DomainError('invalid', 'invalid_calendar_settings')
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, (deps.now ?? Date.now)())
    if (calendarId !== null) {
      const row = await trx
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select(['c.access_role', 'cc.status', 'cc.scopes'])
        .where('c.id', '=', calendarId)
        .where('cc.user_id', '=', session.user.id)
        .where('cc.provider', '=', 'google')
        .executeTakeFirst()
      if (!row) throw new DomainError('not_found', 'calendar_not_found')
      if (
        row.access_role !== 'owner' ||
        row.status !== 'active' ||
        !GOOGLE_CALENDAR_SYNC_SCOPES.every((s) => row.scopes.includes(s))
      )
        throw new DomainError(
          'conflict',
          'calendar_not_writable',
          'Choose an owned Google calendar and enable synchronization first.',
        )
    }
    const updated = await trx
      .updateTable('profiles')
      .set({ destination_calendar_id: calendarId })
      .where('user_id', '=', session.user.id)
      .returning('user_id')
      .executeTakeFirst()
    if (!updated)
      throw new DomainError(
        'not_found',
        'profile_not_found',
        'Create a profile before selecting a booking calendar.',
      )
  })
}
