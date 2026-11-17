// Shared pure rendering for execution and the later synthetic preview. No transport, database
// lookup or user-supplied HTML enters this module. Catalog expansion is a separate step.
import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
  localeFallbacks,
} from '@hourmere/core/language'
import { escapeHtml, multiLine, subjectLine } from '@hourmere/mail/text'
import { DomainError } from '@hourmere/scheduling/errors'
import { isMultiLineText, isSingleLineText } from '@hourmere/scheduling/text'
import type { WorkflowAction, WorkflowTriggerType } from './definition.ts'
import {
  WORKFLOW_BODY_MAX_BYTES,
  WORKFLOW_RENDERED_MAX_BYTES,
  WORKFLOW_SUBJECT_MAX_BYTES,
} from './limits.ts'
import {
  templatePlaceholders,
  templateVariableProblem,
  type WorkflowTemplateContext,
} from './variables.ts'

export type WorkflowEmailAction = Extract<WorkflowAction, { type: 'email' }>

export interface WorkflowEmailInput {
  action: WorkflowEmailAction
  trigger: WorkflowTriggerType
  context: Omit<WorkflowTemplateContext, 'recipients'>
  /** Rechecked by the execution caller; false ignores every stored custom translation. */
  followUpHostNotesEnabled?: boolean
  recipient: { name: string; timeZone: string; locale: string }
  eventType: { title: string; publicPath?: string | null }
  booking: { start: Temporal.Instant; end: Temporal.Instant }
  /** Only the saved booker's scalar answers; extra keys are never interpolated. */
  answers?: Readonly<Record<string, string | number | boolean | null>>
}

export interface RenderedWorkflowEmail {
  subject: string
  text: string
  html: string
  locale: InterfaceLanguage
  templateLocale: InterfaceLanguage
  contentSource: 'custom' | 'built_in'
  fallback: 'host_text_disabled' | 'missing_translation' | undefined
}

type Template = { subject: string; body: string }
type BuiltIns = Record<WorkflowTriggerType, Template>
const builtIns: Partial<Record<InterfaceLanguage, BuiltIns>> = {
  en: {
    'booking.created': {
      subject: 'Booking confirmed: {{event_type.title}}',
      body: 'Hello {{recipient.name}},\nYour booking for {{event_type.title}} is confirmed.\n{{booking.start}} – {{booking.end}} ({{recipient.time_zone}})',
    },
    'booking.cancelled': {
      subject: 'Booking cancelled: {{event_type.title}}',
      body: 'Hello {{recipient.name}},\nYour booking for {{event_type.title}} was cancelled.\n{{booking.start}} – {{booking.end}} ({{recipient.time_zone}})',
    },
    'booking.rescheduled': {
      subject: 'Booking rescheduled: {{event_type.title}}',
      body: 'Hello {{recipient.name}},\nYour booking for {{event_type.title}} was rescheduled.\n{{booking.start}} – {{booking.end}} ({{recipient.time_zone}})',
    },
    before_start: {
      subject: 'Upcoming booking: {{event_type.title}}',
      body: 'Hello {{recipient.name}},\nYour booking for {{event_type.title}} starts soon.\n{{booking.start}} – {{booking.end}} ({{recipient.time_zone}})',
    },
    after_end: {
      subject: 'Booking follow-up: {{event_type.title}}',
      body: 'Hello {{recipient.name}},\nThank you for your booking for {{event_type.title}}.\n{{booking.start}} – {{booking.end}} ({{recipient.time_zone}})',
    },
  },
  'zh-CN': {
    'booking.created': {
      subject: '预约已确认：{{event_type.title}}',
      body: '{{recipient.name}}，您好：\n您的{{event_type.title}}预约已确认。\n{{booking.start}} – {{booking.end}}（{{recipient.time_zone}}）',
    },
    'booking.cancelled': {
      subject: '预约已取消：{{event_type.title}}',
      body: '{{recipient.name}}，您好：\n您的{{event_type.title}}预约已取消。\n{{booking.start}} – {{booking.end}}（{{recipient.time_zone}}）',
    },
    'booking.rescheduled': {
      subject: '预约已改期：{{event_type.title}}',
      body: '{{recipient.name}}，您好：\n您的{{event_type.title}}预约已改期。\n{{booking.start}} – {{booking.end}}（{{recipient.time_zone}}）',
    },
    before_start: {
      subject: '预约即将开始：{{event_type.title}}',
      body: '{{recipient.name}}，您好：\n您的{{event_type.title}}预约即将开始。\n{{booking.start}} – {{booking.end}}（{{recipient.time_zone}}）',
    },
    after_end: {
      subject: '预约后续：{{event_type.title}}',
      body: '{{recipient.name}}，您好：\n感谢您预约{{event_type.title}}。\n{{booking.start}} – {{booking.end}}（{{recipient.time_zone}}）',
    },
  },
}

const invalid = () => new DomainError('invalid', 'invalid_workflow', 'Email template is invalid')
const renderLimit = () =>
  new DomainError('invalid', 'render_limit', 'Email exceeds rendering limits')
const invisible = /\p{Cf}/gu

/** Enforce limits before allocating normalized text, then again after expansion. */
function bounded(value: string, max: number): string {
  if (value.length > max || Buffer.byteLength(value, 'utf8') > max) throw renderLimit()
  return value
}

type Node = { text: string } | { variable: string }
function parse(text: string, multiline: boolean, context: WorkflowTemplateContext): Node[] {
  bounded(text, multiline ? WORKFLOW_BODY_MAX_BYTES : WORKFLOW_SUBJECT_MAX_BYTES)
  if (!(multiline ? isMultiLineText(text) : isSingleLineText(text)) || /\p{Cf}/u.test(text))
    throw invalid()
  const names = templatePlaceholders(text)
  if (!names || names.some((name) => templateVariableProblem(name, context))) throw invalid()
  const nodes: Node[] = []
  let index = 0
  for (const name of names) {
    const open = text.indexOf('{{', index)
    const close = text.indexOf('}}', open + 2)
    nodes.push({ text: text.slice(index, open) }, { variable: name })
    index = close + 2
  }
  nodes.push({ text: text.slice(index) })
  return nodes
}

/** Scalar values are data, never parsed again as template instructions. */
function expand(nodes: Node[], value: (name: string) => string, multiline: boolean): string {
  const parts: string[] = []
  const limit = multiline ? WORKFLOW_RENDERED_MAX_BYTES : WORKFLOW_SUBJECT_MAX_BYTES
  let bytes = 0
  for (const node of nodes) {
    const raw = 'text' in node ? node.text : value(node.variable)
    bounded(raw, WORKFLOW_RENDERED_MAX_BYTES)
    const visible = raw.toWellFormed().replace(invisible, '')
    // Sentinels keep whitespace at AST boundaries; normalize the whole result below.
    const wrapped = `x${visible}x`
    const text = (
      multiline ? multiLine(wrapped) : subjectLine(wrapped, Number.MAX_SAFE_INTEGER)
    ).slice(1, -1)
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > WORKFLOW_RENDERED_MAX_BYTES) throw renderLimit()
    parts.push(text)
  }
  const joined = parts.join('')
  return bounded(
    multiline ? multiLine(joined) : subjectLine(joined, Number.MAX_SAFE_INTEGER),
    limit,
  )
}

export function renderWorkflowEmail(input: WorkflowEmailInput): RenderedWorkflowEmail {
  const locale = interfaceLanguage(input.recipient.locale) ?? 'en'
  const custom =
    input.followUpHostNotesEnabled === false ? undefined : input.action.content?.[locale]
  const templateLocale = custom
    ? locale
    : (localeFallbacks(locale).find((code) => builtIns[code]) ?? 'en')
  const template = custom ?? builtIns[templateLocale]?.[input.trigger]
  if (!template) throw invalid()
  const context = { ...input.context, recipients: input.action.recipients }
  const subjectNodes = parse(template.subject, false, context)
  const bodyNodes = parse(template.body, true, context)
  let formatter: Intl.DateTimeFormat | undefined
  const value = (name: string): string => {
    switch (name) {
      case 'recipient.name':
        return input.recipient.name
      case 'recipient.time_zone':
        return input.recipient.timeZone
      case 'event_type.title':
        return input.eventType.title
      case 'event_type.public_path':
        return input.eventType.publicPath ?? ''
      case 'booking.start':
      case 'booking.end': {
        // A saved IANA zone and structured UTC instant, never a host-authored format string.
        bounded(input.recipient.timeZone, 128)
        try {
          formatter ??= new Intl.DateTimeFormat(formattingLocale(locale), {
            timeZone: input.recipient.timeZone,
            dateStyle: 'medium',
            timeStyle: 'short',
          })
          return formatter.format(
            Number(
              (name === 'booking.start' ? input.booking.start : input.booking.end)
                .epochMilliseconds,
            ),
          )
        } catch {
          throw invalid()
        }
      }
      default: {
        const key = name.slice('answer.'.length)
        const answer =
          input.answers && Object.hasOwn(input.answers, key) ? input.answers[key] : undefined
        if (answer == null) return ''
        if (!['string', 'number', 'boolean'].includes(typeof answer)) throw invalid()
        return String(answer)
      }
    }
  }
  const subject = expand(subjectNodes, value, false)
  const text = expand(bodyNodes, value, true)
  return {
    subject,
    text,
    html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`,
    locale,
    templateLocale,
    contentSource: custom ? 'custom' : 'built_in',
    fallback: input.action.content
      ? input.followUpHostNotesEnabled === false
        ? 'host_text_disabled'
        : custom
          ? undefined
          : 'missing_translation'
      : undefined,
  }
}
