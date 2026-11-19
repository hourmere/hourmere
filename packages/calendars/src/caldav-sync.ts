import { createHash } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { readCalDavCredentials } from './caldav-credentials.ts'
import { parseCalDavBusy } from './caldav-events.ts'
import type { CalDavSyncClient } from './caldav-sync-client.ts'
import { CalDavError } from './caldav-transport.ts'
import { calendarEncryptionKey } from './credentials.ts'
import { lockUser, requireCalendarSession } from './index.ts'

export interface CalDavSyncDeps {
  db: Db
  client: CalDavSyncClient
  encryptionKey: string
  now?: () => number
  enqueueSync?: (calendarId: string, transaction: Db) => Promise<unknown>
}
const discovery = z.object({
  version: z.literal(1),
  available: z.boolean(),
  color: z.string().nullable(),
})
const state = z.object({
  version: z.literal(2),
  start: z.string(),
  end: z.string(),
  timeZone: z.string().nullable(),
  syncToken: z.string().nullable(),
  etags: z.record(z.string(), z.string()),
  resources: z.record(z.string(), z.array(z.string())),
  caldavDiscovery: discovery,
})
function verifiedZone(value: string | null): string | null {
  if (!value) return null
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value)
    return value
  } catch {
    return null
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Caller holds the connection lock; retire any pre-write hashed copy before mirroring. */
export async function removeCalDavSyncedResource(
  db: Db,
  calendar: { id: string; sync_state: unknown },
  href: string,
) {
  const parsed = state.safeParse(calendar.sync_state)
  const ids = parsed.success ? parsed.data.resources[hash(href)] : undefined
  if (ids?.length)
    await db
      .deleteFrom('calendar_busy')
      .where('calendar_id', '=', calendar.id)
      .where('external_event_id', 'in', ids)
      .execute()
}
const sanitized = (error: unknown) =>
  new CalDavError(error instanceof CalDavError ? error.code : 'unavailable')

/** Internal selection; session and personal ownership are rechecked under the owner lock. */
export async function configureCalDavCalendar(
  deps: Pick<CalDavSyncDeps, 'db' | 'now' | 'enqueueSync'>,
  principal: Principal,
  id: string,
  checkConflicts: boolean,
) {
  const session = requireCalendarSession(principal)
  if (!z.uuid().safeParse(id).success || typeof checkConflicts !== 'boolean')
    throw new DomainError('invalid', 'invalid_calendar_settings')
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, deps.now ?? Date.now)
    const calendar = await trx
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select(['c.id', 'c.check_conflicts', 'c.sync_state', 'cc.status'])
      .where('c.id', '=', id)
      .where('cc.user_id', '=', session.user.id)
      .where('cc.provider', '=', 'caldav')
      .executeTakeFirst()
    if (!calendar) throw new DomainError('not_found', 'calendar_not_found')
    const metadata = z.object({ caldavDiscovery: discovery }).safeParse(calendar.sync_state)
    if (
      checkConflicts &&
      (calendar.status !== 'active' ||
        !metadata.success ||
        !metadata.data.caldavDiscovery.available)
    )
      throw new DomainError('conflict', 'caldav_calendar_unavailable')
    if (checkConflicts && !calendar.check_conflicts) {
      const count = await trx
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('cc.user_id', '=', session.user.id)
        .where('c.check_conflicts', '=', true)
        .executeTakeFirstOrThrow()
      if (count.count >= 20) throw new DomainError('conflict', 'calendar_selection_limit')
    }
    await trx
      .updateTable('calendars')
      .set({ check_conflicts: checkConflicts })
      .where('id', '=', id)
      .execute()
    if (checkConflicts) await deps.enqueueSync?.(id, trx)
  })
}

/** One connection row lock serializes even separate workers and different calendars. */
export async function syncCalDavCalendar(
  deps: CalDavSyncDeps,
  calendarId: string,
  outerSignal?: AbortSignal,
  principal?: Principal,
): Promise<void> {
  const signal = AbortSignal.any([
    ...(outerSignal ? [outerSignal] : []),
    AbortSignal.timeout(60_000),
  ])
  try {
    const owner = await deps.db
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select(['cc.id', 'cc.user_id'])
      .where('c.id', '=', calendarId)
      .where('cc.provider', '=', 'caldav')
      .executeTakeFirst()
    if (!owner) return
    const failure = await deps.db.transaction().execute(async (trx) => {
      if (principal)
        await lockUser(trx, requireCalendarSession(principal), deps.now ?? Date.now, 'key_share')
      await trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', owner.user_id)
        .forKeyShare()
        .execute()
      const connection = await trx
        .selectFrom('calendar_connections')
        .selectAll()
        .where('id', '=', owner.id)
        .where('provider', '=', 'caldav')
        .forUpdate()
        .executeTakeFirst()
      if (connection?.status !== 'active') return
      const calendar = await trx
        .selectFrom('calendars')
        .selectAll()
        .where('id', '=', calendarId)
        .where('check_conflicts', '=', true)
        .executeTakeFirst()
      if (!calendar) return
      const metadata = z.object({ caldavDiscovery: discovery }).safeParse(calendar.sync_state)
      const now = Temporal.Instant.fromEpochMilliseconds((deps.now ?? Date.now)())
      const day = now.toZonedDateTimeISO('UTC').toPlainDate().toZonedDateTime('UTC').toInstant()
      const start = day.subtract({ hours: 72 }).toString(),
        end = day.add({ hours: 403 * 24 }).toString()
      const saved = state.safeParse(calendar.sync_state)
      const previous =
        saved.success && saved.data.start === start && saved.data.end === end
          ? saved.data
          : undefined
      let prepared: {
        page: Awaited<ReturnType<CalDavSyncClient['sync']>>
        timeZone: string | null
        events: { key: string; href: string; periods: ReturnType<typeof parseCalDavBusy> }[]
      }
      try {
        if (!metadata.success || !metadata.data.caldavDiscovery.available)
          throw new CalDavError('unavailable')
        signal.throwIfAborted()
        const credentials = readCalDavCredentials(
          calendarEncryptionKey(deps.encryptionKey),
          connection,
        )
        const result = await deps.client.sync(
          credentials,
          {
            calendarUrl: calendar.external_id,
            start,
            end,
            ...(previous ? { previous } : {}),
          },
          signal,
        )
        const timeZone =
          result.calendarTimezone === null
            ? verifiedZone(calendar.time_zone)
            : verifiedZone(result.calendarTimezone)
        // A timezone change invalidates retained floating intervals, even on an empty delta.
        const page =
          previous && !result.full && timeZone !== previous.timeZone
            ? await deps.client.sync(
                credentials,
                { calendarUrl: calendar.external_id, start, end },
                signal,
              )
            : result
        prepared = {
          page,
          timeZone: page.calendarTimezone === null ? timeZone : verifiedZone(page.calendarTimezone),
          events: page.resources.map((resource) => ({
            key: hash(resource.href),
            href: resource.href,
            periods: parseCalDavBusy(resource.calendarData, {
              start,
              end,
              timeZone:
                page.calendarTimezone === null ? timeZone : verifiedZone(page.calendarTimezone),
            }),
          })),
        }
      } catch (error) {
        const failure = sanitized(error)
        const code =
          failure.code === 'unauthorized'
            ? 'needs_reauth'
            : failure.code === 'forbidden'
              ? 'permissions_missing'
              : 'provider_unavailable'
        await trx
          .updateTable('calendars')
          .set({ sync_error: code })
          .where('id', '=', calendarId)
          .execute()
        await trx
          .updateTable('calendar_connections')
          .set({
            last_error: code,
            ...(failure.code === 'unauthorized' ? { status: 'needs_reauth' } : {}),
          })
          .where('id', '=', owner.id)
          .execute()
        return failure
      }
      const { page, timeZone, events } = prepared
      // Only a persisted mapping plus its expected UID identifies our own copy. A
      // matching time/title, UID on another href, or recurrence is still foreign busy time.
      const written = await trx
        .selectFrom('booking_calendar_events as e')
        .innerJoin('booking_calendar_targets as t', (join) =>
          join
            .onRef('t.calendar_id', '=', 'e.calendar_id')
            .on(
              sql<boolean>`e.external_event_id = ${calendar.external_id.replace(/\/?$/, '/')} || t.root_booking_id::text || '.ics'`,
            ),
        )
        .select(['e.external_event_id', 't.root_booking_id'])
        .where('e.calendar_id', '=', calendarId)
        .execute()
      const groups = await trx
        .selectFrom('group_slot_calendar_events')
        .select(['external_event_id', 'group_slot_id'])
        .where('calendar_id', '=', calendarId)
        .execute()
      const own = new Map<string, Set<string>>()
      for (const mapping of written) {
        const ids = own.get(mapping.external_event_id) ?? new Set<string>()
        ids.add(JSON.stringify([mapping.root_booking_id, null]))
        own.set(mapping.external_event_id, ids)
      }
      for (const mapping of groups)
        own.set(
          mapping.external_event_id,
          new Set([JSON.stringify([`group-${mapping.group_slot_id}@hourmere`, null])]),
        )
      const resources = page.full ? ({} as Record<string, string[]>) : { ...previous?.resources }
      if (page.full)
        await trx.deleteFrom('calendar_busy').where('calendar_id', '=', calendarId).execute()
      // A write may have installed its immediate mirror after the previous snapshot.
      // Such a row is not yet in resources; retire it on both updates and deletions.
      const mirrored = [...page.deleted, ...events.map((event) => event.href)].filter((href) =>
        own.has(href),
      )
      if (mirrored.length)
        await trx
          .deleteFrom('calendar_busy')
          .where('calendar_id', '=', calendarId)
          .where('external_event_id', 'in', mirrored)
          .execute()
      for (const key of [...page.deleted.map(hash), ...events.map((event) => event.key)]) {
        const old = resources[key]
        if (old?.length)
          await trx
            .deleteFrom('calendar_busy')
            .where('calendar_id', '=', calendarId)
            .where('external_event_id', 'in', old)
            .execute()
        delete resources[key]
      }
      for (const event of events) {
        resources[event.key] = []
        for (const period of event.periods) {
          const id =
            event.periods.length === 1 && own.get(event.href)?.has(period.instanceId)
              ? event.href
              : hash(JSON.stringify([event.key, period.instanceId]))
          resources[event.key]?.push(id)
          await trx
            .insertInto('calendar_busy')
            .values({
              calendar_id: calendarId,
              external_event_id: id,
              period:
                period.kind === 'timed'
                  ? sql<string>`tstzrange(${period.start}::timestamptz,${period.end}::timestamptz,'[)')`
                  : null,
              all_day_start: period.kind === 'all_day' ? period.start : null,
              all_day_end: period.kind === 'all_day' ? period.end : null,
            })
            .execute()
        }
      }
      await trx
        .updateTable('calendars')
        .set({
          sync_state: JSON.stringify({
            version: 2,
            start,
            end,
            timeZone,
            syncToken: page.syncToken,
            etags: page.etags,
            resources,
            caldavDiscovery: metadata.success ? metadata.data.caldavDiscovery : undefined,
            caldavWriteback: (calendar.sync_state as { caldavWriteback?: unknown } | null)
              ?.caldavWriteback,
          }),
          time_zone: timeZone,
          last_synced_at: new Date(now.epochMilliseconds),
          sync_error: null,
        })
        .where('id', '=', calendarId)
        .execute()
      await trx
        .updateTable('calendar_connections')
        .set({
          last_error: sql<string | null>`CASE WHEN EXISTS (
          SELECT 1 FROM calendars WHERE connection_id=${owner.id}::uuid
            AND sync_state->'caldavWriteback'->>'result' <> 'success'
          ) THEN 'provider_unavailable' ELSE NULL END`,
        })
        .where('id', '=', owner.id)
        .execute()
    })
    if (failure) throw failure
  } catch (error) {
    // Persistence failures roll back the snapshot and must also invalidate freshness.
    // A concurrent recovery may be conservatively marked unknown; it can sync again.
    if (!(error instanceof CalDavError)) {
      await deps.db
        .updateTable('calendars')
        .set({ sync_error: 'provider_unavailable' })
        .where('id', '=', calendarId)
        .execute()
        .catch(() => {})
    }
    throw sanitized(error)
  }
}
