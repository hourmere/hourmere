import { explicitLanguage, type InterfaceLanguage, localeRegistry } from '@hourmere/core/language'
import { useEffect, useRef } from 'react'
import type { Schemas } from '../../api/client.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { workflowRecipientLabels } from './WorkflowAudienceFields.tsx'
import { workflowLocales } from './WorkflowDefinitionFields.tsx'

type Preview = Schemas['WorkflowPreview']

const matchMessages = {
  matched: 'The example booking matches this workflow.',
  scope_mismatch: 'Skipped: the example booking is outside the workflow scope.',
  condition_false: 'Skipped: the example booking does not meet the workflow conditions.',
} as const satisfies Record<Preview['match'], string>

const fallbackMessages = {
  host_text_disabled: 'Built-in text is used because custom text is disabled.',
  missing_translation: 'Built-in text is used because a custom translation is missing.',
} as const

function languageName(value: string) {
  const language = explicitLanguage(value)
  return language ? localeRegistry[language].nativeName : value
}

export function WorkflowPreviewPanel({
  locale,
  eventTypes,
  eventTypeId,
  onEventTypeChange,
  onLocaleChange,
  preview,
  loading,
}: {
  locale: InterfaceLanguage
  eventTypes: readonly Schemas['EventType'][]
  eventTypeId: string
  onEventTypeChange: (id: string) => void
  onLocaleChange: (locale: InterfaceLanguage) => void
  preview: Preview | null
  loading: boolean
}) {
  const { t } = useI18n()
  const result = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (preview) result.current?.focus()
  }, [preview])

  return (
    <section className="panel workflow-fields" aria-label={t('Workflow preview')}>
      <div className="form-actions">
        <label className="field">
          <span>{t('Preview language')}</span>
          <select
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value as InterfaceLanguage)}
          >
            {workflowLocales.map((code) => (
              <option key={code} value={code} lang={code}>
                {localeRegistry[code].nativeName}
              </option>
            ))}
          </select>
        </label>
        {eventTypes.length > 0 && (
          <label className="field">
            <span>{t('Preview event type')}</span>
            <select value={eventTypeId} onChange={(event) => onEventTypeChange(event.target.value)}>
              <option value="">{t('Use the default example')}</option>
              {eventTypes.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="button" type="submit" value="preview">
          {t('Preview workflow')}
        </button>
      </div>
      <p className="muted">{t('Preview uses an example booking and sends nothing.')}</p>
      {loading && <p role="status">{t('Generating preview…')}</p>}
      {preview && (
        <div className="workflow-fields">
          <h2 ref={result} tabIndex={-1}>
            {t('Workflow preview')}
          </h2>
          <p>{t(matchMessages[preview.match])}</p>
          {preview.emails.map((email) => (
            <div key={email.recipientClass} className="workflow-fields workflow-preview-email">
              <h3>{t(workflowRecipientLabels[email.recipientClass])}</h3>
              <p className="user-content">
                {t('Requested language: {requested}. Template language: {template}.', {
                  requested: languageName(email.locale),
                  template: languageName(email.templateLocale),
                })}
              </p>
              {email.fallback && <p>{t(fallbackMessages[email.fallback])}</p>}
              <p className="user-content" lang={email.templateLocale}>
                <strong>{email.subject}</strong>
              </p>
              <p className="user-content workflow-preview-text" lang={email.templateLocale}>
                {email.text}
              </p>
            </div>
          ))}
          {preview.estimates.webhookDeliveriesPerMatch > 0 && (
            <p>{t('A matching booking would queue a webhook delivery.')}</p>
          )}
        </div>
      )}
    </section>
  )
}
