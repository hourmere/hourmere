import { type InterfaceLanguage, interfaceLanguages, localeRegistry } from '@hourmere/core/language'
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'

type DefinitionFields = Pick<Schemas['Workflow'], 'name' | 'scope' | 'trigger'>
type Trigger = DefinitionFields['trigger']

const triggers = {
  'booking.created': 'Booking created',
  'booking.rescheduled': 'Booking rescheduled',
  'booking.cancelled': 'Booking canceled',
  before_start: 'Before booking starts',
  after_end: 'After booking ends',
} as const satisfies Record<Trigger['type'], string>

function isTimer(type: Trigger['type']): type is 'before_start' | 'after_end' {
  return type === 'before_start' || type === 'after_end'
}

export function WorkflowDefinitionFields({
  name,
  scope,
  trigger,
  eventTypes,
  onChange,
}: DefinitionFields & {
  eventTypes: readonly Schemas['EventType'][]
  onChange: (fields: Partial<DefinitionFields>) => void
}) {
  const { t } = useI18n()
  const value = 'offsetMinutes' in trigger ? trigger.offsetMinutes : trigger.delayMinutes

  function timing(type: Trigger['type'], minutes: number) {
    onChange({
      trigger: isTimer(type) ? { type, offsetMinutes: minutes } : { type, delayMinutes: minutes },
    })
  }

  return (
    <>
      <label className="field">
        <span>{t('Workflow name')}</span>
        <input
          type="text"
          required
          value={name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="field">
        <span>{t('Applies to')}</span>
        <select
          value={scope.type}
          onChange={(event) =>
            onChange({
              scope:
                event.target.value === 'event_type'
                  ? { type: 'event_type', eventTypeId: '' }
                  : { type: 'all_event_types' },
            })
          }
        >
          <option value="all_event_types">{t('All event types')}</option>
          <option value="event_type">{t('One event type')}</option>
        </select>
      </label>
      {scope.type === 'event_type' && (
        <label className="field">
          <span>{t('Event type')}</span>
          <select
            required
            value={eventTypes.some(({ id }) => id === scope.eventTypeId) ? scope.eventTypeId : ''}
            onChange={(event) =>
              onChange({ scope: { type: 'event_type', eventTypeId: event.target.value } })
            }
          >
            <option value="">{t('Choose an event type')}</option>
            {eventTypes.map(({ id, title }) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="field-grid">
        <label className="field">
          <span>{t('Trigger')}</span>
          <select
            value={trigger.type}
            onChange={(event) => {
              const type = event.target.value as Trigger['type']
              timing(type, isTimer(type) === isTimer(trigger.type) ? value : isTimer(type) ? 5 : 0)
            }}
          >
            {(Object.keys(triggers) as Trigger['type'][]).map((type) => (
              <option key={type} value={type}>
                {t(triggers[type])}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t(isTimer(trigger.type) ? 'Offset (minutes)' : 'Delay (minutes)')}</span>
          <input
            type="number"
            min={isTimer(trigger.type) ? 5 : 0}
            max={43200}
            step={1}
            required
            value={Number.isNaN(value) ? '' : value}
            onChange={(event) => timing(trigger.type, event.target.valueAsNumber)}
          />
        </label>
      </div>
    </>
  )
}

export const workflowLocales = interfaceLanguages('public')
export type WorkflowContent = NonNullable<
  Extract<Schemas['WorkflowAction'], { type: 'email' }>['content']
>

export function WorkflowTranslations({
  content,
  onChange,
}: {
  content: WorkflowContent | undefined
  onChange: (content: WorkflowContent | undefined) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const nextFocus = useRef<string | undefined>(undefined)
  const [selected, setSelected] = useState<InterfaceLanguage>('en')
  const available = workflowLocales.filter((language) => !content?.[language])
  const language = available.includes(selected) ? selected : available[0]
  useLayoutEffect(() => {
    if (nextFocus.current) document.getElementById(nextFocus.current)?.focus()
    nextFocus.current = undefined
  })

  return (
    <fieldset className="form-fieldset workflow-fields">
      <legend>{t('Custom email text')}</legend>
      <p className="muted">
        {t('Built-in text is used for languages without a custom translation.')}
      </p>
      {workflowLocales.map((code) => {
        const entry = content?.[code]
        if (!entry) return null
        const label = localeRegistry[code].nativeName
        return (
          <fieldset className="form-fieldset workflow-fields workflow-translation" key={code}>
            <legend lang={code}>{label}</legend>
            <label className="field">
              <span>{t('Custom subject')}</span>
              <input
                id={`${id}-${code}-subject`}
                required
                value={entry.subject}
                onChange={(event) =>
                  onChange({ ...content, [code]: { ...entry, subject: event.target.value } })
                }
              />
            </label>
            <label className="field">
              <span>{t('Custom body')}</span>
              <textarea
                required
                value={entry.body}
                onChange={(event) =>
                  onChange({ ...content, [code]: { ...entry, body: event.target.value } })
                }
              />
            </label>
            <div>
              <button
                className="button button-small"
                type="button"
                aria-label={t('Remove {language} translation', { language: label })}
                onClick={() => {
                  const next = { ...content }
                  delete next[code]
                  nextFocus.current = `${id}-add-language`
                  onChange(Object.keys(next).length ? next : undefined)
                }}
              >
                {t('Remove translation')}
              </button>
            </div>
          </fieldset>
        )
      })}
      {language && (
        <div className="form-actions">
          <label className="field">
            <span>{t('Add language')}</span>
            <select
              id={`${id}-add-language`}
              value={language}
              onChange={(event) => setSelected(event.target.value as InterfaceLanguage)}
            >
              {available.map((code) => (
                <option key={code} value={code} lang={code}>
                  {localeRegistry[code].nativeName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button-small"
            type="button"
            onClick={() => {
              nextFocus.current = `${id}-${language}-subject`
              onChange({ ...content, [language]: { subject: '', body: '' } })
            }}
          >
            {t('Add translation')}
          </button>
        </div>
      )}
    </fieldset>
  )
}

export function WorkflowWebhookField({
  organizationId,
  webhookId,
  onChange,
}: {
  organizationId: string
  webhookId: string
  onChange: (id: string) => void
}) {
  const { t } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const webhooks = await unwrap(
          api.GET('/api/v1/webhooks', {
            params: { header: { 'x-expected-organization-id': organizationId } },
            signal,
            cache: 'no-store',
          }),
        )
        return webhooks.filter(
          (webhook) =>
            webhook.organizationId === organizationId &&
            webhook.isActive &&
            webhook.events.includes('workflow.executed'),
        )
      } catch (error) {
        if (error instanceof RequestError && (error.status === 403 || error.status === 404))
          return null
        throw error
      }
    },
    [organizationId],
  )
  const [webhooks, retry] = useLoad(load)
  const options = webhooks.status === 'ready' ? webhooks.data : null

  return (
    <>
      <label className="field">
        <span>{t('Webhook endpoint')}</span>
        <select
          required
          value={options?.some(({ id }) => id === webhookId) ? webhookId : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t('Choose a webhook endpoint')}</option>
          {options?.map(({ id, url }) => (
            <option key={id} value={id}>
              {url}
            </option>
          ))}
        </select>
      </label>
      {webhooks.status === 'loading' && <p role="status">{t('Loading webhook endpoints…')}</p>}
      {webhooks.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not load webhook endpoints.')}</p>
          <button className="button button-small" type="button" onClick={retry}>
            {t('Try again')}
          </button>
        </div>
      )}
      {webhooks.status === 'ready' &&
        (options === null ? (
          <p role="alert">{t('Webhook endpoints are unavailable.')}</p>
        ) : options.length === 0 ? (
          <p>{t('No active endpoints subscribe to workflow deliveries.')}</p>
        ) : null)}
    </>
  )
}
