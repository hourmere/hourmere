import { validateTimeZone, validateWeeklyHours } from '@hourmere/core'
import type { Db, EventTypeHosts, EventTypes, Schedules } from '@hourmere/db'
import { type Selectable, sql } from 'kysely'
import { z } from 'zod'
import { assertCachedCalendarSync, servedHandle } from './availability.ts'
import { checkedCatalogPage } from './catalog-page.ts'
import {
  automaticMeet,
  automaticZoom,
  evaluateGoogleWriteDestination,
  evaluateZoomConnection,
  meetOrganizer,
} from './conferences.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { eligibleHostIds, hasValidHostShape } from './hosts.ts'
import { isUuid } from './internal.ts'
import { cleanText } from './text.ts'

export const ReadinessStateSchema = z.enum([
  'satisfied',
  'not_applicable',
  'configuration_blocker',
  'dependency_unavailable',
  'not_checked',
  'check_failed',
])
const axisUnknown = ['not_applicable', 'not_checked', 'check_failed'] as const
const Enablement = z.enum(['enabled', 'disabled', ...axisUnknown])
const Activation = z.enum(['active', 'inactive', ...axisUnknown])
const Summary = z.enum([
  'disabled',
  'needs_activation',
  'configuration_blocked',
  'dependency_unavailable',
  'check_failed',
  'not_checked',
  'checks_passed',
  'partial_pool',
])
const Completeness = z.enum(['complete', 'partial'])
const Reason = z.enum([
  'default_schedule_required',
  'host_configuration_required',
  'activation_required',
  'calendar_attention_required',
  'check_not_performed',
  'check_failed',
  'optional_feature_attention_required',
])
const AdminFix = z.enum(['edit_event', 'ask_member', 'retry_summary'])
const SignalId = z
  .enum([
    'event_enablement',
    'default_schedule',
    'effective_event_schedule',
    'host_eligibility',
    'round_robin_activation',
    'conflict_calendar_selection',
    'selected_calendar_sync',
    'optional_conference_dependency',
    'slot_observation',
  ])
  .describe(
    'event_enablement is a legacy signal ID and is no longer emitted; use the independent enablement field. Hidden visibility does not disable an event.',
  )
const Signal = z.object({
  id: SignalId,
  state: ReadinessStateSchema,
  reasonCode: z.string().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  ownerKind: z.enum([
    'member_self',
    'event_owner',
    'team_admin',
    'calendar_worker',
    'shared_evaluator',
    'operator',
  ]),
  fixKind: z
    .enum([
      'event_editor',
      'self_availability',
      'self_schedule',
      'self_calendars',
      'self_identity',
      'self_profile',
      'self_conferences',
      'ask_member',
      'retry_summary',
    ])
    .nullable(),
})
const SafeSyncError = z.enum(['provider_unavailable', 'needs_reauth', 'permissions_missing'])
const SelfReadinessSchema = z.object({
  subject: z.object({
    kind: z.enum(['member', 'event_type']),
    id: z.uuid(),
    organizationId: z.uuid(),
  }),
  audience: z.literal('self_detail'),
  enablement: Enablement,
  activation: Activation,
  evaluatedAt: z.iso.datetime(),
  scope: z.literal('configuration_and_cached_sync'),
  signals: z.array(Signal),
  summary: Summary,
  availability: z.literal('not_checked'),
  completeness: Completeness,
  details: z
    .object({
      schedules: z.array(
        z.object({ id: z.uuid(), name: z.string(), timeZone: z.string(), isDefault: z.boolean() }),
      ),
      calendars: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          accountEmail: z.string().nullable(),
          provider: z.string(),
          checkConflicts: z.boolean(),
          lastSyncedAt: z.iso.datetime().nullable(),
          syncError: SafeSyncError.nullable(),
          status: z.string(),
        }),
      ),
    })
    .describe(
      'Private details occur only in member.details. Event-type details are a deprecated compatibility field with empty schedules and calendars; reuse member.details.',
    ),
})
const teamFields = {
  summary: Summary,
  completeness: Completeness,
  evaluatedAt: z.iso.datetime(),
  reasonCodes: z.array(Reason),
  fixKinds: z.array(AdminFix),
}
const TeamMember = z.object({
  memberId: z.uuid(),
  displayName: z
    .string()
    .describe('Verified, display-safe member name, otherwise the neutral label Team member.'),
  ...teamFields,
})
const TeamEvent = z.object({
  eventTypeId: z.uuid(),
  enablement: Enablement,
  activation: Activation,
  ...teamFields,
})
const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.uuid().nullable() })
export const SelfReadinessPageSchema = z.object({
  member: SelfReadinessSchema,
  eventTypes: pageSchema(SelfReadinessSchema),
})
export const TeamReadinessPageSchema = z.object({
  organizationId: z.uuid(),
  members: pageSchema(TeamMember),
  eventTypes: pageSchema(TeamEvent),
})
const MemberHealth = z.object({
  defaultSchedule: ReadinessStateSchema,
  selectedCalendars: ReadinessStateSchema,
  conferenceAccounts: z.enum(['connected', 'attention_required', 'not_connected', 'check_failed']),
})
export const MemberReadinessPageSchema = z.object({
  organizationId: z.uuid(),
  members: z.array(TeamMember.extend({ health: MemberHealth })),
})
export type MemberReadinessPage = z.infer<typeof MemberReadinessPageSchema>
export type SelfReadiness = z.infer<typeof SelfReadinessSchema>
export type SelfReadinessPage = z.infer<typeof SelfReadinessPageSchema>
export type TeamReadinessPage = z.infer<typeof TeamReadinessPageSchema>
type State = z.infer<typeof ReadinessStateSchema>
type Check = z.infer<typeof Signal>
type SummaryState = z.infer<typeof Summary>
type Event = Pick<
  Selectable<EventTypes>,
  | 'id'
  | 'organization_id'
  | 'owner_user_id'
  | 'is_active'
  | 'scheduling_type'
  | 'location'
  | 'conference_organizer_user_id'
  | 'zoom_connection_id'
>
type Host = Pick<
  Selectable<EventTypeHosts>,
  'event_type_id' | 'user_id' | 'schedule_id' | 'destination_calendar_id'
>
type Schedule = Pick<
  Selectable<Schedules>,
  'id' | 'user_id' | 'is_default' | 'name' | 'time_zone' | 'weekly_hours'
>
type Member = { id: string; userId: string; name: string; emailVerified: boolean }
type Load<T> = { ok: true; value: T } | { ok: false }
const loaded = <T>(value: T): Load<T> => ({ ok: true, value })
const result = <T>(r: PromiseSettledResult<T>): Load<T> =>
  r.status === 'fulfilled' ? loaded(r.value) : { ok: false }

export interface ReadinessPageInput {
  limit?: number | undefined
  memberCursor?: string | undefined
  eventTypeCursor?: string | undefined
}

/** Only construct this context after the web team-management access check. */
export interface ReadinessTeamContext {
  db: Db
  organizationId: string
  now: () => Temporal.Instant
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
}

/** Construct only from teamManagementAccess.readMember's freshly authorized actor. */
export interface ReadinessMemberContext extends ReadinessTeamContext {
  userId: string
  role: 'owner' | 'admin' | 'member'
}

function checkedPage(input: ReadinessPageInput) {
  const { limit } = checkedCatalogPage({ limit: input.limit ?? 50, after: input.eventTypeCursor })
  if (input.memberCursor !== undefined && !isUuid(input.memberCursor))
    throw new DomainError(
      'invalid',
      'invalid_cursor',
      'memberCursor must be a UUID from the previous page',
    )
  return { ...input, limit }
}

function page<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit)
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null }
}

function eventPage(
  db: Db,
  organizationId: string,
  input: ReturnType<typeof checkedPage>,
  owner?: string,
) {
  return db
    .selectFrom('event_types')
    .select([
      'id',
      'organization_id',
      'owner_user_id',
      'is_active',
      'scheduling_type',
      'location',
      'conference_organizer_user_id',
      'zoom_connection_id',
    ])
    .where('organization_id', '=', organizationId)
    .where('deleted_at', 'is', null)
    .$if(owner !== undefined, (q) => q.where('owner_user_id', '=', owner as string))
    .$if(owner === undefined, (q) => q.where('owner_user_id', 'is', null))
    .$if(input.eventTypeCursor !== undefined, (q) =>
      q.where('id', '>', input.eventTypeCursor as string),
    )
    .orderBy('id')
    .limit(input.limit + 1)
    .execute()
}

/** Session-only global self facts, bound to current membership in the acting organization. */
export async function getSelfReadiness(
  ctx: ServiceContext,
  input: ReadinessPageInput = {},
): Promise<SelfReadinessPage> {
  const principal = ctx.principal
  const denied = () => new DomainError('forbidden', 'readiness_access_denied')
  if (
    principal.kind !== 'session' ||
    !isUuid(principal.sessionId) ||
    !isUuid(principal.user.id) ||
    !isUuid(principal.organization.id)
  )
    throw denied()
  const member = await ctx.db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .innerJoin('auth.session as s', 's.userId', 'u.id')
    .leftJoin('auth.member as activeMember', (join) =>
      join
        .onRef('activeMember.userId', '=', 's.userId')
        .on(
          sql<string>`${sql.ref('activeMember.organizationId')}::text`,
          '=',
          sql.ref('s.activeOrganizationId'),
        ),
    )
    .leftJoin('personal_organizations as personal', 'personal.user_id', 's.userId')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'm.organizationId')
    .select(['m.id', 'm.userId', 'u.name', 'u.emailVerified', 'p.user_id as personalOwner'])
    .where('m.organizationId', '=', principal.organization.id)
    .where('m.userId', '=', principal.user.id)
    .where('u.emailVerified', '=', true)
    .where('s.id', '=', principal.sessionId)
    .where('s.expiresAt', '>', sql<Date>`clock_timestamp()`)
    .where((eb) =>
      eb(
        eb.fn.coalesce('activeMember.organizationId', 'personal.organization_id'),
        '=',
        principal.organization.id,
      ),
    )
    .executeTakeFirst()
  if (!member) throw denied()
  const options = checkedPage(input)
  const events = page(
    member.personalOwner === member.userId
      ? await eventPage(ctx.db, principal.organization.id, options, member.userId)
      : [],
    options.limit,
  )
  const facts = await loadFacts(ctx.db, principal.organization.id, events.data, [member], true)
  const now = ctx.now()
  const memberView = evaluateMember(member, facts, now)
  return {
    member: selfView(
      { kind: 'member', id: member.id, organizationId: principal.organization.id },
      memberView,
      facts,
      member.userId,
    ),
    eventTypes: {
      data: events.data.map((event) =>
        selfView(
          { kind: 'event_type', id: event.id, organizationId: event.organization_id },
          evaluateEvent(event, facts, now, ctx),
          facts,
          member.userId,
        ),
      ),
      nextCursor: events.nextCursor,
    },
  }
}

/** The caller has already passed teamManagementAccess; all targets remain scoped here. */
export async function getTeamReadiness(
  ctx: ReadinessTeamContext,
  input: ReadinessPageInput = {},
): Promise<TeamReadinessPage> {
  if (!isUuid(ctx.organizationId))
    throw new DomainError('forbidden', 'team_management_access_denied')
  const options = checkedPage(input)
  const pages = await Promise.allSettled([
    ctx.db
      .selectFrom('auth.member as m')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .select(['m.id', 'm.userId', 'u.name', 'u.emailVerified'])
      .where('m.organizationId', '=', ctx.organizationId)
      .$if(options.memberCursor !== undefined, (q) =>
        q.where('m.id', '>', options.memberCursor as string),
      )
      .orderBy('m.id')
      .limit(options.limit + 1)
      .execute(),
    eventPage(ctx.db, ctx.organizationId, options),
  ])
  // Without complete subject reads there is no safe set of identities to summarize.
  if (pages[0].status === 'rejected') throw pages[0].reason
  if (pages[1].status === 'rejected') throw pages[1].reason
  const members = page(pages[0].value, options.limit)
  const events = page(pages[1].value, options.limit)
  const facts = await loadFacts(ctx.db, ctx.organizationId, events.data, members.data)
  const now = ctx.now()
  return {
    organizationId: ctx.organizationId,
    members: {
      data: members.data.map((member) => ({
        memberId: member.id,
        displayName: memberDisplayName(member),
        ...adminView(evaluateMember(member, facts, now)),
      })),
      nextCursor: members.nextCursor,
    },
    eventTypes: {
      data: events.data.map((event) => {
        const view = evaluateEvent(event, facts, now, ctx)
        return {
          eventTypeId: event.id,
          enablement: view.enablement,
          activation: view.activation,
          ...adminView(view),
        }
      }),
      nextCursor: events.nextCursor,
    },
  }
}

/** Coarse shared member checks; ordinary members may summarize only their own row. */
export async function getTeamMemberReadiness(
  ctx: ReadinessMemberContext,
  memberIds: string[],
): Promise<MemberReadinessPage> {
  const actor = ctx
  if (!isUuid(actor.organizationId) || !isUuid(actor.userId))
    throw new DomainError('forbidden', 'team_management_access_denied')
  if (!memberIds.length || memberIds.length > 100 || memberIds.some((id) => !isUuid(id)))
    throw new DomainError('invalid', 'invalid_member_ids')
  const members = await ctx.db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select(['m.id', 'm.userId', 'u.name', 'u.emailVerified'])
    .where('m.organizationId', '=', actor.organizationId)
    .where('m.id', 'in', [...new Set(memberIds)])
    .$if(actor.role === 'member', (query) => query.where('m.userId', '=', actor.userId))
    .orderBy('m.id')
    .execute()
  const facts = await loadFacts(ctx.db, actor.organizationId, [], members)
  const now = ctx.now()
  return {
    organizationId: actor.organizationId,
    members: members.map((member) => {
      const view = evaluateMember(member, facts, now)
      return {
        memberId: member.id,
        displayName: memberDisplayName(member),
        ...adminView(view),
        health: {
          defaultSchedule:
            view.signals.find((signal) => signal.id === 'default_schedule')?.state ?? 'not_checked',
          selectedCalendars: aggregate(
            view.signals.filter(
              (signal) =>
                signal.id === 'conflict_calendar_selection' ||
                signal.id === 'selected_calendar_sync',
            ),
            'selected_calendar_sync',
            now,
          ).state,
          conferenceAccounts: memberConferenceAccounts(facts, member.userId),
        },
      }
    }),
  }
}

function memberConferenceAccounts(
  facts: Facts,
  userId: string,
): z.infer<typeof MemberHealth>['conferenceAccounts'] {
  if (!facts.conferences.ok) return 'check_failed'
  const connections = facts.conferences.value.filter(
    (connection) => connection.user_id === userId && connection.status !== 'disconnected',
  )
  if (!connections.length) return 'not_connected'
  if (connections.some((connection) => connection.status === 'needs_reauth'))
    return 'attention_required'
  return 'connected'
}

function memberDisplayName(member: Member): string {
  return (member.emailVerified && cleanText(member.name, { max: 200 })) || 'Team member'
}

async function loadFacts(
  db: Db,
  organizationId: string,
  events: Event[],
  members: Member[],
  privateDetails = false,
) {
  const ids = events.map((event) => event.id)
  const first = await Promise.allSettled([
    ids.length
      ? db
          .selectFrom('event_type_hosts')
          .select(['event_type_id', 'user_id', 'schedule_id', 'destination_calendar_id'])
          .where('event_type_id', 'in', ids)
          .execute()
      : Promise.resolve([] as Host[]),
    ids.length
      ? db
          .selectFrom('round_robin_state')
          .select(['event_type_id', 'enabled'])
          .where('event_type_id', 'in', ids)
          .execute()
      : Promise.resolve([]),
  ])
  const hosts = result(first[0])
  const activation = result(first[1])
  const users = [
    ...new Set([
      ...members.map((member) => member.userId),
      ...(hosts.ok ? hosts.value.map((host) => host.user_id) : []),
      ...events.flatMap((event) => (event.owner_user_id ? [event.owner_user_id] : [])),
    ]),
  ]
  const custom = hosts.ok
    ? hosts.value.flatMap((host) => (host.schedule_id ? [host.schedule_id] : []))
    : []
  const identityResults = await Promise.allSettled([
    users.length
      ? db
          .selectFrom('auth.user as u')
          .leftJoin('auth.member as m', (join) =>
            join.onRef('m.userId', '=', 'u.id').on('m.organizationId', '=', organizationId),
          )
          .select(['u.id', 'u.emailVerified', 'm.userId', 'm.organizationId'])
          .where('u.id', 'in', users)
          .execute()
      : Promise.resolve([]),
  ])
  const identities = result(identityResults[0])
  // A departed configured host contributes only a host-configuration gap. Do not load
  // their private facts through the historical event relation.
  const privateUsers = [
    ...new Set([
      ...members.map((member) => member.userId),
      ...(identities.ok
        ? identities.value.filter((user) => user.userId !== null).map((user) => user.id)
        : []),
    ]),
  ]
  // Every dependency is read once for the entire page, never once per event or host.
  const dependencies = await Promise.allSettled([
    privateUsers.length
      ? db
          .selectFrom('schedules')
          .select(['id', 'user_id', 'is_default', 'time_zone', 'weekly_hours'])
          .$if(privateDetails, (query) => query.select('name'))
          .where('user_id', 'in', privateUsers)
          .where((eb) =>
            custom.length
              ? eb.or([eb('is_default', '=', true), eb('id', 'in', custom)])
              : eb('is_default', '=', true),
          )
          .execute()
      : Promise.resolve([] as Schedule[]),
    privateUsers.length
      ? db
          .selectFrom('calendar_connections as cc')
          .innerJoin('calendars as c', 'c.connection_id', 'cc.id')
          .select([
            'cc.user_id',
            'cc.id as connection_id',
            'cc.provider',
            'cc.status',
            'cc.scopes',
            'c.id',
            'c.check_conflicts',
            'c.last_synced_at',
            'c.sync_error',
            'c.sync_state',
            'c.time_zone',
            'c.access_role',
            'c.supports_google_meet',
          ])
          .$if(privateDetails, (query) => query.select(['cc.account_email', 'c.name']))
          .where('cc.user_id', 'in', privateUsers)
          .execute()
      : Promise.resolve([]),
    privateUsers.length
      ? db
          .selectFrom('profiles')
          .select(['user_id', 'handle', 'destination_calendar_id'])
          .where('user_id', 'in', privateUsers)
          .execute()
      : Promise.resolve([]),
    privateUsers.length
      ? db
          .selectFrom('conference_connections')
          .select(['id', 'user_id', 'provider', 'external_user_id', 'mode', 'scopes', 'status'])
          .where('user_id', 'in', privateUsers)
          .execute()
      : Promise.resolve([]),
  ])
  return {
    organizationId,
    hosts,
    activation,
    identities,
    schedules: result(dependencies[0]),
    calendars: result(dependencies[1]),
    profiles: result(dependencies[2]),
    conferences: result(dependencies[3]),
  }
}
type Facts = Awaited<ReturnType<typeof loadFacts>>
type View = Pick<
  SelfReadiness,
  'enablement' | 'activation' | 'signals' | 'summary' | 'completeness' | 'evaluatedAt'
> & { requiredChecks: Check[] }

function check(
  id: Check['id'],
  state: State,
  now: Temporal.Instant,
  reasonCode: string | null = null,
  fixKind: Check['fixKind'] = null,
  ownerKind: Check['ownerKind'] = 'shared_evaluator',
): Check {
  return {
    id,
    state,
    reasonCode,
    checkedAt: state === 'not_checked' ? null : now.toString(),
    fixKind,
    ownerKind,
  }
}
const failed = (id: Check['id'], now: Temporal.Instant) =>
  check(id, 'check_failed', now, 'check_failed', 'retry_summary')
const na = (id: Check['id'], now: Temporal.Instant) => check(id, 'not_applicable', now)

function scheduleCheck(
  facts: Facts,
  userId: string,
  scheduleId: string | null,
  id: Check['id'],
  now: Temporal.Instant,
): Check {
  if (!facts.schedules.ok) return failed(id, now)
  const schedule = facts.schedules.value.find(
    (s) => s.user_id === userId && (scheduleId ? s.id === scheduleId : s.is_default),
  )
  if (!schedule)
    return check(
      id,
      'configuration_blocker',
      now,
      'default_schedule_required',
      'self_availability',
      'member_self',
    )
  try {
    validateTimeZone(schedule.time_zone)
    validateWeeklyHours(schedule.weekly_hours)
  } catch {
    return failed(id, now)
  }
  return check(id, 'satisfied', now)
}

function calendarChecks(facts: Facts, userId: string, now: Temporal.Instant): Check[] {
  if (!facts.calendars.ok)
    return [failed('conflict_calendar_selection', now), failed('selected_calendar_sync', now)]
  const selected = facts.calendars.value.filter((c) => c.user_id === userId && c.check_conflicts)
  if (!selected.length)
    return [na('conflict_calendar_selection', now), na('selected_calendar_sync', now)]
  const unsupported = selected.some((c) => c.provider !== 'google')
  const selection = check(
    'conflict_calendar_selection',
    unsupported ? 'not_checked' : 'satisfied',
    now,
    unsupported ? 'unsupported_conflict_provider' : null,
    unsupported ? 'self_calendars' : null,
    'member_self',
  )
  const syncIssues: Check[] = []
  for (const calendar of selected.filter((c) => c.provider === 'google')) {
    try {
      assertCachedCalendarSync([calendar], now)
    } catch (error) {
      syncIssues.push(
        error instanceof DomainError && error.code === 'calendar_sync_unavailable'
          ? check(
              'selected_calendar_sync',
              'dependency_unavailable',
              now,
              // An explicit failure takes precedence over absent success metadata.
              calendar.status !== 'active' || calendar.sync_error
                ? 'calendar_attention_required'
                : !calendar.last_synced_at || calendar.sync_state === null
                  ? 'sync_not_ready'
                  : 'calendar_attention_required',
              'self_calendars',
              'calendar_worker',
            )
          : failed('selected_calendar_sync', now),
      )
    }
  }
  if (syncIssues.length)
    return [
      selection,
      // An unexpected evaluation failure must remain unknown rather than a known sync issue.
      syncIssues.find((issue) => issue.state === 'check_failed') ??
        // Missing success metadata for one calendar must not hide another calendar's problem.
        syncIssues.find((issue) => issue.reasonCode === 'calendar_attention_required') ??
        aggregate(syncIssues, 'selected_calendar_sync', now),
    ]
  return [
    selection,
    unsupported
      ? check(
          'selected_calendar_sync',
          'not_checked',
          now,
          'unsupported_conflict_provider',
          'self_calendars',
          'member_self',
        )
      : check('selected_calendar_sync', 'satisfied', now),
  ]
}

function baseSignals(now: Temporal.Instant) {
  return SignalId.options
    .filter((id) => id !== 'event_enablement')
    .map((id) =>
      id === 'slot_observation'
        ? check(id, 'not_checked', now, 'check_not_performed', 'retry_summary')
        : na(id, now),
    )
}
function put(signals: Check[], ...checks: Check[]) {
  for (const value of checks) {
    const index = signals.findIndex((signal) => signal.id === value.id)
    signals[index] = value
  }
}
function aggregate(checks: Check[], id: Check['id'], now: Temporal.Instant): Check {
  for (const state of [
    'configuration_blocker',
    'dependency_unavailable',
    'check_failed',
    'not_checked',
    'satisfied',
  ] as const) {
    const value = checks.find((c) => c.state === state)
    if (value) return { ...value, id }
  }
  return na(id, now)
}
function finish(
  signals: Check[],
  now: Temporal.Instant,
  enablement: View['enablement'] = 'not_applicable',
  activation: View['activation'] = 'not_applicable',
  override?: SummaryState,
  candidateChecks: Check[] = [],
): View {
  const required = [...signals, ...candidateChecks].filter(
    (signal) => signal.id !== 'slot_observation',
  )
  const has = (state: State) => required.some((signal) => signal.state === state)
  const unknown = has('not_checked') || enablement === 'not_checked' || activation === 'not_checked'
  const failure =
    has('check_failed') || enablement === 'check_failed' || activation === 'check_failed'
  const summary =
    enablement === 'disabled'
      ? 'disabled'
      : activation === 'inactive'
        ? 'needs_activation'
        : activation === 'check_failed'
          ? 'check_failed'
          : activation === 'not_checked'
            ? 'not_checked'
            : (override ??
              (has('configuration_blocker')
                ? 'configuration_blocked'
                : has('dependency_unavailable')
                  ? 'dependency_unavailable'
                  : failure
                    ? 'check_failed'
                    : unknown
                      ? 'not_checked'
                      : 'checks_passed'))
  return {
    signals,
    enablement,
    activation,
    evaluatedAt: now.toString(),
    summary,
    completeness: unknown || failure ? 'partial' : 'complete',
    requiredChecks: required,
  }
}
function evaluateMember(member: Member, facts: Facts, now: Temporal.Instant): View {
  const signals = baseSignals(now)
  put(
    signals,
    check(
      'host_eligibility',
      member.emailVerified ? 'satisfied' : 'configuration_blocker',
      now,
      member.emailVerified ? null : 'host_configuration_required',
      member.emailVerified ? null : 'self_identity',
      'member_self',
    ),
    scheduleCheck(facts, member.userId, null, 'default_schedule', now),
    ...calendarChecks(facts, member.userId, now),
  )
  return finish(signals, now)
}

function conferenceCheck(
  event: Event,
  facts: Facts,
  hosts: Host[],
  userId: string,
  now: Temporal.Instant,
  ctx: Pick<ServiceContext, 'automaticMeet' | 'automaticZoom'>,
): Check {
  const id = 'optional_conference_dependency'
  if (!automaticMeet(event.location) && !automaticZoom(event.location)) return na(id, now)
  // Personal public resolution always derives its single host from the owner.
  const personal = event.owner_user_id !== null
  const mode = personal ? 'individual' : event.scheduling_type
  const hostIds = personal ? [event.owner_user_id as string] : hosts.map((host) => host.user_id)
  const blocker = () =>
    check(
      id,
      'configuration_blocker',
      now,
      'optional_feature_attention_required',
      'event_editor',
      'event_owner',
    )
  if (automaticZoom(event.location)) {
    if (!ctx.automaticZoom || mode !== 'individual' || hostIds.length !== 1) return blocker()
    if (!facts.conferences.ok) return failed(id, now)
    return evaluateZoomConnection(
      userId,
      event.zoom_connection_id,
      facts.conferences.value.find((c) => c.id === event.zoom_connection_id),
      true,
    ).eligible
      ? check(id, 'satisfied', now)
      : blocker()
  }
  if (!ctx.automaticMeet) return blocker()
  if (!facts.profiles.ok || !facts.calendars.ok) return failed(id, now)
  let organizer: string | undefined
  try {
    organizer =
      mode === 'round_robin'
        ? userId
        : meetOrganizer(mode, hostIds, personal ? null : event.conference_organizer_user_id)
  } catch (error) {
    return error instanceof DomainError ? blocker() : failed(id, now)
  }
  const profile = facts.profiles.value.find((p) => p.user_id === organizer)
  const host = hosts.find((h) => h.user_id === organizer)
  const destination = host?.destination_calendar_id ?? profile?.destination_calendar_id
  const calendar = facts.calendars.value.find(
    (c) => c.id === destination && c.user_id === organizer,
  )
  // googleWriteDestination starts at profiles and joins only the destination owner's connection.
  const value = evaluateGoogleWriteDestination(
    profile
      ? {
          destination: destination ?? null,
          calendar_id: calendar?.id ?? null,
          connection_id: calendar?.connection_id ?? null,
          provider: calendar?.provider ?? null,
          status: calendar?.status ?? null,
          access_role: calendar?.access_role ?? null,
          supports_google_meet: calendar?.supports_google_meet ?? null,
          scopes: calendar?.scopes ?? null,
        }
      : undefined,
    true,
  )
  return value.eligible ? check(id, 'satisfied', now) : blocker()
}

function evaluateEvent(
  event: Event,
  facts: Facts,
  now: Temporal.Instant,
  ctx: Pick<ServiceContext, 'automaticMeet' | 'automaticZoom'>,
): View {
  const signals = baseSignals(now)
  const personal = event.owner_user_id !== null
  const mode = personal ? 'individual' : event.scheduling_type
  const enablement = event.is_active ? 'enabled' : 'disabled'
  let activation: View['activation'] = 'not_applicable'
  if (mode === 'round_robin') {
    activation = facts.activation.ok
      ? facts.activation.value.some((r) => r.event_type_id === event.id && r.enabled)
        ? 'active'
        : 'inactive'
      : 'check_failed'
    put(
      signals,
      activation === 'check_failed'
        ? failed('round_robin_activation', now)
        : check(
            'round_robin_activation',
            activation === 'active' ? 'satisfied' : 'configuration_blocker',
            now,
            activation === 'inactive' ? 'activation_required' : null,
            activation === 'inactive' ? 'event_editor' : null,
            'team_admin',
          ),
    )
  }
  if (!facts.hosts.ok || !facts.identities.ok) {
    put(
      signals,
      failed('host_eligibility', now),
      failed('effective_event_schedule', now),
      failed('conflict_calendar_selection', now),
      failed('selected_calendar_sync', now),
      failed('optional_conference_dependency', now),
    )
    return finish(signals, now, enablement, activation)
  }
  const hosts = facts.hosts.value.filter((h) => h.event_type_id === event.id)
  const configured = personal ? [event.owner_user_id as string] : hosts.map((h) => h.user_id)
  const members = facts.identities.value.flatMap((u) =>
    u.userId && u.organizationId ? [{ userId: u.userId, organizationId: u.organizationId }] : [],
  )
  let eligible = eligibleHostIds(event.organization_id, configured, facts.identities.value, members)
  let hostCheckFailed = false
  if (personal) {
    if (!facts.profiles.ok) {
      hostCheckFailed = true
    } else {
      const profile = facts.profiles.value.find((p) => p.user_id === event.owner_user_id)
      eligible =
        facts.identities.value.some((u) => u.id === event.owner_user_id && u.userId !== null) &&
        profile &&
        servedHandle(profile.handle)
          ? configured
          : []
    }
  }
  const rr = mode === 'round_robin'
  const shape = personal || hasValidHostShape(mode, configured)
  const hostBlocked = !shape || !eligible.length || (!rr && eligible.length !== configured.length)
  const degraded = eligible.length !== configured.length
  put(
    signals,
    hostCheckFailed
      ? failed('host_eligibility', now)
      : check(
          'host_eligibility',
          hostBlocked ? 'configuration_blocker' : 'satisfied',
          now,
          hostBlocked ? 'host_configuration_required' : degraded ? 'host_pool_degraded' : null,
          hostBlocked || degraded ? (personal ? 'self_profile' : 'event_editor') : null,
          personal ? 'member_self' : 'event_owner',
        ),
  )
  const candidates = (personal ? configured : eligible).map((userId) => {
    const host = hosts.find((h) => h.user_id === userId)
    return [
      scheduleCheck(
        facts,
        userId,
        mode === 'individual' ? (host?.schedule_id ?? null) : null,
        'effective_event_schedule',
        now,
      ),
      ...calendarChecks(facts, userId, now),
      conferenceCheck(event, facts, hosts, userId, now, ctx),
    ]
  })
  for (const id of [
    'effective_event_schedule',
    'conflict_calendar_selection',
    'selected_calendar_sync',
    'optional_conference_dependency',
  ] as const)
    put(
      signals,
      aggregate(
        candidates.flat().filter((c) => c.id === id),
        id,
        now,
      ),
    )
  const legacySchedule = rr && hosts.some((h) => h.schedule_id !== null)
  const legacyChecks = legacySchedule
    ? [
        check(
          'round_robin_activation',
          'configuration_blocker',
          now,
          'host_configuration_required',
          'event_editor',
          'team_admin',
        ),
      ]
    : []
  const flat = [...candidates.flat(), ...legacyChecks]
  if (!rr || hostBlocked) return finish(signals, now, enablement, activation, undefined, flat)
  const pass = candidates.some((checks) =>
    checks.every((c) => c.state === 'satisfied' || c.state === 'not_applicable'),
  )
  const has = (state: State) => flat.some((c) => c.state === state)
  const summary: SummaryState = has('check_failed')
    ? 'check_failed'
    : has('not_checked')
      ? 'not_checked'
      : legacySchedule
        ? 'configuration_blocked'
        : pass
          ? degraded || has('configuration_blocker') || has('dependency_unavailable')
            ? 'partial_pool'
            : 'checks_passed'
          : has('dependency_unavailable')
            ? 'dependency_unavailable'
            : 'configuration_blocked'
  return finish(signals, now, enablement, activation, summary, flat)
}

function selfView(
  subject: SelfReadiness['subject'],
  view: View,
  facts: Facts,
  userId: string,
): SelfReadiness {
  return {
    subject,
    audience: 'self_detail',
    scope: 'configuration_and_cached_sync',
    availability: 'not_checked',
    enablement: view.enablement,
    activation: view.activation,
    evaluatedAt: view.evaluatedAt,
    signals: view.signals,
    summary: view.summary,
    completeness: view.completeness,
    details: {
      schedules:
        subject.kind === 'member' && facts.schedules.ok
          ? facts.schedules.value
              .filter((s) => s.user_id === userId)
              .map((s) => ({
                id: s.id,
                name: s.name ?? '',
                timeZone: s.time_zone,
                isDefault: s.is_default,
              }))
          : [],
      calendars:
        subject.kind === 'member' && facts.calendars.ok
          ? facts.calendars.value
              .filter((c) => c.user_id === userId)
              .map((c) => ({
                id: c.id,
                name: c.name ?? '',
                accountEmail: c.account_email ?? null,
                provider: c.provider,
                checkConflicts: c.check_conflicts,
                lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
                syncError: SafeSyncError.nullable().catch(null).parse(c.sync_error),
                status: c.status,
              }))
          : [],
    },
  }
}

/** Build the administrator response independently; never serialize a self-detail DTO here. */
function adminView(
  view: View,
): Pick<
  z.infer<typeof TeamMember>,
  'summary' | 'completeness' | 'evaluatedAt' | 'reasonCodes' | 'fixKinds'
> {
  const reasonCodes = new Set<z.infer<typeof Reason>>()
  const fixKinds = new Set<z.infer<typeof AdminFix>>()
  if (view.activation === 'inactive') {
    reasonCodes.add('activation_required')
    fixKinds.add('edit_event')
  }
  for (const signal of view.requiredChecks) {
    if (signal.id === 'slot_observation') continue
    if (signal.state === 'check_failed') {
      reasonCodes.add('check_failed')
      fixKinds.add('retry_summary')
    } else if (signal.state === 'not_checked') {
      reasonCodes.add('check_not_performed')
      fixKinds.add('retry_summary')
    } else if (
      signal.state === 'configuration_blocker' ||
      signal.state === 'dependency_unavailable' ||
      signal.reasonCode === 'host_pool_degraded'
    ) {
      if (signal.id === 'default_schedule' || signal.id === 'effective_event_schedule') {
        reasonCodes.add('default_schedule_required')
        fixKinds.add('ask_member')
      } else if (
        signal.id === 'selected_calendar_sync' ||
        signal.id === 'conflict_calendar_selection'
      ) {
        reasonCodes.add('calendar_attention_required')
        fixKinds.add('ask_member')
      } else if (signal.id === 'optional_conference_dependency') {
        reasonCodes.add('optional_feature_attention_required')
        fixKinds.add('edit_event')
        fixKinds.add('ask_member')
      } else if (signal.reasonCode === 'activation_required') {
        reasonCodes.add('activation_required')
        fixKinds.add('edit_event')
      } else {
        reasonCodes.add('host_configuration_required')
        fixKinds.add(signal.ownerKind === 'member_self' ? 'ask_member' : 'edit_event')
      }
    }
  }
  return {
    summary: view.summary,
    completeness: view.completeness,
    evaluatedAt: view.evaluatedAt,
    reasonCodes: [...reasonCodes],
    fixKinds: [...fixKinds],
  }
}
