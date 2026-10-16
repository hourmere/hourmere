import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { availableTimeZones } from './env.ts'
import { currentZoneId, offsetLabel, zoneName } from './time.ts'

interface TimeZonePickerProps {
  value: string
  onChange: (timeZone: string) => void
  /** For each zone's current offset. */
  now: number
  error?: string | undefined
}

interface Zone {
  id: string
  name: string
  offset: string
  /** What a search matches against. */
  haystack: string
}

const normalize = (text: string) => text.toLowerCase().replaceAll('_', ' ')

/**
 * Shows the zone times are in, and lets people pick another from every IANA zone the browser
 * knows, searching by city, region or offset ("berlin", "new york", "gmt+5:30"). The search
 * box is an ARIA combobox: arrows move through the list, Enter picks, Escape closes.
 */
export function TimeZonePicker({ value, onChange, now, error }: TimeZonePickerProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const toggle = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const zones = useMemo<Zone[]>(() => {
    const ids = availableTimeZones()
    // The visitor's own zone, also when the browser lists it under its other name.
    const listed = ids.find((id) => currentZoneId(id) === currentZoneId(value))
    if (listed) ids[ids.indexOf(listed)] = value
    else ids.push(value)
    return ids
      .map((zone) => {
        const offset = offsetLabel(zone, now)
        const name = zoneName(zone)
        return { id: zone, name, offset, haystack: normalize(`${name} ${zone} ${offset}`) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [now, value])

  const matches = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean)
    return words.length ? zones.filter((z) => words.every((w) => z.haystack.includes(w))) : zones
  }, [zones, query])

  useEffect(() => {
    if (open) search.current?.focus()
  }, [open])

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  })

  const current = zones.find((z) => z.id === value)

  function close() {
    setOpen(false)
    setQuery('')
    // After the key that closed it is done: a button focused while Enter is still going on
    // takes the rest of the keystroke as a click and opens the list again.
    setTimeout(() => toggle.current?.focus(), 0)
  }

  function pick(zone: string) {
    onChange(zone)
    close()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((a) => Math.min(Math.max(a + step, 0), Math.max(matches.length - 1, 0)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const zone = matches[active]
      if (zone) pick(zone.id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const optionId = (index: number) => `${id}-option-${index}`

  return (
    <div className="tz-picker">
      <button
        type="button"
        ref={toggle}
        className="tz-toggle"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-describedby={error ? `${id}-error` : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="tz-caption">Time zone</span>
        <span className="tz-current">
          <span className="tz-name">{current?.name ?? zoneName(value)}</span>{' '}
          <span className="tz-offset">{current?.offset}</span>
        </span>
        <span className="tz-change">{open ? 'Close' : 'Change'}</span>
      </button>
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
      {open && (
        <div className="tz-panel" id={`${id}-panel`}>
          <label htmlFor={`${id}-search`} className="visually-hidden">
            Search time zones
          </label>
          <input
            id={`${id}-search`}
            ref={search}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-autocomplete="list"
            aria-activedescendant={matches.length ? optionId(active) : undefined}
            placeholder="Search by city or offset"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          {/* Focus stays in the combobox, which points at the active option
              (aria-activedescendant) and takes the keys; options only take the pointer. */}
          <div
            className="tz-options"
            id={`${id}-options`}
            role="listbox"
            aria-label="Time zones"
            ref={list}
          >
            {matches.map((zone, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox handles the keys
              // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox
              <div
                key={zone.id}
                id={optionId(index)}
                role="option"
                aria-selected={zone.id === value}
                data-active={index === active}
                className="tz-option"
                onClick={() => pick(zone.id)}
                onMouseMove={() => index !== active && setActive(index)}
              >
                <span>{zone.name}</span>
                <span className="tz-offset">{zone.offset}</span>
              </div>
            ))}
          </div>
          <p className="visually-hidden" role="status">
            {matches.length === 1 ? '1 time zone' : `${matches.length} time zones`}
          </p>
          {!matches.length && <p className="muted tz-empty">No time zone matches “{query}”.</p>}
        </div>
      )}
    </div>
  )
}
