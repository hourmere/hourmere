// Shared pure rendering for execution and the later synthetic preview. No transport, database
// lookup or user-supplied HTML enters this module.
import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { mailMessage, mailMessageLocale } from '@hourmere/mail/catalogue'
import { emailUserText, escapeHtml, multiLine, subjectLine } from '@hourmere/mail/text'
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
  type WorkflowTemplateVariable,
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

const builtInNames = {
  'booking.created': 'created',
  'booking.cancelled': 'cancelled',
  'booking.rescheduled': 'rescheduled',
  before_start: 'beforeStart',
  after_end: 'afterEnd',
} as const satisfies Record<WorkflowTriggerType, string>

// Translate catalogue placeholders into workflow placeholders. Recipient data enters
// only after the renderer has applied the same allowlist as it does for custom text.
const builtInVariables = {
  event: '{{event_type.title}}',
  recipient: '{{recipient.name}}',
  start: '{{booking.start}}',
  end: '{{booking.end}}',
  zone: '{{recipient.time_zone}}',
} satisfies Record<string, `{{${WorkflowTemplateVariable}}}`>

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
type ExpandedNode = { node: Node; text: string }
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
function expand(nodes: Node[], value: (name: string) => string, multiline: boolean) {
  const parts: ExpandedNode[] = []
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
    parts.push({ node, text })
  }
  const joined = parts.map(({ text }) => text).join('')
  const text = bounded(
    multiline ? multiLine(joined) : subjectLine(joined, Number.MAX_SAFE_INTEGER),
    limit,
  )
  return { text, parts, start: joined.length - joined.trimStart().length }
}

function htmlBody(
  body: ReturnType<typeof expand>,
  language: InterfaceLanguage,
  custom: boolean,
): string {
  let offset = 0
  const end = body.start + body.text.length
  const html = body.parts
    .map(({ node, text }) => {
      // Use the same trim boundaries as the plain alternative, including whitespace
      // supplied by a variable at the beginning or end of an otherwise empty template.
      const visible = text.slice(Math.max(0, body.start - offset), Math.max(0, end - offset))
      offset += text.length
      if ('variable' in node) {
        if (node.variable === 'event_type.public_path') {
          return emailUserText(visible, language, 'ltr')
        }
        if (
          node.variable === 'event_type.title' ||
          node.variable === 'recipient.name' ||
          node.variable.startsWith('answer.')
        ) {
          return emailUserText(visible, language)
        }
      }
      return escapeHtml(visible).replaceAll('\n', '<br>')
    })
    .join('')
  if (!custom) return `<p>${html}</p>`
  return `<p>${html
    .split('<br>')
    .map((line) => (line ? `<span dir="auto">${line}</span>` : ''))
    .join('<br>')}</p>`
}

export function renderWorkflowEmail(input: WorkflowEmailInput): RenderedWorkflowEmail {
  const recipientLanguage = interfaceLanguage(input.recipient.locale)
  const locale = recipientLanguage ?? 'en'
  const custom =
    recipientLanguage && input.followUpHostNotesEnabled !== false
      ? input.action.content?.[recipientLanguage]
      : undefined
  let templateLocale = locale
  let template = custom
  if (!template) {
    const name = builtInNames[input.trigger]
    if (typeof name !== 'string') throw invalid()
    const subjectKey = `workflow.${name}.subject` as const
    const bodyKey = `workflow.${name}.body` as const
    templateLocale = mailMessageLocale(locale, [subjectKey, bodyKey])
    template = {
      subject: mailMessage(templateLocale, subjectKey, builtInVariables),
      body: mailMessage(templateLocale, bodyKey, builtInVariables),
    }
  }
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
  const subject = expand(subjectNodes, value, false).text
  const body = expand(bodyNodes, value, true)
  return {
    subject,
    text: body.text,
    html: htmlBody(body, templateLocale, custom !== undefined),
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
