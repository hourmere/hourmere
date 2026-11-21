import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { DomainError } from './errors.ts'

export { readEligibleHostIds as eligibleRoundRobinHosts } from './hosts.ts'

/** Call after the event share lock and every configured host's ordered advisory lock. */
export async function lockRoundRobinState(db: Db, eventTypeId: string): Promise<void> {
  const state = await db
    .selectFrom('round_robin_state')
    .select('enabled')
    .where('event_type_id', '=', eventTypeId)
    .forUpdate()
    .executeTakeFirst()
  if (!state?.enabled)
    throw new DomainError(
      'conflict',
      'booking_changed',
      'Round-robin activation changed; try again',
    )
}

/** PostgreSQL orders and increments bigint values exactly; no Number/JSON conversion. */
export async function assignRoundRobinHost(
  db: Db,
  eventTypeId: string,
  available: readonly string[],
): Promise<string> {
  if (!available.length)
    throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
  const winner = await db
    .selectFrom('event_type_hosts')
    .select('user_id')
    .where('event_type_id', '=', eventTypeId)
    .where('user_id', 'in', available)
    .orderBy('last_assigned_sequence')
    .orderBy('user_id')
    .executeTakeFirst()
  if (!winner) throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
  const state = await db
    .updateTable('round_robin_state')
    .set({ next_sequence: sql`next_sequence + 1` })
    .where('event_type_id', '=', eventTypeId)
    .where('enabled', '=', true)
    .returning('next_sequence')
    .executeTakeFirst()
  if (!state)
    throw new DomainError(
      'conflict',
      'booking_changed',
      'Round-robin activation changed; try again',
    )
  await db
    .updateTable('event_type_hosts')
    .set({ last_assigned_sequence: state.next_sequence })
    .where('event_type_id', '=', eventTypeId)
    .where('user_id', '=', winner.user_id)
    .executeTakeFirstOrThrow()
  return winner.user_id
}
