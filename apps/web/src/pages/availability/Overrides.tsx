import { useEffect, useRef, useState } from 'react'
import { Field, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { IntervalsEditor } from './IntervalsEditor.tsx'
import {
  type IntervalDraft,
  intervalDraft,
  intervalField,
  toIntervals,
  validateIntervals,
} from './weekly-hours.ts'

export type Override = { date: string; intervals: { start: string; end: string }[] }
export type OverrideDraft = {
  key: string
  date: string
  intervals: IntervalDraft[]
  removed: boolean
}
export const overrideDraft = (value: Override): OverrideDraft => ({
  key: intervalDraft().key,
  date: value.date,
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
}: {
  drafts: OverrideDraft[]
  onChange: (drafts: OverrideDraft[]) => void
  errors: FieldErrors
}) {
  const { t } = useI18n()
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
      {drafts.length === 0 && <p>{t('No date overrides.')}</p>}
      {drafts.map((d, n) => (
        <fieldset key={d.key} id={`override-${d.key}`} tabIndex={-1} className="override-form">
          <legend>{t('Date override {0}', { '0': n + 1 })}</legend>
          {d.removed ? (
            <p>
              {d.date} — {t('Removal pending save')}
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
                  label={d.date || t('That date')}
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
              '0': d.date || n + 1,
            })}
            onClick={() => change(d.key, { removed: !d.removed })}
          >
            {t(d.removed ? 'Undo removal' : 'Remove')}
          </button>
        </fieldset>
      ))}
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
    </section>
  )
}
