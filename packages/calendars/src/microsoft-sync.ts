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
  type MicrosoftDeltaPage,
  MicrosoftDeltaReset,
} from './microsoft.ts'
import {
  clearMicrosoftChanges,
  publishMicrosoftChanges,
  stageMicrosoftChanges,
} from './microsoft-snapshot.ts'
import { SYNC_MAX_AGE_MS } from './sync.ts'

export const MICROSOFT_DELTA_PAGE_BUDGET = 16
const rolloverLeadHours = 7 * 24
const extraCoverageHours = 28 * 24
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
    let state = persisted.data ?? {}
    if (typeof state.retryAt === 'string' && state.retryAt > new Date(clock()).toISOString()) {
      return principal ? new MicrosoftCalendarError('provider_unavailable', 429) : undefined
    }
    let accessToken: string | undefined
    let readingCalendar = false
    let expired = false
    let expiredCursor = false
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
      const requiredEnd = day.add({ hours: 403 * 24 })
      const required = {
        start: day.subtract({ hours: 72 }).toString(),
        end: requiredEnd.toString(),
      }
      // Graph binds each cursor to its original window. Extra coverage avoids a daily rebuild.
      const fresh = { ...required, end: requiredEnd.add({ hours: extraCoverageHours }).toString() }
      const rollover = {
        ...required,
        end: requiredEnd.add({ hours: rolloverLeadHours }).toString(),
      }
      const budget = AbortSignal.timeout(30_000)
      const pageSignal = AbortSignal.any([signal, budget])
      let requests = 0
      let published = false
      rounds: do {
        expired = false
        expiredCursor = false
        const cursor = cursorSchema.safeParse(state).data
        // Checkpoints without a start time cannot establish the age of their staged pages.
        const saved = checkpointSchema.safeParse(state.microsoftPending).data
        const resumed = saved && covers(saved, required) ? saved : undefined
        // Start replacement with overlap so its pages can finish while the published range still serves bookings.
        const base = cursor && (published || covers(cursor, rollover)) ? cursor : undefined
        let window = resumed ?? base ?? fresh
        let nextLink = resumed?.nextLink ?? base?.deltaLink
        let startedAt = resumed?.startedAt ?? new Date(clock()).toISOString()
        let position = resumed?.position ?? 0
        let replace = resumed?.replace ?? !base
        let deltaLink: string | undefined
        let changes: MicrosoftDeltaChange[][] = []
        const visited = new Set<string>()
        readingCalendar = true
        while (requests < MICROSOFT_DELTA_PAGE_BUDGET) {
          requests++
          if (nextLink) visited.add(nextLink)
          let page: MicrosoftDeltaPage
          try {
            page = await client.deltaEvents(
              accessToken,
              calendar.external_id,
              {
                start: Temporal.Instant.from(window.start),
                end: Temporal.Instant.from(window.end),
                link: nextLink,
              },
              pageSignal,
            )
          } catch (error) {
            // A local budget expiry can still checkpoint pages already fetched.
            if (
              budget.aborted &&
              !signal.aborted &&
              (changes.length || expired || published) &&
              error instanceof MicrosoftCalendarError &&
              error.status === undefined
            ) {
              if (!changes.length && !expired) break rounds
              break
            }
            if (!(error instanceof MicrosoftDeltaReset) || !nextLink || expired) throw error
            expired = true
            expiredCursor = !replace
            window = fresh
            replace = true
            position = 0
            changes = []
            nextLink = undefined
            startedAt = new Date(clock()).toISOString()
            visited.clear()
            continue
          }
          changes.push(page.changes)
          nextLink = page.nextLink
          deltaLink = page.deltaLink
          if (nextLink && visited.has(nextLink))
            throw new MicrosoftCalendarError('provider_unavailable')
          if (deltaLink || budget.aborted) break
        }
        readingCalendar = false
        if (!deltaLink && !nextLink && !expired)
          throw new MicrosoftCalendarError('provider_unavailable')

        // If staging or publication fails, retain the last snapshot and checkpoint, then
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
          const nextState = deltaLink
            ? {
                version: 2,
                start: window.start,
                end: window.end,
                timeZone: calendar.time_zone,
                deltaLink,
              }
            : {
                ...state,
                ...(expiredCursor ? { deltaLink: undefined } : {}),
                retryAt: undefined,
                microsoftPending: nextLink
                  ? {
                      start: window.start,
                      end: window.end,
                      nextLink,
                      startedAt,
                      position,
                      replace,
                    }
                  : undefined,
              }
          if (deltaLink) await publishMicrosoftChanges(trx, calendarId, replace)
          await trx
            .updateTable('calendars')
            .set({
              sync_state: JSON.stringify(nextState),
              ...(deltaLink ? { last_synced_at: new Date(startedAt), sync_error: null } : {}),
            })
            .where('id', '=', calendarId)
            .execute()
          await sql`RELEASE SAVEPOINT microsoft_calendar_snapshot`.execute(trx)
          state = nextState
        } catch {
          await sql`ROLLBACK TO SAVEPOINT microsoft_calendar_snapshot`.execute(trx)
          throw new MicrosoftCalendarError('provider_unavailable')
        }
        if (!deltaLink) {
          if (!published)
            return principal ? new MicrosoftCalendarError('provider_unavailable') : undefined
          break
        }
        published = true
        // Changes to already-read pages can arrive in the next round. Catch up within the
        // same budget if this snapshot has already aged out, or let the minute dispatcher retry.
        if (clock() - Date.parse(startedAt) <= SYNC_MAX_AGE_MS) break
      } while (requests < MICROSOFT_DELTA_PAGE_BUDGET && !pageSignal.aborted)
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
            ...(expiredCursor ? { deltaLink: undefined } : {}),
            ...(expired ? { microsoftPending: undefined } : {}),
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
