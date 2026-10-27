import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import './SlotPicker.css'
import { TimeZonePicker } from '../components/TimeZonePicker.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { failureMessage, loadSlotsInRange, type Slot, type SlotLoader } from './api.ts'
import {
  addMonths,
  compareMonths,
  type DateKey,
  daysInMonth,
  firstDayOfWeek,
  monthOf,
  parseDateKey,
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

/** Calendar position owned by the booking flow, independent of its selected time. */
export interface SlotPickerPosition {
  month: YearMonth
  day: DateKey | null
}

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
  /** Restore when the picker remounts after another step in the same flow. */
  initialPosition?: SlotPickerPosition | null
  onPositionChange?: (position: SlotPickerPosition) => void
  /** Changing it reloads the slots, e.g. after the chosen one was taken. */
  version: number
  title?: string
  /** Supporting content read immediately after the heading, before the calendar. */
  afterTitle?: ReactNode
  /** Focus the picker's heading when it appears (coming back to it from another step). */
  focusTitle?: boolean
  /** A message about the last attempt, shown above the calendar (e.g. the time was taken). */
  notice?: UiText | null | undefined
}

const monthKey = ({ year, month }: YearMonth) => `${year}-${month}`

function restorePosition(
  position: SlotPickerPosition | null | undefined,
  firstMonth: YearMonth,
  lastMonth: YearMonth,
  today: DateKey,
) {
  if (!position) return { month: firstMonth, day: null, unavailable: false }
  const { month, day } = position
  if (
    !Number.isInteger(month.year) ||
    !Number.isInteger(month.month) ||
    month.month < 1 ||
    month.month > 12 ||
    compareMonths(month, firstMonth) < 0 ||
    compareMonths(month, lastMonth) > 0
  ) {
    return { month: firstMonth, day: null, unavailable: true }
  }
  if (day !== null) {
    const parsed = parseDateKey(day)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      parsed.day < 1 ||
      parsed.day > daysInMonth(month) ||
      compareMonths(monthOf(day), month) !== 0 ||
      day < today
    ) {
      return { month, day: null, unavailable: true }
    }
  }
  return { month, day, unavailable: false }
}

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
  initialPosition,
  onPositionChange,
  version,
  title = 'Pick a time',
  afterTitle,
  focusTitle = false,
  notice,
}: SlotPickerProps) {
  const { t, uiText } = useI18n()

  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the picker appears
  useEffect(() => {
    if (focusTitle) heading.current?.focus()
  }, [])
  const today = dateKeyIn(now, timeZone)
  const firstMonth = useMemo(() => monthOf(today), [today])
  const lastMonth = useMemo(() => addMonths(firstMonth, MONTHS_AHEAD), [firstMonth])
  const [restored] = useState(() => restorePosition(initialPosition, firstMonth, lastMonth, today))
  const [month, setMonth] = useState<YearMonth>(restored.month)
  const [day, setDay] = useState<DateKey | null>(restored.day)
  const [positionUnavailable, setPositionUnavailable] = useState(restored.unavailable)
  const [focusDay, setFocusDay] = useState<DateKey>(
    restored.day ??
      (compareMonths(restored.month, firstMonth) === 0
        ? today
        : toDateKey({ ...restored.month, day: 1 })),
  )
  const [focusRequested, setFocusRequested] = useState(false)
  const [retry, setRetry] = useState(0)
  const slotsHeading = useRef<HTMLHeadingElement>(null)
  const slotsList = useRef<HTMLUListElement>(null)
  const [daySelection, setDaySelection] = useState(0)
  const [moreSlots, setMoreSlots] = useState(false)
  // Loaded data remembers what it was loaded for, so a render between a change and the new
  // answer never takes the previous month's slots for this one's.
  const request = `${monthKey(month)}|${version}|${retry}|${now}|${durationMinutes}`
  const [loaded, setLoaded] = useState<{ request: string } & Loaded>({
    request: '',
    status: 'loading',
  })
  const state: Loaded = loaded.request === request ? loaded : { status: 'loading' }
  // Returning to a browsed month must not silently move it, even if it is now empty.
  const autoAdvanced = useRef(initialPosition ? AUTO_ADVANCE : 0)
  const weekStart = useMemo(() => firstDayOfWeek(locale), [locale])

  useEffect(() => {
    onPositionChange?.({ month, day })
  }, [month, day, onPositionChange])

  // Time passing or changing zones can move the accessible month window.
  useEffect(() => {
    if (compareMonths(month, firstMonth) >= 0 && compareMonths(month, lastMonth) <= 0) return
    autoAdvanced.current = AUTO_ADVANCE
    setMonth(firstMonth)
    setDay(null)
    setPositionUnavailable(true)
  }, [month, firstMonth, lastMonth])

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
    if (day < today || compareMonths(monthOf(day), month) !== 0 || (ready && !available.has(day))) {
      setDay(null)
      setPositionUnavailable(true)
    }
  }, [day, month, available, ready, today])
  useEffect(() => {
    if (compareMonths(monthOf(focusDay), month) !== 0) {
      setFocusDay(toDateKey({ ...month, day: 1 }))
    }
  }, [focusDay, month])

  const changeMonth = useCallback((next: YearMonth, focus?: DateKey) => {
    autoAdvanced.current = AUTO_ADVANCE // people paging themselves stop the automatic advance
    setMonth(next)
    setDay(null)
    setPositionUnavailable(false)
    if (focus) {
      setFocusDay(focus)
      setFocusRequested(true)
    }
  }, [])
  const moveFocus = useCallback((target: DateKey) => {
    // Browsing days with the keyboard or pointer also takes precedence over auto-jump.
    autoAdvanced.current = AUTO_ADVANCE
    setFocusDay(target)
    setFocusRequested(true)
  }, [])
  const focusDone = useCallback(() => setFocusRequested(false), [])

  const daySlots = day ? (byDay.get(day) ?? []) : []
  const updateSlotOverflow = useCallback(() => {
    const list = slotsList.current
    setMoreSlots(!!list && list.scrollHeight - list.scrollTop > list.clientHeight + 1)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure after the chosen day or its slot count changes
  useEffect(() => {
    const list = slotsList.current
    if (list) list.scrollTop = 0
    updateSlotOverflow()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSlotOverflow)
    if (list) observer?.observe(list)
    return () => observer?.disconnect()
  }, [day, daySlots.length, updateSlotOverflow])
  useEffect(() => {
    if (!day || !daySelection) return
    if (!window.matchMedia?.('(max-width: 639px)').matches) return
    slotsHeading.current?.scrollIntoView?.({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }, [day, daySelection])
  // Before a day is chosen, use the focused day in the visible month. A date rather than
  // today's instant lets every listed zone use its own DST rules for that calendar day.
  const referenceDate =
    day ??
    (compareMonths(monthOf(focusDay), month) === 0 ? focusDay : toDateKey({ ...month, day: 1 }))
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
        {uiText(title)}
      </h2>
      {afterTitle}
      {notice && (
        <div className="alert alert-info">
          <p role="alert">{uiText(notice)}</p>
        </div>
      )}
      {positionUnavailable && (
        <p className="alert alert-info" role="status">
          {t('The date you were viewing is no longer available. Please pick another day.')}
        </p>
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
            onSelect={(next) => {
              setDaySelection((attempt) => attempt + 1)
              setDay(next)
              setPositionUnavailable(false)
            }}
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
            {uiText(status)}
          </p>
          {state.status === 'error' && (
            <div className="alert alert-error picker-error">
              <p role="alert">{uiText(state.message)}</p>
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
            referenceDate={referenceDate}
            error={timeZoneError}
          />
        </div>
        <div className="picker-slots">
          {day ? (
            <>
              <h3 className="slots-day" ref={slotsHeading}>
                {formatDateKey(day, locale)}
              </h3>
              <div className="slots-scroll" data-more={moreSlots}>
                <ul
                  className="slots"
                  ref={slotsList}
                  onScroll={updateSlotOverflow}
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
              </div>
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
