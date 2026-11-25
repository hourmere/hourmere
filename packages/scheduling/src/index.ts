// The scheduling service layer: framework-free functions shared by the REST API and the
// MCP server. Each takes a ServiceContext (or PublicContext) and plain inputs, reads and
// writes through Kysely, and throws DomainError for failures the caller can act on.

// Defined in core so notifications can use it without loading scheduling schemas.
export { PHONE_NUMBER_PATTERN } from '@hourmere/core'
export {
  type ActivityCounts,
  activityRange,
  type BookingActivity,
  getBookingActivity,
  MAX_ANALYTICS_DAYS,
} from './analytics.ts'
export {
  AUDIT_ACTOR_TYPES,
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  AUDIT_PURGE_BATCH,
  AUDIT_PURGE_MAX_BATCHES,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  AuditEventFilters,
  type AuditEventQuery,
  type AuditEventView,
  type AuditLogSettingsContext,
  AuditLogSettingsUpdate,
  type AuditLogSettingsView,
  type AuditPurgeResult,
  type AuditRetentionDays,
  auditRetentionLock,
  getAuditLogSettings,
  listAuditEvents,
  purgeAuditEvents,
  setAuditLogSettings,
} from './audit-log.ts'
export {
  type AvailabilityQuery,
  buildAvailabilityInput,
  type ExplainEventAvailabilityQuery,
  explainEventAvailability,
  findPublicBookingPath,
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
  type TroubleshootAvailabilityInput,
  type TroubleshootAvailabilityResult,
  type TroubleshootReason,
  type TroubleshootSlot,
  troubleshootEventAvailability,
} from './availability-troubleshooting.ts'
export {
  BOOKING_EXPORT_COLUMNS,
  type BookingExportInput,
  exportBookingsCsv,
  MAX_EXPORT_DAYS,
  prepareBookingExport,
} from './booking-export.ts'
export { resolveBookingOrganization } from './booking-organization.ts'
export { MAX_SEARCH_LENGTH } from './booking-page.ts'
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
  type CreateRoutedBookingInput,
  cancelHostBooking,
  cancelManagedBooking,
  createOneTimeBooking,
  createPublicBooking,
  createPublicTeamBooking,
  createRoutedBooking,
  DEFAULT_PAGE_SIZE,
  expireRescheduleRequest,
  getHostBooking,
  getHostBookingDetail,
  getManagedBooking,
  type HostBookingDetail,
  type InviteeInput,
  type ListBookingsInput,
  listHostBookings,
  MAX_GUESTS,
  MAX_PAGE_SIZE,
  type ManagedBookingMutationSelector,
  type ManagedBookingSelector,
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
  getEmailBranding,
  getPublicBranding,
  getPublicBrandLogo,
  type PublicBranding,
  setBranding,
  uploadBrandLogo,
} from './branding.ts'
export {
  type CatalogPage,
  type CatalogPageInput,
  DEFAULT_CATALOG_PAGE_SIZE,
  MAX_CATALOG_PAGE_SIZE,
} from './catalog-page.ts'
export {
  CHANGE_CUTOFF_MAX_MINUTES,
  type ChangeCutoffs,
  type ChangeKind,
  changeDeadline,
} from './change-deadlines.ts'
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
  duplicateEventType,
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
export { cancelGroupOccurrence, getGroupOccurrenceAttendees } from './group-occurrences.ts'
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
  type MeetingPollOwnBallot,
  type MeetingPollReminderOptOut,
  optOutOfMeetingPollReminders,
  type SubmitMeetingPollBallotInput,
  submitMeetingPollBallot,
  type WithdrawMeetingPollVoterInput,
  withdrawMeetingPollVoter,
} from './meeting-poll-ballots.ts'
export { expireMeetingPollCapabilities } from './meeting-poll-capability-expiry.ts'
export {
  cleanupMeetingPolls,
  type MeetingPollCleanupOptions,
  type MeetingPollCleanupResult,
} from './meeting-poll-cleanup.ts'
export {
  type FinalizeMeetingPollInput,
  type FinalizeMeetingPollResult,
  finalizeMeetingPoll,
  MeetingPollAlreadyScheduledError,
} from './meeting-poll-finalize.ts'
export { ensureMeetingPollKey, MeetingPollKeyMismatchError } from './meeting-poll-key.ts'
export { bookingMeetingPollLinked } from './meeting-poll-outcomes.ts'
export { MEETING_POLL_LIMITS } from './meeting-poll-policy.ts'
export { type PublicMeetingPoll, readMeetingPoll } from './meeting-poll-public.ts'
export {
  getMeetingPollResults,
  type MeetingPollResults,
  removeMeetingPollVoter,
  removeUnverifiedMeetingPollVoters,
} from './meeting-poll-results.ts'
export {
  type EnrollMeetingPollVoterInput,
  enrollMeetingPollVoter,
  inviteMeetingPollVoters,
  type MeetingPollHostContext,
  type MeetingPollPublicContext,
  MeetingPollRateLimitError,
  type MeetingPollVoterState,
  meetingPollDerivedKey,
  recoverMeetingPollVoter,
  resendMeetingPollInvitation,
  type VerifyMeetingPollVoterResult,
  verifyMeetingPollVoter,
} from './meeting-poll-voters.ts'
export {
  cancelMeetingPoll,
  closeMeetingPoll,
  createMeetingPoll,
  deleteMeetingPoll,
  getMeetingPoll,
  listMeetingPolls,
  MEETING_POLL_PAGE_DEFAULT,
  MEETING_POLL_PAGE_MAX,
  type MeetingPoll,
  MeetingPollAlreadyCreatedError,
  MeetingPollSlotUnavailableError,
  type MeetingPollWithLink,
  rotateMeetingPollLink,
} from './meeting-polls.ts'
export {
  getTeamMemberDepartureImpact,
  hasTeamMemberDepartureImpact,
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
  ONE_TIME_LINK_PAGE_DEFAULT,
  ONE_TIME_LINK_PAGE_MAX,
  ONE_TIME_LINK_PAGE_MIN,
  ONE_TIME_LINK_PREFILL_EMAIL_MAX,
  ONE_TIME_LINK_PREFILL_NAME_MAX,
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
export {
  type CheckoutOperation,
  type CheckoutSession,
  checkoutReconciliationWindow,
  checkoutSessionExpiry,
  FakePaymentProvider,
  type PaymentMode,
  type PaymentProvider,
} from './payment-provider.ts'
export {
  type PaymentRefundProvider,
  PaymentRefundProviderError,
  runPaymentRefunds,
  type StripeRefundObservation,
} from './payment-refunds.ts'
export {
  cancelPaymentHold,
  confirmPaymentHold,
  createPaymentCheckout,
  createPaymentHold,
  PAYMENT_HOLD_MINUTES,
  type PaymentContext,
  type PaymentPrice,
  recordStripePaymentEvent,
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
  RECURRING_BOOKINGS_ENABLED,
  type RecurringBookingAdmissionDeps,
  recurringBookingAdmissionEnabled,
} from './recurring-admission.ts'
export {
  checkRecurringAvailability,
  type RecurringAvailabilityInput,
  type RecurringAvailabilityResult,
} from './recurring-availability.ts'
export {
  type CancelBookingSeriesInput,
  type CancelBookingSeriesResult,
  cancelHostBookingSeries,
  cancelManagedBookingSeries,
} from './recurring-cancellation.ts'
export {
  resolveSeriesCapability,
  resolveSeriesMember,
  type SeriesMemberMutationSelector,
  type SeriesMemberSelector,
} from './recurring-capabilities.ts'
export {
  BookingSeriesRateLimitError,
  type CreateBookingSeriesInput,
  type CreateBookingSeriesOptions,
  type CreateBookingSeriesResult,
  createPublicBookingSeries,
  createPublicTeamBookingSeries,
  type ExpectedBookingSeriesPreview,
} from './recurring-creation.ts'
export { bookingPreLockLinks } from './recurring-members.ts'
export {
  expandRecurringRule,
  MAX_RECURRING_HORIZON_DAYS,
  MAX_RECURRING_OCCURRENCES,
  MIN_RECURRING_OCCURRENCES,
  normalizeRecurringRule,
  type RecurringExpansionInput,
  type RecurringOccurrence,
  type RecurringRule,
} from './recurring-rules.ts'
export {
  listRoutingContinuationSlots,
  type RoutingContinuationContext,
  type RoutingContinuationEventType,
  resolveRoutingContinuation,
} from './routing-continuation.ts'
export {
  archiveRoutingForm,
  createRoutingForm,
  getPublicRoutingForm,
  getRoutingForm,
  listRoutingForms,
  type PublicRoutingFormAddress,
  previewRoutingForm,
  publishRoutingForm,
  ROUTING_RECEIPT_LIMITS,
  RoutingAdmissionError,
  type RoutingSubmissionContext,
  type RoutingSubmissionResult,
  resolvePublicRoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from './routing-form-service.ts'
export { routingRequestKey } from './routing-receipt-crypto.ts'
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
export { lockWorkflowOwner } from './workflow-owner-lock.ts'
