import type { InterfaceLanguage } from '@hourmere/core/locales'
import {
  formatSlotSnippet,
  resolveSnippetLocale,
  resolveSnippetTimeZone,
  type SlotSnippet,
  type SlotSnippetAddress,
  SlotSnippetError,
} from '@hourmere/core/slot-snippet'
import { listPublicSlots, listPublicTeamSlots, selectDurationMinutes } from './availability.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'

/** Elapsed days, not calendar days: explicit offsets make DST boundaries unambiguous. */
export const MAX_OPEN_TIME_SNIPPET_RANGE_DAYS = 31
export interface GenerateOpenTimeSnippetInput {
  eventTypeId?: string
  slug?: string
  from: string
  to: string
  count?: number
  displayTimeZone?: string
  locale?: InterfaceLanguage
  durationMinutes?: number
}
export interface OpenTimeSnippetOptions {
  publicUrl: string
  slotSnippetsEnabled: boolean
}

/** Read-only selection of the earliest available alternatives; never reserves or books. */
export async function generateOpenTimeSnippet(
  ctx: ServiceContext,
  input: GenerateOpenTimeSnippetInput,
  options: OpenTimeSnippetOptions,
): Promise<SlotSnippet> {
  if (!options.slotSnippetsEnabled) throw new DomainError('not_found', 'slot_snippets_disabled')
  if ((input.eventTypeId === undefined) === (input.slug === undefined))
    throw new DomainError('invalid', 'invalid_event_type_selector')
  if (input.eventTypeId !== undefined && !isUuid(input.eventTypeId))
    throw new DomainError('not_found', 'event_type_not_found')
  if (input.slug !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.slug))
    throw new DomainError('invalid', 'invalid_slug')
  const count = input.count ?? 3
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new DomainError('invalid', 'invalid_count')
  let start: Temporal.Instant
  let end: Temporal.Instant
  const instantPattern =
    /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
  if (!instantPattern.test(input.from) || !instantPattern.test(input.to))
    throw new DomainError('invalid', 'invalid_range')
  try {
    start = Temporal.Instant.from(input.from)
    end = Temporal.Instant.from(input.to)
  } catch {
    throw new DomainError('invalid', 'invalid_range')
  }
  if (Temporal.Instant.compare(end, start) <= 0) throw new DomainError('invalid', 'invalid_range')
  if (end.since(start).total('hours') > MAX_OPEN_TIME_SNIPPET_RANGE_DAYS * 24)
    throw new DomainError('invalid', 'range_too_long')

  // One snapshot binds the saved address, permissions, rules and public availability.
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (db) => {
      const membership = await db
        .selectFrom('auth.member as m')
        .innerJoin('auth.user as u', 'u.id', 'm.userId')
        .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
        .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
        .select(['m.role', 'o.slug as teamSlug', 'p.user_id as personalOwnerId'])
        .where('m.organizationId', '=', ctx.principal.organization.id)
        .where('m.userId', '=', ctx.principal.user.id)
        .where('u.emailVerified', '=', true)
        .executeTakeFirst()
      if (!membership) throw new DomainError('forbidden', 'insufficient_role')
      const events = await db
        .selectFrom('event_types')
        .selectAll()
        .where('organization_id', '=', ctx.principal.organization.id)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([eb('owner_user_id', '=', ctx.principal.user.id), eb('owner_user_id', 'is', null)]),
        )
        .$if(input.eventTypeId !== undefined, (q) =>
          q.where('id', '=', input.eventTypeId as string),
        )
        .$if(input.slug !== undefined, (q) => q.where('slug', '=', input.slug as string))
        .limit(2)
        .execute()
      const event = events[0]
      if (!event) throw new DomainError('not_found', 'event_type_not_found')
      if (events.length > 1) throw new DomainError('invalid', 'ambiguous_event_type_slug')
      if (membership.personalOwnerId && event.owner_user_id !== membership.personalOwnerId)
        throw new DomainError('not_found', 'event_type_not_found')
      const roles = membership.role.split(',').map((role) => role.trim())
      if (
        event.owner_user_id === null &&
        (roles.some((role) => !['owner', 'admin', 'member'].includes(role)) ||
          (!roles.includes('owner') && !roles.includes('admin')))
      )
        throw new DomainError('forbidden', 'insufficient_role')
      if (!event.is_active) throw new DomainError('not_found', 'event_type_not_found')
      const profile = await db
        .selectFrom('profiles')
        .select(['handle', 'time_zone', 'locale'])
        .where('user_id', '=', ctx.principal.user.id)
        .executeTakeFirst()
      let address: SlotSnippetAddress
      if (event.owner_user_id !== null) {
        if (!profile) throw new DomainError('not_found', 'profile_not_found')
        address = { kind: 'personal', handle: profile.handle, slug: event.slug }
      } else {
        address = { kind: 'team', teamSlug: membership.teamSlug, slug: event.slug }
      }
      const durationMinutes = selectDurationMinutes(
        {
          durationMinutes: event.duration_minutes,
          allowedDurationsMinutes: event.allowed_durations_minutes,
        },
        input.durationMinutes,
      )
      const query = {
        handle: address.kind === 'personal' ? address.handle : address.teamSlug,
        slug: event.slug,
        start,
        end,
        durationMinutes,
      }
      const slots = await (address.kind === 'personal' ? listPublicSlots : listPublicTeamSlots)(
        { ...ctx, db },
        query,
      )
      if (!slots.length) throw new DomainError('conflict', 'no_available_slots')
      try {
        return formatSlotSnippet({
          publicUrl: options.publicUrl,
          address,
          title: event.title,
          durationMinutes,
          starts: slots.slice(0, count).map((slot) => slot.start),
          locale: input.locale ?? resolveSnippetLocale(profile?.locale),
          displayTimeZone: input.displayTimeZone ?? resolveSnippetTimeZone(profile?.time_zone),
        })
      } catch (error) {
        if (error instanceof SlotSnippetError) throw new DomainError('invalid', error.code)
        throw error
      }
    })
}
