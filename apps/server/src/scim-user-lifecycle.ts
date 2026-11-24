import { teamRoles } from '@hourmere/auth'
import type { Database } from '@hourmere/db'
import { suspendScimMembership } from '@hourmere/db/scim-suspension'
import { sql, type Transaction } from 'kysely'
import {
  rejectPrivilegedChildMembership,
  resumeManagedChildMemberships,
  sourcedChildMemberships,
  suspendManagedChildMemberships,
} from './scim-managed-child-memberships.ts'
import { immutableScimPrivileges, refuse } from './scim-user-write.ts'

interface LifecycleWrite {
  active: boolean | undefined
  deactivationRequested: boolean
  roleWrite: boolean
}

interface LifecycleEntry {
  id: string
  organization_id: string
  connection_id: string
  linked_user_id: string | null
}

const locallyBlocked = () =>
  refuse(
    403,
    'This membership must be restored through ordinary team administration.',
    'mutability',
  )

// Inspect the account's current membership even if removal cleared the original link.
// Local role writes already serialize on the organization row.
function linkedMemberships(trx: Transaction<Database>, entry: LifecycleEntry, userId: string) {
  return trx
    .selectFrom('auth.user as account')
    .leftJoin('auth.member as member', (join) =>
      join
        .onRef('member.userId', '=', 'account.id')
        .on('member.organizationId', '=', entry.organization_id),
    )
    .select(['member.id as memberId', 'member.role', 'account.email', 'account.emailVerified'])
    .where('account.id', '=', userId)
    .execute()
}

function rejectPrivilegedMembership(memberships: { role: string | null }[]) {
  if (memberships.some(({ role }) => teamRoles(role).some((r) => r === 'owner' || r === 'admin')))
    throw immutableScimPrivileges()
}

/** The caller holds the organization update lock and the live resource row lock. */
export async function assertScimUserCanRetire(trx: Transaction<Database>, entry: LifecycleEntry) {
  if (entry.linked_user_id !== null)
    rejectPrivilegedMembership(await linkedMemberships(trx, entry, entry.linked_user_id))
}

/**
 * The caller holds the update locks of the organization and of the child teams in which
 * this User sources a managed membership, and the live resource row lock. A returned
 * reply is a refusal whose child changes the caller must still commit.
 */
export async function applyScimUserLifecycle(
  trx: Transaction<Database>,
  entry: LifecycleEntry & { active: boolean },
  { active, deactivationRequested, roleWrite }: LifecycleWrite,
  actor: { type: 'scim_token'; id: string },
) {
  const reactivating = active === true && !entry.active
  if (!reactivating && !deactivationRequested && !roleWrite) return
  // Child access follows the roster source, so check it before any state changes.
  const sourced = deactivationRequested ? await sourcedChildMemberships(trx, entry) : []
  rejectPrivilegedChildMembership(sourced)
  const resumed = reactivating ? await resumeManagedChildMemberships(trx, entry) : 0
  const blocked = await applyParentLifecycle(
    trx,
    entry,
    { active, deactivationRequested, roleWrite },
    actor,
  )
  if (blocked) {
    // The parent's own blocker decides only parent access. The caller commits the child
    // resume with this refusal and applies nothing else from the request.
    if (resumed > 0) return blocked.reply
    throw blocked
  }
  // The entry stays inactive after a refused reactivation, so a repeated deactivation
  // suspends again whatever that reactivation resumed.
  if (active === false) await suspendManagedChildMemberships(trx, sourced)
}

async function applyParentLifecycle(
  trx: Transaction<Database>,
  entry: LifecycleEntry & { active: boolean },
  { active, deactivationRequested, roleWrite }: LifecycleWrite,
  actor: { type: 'scim_token'; id: string },
) {
  const userId = entry.linked_user_id
  if (userId === null) return
  const reactivating = active === true && !entry.active
  const organizationId = entry.organization_id
  const memberships = await linkedMemberships(trx, entry, userId)
  if (deactivationRequested || roleWrite) rejectPrivilegedMembership(memberships)

  if (reactivating) {
    // The account link is the proof. The provisioned work address is only profile data.
    const account = memberships[0]
    const mailbox = account?.emailVerified ? account.email.trim().toLowerCase() : null
    const localBlock = await trx
      .selectFrom('scim_membership_blocks')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('source', '=', 'local')
      .where('cleared_at', 'is', null)
      .where((eb) => eb.or([eb('user_id', '=', userId), eb('identity_email', '=', mailbox)]))
      .executeTakeFirst()
    if (localBlock || !memberships.some(({ memberId }) => memberId !== null))
      return locallyBlocked()
    await trx
      .updateTable('scim_membership_blocks')
      .set({ cleared_at: sql<Date>`clock_timestamp()` })
      .where('organization_id', '=', organizationId)
      .where('connection_id', '=', entry.connection_id)
      .where('scim_user_id', '=', entry.id)
      .where('user_id', '=', userId)
      .where('source', '=', 'scim')
      .where('kind', '=', 'suspension')
      .where('cleared_at', 'is', null)
      .execute()
  } else if (active === false && entry.active) {
    await suspendScimMembership(
      trx,
      { organizationId, userId, connectionId: entry.connection_id, scimUserId: entry.id },
      actor,
    )
  }
}
