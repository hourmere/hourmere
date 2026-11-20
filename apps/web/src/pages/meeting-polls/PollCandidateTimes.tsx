import { useCallback } from 'react'
import { zoned } from '../../format.ts'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { eventSlots, type Slot } from '../../public/api.ts'
import { AvailableHostTimes, loadHostDaySlots } from '../event-types/HostTimeSelection.tsx'
import { pollTimeRange } from './poll-time.ts'

export const MAX_POLL_CANDIDATES = 20

export function PollCandidateTimes({
  handle,
  slug,
  team,
  timeZone,
  date,
  durationMinutes,
  disabled,
  selected,
  onSelect,
}: {
  handle: string
  slug: string
  team: boolean
  timeZone: string
  date: string
  durationMinutes: number
  disabled: boolean
  selected: Slot[]
  onSelect: (slot: Slot) => void
}) {
  const { t, formatLocale } = useI18n()
  const format = zoned(timeZone, formatLocale)
  const load = useCallback(
    (signal: AbortSignal) =>
      loadHostDaySlots(
        eventSlots(handle, slug, team, durationMinutes),
        date,
        timeZone,
        durationMinutes,
        signal,
      ),
    [handle, slug, team, date, timeZone, durationMinutes],
  )
  const [times, reload] = useLoad(load)
  const slots = times.status === 'ready' ? times.data : []
  return (
    <>
      <AvailableHostTimes
        id="poll-create-candidates"
        loading={times.status === 'loading'}
        error={times.status === 'error'}
        disabled={disabled}
      >
        {slots.length > 0
          ? slots.map((slot) => {
              const checked = selected.some((candidate) => candidate.start === slot.start)
              return (
                <label key={slot.start} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selected.length >= MAX_POLL_CANDIDATES}
                    onChange={() => onSelect(slot)}
                  />
                  {pollTimeRange(format, slot.start, slot.end)}
                </label>
              )
            })
          : null}
      </AvailableHostTimes>
      {times.status === 'error' && (
        <button className="button button-small" type="button" onClick={reload}>
          {t('Check availability again')}
        </button>
      )}
    </>
  )
}
