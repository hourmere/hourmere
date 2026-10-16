// The scheduling service layer: framework-free functions shared by the REST API and the
// MCP server. Each takes a ServiceContext (or PublicContext) and plain inputs, reads and
// writes through Kysely, and throws DomainError for failures the caller can act on.

export {
  type AvailabilityQuery,
  buildAvailabilityInput,
  findSlots,
  getPublicEventType,
  LOCATION_KINDS,
  type Location,
  type LocationKind,
  listPublicSlots,
  MAX_SLOT_RANGE_DAYS,
  type PublicEventType,
  QUESTION_TYPES,
  type Question,
  type QuestionType,
  type SlotView,
} from './availability.ts'
export {
  type Attendee,
  type Booking,
  type BookingPage,
  type BookingSource,
  type BookingStatus,
  type BookingWithToken,
  type CreateBookingInput,
  type CreateBookingResult,
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  DEFAULT_PAGE_SIZE,
  getHostBooking,
  getManagedBooking,
  type InviteeInput,
  type ListBookingsInput,
  listHostBookings,
  MAX_GUESTS,
  MAX_PAGE_SIZE,
  type PersonInput,
  type Responses,
  type ResponseValue,
  rescheduleManagedBooking,
} from './bookings.ts'
export type { PublicContext, ServiceContext } from './context.ts'
export { DomainError, type DomainErrorKind, RESERVED_ERROR_CODES } from './errors.ts'
