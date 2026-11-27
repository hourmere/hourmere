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

export interface DepartureHandoffSourceInput {
  teamId: string
  expectedOrganizationId: string
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
  const capabilities = withScimResources(
    ssoCapabilities,
    ctx.scimResourcesEnabled || ctx.principal.scimResourcesEnabled,
  )
  const principal = capabilities.scimResourcesEnabled
    ? { ...ctx.principal, scimResourcesEnabled: true as const }
    : ctx.principal

  return teamWriteTransaction(
    ctx.db.transaction().setIsolationLevel('read committed'),
    async (trx) => {
      await ctx.lockOrganizationContext?.(trx)
      const actor = await checkTeamManagementAccess(trx, principal, input.teamId, 'share', {
        expectedOrganizationId: input.expectedOrganizationId,
        allowPersonal: false,
      }).catch(rethrowTeamManagementError)
      recordTeamWriteOrganizationLock(trx, actor.organizationId)
      const deadline = await lockSharedTeamSsoProof(
        trx,
        capabilities,
        { userId: principal.user.id, sessionId: principal.sessionId },
        actor.organizationId,
        ssoRequired,
      )
      const source = await lockDepartureHandoffSource(trx, actor.organizationId, input.bookingId)
      if (!source) throw handoffBookingNotFound()

      const result = await write(
        { ...ctx, db: trx, principal, scimResourcesEnabled: capabilities.scimResourcesEnabled },
        { organizationId: actor.organizationId, sourceBookingId: source.id },
        { userId: actor.userId, sessionId: principal.sessionId },
        source,
      )
      await checkTeamWriteDeadline(trx, deadline, ssoRequired)
      await teamSession(trx, principal, false).catch(rethrowTeamManagementError)
      return result
    },
  )
}
