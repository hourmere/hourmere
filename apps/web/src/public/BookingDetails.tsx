import { displayConferenceUrl } from '@hourmere/core/conference-url'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/runtime.tsx'
import type { Booking } from './api.ts'
import { formatDate, formatTimeRange, offsetLabel, zoneName } from './time.ts'

export const LOCATION_LABELS: Record<string, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  microsoft_teams: 'Microsoft Teams',
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

function bookingLocationUrl(location: NonNullable<Booking['location']>): string | undefined {
  switch (location.kind) {
    case 'microsoft_teams':
      return location.status === 'ready'
        ? displayConferenceUrl(location.kind, location.url)
        : undefined
    case 'google_meet':
    case 'zoom':
      return displayConferenceUrl(location.kind, location.url)
    default:
      return safeUrl(location.url)
  }
}

/** Where a booked meeting happens, with the details the booking reveals (number, address, link). */
export function LocationDetails({
  location,
  cancelled = false,
}: {
  location: Booking['location']
  cancelled?: boolean
}) {
  const { t, ui } = useI18n()

  if (!location)
    return <>{t('No location has been specified. Contact the host for meeting details.')}</>
  if (location.kind === 'microsoft_teams') {
    const url = !cancelled && bookingLocationUrl(location)
    return (
      <>
        {t('Microsoft Teams')}
        {url ? (
          <>
            {t(': ')}
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t('Join Microsoft Teams')}
            </a>
          </>
        ) : !cancelled && location.status === 'join_url_pending' ? (
          <p>{t('The Teams link isn’t ready yet.')}</p>
        ) : !cancelled &&
          (location.status === 'teams_unavailable' || location.status === 'writeback_failed') ? (
          <p>{t('The booking is still scheduled without a Teams link.')}</p>
        ) : null}
      </>
    )
  }
  const url = bookingLocationUrl(location)
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
  const link = bookingLocationUrl(location)
  const detail =
    location.kind === 'microsoft_teams'
      ? link
      : [location.number, location.address, link].find(
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
