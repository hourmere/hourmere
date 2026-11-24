import { type Expression, sql } from 'kysely'

/** A scalar subquery, so callers can read the current booking in the same snapshot. */
export function latestBookingId(id: string | Expression<string>, organizationId?: string) {
  return sql<string>`(SELECT id FROM ${latestBookingInChain(id, organizationId)} AS latest)`
}

export function latestBookingInChain(id: string | Expression<string>, organizationId?: string) {
  const scope =
    organizationId === undefined ? sql`` : sql`WHERE b.organization_id = ${organizationId}`
  return sql<{ id: string; depth: number }>`(
    WITH RECURSIVE chain (id, depth) AS (
      SELECT ${id}::uuid, 0
      UNION ALL
      SELECT b.id, c.depth + 1
        FROM bookings b JOIN chain c ON b.rescheduled_from_id = c.id
        ${scope}
    ) CYCLE id SET is_cycle USING path
    SELECT id, depth FROM chain WHERE NOT is_cycle ORDER BY depth DESC, id LIMIT 1)`
}
