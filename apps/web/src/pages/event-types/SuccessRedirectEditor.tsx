import { Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import type { EventTypeDraft, SuccessRedirectParameter } from './event-type-form.ts'

const PARAMETERS: { value: SuccessRedirectParameter; label: MessageKey }[] = [
  { value: 'eventTypeSlug', label: 'Event type slug' },
  { value: 'start', label: 'Start time' },
  { value: 'end', label: 'End time' },
  { value: 'timeZone', label: 'Time zone' },
  { value: 'hostName', label: 'Host name' },
  { value: 'inviteeName', label: 'Invitee name' },
  { value: 'inviteeEmail', label: 'Invitee email' },
]

const SAMPLE_VALUES: Record<SuccessRedirectParameter, string> = {
  eventTypeSlug: 'intro-call',
  start: '2030-01-15T10:00:00Z',
  end: '2030-01-15T10:30:00Z',
  timeZone: 'Europe/Berlin',
  hostName: 'Alex Chen',
  inviteeName: 'Sam Taylor',
  inviteeEmail: 'sam+demo@example.com',
}

/** A text-only example; the scheduling service validates the actual destination on save. */
export function previewSuccessRedirect(
  draft: EventTypeDraft,
  values: Record<SuccessRedirectParameter, string> = SAMPLE_VALUES,
): string | null {
  let url: string
  try {
    url = new URL(draft.successRedirectUrl).href
  } catch {
    return null
  }
  const parameters = new URLSearchParams(
    draft.successRedirectParameters
      .filter(
        (key) =>
          draft.includeInviteePersonalData || (key !== 'inviteeName' && key !== 'inviteeEmail'),
      )
      .map((key) => [key, values[key]]),
  )
  const fragmentStart = url.indexOf('#')
  const target = fragmentStart === -1 ? url : url.slice(0, fragmentStart)
  const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart)
  return (
    target + (parameters.size ? `${target.includes('?') ? '&' : '?'}${parameters}` : '') + fragment
  )
}

export function SuccessRedirectEditor({
  draft,
  errors,
  set,
}: {
  draft: EventTypeDraft
  errors: FieldErrors
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
}) {
  const { t } = useI18n()
  const preview = previewSuccessRedirect(draft)
  return (
    <section className="panel" aria-labelledby="success-redirect-heading">
      <h2 id="success-redirect-heading">{t('After booking')}</h2>
      <p>
        {t(
          'Offer a Continue link after the booking confirmation. Invitees can review their calendar and manage link before leaving. Clear the URL to turn this off.',
        )}
      </p>
      {errors.successRedirect && (
        <FieldError id="successRedirect-error">{errors.successRedirect}</FieldError>
      )}
      <div className="stack">
        <Field
          id="successRedirect.url"
          label={t('Continue to URL')}
          optional
          error={errors['successRedirect.url']}
          hint={t('Use HTTPS. The server checks the destination when you save.')}
        >
          {(props) => (
            <input
              {...props}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.successRedirectUrl}
              onChange={(event) => set('successRedirectUrl', event.target.value)}
            />
          )}
        </Field>
        <fieldset
          id="successRedirect.parameters"
          tabIndex={-1}
          aria-describedby={`success-redirect-parameters-hint${errors['successRedirect.parameters'] ? ' successRedirect.parameters-error' : ''}`}
        >
          <legend>{t('URL parameters')}</legend>
          <p id="success-redirect-parameters-hint" className="hint">
            {t(
              'Only selected values are added. Answers, guests, phone numbers and private booking links are never included.',
            )}
          </p>
          {errors['successRedirect.parameters'] && (
            <FieldError id="successRedirect.parameters-error">
              {errors['successRedirect.parameters']}
            </FieldError>
          )}
          {PARAMETERS.filter(
            ({ value }) => value !== 'inviteeName' && value !== 'inviteeEmail',
          ).map(({ value, label }) => (
            <label className="checkbox" key={value}>
              <input
                type="checkbox"
                checked={draft.successRedirectParameters.includes(value)}
                onChange={(event) =>
                  set(
                    'successRedirectParameters',
                    event.target.checked
                      ? [...draft.successRedirectParameters, value]
                      : draft.successRedirectParameters.filter((parameter) => parameter !== value),
                  )
                }
              />
              {t(label)}
            </label>
          ))}
          <p id="success-redirect-personal-warning" className="hint">
            {t(
              'Warning: sharing invitee name or email makes them visible to the target site and its analytics, and may put them in browser history. Enable this only with a clear reason to share that data.',
            )}
          </p>
          <label className="checkbox">
            <input
              id="successRedirect.includeInviteePersonalData"
              type="checkbox"
              checked={draft.includeInviteePersonalData}
              aria-describedby={`success-redirect-personal-warning${errors['successRedirect.includeInviteePersonalData'] ? ' successRedirect.includeInviteePersonalData-error' : ''}`}
              aria-invalid={errors['successRedirect.includeInviteePersonalData'] ? true : undefined}
              onChange={(event) => {
                set('includeInviteePersonalData', event.target.checked)
                if (!event.target.checked)
                  set(
                    'successRedirectParameters',
                    draft.successRedirectParameters.filter(
                      (parameter) => parameter !== 'inviteeName' && parameter !== 'inviteeEmail',
                    ),
                  )
              }}
            />
            {t('Allow sharing invitee name and email')}
          </label>
          {errors['successRedirect.includeInviteePersonalData'] && (
            <FieldError id="successRedirect.includeInviteePersonalData-error">
              {errors['successRedirect.includeInviteePersonalData']}
            </FieldError>
          )}
          {PARAMETERS.filter(
            ({ value }) => value === 'inviteeName' || value === 'inviteeEmail',
          ).map(({ value, label }) => (
            <label className="checkbox" key={value}>
              <input
                type="checkbox"
                disabled={!draft.includeInviteePersonalData}
                checked={draft.successRedirectParameters.includes(value)}
                aria-describedby="success-redirect-personal-warning"
                onChange={(event) =>
                  set(
                    'successRedirectParameters',
                    event.target.checked
                      ? [...draft.successRedirectParameters, value]
                      : draft.successRedirectParameters.filter((parameter) => parameter !== value),
                  )
                }
              />
              {t(label)}
            </label>
          ))}
        </fieldset>
        <div>
          <label className="checkbox">
            <input
              id="successRedirect.allowEmbedParent"
              type="checkbox"
              checked={draft.allowEmbedParent}
              aria-describedby={`success-redirect-embed-hint${errors['successRedirect.allowEmbedParent'] ? ' successRedirect.allowEmbedParent-error' : ''}`}
              aria-invalid={errors['successRedirect.allowEmbedParent'] ? true : undefined}
              onChange={(event) => set('allowEmbedParent', event.target.checked)}
            />
            {t('Allow embedded bookings to open the parent page')}
          </label>
          <p id="success-redirect-embed-hint" className="hint">
            {t(
              'Off by default: Continue opens a new tab from an embed. Enabling this allows an invitee’s click to replace the page containing the booking widget, when its sandbox permits it.',
            )}
          </p>
          {errors['successRedirect.allowEmbedParent'] && (
            <FieldError id="successRedirect.allowEmbedParent-error">
              {errors['successRedirect.allowEmbedParent']}
            </FieldError>
          )}
        </div>
        <div>
          <p id="success-redirect-preview-label">{t('Example continuation URL')}</p>
          <output
            className="success-redirect-preview"
            aria-labelledby="success-redirect-preview-label"
          >
            {preview ?? t('Enter a URL to preview the continuation.')}
          </output>
          <p className="hint">
            {t('Sample values only. The server validates your settings on save.')}
          </p>
        </div>
      </div>
    </section>
  )
}
