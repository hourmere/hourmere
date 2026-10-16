// The API's documented limits (the OpenAPI document's maxLength, minimum, maximum and
// pattern), checked in the forms before anything is sent so people see what to fix next to
// the field. The server checks them again and stays the authority. The server's test
// web-limits.test.ts compares these values with the published document, so they cannot
// drift apart unnoticed.

export const EVENT_TYPE = {
  titleMaxLength: 200,
  descriptionMaxLength: 5000,
  slugMaxLength: 64,
  /** Lowercase letters, digits and inner hyphens. */
  slugPattern: /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  addressMaxLength: 500,
  urlMaxLength: 2000,
  /** E.164: a plus sign, then 7–15 digits. */
  phonePattern: /^\+[1-9][0-9]{6,14}$/,
  positionMin: -2_147_483_648,
  positionMax: 2_147_483_647,
} as const

/** Bounds of the scheduling rules, inclusive (the availability engine's own). */
export const RULES = {
  durationMinutes: { min: 1, max: 1440 },
  slotStepMinutes: { min: 1, max: 1440 },
  bufferBeforeMinutes: { min: 0, max: 1440 },
  bufferAfterMinutes: { min: 0, max: 1440 },
  minimumNoticeMinutes: { min: 0, max: 525_600 },
  maxBookingsPerDay: { min: 1, max: 1000 },
  bookingWindowDays: { min: 1, max: 3650 },
} as const

export const QUESTIONS = {
  maxQuestions: 20,
  labelMaxLength: 200,
  maxOptions: 50,
  optionMaxLength: 200,
} as const

export const SCHEDULE = {
  nameMaxLength: 100,
} as const

export const PROFILE = {
  handleMaxLength: 40,
  /** Lowercase letters, digits and inner hyphens. */
  handlePattern: /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
  localeMaxLength: 35,
} as const

export const BOOKING = {
  cancelReasonMaxLength: 1000,
} as const
