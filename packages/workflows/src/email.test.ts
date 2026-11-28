import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerValues, rawMailCapture } from '../../notifications/src/testing/raw-mime.ts'
import { validateWorkflowDefinition } from './definition.ts'
import { renderWorkflowEmail, type WorkflowEmailInput } from './email.ts'
import { WORKFLOW_RENDERED_MAX_BYTES, WORKFLOW_SUBJECT_MAX_BYTES } from './limits.ts'
import { candidate, eventTypes, ids, personalContext } from './testing.ts'

function input(
  subject = '{{recipient.name}}',
  body = 'Hello {{recipient.name}}!',
): WorkflowEmailInput {
  return {
    action: { type: 'email', recipients: ['booker'], content: { en: { subject, body } } },
    trigger: 'booking.created',
    context: { owner: 'personal', eventType: eventTypes.get(ids.event) },
    recipient: { name: 'Ada', timeZone: 'UTC', locale: 'en' },
    eventType: { title: 'Consultation', publicPath: '/ada/consultation' },
    booking: {
      start: Temporal.Instant.from('2026-11-20T10:00:00Z'),
      end: Temporal.Instant.from('2026-11-20T10:30:00Z'),
    },
    answers: { company: 'Example', consent: true },
  }
}

function refuses(value: WorkflowEmailInput, code = 'invalid_workflow') {
  expect(() => renderWorkflowEmail(value)).toThrow(expect.objectContaining({ code }))
}

describe('workflow email raw MIME', () => {
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  beforeAll(async () => {
    capture = await rawMailCapture('Hourmere <mail@example.test>')
  })
  afterAll(async () => {
    await capture?.close()
  })

  it.each([
    ['subject byte boundary', 'x'.repeat(200), 'x'.repeat(200), 'x'.repeat(200)],
    [
      'HTML',
      '<script>alert(1)</script>',
      '<script>alert(1)</script>',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    ],
    [
      'attributes',
      '"><img src=x onerror=alert(1)>',
      '"><img src=x onerror=alert(1)>',
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    ],
    [
      'headers',
      'Ada\r\nBcc: injected@example.test',
      'Ada\nBcc: injected@example.test',
      'Ada</bdi></span><br><span dir="auto"><bdi>Bcc: injected@example.test',
    ],
    ['controls', 'A\u0000\u0007\u007f\u009f\u202e\u2066\u200b\ufeffda', 'Ada', 'Ada'],
    ['invalid Unicode', 'A\ud800da', 'A�da', 'A�da'],
  ])(
    'renders %s as inert data in headers, plain text and HTML',
    async (_, hostile, plain, escaped) => {
      const value = input()
      value.recipient.name = hostile
      const rendered = renderWorkflowEmail(value)
      expect(rendered.subject).not.toMatch(/[\r\n]/)
      expect(Buffer.byteLength(rendered.subject)).toBeLessThanOrEqual(WORKFLOW_SUBJECT_MAX_BYTES)
      expect(rendered.text).toBe(`Hello ${plain}!`)
      expect(rendered.html).toBe(`<p><span dir="auto">Hello <bdi>${escaped}</bdi>!</span></p>`)
      expect(rendered.html).not.toMatch(/<(?:script|img)\b/i)
      await capture.mailer.send({ to: 'recipient@example.test', ...rendered })
      const message = capture.sent.at(-1)
      if (!message) throw new Error('No raw MIME message captured')
      expect(headerValues(message, 'subject')).toHaveLength(1)
      expect(headerValues(message, 'bcc')).toEqual([])
      expect(message.envelope).toEqual(['recipient@example.test'])
      expect(message.decoded).toContain(rendered.html)
      expect(message.decoded).toContain(rendered.text.replaceAll('\n', '\r\n'))
      // biome-ignore lint/suspicious/noControlCharactersInRegex: assert hostile controls do not survive MIME
      expect(message.decoded).not.toMatch(/[\u0000\u0007\u007f\u009f\u202e\u2066\u200b\ufeff]/u)
    },
  )

  it('escapes host-authored markup too, with no attributes or links from values', async () => {
    const rendered = renderWorkflowEmail(
      input(
        '<script>{{recipient.name}}</script>',
        '<a href="{{event_type.public_path}}">{{answer.company}}</a>',
      ),
    )
    expect(rendered.subject).toBe('<script>Ada</script>')
    expect(rendered.html).toBe(
      '<p><span dir="auto">&lt;a href=&quot;<bdi dir="ltr">/ada/consultation</bdi>&quot;&gt;<bdi>Example</bdi>&lt;/a&gt;</span></p>',
    )
    await capture.mailer.send({ to: 'recipient@example.test', ...rendered })
    expect(capture.sent.at(-1)?.decoded).toContain(rendered.html)
    expect(capture.sent.at(-1)?.decoded).toContain(rendered.text)
  })
})

describe('workflow email rendering contract', () => {
  it('keeps mixed-direction template lines and each substituted value independent', () => {
    const value = input(
      'Title: {{event_type.title}}',
      ' اجتماع ({{recipient.name}}) عبر {{event_type.public_path}}\n\nNext: {{event_type.title}}\nפרטי קשר ({{answer.company}}) ',
    )
    value.recipient.name = 'נועה (Noa)'
    value.eventType.title = '12 موعد 中文'
    value.answers = { company: 'layla@example.test' }
    const rendered = renderWorkflowEmail(value)
    expect(rendered.subject).toBe('Title: 12 موعد 中文')
    expect(rendered.text).toBe(
      'اجتماع (נועה (Noa)) عبر /ada/consultation\n\nNext: 12 موعد 中文\nפרטי קשר (layla@example.test)',
    )
    expect(rendered.html).toBe(
      [
        '<p><span dir="auto">اجتماع (<bdi>נועה (Noa)</bdi>) عبر <bdi dir="ltr">/ada/consultation</bdi></span>',
        '<br><br><span dir="auto">Next: <bdi>12 موعد 中文</bdi></span>',
        '<br><span dir="auto">פרטי קשר (<bdi>layla@example.test</bdi>)</span></p>',
      ].join(''),
    )
  })
  it('renders a validated template with an emoji variation selector unchanged', () => {
    const value = input('Hello ❤️', 'Thanks ❤️ {{recipient.name}}')
    validateWorkflowDefinition(candidate({ actions: [value.action] }), personalContext)
    expect(renderWorkflowEmail(value)).toMatchObject({ subject: 'Hello ❤️', text: 'Thanks ❤️ Ada' })
  })

  it('preserves AST whitespace and normalizes body line endings without recursive substitution', () => {
    const value = input(' Hello {{recipient.name}} ! ', 'Line one\r\n {{recipient.name}} \r\nEnd')
    value.recipient.name = '{{answer.company}}'
    const rendered = renderWorkflowEmail(value)
    expect(rendered.subject).toBe('Hello {{answer.company}} !')
    expect(rendered.text).toBe('Line one\n {{answer.company}} \nEnd')
  })

  it.each([
    'secret',
    'booking.title',
    'recipient.email',
    '__proto__',
    'answer.topics',
    'answer.missing',
  ])('refuses unauthorized variable %s', (variable) => {
    refuses(input('Hello', `{{${variable}}}`))
  })

  it.each(['{{', '}}', '{{recipient.name', '{{ recipient.name extra }}'])(
    'refuses malformed placeholder %s',
    (placeholder) => {
      refuses(input('Hello', placeholder))
    },
  )

  it.each(['guests', 'hosts', 'booker'] as const)(
    'allows only authorized scalar answers for %s',
    (recipient) => {
      const value = input('{{answer.company}}', '{{answer.consent}}')
      value.action.recipients = [recipient]
      if (recipient === 'guests') refuses(value)
      else {
        expect(renderWorkflowEmail(value)).toMatchObject({ subject: 'Example', text: 'true' })
        value.context.owner = 'team'
        refuses(value)
        value.context.owner = 'personal'
        value.context.eventType = undefined
        refuses(value)
      }
    },
  )

  it('checks all action recipients, not just the recipient being rendered', () => {
    const value = input('Hello', '{{answer.company}}')
    value.action.recipients = ['hosts', 'guests']
    refuses(value)
  })

  it.each(['Hi\r\nBcc: attacker@example.test', 'Hi\u0000', 'Hi\u202e', 'Hi\u200b', 'Hi\ud800'])(
    'refuses unsafe stored template text %s',
    (subject) => {
      refuses(input(subject))
    },
  )

  it('formats structured instants in the saved recipient zone', () => {
    const value = input('{{booking.start}}', '{{booking.end}} ({{recipient.time_zone}})')
    value.recipient.timeZone = 'America/Los_Angeles'
    expect(renderWorkflowEmail(value)).toMatchObject({
      subject: 'Nov 20, 2026, 2:00 AM',
      text: 'Nov 20, 2026, 2:30 AM (America/Los_Angeles)',
    })
  })

  it('rejects invalid saved zones without reflecting their value', () => {
    const value = input('{{booking.start}}')
    value.recipient.timeZone = 'private invalid zone'
    refuses(value)
  })

  it('enforces UTF-8 subject and expanded body limits without truncating', () => {
    const value = input('{{recipient.name}}', '{{answer.company}}{{answer.company}}')
    value.recipient.name = `${'界'.repeat(66)}ab`
    value.answers = { company: 'x'.repeat(8000) }
    const rendered = renderWorkflowEmail(value)
    expect(Buffer.byteLength(rendered.subject)).toBe(WORKFLOW_SUBJECT_MAX_BYTES)
    expect(Buffer.byteLength(rendered.text)).toBe(WORKFLOW_RENDERED_MAX_BYTES)
    value.recipient.name += 'x'
    refuses(value, 'render_limit')
    value.recipient.name = 'Ada'
    value.answers = { company: 'x'.repeat(8001) }
    refuses(value, 'render_limit')
    value.answers = { company: 'x'.repeat(1_000_000) }
    refuses(value, 'render_limit')
  })

  it('bounds repeated expansion and oversized stored template input', () => {
    const value = input('Hi', '{{recipient.name}}'.repeat(400))
    value.recipient.name = 'x'.repeat(100)
    refuses(value, 'render_limit')
    refuses(input('x'.repeat(201)), 'render_limit')
    refuses(input('Hi', 'x'.repeat(8001)), 'render_limit')
  })

  it.each(['booker', 'guests', 'hosts'] as const)(
    'rechecks the host-text switch for %s including stored custom revisions',
    (recipient) => {
      for (const enabled of [true, false]) {
        const value = input('Private custom subject', 'Private custom body')
        value.action.recipients = [recipient]
        value.followUpHostNotesEnabled = enabled
        const rendered = renderWorkflowEmail(value)
        if (enabled)
          expect(rendered).toMatchObject({
            subject: 'Private custom subject',
            text: 'Private custom body',
            contentSource: 'custom',
            fallback: undefined,
          })
        else {
          expect(rendered).toMatchObject({
            subject: 'Booking confirmed: Consultation',
            contentSource: 'built_in',
            fallback: 'host_text_disabled',
          })
          expect(JSON.stringify(rendered)).not.toContain('Private custom')
        }
        delete value.action.content
        expect(renderWorkflowEmail(value)).toMatchObject({
          subject: 'Booking confirmed: Consultation',
          contentSource: 'built_in',
          fallback: undefined,
        })
      }
    },
  )

  it('ignores even malformed legacy custom text when the switch is off', () => {
    const value = input('{{unknown}}\r\nBcc: private', '<script>private</script>')
    value.followUpHostNotesEnabled = false
    expect(renderWorkflowEmail(value).subject).toBe('Booking confirmed: Consultation')
  })

  it('never uses an English custom translation for another locale', () => {
    const value = input('Private custom subject', 'Private custom body')
    value.recipient.locale = 'zh-CN'
    expect(renderWorkflowEmail(value)).toMatchObject({
      subject: '预约已确认：Consultation',
      templateLocale: 'zh-CN',
      contentSource: 'built_in',
      fallback: 'missing_translation',
    })
  })

  it.each([
    'booking.created',
    'booking.cancelled',
    'booking.rescheduled',
    'before_start',
    'after_end',
  ] as const)(
    'has valid English and Chinese built-ins for %s with either switch value',
    (trigger) => {
      for (const locale of ['en', 'zh-CN'])
        for (const enabled of [false, true]) {
          const value = input()
          delete value.action.content
          value.trigger = trigger
          value.recipient.locale = locale
          value.followUpHostNotesEnabled = enabled
          const rendered = renderWorkflowEmail(value)
          expect(rendered.contentSource).toBe('built_in')
          expect(rendered.templateLocale).toBe(locale)
          expect(rendered.text).toContain('Ada')
          expect(rendered.text).toContain('Consultation')
          expect(rendered.text).not.toContain('{{')
        }
    },
  )
})
