import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import type { RoutingDraft, RoutingForm } from './routing-form-api.ts'
import { type RoutingTargetEvents, routingEventLabels } from './routing-target-events.ts'

export type RoutingPublicationAction = 'publish' | 'disable' | 'enable'

export const routingHealthLabel = {
  ok: 'Available',
  unavailable: 'Unavailable',
  unknown: 'Health unknown',
} as const satisfies Record<NonNullable<RoutingForm['health']>['status'], MessageKey>

const actions = {
  publish: {
    label: 'Review publication',
    confirm: 'Publish version',
    busy: 'Publishing…',
    testId: 'routing-publication-review',
  },
  disable: {
    label: 'Disable routing form',
    confirm: 'Disable form',
    busy: 'Disabling…',
    testId: 'routing-disable-confirmation',
  },
  enable: {
    label: 'Re-enable routing form',
    confirm: 'Re-enable form',
    busy: 'Re-enabling…',
    testId: 'routing-enable-confirmation',
  },
} as const

export function RoutingFormPublication({
  form,
  draft,
  dirty,
  disabled,
  busy,
  status,
  publishedNumber,
  events,
  onPublish,
  onSetEnabled,
  onRepair,
}: {
  form: RoutingForm
  draft: RoutingDraft
  dirty: boolean
  disabled: boolean
  busy: RoutingPublicationAction | null
  status: RoutingPublicationAction | null
  publishedNumber: number | null
  events: RoutingTargetEvents['list']
  onPublish(): Promise<void>
  onSetEnabled(enabled: boolean): Promise<void>
  onRepair(ruleId: string): void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const saveHintId = useId()
  const publishButton = useRef<HTMLButtonElement>(null)
  const toggleButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const previousAction = useRef<RoutingPublicationAction | null>(null)
  const [review, setReview] = useState<{ action: RoutingPublicationAction; revision: number }>()
  const [acknowledged, setAcknowledged] = useState(false)
  const action = review?.revision === form.draftRevision ? review.action : null
  const toggleAction = form.enabled ? 'disable' : 'enable'
  const version = form.publishedVersionNumber
  const locked = disabled || busy !== null

  useEffect(() => {
    if (action) cancelButton.current?.focus()
    else if (previousAction.current === 'publish') publishButton.current?.focus()
    else if (previousAction.current) toggleButton.current?.focus()
    previousAction.current = action
  }, [action])

  function start(action: RoutingPublicationAction) {
    setAcknowledged(false)
    setReview({ action, revision: form.draftRevision })
  }

  const fallback = form.fallback
  const fallbackEvent =
    action === 'publish' && fallback.kind === 'event' && events.status === 'ready'
      ? routingEventLabels(events.data, t).get(fallback.eventTypeId)
      : undefined

  return (
    <section className="panel" aria-labelledby={titleId} data-testid="routing-publication">
      <h2 id={titleId}>{t('Publication')}</h2>
      <p>
        {version === null
          ? t('No version published yet.')
          : t('Published version {number}', { number: version })}
      </p>
      <p>{form.enabled ? t('Enabled') : t('Disabled')}</p>
      {version !== null && (
        <PublishedHealth form={form} draft={draft} disabled={locked} onRepair={onRepair} />
      )}
      {dirty && (
        <p className="muted" id={saveHintId}>
          {t('Save your changes before publishing.')}
        </p>
      )}
      {action ? (
        <fieldset
          className="form-fieldset"
          data-testid={actions[action].testId}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation()
              setReview(undefined)
            }
          }}
        >
          <legend className="visually-hidden">{t(actions[action].label)}</legend>
          {action === 'publish' && (
            <>
              <h3>{t('Saved fallback')}</h3>
              {fallback.kind === 'message' ? (
                <p className="user-content routing-preview-message">{fallback.message}</p>
              ) : (
                <p>
                  {fallbackEvent ? (
                    <bdi className="user-content">{fallbackEvent}</bdi>
                  ) : (
                    t(
                      events.status === 'loading'
                        ? 'Loading event types…'
                        : 'Saved fallback event name unavailable.',
                    )
                  )}
                </p>
              )}
              <p>
                {t('Publishing uses the saved draft and keeps the form’s current enabled status.')}
              </p>
            </>
          )}
          {action === 'disable' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={locked}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t(
                'I understand that while this form is disabled, submissions and pending booking links are blocked.',
              )}
            </label>
          )}
          {action === 'enable' && (
            <p>{t('Re-enable the current published version to accept submissions.')}</p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className={`button ${action === 'disable' ? 'button-danger' : 'button-primary'}`}
              disabled={
                locked || (action === 'disable' && !acknowledged) || (action === 'publish' && dirty)
              }
              onClick={() => {
                if (action === 'publish') void onPublish()
                else void onSetEnabled(action === 'enable')
              }}
            >
              {t(actions[action].confirm)}
            </button>
            <button
              ref={cancelButton}
              type="button"
              className="button"
              onClick={() => setReview(undefined)}
              disabled={busy !== null}
            >
              {t('Cancel')}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="form-actions">
          <button
            ref={publishButton}
            type="button"
            className="button button-primary"
            disabled={locked || dirty}
            aria-describedby={dirty ? saveHintId : undefined}
            onClick={() => start('publish')}
          >
            {t(actions.publish.label)}
          </button>
          {version !== null && (
            <button
              ref={toggleButton}
              type="button"
              className="button"
              disabled={locked}
              onClick={() => start(toggleAction)}
            >
              {t(actions[toggleAction].label)}
            </button>
          )}
        </div>
      )}
      <div role="status">
        {busy ? (
          <p data-testid="routing-publication-pending">{t(actions[busy].busy)}</p>
        ) : (
          status && (
            <p data-testid="routing-publication-status">
              {status === 'publish' &&
                publishedNumber !== null &&
                t('Published version {number}.', { number: publishedNumber })}
              {status === 'disable' && t('Routing form disabled.')}
              {status === 'enable' && t('Routing form re-enabled.')}
            </p>
          )
        )}
      </div>
    </section>
  )
}

function PublishedHealth({
  form,
  draft,
  disabled,
  onRepair,
}: {
  form: RoutingForm
  draft: RoutingDraft
  disabled: boolean
  onRepair(ruleId: string): void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const health = form.health?.versionId === form.publishedVersionId ? form.health : null
  const draftRules = new Set(draft.rules.map(({ id }) => id))

  return (
    <section aria-labelledby={titleId} data-testid="routing-published-health">
      <h3 id={titleId}>{t('Published target health')}</h3>
      <p>{t(routingHealthLabel[health?.status ?? 'unknown'])}</p>
      {health && health.targets.length > 0 && (
        <ul>
          {health.targets.map((target, index) => {
            const fallback = target.ruleId === 'fallback'
            const number = index + 1
            return (
              <li key={target.ruleId}>
                <p>
                  <strong>{fallback ? t('Fallback') : t('Rule {number}', { number })}</strong>{' '}
                  {t(routingHealthLabel[target.health])}
                </p>
                {target.health === 'unavailable' &&
                  (fallback || draftRules.has(target.ruleId) ? (
                    <button
                      type="button"
                      className="button button-small"
                      disabled={disabled}
                      onClick={() => onRepair(target.ruleId)}
                    >
                      {fallback ? t('Repair fallback') : t('Repair rule {number}', { number })}
                    </button>
                  ) : (
                    <p className="muted">
                      {t('Publish without this rule to remove it from the current version.')}
                    </p>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
      {health?.status === 'unavailable' && (
        <p>{t('Save and publish your draft to update the published destinations.')}</p>
      )}
    </section>
  )
}
