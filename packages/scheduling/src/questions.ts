// Booking-form questions (`event_types.questions`) and their answers (`bookings.responses`).
// This is the single definition: the owner-side API validates questions with
// QuestionsSchema before storing them, the booking path reads them with parseQuestions
// and checks answers with validateResponses. The format is described in docs/data-model.md.
import { z } from 'zod'
import { DomainError } from './errors.ts'
import { isMultiLineText, isSingleLineText, textSchema } from './text.ts'

export const QUESTION_TYPES = [
  'short_text',
  'long_text',
  'phone',
  'select',
  'multi_select',
  'checkbox',
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export const MAX_QUESTIONS = 20
export const MAX_QUESTION_LABEL = 200
export const MAX_OPTIONS = 50
export const MAX_OPTION_LENGTH = 200
/** Longest answer, in characters, for each text-like type. */
export const MAX_ANSWER_LENGTH = { short_text: 500, long_text: 5000, phone: 32 } as const

const isChoice = (type: QuestionType) => type === 'select' || type === 'multi_select'

/**
 * One extra booking-form field (name and email are always asked). Answers are keyed by
 * `id`; `options` are the choices of `select` and `multi_select` and absent otherwise.
 * Strict: unknown fields are refused, not dropped.
 */
export const QuestionSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'id must be 1 to 64 letters, digits, "_" or "-"')
      // Generic JSON handling (e.g. zod records) drops this key, so it could never be answered.
      .refine((id) => id !== '__proto__', 'id must not be __proto__'),
    label: textSchema({ max: MAX_QUESTION_LABEL }),
    type: z.enum(QUESTION_TYPES),
    required: z.boolean().default(false),
    options: z
      .array(textSchema({ max: MAX_OPTION_LENGTH }))
      .min(1)
      .max(MAX_OPTIONS)
      .optional(),
  })
  .superRefine((q, ctx) => {
    if (isChoice(q.type) && q.options === undefined) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: `${q.type} needs options` })
    }
    if (!isChoice(q.type) && q.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'only select and multi_select take options',
      })
    }
    if (q.options && new Set(q.options).size !== q.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'options must be distinct' })
    }
  })
export type Question = z.output<typeof QuestionSchema>

/** `event_types.questions`: at most MAX_QUESTIONS questions with distinct ids. */
export const QuestionsSchema = z
  .array(QuestionSchema)
  .max(MAX_QUESTIONS)
  .superRefine((questions, ctx) => {
    const seen = new Set<string>()
    questions.forEach((q, i) => {
      if (seen.has(q.id)) {
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'question ids must be distinct' })
      }
      seen.add(q.id)
    })
  })

/** Text for short_text, long_text and phone; an option for select; options for multi_select; a boolean for checkbox. */
export const ResponseValueSchema = z.union([z.string(), z.array(z.string()), z.boolean()])
export type ResponseValue = z.output<typeof ResponseValueSchema>

/** `bookings.responses`: answers keyed by question id. */
export const ResponsesSchema = z.record(z.string(), ResponseValueSchema)
export type Responses = z.output<typeof ResponsesSchema>

/**
 * Validates questions a host submits (the owner-side API's write path). Throws
 * `invalid_questions` naming the first problem; returns them normalized (trimmed, defaults).
 */
export function validateQuestions(value: unknown): Question[] {
  const result = QuestionsSchema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? `questions.${issue.path.join('.')}: ` : ''
    throw new DomainError('invalid', 'invalid_questions', `${where}${issue?.message ?? 'invalid'}`)
  }
  return result.data
}

/**
 * Reads `event_types.questions`. Questions are validated when they are stored, so data that
 * does not match the schema is a bug and throws (500), never a client error.
 */
export function parseQuestions(value: unknown): Question[] {
  const result = QuestionsSchema.safeParse(value)
  if (!result.success) {
    throw new Error('event_types.questions does not match QuestionsSchema', {
      cause: result.error,
    })
  }
  return result.data
}

const PHONE = /^\+?[0-9][0-9 ().-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks answers against the event type's questions and returns them normalized (text
 * trimmed, empty optional answers left out). Throws `invalid_responses` for an unknown
 * question, a missing required answer, or an answer of the wrong kind, length or text
 * (control characters, malformed Unicode; long_text may have tabs and line breaks).
 * Answers are read as own properties only and returned in an object without a prototype,
 * so question ids such as `constructor` or `__proto__` never reach Object.prototype.
 */
export function validateResponses(questions: readonly Question[], given: unknown): Responses {
  const invalid = (message: string) => new DomainError('invalid', 'invalid_responses', message)
  if (!isRecord(given)) throw invalid('responses must be an object keyed by question id')
  const ids = new Set(questions.map((q) => q.id))
  if (Object.keys(given).some((id) => !ids.has(id))) {
    throw invalid('responses answers a question this event type does not ask')
  }
  const result: Responses = Object.create(null)
  for (const q of questions) {
    const value = Object.hasOwn(given, q.id) ? given[q.id] : undefined
    const name = `Question "${q.id}"`
    const missing = () => invalid(`${name} is required`)
    switch (q.type) {
      case 'short_text':
      case 'long_text':
      case 'phone': {
        if (value === undefined || value === null) {
          if (q.required) throw missing()
          break
        }
        if (typeof value !== 'string') throw invalid(`${name} takes text`)
        const text = value.trim()
        if (text === '') {
          if (q.required) throw missing()
          break
        }
        if (text.length > MAX_ANSWER_LENGTH[q.type]) {
          throw invalid(`${name} takes at most ${MAX_ANSWER_LENGTH[q.type]} characters`)
        }
        if (!(q.type === 'long_text' ? isMultiLineText(text) : isSingleLineText(text))) {
          throw invalid(`${name} contains characters that are not allowed`)
        }
        if (q.type === 'phone' && !PHONE.test(text)) throw invalid(`${name} takes a phone number`)
        result[q.id] = text
        break
      }
      case 'select': {
        if (value === undefined || value === null || value === '') {
          if (q.required) throw missing()
          break
        }
        if (typeof value !== 'string' || !q.options?.includes(value)) {
          throw invalid(`${name} takes one of its options`)
        }
        result[q.id] = value
        break
      }
      case 'multi_select': {
        if (value === undefined || value === null || (Array.isArray(value) && !value.length)) {
          if (q.required) throw missing()
          break
        }
        if (
          !Array.isArray(value) ||
          !value.every((v) => typeof v === 'string' && q.options?.includes(v)) ||
          new Set(value).size !== value.length
        ) {
          throw invalid(`${name} takes a list of distinct options`)
        }
        result[q.id] = value as string[]
        break
      }
      case 'checkbox': {
        if (value === undefined || value === null) {
          if (q.required) throw missing()
          break
        }
        if (typeof value !== 'boolean') throw invalid(`${name} takes true or false`)
        if (q.required && !value) throw missing()
        result[q.id] = value
        break
      }
    }
  }
  return result
}
