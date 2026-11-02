/** Untrusted, minimized source rows. Parsers validate before producing typed plans. */
export type SourceRow = Record<string, unknown>
export type SourceVersion = 'cal.diy-a5ee96f77edd' | 'cal.com-v6.2.0'
export type SourceTable =
  | 'users'
  | 'Profile'
  | 'EventType'
  | 'EventTypeCustomInput'
  | 'Host'
  | 'Schedule'
  | 'Availability'
  | 'Booking'
  | 'BookingSeat'
  | 'Attendee'
  | 'Team'
  | 'Membership'
  | 'TravelSchedule'
  | 'OutOfOfficeEntry'
  | 'UserHolidaySettings'
  | 'HostGroup'
  | 'HostLocation'
  | '_user_eventtype'
  | 'BookingReference'
  | 'Payment'
export interface SourceSnapshot {
  sourceVersion: SourceVersion
  schemaFingerprint: string
  extractedAt: string
  cutoff: string
  selectedUserIds: number[]
  tables: Partial<Record<SourceTable, SourceRow[]>>
  /** SQL aggregate only: omitted historical and terminal rows carry no booking payload. */
  bookingExclusionCounts?: {
    sourceUserId: number
    pastOrStarted: number
    terminal: number
  }[]
}
export interface TargetUser {
  id: string
  email: string
  emailVerified: boolean
  personalOrganizationId: string | null
  /** Explicit authorization by this target account's owner, checked outside this parser. */
  authorized: boolean
  profile?: { handle: string; timeZone: string; locale: string }
}
export interface TargetContext {
  users: TargetUser[]
  occupiedHandles: string[]
  occupiedSlugs: { organizationId: string; slug: string }[]
  busy: { targetUserId: string; start: string; end: string }[]
}
export interface MatchedUser {
  sourceId: number
  targetUserId: string
  organizationId: string
  sourceTimezone: string
  profile: { handle: string; timeZone: string; locale: string }
  profileAction: 'preserve' | 'propose'
}
export type ProblemSeverity = 'warning' | 'activation_blocker' | 'import_blocker' | 'excluded'
export interface PlanProblem {
  code: string
  severity: ProblemSeverity
  source: { table: string; id: number | string }
  /** Static English text: never interpolate a source value, email, URL or driver error. */
  message: string
}
export interface BookingDecision {
  sourceBookingId: number
  sourceUserId: number
  /** Source owner's explicit historical single-host and attendee-role confirmation. */
  singleHostAndAttendeeRolesConfirmed: true
  /** Required only for old records without responses.email. */
  bookerAttendeeId?: number
  acceptMissingLocation?: boolean
  recurringOccurrencesComplete?: boolean
}
export interface ParseOptions {
  target: TargetContext
  bookingDecisions: BookingDecision[]
}
/** Operational caps supplement the contract's per-field limits. No partial extraction. */
export const LIMITS = Object.freeze({
  users: 25,
  perTable: 10_000,
  totalRows: 50_000,
  jsonBytes: 1_000_000,
  snapshotBytes: 32 * 1024 * 1024,
})
