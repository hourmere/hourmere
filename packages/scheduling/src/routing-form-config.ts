// Routing-form configuration (docs/routing-forms.md, "Form model and limits" and "Rules and
// versions"): the shared validator for a version's questions, ordered rules and fallback, the
// validator for an invitee's answers, and the ordered first-match evaluator. Pure functions
// with no storage, transport or clock. Target eligibility and answer mappings, which read
// stored event types, are in routing-form-targets.ts. Nothing calls these while routing is
// hard-off; the configuration services and the public submission are their later callers.
import { cleanInviteeEmail } from './bookings.ts'
import { DomainError } from './errors.ts'
import { MAX_OPTION_LENGTH, MAX_QUESTIONS } from './questions.ts'
import { isMultiLineText, isSingleLineText } from './text.ts'

/** The design register's limits that bound validation and evaluation work. */
export const ROUTING_FORM_LIMITS = {
  questionsPerForm: 20,
  optionsPerQuestion: 50,
  rulesPerForm: 50,
  conditionsPerRule: 10,
  /** Question and option labels, in UTF-16 code units as submitted. */
  labelLength: 200,
  /** Short-text and email answers and the literals compared with them. */
  textAnswerLength: 500,
  /** Custom message targets. */
  messageLength: 2000,
} as const

/** One mapping per destination: the booking form's questions plus invitee name and email. */
export const MAX_MAPPINGS_PER_TARGET = MAX_QUESTIONS + 2

/** The stable rule identity of the fallback target in provenance. */
export const FALLBACK_RULE_ID = 'fallback'

export const ROUTING_QUESTION_TYPES = ['short_text', 'email', 'select'] as const
export type RoutingQuestionType = (typeof ROUTING_QUESTION_TYPES)[number]

export interface RoutingOption {
  id: string
  label: string
}

export type RoutingQuestion =
  | { id: string; type: 'short_text' | 'email'; label: string; required: boolean }
  | { id: string; type: 'select'; label: string; required: boolean; options: RoutingOption[] }

/** `equals` compares text, an email address or one option ID; `one_of` lists option IDs. */
export type RoutingCondition =
  | { questionId: string; operator: 'equals'; value: string }
  | { questionId: string; operator: 'one_of'; values: string[] }

export type RoutingMappingDestination =
  | { kind: 'inviteeName' }
  | { kind: 'inviteeEmail' }
  | { kind: 'question'; questionId: string }

export interface RoutingMapping {
  /** The routing question whose answer prefills the destination. */
  questionId: string
  destination: RoutingMappingDestination
  /** Select sources only: every option ID of the source → a current destination option. */
  options?: Record<string, string>
}

export type RoutingTarget =
  | { kind: 'event'; eventTypeId: string; mappings: RoutingMapping[] }
  | { kind: 'message'; message: string }

export interface RoutingRule {
  id: string
  conditions: RoutingCondition[]
  target: RoutingTarget
}

/** A version's routing content: what publication freezes and evaluation reads. */
export interface RoutingFormConfig {
  questions: RoutingQuestion[]
  rules: RoutingRule[]
  fallback: RoutingTarget
}

/** Validated answers keyed by question ID; unanswered optional questions are absent. */
export type RoutingAnswers = Readonly<Record<string, string>>

export type RoutingErrorCode =
  | 'invalid_routing_form'
  | 'invalid_routing_answers'
  | 'invalid_routing_target'

/**
 * A routing validation failure (400). `field` is the path of the offending input, such as
 * `rules.2.target`; `reason` says why a target or mapping is refused, such as
 * `group_booking` or `payment_required`. Neither the message nor these carry a submitted
 * value, so transports may expose both as open strings.
 */
export class RoutingValidationError extends DomainError {
  readonly field: string | undefined
  readonly reason: string | undefined

  constructor(code: RoutingErrorCode, field: string | undefined, message: string, reason?: string) {
    super('invalid', code, field === undefined ? message : `${field}: ${message}`)
    this.field = field
    this.reason = reason
  }
}

const invalidForm = (field: string | undefined, message: string) =>
  new RoutingValidationError('invalid_routing_form', field, message)
const invalidTarget = (field: string, message: string, reason: string) =>
  new RoutingValidationError('invalid_routing_target', field, message, reason)
const invalidAnswers = (field: string, message: string) =>
  new RoutingValidationError('invalid_routing_answers', field, message)

// Canonical lowercase UUIDs, as the routing tables' rule identity checks require.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A booking question ID (questions.ts).
const BOOKING_QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/
// Bidirectional embedding, override and isolate controls.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Text from an author or invitee: at most `max` UTF-16 code units as submitted, before
 * trimming, so every legal string is bounded; then trimmed, well-formed and free of control
 * characters (tabs and line breaks only when `multiline`) and bidirectional controls.
 * Returns '' for blank text and undefined for text that breaks a rule.
 */
export function cleanRoutingText(value: string, max: number, multiline = false) {
  if (value.length > max) return undefined
  const text = value.trim()
  if (!(multiline ? isMultiLineText(text) : isSingleLineText(text))) return undefined
  if (BIDI_CONTROLS.test(text)) return undefined
  return text
}

/** An object with no fields beyond `keys`. */
function strict<E extends Error>(
  value: unknown,
  keys: readonly string[],
  error: (message: string) => E,
): Record<string, unknown> {
  if (!isRecord(value)) throw error('must be an object')
  if (Object.keys(value).some((key) => !keys.includes(key))) throw error('has an unknown field')
  return value
}

function list<E extends Error>(
  value: unknown,
  min: number,
  max: number,
  error: (message: string) => E,
): unknown[] {
  if (!Array.isArray(value)) throw error('must be an array')
  if (value.length < min || value.length > max) throw error(`must have ${min} to ${max} items`)
  return value
}

function label<E extends Error>(
  value: unknown,
  max: number,
  error: (message: string) => E,
  multiline = false,
): string {
  const text = typeof value === 'string' ? cleanRoutingText(value, max, multiline) : undefined
  if (text === undefined)
    throw error(`must be text of at most ${max} characters without control characters`)
  if (text === '') throw error('must not be blank')
  return text
}

/** A new identity: a UUID not used by any other question, option or rule of the version. */
function identity(value: unknown, field: string, ids: Set<string>): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw invalidForm(field, 'must be a lowercase UUID')
  if (ids.has(value)) throw invalidForm(field, 'must not repeat another ID of this form')
  ids.add(value)
  return value
}

function validateQuestion(value: unknown, field: string, ids: Set<string>): RoutingQuestion {
  const at = (path: string) => (message: string) => invalidForm(`${field}${path}`, message)
  const q = strict(value, ['id', 'type', 'label', 'required', 'options'], at(''))
  const id = identity(q.id, `${field}.id`, ids)
  const type = ROUTING_QUESTION_TYPES.find((known) => known === q.type)
  if (type === undefined) throw invalidForm(`${field}.type`, 'must be short_text, email or select')
  const text = label(q.label, ROUTING_FORM_LIMITS.labelLength, at('.label'))
  if (q.required !== undefined && typeof q.required !== 'boolean')
    throw invalidForm(`${field}.required`, 'must be true or false')
  const required = q.required === true
  if (type !== 'select') {
    if (q.options !== undefined)
      throw invalidForm(`${field}.options`, 'only select questions take options')
    return { id, type, label: text, required }
  }
  const labels = new Set<string>()
  const options = list(q.options, 1, ROUTING_FORM_LIMITS.optionsPerQuestion, at('.options')).map(
    (option, i) => {
      const path = `.options.${i}`
      const o = strict(option, ['id', 'label'], at(path))
      const optionId = identity(o.id, `${field}${path}.id`, ids)
      const optionLabel = label(o.label, ROUTING_FORM_LIMITS.labelLength, at(`${path}.label`))
      const key = optionLabel.normalize('NFC')
      if (labels.has(key)) throw invalidForm(`${field}${path}.label`, 'must differ from the others')
      labels.add(key)
      return { id: optionId, label: optionLabel }
    },
  )
  return { id, type, label: text, required, options }
}

/**
 * The literal an `equals` condition compares with: an option ID of a select question, or
 * nonblank text that a legal answer could equal. Text is stored trimmed and NFC-normalized;
 * an email literal must pass the invitee email rule.
 */
function literal(question: RoutingQuestion, value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidForm(field, 'must be a string')
  if (question.type === 'select') {
    // No coercion: a label or any other string is not an option ID.
    if (!question.options.some((option) => option.id === value))
      throw invalidForm(field, "must be one of the question's option IDs")
    return value
  }
  const text = cleanRoutingText(value, ROUTING_FORM_LIMITS.textAnswerLength)
  if (text === undefined)
    throw invalidForm(field, 'must be text a valid answer could equal, without control characters')
  // A missing answer never matches, so an empty literal could only mislead.
  if (text === '') throw invalidForm(field, 'must not be blank')
  if (question.type === 'email' && cleanInviteeEmail(text) === undefined)
    throw invalidForm(field, 'must be an email address')
  return question.type === 'short_text' ? text.normalize('NFC') : text
}

function validateCondition(
  value: unknown,
  field: string,
  questions: ReadonlyMap<string, RoutingQuestion>,
): RoutingCondition {
  const c = strict(value, ['questionId', 'operator', 'value', 'values'], (message) =>
    invalidForm(field, message),
  )
  const question = typeof c.questionId === 'string' ? questions.get(c.questionId) : undefined
  if (question === undefined)
    throw invalidForm(`${field}.questionId`, 'must name a question of this form')
  if (c.operator === 'equals') {
    if (c.values !== undefined) throw invalidForm(`${field}.values`, 'equals takes value')
    return {
      questionId: question.id,
      operator: 'equals',
      value: literal(question, c.value, `${field}.value`),
    }
  }
  if (c.operator === 'one_of') {
    if (question.type !== 'select')
      throw invalidForm(`${field}.operator`, 'one_of applies to select questions only')
    if (c.value !== undefined) throw invalidForm(`${field}.value`, 'one_of takes values')
    const optionIds = new Set(question.options.map((option) => option.id))
    const values = list(c.values, 1, optionIds.size, (message) =>
      invalidForm(`${field}.values`, message),
    )
    const chosen = new Set<string>()
    for (const option of values) {
      if (typeof option !== 'string' || !optionIds.has(option))
        throw invalidForm(`${field}.values`, "must list the question's option IDs")
      if (chosen.has(option)) throw invalidForm(`${field}.values`, 'must not repeat an option')
      chosen.add(option)
    }
    return { questionId: question.id, operator: 'one_of', values: [...chosen] }
  }
  throw invalidForm(`${field}.operator`, 'must be equals or one_of')
}

function validateDestination(value: unknown, field: string): RoutingMappingDestination {
  const error = (message: string) => invalidTarget(field, message, 'invalid_mapping')
  if (!isRecord(value)) throw error('must be an object')
  if (value.kind === 'inviteeName' || value.kind === 'inviteeEmail') {
    strict(value, ['kind'], error)
    return { kind: value.kind }
  }
  if (value.kind === 'question') {
    strict(value, ['kind', 'questionId'], error)
    if (typeof value.questionId !== 'string' || !BOOKING_QUESTION_ID.test(value.questionId))
      throw error('must name a booking question ID')
    return { kind: 'question', questionId: value.questionId }
  }
  throw error('must be inviteeName, inviteeEmail or question')
}

const destinationKey = (destination: RoutingMappingDestination) =>
  destination.kind === 'question' ? `question:${destination.questionId}` : destination.kind

/**
 * A mapping's shape and its links to this form: the source question exists, the destination
 * is named once per target, and a select source has a complete crosswalk with no option IDs
 * beyond its own. Compatibility with the event's current booking form is checked against the
 * stored event (routing-form-targets.ts).
 */
function validateMapping(
  value: unknown,
  field: string,
  questions: ReadonlyMap<string, RoutingQuestion>,
): RoutingMapping {
  const error = (path: string) => (message: string) =>
    invalidTarget(`${field}${path}`, message, 'invalid_mapping')
  const m = strict(value, ['questionId', 'destination', 'options'], error(''))
  const source = typeof m.questionId === 'string' ? questions.get(m.questionId) : undefined
  if (source === undefined) throw error('.questionId')('must name a question of this form')
  const destination = validateDestination(m.destination, `${field}.destination`)
  if (source.type !== 'select') {
    if (m.options !== undefined) throw error('.options')('only select answers take options')
    return { questionId: source.id, destination }
  }
  const crosswalk = strict(
    m.options,
    source.options.map((option) => option.id),
    error('.options'),
  )
  const options: Record<string, string> = {}
  for (const option of source.options) {
    const mapped = Object.hasOwn(crosswalk, option.id) ? crosswalk[option.id] : undefined
    if (typeof mapped !== 'string' || mapped.length === 0 || mapped.length > MAX_OPTION_LENGTH)
      throw error('.options')('must map every option of the question to a booking option')
    options[option.id] = mapped
  }
  return { questionId: source.id, destination, options }
}

function validateTarget(
  value: unknown,
  field: string,
  questions: ReadonlyMap<string, RoutingQuestion>,
): RoutingTarget {
  const unsupported = (message: string) => invalidTarget(field, message, 'unsupported_target')
  if (!isRecord(value)) throw unsupported('must be an object')
  if (value.kind === 'message') {
    strict(value, ['kind', 'message'], unsupported)
    const message = label(
      value.message,
      ROUTING_FORM_LIMITS.messageLength,
      (text) => invalidTarget(`${field}.message`, text, 'invalid_message'),
      true,
    )
    return { kind: 'message', message }
  }
  if (value.kind === 'event') {
    // No member, host, URL or redirect selector: an event is routed to as it stands.
    strict(value, ['kind', 'eventTypeId', 'mappings'], unsupported)
    if (typeof value.eventTypeId !== 'string' || !UUID.test(value.eventTypeId))
      throw invalidTarget(`${field}.eventTypeId`, 'must be a lowercase UUID', 'not_found')
    const mappings = (
      value.mappings === undefined
        ? []
        : list(value.mappings, 0, MAX_MAPPINGS_PER_TARGET, (message) =>
            invalidTarget(`${field}.mappings`, message, 'invalid_mapping'),
          )
    ).map((mapping, i) => validateMapping(mapping, `${field}.mappings.${i}`, questions))
    const destinations = new Set<string>()
    mappings.forEach((mapping, i) => {
      const key = destinationKey(mapping.destination)
      if (destinations.has(key))
        throw invalidTarget(
          `${field}.mappings.${i}.destination`,
          'must not repeat another mapping of this target',
          'invalid_mapping',
        )
      destinations.add(key)
    })
    return { kind: 'event', eventTypeId: value.eventTypeId, mappings }
  }
  // External URLs and every other kind are refused, including for the fallback.
  throw invalidTarget(`${field}.kind`, 'must be event or message', 'unsupported_target')
}

/**
 * Validates a version's questions, ordered rules and fallback, and returns them normalized
 * (labels and messages trimmed, text literals NFC-normalized, `required` and `mappings`
 * defaulted). Throws the first problem as `invalid_routing_form`, or `invalid_routing_target`
 * for a target or mapping. Event targets are only checked for shape here; their eligibility
 * and mapping compatibility need the stored event (routing-form-targets.ts).
 */
export function validateRoutingFormConfig(value: unknown): RoutingFormConfig {
  const config = strict(value, ['questions', 'rules', 'fallback'], (message) =>
    invalidForm(undefined, message),
  )
  const ids = new Set<string>()
  const questions = list(config.questions, 0, ROUTING_FORM_LIMITS.questionsPerForm, (message) =>
    invalidForm('questions', message),
  ).map((question, i) => validateQuestion(question, `questions.${i}`, ids))
  const byId = new Map(questions.map((question) => [question.id, question]))
  const rules = list(config.rules, 0, ROUTING_FORM_LIMITS.rulesPerForm, (message) =>
    invalidForm('rules', message),
  ).map((rule, i): RoutingRule => {
    const field = `rules.${i}`
    const r = strict(rule, ['id', 'conditions', 'target'], (message) => invalidForm(field, message))
    const id = identity(r.id, `${field}.id`, ids)
    const conditions = list(r.conditions, 1, ROUTING_FORM_LIMITS.conditionsPerRule, (message) =>
      invalidForm(`${field}.conditions`, message),
    ).map((condition, j) => validateCondition(condition, `${field}.conditions.${j}`, byId))
    return { id, conditions, target: validateTarget(r.target, `${field}.target`, byId) }
  })
  return { questions, rules, fallback: validateTarget(config.fallback, 'fallback', byId) }
}

/**
 * Validates an invitee's answers against a version's questions and returns them normalized:
 * text trimmed, blank and null optional answers left out, in an object without a prototype.
 * Throws `invalid_routing_answers` for an unknown question ID, a value that is not a string,
 * text over the limit or with control characters, an invalid email address, a select value
 * that is not one of its option IDs, or a missing required answer (a present key holding
 * blank text does not count as an answer).
 */
export function validateRoutingAnswers(
  questions: readonly RoutingQuestion[],
  value: unknown,
): RoutingAnswers {
  if (!isRecord(value)) throw invalidAnswers('answers', 'must be an object keyed by question ID')
  const known = new Set(questions.map((question) => question.id))
  // The unknown key itself is never echoed.
  if (Object.keys(value).some((id) => !known.has(id)))
    throw invalidAnswers('answers', 'answers a question this form does not ask')
  const answers: Record<string, string> = Object.create(null)
  for (const question of questions) {
    const field = `answers.${question.id}`
    const given = Object.hasOwn(value, question.id) ? value[question.id] : undefined
    if (given !== undefined && given !== null && typeof given !== 'string')
      throw invalidAnswers(field, 'must be a string')
    const text =
      typeof given === 'string' ? cleanRoutingText(given, ROUTING_FORM_LIMITS.textAnswerLength) : ''
    if (text === undefined)
      throw invalidAnswers(
        field,
        `must be text of at most ${ROUTING_FORM_LIMITS.textAnswerLength} characters without control characters`,
      )
    if (text === '') {
      if (question.required) throw invalidAnswers(field, 'is required')
      continue
    }
    if (question.type === 'select' && !question.options.some((option) => option.id === given))
      throw invalidAnswers(field, "must be one of the question's option IDs")
    if (question.type === 'email' && cleanInviteeEmail(text) === undefined)
      throw invalidAnswers(field, 'must be an email address')
    answers[question.id] = text
  }
  return answers
}

/** The rule that matched (or `fallback`) and its target. */
export interface RoutingMatch {
  ruleId: string
  target: RoutingTarget
}

/** Exact text after NFC normalization, case-sensitive; email addresses ignore case. */
function comparable(type: RoutingQuestionType, value: string): string {
  if (type === 'short_text') return value.normalize('NFC')
  if (type === 'email') return value.toLowerCase()
  return value
}

function conditionMatches(
  condition: RoutingCondition,
  questions: ReadonlyMap<string, RoutingQuestion>,
  answers: RoutingAnswers,
): boolean {
  const question = questions.get(condition.questionId)
  if (question === undefined) return false
  const answer = Object.hasOwn(answers, condition.questionId)
    ? answers[condition.questionId]
    : undefined
  // A missing optional answer never matches anything.
  if (answer === undefined) return false
  if (condition.operator === 'one_of')
    return question.type === 'select' && condition.values.includes(answer)
  return comparable(question.type, answer) === comparable(question.type, condition.value)
}

/**
 * Evaluates the rules of a validated version top to bottom against validated answers: the
 * first rule whose every condition matches wins; when none does, the fallback applies. A rule
 * without conditions never matches. Whether the chosen target is still usable is decided by
 * the caller from current eligibility, never by moving on to a later rule.
 */
export function evaluateRoutingForm(
  config: RoutingFormConfig,
  answers: RoutingAnswers,
): RoutingMatch {
  const questions = new Map(config.questions.map((question) => [question.id, question]))
  for (const rule of config.rules) {
    if (
      rule.conditions.length > 0 &&
      rule.conditions.every((condition) => conditionMatches(condition, questions, answers))
    )
      return { ruleId: rule.id, target: rule.target }
  }
  return { ruleId: FALLBACK_RULE_ID, target: config.fallback }
}
