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
  type ExplainEventAvailabilityQuery,
  explainEventAvailability,
  findSlots,
  getOneTimeBookingPage,
  getPublicEventType,
  getPublicHost,
  getPublicTeamEventType,
  LOCATION_KINDS,
  type Location,
  type LocationKind,
  listOneTimeBookingSlots,
  listPublicSlots,
  listPublicTeamSlots,
  MAX_SLOT_CANDIDATES,
  MAX_SLOT_RANGE_DAYS,
  type OneTimeBookingPage,
  type OneTimeEventType,
  type PublicEventType,
  type PublicEventTypeSummary,
  type PublicHost,
  type SlotView,
} from './availability.ts'
export {
  BOOKING_EXPORT_COLUMNS,
  type BookingExportInput,
  exportBookingsCsv,
  MAX_EXPORT_DAYS,
  prepareBookingExport,
} from './booking-export.ts'
export { resolveBookingOrganization } from './booking-organization.ts'
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
  type CreateOneTimeBookingInput,
  cancelHostBooking,
  cancelManagedBooking,
  createOneTimeBooking,
  createPublicBooking,
  createPublicTeamBooking,
  DEFAULT_PAGE_SIZE,
  expireRescheduleRequest,
  getHostBooking,
  getManagedBooking,
  type InviteeInput,
  type ListBookingsInput,
  listHostBookings,
  MAX_GUESTS,
  MAX_PAGE_SIZE,
  type PersonInput,
  RESCHEDULE_REQUEST_TIMEOUT_HOURS,
  RescheduleRequestNoteSchema,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
export {
  BRAND_LOGO_MAX_BYTES,
  BrandingUpdateInput,
  getBranding,
  getBrandLogo,
  setBranding,
  uploadBrandLogo,
} from './branding.ts'
export {
  type CatalogPage,
  type CatalogPageInput,
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
} from './catalog-page.ts'
export { automaticMeet, type ConferenceStatus, conferenceRoot } from './conferences.ts'
export type {
  AttendeeNoShowNotifier,
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
  getEventTypeNotifications,
  getEventTypeWaitlist,
  getEventTypeWaitlistSummary,
  listEventTypeCatalog,
  listEventTypeHosts,
  listEventTypes,
  listEventTypeWaitlistEntries,
  type ManagedWaitlistEntry,
  PHONE_NUMBER_PATTERN,
  type QuestionInput,
  removeEventTypeWaitlistEntry,
  type SchedulingType,
  SLUG_PATTERN,
  setEventTypeNotifications,
  setEventTypeWaitlist,
  updateEventType,
  type WaitlistEntryState,
  type WaitlistSettings,
  WaitlistSettingsSchema,
} from './event-types.ts'
export { validTimeZone } from './internal.ts'
export {
  compatLocation,
  LOCATION_OPTION_LIMITS,
  type LocationChoiceContext,
  type LocationChoiceInput,
  type LocationOption,
  type LocationSettings,
  locationOptionsFromLegacy,
  type PublicLocationOption,
  publicLocationOptions,
  type ResolvedLocationChoice,
  resolveLocationChoice,
  validateLocationOptions,
} from './location-options.ts'
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
export { type AttendeeNoShow, listBookingAttendeeNoShows, setAttendeeNoShow } from './no-show.ts'
export * from './notification-settings.ts'
export {
  type CreateOneTimeBookingLinkInput,
  claimOneTimeBookingLink,
  createOneTimeBookingLink,
  getOneTimeBookingLink,
  listOneTimeBookingLinks,
  ONE_TIME_BOOKING_LINK_LIMIT,
  ONE_TIME_BOOKING_LINK_MEMBER_LIMIT,
  ONE_TIME_LINK_ALREADY_CREATED_MESSAGE,
  type OneTimeBookingLink,
  type OneTimeBookingLinkPrefill,
  type OneTimeBookingLinkState,
  type ResolvedOneTimeBookingLink,
  resolveOneTimeBookingLink,
  revokeManagedOneTimeBookingLink,
  revokeOneTimeBookingLink,
} from './one-time-links.ts'
export {
  type GenerateOpenTimeSnippetInput,
  generateOpenTimeSnippet,
  MAX_OPEN_TIME_SNIPPET_RANGE_DAYS,
  type OpenTimeSnippetOptions,
} from './open-time-snippets.ts'
export { expirePaymentHolds } from './payment-expiry.ts'
export { FakePaymentProvider, type PaymentProvider } from './payment-provider.ts'
export {
  cancelPaymentHold,
  confirmPaymentHold,
  createPaymentHold,
  PAYMENT_HOLD_MINUTES,
  type PaymentContext,
} from './payments.ts'
export {
  findLegacyHandleCollisions,
  getProfile,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  type LegacyHandleCollision,
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
  getScheduleAvailability,
  listScheduleCatalog,
  listScheduleOverrides,
  listSchedules,
  MAX_SCHEDULE_OVERRIDES,
  putScheduleOverride,
  SCHEDULE_NAME_MAX_LENGTH,
  type Schedule,
  type ScheduleAvailability,
  type ScheduleAvailabilityInput,
  type ScheduleInput,
  type ScheduleOverride,
  type ScheduleSummary,
  type ScheduleUpdate,
  saveScheduleAvailability,
  updateSchedule,
} from './schedules.ts'
export {
  type BookingSuccessRedirect,
  SUCCESS_REDIRECT_MAX_LENGTH,
  SUCCESS_REDIRECT_PARAMETERS,
  type SuccessRedirect,
  type SuccessRedirectInput,
  type SuccessRedirectParameter,
  type SuccessRedirectPolicy,
} from './success-redirect.ts'
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
export {
  cancelTeamAdminBooking,
  getTeamAdminBooking,
  listTeamAdminBookings,
} from './team-bookings.ts'
export {
  cleanText,
  isMultiLineText,
  isSingleLineText,
  type TextRules,
  textSchema,
} from './text.ts'
export * from './waitlist.ts'
export { scanWaitlistEvent, scanWaitlists } from './waitlist-discovery.ts'
