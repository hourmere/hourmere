import { useEffect, useRef, useState } from 'react'
import { Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { formatMinutes } from '../../i18n/duration.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { EVENT_TYPE } from '../../limits.ts'
import { durationToAddProblem } from './event-type-form.ts'

const PRESETS = [15, 30, 45, 60, 90]

/** Native controls keep length selection and list changes usable without a pointer. */
export function DurationsEditor({
  durations,
  defaultDuration,
  errors,
  onChange,
  onDefaultChange,
  showDefault = true,
}: {
  showDefault?: boolean
  durations: number[]
  defaultDuration: string
  errors: FieldErrors
  onChange: (durations: number[], defaultDuration: string) => void
  onDefaultChange: (duration: string) => void
}) {
  const { t, uiText, locale } = useI18n()
  const [value, setValue] = useState('')
  const [error, setError] = useState<UiText | undefined>()
  const [announcement, setAnnouncement] = useState<UiText>('')
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const defaultSelect = useRef<HTMLSelectElement>(null)
  const length = (minutes: number) => formatMinutes(minutes, locale)

  useEffect(() => () => clearTimeout(announcementTimer.current), [])

  function announce(message: UiText) {
    clearTimeout(announcementTimer.current)
    // Empty the live region in a separate update so identical failures are announced again.
    setAnnouncement('')
    announcementTimer.current = setTimeout(() => setAnnouncement(message), 0)
  }

  function add(raw = value) {
    const problem = durationToAddProblem(raw, durations)
    if (problem) {
      setError(problem)
      announce(problem)
      input.current?.focus()
      return
    }
    const minutes = Number(raw)
    onChange(
      [...durations, minutes].sort((a, b) => a - b),
      defaultDuration,
    )
    setValue('')
    setError(undefined)
    announce(msg('Added {0}.', { '0': length(minutes) }))
    input.current?.focus()
  }

  function remove(minutes: number) {
    if (durations.length <= 1) return
    const remaining = durations.filter((duration) => duration !== minutes)
    const nextDefault = Number(defaultDuration) === minutes ? String(remaining[0]) : defaultDuration
    onChange(remaining, nextDefault)
    setError(undefined)
    announce(
      msg('Removed {0}. Default duration: {1}.', {
        '0': length(minutes),
        '1': length(Number(nextDefault)),
      }),
    )
    ;(defaultSelect.current ?? document.getElementById('durationMinutes'))?.focus()
  }

  return (
    <fieldset
      id="allowedDurationsMinutes"
      className="durations-editor"
      tabIndex={-1}
      aria-describedby={`allowed-durations-hint${errors.allowedDurationsMinutes ? ' allowedDurationsMinutes-error' : ''}`}
    >
      <legend>{t('Allowed durations')}</legend>
      <p id="allowed-durations-hint" className="hint">
        {t(
          'Offer 1–12 different lengths, from 1 to 1,440 minutes. Invitees choose a length before a time.',
        )}
      </p>
      {errors.allowedDurationsMinutes && (
        <FieldError id="allowedDurationsMinutes-error">{errors.allowedDurationsMinutes}</FieldError>
      )}
      <ul className="duration-list" aria-label={t('Offered lengths')}>
        {durations.map((minutes) => (
          <li key={minutes}>
            <span>{length(minutes)}</span>
            <button
              type="button"
              className="button button-small"
              aria-label={t('Remove {0}', { '0': length(minutes) })}
              disabled={durations.length <= 1}
              onClick={() => remove(minutes)}
            >
              {t('Remove')}
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">
        {t('Keep at least one length. Removing the default selects the first remaining length.')}
      </p>
      <fieldset className="duration-presets">
        <legend className="visually-hidden">{t('Quick durations')}</legend>
        {PRESETS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="button button-small"
            disabled={
              durations.includes(minutes) || durations.length >= EVENT_TYPE.maxAllowedDurations
            }
            onClick={() => add(String(minutes))}
          >
            {t('Add {0}', { '0': length(minutes) })}
          </button>
        ))}
      </fieldset>
      <Field id="duration-to-add" label={t('Duration to add (minutes)')} error={error}>
        {(props) => (
          <input
            {...props}
            ref={input}
            inputMode="numeric"
            value={value}
            onChange={(event) => {
              clearTimeout(announcementTimer.current)
              setAnnouncement('')
              setValue(event.target.value)
              setError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
          />
        )}
      </Field>
      <button type="button" className="button button-small" onClick={() => add()}>
        {t('Add duration')}
      </button>
      {showDefault && (
        <Field
          id="durationMinutes"
          label={t('Default duration')}
          error={errors.durationMinutes}
          hint={t(
            'Selected when an invitee opens the booking page. They can choose another offered length.',
          )}
        >
          {(props) => (
            <select
              {...props}
              ref={defaultSelect}
              value={defaultDuration}
              onChange={(event) => onDefaultChange(event.target.value)}
            >
              {durations.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {length(minutes)}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <p className="visually-hidden" role="status" aria-atomic="true">
        {uiText(announcement)}
      </p>
    </fieldset>
  )
}
