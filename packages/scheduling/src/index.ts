// The scheduling service layer: framework-free functions shared by the REST API and the
// MCP server. Each takes a ServiceContext (or PublicContext) and plain inputs, reads and
// writes through Kysely, and throws DomainError for failures the caller can act on.
export type { PublicContext, ServiceContext } from './context.ts'
export { DomainError, type DomainErrorKind, RESERVED_ERROR_CODES } from './errors.ts'
export {
  createEventType,
  deleteEventType,
  EVENT_TYPE_LIMITS,
  type EventType,
  type EventTypeInput,
  type EventTypeLocation,
  type EventTypeUpdate,
  getEventType,
  LOCATION_KINDS,
  type LocationKind,
  listEventTypes,
  PHONE_NUMBER_PATTERN,
  QUESTION_ID_PATTERN,
  QUESTION_TYPES,
  type Question,
  type QuestionInput,
  type QuestionType,
  type SchedulingType,
  SLUG_PATTERN,
  updateEventType,
} from './event-types.ts'
export {
  getProfile,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  LOCALE_MAX_LENGTH,
  type Profile,
  type ProfileInput,
  putProfile,
  RESERVED_HANDLES,
} from './profile.ts'
export {
  createSchedule,
  deleteSchedule,
  deleteScheduleOverride,
  getSchedule,
  listScheduleOverrides,
  listSchedules,
  putScheduleOverride,
  SCHEDULE_NAME_MAX_LENGTH,
  type Schedule,
  type ScheduleInput,
  type ScheduleOverride,
  type ScheduleUpdate,
  updateSchedule,
} from './schedules.ts'
