// A searchable list of IANA time zones: a text field with suggestions (the ARIA combobox
// pattern). The value is the text itself, so the form validates it like any other field;
// picking a suggestion fills it in.
import { useEffect, useId, useMemo, useState } from 'react'
import { isKnownTimeZone, utcOffset } from '../format.ts'
import type { ControlProps } from './forms.tsx'

/** Suggestions shown at once while typing; more typing narrows them down. */
const MAX_SHOWN = 100

/** The time zones the browser knows, with UTC, sorted. */
export function timeZoneNames(): string[] {
  let names: string[] = []
  try {
    names = Intl.supportedValuesOf('timeZone')
  } catch {
    // Very old browsers: people can still type a name.
  }
  return [...new Set([...names, 'UTC'])].sort()
}

const searchable = (zone: string) => zone.toLowerCase().replaceAll('_', ' ')

/** Zones whose name contains every word of `query` ("new york", "europe ber", "kolkata"). */
export function matchTimeZones(zones: readonly string[], query: string): string[] {
  const words = query
    .toLowerCase()
    .replaceAll('_', ' ')
    .split(/[\s/]+/)
    .filter(Boolean)
  if (!words.length) return [...zones]
  return zones.filter((zone) => {
    const name = searchable(zone)
    return words.every((word) => name.includes(word))
  })
}

export function TimeZonePicker({
  value,
  onChange,
  control,
}: {
  value: string
  onChange: (value: string) => void
  /** From the surrounding Field: id, description, invalid state. */
  control: ControlProps
}) {
  const zones = useMemo(() => {
    const names = timeZoneNames()
    // An alias the browser does not list (e.g. a stored "Asia/Calcutta") is still offered.
    return value && !names.includes(value) && isKnownTimeZone(value)
      ? [...names, value].sort()
      : names
  }, [value])
  const offsets = useMemo(() => {
    const now = new Date()
    return new Map(zones.map((zone) => [zone, utcOffset(zone, now)]))
  }, [zones])

  const [open, setOpen] = useState(false)
  // Typing filters the list; opening it otherwise shows every zone, the current one active.
  const [filtering, setFiltering] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`

  const matches = filtering ? matchTimeZones(zones, value) : zones
  // Opened without typing, the whole list scrolls (to the current zone); typing caps it.
  const shown = filtering ? matches.slice(0, MAX_SHOWN) : matches

  // Keep the active suggestion in view while moving through the list with the keyboard.
  useEffect(() => {
    if (!open || active < 0) return
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
  })

  function show(fromTyping: boolean) {
    setOpen(true)
    setFiltering(fromTyping)
    setActive(fromTyping ? 0 : Math.max(0, zones.indexOf(value)))
  }

  function pick(zone: string) {
    onChange(zone)
    setOpen(false)
    setFiltering(false)
    setActive(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) show(false)
        else setActive((i) => Math.min(i + 1, shown.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        if (open) setActive((i) => Math.max(i - 1, 0))
        break
      case 'Enter': {
        const zone = shown[active]
        if (open && zone) {
          // Picking a suggestion, not submitting the form.
          e.preventDefault()
          pick(zone)
        }
        break
      }
      case 'Escape':
        if (open) {
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
        }
        break
    }
  }

  const activeZone = open ? shown[active] : undefined
  return (
    <div className="combobox">
      <input
        {...control}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        {...(activeZone && { 'aria-activedescendant': optionId(active) })}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          show(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false)
          // A name typed in another case is still that zone.
          const exact = zones.find((z) => z.toLowerCase() === value.trim().toLowerCase())
          if (exact && exact !== value) onChange(exact)
        }}
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Time zones"
        className="combobox-list"
        hidden={!open || shown.length === 0}
      >
        {open &&
          shown.map((zone, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's input handles keys
            <div
              key={zone}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              // Never in the tab order: the input keeps focus (aria-activedescendant).
              tabIndex={-1}
              className="combobox-option"
              // Keeps focus in the input, so the list stays a suggestion of it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(zone)}
            >
              <span>{zone.replaceAll('_', ' ')}</span>
              <span className="muted">{offsets.get(zone)}</span>
            </div>
          ))}
      </div>
      {open && shown.length === 0 && (
        <div className="combobox-list combobox-empty">No time zone matches “{value}”.</div>
      )}
      {open && shown.length < matches.length && (
        <p className="hint">Type to narrow down the {matches.length} time zones.</p>
      )}
    </div>
  )
}
