// The scheduling service layer: framework-free functions shared by the REST API and the
// MCP server. Each takes a ServiceContext (or PublicContext) and plain inputs, reads and
// writes through Kysely, and throws DomainError for failures the caller can act on.

export {
  type ActivityCounts,
  activityRange,
  type BookingActivity,
  getBookingActivity,
  MAX_ANALYTICS_DAYS,
} from './analytics.ts'
export {
  type AvailabilityQuery,
  buildAvailabilityInput,
  findSlots,
  getPublicEventType,
  getPublicHost,
  getPublicTeamEventType,
  LOCATION_KINDS,
  type Location,
  type LocationKind,
  listPublicSlots,
  listPublicTeamSlots,
  MAX_SLOT_CANDIDATES,
  MAX_SLOT_RANGE_DAYS,
  type PublicEventType,
  type PublicEventTypeSummary,
  type PublicHost,
  type SlotView,
} from './availability.ts'
export {
  type Attendee,
  type Booking,
  type BookingOrigin,
  type BookingPage,
  type BookingSource,
  type BookingStatus,
  type BookingWithToken,
  type CreateBookingInput,
  type CreateBookingResult,
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  DEFAULT_PAGE_SIZE,
  getHostBooking,
  getManagedBooking,
  type InviteeInput,
  type ListBookingsInput,
  listHostBookings,
  MAX_GUESTS,
  MAX_PAGE_SIZE,
  type PersonInput,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
export {
  type CatalogPage,
  type CatalogPageInput,
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
} from './catalog-page.ts'
export { automaticMeet, type ConferenceStatus, conferenceRoot } from './conferences.ts'
export type {
  BookingEvent,
  BookingNotifier,
  PublicContext,
  ServiceContext,
} from './context.ts'
export { DomainError, type DomainErrorKind, RESERVED_ERROR_CODES } from './errors.ts'
export {
  activateRoundRobin,
  createEventType,
  deleteEventType,
  EVENT_TYPE_LIMITS,
  type EventType,
  type EventTypeInput,
  type EventTypeLocation,
  type EventTypeSummary,
  type EventTypeUpdate,
  getEventType,
  listEventTypeCatalog,
  listEventTypeHosts,
  listEventTypes,
  PHONE_NUMBER_PATTERN,
  type QuestionInput,
  type SchedulingType,
  SLUG_PATTERN,
  updateEventType,
} from './event-types.ts'
export { validTimeZone } from './internal.ts'
export {
  getManagedBookingDetails,
  listHostBookingSlots,
  listManagedSlots,
  type ManagedBooking,
} from './manage.ts'
export {
  getTeamMemberDepartureImpact,
  MemberDepartureBookingSchema,
  MemberDepartureEventTypeSchema,
  type MemberDepartureImpact,
  type MemberDepartureImpactInput,
  MemberDepartureImpactSchema,
} from './member-departure-impact.ts'
export { leaveTeamMember } from './member-leave.ts'
export {
  getLatestTeamMemberRemovalHandling,
  getTeamMemberRemovalHandling,
  type LatestMemberRemovalHandlingInput,
  type MemberRemovalHandling,
  type MemberRemovalHandlingInput,
  MemberRemovalHandlingSchema,
} from './member-removal.ts'
export {
  getProfile,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  LOCALE_MAX_LENGTH,
  type Profile,
  type ProfileInput,
  putProfile,
  RESERVED_HANDLES,
  updateDisplayName,
} from './profile.ts'
export {
  MAX_ANSWER_LENGTH,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LABEL,
  MAX_QUESTIONS,
  parseQuestions,
  QUESTION_TYPES,
  type Question,
  QuestionSchema,
  QuestionsSchema,
  type QuestionType,
  type Responses,
  ResponsesSchema,
  type ResponseValue,
  ResponseValueSchema,
  validateQuestions,
  validateResponses,
} from './questions.ts'
export {
  getSelfReadiness,
  getTeamMemberReadiness,
  getTeamReadiness,
  type MemberReadinessPage,
  MemberReadinessPageSchema,
  type ReadinessMemberContext,
  type ReadinessPageInput,
  ReadinessStateSchema,
  type ReadinessTeamContext,
  type SelfReadiness,
  type SelfReadinessPage,
  SelfReadinessPageSchema,
  type TeamReadinessPage,
  TeamReadinessPageSchema,
} from './readiness.ts'
export {
  confirmDefaultSchedule,
  createSchedule,
  deleteSchedule,
  deleteScheduleOverride,
  getSchedule,
  listScheduleCatalog,
  listScheduleOverrides,
  listSchedules,
  putScheduleOverride,
  SCHEDULE_NAME_MAX_LENGTH,
  type Schedule,
  type ScheduleInput,
  type ScheduleOverride,
  type ScheduleSummary,
  type ScheduleUpdate,
  updateSchedule,
} from './schedules.ts'
export {
  type TeamAdminBooking,
  TeamAdminBookingListItemSchema,
  type TeamAdminBookingListPage,
  TeamAdminBookingListPageSchema,
  type TeamAdminBookingPage,
  TeamAdminBookingPageSchema,
  type TeamAdminBookingRecord,
  TeamAdminBookingSchema,
  toTeamAdminBooking,
} from './team-admin-booking.ts'
export { cancelTeamAdminBooking, listTeamAdminBookings } from './team-bookings.ts'
export {
  cleanText,
  isMultiLineText,
  isSingleLineText,
  type TextRules,
  textSchema,
} from './text.ts'
