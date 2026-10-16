// The hours of one day (a weekday or a date override): time ranges to add and remove.
import { useEffect, useState } from 'react'
import { FieldError, type FieldErrors } from '../../components/forms.tsx'
import { type IntervalDraft, intervalDraft, intervalField } from './weekly-hours.ts'

/** A range after the last one, or 9 to 5 for the first. */
function nextInterval(intervals: readonly IntervalDraft[]): IntervalDraft {
  const last = intervals.at(-1)
  if (!last || !/^\d{2}:\d{2}$/.test(last.end) || last.end === '00:00') return intervalDraft()
  const [h, m] = last.end.split(':').map(Number) as [number, number]
  const start = h * 60 + m + 60
  if (start >= 23 * 60) return intervalDraft('09:00', '17:00')
  const time = (total: number) =>
    `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  return intervalDraft(time(start), time(Math.min(start + 60, 24 * 60 - 1)))
}

export function IntervalsEditor({
  prefix,
  label,
  intervals,
  onChange,
  errors,
}: {
  /** Field ids start with it; errors[prefix] is the day's own (overlaps). */
  prefix: string
  /** The day, for accessible names: "Monday". */
  label: string
  intervals: IntervalDraft[]
  onChange: (intervals: IntervalDraft[]) => void
  errors: FieldErrors
}) {
  const [focus, setFocus] = useState<string | null>(null)

  useEffect(() => {
    if (focus === null) return
    document.getElementById(focus)?.focus()
    setFocus(null)
  }, [focus])

  const dayError = errors[prefix]
  const addId = `${prefix}-add`

  function add() {
    const interval = nextInterval(intervals)
    onChange([...intervals, interval])
    setFocus(intervalField(prefix, interval, 'start'))
  }

  function remove(index: number) {
    const rest = intervals.filter((_, i) => i !== index)
    onChange(rest)
    const next = rest[index] ?? rest[index - 1]
    setFocus(next ? intervalField(prefix, next, 'start') : addId)
  }

  function update(key: string, change: Partial<IntervalDraft>) {
    onChange(intervals.map((i) => (i.key === key ? { ...i, ...change } : i)))
  }

  return (
    <div className="intervals">
      {dayError && <FieldError id={`${prefix}-error`}>{dayError}</FieldError>}
      {intervals.length === 0 && <p className="muted">No hours: unavailable.</p>}
      {intervals.length > 0 && (
        <ul className="interval-list">
          {intervals.map((interval, index) => {
            const startId = intervalField(prefix, interval, 'start')
            const endId = intervalField(prefix, interval, 'end')
            const startError = errors[startId]
            const endError = errors[endId]
            const name = `${label}, hours ${index + 1}`
            const describe = (id: string, error: string | undefined) =>
              [error && `${id}-error`, dayError && `${prefix}-error`].filter(Boolean).join(' ') ||
              undefined
            return (
              <li key={interval.key} className="interval">
                <div className="interval-row">
                  <label htmlFor={startId} className="visually-hidden">
                    {name}, from
                  </label>
                  <input
                    id={startId}
                    type="time"
                    className="time-input"
                    value={interval.start}
                    required
                    aria-invalid={startError || dayError ? true : undefined}
                    aria-describedby={describe(startId, startError)}
                    onChange={(e) => update(interval.key, { start: e.target.value })}
                  />
                  <span aria-hidden="true">–</span>
                  <label htmlFor={endId} className="visually-hidden">
                    {name}, until
                  </label>
                  <input
                    id={endId}
                    type="time"
                    className="time-input"
                    value={interval.end}
                    required
                    aria-invalid={endError || dayError ? true : undefined}
                    aria-describedby={describe(endId, endError)}
                    onChange={(e) => update(interval.key, { end: e.target.value })}
                  />
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => remove(index)}
                    aria-label={`Remove ${name}`}
                  >
                    Remove
                  </button>
                </div>
                {startError && <FieldError id={`${startId}-error`}>{startError}</FieldError>}
                {endError && <FieldError id={`${endId}-error`}>{endError}</FieldError>}
              </li>
            )
          })}
        </ul>
      )}
      <button
        id={addId}
        type="button"
        className="button button-small"
        onClick={add}
        aria-label={`Add hours on ${label}`}
      >
        Add hours
      </button>
    </div>
  )
}
