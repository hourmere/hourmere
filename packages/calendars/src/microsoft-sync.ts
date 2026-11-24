import type { Principal } from '@hourmere/auth'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { type CalendarDeps, lockUser, readTokens, saveCalendars, tokenAad } from './index.ts'
import {
  hasMicrosoftCalendarListAccess,
  MicrosoftCalendarError,
  type MicrosoftDeltaChange,
  MicrosoftDeltaReset,
} from './microsoft.ts'
import {
  clearMicrosoftChanges,
  publishMicrosoftChanges,
  stageMicrosoftChanges,
} from './microsoft-snapshot.ts'

export const MICROSOFT_DELTA_PAGE_BUDGET = 8
const windowSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime() })
const cursorSchema = windowSchema.extend({ version: z.literal(2), deltaLink: z.string().min(1) })
const checkpointSchema = windowSchema.extend({
  nextLink: z.string().min(1),
  startedAt: z.iso.datetime(),
  position: z.int().nonnegative(),
  replace: z.boolean(),
})
type Window = z.infer<typeof windowSchema>

function covers(window: Window, required: Window) {
  return (
    Temporal.Instant.compare(window.start, required.start) <= 0 &&
    Temporal.Instant.compare(window.end, required.end) >= 0
  )
}

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
      .select(['external_id', 'time_zone', 'check_conflicts', 'sync_state', 'sync_error'])
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
    const removed = () => new DomainError('conflict', 'microsoft_calendar_removed')
    if (calendar.sync_error === 'calendar_removed') return principal ? removed() : undefined
    const persisted = z.record(z.string(), z.unknown()).safeParse(calendar.sync_state)
    const state = persisted.data ?? {}
    if (typeof state.retryAt === 'string' && state.retryAt > new Date(clock()).toISOString()) {
      return principal ? new MicrosoftCalendarError('provider_unavailable', 429) : undefined
    }
    let accessToken: string | undefined
    let readingCalendar = false
    let expired = false
    try {
      if (connection.status !== 'active') return new MicrosoftCalendarError('needs_reauth')
      if (!hasMicrosoftCalendarListAccess(connection.scopes))
        throw new MicrosoftCalendarError('permissions_missing')
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
      accessToken = previous.accessToken
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
      const required = {
        start: day.subtract({ hours: 72 }).toString(),
        end: day.add({ hours: 403 * 24 }).toString(),
      }
      // Graph binds each cursor to its original window. Extra coverage avoids a daily rebuild.
      const fresh = { ...required, end: day.add({ hours: (403 + 28) * 24 }).toString() }
      const cursor = cursorSchema.safeParse(state).data
      const saved = checkpointSchema.safeParse(state.microsoftPending).data
      const resumed = saved && covers(saved, required) ? saved : undefined
      const base = cursor && covers(cursor, required) ? cursor : undefined
      let window = resumed ?? base ?? fresh
      let nextLink = resumed?.nextLink ?? base?.deltaLink
      let startedAt = resumed?.startedAt ?? now.toString()
      let position = resumed?.position ?? 0
      let replace = resumed?.replace ?? !base
      let deltaLink: string | undefined
      let changes: MicrosoftDeltaChange[][] = []
      const visited = new Set<string>()
      const opened = performance.now()
      readingCalendar = true
      for (let request = 0; request < MICROSOFT_DELTA_PAGE_BUDGET; request++) {
        if (nextLink) visited.add(nextLink)
        try {
          const page = await client.deltaEvents(
            accessToken,
            calendar.external_id,
            {
              start: Temporal.Instant.from(window.start),
              end: Temporal.Instant.from(window.end),
              link: nextLink,
            },
            signal,
          )
          changes.push(page.changes)
          nextLink = page.nextLink
          deltaLink = page.deltaLink
          if (nextLink && visited.has(nextLink))
            throw new MicrosoftCalendarError('provider_unavailable')
          if (deltaLink || performance.now() - opened >= 30_000) break
        } catch (error) {
          if (!(error instanceof MicrosoftDeltaReset) || !nextLink || expired) throw error
          expired = true
          window = fresh
          startedAt = new Date(clock()).toISOString()
          replace = true
          position = 0
          changes = []
          nextLink = undefined
          visited.clear()
        }
      }
      readingCalendar = false
      if (!deltaLink && !nextLink) throw new MicrosoftCalendarError('provider_unavailable')

      // If staging or publication fails, retain the old snapshot and checkpoint, then
      // record the failure on the calendar in the outer transaction.
      await sql`SAVEPOINT microsoft_calendar_snapshot`.execute(trx)
      try {
        if (!resumed || expired) await clearMicrosoftChanges(trx, calendarId)
        const bounds = {
          start: Temporal.Instant.from(window.start),
          end: Temporal.Instant.from(window.end),
        }
        for (const page of changes) {
          await stageMicrosoftChanges(trx, calendarId, position, bounds, page)
          position += page.length
        }
        if (deltaLink) await publishMicrosoftChanges(trx, calendarId, replace)
        await trx
          .updateTable('calendars')
          .set(
            deltaLink
              ? {
                  sync_state: JSON.stringify({
                    version: 2,
                    start: window.start,
                    end: window.end,
                    timeZone: calendar.time_zone,
                    deltaLink,
                  }),
                  // A long page walk can precede newer changes. Its age starts with the round.
                  last_synced_at: new Date(startedAt),
                  sync_error: null,
                }
              : {
                  sync_state: JSON.stringify({
                    ...state,
                    ...(expired ? { deltaLink: undefined } : {}),
                    retryAt: undefined,
                    microsoftPending: {
                      start: window.start,
                      end: window.end,
                      nextLink,
                      startedAt,
                      position,
                      replace,
                    },
                  }),
                  sync_error: 'provider_unavailable',
                },
          )
          .where('id', '=', calendarId)
          .execute()
      } catch {
        await sql`ROLLBACK TO SAVEPOINT microsoft_calendar_snapshot`.execute(trx)
        throw new MicrosoftCalendarError('provider_unavailable')
      }
      if (!deltaLink)
        return principal ? new MicrosoftCalendarError('provider_unavailable') : undefined
      await trx
        .updateTable('calendar_connections')
        .set({ last_error: null })
        .where('id', '=', owner.connectionId)
        .where('last_error', '=', 'provider_unavailable')
        .execute()
    } catch (error) {
      if (!(error instanceof MicrosoftCalendarError)) throw error
      if (readingCalendar && accessToken && (error.status === 403 || error.status === 404)) {
        // A view permission failure can be local to one shared calendar. Only a
        // complete discovery response can confirm that Graph no longer lists it.
        const calendars = await client
          .calendars(accessToken, signal)
          .catch((listError: unknown) => {
            if (!(listError instanceof MicrosoftCalendarError)) throw listError
            return undefined
          })
        if (calendars) {
          await saveCalendars(trx, owner.connectionId, calendars, 'microsoft')
          if (!calendars.some((entry) => entry.id === calendar.external_id))
            return principal ? removed() : undefined
        }
      } else if (error.code !== 'provider_unavailable') {
        await trx
          .updateTable('calendar_connections')
          .set({ last_error: error.code, status: 'needs_reauth' })
          .where('id', '=', owner.connectionId)
          .execute()
      }
      if (expired) await clearMicrosoftChanges(trx, calendarId)
      await trx
        .updateTable('calendars')
        .set({
          sync_error: error.code,
          sync_state: JSON.stringify({
            ...state,
            ...(expired ? { deltaLink: undefined, microsoftPending: undefined } : {}),
            retryAt:
              error.retryAfterMs === undefined
                ? undefined
                : new Date(clock() + error.retryAfterMs).toISOString(),
          }),
        })
        .where('id', '=', calendarId)
        .execute()
      return error
    }
  })
  if (failure) throw failure
}
