import { useEffect, useRef, useState } from 'react'
import { Field, type FieldErrors } from '../../components/forms.tsx'
import { isKnownTimeZone } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { IntervalsEditor } from './IntervalsEditor.tsx'
import {
  type IntervalDraft,
  intervalDraft,
  intervalField,
  todayIn,
  toIntervals,
  validateIntervals,
} from './weekly-hours.ts'

export type Override = { date: string; intervals: { start: string; end: string }[] }
export type OverrideDraft = {
  key: string
  date: string
  originalDate: string
  intervals: IntervalDraft[]
  removed: boolean
}
export const overrideDraft = (value: Override): OverrideDraft => ({
  key: intervalDraft().key,
  date: value.date,
  originalDate: value.date,
  intervals: value.intervals.map((i) => intervalDraft(i.start, i.end)),
  removed: false,
})
export const overridesBody = (drafts: OverrideDraft[]) =>
  drafts
    .filter((d) => !d.removed)
    .map((d) => ({ date: d.date, intervals: toIntervals(d.intervals) }))
    .sort((a, b) => a.date.localeCompare(b.date))
export const comparableOverrides = (drafts: OverrideDraft[]) =>
  JSON.stringify(overridesBody(drafts))
export function overrideErrors(drafts: OverrideDraft[]): FieldErrors {
  const errors: FieldErrors = {}
  const dates = new Set<string>()
  for (const d of drafts.filter((d) => !d.removed)) {
    const dateId = `override-${d.key}-date`
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
      d.date.startsWith('0000') ||
      Number.isNaN(Date.parse(`${d.date}T00:00:00Z`)) ||
      new Date(`${d.date}T00:00:00Z`).toISOString().slice(0, 10) !== d.date
    )
      errors[dateId] = 'Choose a date in the years 0001 to 9999.'
    else if (dates.has(d.date)) errors[dateId] = 'Each date can have only one override.'
    dates.add(d.date)
    Object.assign(errors, validateIntervals(`override-${d.key}`, d.intervals))
  }
  return errors
}
export function overrideLabels(drafts: OverrideDraft[]): Record<string, UiText> {
  const labels: Record<string, UiText> = {}
  for (const d of drafts) {
    const prefix = `override-${d.key}`
    labels[`${prefix}-date`] = 'Date'
    labels[prefix] = 'Hours'
    d.intervals.forEach((i, n) => {
      labels[intervalField(prefix, i, 'start')] = msg('Hours {0}, from', { '0': n + 1 })
      labels[intervalField(prefix, i, 'end')] = msg('Hours {0}, until', { '0': n + 1 })
    })
  }
  return labels
}

/** Every row is part of the enclosing schedule form, including incomplete new rows. */
export function Overrides({
  drafts,
  onChange,
  errors,
  timeZone,
}: {
  drafts: OverrideDraft[]
  onChange: (drafts: OverrideDraft[]) => void
  errors: FieldErrors
  timeZone: string
}) {
  const { t, formatLocale } = useI18n()
  const zoneLabel = isKnownTimeZone(timeZone)
    ? (new Intl.DateTimeFormat(formatLocale, {
        timeZone,
        timeZoneName: 'longGeneric',
      })
        .formatToParts()
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone.replaceAll('_', ' '))
    : timeZone.replaceAll('_', ' ')
  const today = todayIn(timeZone)
  const isPast = (d: OverrideDraft) => !!d.originalDate && d.originalDate < today
  const past = drafts.filter(isPast)
  const upcoming = drafts
    .filter((d) => !isPast(d))
    .sort((a, b) => a.originalDate.localeCompare(b.originalDate))
  const dateLabel = (date: string) => {
    const parsed = new Date(`${date}T00:00:00Z`)
    // Native date inputs can supply years beyond the supported four-digit range.
    // Keep the draft renderable so ordinary field validation can explain the error.
    if (Number.isNaN(parsed.getTime())) return date
    return new Intl.DateTimeFormat(formatLocale, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      calendar: 'gregory',
    }).format(parsed)
  }
  const [focus, setFocus] = useState<string | null>(null)
  const add = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focus) {
      document.getElementById(focus)?.focus()
      setFocus(null)
    }
  }, [focus])
  function change(key: string, patch: Partial<OverrideDraft>) {
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }
  return (
    <section className="panel" aria-labelledby="overrides-heading">
      <h2 id="overrides-heading">{t('Date overrides')}</h2>
      <p className="hint">
        {t(
          'Date overrides replace weekly hours on that date. Save changes applies every change on this page.',
        )}
      </p>
      <p className="hint">{t('Times are in {0}.', { '0': zoneLabel })}</p>
      <button
        ref={add}
        type="button"
        className="button"
        onClick={() => {
          const d = overrideDraft({ date: '', intervals: [] })
          onChange([...drafts, d])
          setFocus(`override-${d.key}-date`)
        }}
      >
        {t('Add a date override')}
      </button>
      {drafts.length === 0 && <p>{t('No date overrides.')}</p>}
      {upcoming.map((d, n) => (
        <fieldset key={d.key} id={`override-${d.key}`} tabIndex={-1} className="override-form">
          <legend>{t('Date override {0}', { '0': n + 1 })}</legend>
          {d.removed ? (
            <p>
              {dateLabel(d.date)} — {t('Removal pending save')}
            </p>
          ) : (
            <>
              <Field
                id={`override-${d.key}-date`}
                label={t('Date')}
                error={errors[`override-${d.key}-date`]}
              >
                {(props) => (
                  <input
                    {...props}
                    type="date"
                    min={today}
                    value={d.date}
                    onChange={(e) => change(d.key, { date: e.target.value })}
                  />
                )}
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  id={`override-${d.key}-off`}
                  checked={d.intervals.length === 0}
                  onChange={(e) =>
                    change(d.key, { intervals: e.target.checked ? [] : [intervalDraft()] })
                  }
                />
                {t('Unavailable all day')}
              </label>
              {d.intervals.length > 0 && (
                <IntervalsEditor
                  prefix={`override-${d.key}`}
                  label={dateLabel(d.date) || t('That date')}
                  intervals={d.intervals}
                  onChange={(intervals) => {
                    change(d.key, { intervals })
                    if (!intervals.length) setFocus(`override-${d.key}-off`)
                  }}
                  errors={errors}
                />
              )}
            </>
          )}
          <button
            type="button"
            className="button button-small"
            aria-label={t(d.removed ? 'Undo removal: {0}' : 'Remove override: {0}', {
              '0': dateLabel(d.date) || n + 1,
            })}
            onClick={() => change(d.key, { removed: !d.removed })}
          >
            {t(d.removed ? 'Undo removal' : 'Remove')}
          </button>
        </fieldset>
      ))}
      {past.length > 0 && (
        <details className="past-overrides">
          <summary>{t('Past date overrides ({0})', { '0': past.length })}</summary>
          <ul>
            {past.map((d) => (
              <li key={d.key}>
                {dateLabel(d.date)} —{' '}
                {d.intervals.length
                  ? d.intervals.map((i) => `${i.start}–${i.end}`).join(', ')
                  : t('Unavailable all day')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
