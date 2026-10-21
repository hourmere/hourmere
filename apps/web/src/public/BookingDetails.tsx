import { displayConferenceUrl } from '@hourmere/core/conference-url'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/runtime.tsx'
import type { Booking } from './api.ts'
import { formatDate, formatTimeRange, offsetLabel, zoneName } from './time.ts'

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  phone: 'Phone call',
  in_person: 'In person',
  link: 'Online meeting',
}

export const locationLabel = (kind: string) => LOCATION_LABELS[kind] ?? 'To be confirmed'

/** Only http(s) links become clickable: a host-entered value must never run script. */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Where a booked meeting happens, with the details the booking reveals (number, address, link). */
export function LocationDetails({ location }: { location: Booking['location'] }) {
  const { t, ui } = useI18n()

  if (!location) return <>{t('To be confirmed by the host')}</>
  const url =
    location.kind === 'google_meet' || location.kind === 'zoom'
      ? displayConferenceUrl(location.kind, location.url)
      : safeUrl(location.url)
  const number = typeof location.number === 'string' ? location.number : undefined
  const address = typeof location.address === 'string' ? location.address : undefined
  return (
    <>
      {ui(locationLabel(location.kind))}
      {number && (
        <>
          {t(': ')}
          <a href={`tel:${number.replace(/[^+\d]/g, '')}`}>{number}</a>
        </>
      )}
      {address && (
        <>
          {t(': ')}
          {address}
        </>
      )}
      {url && (
        <>
          {t(': ')}
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
          </a>
        </>
      )}
    </>
  )
}

/** The plain-text location for a calendar entry. */
export function locationText(
  location: Booking['location'],
  labelText: (label: string) => string = (label) => label,
  separator = ': ',
): string | undefined {
  if (!location) return undefined
  const link =
    location.kind === 'google_meet' || location.kind === 'zoom'
      ? displayConferenceUrl(location.kind, location.url)
      : safeUrl(location.url)
  const detail = [location.number, location.address, link].find(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  return detail
    ? `${labelText(locationLabel(location.kind))}${separator}${detail}`
    : labelText(locationLabel(location.kind))
}

/** `Tuesday, November 3, 2026, 9:00 – 9:30 AM (Europe/Berlin, GMT+01:00)` in parts. */
export function When({
  start,
  end,
  timeZone,
  locale,
}: {
  start: string
  end: string
  timeZone: string
  locale: string
}) {
  const { t } = useI18n()
  const s = Date.parse(start)
  const e = Date.parse(end)
  // The locale's brackets and comma wrap the zone; the numeric offset and its closing bracket
  // stay in one unbreakable span.
  const offset = offsetLabel(timeZone, s)
  const zone = t(' ({zone}, {offset})', { zone: zoneName(timeZone), offset })
  const at = zone.lastIndexOf(offset)
  return (
    <>
      <time dateTime={start}>{formatDate(s, timeZone, locale)}</time>
      <br />
      {formatTimeRange(s, e, timeZone, locale)}
      <span className="muted">
        {at < 0 ? (
          zone
        ) : (
          <>
            {zone.slice(0, at)}
            <span className="time-offset">{zone.slice(at)}</span>
          </>
        )}
      </span>
    </>
  )
}

export function DetailList({ items }: { items: [string, ReactNode][] }) {
  const { ui } = useI18n()

  return (
    <dl className="booking-details">
      {items.map(([term, value]) => (
        <div key={term} className="details-row">
          <dt>{ui(term)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
