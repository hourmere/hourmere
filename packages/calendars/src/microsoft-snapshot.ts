import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type { MicrosoftDeltaChange } from './microsoft.ts'

export async function stageMicrosoftChanges(
  trx: Db,
  calendarId: string,
  position: number,
  window: { start: Temporal.Instant; end: Temporal.Instant },
  changes: MicrosoftDeltaChange[],
) {
  if (!changes.length) return
  await trx
    .insertInto('calendar_microsoft_changes')
    .values(
      changes.map((change, index) => {
        const event = change.kind === 'event' ? change : null
        let period = null
        if (
          event?.period &&
          Temporal.Instant.compare(event.period.start, window.end) < 0 &&
          Temporal.Instant.compare(event.period.end, window.start) > 0
        ) {
          // Graph timestamps can have 100 ns precision. Round outward to PostgreSQL precision.
          const from = event.period.start.round({
            smallestUnit: 'microsecond',
            roundingMode: 'floor',
          })
          const to = event.period.end.round({ smallestUnit: 'microsecond', roundingMode: 'ceil' })
          period = sql<string>`tstzrange(${from.toString()}::timestamptz,${to.toString()}::timestamptz,'[)')`
        }
        return {
          calendar_id: calendarId,
          position: position + index,
          external_event_id: change.id,
          microsoft_series_id: event?.seriesMasterId ?? null,
          microsoft_original_start: event?.originalStart ?? null,
          last_modified_at: event?.lastModifiedAt ?? null,
          period,
          removes_series:
            change.kind === 'removed' || (event?.type === 'seriesMaster' && event.cancelled),
          is_exception: event?.type === 'exception',
        }
      }),
    )
    .execute()
}

export async function clearMicrosoftChanges(trx: Db, calendarId: string) {
  await trx.deleteFrom('calendar_microsoft_changes').where('calendar_id', '=', calendarId).execute()
}

export async function publishMicrosoftChanges(trx: Db, calendarId: string, replace: boolean) {
  // Positions span all pages of the round, including those staged by earlier runs.
  // Match recurring aliases by original slot and prefer the exception. For equally ranked
  // aliases with indistinguishable modification times, prefer a busy interval.
  await sql`
    WITH changes AS MATERIALIZED (
      SELECT DISTINCT ON (external_event_id) *
      FROM calendar_microsoft_changes
      WHERE calendar_id = ${calendarId}
      ORDER BY external_event_id, position DESC
    ), slots AS MATERIALIZED (
      SELECT DISTINCT ON (microsoft_series_id, microsoft_original_start) *
      FROM changes WHERE microsoft_original_start IS NOT NULL
      ORDER BY microsoft_series_id, microsoft_original_start,
        is_exception DESC,
        CASE WHEN bool_and(last_modified_at IS NOT NULL) OVER (
          PARTITION BY microsoft_series_id, microsoft_original_start, is_exception
        ) THEN last_modified_at END DESC NULLS LAST,
        (period IS NOT NULL) DESC, position DESC
    ), busy AS MATERIALIZED (
      SELECT change.* FROM changes change
      LEFT JOIN slots slot USING (microsoft_series_id, microsoft_original_start)
      WHERE change.period IS NOT NULL
        AND (slot.position IS NULL OR change.position = slot.position)
    ), removed_series AS (
      SELECT master.external_event_id FROM changes master
      WHERE master.removes_series AND NOT EXISTS (
        -- Graph can return tombstones for out-of-window changes. A live child in this round
        -- is evidence that the series still has occurrences in the window.
        SELECT FROM busy WHERE busy.microsoft_series_id = master.external_event_id
      )
    ), discard AS (
      DELETE FROM calendar_busy old
      WHERE old.calendar_id = ${calendarId}
        AND NOT EXISTS (SELECT FROM busy WHERE busy.external_event_id = old.external_event_id)
        AND (
          ${replace}::boolean
          OR old.external_event_id IN (SELECT external_event_id FROM changes)
          OR old.microsoft_series_id IN (SELECT external_event_id FROM removed_series)
          OR (old.microsoft_series_id, old.microsoft_original_start) IN (
            SELECT microsoft_series_id, microsoft_original_start FROM slots
          )
        )
    )
    INSERT INTO calendar_busy (calendar_id, external_event_id, period, microsoft_series_id, microsoft_original_start)
    SELECT calendar_id, external_event_id, period, microsoft_series_id, microsoft_original_start
    FROM busy
    ON CONFLICT (calendar_id, external_event_id) DO UPDATE SET
      period = excluded.period,
      all_day_start = NULL,
      all_day_end = NULL,
      microsoft_series_id = excluded.microsoft_series_id,
      microsoft_original_start = excluded.microsoft_original_start
    WHERE (calendar_busy.period, calendar_busy.microsoft_series_id, calendar_busy.microsoft_original_start)
      IS DISTINCT FROM (excluded.period, excluded.microsoft_series_id, excluded.microsoft_original_start)
  `.execute(trx)
  await clearMicrosoftChanges(trx, calendarId)
}
