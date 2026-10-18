import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { failureMessage, loadSlotsInRange, type Slot, type SlotLoader } from './api.ts'
import {
  addMonths,
  compareMonths,
  type DateKey,
  firstDayOfWeek,
  monthOf,
  toDateKey,
  type YearMonth,
} from './calendar.ts'
import { MonthCalendar } from './MonthCalendar.tsx'
import { dateKeyIn, formatDateKey, formatTime } from './time.ts'

/** How far ahead people may page (the API has no notion of "the last month with slots"). */
const MONTHS_AHEAD = 24
/** Months skipped automatically when the first one shown has nothing left. */
const AUTO_ADVANCE = 2
// UTC offsets lie within -12 and +14 hours, so 14 hours either way covers every zone.
const ZONE_MARGIN = 14 * 3_600_000

/**
 * What one month's slots request asks for: every slot that starts in the month in any zone
 * (so changing the zone never needs another request), however long it is. The API returns
 * only slots that lie fully inside the range, so the UTC month is widened by the largest zone
 * offset plus the meeting's length on both sides: an 8-hour meeting at 09:00 UTC on the 1st
 * starts on the last day of the month before in Pago Pago (UTC-11) and ends after the
 * 14-hour margin. Slots are then sorted into days by their start in the chosen zone, and
 * those of other months left out. Nothing before `now` is asked for.
 */
export function monthRequestRange(
  { year, month }: YearMonth,
  durationMinutes: number,
  now: number,
): { start: number; end: number } {
  const margin = ZONE_MARGIN + durationMinutes * 60_000
  return {
    start: Math.max(Date.UTC(year, month - 1, 1) - margin, now),
    end: Date.UTC(year, month, 1) + margin,
  }
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; slots: Slot[] }
  | { status: 'error'; message: UiText }

interface SlotPickerProps {
  load: SlotLoader
  /** The meeting's length, for splitting long requests without losing slots. */
  durationMinutes: number
  timeZone: string
  onTimeZoneChange: (timeZone: string) => void
  timeZoneError?: UiText | undefined
  locale: string
  /** The current time; slots before it are not asked for. */
  now: number
  /** A reschedule must choose a different time from the booking it replaces. */
  excludeStart?: string | undefined
  selected: Slot | null
  onSelect: (slot: Slot) => void
  /** Changing it reloads the slots, e.g. after the chosen one was taken. */
  version: number
  title?: string
  /** Focus the picker's heading when it appears (coming back to it from another step). */
  focusTitle?: boolean
  /** A message about the last attempt, shown above the calendar (e.g. the time was taken). */
  notice?: UiText | null | undefined
}

const monthKey = ({ year, month }: YearMonth) => `${year}-${month}`

/**
 * Picks a slot: a month calendar of the days with times, the times of the chosen day in the
 * visitor's time zone (which they can change), and the zone shown with them. Used by the
 * booking page and for rescheduling. The calendar keeps its six rows and the times column its
 * size while slots load, so nothing jumps.
 */
export function SlotPicker({
  load,
  durationMinutes,
  timeZone,
  onTimeZoneChange,
  timeZoneError,
  locale,
  now,
  selected,
  excludeStart,
  onSelect,
  version,
  title = 'Pick a time',
  focusTitle = false,
  notice,
}: SlotPickerProps) {
  const { t, ui } = useI18n()

  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the picker appears
  useEffect(() => {
    if (focusTitle) heading.current?.focus()
  }, [])
  const today = dateKeyIn(now, timeZone)
  const firstMonth = useMemo(() => monthOf(today), [today])
  const lastMonth = useMemo(() => addMonths(firstMonth, MONTHS_AHEAD), [firstMonth])
  const [month, setMonth] = useState<YearMonth>(firstMonth)
  const [day, setDay] = useState<DateKey | null>(null)
  const [focusDay, setFocusDay] = useState<DateKey>(today)
  const [focusRequested, setFocusRequested] = useState(false)
  const [retry, setRetry] = useState(0)
  // Loaded data remembers what it was loaded for, so a render between a change and the new
  // answer never takes the previous month's slots for this one's.
  const request = `${monthKey(month)}|${version}|${retry}`
  const [loaded, setLoaded] = useState<{ request: string } & Loaded>({
    request: '',
    status: 'loading',
  })
  const state: Loaded = loaded.request === request ? loaded : { status: 'loading' }
  const autoAdvanced = useRef(0)
  const weekStart = useMemo(() => firstDayOfWeek(locale), [locale])

  useEffect(() => {
    const controller = new AbortController()
    const { start, end } = monthRequestRange(month, durationMinutes, now)
    if (end <= start) {
      setLoaded({ request, status: 'ready', slots: [] })
      return
    }
    loadSlotsInRange(load, start, end, durationMinutes * 60_000, controller.signal).then(
      (slots) => {
        if (!controller.signal.aborted) setLoaded({ request, status: 'ready', slots })
      },
      (err: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({ request, status: 'error', message: failureMessage(err) })
        }
      },
    )
    return () => controller.abort()
  }, [load, request, month, now, durationMinutes])

  /** The month's slots by day in the chosen zone (slots of other months are left out). */
  const byDay = useMemo(() => {
    const days = new Map<DateKey, Slot[]>()
    if (state.status !== 'ready') return days
    for (const slot of state.slots) {
      if (excludeStart !== undefined && Date.parse(slot.start) === Date.parse(excludeStart))
        continue
      const key = dateKeyIn(Date.parse(slot.start), timeZone)
      if (compareMonths(monthOf(key), month) !== 0) continue
      const list = days.get(key) ?? []
      list.push(slot)
      days.set(key, list)
    }
    for (const slots of days.values())
      slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    return days
  }, [state, timeZone, month, excludeStart])
  const available = useMemo(() => new Set(byDay.keys()), [byDay])
  const ready = state.status === 'ready'

  // The first month shown may have nothing left (late in the month, or a booking window that
  // opens later): move on by itself, a couple of times at most.
  useEffect(() => {
    if (!ready || available.size || autoAdvanced.current >= AUTO_ADVANCE) return
    if (compareMonths(month, lastMonth) >= 0) return
    autoAdvanced.current += 1
    setMonth(addMonths(month, 1))
  }, [ready, available, month, lastMonth])

  // The chosen day must be in the month shown and still have times (another zone can move a
  // day's times to the day before or after); keyboard focus stays in the month shown.
  useEffect(() => {
    if (day === null) return
    if (compareMonths(monthOf(day), month) !== 0 || (ready && !available.has(day))) setDay(null)
  }, [day, month, available, ready])
  useEffect(() => {
    if (compareMonths(monthOf(focusDay), month) !== 0) {
      setFocusDay(toDateKey({ ...month, day: 1 }))
    }
  }, [focusDay, month])

  const changeMonth = useCallback((next: YearMonth, focus?: DateKey) => {
    autoAdvanced.current = AUTO_ADVANCE // people paging themselves stop the automatic advance
    setMonth(next)
    if (focus) {
      setFocusDay(focus)
      setFocusRequested(true)
    }
  }, [])
  const moveFocus = useCallback((target: DateKey) => {
    setFocusDay(target)
    setFocusRequested(true)
  }, [])
  const focusDone = useCallback(() => setFocusRequested(false), [])

  const daySlots = day ? (byDay.get(day) ?? []) : []
  const labels = daySlots.map((s) => formatTime(Date.parse(s.start), timeZone, locale))
  // Where clocks go back, one wall time happens twice: add the zone's abbreviation then.
  const repeated = new Set(labels.filter((l, i) => labels.indexOf(l) !== i))

  let status = ''
  if (state.status === 'loading') status = t('Loading available times…')
  else if (ready && !available.size) status = t('No available times this month.')
  else if (ready && day) {
    status = t(
      daySlots.length === 1
        ? '{count} time available on {day}.'
        : '{count} times available on {day}.',
      { count: daySlots.length, day: formatDateKey(day, locale) },
    )
  } else if (ready) {
    status = t(
      available.size === 1
        ? '{count} day has available times this month.'
        : '{count} days have available times this month.',
      { count: available.size },
    )
  }

  return (
    <section className="picker" aria-labelledby={headingId}>
      <h2 id={headingId} className="picker-title" ref={heading} tabIndex={-1}>
        {ui(title)}
      </h2>
      {notice && (
        <div className="alert alert-info">
          <p role="alert">{ui(notice)}</p>
        </div>
      )}
      <div className="picker-body">
        <div className="picker-calendar">
          <MonthCalendar
            month={month}
            firstMonth={firstMonth}
            lastMonth={lastMonth}
            onMonthChange={changeMonth}
            available={available}
            selected={day}
            onSelect={setDay}
            focusDay={focusDay}
            onFocusDay={moveFocus}
            focusRequested={focusRequested}
            onFocusDone={focusDone}
            today={today}
            locale={locale}
            firstDayOfWeek={weekStart}
            busy={state.status === 'loading'}
          />
          <p className="picker-status" role="status">
            {ui(status)}
          </p>
          {state.status === 'error' && (
            <div className="alert alert-error picker-error">
              <p role="alert">{ui(state.message)}</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => setRetry((r) => r + 1)}
              >
                {t('Try again')}
              </button>
            </div>
          )}
          {ready && !available.size && compareMonths(month, lastMonth) < 0 && (
            <p>
              <button
                type="button"
                className="button button-small"
                onClick={() => changeMonth(addMonths(month, 1))}
              >
                {t('Show next month')}
              </button>
            </p>
          )}
          <TimeZonePicker
            value={timeZone}
            onChange={onTimeZoneChange}
            now={now}
            error={timeZoneError}
          />
        </div>
        <div className="picker-slots">
          {day ? (
            <>
              <h3 className="slots-day">{formatDateKey(day, locale)}</h3>
              <ul
                className="slots"
                aria-label={t('Times on {0}', { '0': formatDateKey(day, locale) })}
              >
                {daySlots.map((slot, i) => {
                  const start = Date.parse(slot.start)
                  const label = repeated.has(labels[i] as string)
                    ? formatTime(start, timeZone, locale, { withZone: true })
                    : (labels[i] as string)
                  const isSelected = selected?.start === slot.start
                  return (
                    <li key={slot.start}>
                      <button
                        type="button"
                        className={`slot${isSelected ? ' slot-selected' : ''}`}
                        aria-pressed={isSelected}
                        onClick={() => onSelect(slot)}
                      >
                        {label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <p className="slots-placeholder muted">
              {ready && available.size ? t('Pick a day to see its times.') : ' '}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
