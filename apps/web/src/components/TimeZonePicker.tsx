// One searchable IANA picker for public slot selection and editable admin fields.
import { Fragment, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isKnownTimeZone } from '../format.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { type DateKey, parseDateKey } from '../public/calendar.ts'
import { availableTimeZones, detectTimeZone } from '../public/env.ts'
import { currentZoneId, instantOf, offsetLabel, zoneName } from '../public/time.ts'
import type { ControlProps } from './forms.tsx'

interface TimeZonePickerProps {
  value: string
  onChange: (value: string) => void
  /** With a field control, allow free typing so the surrounding form can validate it. */
  control?: ControlProps
  /** Offsets on this calendar date, at local noon in each listed zone. */
  referenceDate?: DateKey
  /** Fallback offset instant when no calendar date is supplied. */
  now?: number
  error?: UiText | undefined
}

const MAX_SHOWN = 100
const COMMON_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
]
const normalize = (text: string) => text.toLowerCase().replaceAll('_', ' ')

/**
 * Break opportunities after each slash; the stylesheet's `overflow-wrap: anywhere` still
 * splits a segment that is wider than a 320px option on its own, instead of overflowing.
 */
export function TimeZoneName({
  name,
  className,
  label,
}: {
  name: string
  className?: string
  label?: string
}) {
  // Only IANA name segments stay together; translated surrounding prose can wrap normally.
  const at = label?.indexOf(name) ?? -1
  return (
    <span className={className}>
      {at >= 0 && label?.slice(0, at)}
      {name.split('/').map((part, index, parts) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed components of a display name
        <Fragment key={index}>
          <span className="time-zone-segment">{part}</span>
          {index < parts.length - 1 && (
            <>
              {'/'}
              <wbr />
            </>
          )}
        </Fragment>
      ))}
      {at >= 0 && label?.slice(at + name.length)}
    </span>
  )
}

export function timeZoneNames(): string[] {
  try {
    return [...new Set(availableTimeZones())].sort()
  } catch {
    return ['UTC']
  }
}

export function matchTimeZones(zones: readonly string[], query: string): string[] {
  const words = normalize(query)
    .split(/[\s/]+/)
    .filter(Boolean)
  return zones.filter((zone) => words.every((word) => normalize(zone).includes(word)))
}

interface Zone {
  id: string
  name: string
  offset: string
  canonical: string
  haystack: string
}

function zoneInfo(id: string, now: number, referenceDate?: DateKey): Zone {
  const name = zoneName(id)
  const offset = offsetLabel(
    id,
    referenceDate ? instantOf(parseDateKey(referenceDate), 12, 0, id) : now,
  )
  return {
    id,
    name,
    offset,
    canonical: currentZoneId(id),
    haystack: normalize(`${name} ${id} ${offset}`),
  }
}

export function TimeZonePicker({
  value,
  onChange,
  control,
  now,
  referenceDate,
  error,
}: TimeZonePickerProps) {
  const { t, ui, text: translatedText } = useI18n()

  const editable = control !== undefined
  const id = useId()
  const [mountedAt] = useState(Date.now)
  const [browserTimeZone] = useState(detectTimeZone)
  const at = now ?? mountedAt
  // Typing changes only the search; changing the displayed date refreshes every offset.
  const listed = useMemo(
    () => timeZoneNames().map((zone) => zoneInfo(zone, at, referenceDate)),
    [at, referenceDate],
  )
  const zones = useMemo(() => {
    const preferredIds = new Set(editable ? [value] : [value, browserTimeZone])
    const aliases = [...preferredIds]
      .filter((id) => !listed.some((zone) => zone.id === id) && isKnownTimeZone(id))
      .map((id) => zoneInfo(id, at, referenceDate))
    if (!aliases.length) return listed
    return [
      ...listed.filter(
        (zone) =>
          preferredIds.has(zone.id) || !aliases.some((alias) => alias.canonical === zone.canonical),
      ),
      ...aliases,
    ].sort((a, b) => a.id.localeCompare(b.id))
  }, [listed, value, browserTimeZone, editable, at, referenceDate])
  // The public picker starts with the current choice and a short set of common zones.
  // Keep the editable settings combobox alphabetical for its existing keyboard navigation.
  const common = useMemo(() => {
    if (editable) return []
    const ids = new Set([value, browserTimeZone, ...COMMON_ZONES])
    return [...ids].flatMap((id) => {
      const zone = zones.find((zone) => zone.id === id)
      return zone ? [zone] : []
    })
  }, [editable, value, browserTimeZone, zones])
  const ordered = useMemo(() => {
    const ids = new Set(common.map((zone) => zone.id))
    return [...common, ...zones.filter((zone) => !ids.has(zone.id))]
  }, [common, zones])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [active, setActive] = useState(0)
  const toggle = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const text = editable ? value : query
  const words = normalize(text)
    .split(/[\s/]+/)
    .filter(Boolean)
  const matches =
    !editable || filtering
      ? ordered.filter((zone) => words.every((word) => zone.haystack.includes(word)))
      : ordered
  const shown = editable && filtering ? matches.slice(0, MAX_SHOWN) : matches
  const optionId = (index: number) => `${id}-option-${index}`
  const current = zones.find((zone) => zone.id === value)

  useEffect(() => {
    if (open && !editable) search.current?.focus()
  }, [open, editable])
  useEffect(() => {
    if (open)
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  })

  function close() {
    setOpen(false)
    setQuery('')
    setFiltering(false)
    if (!editable) setTimeout(() => toggle.current?.focus(), 0)
  }
  function pick(zone: string) {
    onChange(zone)
    close()
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open && event.key === 'ArrowDown') {
        setOpen(true)
        setFiltering(false)
        setActive(
          Math.max(
            0,
            ordered.findIndex((zone) => zone.id === value),
          ),
        )
      } else if (open) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => Math.min(Math.max(index + step, 0), Math.max(shown.length - 1, 0)))
      }
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const zone = shown[active]
      if (zone) pick(zone.id)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  function renderOption(zone: Zone, index: number) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles keys
      <div
        key={zone.id}
        id={optionId(index)}
        role="option"
        aria-selected={editable ? index === active : zone.id === value}
        data-active={index === active}
        tabIndex={-1}
        className={editable ? 'combobox-option' : 'tz-option'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(zone.id)}
        onMouseMove={() => index !== active && setActive(index)}
      >
        <TimeZoneName name={zone.name} />
        <span className={editable ? 'muted' : 'tz-offset'}>{zone.offset}</span>
      </div>
    )
  }

  return (
    <div className={editable ? 'combobox' : 'tz-picker'}>
      {!editable && (
        <button
          type="button"
          ref={toggle}
          className="tz-toggle"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-describedby={error ? `${id}-error` : undefined}
          onClick={() => {
            if (open) close()
            else {
              setActive(
                Math.max(
                  0,
                  ordered.findIndex((zone) => zone.id === value),
                ),
              )
              setOpen(true)
            }
          }}
        >
          <span className="tz-caption">{t('Time zone')}</span>
          <span className="tz-current">
            <TimeZoneName className="tz-name" name={current?.name ?? zoneName(value)} />{' '}
            <span className="tz-offset">{current?.offset}</span>
          </span>
          <span className="tz-change">{open ? t('Close') : t('Change')}</span>
        </button>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {ui(error)}
        </p>
      )}
      {(editable || open) && (
        <div className={editable ? undefined : 'tz-panel'} id={`${id}-panel`}>
          {!editable && (
            <label htmlFor={`${id}-search`} className="visually-hidden">
              {t('Search time zones')}
            </label>
          )}
          <input
            {...control}
            id={control?.id ?? `${id}-search`}
            ref={search}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-options`}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
            placeholder={editable ? undefined : t('Search by city or offset')}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              if (editable) onChange(event.target.value)
              else setQuery(event.target.value)
              setFiltering(true)
              setOpen(true)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!editable) return
              close()
              const exact =
                listed.find((zone) => zone.id.toLowerCase() === value.trim().toLowerCase()) ??
                zones.find((zone) => zone.id.toLowerCase() === value.trim().toLowerCase())
              if (exact && exact.id !== value) onChange(exact.id)
            }}
          />
          <div
            className={editable ? 'combobox-list' : 'tz-options'}
            id={`${id}-options`}
            role="listbox"
            aria-label={t('Time zones')}
            ref={list}
            hidden={!open || shown.length === 0}
          >
            {open &&
              (!editable && !query ? (
                <>
                  {/* biome-ignore lint/a11y/useSemanticElements: APG listbox option groups use a labelled group, not form fields */}
                  <div role="group" aria-labelledby={`${id}-common`}>
                    <div className="tz-group-label" id={`${id}-common`}>
                      {t('Current and common time zones')}
                    </div>
                    {shown.slice(0, common.length).map(renderOption)}
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: APG listbox option groups use a labelled group, not form fields */}
                  <div role="group" aria-labelledby={`${id}-all`}>
                    <div className="tz-group-label" id={`${id}-all`}>
                      {t('All time zones')}
                    </div>
                    {shown
                      .slice(common.length)
                      .map((zone, index) => renderOption(zone, index + common.length))}
                  </div>
                </>
              ) : (
                shown.map(renderOption)
              ))}
          </div>
          {!editable && (
            <p className="visually-hidden" role="status">
              {matches.length === 1
                ? t('1 time zone')
                : t('{0} time zones', { '0': matches.length })}
            </p>
          )}
          {open && shown.length === 0 && (
            <div className={editable ? 'combobox-list combobox-empty' : 'muted tz-empty'}>
              {translatedText('No time zone matches “{query}”.', { query: text })}
            </div>
          )}
          {editable && open && shown.length < matches.length && (
            <p className="hint">
              {t('Type to narrow down the')} {matches.length} {t('time zones.')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
