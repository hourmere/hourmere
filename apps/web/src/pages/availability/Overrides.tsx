// Date overrides of a saved schedule: other hours (or none) on single dates, such as holidays.
// Each is saved on its own, right away, apart from the schedule's form.
import { type FormEvent, useCallback, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage, RequestError, requestError } from '../../api/errors.ts'
import type { Schedule } from '../../api/resources.ts'
import { ErrorSummary, Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { dateMessage, msg, type UiText } from '../../i18n/translate.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { IntervalsEditor } from './IntervalsEditor.tsx'
import {
  type IntervalDraft,
  intervalDraft,
  intervalField,
  todayIn,
  toIntervals,
  validateIntervals,
} from './weekly-hours.ts'

type Override = { date: string; intervals: { start: string; end: string }[] }

const PREFIX = 'override-hours'

const hoursText = (o: Override) =>
  o.intervals.length === 0
    ? 'Unavailable all day'
    : o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')

export function Overrides({ schedule }: { schedule: Schedule }) {
  const { t, ui } = useI18n()

  // Upcoming ones only: past dates no longer matter for booking.
  const today = todayIn(schedule.timeZone)
  const load = useCallback(
    async (signal: AbortSignal) =>
      (
        await unwrap(
          api.GET('/api/v1/schedules/{id}/overrides', {
            params: { path: { id: schedule.id }, query: { from: today } },
            signal,
          }),
        )
      ).data,
    [schedule.id, today],
  )
  const [state, reload] = useLoad(load)
  const [status, setStatus] = useState<UiText>('')
  const heading = useRef<HTMLHeadingElement>(null)

  return (
    <section className="panel" aria-labelledby="overrides-heading">
      <h2 id="overrides-heading" ref={heading} tabIndex={-1}>
        {t('Date overrides')}
      </h2>
      <p className="hint">
        {t('Other hours on single dates, such as holidays, in')}{' '}
        {schedule.timeZone.replaceAll('_', ' ')}
        {t('. They are saved right away.')}
      </p>
      <p className="flash" role="status">
        {ui(status)}
      </p>
      {state.status === 'loading' && <p role="status">{t('Loading overrides…')}</p>}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>
            {t('Could not load the date overrides.')} {ui(state.message)}
          </p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <p className="muted">{t('No upcoming date overrides.')}</p>
        ) : (
          <ul className="override-list">
            {state.data.map((o) => (
              <OverrideRow
                key={o.date}
                scheduleId={schedule.id}
                override={o}
                onRemoved={() => {
                  setStatus(msg('Removed the override for {0}.', { '0': dateMessage(o.date) }))
                  reload()
                  heading.current?.focus()
                }}
              />
            ))}
          </ul>
        ))}
      <AddOverride
        schedule={schedule}
        today={today}
        existing={state.status === 'ready' ? state.data : []}
        onSaved={(o, created) => {
          setStatus(
            msg(
              created
                ? 'Added the override for {date}: {hours}.'
                : 'Replaced the override for {date}: {hours}.',
              {
                date: dateMessage(o.date),
                hours: o.intervals.length ? hoursText(o) : msg('Unavailable all day'),
              },
            ),
          )
          reload()
        }}
      />
    </section>
  )
}

function OverrideRow({
  scheduleId,
  override,
  onRemoved,
}: {
  scheduleId: string
  override: Override
  onRemoved: () => void
}) {
  const { t, ui, locale: displayLocale } = useI18n()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiText | null>(null)
  const date = new Intl.DateTimeFormat(displayLocale, {
    calendar: 'gregory',
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${override.date}T00:00:00Z`))

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        api.DELETE('/api/v1/schedules/{id}/overrides/{date}', {
          params: { path: { id: scheduleId, date: override.date } },
        }),
      )
      onRemoved()
    } catch (err) {
      // Already gone (removed elsewhere): what the person wanted.
      if (err instanceof RequestError && err.code === 'schedule_override_not_found') onRemoved()
      else setError(msg('Could not remove it. {0}', { '0': errorMessage(err) }))
    }
    setBusy(false)
  }

  return (
    <li className="override">
      <span className="override-date">
        <time dateTime={override.date}>{date}</time>
      </span>
      <span>{ui(hoursText(override))}</span>
      <button
        type="button"
        className="button button-small"
        onClick={remove}
        disabled={busy}
        aria-label={t('Remove override: {0}', { '0': date })}
      >
        {busy ? t('Removing…') : t('Remove')}
      </button>
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(error)}
        </p>
      )}
    </li>
  )
}

function AddOverride({
  schedule,
  today,
  existing,
  onSaved,
}: {
  schedule: Schedule
  today: string
  existing: Override[]
  onSaved: (override: Override, created: boolean) => void
}) {
  const { t, ui } = useI18n()

  const [date, setDate] = useState('')
  const [mode, setMode] = useState<'unavailable' | 'hours'>('unavailable')
  const [initialIntervals] = useState(() => [intervalDraft()])
  const [intervals, setIntervals] = useState<IntervalDraft[]>(initialIntervals)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const submitButton = useRef<HTMLButtonElement>(null)
  const values = (hours: IntervalDraft[]) => hours.map(({ start, end }) => [start, end])
  useUnsavedChanges(
    date !== '' ||
      mode !== 'unavailable' ||
      JSON.stringify(values(intervals)) !== JSON.stringify(values(initialIntervals)),
  )

  const replaces = existing.some((o) => o.date === date)

  function validate(): FieldErrors {
    const problems: FieldErrors = {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems['override-date'] = 'Choose a date.'
    if (mode === 'hours') {
      if (intervals.length === 0) problems[PREFIX] = 'Add hours, or choose unavailable all day.'
      Object.assign(problems, validateIntervals(PREFIX, intervals))
    }
    return problems
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setAttempt((n) => n + 1)
    setFormError(null)
    if (saving) return
    const problems = validate()
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    // The fields are locked while saving (the form resets after), so focus waits on the
    // button rather than being dropped by a disabled field.
    submitButton.current?.focus()
    setSaving(true)
    try {
      const { data, error, response } = await api.PUT('/api/v1/schedules/{id}/overrides/{date}', {
        params: { path: { id: schedule.id, date } },
        body: { intervals: mode === 'hours' ? toIntervals(intervals) : [] },
      })
      if (!data) throw requestError(response.status, error)
      onSaved(data, response.status === 201)
      setDate('')
      setMode('unavailable')
      setIntervals([intervalDraft()])
    } catch (err) {
      if (err instanceof RequestError && err.code === 'invalid_date') {
        setErrors({ 'override-date': 'Choose a date in the years 0001 to 9999.' })
      } else if (err instanceof RequestError && err.code === 'invalid_intervals') {
        const overlap = /overlapping intervals (.+)$/.exec(err.message)?.[1]
        setErrors({
          [PREFIX]: overlap
            ? msg('These hours overlap: {0}.', { '0': overlap })
            : 'Check these hours: each must end after it starts.',
        })
      } else {
        setFormError(msg('Could not save the override. {0}', { '0': errorMessage(err) }))
      }
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  const labels: Record<string, UiText> = { 'override-date': 'Date', [PREFIX]: 'Hours' }
  intervals.forEach((i, n) => {
    labels[intervalField(PREFIX, i, 'start')] = msg('Hours {0}, from', { '0': n + 1 })
    labels[intervalField(PREFIX, i, 'end')] = msg('Hours {0}, until', { '0': n + 1 })
  })

  return (
    <form className="override-form" onSubmit={submit} noValidate aria-labelledby="add-override">
      <h3 id="add-override">{t('Add a date override')}</h3>
      <ErrorSummary errors={errors} labels={labels} message={ui(formError)} attempt={attempt} />
      <fieldset className="form-fieldset override-fields" disabled={saving} role="presentation">
        <Field
          id="override-date"
          label={t('Date')}
          error={ui(errors['override-date'])}
          hint={replaces ? t('This date has an override already; saving replaces it.') : undefined}
          className="date-field"
        >
          {(props) => (
            <input
              {...props}
              type="date"
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="choice">
          <legend>{t('Hours on that date')}</legend>
          <label className="checkbox">
            <input
              type="radio"
              name="override-mode"
              value="unavailable"
              checked={mode === 'unavailable'}
              onChange={() => setMode('unavailable')}
            />
            {t('Unavailable all day')}
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="override-mode"
              value="hours"
              checked={mode === 'hours'}
              onChange={() => setMode('hours')}
            />
            {t('Other hours')}
          </label>
        </fieldset>
        {mode === 'hours' && (
          <div id={PREFIX} tabIndex={-1}>
            <IntervalsEditor
              prefix={PREFIX}
              label={t('That date')}
              intervals={intervals}
              onChange={setIntervals}
              errors={errors}
            />
          </div>
        )}
        {mode === 'unavailable' && errors[PREFIX] && (
          <FieldError id={`${PREFIX}-error`}>{ui(errors[PREFIX])}</FieldError>
        )}
      </fieldset>
      <div className="form-actions">
        <button
          ref={submitButton}
          type="submit"
          className="button button-primary"
          aria-disabled={saving}
        >
          {saving ? t('Saving…') : t('Save override')}
        </button>
      </div>
    </form>
  )
}
