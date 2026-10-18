import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { DomainError } from './errors.ts'

/** Eligibility is an explicit current-data filter, never a swallowed authorization error. */
export async function eligibleRoundRobinHosts(
  db: Db,
  organizationId: string,
  configured: readonly string[],
  lock = false,
): Promise<string[]> {
  const ids = [...new Set(configured)].sort()
  if (!ids.length || ids.length > 8) return []
  let users = db
    .selectFrom('auth.user')
    .select(['id', 'emailVerified'])
    .where('id', 'in', ids)
    .orderBy('id')
  if (lock) users = users.forShare()
  const currentUsers = await users.execute()
  let members = db
    .selectFrom('auth.member')
    .select('userId')
    .where('organizationId', '=', organizationId)
    .where('userId', 'in', ids)
    .orderBy('userId')
  if (lock) members = members.forShare()
  const membership = new Set((await members.execute()).map((member) => member.userId))
  return currentUsers
    .filter((user) => user.emailVerified && membership.has(user.id))
    .map((user) => user.id)
}

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
