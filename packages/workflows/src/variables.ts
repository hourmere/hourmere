// The template variable catalog (docs/workflows.md, "Email and webhook actions" and
// "Permissions, persistence and audit"). Templates are plain text with `{{name}}` placeholders
// from this typed allowlist; anything else is unknown and refused at save and preview. The
// renderer that substitutes and escapes values belongs to a later step. No variable exposes
// another attendee's address, management tokens, private calendar contents, credentials, the
// conference organizer, start or retry capabilities, meeting URLs, cancellation reasons,
// free-text booking titles or attendee no-show markers.

import type { WorkflowEventTypeFacts, WorkflowOwner } from './ownership.ts'

/** Email recipient classes: the booker, the other attendees and the assigned hosts. */
export const WORKFLOW_RECIPIENT_CLASSES = Object.freeze(['booker', 'guests', 'hosts'] as const)
export type WorkflowRecipientClass = (typeof WORKFLOW_RECIPIENT_CLASSES)[number]

/**
 * The common variables. Each is in the team whitelist (docs/team-admin-bookings.md), so
 * personal and team workflows may use them for every recipient class.
 */
export const WORKFLOW_TEMPLATE_VARIABLES = Object.freeze({
  /** The recipient's own name. */
  'recipient.name': 'recipient name',
  /** The recipient's saved time zone, the label for the times below. */
  'recipient.time_zone': 'recipient time zone',
  'event_type.title': 'event type title',
  /** The public booking path while it is still valid. */
  'event_type.public_path': 'public booking path',
  /** Scheduled start in the recipient's saved zone, formatted by code. */
  'booking.start': 'scheduled start',
  /** Scheduled end in the recipient's saved zone, formatted by code. */
  'booking.end': 'scheduled end',
} as const)
export type WorkflowTemplateVariable = keyof typeof WORKFLOW_TEMPLATE_VARIABLES

/**
 * `answer.<questionId>`: the booker's saved scalar answer. Personal workflows only, scoped to
 * one event type, and only when no guest receives the message.
 */
export const WORKFLOW_ANSWER_VARIABLE_PREFIX = 'answer.'
/** Question types with one scalar answer; multi-select answers are lists. */
export const WORKFLOW_SCALAR_QUESTION_TYPES = Object.freeze([
  'short_text',
  'long_text',
  'phone',
  'select',
  'checkbox',
] as const)

const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const PLACEHOLDER_NAME = /^[A-Za-z0-9_.-]{1,80}$/

/**
 * The placeholder names in `text`, in order, or undefined when a placeholder is malformed: an
 * unclosed `{{`, a `}}` outside a placeholder or a name with other characters. One linear pass
 * with no recursion or evaluation.
 */
export function templatePlaceholders(text: string): string[] | undefined {
  const names: string[] = []
  let index = 0
  for (;;) {
    const open = text.indexOf('{{', index)
    const close = text.indexOf('}}', index)
    if (open === -1) return close === -1 ? names : undefined
    if (close !== -1 && close < open) return undefined
    const end = text.indexOf('}}', open + 2)
    if (end === -1) return undefined
    const name = text.slice(open + 2, end).trim()
    if (!PLACEHOLDER_NAME.test(name)) return undefined
    names.push(name)
    index = end + 2
  }
}

/** Where a template is used: who owns it, who receives it and its single event type. */
export interface WorkflowTemplateContext {
  owner: WorkflowOwner['kind']
  recipients: readonly WorkflowRecipientClass[]
  /** The event type of an event-specific scope; undefined for an all-event scope. */
  eventType: WorkflowEventTypeFacts | undefined
}

/**
 * Why `name` may not be used in this context, or undefined when it may. The reasons never
 * repeat the name or any value.
 */
export function templateVariableProblem(
  name: string,
  context: WorkflowTemplateContext,
): string | undefined {
  if (Object.hasOwn(WORKFLOW_TEMPLATE_VARIABLES, name)) return undefined
  if (!name.startsWith(WORKFLOW_ANSWER_VARIABLE_PREFIX)) return 'uses an unknown variable'
  const questionId = name.slice(WORKFLOW_ANSWER_VARIABLE_PREFIX.length)
  if (!QUESTION_ID.test(questionId)) return 'uses an unknown variable'
  if (context.owner !== 'personal') return 'uses an answer variable, which team workflows cannot'
  if (context.recipients.includes('guests'))
    return 'uses an answer variable, which guests cannot receive'
  if (!context.eventType) return 'uses an answer variable without a single event type scope'
  const question = context.eventType.questions.find((candidate) => candidate.id === questionId)
  if (!question) return 'uses an answer variable for a question the event type does not ask'
  if (!(WORKFLOW_SCALAR_QUESTION_TYPES as readonly string[]).includes(question.type))
    return 'uses an answer variable for a question without a single answer'
  return undefined
}
