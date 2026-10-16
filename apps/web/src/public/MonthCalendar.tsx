import { type KeyboardEvent, useEffect, useId, useMemo, useRef } from 'react'
import {
  addDays,
  addMonths,
  compareMonths,
  type DateKey,
  monthGrid,
  monthOf,
  sameDayIn,
  toDateKey,
  weekdayOf,
  type YearMonth,
} from './calendar.ts'
import { formatDateKey, formatDayNumber, formatMonth } from './time.ts'

interface MonthCalendarProps {
  month: YearMonth
  /** The earliest month that may be shown (the current one). */
  firstMonth: YearMonth
  lastMonth: YearMonth
  onMonthChange: (month: YearMonth, focusDay?: DateKey) => void
  /** Days with at least one slot; others cannot be picked. */
  available: ReadonlySet<DateKey>
  selected: DateKey | null
  onSelect: (day: DateKey) => void
  /** The day keyboard focus rests on (one tab stop for the whole grid). */
  focusDay: DateKey
  onFocusDay: (day: DateKey) => void
  /** Move DOM focus to focusDay after the next render (keyboard navigation). */
  focusRequested: boolean
  onFocusDone: () => void
  today: DateKey
  locale: string
  firstDayOfWeek: number
  /** Slots for the month are loading: the grid stays, its days wait. */
  busy: boolean
}

/**
 * A month as an ARIA grid: arrow keys move by day and week, Home and End to the ends of the
 * week, Page Up and Page Down by month; Enter or Space picks the day. Always six rows, so
 * the page does not jump between months.
 */
export function MonthCalendar({
  month,
  firstMonth,
  lastMonth,
  onMonthChange,
  available,
  selected,
  onSelect,
  focusDay,
  onFocusDay,
  focusRequested,
  onFocusDone,
  today,
  locale,
  firstDayOfWeek,
  busy,
}: MonthCalendarProps) {
  const headingId = useId()
  const grid = useRef<HTMLTableElement>(null)
  const weeks = useMemo(() => monthGrid(month, firstDayOfWeek), [month, firstDayOfWeek])
  const weekdays = useMemo(
    () =>
      // 2026-11-01 is a Sunday; the following days give each weekday's name.
      Array.from({ length: 7 }, (_, i) => {
        const key = toDateKey({ year: 2026, month: 11, day: 1 + ((firstDayOfWeek + i) % 7) })
        return {
          short: formatDateKey(key, locale, { weekday: 'short' }),
          long: formatDateKey(key, locale, { weekday: 'long' }),
        }
      }),
    [locale, firstDayOfWeek],
  )
  const canGoBack = compareMonths(month, firstMonth) > 0
  const canGoForward = compareMonths(month, lastMonth) < 0

  useEffect(() => {
    if (!focusRequested) return
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus()
    onFocusDone()
  }, [focusRequested, focusDay, onFocusDone])

  function move(target: DateKey) {
    const targetMonth = monthOf(target)
    if (compareMonths(targetMonth, firstMonth) < 0 || compareMonths(targetMonth, lastMonth) > 0) {
      return
    }
    if (compareMonths(targetMonth, month) !== 0) onMonthChange(targetMonth, target)
    else onFocusDay(target)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, day: DateKey) {
    const weekStart = addDays(day, -((weekdayOf(day) - firstDayOfWeek + 7) % 7))
    const targets: Record<string, () => DateKey> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      Home: () => weekStart,
      End: () => addDays(weekStart, 6),
      PageUp: () => sameDayIn(day, addMonths(monthOf(day), -1)),
      PageDown: () => sameDayIn(day, addMonths(monthOf(day), 1)),
    }
    const target = targets[event.key]
    if (!target) return
    event.preventDefault()
    move(target())
  }

  return (
    <div className="calendar">
      <div className="calendar-header">
        <h3 id={headingId} className="calendar-month" aria-live="polite">
          {formatMonth(month.year, month.month, locale)}
        </h3>
        <div className="calendar-nav">
          <button
            type="button"
            className="icon-button"
            onClick={() => onMonthChange(addMonths(month, -1))}
            disabled={!canGoBack}
            aria-label="Previous month"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => onMonthChange(addMonths(month, 1))}
            disabled={!canGoForward}
            aria-label="Next month"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
      {/* The WAI-ARIA date picker pattern: a table with the grid role, whose cells (implicitly
          gridcells) each hold one day button; arrow keys move between them. */}
      <table
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the APG date grid
        role="grid"
        className="calendar-grid"
        aria-labelledby={headingId}
        aria-busy={busy}
        ref={grid}
      >
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w.long} scope="col" abbr={w.long}>
                {w.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions in the grid
            <tr key={row}>
              {week.map((day, i) => {
                if (day === null) {
                  // biome-ignore lint/suspicious/noArrayIndexKey: padding cells have no identity
                  return <td key={i} aria-hidden="true" />
                }
                const isAvailable = available.has(day)
                const isSelected = day === selected
                const label = `${formatDateKey(day, locale)}, ${
                  busy ? 'loading' : isAvailable ? 'available' : 'no times available'
                }`
                return (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a td in a grid is a gridcell
                  <td key={day} aria-selected={isSelected}>
                    <button
                      type="button"
                      data-day={day}
                      className={`day${isAvailable ? ' day-available' : ''}${
                        isSelected ? ' day-selected' : ''
                      }`}
                      tabIndex={day === focusDay ? 0 : -1}
                      aria-label={label}
                      aria-disabled={!isAvailable}
                      aria-current={day === today ? 'date' : undefined}
                      onFocus={() => day !== focusDay && onFocusDay(day)}
                      onKeyDown={(e) => onKeyDown(e, day)}
                      onClick={() => {
                        onFocusDay(day)
                        if (isAvailable) onSelect(day)
                      }}
                    >
                      {formatDayNumber(day, locale)}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
