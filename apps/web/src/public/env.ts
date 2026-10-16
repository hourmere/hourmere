// What the public pages learn from the browser: the visitor's time zone and language, and the
// zones they can pick from. A module of its own so tests can replace it.

/** The visitor's IANA time zone, as the browser reports it; UTC if it cannot tell. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The visitor's preferred language (BCP 47), for formatting dates and times. */
export function preferredLocale(): string {
  const candidate = navigator.languages?.[0] ?? navigator.language ?? 'en'
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

/** Every IANA time zone the browser knows, plus UTC (which some browsers leave out). */
export function availableTimeZones(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return zones.includes('UTC') ? [...zones] : [...zones, 'UTC']
}

/** The current time in milliseconds. */
export function now(): number {
  return Date.now()
}
