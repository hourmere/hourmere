import type { Db } from '@hourmere/db'
import { type Expression, sql } from 'kysely'

/** The deadline before applying the 30-minute cap. Null means no confirmed roots remain. */
export function seriesConfirmationDeadline(
  organizationId: Expression<string>,
  seriesId: Expression<string>,
  committedAt: Expression<Date>,
  now: Date,
) {
  return sql<Date | null>`(
    SELECT CASE
      WHEN NOT bool_or(member.pending AND member.start_at > ${now}) OVER ()
        THEN ${now}::timestamptz
      ELSE GREATEST(
        member.start_at - interval '15 minutes',
        LEAST(member.start_at, ${committedAt} + interval '5 minutes',
          CASE WHEN NOT member.pending THEN ${now}::timestamptz END)
      )
    END
    FROM (
      SELECT b.start_at, (
        b.location -> 'autoCreate' IS NOT DISTINCT FROM 'true'::jsonb
        AND NOT coalesce(c.state = 'failed'
          OR (c.state = 'ready' AND c.applied_revision = c.revision), false)
      ) AS pending
      FROM booking_series_occurrences o
      JOIN bookings b ON (b.organization_id, b.id) = (o.organization_id, o.root_booking_id)
      LEFT JOIN booking_conferences c ON (c.organization_id, c.root_booking_id, c.booking_id)
        = (b.organization_id, b.id, b.id)
      WHERE (o.organization_id, o.series_id) = (${organizationId}, ${seriesId})
        AND b.status = 'confirmed' AND b.start_at >= ${committedAt}
    ) member
    -- Keep an elapsed start deadline between sweeps. A started root no longer counts as pending.
    ORDER BY member.start_at LIMIT 1
  )`
}

export async function recordSeriesConferenceDeadline(trx: Db, occurrenceId: string, now: Date) {
  // Serialize conference results for the same outbox row. The following statement sees
  // the previously committed results as well as this transaction's own result.
  const intent = await trx
    .selectFrom('booking_series_occurrences as o')
    .innerJoin('booking_series as s', (join) =>
      join.onRef('s.id', '=', 'o.series_id').onRef('s.organization_id', '=', 'o.organization_id'),
    )
    .innerJoin('booking_series_notifications as n', (join) =>
      join.onRef('n.series_id', '=', 's.id').onRef('n.organization_id', '=', 's.organization_id'),
    )
    .select(['n.id', 's.id as seriesId', 's.organization_id', 's.created_at'])
    .where('o.id', '=', occurrenceId)
    .where('n.row_type', '=', 'outbox')
    .where('n.kind', '=', 'confirmation')
    .where('n.outbox_state', '=', 'pending')
    .where('n.attempts', '=', 0)
    .where('n.due_at', '>', now)
    .forUpdate('n')
    .executeTakeFirst()
  if (!intent) return

  const deadline = seriesConfirmationDeadline(
    sql.val(intent.organization_id),
    sql.val(intent.seriesId),
    sql<Date>`${intent.created_at}::timestamptz`,
    now,
  )
  // A member can be removed before a future lead point. Keep that deadline dynamic
  // until it is actually reached.
  await sql`
    WITH readiness AS (SELECT ${deadline} AS due_at)
    UPDATE booking_series_notifications n SET due_at = readiness.due_at
    FROM readiness
    WHERE n.id = ${intent.id} AND readiness.due_at <= ${now} AND readiness.due_at < n.due_at
  `.execute(trx)
}
