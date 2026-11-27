import { interfaceLanguages } from '@hourmere/core/language'
import { mailCatalogues } from '@hourmere/mail/catalogue'
import { describe, expect, it } from 'vitest'
import { WorkflowTriggerSchema, type WorkflowTriggerType } from './definition.ts'
import { renderWorkflowEmail, type WorkflowEmailInput } from './email.ts'
import { eventTypes, ids } from './testing.ts'
import { WORKFLOW_RECIPIENT_CLASSES } from './variables.ts'

const locales = interfaceLanguages('public')
const triggers = WorkflowTriggerSchema.options.map((option) => option.shape.type.value)
const catalogueNames = {
  'booking.created': 'created',
  'booking.cancelled': 'cancelled',
  'booking.rescheduled': 'rescheduled',
  before_start: 'beforeStart',
  after_end: 'afterEnd',
} as const satisfies Record<WorkflowTriggerType, string>

function input(
  locale: string,
  trigger: WorkflowTriggerType = 'booking.created',
): WorkflowEmailInput {
  return {
    action: { type: 'email', recipients: ['booker'] },
    trigger,
    context: { owner: 'personal', eventType: eventTypes.get(ids.event) },
    recipient: { name: 'Ada Lovelace', timeZone: 'Europe/Berlin', locale },
    eventType: { title: 'Planning & Design' },
    booking: {
      start: Temporal.Instant.from('2026-11-20T09:00:00Z'),
      end: Temporal.Instant.from('2026-11-20T09:30:00Z'),
    },
  }
}

describe.each(locales)('workflow email built-ins (%s)', (locale) => {
  it.each(triggers)('renders the %s subject, plain text and HTML', (trigger) => {
    const rendered = renderWorkflowEmail(input(locale, trigger))
    expect(rendered).toMatchObject({
      locale,
      templateLocale: locale,
      contentSource: 'built_in',
      fallback: undefined,
    })
    expect({
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    }).toMatchSnapshot()
  })

  it.each(triggers)('limits %s to fields safe for every recipient', (trigger) => {
    const prefix = `workflow.${catalogueNames[trigger]}` as const
    const subjectTemplate = mailCatalogues[locale]?.[`${prefix}.subject`]
    const bodyTemplate = mailCatalogues[locale]?.[`${prefix}.body`]
    expect(subjectTemplate?.match(/\{[^{}]*\}/g)).toEqual(['{event}'])
    expect(bodyTemplate?.match(/\{[^{}]*\}/g)?.sort()).toEqual([
      '{end}',
      '{event}',
      '{recipient}',
      '{start}',
      '{zone}',
    ])

    const value = input(locale, trigger)
    const recipient = { ...value.recipient, email: 'recipient@example.test' }
    const booking = {
      ...value.booking,
      title: 'PRIVATE_BOOKING_TITLE',
      cancelReason: 'PRIVATE_CANCELLATION_REASON',
      guests: [{ name: 'SIBLING_GUEST_NAME', email: 'sibling@example.test' }],
      hosts: [{ name: 'PRIVATE_HOST_NAME', email: 'host@example.test' }],
      manageUrl: 'https://manage.example.test/booking#token=CAPABILITY',
      startUrl: 'https://start.example.test/meeting?token=CAPABILITY',
      retryUrl: 'https://retry.example.test/conference?token=CAPABILITY',
    }

    for (const owner of ['personal', 'team'] as const) {
      for (const recipientClass of WORKFLOW_RECIPIENT_CLASSES) {
        const { subject, text, html } = renderWorkflowEmail({
          ...value,
          action: { type: 'email', recipients: [recipientClass] },
          context: {
            owner,
            eventType: eventTypes.get(owner === 'team' ? ids.teamEvent : ids.event),
          },
          recipient,
          booking,
          answers: { company: 'PRIVATE_BOOKING_ANSWER' },
        })
        for (const output of [subject, text, html]) {
          expect(output).not.toMatch(/PRIVATE_|SIBLING_|CAPABILITY|\{\{/)
          expect(output).not.toMatch(/https?:\/\/|mailto:|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)
        }
        expect(html).not.toMatch(/<(?:a|button)\b/i)
      }
    }
  })
})

describe('workflow email locale fallback', () => {
  it('uses the matching built-in for a supported regional variant', () => {
    expect(renderWorkflowEmail(input('fr-CA'))).toEqual(renderWorkflowEmail(input('fr')))
  })

  it.each(['ja-JP', 'pt-PT', 'zh-Hant-TW', 'invalid_locale'])(
    'uses the default built-in for %s',
    (locale) => {
      expect(renderWorkflowEmail(input(locale))).toEqual(renderWorkflowEmail(input('en')))
    },
  )

  it('uses the default built-in when an unsupported locale has only English custom text', () => {
    const value = input('ja-JP')
    value.followUpHostNotesEnabled = true
    value.action.content = { en: { subject: 'Custom subject', body: 'Custom body' } }
    const builtIn = renderWorkflowEmail(input('en'))
    expect(renderWorkflowEmail(value)).toEqual({ ...builtIn, fallback: 'missing_translation' })
  })

  it('uses the localized built-in when the custom text is missing or disabled', () => {
    const value = input('pt-BR')
    const builtIn = renderWorkflowEmail(value)
    const custom = { subject: 'Private custom subject', body: 'Private custom body' }

    value.action.content = { en: custom }
    expect(renderWorkflowEmail(value)).toEqual({ ...builtIn, fallback: 'missing_translation' })

    value.action.content['pt-BR'] = custom
    value.followUpHostNotesEnabled = false
    expect(renderWorkflowEmail(value)).toEqual({ ...builtIn, fallback: 'host_text_disabled' })
  })

  it('uses a complete default pair when a localized body is missing', () => {
    const spanish = mailCatalogues.es
    const body = spanish?.['workflow.created.body']
    if (!spanish || !body) throw new Error('Missing Spanish workflow catalogue entry')
    delete spanish['workflow.created.body']
    try {
      const rendered = renderWorkflowEmail(input('es'))
      const english = renderWorkflowEmail(input('en'))
      expect(rendered).toMatchObject({
        subject: english.subject,
        locale: 'es',
        templateLocale: 'en',
        contentSource: 'built_in',
      })
      expect(rendered.text).toContain('Your booking for Planning & Design is confirmed.')
      expect(rendered.text).toContain('20 nov 2026, 10:00')
      expect(rendered.html).toContain(
        'Your booking for <bdi>Planning &amp; Design</bdi> is confirmed.',
      )
    } finally {
      spanish['workflow.created.body'] = body
    }
  })
})
