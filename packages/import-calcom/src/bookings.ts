import { createHash } from 'node:crypto'
import { type Question, type Responses, validateResponses } from '../../scheduling/src/questions.ts'
import { cleanText } from '../../scheduling/src/text.ts'
import type { EventPlan } from './events.ts'
import { parseBookingLocation, type StaticLocation } from './locations.ts'
import type { MatchedUser, ParseOptions, PlanProblem, SourceRow, SourceSnapshot } from './types.ts'
import {
  canonicalTimezone,
  normalizeEmail,
  validEmail,
  validInstant,
  validLocale,
} from './users.ts'

export interface BusyBookingPlan {
  sourceId: number
  sourceUserId: number
  eventSourceId: number
  targetUserId: string
  organizationId: string
  policy: 'local_only_read_only'
  managedIn: 'source_system'
  status: 'confirmed'
  start: string
  end: string
  title: string
  location: StaticLocation | null
  questions: Question[]
  responses: Responses
  attendees: {
    sourceId: number
    name: string
    email: string
    timeZone: string
    locale: string | null
    isBooker: boolean
  }[]
  scheduleSourceId: number | null
  hostsUseDefaultSchedule: false
  requiredHostUserIds: [string]
  manageTokenHash: null
  rescheduledFromId: null
  notificationSnapshot: {
    version: 1
    executionMode: 'configurable'
    notifications: { reminders: []; followUps: [] }
  }
  externalActions: []
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const systemAnswers = new Set(['name', 'email', 'guests', 'location', 'notes'])
const excludedSystemAnswers = new Set(['title', 'rescheduleReason', 'attendeePhoneNumber'])

function mapAnswers(
  booking: SourceRow,
  event: EventPlan,
  problems: PlanProblem[],
): { questions: Question[]; responses: Responses } | undefined {
  const id = booking.id as number
  const report = (code: string, message: string) =>
    problems.push({ code, severity: 'import_blocker', source: { table: 'Booking', id }, message })
  const modern = booking.responses != null
  const given = modern ? booking.responses : (booking.customInputs ?? {})
  if (!record(given)) {
    report('booking_responses_invalid', 'Booking answers must be a supported object.')
    return
  }
  const answers: Record<string, unknown> = Object.create(null)
  let failed = false
  for (const [key, value] of Object.entries(given)) {
    if (modern && systemAnswers.has(key)) continue
    if (modern && excludedSystemAnswers.has(key)) {
      problems.push({
        code: 'booking_system_answer_excluded',
        severity: 'excluded',
        source: { table: 'Booking', id },
        message: 'An optional source system answer has no equivalent and is excluded.',
      })
      continue
    }
    const matches = event.questionCrosswalk.filter((c) =>
      modern ? c.sourceKey === key : c.legacyLabel === key,
    )
    if (matches.length !== 1 || !matches[0]) {
      report('booking_answer_unmapped', 'A booking answer has no unique question mapping.')
      failed = true
      continue
    }
    const crosswalk = matches[0]
    if (crosswalk.type === 'select' || crosswalk.type === 'multi_select') {
      const translate = (v: unknown) =>
        typeof v === 'string' && Object.hasOwn(crosswalk.optionValues, v)
          ? crosswalk.optionValues[v]
          : undefined
      const translated = Array.isArray(value) ? value.map(translate) : translate(value)
      if (
        translated === undefined ||
        (Array.isArray(translated) && translated.some((v) => v === undefined))
      ) {
        report(
          'booking_option_unmapped',
          'A booking answer does not match its source option values.',
        )
        failed = true
        continue
      }
      answers[crosswalk.questionId] = translated
    } else answers[crosswalk.questionId] = value
  }
  const questions: Question[] = event.questions.map((q) => ({ ...q, required: false }))
  const notes = modern ? given.notes : booking.description
  if (notes != null && notes !== '') {
    const mappedNotes = modern
      ? event.questionCrosswalk.find((c) => c.sourceKey === 'notes')
      : undefined
    if (mappedNotes) answers[mappedNotes.questionId] = notes
    else if (questions.length >= 20) {
      report('booking_notes_question_limit', 'Booking notes cannot fit within the question limit.')
      failed = true
    } else {
      const notesId = `cal_notes_${createHash('sha256').update(String(event.sourceId)).digest('hex').slice(0, 24)}`
      questions.push({ id: notesId, label: 'Notes', type: 'long_text', required: false })
      answers[notesId] = notes
    }
  }
  try {
    const responses = validateResponses(questions, answers)
    if (!failed) return { questions, responses }
  } catch {
    report('booking_answer_invalid', 'A booking answer has an invalid type, text, size or option.')
  }
}

export function parseBookings(
  snapshot: SourceSnapshot,
  matched: Map<number, MatchedUser>,
  events: EventPlan[],
  options: ParseOptions,
  problems: PlanProblem[],
): BusyBookingPlan[] {
  const result: BusyBookingPlan[] = []
  const overlapCandidates: {
    sourceId: number
    targetUserId: string
    start: string
    end: string
  }[] = []
  const cutoff = snapshot.cutoff
  for (const row of snapshot.tables.Booking ?? []) {
    if (row.lineageOnly === true) continue
    const id = row.id as number
    const problem = (
      code: string,
      message: string,
      severity: PlanProblem['severity'] = 'import_blocker',
      table = 'Booking',
      sourceId: number | string = id,
    ) => problems.push({ code, severity, source: { table, id: sourceId }, message })
    const before = problems.length
    const status = row.status
    if (
      !['accepted', 'cancelled', 'rejected', 'pending', 'awaiting_host'].includes(status as string)
    ) {
      problem(
        'booking_status_unknown',
        'The source booking status is not recognized by this adapter.',
      )
      continue
    }
    const start = validInstant(row.startTime)
    const end = validInstant(row.endTime)
    if (!start || !end || Temporal.Instant.compare(end, start) <= 0) {
      problem(
        'booking_time_invalid',
        'The booking must have valid UTC instants and a positive duration.',
      )
      continue
    }
    if (Temporal.Instant.compare(start, cutoff) <= 0) {
      problem('booking_not_future', 'An already-started or past booking is excluded.', 'excluded')
      continue
    }
    if (status === 'cancelled' || status === 'rejected') {
      problem(
        'booking_terminal_excluded',
        'A cancelled or rejected booking is excluded.',
        'excluded',
      )
      continue
    }
    if (status !== 'accepted') {
      problem(
        'booking_pending',
        'A future booking awaiting approval must be handled in the source system.',
      )
      continue
    }
    if (row.hasSuccessor === true || row.rescheduled === true) {
      let current = row
      const visited = new Set<number>([id])
      let validLeaf = false
      while (Array.isArray(current.successorIds) && current.successorIds.length === 1) {
        const nextId = current.successorIds[0]
        if (typeof nextId !== 'number' || visited.has(nextId)) break
        visited.add(nextId)
        const next = snapshot.tables.Booking?.find((b) => b.id === nextId)
        if (!next || next.userId !== row.userId || next.eventTypeId !== row.eventTypeId) break
        const nextStart = validInstant(next.startTime),
          nextEnd = validInstant(next.endTime)
        if (
          next.hasSuccessor !== true &&
          next.rescheduled !== true &&
          (!Array.isArray(next.successorIds) || next.successorIds.length === 0)
        ) {
          validLeaf =
            next.status === 'accepted' &&
            !!nextStart &&
            !!nextEnd &&
            Temporal.Instant.compare(nextStart, cutoff) > 0 &&
            Temporal.Instant.compare(nextEnd, nextStart) > 0
          break
        }
        current = next
      }
      problem(
        validLeaf ? 'booking_nonleaf_excluded' : 'booking_lineage_unresolved',
        validLeaf
          ? 'A superseded booking is excluded; its accepted leaf is evaluated separately.'
          : 'A rescheduled booking has no provable eligible accepted leaf in the selected source records.',
        validLeaf ? 'excluded' : 'import_blocker',
      )
      continue
    }
    const user = matched.get(row.userId as number)
    if (user) overlapCandidates.push({ sourceId: id, targetUserId: user.targetUserId, start, end })
    const event = events.find(
      (e) => e.sourceId === row.eventTypeId && e.sourceUserId === row.userId,
    )
    if (!user || !event) {
      problem(
        'booking_ownership_unresolved',
        'The booking requires a matched owner and a verified personal event type.',
      )
      continue
    }
    if (
      row.paid === true ||
      row.hasPayment === true ||
      (snapshot.tables.Payment ?? []).some((p) => p.bookingId === id)
    )
      problem(
        'booking_payment_unsupported',
        'A paid or payment-associated booking cannot be imported.',
      )
    if (
      (snapshot.tables.EventType ?? []).some(
        (e) => e.id === row.eventTypeId && e.seatsPerTimeSlot != null,
      ) ||
      row.hasSeats === true ||
      (snapshot.tables.BookingSeat ?? []).some((p) => p.bookingId === id) ||
      row.dynamicEventSlugRef != null ||
      row.dynamicGroupSlugRef != null
    )
      problem(
        'booking_scope_unsupported',
        'Seat, dynamic-group and multi-host bookings are outside this import scope.',
      )
    const decisions = options.bookingDecisions.filter((d) => d.sourceBookingId === id)
    const decision = decisions.length === 1 ? decisions[0] : undefined
    if (
      !decision ||
      decision.sourceUserId !== row.userId ||
      decision.singleHostAndAttendeeRolesConfirmed !== true
    )
      problem(
        'booking_history_confirmation_required',
        'The source owner must confirm the original single host and the attendee roles.',
      )
    if (row.recurringEventId != null && !decision?.recurringOccurrencesComplete)
      problem(
        'booking_recurring_incomplete',
        'The source owner must confirm that all future recurring occurrences have been materialized.',
      )
    const title = cleanText(row.title, { max: 200 })
    if (!title)
      problem('booking_title_invalid', 'The booking title is invalid or exceeds the text limit.')
    const location = parseBookingLocation(
      row,
      (snapshot.tables.BookingReference ?? []).filter((r) => r.bookingId === id),
      problems,
      decision?.acceptMissingLocation,
      snapshot.tables.EventType?.find((e) => e.id === row.eventTypeId),
    )
    const attendees = (snapshot.tables.Attendee ?? []).filter((a) => a.bookingId === id)
    if (attendees.length < 1 || attendees.length > 11)
      problem(
        'booking_attendee_count',
        'A booking needs exactly one booker and at most ten guests.',
      )
    const responses = record(row.responses) ? row.responses : undefined
    const responseEmail =
      typeof responses?.email === 'string' ? normalizeEmail(responses.email) : undefined
    const bookers = responseEmail
      ? attendees.filter(
          (a) => typeof a.email === 'string' && normalizeEmail(a.email) === responseEmail,
        )
      : attendees.filter((a) => decision?.bookerAttendeeId === a.id)
    if (
      bookers.length !== 1 ||
      (responseEmail &&
        decision?.bookerAttendeeId != null &&
        bookers[0]?.id !== decision.bookerAttendeeId)
    )
      problem(
        'booking_booker_unresolved',
        'The booking must identify exactly one booker without choosing the first attendee.',
      )
    const seenEmails = new Set<string>()
    const mappedAttendees: BusyBookingPlan['attendees'] = []
    for (const attendee of attendees) {
      const name = cleanText(attendee.name, { max: 200 })
      const email = cleanText(attendee.email, { max: 254 })
      const timezone = canonicalTimezone(attendee.timeZone)
      if (
        !name ||
        !email ||
        !validEmail(email) ||
        !timezone ||
        (attendee.locale != null && !validLocale(attendee.locale))
      ) {
        problem(
          'attendee_invalid',
          'An attendee name, email, time zone or locale is invalid.',
          'import_blocker',
          'Attendee',
          attendee.id as number,
        )
        continue
      }
      const normalized = normalizeEmail(email)
      if (seenEmails.has(normalized)) {
        problem(
          'attendee_email_duplicate',
          'Attendee email addresses must be distinct after trimming and case folding.',
          'import_blocker',
          'Attendee',
          attendee.id as number,
        )
        continue
      }
      seenEmails.add(normalized)
      mappedAttendees.push({
        sourceId: attendee.id as number,
        name,
        email,
        timeZone: timezone,
        locale: attendee.locale == null ? null : (attendee.locale as string),
        isBooker: bookers[0]?.id === attendee.id,
      })
    }
    const mappedAnswers = mapAnswers(row, event, problems)
    if (
      problems.slice(before).some((p) => p.severity === 'import_blocker') ||
      !mappedAnswers ||
      !title
    )
      continue
    result.push({
      sourceId: id,
      sourceUserId: user.sourceId,
      eventSourceId: event.sourceId,
      targetUserId: user.targetUserId,
      organizationId: user.organizationId,
      policy: 'local_only_read_only',
      managedIn: 'source_system',
      status: 'confirmed',
      start,
      end,
      title,
      location,
      ...mappedAnswers,
      attendees: mappedAttendees,
      scheduleSourceId: event.scheduleSourceId,
      hostsUseDefaultSchedule: false,
      requiredHostUserIds: [user.targetUserId],
      manageTokenHash: null,
      rescheduledFromId: null,
      notificationSnapshot: {
        version: 1,
        executionMode: 'configurable',
        notifications: { reminders: [], followUps: [] },
      },
      externalActions: [],
    })
  }
  const batchOverlaps = new Set<number>()
  const overlapBlocked = new Set<number>()
  const byHost = new Map<string, typeof overlapCandidates>()
  for (const booking of overlapCandidates) {
    const host = byHost.get(booking.targetUserId) ?? []
    host.push(booking)
    byHost.set(booking.targetUserId, host)
    const overlap = (start: string, end: string) =>
      Temporal.Instant.compare(booking.start, end) < 0 &&
      Temporal.Instant.compare(start, booking.end) < 0
    if (
      options.target.busy.some(
        (b) => b.targetUserId === booking.targetUserId && overlap(b.start, b.end),
      )
    ) {
      overlapBlocked.add(booking.sourceId)
      problems.push({
        code: 'booking_target_overlap',
        severity: 'import_blocker',
        source: { table: 'Booking', id: booking.sourceId },
        message: 'The booking overlaps an existing target busy interval for this host.',
      })
    }
  }
  for (const host of byHost.values()) {
    let latest: (typeof overlapCandidates)[number] | undefined
    for (const booking of host.sort((a, b) => a.start.localeCompare(b.start))) {
      if (latest && booking.start < latest.end) {
        batchOverlaps.add(latest.sourceId)
        batchOverlaps.add(booking.sourceId)
      }
      if (!latest || booking.end > latest.end) latest = booking
    }
  }
  for (const sourceId of batchOverlaps) {
    overlapBlocked.add(sourceId)
    problems.push({
      code: 'booking_batch_overlap',
      severity: 'import_blocker',
      source: { table: 'Booking', id: sourceId },
      message: 'The booking overlaps another source booking for this host.',
    })
  }
  return result.filter((booking) => !overlapBlocked.has(booking.sourceId))
}
