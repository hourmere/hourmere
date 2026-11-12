// Routing target lifecycle and retention (docs/routing-forms.md, step a4). Routing stays
// hard-off: these functions run inside existing event-type and membership mutations and in a
// background job, and with no routing form they find nothing and write nothing.
//
// Health markers. Publication writes one dependency row per event target of a version,
// fallback included, with health `ok`. The mutations that can make a target ineligible (event
// type deletion, an event type update such as disabling, and the deactivations of an
// administrative member removal) set the marker in their own transaction, while they hold the
// organization lock and the changed event types' row locks. Only the current published version
// of each live (not archived) form is marked, so one mutation touches at most the form quota's
// worth of rows. Marking locks dependency rows only, never a form or receipt, so it keeps the
// organization → event → form → receipt order. Reads never trust a marker: they rederive
// health from the current event types.
//
// Retention. Receipts that expired unconsumed are deleted, and their encrypted answers with
// them; consumed receipts are booking evidence and go only with their booking. A version that
// is not its form's current version and that no receipt references is deleted with its
// dependency rows. Each call is one transaction over a bounded batch that locks only its own
// rows with SKIP LOCKED, so cleanup never waits for another transaction and takes no
// organization, event, host or form lock.
import { type Kysely, sql } from 'kysely'
import type { DB } from './tables.ts'

type Db = Kysely<DB>

export type RoutingTargetHealthCode = 'ok' | 'unavailable' | 'unknown'

/** Expired, unconsumed receipts deleted per transaction. */
export const ROUTING_RECEIPT_PURGE_BATCH = 500
/** Versions examined per cleanup transaction, in ID order. */
export const ROUTING_VERSION_SCAN_BATCH = 1000
/** Versions deleted per cleanup transaction, at most. */
export const ROUTING_VERSION_CLEANUP_BATCH = 100

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

const sorted = (ids: readonly string[]) => [...new Set(ids)].sort()

function batchSize(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`)
  return value
}

/** Of these event types, the ones a live form's current published version targets. */
export async function routingTargetsInUse(
  db: Db,
  organizationId: string,
  eventTypeIds: readonly string[],
): Promise<string[]> {
  const ids = sorted(eventTypeIds)
  if (ids.length === 0) return []
  const { rows } = await sql<{ event_type_id: string }>`
    SELECT DISTINCT d.event_type_id
    FROM routing_target_dependencies d
    JOIN routing_forms f
      ON f.organization_id = d.organization_id AND f.published_version_id = d.version_id
    WHERE d.organization_id = ${organizationId}::uuid
      AND d.event_type_id = ANY(${ids}::uuid[])
      AND f.archived_at IS NULL
    ORDER BY d.event_type_id`.execute(db)
  return rows.map((row) => row.event_type_id)
}

/**
 * Sets the health marker of each event type's targets, rule and fallback alike, on the current
 * published version of every live form of the organization. Rows already at that health keep
 * their check time. Call it in the transaction that changed those event types, holding the
 * organization and the event-type row locks. Returns the number of rows changed.
 */
export async function setRoutingTargetHealth(
  db: Db,
  organizationId: string,
  updates: readonly { eventTypeId: string; health: RoutingTargetHealthCode }[],
  checkedAt: Date,
): Promise<number> {
  let changed = 0
  for (const health of ['ok', 'unavailable', 'unknown'] as const) {
    const ids = sorted(
      updates.filter((update) => update.health === health).map((u) => u.eventTypeId),
    )
    if (ids.length === 0) continue
    // UPDATE … FROM locks the dependency rows only, not the joined forms.
    const result = await sql`
      UPDATE routing_target_dependencies d
      SET health_code = ${health}, health_checked_at = ${checkedAt}
      FROM routing_forms f
      WHERE d.organization_id = ${organizationId}::uuid
        AND d.event_type_id = ANY(${ids}::uuid[])
        AND f.organization_id = d.organization_id
        AND f.published_version_id = d.version_id
        AND f.archived_at IS NULL
        AND d.health_code <> ${health}`.execute(db)
    changed += Number(result.numAffectedRows ?? 0)
  }
  return changed
}

/**
 * Deletes up to `limit` receipts that expired unconsumed, oldest first, with their encrypted
 * answers, in one transaction. Consumed receipts are never touched. A receipt another
 * transaction holds (a booking consuming it, say) is skipped for a later run. Returns the number
 * deleted.
 */
export async function purgeExpiredRoutingReceipts(
  db: Db,
  limit: number = ROUTING_RECEIPT_PURGE_BATCH,
): Promise<number> {
  const batch = batchSize(limit, 'limit')
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM routing_receipts
      WHERE consumed_booking_id IS NULL AND expires_at <= statement_timestamp()
      ORDER BY expires_at, id
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`.execute(trx)
    if (rows.length === 0) return 0
    const result = await sql`
      DELETE FROM routing_receipts
      WHERE id = ANY(${rows.map((row) => row.id)}::uuid[]) AND consumed_booking_id IS NULL`.execute(
      trx,
    )
    return Number(result.numAffectedRows ?? 0)
  })
}

export interface RoutingVersionCleanup {
  deleted: number
  /** The ID to continue after, or null once the last version has been examined. */
  next: string | null
}

/**
 * Examines up to `scan` versions after `after`, in ID order, and deletes at most `limit` of
 * them: those that are not their form's current version and that no receipt references, with
 * their dependency rows. Versions, or dependency rows, that another transaction holds are left
 * for a later sweep. One transaction; it never waits for a lock.
 */
export async function deleteUnreferencedRoutingVersions(
  db: Db,
  options: { after?: string | null; scan?: number; limit?: number } = {},
): Promise<RoutingVersionCleanup> {
  const scan = batchSize(options.scan ?? ROUTING_VERSION_SCAN_BATCH, 'scan')
  const limit = batchSize(options.limit ?? ROUTING_VERSION_CLEANUP_BATCH, 'limit')
  return db.transaction().execute(async (trx) => {
    const { rows: window } = await sql<{ id: string }>`
      SELECT id FROM routing_form_versions
      WHERE id > ${options.after ?? NIL_UUID}::uuid
      ORDER BY id
      LIMIT ${scan}`.execute(trx)
    const last = window.at(-1)?.id
    if (last === undefined) return { deleted: 0, next: null }
    const { rows: candidates } = await sql<{ id: string }>`
      SELECT v.id FROM routing_form_versions v
      JOIN routing_forms f ON f.organization_id = v.organization_id AND f.id = v.form_id
      WHERE v.id = ANY(${window.map((row) => row.id)}::uuid[])
        AND f.published_version_id IS DISTINCT FROM v.id
        AND NOT EXISTS (
          SELECT FROM routing_receipts r
          WHERE r.organization_id = v.organization_id AND r.form_id = v.form_id
            AND r.version_id = v.id
        )
      ORDER BY v.id
      LIMIT ${limit}
      FOR UPDATE OF v SKIP LOCKED`.execute(trx)
    // A full batch may leave candidates later in the window: continue after the last one.
    const next =
      candidates.length === limit
        ? (candidates.at(-1)?.id ?? last)
        : window.length < scan
          ? null
          : last
    let ids = candidates.map((row) => row.id)
    if (ids.length > 0) {
      // Lock the dependency rows the deletion cascades to, skipping held ones, so that the
      // cascade never waits; a version with a held row is left for a later sweep.
      const { rows: locked } = await sql<{ version_id: string }>`
        SELECT version_id FROM routing_target_dependencies
        WHERE version_id = ANY(${ids}::uuid[])
        FOR UPDATE SKIP LOCKED`.execute(trx)
      const { rows: totals } = await sql<{ version_id: string; count: number }>`
        SELECT version_id, count(*)::int AS count FROM routing_target_dependencies
        WHERE version_id = ANY(${ids}::uuid[])
        GROUP BY version_id`.execute(trx)
      const held = new Map<string, number>()
      for (const row of locked) held.set(row.version_id, (held.get(row.version_id) ?? 0) + 1)
      const busy = new Set(
        totals
          .filter((row) => (held.get(row.version_id) ?? 0) < row.count)
          .map((row) => row.version_id),
      )
      ids = ids.filter((id) => !busy.has(id))
    }
    if (ids.length === 0) return { deleted: 0, next }
    const result = await sql`
      DELETE FROM routing_form_versions WHERE id = ANY(${ids}::uuid[])`.execute(trx)
    return { deleted: Number(result.numAffectedRows ?? 0), next }
  })
}
