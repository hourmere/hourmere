import { displayConferenceUrl } from '../../core/src/conference-url.ts'
import { cleanText, isSingleLineText } from '../../scheduling/src/text.ts'
import { record } from './questions.ts'
import type { PlanProblem, SourceRow } from './types.ts'

export type StaticLocation =
  | { kind: 'link'; url: string }
  | { kind: 'phone'; number: string }
  | { kind: 'in_person'; address: string }

const PHONE = /^\+[1-9][0-9]{6,14}$/
const forbiddenParameters = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'code',
  'zak',
  'host_key',
  'hostkey',
  'oauth_token',
  'api_key',
  'apikey',
  'password',
])
const joinPasscodes = new Set(['pwd', 'passcode', 'pin'])

/** Pure validation: this never requests the URL or follows a redirect. */
export function safeMeetingUrl(value: unknown, publicConfiguration = false): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2000 ||
    !isSingleLineText(value) ||
    /[\s\\]/.test(value)
  )
    return null
  try {
    const url = new URL(value)
    const path = decodeURIComponent(url.pathname).toLowerCase()
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.href.length > 2000
    )
      return null
    if (/(?:^|\/)(?:admin|login|signin|sign-in|oauth|oauth2|authorize|start|s)(?:\/|$)/i.test(path))
      return null
    if (/^(?:accounts\.(?:google|microsoft)\.com|login\.microsoftonline\.com)$/i.test(url.hostname))
      return null
    for (const key of url.searchParams.keys()) {
      const normalized = key.toLowerCase()
      if (
        forbiddenParameters.has(normalized) ||
        (publicConfiguration && joinPasscodes.has(normalized))
      )
        return null
    }
    if (url.hash) {
      const fragment = decodeURIComponent(url.hash.slice(1))
      if (/(?:token|password|oauth|access_token|zak)=/i.test(fragment)) return null
      if (publicConfiguration && /(?:^|[?&;])(?:pwd|passcode|pin)=/i.test(fragment)) return null
    }
    return value
  } catch {
    return null
  }
}

function staticLocation(raw: SourceRow, publicConfiguration: boolean): StaticLocation | null {
  if (raw.type === 'inPerson' || raw.kind === 'in_person') {
    const address = cleanText(raw.address, { max: 500 })
    return address ? { kind: 'in_person', address } : null
  }
  if (raw.type === 'userPhone' || raw.kind === 'phone') {
    const number = raw.hostPhoneNumber ?? raw.number
    return typeof number === 'string' && PHONE.test(number) ? { kind: 'phone', number } : null
  }
  if (raw.type === 'link' || raw.kind === 'link') {
    const url = safeMeetingUrl(raw.link ?? raw.url, publicConfiguration)
    return url ? { kind: 'link', url } : null
  }
  return null
}

export function parseEventLocation(
  event: SourceRow,
  problems: PlanProblem[],
): StaticLocation | null {
  const add = (code: string, message: string) =>
    problems.push({
      code,
      severity: 'activation_blocker',
      source: { table: 'EventType', id: event.id as number },
      message,
    })
  if (event.unsafeLocation === true) {
    add(
      'location_unsafe_source',
      'An unsafe source location URL was removed during extraction; choose a new location before activation.',
    )
    return null
  }
  if (event.locations == null || (Array.isArray(event.locations) && event.locations.length === 0)) {
    add('location_missing', 'The event location must be reviewed before activation.')
    return null
  }
  if (
    !Array.isArray(event.locations) ||
    event.locations.length !== 1 ||
    !record(event.locations[0])
  ) {
    add(
      'location_choice',
      'Multiple or unrecognized source locations require an explicit choice before activation.',
    )
    return null
  }
  const location = event.locations[0]
  if (location.type === 'phone') {
    add(
      'location_booker_phone',
      'The source location asks for the booker phone; choose a location and review a separate phone question before activation.',
    )
    return null
  }
  if (
    typeof location.type === 'string' &&
    (location.type.startsWith('integrations:') ||
      ['conferencing', 'hostDefault'].includes(location.type))
  ) {
    add(
      'location_provider_reconnect',
      'The source location requires a fresh provider connection and an explicit location choice; no meeting will be created.',
    )
    return null
  }
  if (location.displayLocationPublicly !== true) {
    add(
      'location_private',
      'The source location is private and is omitted from public event configuration until its owner approves disclosure.',
    )
    return null
  }
  const result = staticLocation(location, true)
  if (!result)
    add(
      'location_invalid',
      'The static location is invalid or contains a capability that cannot be published.',
    )
  return result
}

const referenceTypes = new Set([
  'google_video',
  'zoom_video',
  'daily_video',
  'office365_video',
  'google_calendar',
  'office365_calendar',
])

/** Returns a protected existing location, never a conference creation instruction. */
export function parseBookingLocation(
  booking: SourceRow,
  references: SourceRow[],
  problems: PlanProblem[],
  acceptMissing = false,
  sourceEvent?: SourceRow,
): StaticLocation | null {
  const add = (code: string, severity: PlanProblem['severity'], message: string) =>
    problems.push({
      code,
      severity,
      source: { table: 'Booking', id: booking.id as number },
      message,
    })
  if (booking.unsafeLocation === true) {
    add(
      'booking_location_unsafe',
      'import_blocker',
      'An unsafe source location URL was removed during extraction; importing without a location cannot override this protection.',
    )
    return null
  }
  const raw = booking.location
  let direct: StaticLocation | null = null
  if (raw != null && typeof raw !== 'string') {
    add(
      'booking_location_shape',
      'import_blocker',
      'The source booking location must use the audited text column shape.',
    )
    return null
  }
  const responseLocation =
    record(booking.responses) && record(booking.responses.location)
      ? booking.responses.location
      : null
  if (
    typeof raw === 'string' &&
    responseLocation &&
    ['inPerson', 'userPhone', 'phone'].includes(responseLocation.value as string)
  ) {
    if (
      typeof responseLocation.optionValue !== 'string' ||
      (responseLocation.optionValue !== '' && responseLocation.optionValue !== raw)
    ) {
      add(
        'booking_location_response_conflict',
        'import_blocker',
        'The historical location response and stored booking location disagree.',
      )
      return null
    }
    if (responseLocation.value === 'phone') {
      add(
        'booking_location_booker_phone',
        acceptMissing ? 'warning' : 'import_blocker',
        'The source location is the booker phone and is not treated as the host telephone; importing it without a location requires an explicit owner decision.',
      )
      return null
    } else {
      direct = staticLocation(
        { type: responseLocation.value, address: raw, hostPhoneNumber: raw },
        false,
      )
      if (!direct) {
        add(
          'booking_location_invalid_static',
          'import_blocker',
          'The historically typed static booking location fails target text or telephone validation.',
        )
        return null
      }
    }
  }
  if (
    !direct &&
    typeof raw === 'string' &&
    Array.isArray(sourceEvent?.locations) &&
    sourceEvent.locations.length === 1 &&
    record(sourceEvent.locations[0])
  ) {
    const candidate = staticLocation(sourceEvent.locations[0], false)
    if (
      candidate &&
      ((candidate.kind === 'in_person' && candidate.address === raw) ||
        (candidate.kind === 'phone' && candidate.number === raw))
    )
      direct = candidate
  }
  if (!direct && typeof raw === 'string') {
    const url = safeMeetingUrl(raw)
    if (url) direct = { kind: 'link', url }
    else if (/^https?:/i.test(raw)) {
      add(
        'booking_location_unsafe',
        'import_blocker',
        'A source booking URL is invalid or contains a host or authentication capability.',
      )
      return null
    }
  }
  if (direct) return direct
  const usable: string[] = []
  let ambiguous = false
  for (const ref of references.filter((r) => r.bookingId === booking.id)) {
    if (ref.deleted !== null) {
      if (ref.deleted !== true) ambiguous = true
      continue
    }
    if (typeof ref.type !== 'string' || !referenceTypes.has(ref.type)) {
      ambiguous = true
      continue
    }
    if (ref.unsafeMeetingUrl === true) {
      ambiguous = true
      continue
    }
    // Calendar writes also create references without a conference URL. They are
    // not candidate meeting links and do not conflict with a video reference.
    if (['google_calendar', 'office365_calendar'].includes(ref.type) && ref.meetingUrl === null)
      continue
    const url = safeMeetingUrl(ref.meetingUrl)
    const parsed = url ? new URL(url) : null
    const providerJoin =
      url &&
      (ref.type === 'zoom_video'
        ? displayConferenceUrl('zoom', url)
        : ['google_video', 'google_calendar'].includes(ref.type)
          ? displayConferenceUrl('google_meet', url)
          : ref.type === 'daily_video'
            ? parsed?.protocol === 'https:' &&
              /^[a-z0-9-]+\.daily\.co$/.test(parsed.hostname) &&
              !parsed.search &&
              !parsed.hash
            : parsed?.protocol === 'https:' &&
              ['teams.microsoft.com', 'teams.live.com'].includes(parsed.hostname) &&
              /^\/(?:l\/meetup-join|meet)\//.test(parsed.pathname))
    if (!url || !providerJoin) {
      ambiguous = true
      continue
    }
    if (!usable.includes(url)) usable.push(url)
  }
  if (ambiguous || usable.length > 1) {
    add(
      'booking_location_reference',
      'import_blocker',
      'Booking reference locations have an unknown state, unknown provider, unsafe URL or conflicting links.',
    )
    return null
  }
  if (usable.length === 1) return { kind: 'link', url: usable[0] as string }
  add(
    'booking_location_missing',
    acceptMissing ? 'warning' : 'import_blocker',
    acceptMissing
      ? 'The owner explicitly accepted importing this booking without a location.'
      : 'The existing booking location could not be resolved and requires an explicit owner decision.',
  )
  return null
}
