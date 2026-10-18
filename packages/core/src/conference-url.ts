// Fixed commercial Zoom web hosts documented in Zoom support KB0078410. Vanity and
// government domains need a separately reviewed policy; no suffix/wildcard acceptance.
const JOIN_HOSTS = new Set([
  'zoom.us',
  'au01web.zoom.us',
  'ca01web.zoom.us',
  'eu01web.zoom.us',
  'in01web.zoom.us',
  'us02web.zoom.us',
  'us04web.zoom.us',
  'us05web.zoom.us',
  'us06web.zoom.us',
  'us07web.zoom.us',
  'eu02web.zoom.us',
  'sa01web.zoom.us',
  'dg01web.zoom.us',
  'sg01web.zoom.us',
  'uk01web.zoom.us',
])
/** Canonical positive decimal, bounded to a safely representable 15-digit resource ID. */
export function zoomMeetingId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const id = String(value)
  return /^[1-9][0-9]{0,14}$/.test(id) ? id : null
}
/** This URL is a participant capability. It must never be logged or put in a public catalog. */
export function zoomJoinUrl(value: unknown, meetingId: string): string | null {
  if (typeof value !== 'string' || value.length > 1024 || !/^[\x21-\x7e]+$/.test(value)) return null
  if (zoomMeetingId(meetingId) !== meetingId) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !JOIN_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.pathname !== `/j/${meetingId}` ||
      url.href !== value
    )
      return null
    const keys = [...url.searchParams.keys()]
    if (keys.length > 1 || keys.some((key) => key !== 'pwd')) return null
    if (keys.length && !/^[A-Za-z0-9_.~-]{1,128}$/.test(url.searchParams.get('pwd') ?? ''))
      return null
    // Refuse alternate encodings and dangling query delimiters as well as extra capabilities.
    const expected = `https://${url.hostname}/j/${meetingId}${keys.length ? `?pwd=${url.searchParams.get('pwd')}` : ''}`
    return value === expected ? expected : null
  } catch {
    return null
  }
}

export function googleMeetUrl(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 200 &&
    /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value)
    ? value
    : undefined
}
export function conferenceJoinUrl(
  provider: string,
  value: unknown,
  meetingId?: string | null,
): string | undefined {
  return provider === 'google_meet'
    ? googleMeetUrl(value)
    : provider === 'zoom' && meetingId
      ? (zoomJoinUrl(value, meetingId) ?? undefined)
      : undefined
}

/** Presentation only: validating a participant link does not adopt a meeting identity. */
export function displayConferenceUrl(provider: string, value: unknown): string | undefined {
  if (provider === 'google_meet') return googleMeetUrl(value)
  if (provider !== 'zoom' || typeof value !== 'string') return undefined
  try {
    const id = zoomMeetingId(new URL(value).pathname.split('/').at(-1))
    return id ? (zoomJoinUrl(value, id) ?? undefined) : undefined
  } catch {
    return undefined
  }
}
