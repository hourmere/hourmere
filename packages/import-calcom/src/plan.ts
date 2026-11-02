import { createHash } from 'node:crypto'
import { type BusyBookingPlan, parseBookings } from './bookings.ts'
import { type EventPlan, parseEvents } from './events.ts'
import { parseSchedules, type SchedulePlan } from './schedules.ts'
import {
  type BookingDecision,
  LIMITS,
  type MatchedUser,
  type ParseOptions,
  type PlanProblem,
  type SourceSnapshot,
} from './types.ts'
import { parseUsers, validateTargetContext, validInstant } from './users.ts'

export class ImportInputError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImportInputError'
    this.code = code
  }
}
/** Canonical private-data fingerprints; raw source objects are never embedded in a plan. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      )
    return v
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
export interface ImportPlan {
  contractVersion: 1
  mode: 'dry_run'
  writesPerformed: 0
  sourceVersion: SourceSnapshot['sourceVersion']
  schemaFingerprint: string
  sourceFingerprint: string
  targetContextFingerprint: string
  cutoff: string
  extractedAt: string
  selectedUserIds: number[]
  users: MatchedUser[]
  bookingDecisions: BookingDecision[]
  userBatches: { sourceUserId: number; disposition: 'blocked' | 'candidate' }[]
  schedules: SchedulePlan[]
  events: EventPlan[]
  bookings: BusyBookingPlan[]
  problems: PlanProblem[]
  summary: {
    matchedUsers: number
    draftEvents: number
    schedules: number
    localBusyBookings: number
    warnings: number
    activationBlockers: number
    importBlockers: number
    excluded: number
  }
  /** Pure parsing output. A future authorized preview must reread and validate target state. */
  targetVerification: 'operator_supplied_snapshot'
}
const outOfScope: [string, string, string][] = [
  [
    'scope_automation_excluded',
    'Workflows',
    'Workflows, reminders, follow-ups, scheduled triggers and delivery history are excluded.',
  ],
  [
    'scope_team_routing_excluded',
    'Team',
    'Teams, organizations, routing, managed events and their permissions are excluded.',
  ],
  [
    'scope_payment_excluded',
    'Payment',
    'Payments, billing, seats, instant meetings and AI calls are excluded; detected associations block the affected items.',
  ],
  [
    'scope_credentials_excluded',
    'Credential',
    'Authentication and integration credentials are never read or copied.',
  ],
  [
    'scope_provider_ownership_excluded',
    'BookingReference',
    'Provider ownership and calendar identities are excluded; existing invitations remain managed in the source system.',
  ],
  [
    'scope_content_excluded',
    'EventType',
    'Analytics, tracking, internal notes, branding, translations, redirects and attachments are excluded.',
  ],
  [
    'scope_availability_features_excluded',
    'TravelSchedule',
    'Travel, out-of-office, holiday and restriction rules require event activation review; explicit date overrides are retained.',
  ],
]
export function parseImportPlan(snapshot: SourceSnapshot, options: ParseOptions): ImportPlan {
  const fail = () => {
    throw new ImportInputError(
      'input_invalid',
      'The extraction snapshot or target context is invalid or exceeds the import limits.',
    )
  }
  if (
    !snapshot ||
    !['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'].includes(snapshot.sourceVersion) ||
    !validInstant(snapshot.cutoff) ||
    !validInstant(snapshot.extractedAt) ||
    !/^[a-f0-9]{64}$/.test(snapshot.schemaFingerprint) ||
    !validateTargetContext(options?.target) ||
    !Array.isArray(options?.bookingDecisions)
  )
    fail()
  if (
    options.bookingDecisions.some(
      (d) =>
        !d ||
        !Number.isSafeInteger(d.sourceBookingId) ||
        d.sourceBookingId < 1 ||
        !Number.isSafeInteger(d.sourceUserId) ||
        d.sourceUserId < 1 ||
        d.singleHostAndAttendeeRolesConfirmed !== true ||
        (d.bookerAttendeeId !== undefined &&
          (!Number.isSafeInteger(d.bookerAttendeeId) || d.bookerAttendeeId < 1)) ||
        (d.acceptMissingLocation !== undefined && typeof d.acceptMissingLocation !== 'boolean') ||
        (d.recurringOccurrencesComplete !== undefined &&
          typeof d.recurringOccurrencesComplete !== 'boolean'),
    )
  )
    fail()
  if (
    !Array.isArray(snapshot.selectedUserIds) ||
    !snapshot.selectedUserIds.length ||
    snapshot.selectedUserIds.length > LIMITS.users ||
    snapshot.selectedUserIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(snapshot.selectedUserIds).size !== snapshot.selectedUserIds.length
  )
    fail()
  let rows = 0
  for (const [table, entries] of Object.entries(snapshot.tables)) {
    if (!Array.isArray(entries) || entries.length > LIMITS.perTable) fail()
    rows += entries.length
    for (const row of entries)
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Buffer.byteLength(JSON.stringify(row)) > LIMITS.jsonBytes ||
        (Object.hasOwn(row, 'id') &&
          (table === 'HostGroup'
            ? typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(row.id)
            : !Number.isSafeInteger(row.id) || (row.id as number) < 1))
      )
        fail()
  }
  if (rows > LIMITS.totalRows || Buffer.byteLength(JSON.stringify(snapshot)) > LIMITS.snapshotBytes)
    fail()
  const problems: PlanProblem[] = []
  const users = parseUsers(snapshot, options.target, problems)
  const schedules = parseSchedules(snapshot, users, problems)
  let events = parseEvents(snapshot, users, schedules, problems)
  const slugConflicts = new Set<number>()
  for (const event of events) {
    if (
      options.target.occupiedSlugs.some(
        (s) => s.organizationId === event.organizationId && s.slug === event.slug,
      ) ||
      events.some(
        (e) =>
          e.sourceId !== event.sourceId &&
          e.organizationId === event.organizationId &&
          e.slug === event.slug,
      )
    ) {
      problems.push({
        code: 'event_slug_conflict',
        severity: 'import_blocker',
        source: { table: 'EventType', id: event.sourceId },
        message: 'The event slug conflicts with another event in this personal organization.',
      })
      slugConflicts.add(event.sourceId)
    }
  }
  events = events.filter((e) => !slugConflicts.has(e.sourceId))
  const bookings = parseBookings(snapshot, users, events, options, problems)
  for (const [code, table, message] of outOfScope)
    problems.push({ code, severity: 'excluded', source: { table, id: 'scope' }, message })
  const bookingDecisions: BookingDecision[] = options.bookingDecisions.map((d) => ({
    sourceBookingId: d.sourceBookingId,
    sourceUserId: d.sourceUserId,
    singleHostAndAttendeeRolesConfirmed: true,
    ...(d.bookerAttendeeId !== undefined ? { bookerAttendeeId: d.bookerAttendeeId } : {}),
    ...(d.acceptMissingLocation !== undefined
      ? { acceptMissingLocation: d.acceptMissingLocation }
      : {}),
    ...(d.recurringOccurrencesComplete !== undefined
      ? { recurringOccurrencesComplete: d.recurringOccurrencesComplete }
      : {}),
  }))
  const userBatches = snapshot.selectedUserIds.map((sourceUserId) => {
    const blocked = problems.some((p) => {
      if (p.severity !== 'import_blocker') return false
      if (p.source.table === 'users') return p.source.id === sourceUserId
      const row = snapshot.tables[p.source.table as keyof typeof snapshot.tables]?.find(
        (r) => r.id === p.source.id,
      )
      if (!row) return true
      if (row.userId != null) return row.userId === sourceUserId
      if (row.scheduleId != null)
        return snapshot.tables.Schedule?.some(
          (s) => s.id === row.scheduleId && s.userId === sourceUserId,
        )
      if (row.bookingId != null)
        return snapshot.tables.Booking?.some(
          (b) => b.id === row.bookingId && b.userId === sourceUserId,
        )
      if (row.eventTypeId != null)
        return snapshot.tables.EventType?.some(
          (e) => e.id === row.eventTypeId && e.userId === sourceUserId,
        )
      return true
    })
    return { sourceUserId, disposition: blocked ? ('blocked' as const) : ('candidate' as const) }
  })
  const count = (severity: PlanProblem['severity']) =>
    problems.filter((p) => p.severity === severity).length
  return {
    contractVersion: 1,
    mode: 'dry_run',
    writesPerformed: 0,
    sourceVersion: snapshot.sourceVersion,
    schemaFingerprint: snapshot.schemaFingerprint,
    sourceFingerprint: fingerprint(snapshot.tables),
    targetContextFingerprint: fingerprint(options.target),
    cutoff: snapshot.cutoff,
    extractedAt: snapshot.extractedAt,
    selectedUserIds: [...snapshot.selectedUserIds],
    users: [...users.values()],
    bookingDecisions,
    userBatches,
    schedules,
    events,
    bookings,
    problems,
    summary: {
      matchedUsers: users.size,
      draftEvents: events.length,
      schedules: schedules.filter((s) => s.valid).length,
      localBusyBookings: bookings.length,
      warnings: count('warning'),
      activationBlockers: count('activation_blocker'),
      importBlockers: count('import_blocker'),
      excluded: count('excluded'),
    },
    targetVerification: 'operator_supplied_snapshot',
  }
}
