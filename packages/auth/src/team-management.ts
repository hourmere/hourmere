import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type { Principal } from './caller.ts'

export interface TeamManager {
  userId: string
  organizationId: string
  role: 'owner' | 'admin'
}

interface TeamReader extends Omit<TeamManager, 'role'> {
  role: 'owner' | 'admin' | 'member'
}

const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
export class TeamManagementError extends Error {
  readonly code: 'team_management_access_denied' | 'organization_context_changed'

  constructor(code: 'team_management_access_denied' | 'organization_context_changed') {
    super(code)
    this.code = code
  }
}

export const teamManagementDenied = () => new TeamManagementError('team_management_access_denied')
const denied = teamManagementDenied
const contextChanged = () => new TeamManagementError('organization_context_changed')

export const teamRoles = (role: string | null | undefined): string[] =>
  role?.split(',').map((token) => token.trim()) ?? []

type TeamSession = Extract<Principal, { kind: 'session' }>

/** First lock in every team write, including target-bound invitation acceptance. */
export async function teamSessionUser(db: Db, principal: TeamSession, lock: boolean) {
  if (!uuid(principal.user.id) || !uuid(principal.sessionId)) throw denied()
  let query = db
    .selectFrom('auth.user')
    .select(['email', 'emailVerified'])
    .where('id', '=', principal.user.id)
  if (lock) query = query.forShare()
  const user = await query.executeTakeFirst()
  if (!user?.emailVerified) throw denied()
  return user
}

/** Last actor lock: verify expiry after waiting, using wall time rather than BEGIN time. */
export async function teamSession(db: Db, principal: TeamSession, lock: boolean) {
  let query = db
    .selectFrom('auth.session')
    .select(['expiresAt', 'activeOrganizationId'])
    .where('id', '=', principal.sessionId)
    .where('userId', '=', principal.user.id)
  if (lock) query = query.forShare()
  const session = await query.executeTakeFirst()
  if (!session) throw denied()
  const validity = await db
    .selectNoFrom(sql<boolean>`${session.expiresAt}::timestamptz > clock_timestamp()`.as('active'))
    .executeTakeFirstOrThrow()
  if (!validity.active) throw denied()
  return session
}

/** Current database facts only: principal organization metadata and client roles are not authority. */
export async function checkTeamManagementAccess(
  db: Db,
  principal: Principal,
  teamId: string,
  lock: boolean | 'key share' = false,
  context?: { expectedOrganizationId: string; allowPersonal: boolean },
  allowMemberRead = false,
): Promise<TeamReader> {
  const expectedTeamId =
    context &&
    !context.allowPersonal &&
    uuid(context.expectedOrganizationId) &&
    context.expectedOrganizationId.toLowerCase() !== principal.organization.id.toLowerCase()
      ? context.expectedOrganizationId
      : undefined
  const authorizationTeamId = expectedTeamId ?? teamId
  if (
    context &&
    !expectedTeamId &&
    (!uuid(context.expectedOrganizationId) ||
      context.expectedOrganizationId.toLowerCase() !== teamId.toLowerCase())
  )
    throw contextChanged()
  if (
    principal.kind !== 'session' ||
    !uuid(principal.user.id) ||
    !uuid(principal.sessionId) ||
    !uuid(teamId) ||
    (!expectedTeamId && teamId.toLowerCase() !== principal.organization.id.toLowerCase())
  )
    throw denied()

  await teamSessionUser(db, principal, Boolean(lock))

  let organizationQuery = db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', authorizationTeamId)
  // Serialize team-management writes, including organization edits and self role changes,
  // without competing SHARE → UPDATE upgrades in their callbacks.
  if (lock === true) organizationQuery = organizationQuery.forUpdate()
  // Webhook mutations already hold user → organization → endpoint locks. Rechecking
  // member/session authority must not upgrade their organization KEY SHARE to UPDATE,
  // which could deadlock mutations of different endpoints in the same organization.
  if (lock === 'key share') organizationQuery = organizationQuery.forKeyShare()
  const organization = await organizationQuery.executeTakeFirst()
  if (!organization) throw denied()
  const membership = await checkTeamManagementMembership(
    db,
    principal.user.id,
    authorizationTeamId,
    Boolean(lock),
    context?.allowPersonal,
    allowMemberRead,
  )
  const { personal, role } = membership

  // Refuse a session invalidated since caller resolution, including email-proof rotation.
  const session = await teamSession(db, principal, Boolean(lock))

  // A stale browser page may now be in personal space or a member-only team. Validate
  // its expected team's authority before distinguishing a context change. Self-service
  // callers may retain any member role; management callers still require owner/admin.
  if (expectedTeamId) throw contextChanged()

  if (context && session.activeOrganizationId?.toLowerCase() !== organization.id.toLowerCase()) {
    // The caller resolver falls back to the personal organization when the active team's
    // membership has gone. Recompute that effective context from current database facts.
    const activeMembership =
      session.activeOrganizationId && uuid(session.activeOrganizationId)
        ? await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', session.activeOrganizationId)
            .where('userId', '=', principal.user.id)
            .executeTakeFirst()
        : undefined
    if (activeMembership || !personal) {
      if (role === 'member' && !context.allowPersonal && !allowMemberRead) throw denied()
      throw contextChanged()
    }
  }

  return { userId: principal.user.id, organizationId: organization.id, role }
}

/** Shared current-team policy for session management and durable invitation senders. */
export async function checkTeamManagementMembership(
  db: Db,
  userId: string,
  teamId: string,
  lock = false,
  allowPersonal = false,
  allowMemberRead = false,
): Promise<TeamReader & { personal: boolean }> {
  const personal = await db
    .selectFrom('personal_organizations')
    .select('organization_id')
    .where('organization_id', '=', teamId)
    .executeTakeFirst()
  if (personal && !allowPersonal) throw denied()

  // Locking management callers already hold the parent locks, so committed revocation wins.
  let memberQuery = db
    .selectFrom('auth.member')
    .select('role')
    .where('userId', '=', userId)
    .where('organizationId', '=', teamId)
  if (lock) memberQuery = memberQuery.forShare()
  const member = await memberQuery.executeTakeFirst()
  // Better Auth can store multiple roles. Only these exact known tokens grant management.
  const roles = teamRoles(member?.role)
  const role = roles.includes('owner')
    ? 'owner'
    : roles.includes('admin')
      ? 'admin'
      : allowMemberRead && roles.includes('member')
        ? 'member'
        : undefined
  if (!role) throw denied()

  return { userId, organizationId: teamId, role, personal: Boolean(personal) }
}
