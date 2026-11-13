// Routing target invalidation for event-type mutations (docs/routing-forms.md, step a4). Event
// type deletion and updates call this in their own transaction, after their write and while
// they hold the organization lock and the event type's row lock, so a publication targeting
// the event type either finished before (and is marked here) or waits and then refuses it.
// Routing never blocks the mutation, and with no routing form this is one indexed read.
import { type Db, routingTargetsInUse, setRoutingTargetHealth } from '@hourmere/db'
import { loadRoutingTargetEvents, routingTargetProblem } from './routing-form-targets.ts'

/**
 * Rederives, from their current rows, the eligibility of these event types where a live form's
 * current published version targets them, and sets those targets' health markers (`ok` or
 * `unavailable`), fallback targets included.
 */
export async function refreshRoutingTargetHealth(
  db: Db,
  organizationId: string,
  eventTypeIds: readonly string[],
  checkedAt: Date,
): Promise<void> {
  const targeted = await routingTargetsInUse(db, organizationId, eventTypeIds)
  if (targeted.length === 0) return
  const events = await loadRoutingTargetEvents(db, targeted)
  await setRoutingTargetHealth(
    db,
    organizationId,
    targeted.map((eventTypeId) => ({
      eventTypeId,
      health:
        routingTargetProblem(organizationId, events.get(eventTypeId)) === undefined
          ? 'ok'
          : 'unavailable',
    })),
    checkedAt,
  )
}
