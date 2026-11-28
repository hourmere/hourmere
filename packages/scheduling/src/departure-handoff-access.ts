import {
  checkTeamManagementAccess,
  lockSharedTeamSsoProof,
  TeamManagementError,
  type TeamSsoCapabilities,
  teamSession,
  withScimResources,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import {
  checkTeamWriteDeadline,
  recordTeamWriteOrganizationLock,
  teamWriteTransaction,
} from '@hourmere/db/team-write'
import type { Transaction } from 'kysely'
import type { ServiceContext } from './context.ts'
import { lockDepartureHandoffSource } from './departure-handoff-delivery.ts'
import { DomainError } from './errors.ts'

export interface DepartureHandoffTeamInput {
  teamId: string
  expectedOrganizationId: string
}

export interface DepartureHandoffSourceInput extends DepartureHandoffTeamInput {
  bookingId: string
}

export interface DepartureHandoffWriteContext extends ServiceContext {
  /** Only the session advisory lock. Team row locks belong to this transaction. */
  lockOrganizationContext?: (trx: Db) => Promise<void>
}

export const handoffBookingNotFound = () =>
  new DomainError('not_found', 'booking_not_found', 'No such booking')
export const handoffOfferNotFound = () => new DomainError('not_found', 'handoff_offer_not_found')
export const handoffOfferChanged = () => new DomainError('conflict', 'handoff_offer_changed')

const ssoRequired = (): never => {
  throw new DomainError('forbidden', 'sso_required')
}

function rethrowTeamManagementError(error: unknown): never {
  if (!(error instanceof TeamManagementError)) throw error
  throw new DomainError(
    error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
    error.code,
  )
}

type TeamWriteContext = Pick<
  DepartureHandoffWriteContext,
  'lockOrganizationContext' | 'scimResourcesEnabled'
> & { principal: Parameters<typeof checkTeamManagementAccess>[1] }

export async function lockDepartureHandoffTeam(
  trx: Transaction<Database>,
  ctx: TeamWriteContext,
  input: DepartureHandoffTeamInput,
  ssoCapabilities: TeamSsoCapabilities,
  organizationLock: 'share' | true = 'share',
) {
  if (ctx.principal.kind !== 'session')
    throw new DomainError('forbidden', 'team_management_access_denied')
  const capabilities = withScimResources(
    ssoCapabilities,
    ctx.scimResourcesEnabled || ctx.principal.scimResourcesEnabled,
  )
  const principal = capabilities.scimResourcesEnabled
    ? { ...ctx.principal, scimResourcesEnabled: true as const }
    : ctx.principal
  await ctx.lockOrganizationContext?.(trx)
  const manager = await checkTeamManagementAccess(trx, principal, input.teamId, organizationLock, {
    expectedOrganizationId: input.expectedOrganizationId,
    allowPersonal: false,
  }).catch(rethrowTeamManagementError)
  recordTeamWriteOrganizationLock(trx, manager.organizationId)
  const actor = { userId: manager.userId, sessionId: principal.sessionId }
  const deadline = await lockSharedTeamSsoProof(
    trx,
    capabilities,
    actor,
    manager.organizationId,
    ssoRequired,
  )
  return {
    actor,
    organizationId: manager.organizationId,
    scimResourcesEnabled: capabilities.scimResourcesEnabled,
    async checkDeadline() {
      await checkTeamWriteDeadline(trx, deadline, ssoRequired)
      await teamSession(trx, principal, false).catch(rethrowTeamManagementError)
    },
  }
}

/** Keep proposal and apply on the same current team-management boundary. */
export function withDepartureHandoffWrite<T>(
  ctx: DepartureHandoffWriteContext,
  input: DepartureHandoffSourceInput,
  ssoCapabilities: TeamSsoCapabilities,
  write: (
    ctx: DepartureHandoffWriteContext & { db: Transaction<Database> },
    key: { organizationId: string; sourceBookingId: string },
    actor: { userId: string; sessionId: string },
    source: NonNullable<Awaited<ReturnType<typeof lockDepartureHandoffSource>>>,
  ) => Promise<T>,
): Promise<T> {
  if (ctx.principal.kind !== 'session')
    return Promise.reject(new DomainError('forbidden', 'team_management_access_denied'))
  return teamWriteTransaction(
    ctx.db.transaction().setIsolationLevel('read committed'),
    async (trx) => {
      const team = await lockDepartureHandoffTeam(trx, ctx, input, ssoCapabilities)
      const source = await lockDepartureHandoffSource(trx, team.organizationId, input.bookingId)
      if (!source) throw handoffBookingNotFound()

      const principal = team.scimResourcesEnabled
        ? { ...ctx.principal, scimResourcesEnabled: true as const }
        : ctx.principal
      const result = await write(
        { ...ctx, db: trx, principal, scimResourcesEnabled: team.scimResourcesEnabled },
        { organizationId: team.organizationId, sourceBookingId: source.id },
        team.actor,
        source,
      )
      await team.checkDeadline()
      return result
    },
  )
}
