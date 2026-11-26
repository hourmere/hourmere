import { teamsJoinUrl } from '@hourmere/core/conference-url'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type TeamsMeetingLocation =
  | {
      kind: 'microsoft_teams'
      status: 'join_url_pending' | 'teams_unavailable' | 'writeback_failed'
    }
  | { kind: 'microsoft_teams'; status: 'ready'; url: string }

/** Call only after authorizing the booking or selecting a private mail recipient. */
export async function readTeamsMeetingLocations(
  db: Db,
  bookings: readonly { id: string; location: unknown }[],
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<Map<string, TeamsMeetingLocation>> {
  const ids = bookings
    .filter(({ location }) => isRecord(location) && location.kind === 'microsoft_teams')
    .map(({ id }) => id)
  if (!ids.length) return new Map()

  const { rows } = await sql<{ id: string; writeback: unknown }>`
    WITH RECURSIVE chain(booking_id, id, organization_id, group_slot_id, rescheduled_from_id) AS (
      SELECT id, id, organization_id, group_slot_id, rescheduled_from_id
      FROM bookings WHERE id = ANY(${ids}::uuid[]) AND location->>'kind' = 'microsoft_teams'
        AND (NOT ${activeOnly}::boolean OR status = 'confirmed')
      UNION ALL
      SELECT chain.booking_id, parent.id, parent.organization_id, NULL, parent.rescheduled_from_id
      FROM chain JOIN bookings parent ON parent.id = chain.rescheduled_from_id
        AND parent.organization_id = chain.organization_id AND parent.group_slot_id IS NULL
      WHERE chain.group_slot_id IS NULL
    ) CYCLE id SET is_cycle USING path
    SELECT chain.booking_id AS id, coalesce(slot.microsoft_writeback, target.microsoft_writeback) AS writeback
    FROM chain
    LEFT JOIN group_slots slot ON slot.id = chain.group_slot_id
      AND slot.organization_id = chain.organization_id AND slot.location->>'kind' = 'microsoft_teams'
    LEFT JOIN booking_calendar_targets target ON target.root_booking_id = chain.id
      AND chain.group_slot_id IS NULL AND target.microsoft_writeback ? 'teamsStatus'
      AND EXISTS (SELECT 1 FROM booking_hosts h WHERE h.booking_id = chain.booking_id
        AND h.user_id = target.user_id)
    WHERE NOT is_cycle AND (chain.group_slot_id IS NOT NULL OR chain.rescheduled_from_id IS NULL)
  `.execute(db)

  const output = new Map<string, TeamsMeetingLocation>(
    ids.map((id) => [id, { kind: 'microsoft_teams', status: 'join_url_pending' }]),
  )
  for (const { id, writeback } of rows) {
    if (!isRecord(writeback)) continue
    const url = writeback.teamsStatus === 'ready' ? teamsJoinUrl(writeback.teamsJoinUrl) : undefined
    // A later write can fail while the acknowledged meeting still has a usable URL.
    if (url) output.set(id, { kind: 'microsoft_teams', status: 'ready', url })
    else if (writeback.status === 'failed')
      output.set(id, { kind: 'microsoft_teams', status: 'writeback_failed' })
    else if (writeback.status === 'succeeded' && writeback.teamsStatus === 'teams_unavailable')
      output.set(id, { kind: 'microsoft_teams', status: 'teams_unavailable' })
  }
  return output
}
