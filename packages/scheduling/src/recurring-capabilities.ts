import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { MAX_RECURRING_OCCURRENCES } from './recurring-rules.ts'

export interface SeriesMemberSelector {
  seriesManageToken: string
  ordinal: number
}

export interface SeriesMemberMutationSelector extends SeriesMemberSelector {
  expectedRevision: string
}

interface SeriesCapabilityScope {
  scope: 'read' | 'manage'
  organizationId?: string
  seriesId?: string
}

interface SeriesCapability {
  seriesId: string
  organizationId: string
  revision: string
  guestEmail?: string
}

interface SeriesMember extends SeriesCapability {
  occurrenceId: string
  bookingId: string
}

interface AuthorityRow {
  series_id: string
  organization_id: string
  revision: string
  is_booker: boolean
  email: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/

function scopedAuthority(token: string, options: SeriesCapabilityScope) {
  if (typeof token !== 'string' || token.length !== 43 || !TOKEN.test(token)) return undefined
  if (
    [options.organizationId, options.seriesId].some(
      (id) => id !== undefined && (typeof id !== 'string' || id.length !== 36 || !UUID.test(id)),
    )
  )
    return undefined

  const hash = createHash('sha256').update(token, 'utf8').digest()
  // Receipt attendee IDs must still belong to the series and match their delivery role.
  // The key returned at creation is bound to the first root's primary booker.
  return sql`
    WITH RECURSIVE candidates AS (
      SELECT s.id AS series_id, s.organization_id, s.revision, a.is_booker, a.email
      FROM booking_series s
      JOIN booking_series_occurrences o
        ON o.series_id = s.id AND o.organization_id = s.organization_id AND o.ordinal = 1
      JOIN booking_attendees a ON a.booking_id = o.root_booking_id AND a.is_booker
      WHERE s.manage_token_hash = ${hash}
      UNION ALL
      SELECT s.id AS series_id, s.organization_id, s.revision, a.is_booker, a.email
      FROM booking_series_notifications n
      JOIN booking_series s ON s.id = n.series_id AND s.organization_id = n.organization_id
      JOIN booking_attendees a ON a.id = n.recipient_id
      JOIN bookings b ON b.id = a.booking_id AND b.organization_id = n.organization_id
      JOIN booking_series_occurrences o
        ON o.id = b.series_occurrence_id AND o.organization_id = b.organization_id
          AND o.series_id = n.series_id
      WHERE n.manage_token_hash = ${hash} AND n.row_type = 'receipt' AND n.outcome = 'delivered'
        AND ((a.is_booker AND n.recipient_role = 'booker' AND n.capability_scope = 'manage')
          OR (NOT a.is_booker AND n.recipient_role = 'guest' AND n.capability_scope = 'read'))
    ), authority AS (
      SELECT * FROM candidates
      WHERE (SELECT count(*) FROM candidates) = 1
        AND (${options.scope} = 'read' OR is_booker)
        AND (${options.organizationId ?? null}::uuid IS NULL OR organization_id = ${options.organizationId ?? null}::uuid)
        AND (${options.seriesId ?? null}::uuid IS NULL OR series_id = ${options.seriesId ?? null}::uuid)
    )`
}

function toCapability(row: AuthorityRow): SeriesCapability {
  return {
    seriesId: row.series_id,
    organizationId: row.organization_id,
    revision: row.revision,
    ...(!row.is_booker && { guestEmail: row.email }),
  }
}

/** Looks up an API or successfully delivered series capability by digest and scope. */
export async function resolveSeriesCapability(
  db: Db,
  token: string,
  options: SeriesCapabilityScope,
): Promise<SeriesCapability | undefined> {
  const authority = scopedAuthority(token, options)
  if (!authority) return undefined
  const { rows } = await sql<AuthorityRow>`${authority} SELECT * FROM authority`.execute(db)
  const row = rows[0]
  return row && toCapability(row)
}

/** Resolves an ordinal and its current booking in the same snapshot as the capability. */
export async function resolveSeriesMember(
  db: Db,
  selector: SeriesMemberSelector,
  options: SeriesCapabilityScope,
): Promise<SeriesMember | undefined> {
  const { ordinal } = selector
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_RECURRING_OCCURRENCES)
    return undefined
  const authority = scopedAuthority(selector.seriesManageToken, options)
  if (!authority) return undefined
  const { rows } = await sql<AuthorityRow & { occurrence_id: string; booking_id: string }>`
    ${authority}, chain (occurrence_id, organization_id, booking_id, depth) AS (
      SELECT o.id, o.organization_id, o.root_booking_id, 0
      FROM booking_series_occurrences o JOIN authority a
        ON a.series_id = o.series_id AND a.organization_id = o.organization_id
      WHERE o.ordinal = ${ordinal}
      UNION ALL
      SELECT c.occurrence_id, c.organization_id, b.id, c.depth + 1
      FROM chain c JOIN bookings b ON b.rescheduled_from_id = c.booking_id
        AND b.organization_id = c.organization_id AND b.series_occurrence_id = c.occurrence_id
    ) CYCLE booking_id SET is_cycle USING path,
    latest AS (
      SELECT occurrence_id, booking_id FROM chain WHERE NOT is_cycle
      ORDER BY depth DESC, booking_id LIMIT 1
    )
    SELECT a.*, l.occurrence_id, l.booking_id FROM latest l CROSS JOIN authority a
    WHERE EXISTS (
      SELECT 1 FROM booking_attendees attendee WHERE attendee.booking_id = l.booking_id
        AND attendee.is_booker = a.is_booker AND attendee.email = a.email
    )`.execute(db)
  const row = rows[0]
  return row && { ...toCapability(row), occurrenceId: row.occurrence_id, bookingId: row.booking_id }
}
