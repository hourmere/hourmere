// Date overrides of a saved schedule: other hours (or none) on single dates, such as holidays.
// Each is saved on its own, right away, apart from the schedule's form.
import { type FormEvent, useCallback, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage, RequestError, requestError } from '../../api/errors.ts'
import type { Schedule } from '../../api/resources.ts'
import { ErrorSummary, Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
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

const dateFormat = new Intl.DateTimeFormat(undefined, {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/** "Thu, 24 Dec 2026" for "2026-12-24" (a calendar date, no zone). */
export const formatDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`))

const hoursText = (o: Override) =>
  o.intervals.length === 0
    ? 'Unavailable all day'
    : o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')

export function Overrides({ schedule }: { schedule: Schedule }) {
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
  const [status, setStatus] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)

  return (
    <section className="panel" aria-labelledby="overrides-heading">
      <h2 id="overrides-heading" ref={heading} tabIndex={-1}>
        Date overrides
      </h2>
      <p className="hint">
        Other hours on single dates, such as holidays, in {schedule.timeZone.replaceAll('_', ' ')}.
        They are saved right away.
      </p>
      <p className="flash" role="status">
        {status}
      </p>
      {state.status === 'loading' && <p role="status">Loading overrides…</p>}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>Could not load the date overrides. {state.message}</p>
          <button type="button" className="button button-small" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <p className="muted">No upcoming date overrides.</p>
        ) : (
          <ul className="override-list">
            {state.data.map((o) => (
              <OverrideRow
                key={o.date}
                scheduleId={schedule.id}
                override={o}
                onRemoved={() => {
                  setStatus(`Removed the override for ${formatDate(o.date)}.`)
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
            `${created ? 'Added' : 'Replaced'} the override for ${formatDate(o.date)}: ${hoursText(o)}.`,
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const date = formatDate(override.date)

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
      else setError(`Could not remove it. ${errorMessage(err)}`)
    }
    setBusy(false)
  }

  return (
    <li className="override">
      <span className="override-date">
        <time dateTime={override.date}>{date}</time>
      </span>
      <span>{hoursText(override)}</span>
      <button
        type="button"
        className="button button-small"
        onClick={remove}
        disabled={busy}
        aria-label={`Remove override: ${date}`}
      >
        {busy ? 'Removing…' : 'Remove'}
      </button>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
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
  const [date, setDate] = useState('')
  const [mode, setMode] = useState<'unavailable' | 'hours'>('unavailable')
  const [intervals, setIntervals] = useState<IntervalDraft[]>(() => [intervalDraft()])
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  useUnsavedChanges(date !== '')

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
    const problems = validate()
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
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
            ? `These hours overlap: ${overlap}.`
            : 'Check these hours: each must end after it starts.',
        })
      } else {
        setFormError(`Could not save the override. ${errorMessage(err)}`)
      }
      setAttempt((n) => n + 1)
    }
    setSaving(false)
  }

  const labels: Record<string, string> = { 'override-date': 'Date', [PREFIX]: 'Hours' }
  intervals.forEach((i, n) => {
    labels[intervalField(PREFIX, i, 'start')] = `Hours ${n + 1}, from`
    labels[intervalField(PREFIX, i, 'end')] = `Hours ${n + 1}, until`
  })

  return (
    <form className="override-form" onSubmit={submit} noValidate aria-labelledby="add-override">
      <h3 id="add-override">Add a date override</h3>
      <ErrorSummary errors={errors} labels={labels} message={formError} attempt={attempt} />
      <Field
        id="override-date"
        label="Date"
        error={errors['override-date']}
        hint={replaces ? 'This date has an override already; saving replaces it.' : undefined}
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
        <legend>Hours on that date</legend>
        <label className="checkbox">
          <input
            type="radio"
            name="override-mode"
            value="unavailable"
            checked={mode === 'unavailable'}
            onChange={() => setMode('unavailable')}
          />
          Unavailable all day
        </label>
        <label className="checkbox">
          <input
            type="radio"
            name="override-mode"
            value="hours"
            checked={mode === 'hours'}
            onChange={() => setMode('hours')}
          />
          Other hours
        </label>
      </fieldset>
      {mode === 'hours' && (
        <div id={PREFIX} tabIndex={-1}>
          <IntervalsEditor
            prefix={PREFIX}
            label="That date"
            intervals={intervals}
            onChange={setIntervals}
            errors={errors}
          />
        </div>
      )}
      {mode === 'unavailable' && errors[PREFIX] && (
        <FieldError id={`${PREFIX}-error`}>{errors[PREFIX]}</FieldError>
      )}
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save override'}
        </button>
      </div>
    </form>
  )
}
