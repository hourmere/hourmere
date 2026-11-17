import { useState } from 'react'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'

export type TimeUnit = 'minutes' | 'hours' | 'days'
const MINUTES = { minutes: 1, hours: 60, days: 1440 } as const

export function initialTimeUnit(value: string, storageUnit: 'minutes' | 'days'): TimeUnit {
  const minutes = Number(value) * MINUTES[storageUnit]
  if (storageUnit === 'days' || (minutes > 0 && minutes % 1440 === 0)) return 'days'
  return minutes > 0 && minutes % 60 === 0 ? 'hours' : 'minutes'
}

/** Accept decimals only when their exact rational value represents whole storage units. */
export function toStoredTime(
  value: string,
  unit: TimeUnit,
  storageUnit: 'minutes' | 'days',
): string {
  const raw = value.trim()
  if (!raw) return ''
  if (!/^\d+(\.\d+)?$/.test(raw) || raw.length > 30) return 'invalid'
  const [whole, fraction = ''] = raw.split('.')
  const numerator = BigInt(whole + fraction) * BigInt(MINUTES[unit])
  const denominator = 10n ** BigInt(fraction.length) * BigInt(MINUTES[storageUnit])
  if (numerator % denominator !== 0n) return 'invalid'
  return String(numerator / denominator)
}

/** Unit changes affect presentation only; the untouched canonical value is never rounded. */
export function TimeUnitField({
  id,
  label,
  value,
  onChange,
  rule,
  storageUnit = 'minutes',
  optional = false,
  error,
  extra,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  rule: { min: number; max: number }
  storageUnit?: 'minutes' | 'days'
  optional?: boolean
  error?: UiText
  extra?: string
}) {
  const { t, uiText } = useI18n()
  const [unit, setUnit] = useState<TimeUnit>(() => initialTimeUnit(value, storageUnit))
  const [entry, setEntry] = useState<{ canonical: string; unit: TimeUnit; text: string } | null>(
    null,
  )
  // Multiply before dividing: a precomputed 1/60 factor shows 111 minutes as 1.8499999999999999 hours.
  const inUnit = (stored: number) => (stored * MINUTES[storageUnit]) / MINUTES[unit]
  const unitLabel = t(
    unit === 'minutes' ? 'Minutes' : unit === 'hours' ? 'Time unit: hours' : 'Days',
  )
  const display =
    entry?.canonical === value && entry.unit === unit
      ? entry.text
      : value === ''
        ? ''
        : String(inUnit(Number(value)))
  const range = msg('Enter {min}–{max} {unit}, in whole {storageUnit}.', {
    min: String(inUnit(rule.min)),
    max: String(inUnit(rule.max)),
    unit: unitLabel,
    storageUnit: t(storageUnit === 'minutes' ? 'Minutes' : 'Days'),
  })
  return (
    <Field
      id={id}
      label={label}
      optional={optional}
      error={error ? range : undefined}
      hint={
        <>
          {extra} {uiText(range)}{' '}
          {value !== '' && value !== 'invalid'
            ? t('Stored value: {value} {unit}.', {
                value,
                unit: t(storageUnit === 'minutes' ? 'Minutes' : 'Days'),
              })
            : ''}
          {optional ? ` ${t('Empty: no limit.')}` : ''}
        </>
      }
    >
      {(props) => (
        <>
          <input
            {...props}
            inputMode="decimal"
            value={display}
            onChange={(event) => {
              const canonical = toStoredTime(event.target.value, unit, storageUnit)
              setEntry({ canonical, unit, text: event.target.value })
              onChange(canonical)
            }}
          />
          <select
            aria-label={t('{label} unit', { label })}
            value={unit}
            onChange={(event) => {
              const nextUnit = event.target.value as TimeUnit
              setUnit(nextUnit)
              setEntry(value === 'invalid' && entry ? { ...entry, unit: nextUnit } : null)
            }}
          >
            <option value="minutes">{t('Minutes')}</option>
            <option value="hours">{t('Time unit: hours')}</option>
            <option value="days">{t('Days')}</option>
          </select>
        </>
      )}
    </Field>
  )
}
