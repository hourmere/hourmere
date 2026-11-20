import type { ReactNode } from 'react'
import type { ControlProps } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { codeOf, type Slot, type SlotLoader } from '../../public/api.ts'
import { addDays, parseDateKey } from '../../public/calendar.ts'
import { instantOf } from '../../public/time.ts'

export function MeetingLengthSelect({
  control,
  allowed,
  value,
  onChange,
}: {
  control: ControlProps
  allowed: number[]
  value: number
  onChange: (minutes: number) => void
}) {
  const { t } = useI18n()
  return (
    <select {...control} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {allowed.map((duration) => (
        <option key={duration} value={duration}>
          {t('{0} min', { '0': duration })}
        </option>
      ))}
    </select>
  )
}

export function AvailableHostTimes({
  id,
  loading,
  error,
  disabled,
  children,
}: {
  id?: string
  loading: boolean
  error: boolean
  disabled: boolean
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <fieldset
      id={id}
      tabIndex={id ? -1 : undefined}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      <legend>{t('Available times')}</legend>
      {loading ? (
        <p role="status">{t('Loading available times…')}</p>
      ) : error ? (
        <p role="alert">{t('We could not load available times. Please try again.')}</p>
      ) : (
        (children ?? <p>{t('No times are offered on this date.')}</p>)
      )}
    </fieldset>
  )
}

/** A display-zone calendar day, including both occurrences of any repeated hour. */
export async function loadHostDaySlots(
  load: SlotLoader,
  date: string,
  timeZone: string,
  durationMinutes: number,
  signal: AbortSignal,
): Promise<Slot[]> {
  const start = instantOf(parseDateKey(date), 0, 0, timeZone)
  const boundary = instantOf(parseDateKey(addDays(date, 1)), 0, 0, timeZone)
  const duration = durationMinutes * 60_000
  const until = boundary + duration
  const request = (from: number, to: number) =>
    load(new Date(from).toISOString(), new Date(to).toISOString(), signal)
  let slots: Slot[]
  try {
    slots = await request(start, until)
  } catch (error) {
    if (codeOf(error) !== 'range_too_long' || signal.aborted) throw error
    // Keep cross-midnight times and split the start window for small slot steps.
    const middle = start + (boundary - start) / 2
    const [first, second] = await Promise.all([
      request(start, middle + duration),
      request(middle, until),
    ])
    slots = [
      ...first.filter((slot) => Date.parse(slot.start) < middle),
      ...second.filter((slot) => Date.parse(slot.start) >= middle),
    ]
  }
  return slots
    .filter((slot) => {
      const startsAt = Date.parse(slot.start)
      return (
        startsAt >= start && startsAt < boundary && Date.parse(slot.end) === startsAt + duration
      )
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
}
