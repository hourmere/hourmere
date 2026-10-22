import { isKnownTimeZone } from '../format.ts'

const STORAGE_KEY = 'hourmere-visitor-time-zone'

/** A visitor's explicit choice takes precedence over automatic or booking defaults. */
export function visitorTimeZone(fallback: string): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && isKnownTimeZone(saved)) return saved
  } catch {
    // Storage may be unavailable in private windows or embedded pages.
  }
  return fallback
}

/** Call only for an explicit picker choice, never for automatic zone detection. */
export function rememberVisitorTimeZone(timeZone: string): void {
  if (!isKnownTimeZone(timeZone)) return
  try {
    localStorage.setItem(STORAGE_KEY, timeZone)
  } catch {
    // The current page can still use the choice when storage is blocked.
  }
}
