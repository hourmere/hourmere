import { PHONE_NUMBER_PATTERN } from '@hourmere/core'
import {
  type PublicEventTypeRecord,
  requireLocationAvailability,
  selectBookableLocationOption,
} from './availability.ts'
import { automaticMeet, automaticZoom } from './conferences.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import type { LocationKind } from './location-kinds.ts'

/** Check current logistics for the eligible sole host using saved facts only. */
export async function getDepartureHandoffLocation(
  ctx: Pick<ServiceContext, 'db' | 'automaticMeet' | 'automaticZoom' | 'microsoftCalendarEnabled'>,
  event: PublicEventTypeRecord,
  locationOptionId?: string,
  savedInviteePhone?: string,
): Promise<LocationKind | null> {
  const option = selectBookableLocationOption(event, locationOptionId)
  if (
    (option?.kind === 'microsoft_teams' && ctx.microsoftCalendarEnabled !== true) ||
    option?.kind === 'link' ||
    (option?.kind === 'google_meet' && !automaticMeet(option)) ||
    (option?.kind === 'zoom' && !automaticZoom(option)) ||
    (option?.kind === 'phone' &&
      'askInvitee' in option &&
      !PHONE_NUMBER_PATTERN.test(savedInviteePhone ?? ''))
  )
    throw new DomainError('conflict', 'location_unavailable', 'The chosen location is unavailable.')

  await requireLocationAvailability(ctx, event, locationOptionId)
  return option?.kind ?? null
}
