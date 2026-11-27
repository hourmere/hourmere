import { useId, useLayoutEffect, useRef } from 'react'
import type { Schemas } from '../../api/client.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import './WebhookViews.css'

const EVENT_LABELS = {
  'booking.created': 'Booking created',
  'booking.rescheduled': 'Booking rescheduled',
  'booking.cancelled': 'Booking cancelled',
  'booking.reschedule_requested': 'Booking reschedule requested',
  'booking.reschedule_request_expired': 'Booking reschedule request expired',
  'booking.attendee_no_show_changed': 'Attendee no-show changed',
  'workflow.executed': 'Workflow executed',
} as const satisfies Record<Schemas['Webhook']['events'][number], MessageKey>

export type WebhookEvent = keyof typeof EVENT_LABELS

export function isWebhookEvent(event: string): event is WebhookEvent {
  return Object.hasOwn(EVENT_LABELS, event)
}

export interface WebhookEndpoint {
  id: string
  organizationId: string
  origin: string
  events: string[]
  isActive: boolean
}

export interface WebhookDraft {
  url: string
  events: WebhookEvent[]
  isActive: boolean
}

export type WebhookConfirmation = 'rotate' | 'delete'

export function usePanelHeading() {
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()
  useLayoutEffect(() => heading.current?.focus(), [])
  return { id, ref: heading, tabIndex: -1 }
}

export function EndpointIdentity({
  endpoint,
  prefix,
}: {
  endpoint: WebhookEndpoint
  prefix: string
}) {
  const { t } = useI18n()
  return (
    <>
      <dt>{t('Destination origin')}</dt>
      <dd id={`${prefix}-origin`} className="user-content" data-private>
        <bdi>{endpoint.origin}</bdi>
      </dd>
      <dt>{t('Endpoint ID')}</dt>
      <dd id={`${prefix}-id`} className="user-content" data-private>
        <code>{endpoint.id}</code>
      </dd>
    </>
  )
}

function EventLabels({ events }: { events: readonly string[] }) {
  const { t, locale } = useI18n()
  const labels = new Set<MessageKey>(events.map(webhookEventLabel))
  return new Intl.ListFormat(locale).format(Array.from(labels, (label) => t(label)))
}

export function webhookEventLabel(event: string): MessageKey {
  return isWebhookEvent(event) ? EVENT_LABELS[event] : 'Unknown event'
}

type OpenEndpoint = (id: string, opener: HTMLButtonElement) => void

export function WebhookList({
  endpoints,
  onEdit,
  onHistory,
  onCreate,
  busy,
}: {
  endpoints: readonly WebhookEndpoint[]
  onEdit: OpenEndpoint
  onHistory: OpenEndpoint
  onCreate: (opener: HTMLButtonElement) => void
  busy: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="webhook-list stack">
      {endpoints.length ? (
        // biome-ignore lint/a11y/noRedundantRoles: WebKit can omit unstyled lists from the accessibility tree.
        <ul className="webhook-endpoints" role="list">
          {endpoints.map((endpoint) => (
            <WebhookListItem
              key={endpoint.id}
              endpoint={endpoint}
              onEdit={onEdit}
              onHistory={onHistory}
              busy={busy}
            />
          ))}
        </ul>
      ) : (
        <p>{t('No webhook endpoints yet.')}</p>
      )}
      <div className="webhook-actions form-actions">
        <button
          type="button"
          className="button button-primary button-wrap"
          disabled={busy}
          onClick={(event) => onCreate(event.currentTarget)}
        >
          {t('Add webhook')}
        </button>
      </div>
    </div>
  )
}

function WebhookListItem({
  endpoint,
  onEdit,
  onHistory,
  busy,
}: {
  endpoint: WebhookEndpoint
  onEdit: OpenEndpoint
  onHistory: OpenEndpoint
  busy: boolean
}) {
  const { t } = useI18n()
  const prefix = useId()
  return (
    <li className="webhook-endpoint">
      <dl className="details">
        <EndpointIdentity endpoint={endpoint} prefix={prefix} />
        <dt>{t('Webhook events')}</dt>
        <dd>
          <EventLabels events={endpoint.events} />
        </dd>
        <dt>{t('Status')}</dt>
        <dd>{t(endpoint.isActive ? 'Enabled' : 'Paused')}</dd>
      </dl>
      <div className="webhook-actions form-actions">
        <button
          type="button"
          className="button button-wrap"
          disabled={busy}
          aria-describedby={`${prefix}-origin ${prefix}-id`}
          onClick={(event) => onEdit(endpoint.id, event.currentTarget)}
        >
          {t('Edit webhook')}
        </button>
        <button
          type="button"
          className="button button-wrap"
          disabled={busy}
          aria-describedby={`${prefix}-origin ${prefix}-id`}
          onClick={(event) => onHistory(endpoint.id, event.currentTarget)}
        >
          {t('Delivery history')}
        </button>
      </div>
    </li>
  )
}

function EventChoices({
  events,
  onChange,
  workflowAllowed,
  busy,
}: {
  events: readonly WebhookEvent[]
  onChange: (events: WebhookEvent[]) => void
  workflowAllowed: boolean
  busy: boolean
}) {
  const { t } = useI18n()
  const hintId = useId()
  return (
    <fieldset className="webhook-events" disabled={busy} aria-describedby={hintId}>
      <legend>{t('Webhook events')}</legend>
      <p className="hint" id={hintId}>
        {t('Choose at least one event.')}
      </p>
      {Object.keys(EVENT_LABELS)
        .filter(isWebhookEvent)
        .map((event) => {
          const checked = events.includes(event)
          if (event === 'workflow.executed' && !workflowAllowed && !checked) return null
          return (
            <label className="checkbox" key={event}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(change) =>
                  onChange(
                    change.currentTarget.checked
                      ? [...events, event]
                      : events.filter((value) => value !== event),
                  )
                }
              />
              {t(EVENT_LABELS[event])}
            </label>
          )
        })}
    </fieldset>
  )
}

export function WebhookCreateForm({
  draft,
  onChange,
  onSave,
  onCancel,
  workflowsEnabled,
  busy,
}: {
  draft: WebhookDraft
  onChange: (draft: WebhookDraft) => void
  onSave: () => void
  onCancel: () => void
  workflowsEnabled: boolean | null | undefined
  busy: boolean
}) {
  const { t } = useI18n()
  const heading = usePanelHeading()
  const urlId = useId()
  const workflowAllowed = workflowsEnabled === true
  const canSave =
    draft.url.trim() &&
    draft.events.length > 0 &&
    (workflowAllowed || !draft.events.includes('workflow.executed'))
  return (
    <section className="webhook-create webhook-subpanel" aria-labelledby={heading.id}>
      <h4 {...heading}>{t('Create webhook')}</h4>
      <form
        className="stack"
        autoComplete="off"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && canSave) onSave()
        }}
      >
        <Field id={urlId} label={t('Destination URL')}>
          {(props) => (
            <input
              {...props}
              type="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-private
              required
              disabled={busy}
              value={draft.url}
              onChange={(event) => onChange({ ...draft, url: event.currentTarget.value })}
            />
          )}
        </Field>
        <EventChoices
          events={draft.events}
          onChange={(events) => onChange({ ...draft, events })}
          workflowAllowed={workflowAllowed}
          busy={busy}
        />
        <label className="checkbox webhook-enabled">
          <input
            type="checkbox"
            checked={draft.isActive}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, isActive: event.currentTarget.checked })}
          />
          {t('Enabled')}
        </label>
        <div className="webhook-actions form-actions">
          <button
            type="submit"
            className="button button-primary button-wrap"
            disabled={busy || !canSave}
          >
            {t('Create webhook')}
          </button>
          <button type="button" className="button button-wrap" disabled={busy} onClick={onCancel}>
            {t('Cancel')}
          </button>
        </div>
      </form>
    </section>
  )
}

export function WebhookEditor({
  endpoint,
  events,
  onEventsChange,
  onSaveEvents,
  onSetActive,
  onConfirm,
  onClose,
  workflowsEnabled,
  busy,
}: {
  endpoint: WebhookEndpoint
  events: readonly WebhookEvent[]
  onEventsChange: (events: WebhookEvent[]) => void
  onSaveEvents: () => void
  onSetActive: (isActive: boolean) => void
  onConfirm: (action: WebhookConfirmation, opener: HTMLButtonElement) => void
  onClose: () => void
  workflowsEnabled: boolean | null | undefined
  busy: boolean
}) {
  const { t } = useI18n()
  const heading = usePanelHeading()
  const statusHintId = useId()
  const workflowAllowed = workflowsEnabled === true || endpoint.events.includes('workflow.executed')
  const unknownEvents = endpoint.events.some((event) => !isWebhookEvent(event))
  const eventsChanged =
    endpoint.events.length !== events.length ||
    events.some((event) => !endpoint.events.includes(event))
  const canSave =
    !unknownEvents &&
    eventsChanged &&
    events.length > 0 &&
    (workflowAllowed || !events.includes('workflow.executed'))
  return (
    <section className="webhook-editor webhook-subpanel" aria-labelledby={heading.id}>
      <h4 {...heading}>{t('Edit webhook')}</h4>
      <dl className="details">
        <EndpointIdentity endpoint={endpoint} prefix={heading.id} />
        <dt>{t('Status')}</dt>
        <dd>{t(endpoint.isActive ? 'Enabled' : 'Paused')}</dd>
        {unknownEvents && (
          <>
            <dt>{t('Webhook events')}</dt>
            <dd>
              <EventLabels events={endpoint.events} />
            </dd>
          </>
        )}
      </dl>
      {unknownEvents ? (
        <p className="hint">{t('Subscription editing is unavailable for this endpoint.')}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && canSave) onSaveEvents()
          }}
        >
          <EventChoices
            events={events}
            onChange={onEventsChange}
            workflowAllowed={workflowAllowed}
            busy={busy}
          />
          <div className="webhook-actions form-actions">
            <button
              type="submit"
              className="button button-primary button-wrap"
              disabled={busy || !canSave}
            >
              {t('Save subscriptions')}
            </button>
          </div>
        </form>
      )}
      <p className="hint webhook-status-hint" id={statusHintId}>
        {t(
          endpoint.isActive
            ? 'A delivery in progress may finish after you pause this endpoint.'
            : 'Skipped deliveries stay skipped after resuming.',
        )}
      </p>
      <div className="webhook-actions form-actions">
        <button
          type="button"
          className="button button-wrap"
          aria-describedby={statusHintId}
          disabled={busy}
          onClick={() => onSetActive(!endpoint.isActive)}
        >
          {t(endpoint.isActive ? 'Pause webhook' : 'Resume webhook')}
        </button>
        <button
          type="button"
          className="button button-wrap"
          disabled={busy}
          onClick={(event) => onConfirm('rotate', event.currentTarget)}
        >
          {t('Rotate signing secret…')}
        </button>
        <button
          type="button"
          className="button button-wrap"
          disabled={busy}
          onClick={(event) => onConfirm('delete', event.currentTarget)}
        >
          {t('Delete webhook…')}
        </button>
        <button type="button" className="button button-wrap" disabled={busy} onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </section>
  )
}

export function WebhookConfirm({
  action,
  endpoint,
  onCancel,
  onConfirm,
  busy,
}: {
  action: WebhookConfirmation
  endpoint: WebhookEndpoint
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => cancel.current?.focus(), [])
  const label = t(action === 'rotate' ? 'Rotate signing secret' : 'Delete webhook')
  return (
    <section
      className="webhook-confirm webhook-subpanel"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <h4 id={id}>{label}</h4>
      <dl className="details">
        <EndpointIdentity endpoint={endpoint} prefix={id} />
      </dl>
      <p>
        {t(
          action === 'rotate'
            ? 'Prepare your receiver to install the new signing secret immediately. All subsequent attempts, including retries, use the new secret.'
            : 'Deleting this endpoint permanently removes its retained deliveries. Workflows that reference this ID must be updated separately.',
        )}
      </p>
      <div className="webhook-actions form-actions">
        <button
          type="button"
          className="button button-wrap"
          ref={cancel}
          disabled={busy}
          onClick={onCancel}
        >
          {t('Go back')}
        </button>
        <button
          type="button"
          className="button button-danger button-wrap"
          disabled={busy}
          onClick={onConfirm}
        >
          {label}
        </button>
      </div>
    </section>
  )
}

export function WebhookSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const { t } = useI18n()
  const heading = usePanelHeading()
  return (
    <section className="webhook-secret webhook-subpanel" aria-labelledby={heading.id}>
      <h4 {...heading}>{t('Signing secret')}</h4>
      <p>
        {t('Save this signing secret in your receiver’s secret store. You can see it only here.')}
      </p>
      <p className="webhook-secret-value user-content" data-private>
        <code>{secret}</code>
      </p>
      <div className="webhook-actions form-actions">
        <CopyButton text={secret} label="Copy signing secret" />
        <button type="button" className="button button-wrap" onClick={onDismiss}>
          {t('Dismiss')}
        </button>
      </div>
    </section>
  )
}
