import {
  checkTeamManagementAccess,
  ssoHardOff,
  TeamManagementError,
  type TeamSsoCapabilities,
  teamSsoAccess,
  withScimResources,
} from '@hourmere/auth'
import { findSlots, type LocationKind, selectDurationMinutes } from './availability.ts'
import type { ServiceContext } from './context.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { getDepartureHandoffLocation } from './departure-handoff-location.ts'
import { DomainError } from './errors.ts'

export interface DepartureHandoffPreviewInput {
  teamId: string
  bookingId: string
  departingUserId: string
  /** Defaults to the source start and duration. */
  start?: Temporal.Instant
  durationMinutes?: number
  /** Defaults to the source's saved choice, or the current default for legacy bookings. */
  locationOptionId?: string
}

export interface DepartureHandoffPreview {
  bookingId: string
  eventTypeId: string
  candidateUserId: string
  evaluatedAt: string
  start: string
  end: string
  locationKind: LocationKind | null
  availability: 'available' | 'unavailable'
}

/** Trial of one slot for the repaired event's sole host. A write must recheck under
 * its own locks. The only conflict information returned is whether the slot is offered. */
export function previewDepartureHandoff(
  ctx: ServiceContext,
  input: DepartureHandoffPreviewInput,
  ssoCapabilities: TeamSsoCapabilities = ssoHardOff,
): Promise<DepartureHandoffPreview> {
  return withDepartureHandoffRead(
    ctx,
    input.teamId,
    input.teamId,
    ssoCapabilities,
    (readContext, organizationId, now) =>
      previewDepartureHandoffSlot(readContext, organizationId, input, now),
  )
}

/** Authorize and read the preview and any offer evidence in one private snapshot. */
export function withDepartureHandoffRead<T>(
  ctx: ServiceContext,
  teamId: string,
  expectedOrganizationId: string,
  ssoCapabilities: TeamSsoCapabilities,
  read: (ctx: ServiceContext, organizationId: string, now: Temporal.Instant) => Promise<T>,
): Promise<T> {
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (db) => {
      const capabilities = withScimResources(
        ssoCapabilities,
        ctx.scimResourcesEnabled || ctx.principal.scimResourcesEnabled,
      )
      const { scimResourcesEnabled } = capabilities
      const principal = scimResourcesEnabled
        ? { ...ctx.principal, scimResourcesEnabled: true as const }
        : ctx.principal
      if (principal.kind !== 'session')
        throw new DomainError('forbidden', 'team_management_access_denied')

      const actor = await checkTeamManagementAccess(db, principal, teamId, false, {
        expectedOrganizationId,
        allowPersonal: false,
      }).catch((error: unknown) => {
        if (!(error instanceof TeamManagementError)) throw error
        throw new DomainError(
          error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
          error.code,
        )
      })

      const sso = await teamSsoAccess(
        { db, capabilities },
        { sessionId: principal.sessionId, userId: actor.userId },
        actor.organizationId,
      )
      if (sso.suspended) throw new DomainError('forbidden', 'team_management_access_denied')
      if (!sso.allowed) throw new DomainError('forbidden', 'sso_required')

      const now = ctx.now()
      return read({ ...ctx, db, scimResourcesEnabled, now: () => now }, actor.organizationId, now)
    })
}

/** Needs a current authorized team and the caller's read-only snapshot. */
export async function previewDepartureHandoffSlot(
  ctx: ServiceContext,
  organizationId: string,
  input: Omit<DepartureHandoffPreviewInput, 'teamId'>,
  now: Temporal.Instant,
): Promise<DepartureHandoffPreview> {
  const { source, event, candidateUserId } = await getDepartureHandoffEligibility(
    ctx,
    organizationId,
    input,
    now,
  )
  const locationKind = await getDepartureHandoffLocation(
    ctx,
    event,
    input.locationOptionId ?? source.locationOptionId,
    source.savedInviteePhone,
  )
  const durationMinutes = selectDurationMinutes(
    event,
    input.durationMinutes ?? source.end.since(source.start).total('minutes'),
  )
  const start = input.start ?? source.start
  const end = start.add({ minutes: durationMinutes })
  // This mapper omits only the source's local occupancy and exact provider-event
  // mappings for its chain. It refuses stale conflict calendars without provider I/O.
  const slots = await findSlots(ctx.db, {
    eventTypeId: event.id,
    hostUserId: candidateUserId,
    rangeStart: start,
    rangeEnd: end,
    now,
    durationMinutes,
    excludeBookingId: source.id,
  })

  return {
    bookingId: source.id,
    eventTypeId: event.id,
    candidateUserId,
    evaluatedAt: now.toString(),
    start: start.toString(),
    end: end.toString(),
    locationKind,
    availability: slots.some((slot) => slot.start.equals(start) && slot.end.equals(end))
      ? 'available'
      : 'unavailable',
  }
}
