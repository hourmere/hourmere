import { validateEventTypeRules, validateTimeZone } from '@hourmere/core'
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parseFragment } from 'parse5'
import type { Question } from '../../scheduling/src/questions.ts'
import { cleanText, isMultiLineText } from '../../scheduling/src/text.ts'
import { parseEventLocation, type StaticLocation } from './locations.ts'
import { parseQuestions, type QuestionCrosswalk, record } from './questions.ts'
import type { SchedulePlan } from './schedules.ts'
import type { MatchedUser, PlanProblem, SourceSnapshot } from './types.ts'

export interface EventPlan {
  sourceId: number
  sourceUserId: number
  targetUserId: string
  organizationId: string
  title: string
  slug: string
  description: string | null
  position: number
  durationMinutes: number
  allowedDurationsMinutes: number[]
  slotStepMinutes: number | null
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minimumNoticeMinutes: number
  bookingWindowDays: number | null
  maxBookingsPerDay: number | null
  isHidden: boolean
  isActive: false
  allowGuests: boolean
  schedulingType: 'individual'
  scheduleSourceId: number | null
  proposedScheduleTimezone: string | null
  location: StaticLocation | null
  questions: Question[]
  questionCrosswalk: QuestionCrosswalk[]
  notifications: { reminders: []; followUps: [] }
  successRedirect: null
  /** Retained source restrictions require a later explicit activation decision. */
  sourceConstraints: {
    periodType: string
    periodDays: number | null
    periodCountCalendarDays: boolean | null
    periodStartDate: string | null
    periodEndDate: string | null
    bookingLimits: Record<string, number> | null
    durationLimits: Record<string, number> | null
    maxActiveBookingsPerBooker: number | null
  }
}

const omittedDescriptionSubtrees = new Set(['script', 'style', 'iframe', 'object', 'template'])
const descriptionBlocks = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
])

/** parse5 builds an inert syntax tree; attributes and resource URLs are never consumed. */
export function plainDescription(value: string): { text: string; converted: boolean } {
  if (!value.includes('<')) return { text: value, converted: false }
  const fragment = parseFragment(value, { sourceCodeLocationInfo: true })
  const onlyChild = fragment.childNodes[0]
  // A source-spanning text node is ordinary text, including literal angle brackets
  // and entity-like text. Preserve it byte for byte rather than decoding or trimming it.
  if (
    value === '' ||
    (fragment.childNodes.length === 1 &&
      onlyChild &&
      defaultTreeAdapter.isTextNode(onlyChild) &&
      onlyChild.sourceCodeLocation?.startOffset === 0 &&
      onlyChild.sourceCodeLocation.endOffset === value.length)
  ) {
    return { text: value, converted: false }
  }
  const parts: string[] = []
  const blockBreak = () => {
    if (parts.length > 0 && !parts.at(-1)?.endsWith('\n')) parts.push('\n')
  }
  const visit = (node: DefaultTreeAdapterTypes.ChildNode): void => {
    if (defaultTreeAdapter.isTextNode(node)) {
      if (node.value) parts.push(node.value)
      return
    }
    // Comments and doctypes contribute no visible text.
    if (!defaultTreeAdapter.isElementNode(node)) return
    const tagName = node.tagName.toLowerCase()
    if (omittedDescriptionSubtrees.has(tagName)) return
    if (tagName === 'br') {
      parts.push('\n')
      return
    }
    if (descriptionBlocks.has(tagName)) blockBreak()
    for (const child of node.childNodes) visit(child)
    if (descriptionBlocks.has(tagName)) blockBreak()
  }
  for (const child of fragment.childNodes) visit(child)
  return { text: parts.join('').trim(), converted: true }
}

function nonempty(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (record(value)) return Object.keys(value).length > 0
  return true
}

export function parseEvents(
  snapshot: SourceSnapshot,
  users: Map<number, MatchedUser>,
  schedules: SchedulePlan[],
  problems: PlanProblem[],
): EventPlan[] {
  const plans: EventPlan[] = []
  const slugs = new Map<string, number>()
  for (const event of snapshot.tables.EventType ?? []) {
    const id = event.id as number
    const startProblems = problems.length
    const add = (code: string, severity: PlanProblem['severity'], message: string) =>
      problems.push({ code, severity, source: { table: 'EventType', id }, message })
    if (
      event.teamId != null ||
      event.profileId != null ||
      event.parentId != null ||
      event.schedulingType != null ||
      event.assignAllTeamMembers === true ||
      event.assignRRMembersUsingSegment === true ||
      event.rrHostSubsetEnabled === true
    ) {
      add(
        'event_scope',
        'excluded',
        'Team, organization, managed and multiple-host event types are outside this import scope.',
      )
      continue
    }
    const user = users.get(event.userId as number)
    if (!user) {
      add(
        'event_owner',
        'import_blocker',
        'The event owner is not a uniquely matched verified personal user.',
      )
      continue
    }
    const hosts = (snapshot.tables.Host ?? []).filter((h) => h.eventTypeId === id)
    const linkedUsers = (snapshot.tables._user_eventtype ?? []).filter((h) => h.A === id)
    const actualUsers = new Set([...hosts.map((h) => h.userId), ...linkedUsers.map((h) => h.B)])
    if (
      actualUsers.size !== 1 ||
      !actualUsers.has(user.sourceId) ||
      hosts.some((h) => h.groupId != null || h.memberId != null) ||
      (snapshot.tables.HostGroup ?? []).some((g) => g.eventTypeId === id)
    ) {
      add(
        'event_host_shape',
        'import_blocker',
        'The source event relationships do not prove exactly one personal host matching the owner.',
      )
      continue
    }
    if (
      (event.price != null && event.price !== 0) ||
      event.paymentConfigured === true ||
      event.unknownPaymentShape === true ||
      event.isInstantEvent === true
    ) {
      add(
        'event_paid_or_instant',
        'import_blocker',
        'Paid, unknown payment-app and instant event types cannot be imported as ordinary free events.',
      )
      continue
    }
    const title = cleanText(event.title, { max: 200 })
    const slug =
      typeof event.slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(event.slug)
        ? event.slug
        : null
    let description: string | null = null
    if (event.description != null) {
      if (
        typeof event.description !== 'string' ||
        !isMultiLineText(event.description) ||
        event.description.length > 5000
      )
        add(
          'event_description',
          'import_blocker',
          'The event description is invalid or exceeds five thousand characters; it is not truncated.',
        )
      else {
        const result = plainDescription(event.description)
        description = result.text
        if (!isMultiLineText(description) || description.length > 5000)
          add(
            'event_description',
            'import_blocker',
            'The converted event description fails target text validation.',
          )
        if (result.converted)
          add(
            'event_html_loss',
            'activation_blocker',
            'HTML description formatting and embedded content are removed; review the plain text before activation.',
          )
      }
    }
    if (
      !title ||
      !slug ||
      !Number.isSafeInteger(event.position) ||
      (event.position as number) < -2147483648 ||
      (event.position as number) > 2147483647 ||
      typeof event.hidden !== 'boolean' ||
      typeof event.disableGuests !== 'boolean'
    )
      add(
        'event_text',
        'import_blocker',
        'The event title, slug, position or visibility flags fail target validation.',
      )
    if (slug) {
      const key = `${user.organizationId}:${slug}`
      const prior = slugs.get(key)
      if (prior !== undefined) {
        add(
          'event_slug_conflict',
          'import_blocker',
          'Multiple selected event types share a personal page slug; no event is renamed automatically.',
        )
        problems.push({
          code: 'event_slug_conflict',
          severity: 'import_blocker',
          source: { table: 'EventType', id: prior },
          message:
            'Multiple selected event types share a personal page slug; no event is renamed automatically.',
        })
      } else slugs.set(key, id)
    }
    const multiple = event.multipleDuration
    let allowed =
      multiple == null || (Array.isArray(multiple) && multiple.length === 0)
        ? [event.length]
        : multiple
    try {
      validateEventTypeRules({
        durationMinutes: event.length,
        allowedDurationsMinutes: allowed,
        ...(event.slotInterval != null ? { slotStepMinutes: event.slotInterval } : {}),
        bufferBeforeMinutes: event.beforeEventBuffer,
        bufferAfterMinutes: event.afterEventBuffer,
        minimumNoticeMinutes: event.minimumBookingNotice,
      })
    } catch {
      add(
        'event_duration_rules',
        'import_blocker',
        'Durations, slot intervals, buffers or minimum notice fail the target integer bounds; values are not repaired.',
      )
    }
    if (event.hideDurationSelectorInBookingPage === true) {
      add(
        'event_hidden_durations',
        'activation_blocker',
        'The source duration selector is hidden; only its default duration is proposed until the owner confirms the omitted choices.',
      )
      allowed = [event.length]
    }
    if (event.offsetStart !== 0)
      add(
        'event_offset',
        'activation_blocker',
        'The source slot offset has no target equivalent and must be resolved before activation.',
      )
    const periodType = event.periodType
    if (!['unlimited', 'rolling', 'rolling_window', 'range'].includes(periodType as string))
      add(
        'event_period_type',
        'import_blocker',
        'The source booking period type is not recognized by this adapter.',
      )
    else if (
      periodType !== 'unlimited' ||
      event.periodDays != null ||
      event.periodStartDate != null ||
      event.periodEndDate != null
    )
      add(
        'event_window',
        'activation_blocker',
        'The source date window uses different local-day or business-day semantics; choose an explicit target window before activation.',
      )
    const validatedLimits = (value: unknown): Record<string, number> | null => {
      if (value == null) return null
      if (
        !record(value) ||
        Object.entries(value).some(
          ([key, limit]) =>
            !['PER_DAY', 'PER_WEEK', 'PER_MONTH', 'PER_YEAR'].includes(key) ||
            !Number.isSafeInteger(limit) ||
            (limit as number) < 1,
        )
      ) {
        add(
          'event_limits_shape',
          'import_blocker',
          'Source limits must contain only recognized positive integer interval limits; arbitrary JSON is not retained.',
        )
        return null
      }
      return Object.fromEntries(Object.entries(value)) as Record<string, number>
    }
    const bookingLimits = validatedLimits(event.bookingLimits)
    const durationLimits = validatedLimits(event.durationLimits)
    let maxBookingsPerDay: number | null = null
    if (
      nonempty(event.bookingLimits) ||
      nonempty(event.durationLimits) ||
      event.maxActiveBookingsPerBooker != null
    ) {
      add(
        'event_limits',
        'activation_blocker',
        'Source booking-count, duration or per-booker limits require review because their counting semantics differ from the target.',
      )
      if (
        record(event.bookingLimits) &&
        Number.isSafeInteger(event.bookingLimits.PER_DAY) &&
        (event.bookingLimits.PER_DAY as number) >= 1 &&
        (event.bookingLimits.PER_DAY as number) <= 1000
      )
        maxBookingsPerDay = event.bookingLimits.PER_DAY as number
    }
    const unsupportedFlags = [
      'requiresConfirmation',
      'requiresConfirmationWillBlockSlot',
      'requiresConfirmationForFreeEmail',
      'requiresBookerEmailVerification',
      'bookingRequiresAuthentication',
      'disableCancelling',
      'disableRescheduling',
      'useBookerTimezone',
      'enablePerHostLocations',
    ]
    for (const flag of unsupportedFlags)
      if (event[flag] === true)
        add(
          `event_policy_${flag}`,
          'activation_blocker',
          'A source approval, authentication, cancellation, time-zone or location policy has no equivalent and must be resolved before activation.',
        )
    if (nonempty(event.recurringEvent))
      add(
        'event_recurring',
        'activation_blocker',
        'Recurring event generation is not imported; materialized future bookings require a separate completeness decision.',
      )
    if (event.seatsPerTimeSlot != null)
      add(
        'event_seats',
        'activation_blocker',
        'Seat capacity is not imported and must be resolved before activation.',
      )
    if (
      event.restrictionScheduleId != null ||
      event.minimumRescheduleNotice != null ||
      (snapshot.tables.HostLocation ?? []).some((h) => h.eventTypeId === id)
    )
      add(
        'event_extra_restriction',
        'activation_blocker',
        'An additional restriction schedule, reschedule notice or host-specific location cannot be represented by this draft.',
      )
    if (
      (snapshot.tables.TravelSchedule ?? []).some((r) => r.userId === user.sourceId) ||
      (snapshot.tables.OutOfOfficeEntry ?? []).some((r) => r.userId === user.sourceId) ||
      (snapshot.tables.UserHolidaySettings ?? []).some((r) => r.userId === user.sourceId)
    )
      add(
        'event_unavailable_rules',
        'activation_blocker',
        'Effective travel, out-of-office or holiday rules are not imported; the event must remain inactive until availability is reviewed.',
      )
    const hostScheduleIds = [...new Set(hosts.map((h) => h.scheduleId).filter((s) => s != null))]
    const sourceUser = snapshot.tables.users?.find((u) => u.id === user.sourceId)
    const scheduleId = event.scheduleId ?? hostScheduleIds[0] ?? sourceUser?.defaultScheduleId
    let scheduleSourceId: number | null = null
    let proposedScheduleTimezone: string | null = null
    if (hostScheduleIds.length > 1 && event.scheduleId == null)
      add(
        'event_schedule_ambiguous',
        'import_blocker',
        'The single host has conflicting schedule relationships.',
      )
    if (scheduleId == null)
      add(
        'event_schedule_unresolved',
        'activation_blocker',
        'The source uses an unordered first schedule or built-in fallback; the owner must choose a concrete schedule before activation.',
      )
    else {
      const schedule = schedules.find(
        (s) => s.sourceId === scheduleId && s.sourceUserId === user.sourceId,
      )
      if (!schedule?.valid)
        add(
          'event_schedule_invalid',
          'import_blocker',
          'The effective source schedule is missing, invalid or belongs to another user.',
        )
      else {
        scheduleSourceId = schedule.sourceId
        if (schedule.requiresTimezoneConfirmation) {
          try {
            proposedScheduleTimezone = validateTimeZone(event.timeZone ?? user.sourceTimezone)
          } catch {
            add('event_timezone', 'import_blocker', 'The proposed event time zone is invalid.')
          }
          add(
            'event_schedule_timezone',
            'activation_blocker',
            'The effective schedule time zone is a proposal requiring owner confirmation; no provider is queried.',
          )
        }
      }
    }
    const location = parseEventLocation(event, problems)
    const mappedQuestions = parseQuestions(
      event,
      (snapshot.tables.EventTypeCustomInput ?? []).filter((q) => q.eventTypeId === id),
      problems,
    )
    if (!event.disableGuests)
      add(
        'event_guest_limit',
        'warning',
        'New target bookings allow at most ten guests; existing source attendees are validated separately and never truncated.',
      )
    add(
      'event_notifications_omitted',
      'warning',
      'Source workflows, notifications, redirects, tracking and provider ownership are not imported; this draft has empty notifications and no success redirect.',
    )
    if (problems.slice(startProblems).some((p) => p.severity === 'import_blocker')) continue
    plans.push({
      sourceId: id,
      sourceUserId: user.sourceId,
      targetUserId: user.targetUserId,
      organizationId: user.organizationId,
      title: title as string,
      slug: slug as string,
      description,
      position: event.position as number,
      durationMinutes: event.length as number,
      allowedDurationsMinutes: allowed as number[],
      slotStepMinutes: event.slotInterval as number | null,
      bufferBeforeMinutes: event.beforeEventBuffer as number,
      bufferAfterMinutes: event.afterEventBuffer as number,
      minimumNoticeMinutes: event.minimumBookingNotice as number,
      bookingWindowDays: null,
      maxBookingsPerDay,
      isHidden: event.hidden as boolean,
      isActive: false,
      allowGuests: !event.disableGuests,
      schedulingType: 'individual',
      scheduleSourceId,
      proposedScheduleTimezone,
      location,
      questions: mappedQuestions.questions,
      questionCrosswalk: mappedQuestions.crosswalk,
      notifications: { reminders: [], followUps: [] },
      successRedirect: null,
      sourceConstraints: {
        periodType: periodType as string,
        periodDays: event.periodDays as number | null,
        periodCountCalendarDays: event.periodCountCalendarDays as boolean | null,
        periodStartDate: event.periodStartDate as string | null,
        periodEndDate: event.periodEndDate as string | null,
        bookingLimits,
        durationLimits,
        maxActiveBookingsPerBooker: event.maxActiveBookingsPerBooker as number | null,
      },
    })
  }
  return plans.filter(
    (p) =>
      !problems.some(
        (problem) =>
          problem.source.table === 'EventType' &&
          problem.source.id === p.sourceId &&
          problem.severity === 'import_blocker',
      ),
  )
}
