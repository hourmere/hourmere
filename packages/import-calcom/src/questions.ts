import { createHash } from 'node:crypto'
import {
  type Question,
  QuestionsSchema,
  type QuestionType,
} from '../../scheduling/src/questions.ts'
import { cleanText } from '../../scheduling/src/text.ts'
import type { PlanProblem, SourceRow } from './types.ts'

/** Retained in a future import association so historical answers never depend on labels. */
export interface QuestionCrosswalk {
  sourceKey: string
  questionId: string
  type: QuestionType
  optionValues: Record<string, string>
  legacyLabel?: string
}

export function stableQuestionId(eventId: number, sourceKey: string): string {
  return `cal_${createHash('sha256').update(`${eventId}:${sourceKey}`).digest('hex').slice(0, 40)}`
}

export function record(value: unknown): value is SourceRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const modernTypes: Record<string, QuestionType> = {
  text: 'short_text',
  textarea: 'long_text',
  phone: 'phone',
  select: 'select',
  radio: 'select',
  multiselect: 'multi_select',
  boolean: 'checkbox',
}
const legacyTypes: Record<string, QuestionType> = {
  text: 'short_text',
  textLong: 'long_text',
  phone: 'phone',
  bool: 'checkbox',
  radio: 'select',
}
const systemFields = new Set(['name', 'email', 'guests', 'location'])
const unsupported = [
  'getOptionsAt',
  'optionsInputs',
  'minLength',
  'maxLength',
  'min',
  'max',
  'pattern',
  'excludeEmails',
  'requireEmails',
  'conditions',
  'conditional',
  'variantsConfig',
  'variant',
  'readOnly',
  'readonly',
  'defaultValue',
  'prefill',
]

export function parseQuestions(
  event: SourceRow,
  legacyInputs: SourceRow[],
  problems: PlanProblem[],
): { questions: Question[]; crosswalk: QuestionCrosswalk[] } {
  const eventId = event.id as number
  const questions: Question[] = []
  const crosswalk: QuestionCrosswalk[] = []
  const add = (
    code: string,
    severity: PlanProblem['severity'],
    table = 'EventType',
    id: number | string = eventId,
  ) => {
    const messages: Record<string, string> = {
      question_shape: 'The source question shape is invalid.',
      question_key: 'Question identities must be nonempty and unique.',
      question_unsupported:
        'A source question feature has no equivalent and requires review before activation.',
      question_priced: 'Paid questions or options cannot be imported.',
      question_placeholder: 'Question placeholder text is not imported.',
      question_label: 'A question label is invalid or cannot be resolved without translation.',
      question_options:
        'Choice options must have unique labels and an unambiguous value mapping within the target limits.',
      question_normalized:
        'Question text is trimmed to meet target validation; the answer crosswalk preserves original values.',
      question_limit: 'The event has more than twenty extra questions.',
      question_system:
        'A configured system field is represented by the target booking fields rather than an extra question.',
    }
    problems.push({
      code,
      severity,
      source: { table, id },
      message: messages[code] ?? 'Question validation failed.',
    })
  }
  if (event.bookingFields != null && !Array.isArray(event.bookingFields)) {
    add('question_shape', 'import_blocker')
    return { questions, crosswalk }
  }
  const modern = Array.isArray(event.bookingFields) && event.bookingFields.length > 0
  const fields: unknown[] = modern ? (event.bookingFields as unknown[]) : legacyInputs
  const seen = new Set<string>()
  const seenLegacyLabels = new Set<string>()
  for (const raw of fields) {
    if (!record(raw)) {
      add('question_shape', 'import_blocker')
      continue
    }
    const table = modern ? 'EventType' : 'EventTypeCustomInput'
    const id = modern ? eventId : typeof raw.id === 'number' ? raw.id : eventId
    const issue = (code: string, severity: PlanProblem['severity']) =>
      add(code, severity, table, id)
    if (
      (raw.price != null && raw.price !== 0) ||
      (Array.isArray(raw.options) &&
        raw.options.some((o) => record(o) && o.price != null && o.price !== 0))
    ) {
      issue('question_priced', 'import_blocker')
      continue
    }
    const key = modern
      ? raw.name
      : typeof raw.id === 'number' && Number.isSafeInteger(raw.id)
        ? `legacy:${raw.id}`
        : undefined
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) {
      issue('question_key', 'import_blocker')
      continue
    }
    seen.add(key)
    if (modern && systemFields.has(key)) {
      issue('question_system', 'warning')
      if (
        ['hidden', 'disableOnPrefill', 'readOnly', 'readonly'].some((k) => raw[k] === true) ||
        raw.editable === 'user-readonly' ||
        unsupported.some((k) => raw[k] != null)
      ) {
        issue('question_unsupported', 'activation_blocker')
      }
      continue
    }
    if (
      unsupported.some((k) => raw[k] != null && raw[k] !== false) ||
      raw.hidden === true ||
      raw.disableOnPrefill === true ||
      raw.editable === 'user-readonly' ||
      raw.labelAsSafeHtml != null
    ) {
      issue('question_unsupported', 'activation_blocker')
      continue
    }
    const type =
      typeof raw.type === 'string' ? (modern ? modernTypes : legacyTypes)[raw.type] : undefined
    // The audited modern checkbox widget is a group of choices, not one boolean.
    if (!type) {
      issue('question_unsupported', 'activation_blocker')
      continue
    }
    if (raw.placeholder != null || raw.defaultPlaceholder != null)
      issue('question_placeholder', 'warning')
    const label = cleanText(raw.label, { max: 200 })
    if (!label) {
      issue('question_label', 'import_blocker')
      continue
    }
    if (!modern && seenLegacyLabels.has(raw.label as string)) {
      issue('question_key', 'import_blocker')
      continue
    }
    seenLegacyLabels.add(raw.label as string)
    if (label !== raw.label) issue('question_normalized', 'warning')
    if (raw.required != null && typeof raw.required !== 'boolean') {
      issue('question_shape', 'import_blocker')
      continue
    }
    const question: Question = {
      id: stableQuestionId(eventId, key),
      label,
      type,
      required: raw.required === true,
    }
    const optionValues: Record<string, string> = Object.create(null)
    if (type === 'select' || type === 'multi_select') {
      const options: unknown = raw.options
      if (!Array.isArray(options) || options.length < 1 || options.length > 50) {
        issue('question_options', 'import_blocker')
        continue
      }
      const labels: string[] = []
      let invalid = false
      for (const option of options) {
        if (!record(option)) {
          invalid = true
          break
        }
        if (!modern && typeof option.type !== 'string') {
          invalid = true
          break
        }
        const rawLabel = record(option) ? option.label : option
        const value = modern && record(option) ? option.value : rawLabel
        const optionLabel = cleanText(rawLabel, { max: 200 })
        if (
          !optionLabel ||
          typeof value !== 'string' ||
          value === '' ||
          Object.hasOwn(optionValues, value) ||
          labels.includes(optionLabel)
        ) {
          invalid = true
          break
        }
        optionValues[value] = optionLabel
        labels.push(optionLabel)
        if (optionLabel !== rawLabel) issue('question_normalized', 'warning')
      }
      if (invalid) {
        issue('question_options', 'import_blocker')
        continue
      }
      question.options = labels
    } else if (raw.options != null && (!Array.isArray(raw.options) || raw.options.length > 0)) {
      issue('question_unsupported', 'activation_blocker')
      continue
    }
    questions.push(question)
    crosswalk.push({
      sourceKey: key,
      questionId: question.id,
      type,
      optionValues,
      ...(!modern ? { legacyLabel: raw.label as string } : {}),
    })
  }
  if (questions.length > 20) add('question_limit', 'import_blocker')
  if (!QuestionsSchema.safeParse(questions).success && questions.length <= 20)
    add('question_shape', 'import_blocker')
  return { questions, crosswalk }
}
