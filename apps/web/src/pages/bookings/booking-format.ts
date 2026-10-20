import { displayConferenceUrl } from '@hourmere/core/conference-url'
// How bookings read: their location and answers, and the host's time zone they are shown in.
import type { Booking, Profile } from '../../api/resources.ts'
import { browserTimeZone } from '../../format.ts'
import { formatList } from '../../i18n/formatting.ts'
import { literal, msg, type UiText } from '../../i18n/translate.ts'

/** Localize only a verified generated title; retain custom and historical titles verbatim. */
export function bookingTitle(booking: Booking): UiText {
  const invitee = booking.attendees.find((attendee) => attendee.isBooker)
  const event = booking.eventTypeTitle
  if (!invitee || !event || booking.title !== `${event} with ${invitee.name}`)
    return literal(booking.title)
  return msg('{event} with {host}', { event, host: invitee.name })
}

/** Mutation responses omit host-read metadata; keep it only for the same booking. */
export function bookingUpdate(current: Booking, updated: Booking): Booking {
  return current.id === updated.id &&
    updated.eventTypeTitle === undefined &&
    current.eventTypeTitle !== undefined
    ? { ...updated, eventTypeTitle: current.eventTypeTitle }
    : updated
}

/** The zone bookings are shown in: the profile's, else the browser's. */
export function hostZone(profile: Profile | null): { timeZone: string; fromProfile: boolean } {
  return profile
    ? { timeZone: profile.timeZone, fromProfile: true }
    : { timeZone: browserTimeZone(), fromProfile: false }
}

const LOCATION_LABELS: Record<string, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  phone: 'Phone call',
  in_person: 'In person',
  link: 'Online meeting',
}

export interface LocationView {
  label: string
  /** The number, address or link, when the booking has one. */
  detail: string | null
  /** A link to open, for urls and phone numbers. */
  href: string | null
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)

/** Only http(s) links are made clickable; anything else is shown as text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

export function describeLocation(location: Booking['location']): LocationView | null {
  if (!location) return null
  const label = LOCATION_LABELS[location.kind] ?? location.kind
  const number = str(location.number)
  const address = str(location.address)
  const url =
    location.kind === 'google_meet' || location.kind === 'zoom'
      ? (displayConferenceUrl(location.kind, location.url) ?? null)
      : str(location.url)
  if (location.kind === 'phone' && number) {
    return { label, detail: number, href: `tel:${number.replace(/[^+0-9]/g, '')}` }
  }
  if (location.kind === 'in_person' && address) return { label, detail: address, href: null }
  if (url) return { label, detail: url, href: safeHref(url) }
  return { label, detail: null, href: null }
}

export const SOURCE_LABELS: Record<Booking['source'], string> = {
  web: 'the booking page',
  embed: 'an embedded booking page',
  api: 'an agent or script (API)',
  mcp: 'an AI agent (MCP)',
}

/** An answer as text: options joined, checkboxes as Yes or No. */
export function answerText(
  value: string | string[] | boolean | undefined,
  locale = 'en',
): string | null {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? formatList(value, locale) : null
  return value.trim() ? value : null
}
