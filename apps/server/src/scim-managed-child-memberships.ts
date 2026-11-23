import { teamRoles } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import {
  lockScimCredentialRevocation,
  revokeScimTeamCredentials,
} from '@hourmere/db/scim-suspension'
import { hasTeamMemberDepartureImpact } from '@hourmere/scheduling'
import { sql, type Transaction } from 'kysely'
import type { ScimResourceRequest } from './scim.ts'
import { lockMappingTeams } from './scim-team-mapping-retirement.ts'
import { lockScimWriteConnection, refuse } from './scim-user-write.ts'

type Principal = ScimResourceRequest['principal']

interface SourceUser {
  id: string
  organization_id: string
  connection_id: string
}

export interface ManagedChildMembership {
  memberId: string
  role: string
  userId: string
  childId: string
}

const protectedMember = () =>
  refuse(
    403,
    'An owner or admin of a team must be changed through ordinary team administration first.',
    'mutability',
  )
const departureBlocked = () =>
  refuse(
    409,
    'A member still hosts event types or unfinished bookings in the mapped team. Reassign them through ordinary team administration first.',
  )
const changedTeams = () =>
  refuse(409, 'The memberships of this User changed during the request. Send it again.')

/** Rows of this User's roster entries on mappings that still have directory authority. */
function sourced(db: Db, organizationId: string, scimUserId: string) {
  return db
    .selectFrom('scim_team_managed_memberships as source')
    .innerJoin('scim_team_mappings as mapping', 'mapping.id', 'source.mapping_id')
    .where('source.scim_user_id', '=', scimUserId)
    .where('mapping.live_parent_organization_id', '=', organizationId)
    .where('mapping.suspended_at', 'is', null)
}

async function childTeams(db: Db, organizationId: string, scimUserId: string) {
  const rows = await sourced(db, organizationId, scimUserId)
    .select('source.child_organization_id as id')
    .distinct()
    .execute()
  return rows.map(({ id }) => id)
}

class ChangedTeams extends Error {}

/**
 * Run a User write holding the parent and every child team in which the User sources a
 * managed membership. The teams are read first, locked in ascending ID order, then read
 * again: a Group write that added another team in between restarts the transaction.
 */
export async function scimUserWriteTransaction<T>(
  db: Db,
  principal: Principal,
  scimUserId: string,
  write: (trx: Transaction<Database>, connectionId: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          const { organizationId } = principal
          const expected = await childTeams(trx, organizationId, scimUserId)
          if (expected.length > 0) await lockMappingTeams(trx, [organizationId, ...expected])
          // Group writes hold the parent lock, so the roster of this User is now stable.
          const connectionId = await lockScimWriteConnection(trx, principal)
          const current = await childTeams(trx, organizationId, scimUserId)
          if (current.some((id) => !expected.includes(id))) throw new ChangedTeams()
          return write(trx, connectionId)
        })
    } catch (error) {
      if (!(error instanceof ChangedTeams)) throw error
      if (attempt === 3) throw changedTeams()
    }
  }
}

/** The caller holds the parent and child team locks. Locks the child membership rows. */
export function sourcedChildMemberships(
  trx: Transaction<Database>,
  entry: SourceUser,
): Promise<ManagedChildMembership[]> {
  return sourced(trx, entry.organization_id, entry.id)
    .innerJoin('auth.member as member', 'member.id', 'source.member_id')
    .where('mapping.live_connection_id', '=', entry.connection_id)
    .select([
      'member.id as memberId',
      'member.role',
      'member.userId',
      'source.child_organization_id as childId',
    ])
    .orderBy('member.userId')
    .orderBy('source.child_organization_id')
    .forUpdate('member')
    .execute()
}

/** The caller holds both team locks and the mapping. Locks the child membership rows. */
export function rosterMemberships(
  trx: Transaction<Database>,
  mappingId: string,
  childId: string,
  scimUserIds: string[],
): Promise<ManagedChildMembership[]> {
  return trx
    .selectFrom('scim_team_managed_memberships as source')
    .innerJoin('auth.member as member', 'member.id', 'source.member_id')
    .where('source.mapping_id', '=', mappingId)
    .where('source.child_organization_id', '=', childId)
    .where('source.scim_user_id', 'in', scimUserIds)
    .select([
      'member.id as memberId',
      'member.role',
      'member.userId',
      'source.child_organization_id as childId',
    ])
    .orderBy('member.userId')
    .forUpdate('member')
    .execute()
}

/** Directory writes never suspend or remove a current owner or admin of the child. */
export function rejectPrivilegedChildMembership(memberships: ManagedChildMembership[]) {
  if (
    memberships.some(({ role }) =>
      teamRoles(role).some((item) => item === 'owner' || item === 'admin'),
    )
  )
    throw protectedMember()
}

// Rows arrive ordered by account, the order of the per-account revocation locks.
async function revokeChildCredentials(
  trx: Transaction<Database>,
  memberships: ManagedChildMembership[],
) {
  for (const userId of new Set(memberships.map((membership) => membership.userId)))
    await lockScimCredentialRevocation(trx, userId)
  for (const { childId, userId } of memberships)
    await revokeScimTeamCredentials(trx, childId, userId)
}

/**
 * End managed child access through the ordinary departure checks. Every row is checked
 * before the first one is removed, and the caller's transaction rolls back on refusal.
 */
export async function removeManagedChildMemberships(
  trx: Transaction<Database>,
  memberships: ManagedChildMembership[],
) {
  rejectPrivilegedChildMembership(memberships)
  for (const { childId, userId } of memberships) {
    if (await hasTeamMemberDepartureImpact(trx, { teamId: childId, memberUserId: userId }))
      throw departureBlocked()
  }
  await revokeChildCredentials(trx, memberships)
  if (memberships.length === 0) return
  // Removes the provenance row, and any suspension on it, through its scoped foreign key.
  await trx
    .deleteFrom('auth.member')
    .where(
      'id',
      'in',
      memberships.map(({ memberId }) => memberId),
    )
    .execute()
}

/** Deactivating the source User suspends the child memberships it sourced. */
export async function suspendManagedChildMemberships(
  trx: Transaction<Database>,
  memberships: ManagedChildMembership[],
) {
  if (memberships.length === 0) return
  await revokeChildCredentials(trx, memberships)
  await trx
    .updateTable('scim_team_managed_memberships')
    .set({ suspended_at: sql<Date>`clock_timestamp()` })
    .where(
      'member_id',
      'in',
      memberships.map(({ memberId }) => memberId),
    )
    .where('suspended_at', 'is', null)
    .execute()
}

/** Reactivation lifts only this source's suspension, on mappings with directory authority. */
export async function resumeManagedChildMemberships(trx: Transaction<Database>, entry: SourceUser) {
  await trx
    .updateTable('scim_team_managed_memberships')
    .set({ suspended_at: null })
    .where('scim_user_id', '=', entry.id)
    .where('suspended_at', 'is not', null)
    .where('mapping_id', 'in', (eb) =>
      eb
        .selectFrom('scim_team_mappings')
        .select('id')
        .where('live_parent_organization_id', '=', entry.organization_id)
        .where('live_connection_id', '=', entry.connection_id)
        .where('suspended_at', 'is', null),
    )
    .execute()
}
