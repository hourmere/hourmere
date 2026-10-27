import type { Db } from '@hourmere/db'
import { DomainError } from './errors.ts'

const invalidHosts = () =>
  new DomainError('invalid', 'invalid_hosts', 'Hosts must be current verified organization members')

export interface HostUserFact {
  id: string
  emailVerified: boolean
}

export interface HostMembershipFact {
  userId: string
  organizationId: string
}

/** The same host cardinality applies to cached configuration reads and public resolution. */
export function hasValidHostShape(mode: string, hostIds: readonly string[]): boolean {
  if (mode !== 'individual' && mode !== 'collective' && mode !== 'round_robin') return false
  return (
    new Set(hostIds).size === hostIds.length &&
    hostIds.length >= (mode === 'collective' ? 2 : 1) &&
    hostIds.length <= (mode === 'individual' ? 1 : 8)
  )
}

/** Evaluate complete, already loaded facts without making one query per event or member. */
export function eligibleHostIds(
  organizationId: string,
  configured: readonly string[],
  users: readonly HostUserFact[],
  members: readonly HostMembershipFact[],
): string[] {
  const ids = [...new Set(configured)].sort()
  if (!ids.length || ids.length > 8) return []
  const verified = new Set(users.filter((user) => user.emailVerified).map((user) => user.id))
  const membership = new Set(
    members
      .filter((member) => member.organizationId === organizationId)
      .map((member) => member.userId),
  )
  return ids.filter((id) => verified.has(id) && membership.has(id))
}

/** Hold current membership and verification until a host assignment or booking commits. */
export async function assertHosts(
  db: Db,
  organizationId: string,
  userIds: readonly string[],
  lock = false,
): Promise<void> {
  const ids = [...new Set(userIds)].sort()
  if (!ids.length || ids.length > 8) throw invalidHosts()
  let users = db
    .selectFrom('auth.user')
    .select(['id', 'emailVerified'])
    .where('id', 'in', ids)
    .orderBy('id')
  if (lock) users = users.forShare()
  const verified = await users.execute()
  let members = db
    .selectFrom('auth.member')
    .select(['userId', 'organizationId'])
    .where('organizationId', '=', organizationId)
    .where('userId', 'in', ids)
    .orderBy('userId')
  if (lock) members = members.forShare()
  const current = await members.execute()
  if (eligibleHostIds(organizationId, ids, verified, current).length !== ids.length)
    throw invalidHosts()
}

/** Missing original hosts fail closed even after auth.user cascades booking_hosts. */
export async function bookingHostIds(
  db: Db,
  bookingId: string,
  organizationId: string,
  required: readonly string[],
  lock = false,
): Promise<string[]> {
  const hosts = await db
    .selectFrom('booking_hosts')
    .select('user_id')
    .where('booking_id', '=', bookingId)
    .orderBy('user_id')
    .execute()
  const ids = required.length ? [...required].sort() : hosts.map((h) => h.user_id)
  if (!ids.length)
    throw new DomainError(
      'conflict',
      'booking_has_no_host',
      'This booking has no host, so it cannot be rescheduled',
    )
  if (ids.length !== hosts.length || ids.some((id, index) => id !== hosts[index]?.user_id)) {
    throw new DomainError(
      'conflict',
      'booking_hosts_unavailable',
      'An original required host is no longer available',
    )
  }
  try {
    await assertHosts(db, organizationId, ids, lock)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'invalid_hosts')
      throw new DomainError(
        'conflict',
        'booking_hosts_unavailable',
        'An original required host is no longer a verified organization member',
      )
    throw error
  }
  return ids
}

/** Parent first: organization deletion cascades through members, event types and bookings. */
export async function lockOrganization(db: Db, id: string): Promise<void> {
  // Deleting a personal owner first locks auth.user, then deletes its personal org.
  // Team deletion instead locks the organization before cascading its dependent rows.
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', id)
    .executeTakeFirst()
  if (personal) {
    const user = await db
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', personal.user_id)
      .forShare()
      .executeTakeFirst()
    if (!user) throw new DomainError('not_found', 'event_type_not_found', 'No such event type')
  }
  const row = await db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', id)
    .forShare()
    .executeTakeFirst()
  if (!row) throw new DomainError('not_found', 'event_type_not_found', 'No such event type')
}
