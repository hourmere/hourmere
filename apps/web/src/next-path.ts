// Where to send someone after they sign in. The destination arrives in the URL
// (/sign-in?next=…), which anyone can craft, so only paths on this site are accepted:
// anything else would make the sign-in page an open redirect.

const HOME = '/'
const SIGN_IN = '/sign-in'
// Any origin works for resolving: only the path, query and fragment are kept.
const BASE = 'https://app.invalid'
// Far beyond any page of the app; a longer value is not worth carrying through sign-in.
const MAX_LENGTH = 2048

/**
 * `raw` if it is a page of this app (normalized), else the start page. Refuses
 * protocol-relative and backslash forms (`//host`, `/\host`, which browsers treat as other
 * sites), absolute URLs, control characters and whitespace (which browsers drop, possibly
 * turning a harmless-looking value into one of the above), and the sign-in page itself.
 *
 * Also refuses what Better Auth would refuse as a callbackURL, so a crafted link cannot
 * make sign-in fail: encoded separators (`%2F`, `%5C`) in the path. And paths under /api/,
 * which are the API rather than pages, and overlong values.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.length > MAX_LENGTH) return HOME
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(raw)) return HOME
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return HOME
  }
  const { pathname } = url
  if (
    url.origin !== BASE ||
    pathname === SIGN_IN ||
    // Normalizing can produce `//` again, e.g. from `/.//host`.
    pathname.startsWith('//') ||
    /%2f|%5c/i.test(pathname) ||
    /^\/api(\/|$)/.test(pathname)
  ) {
    return HOME
  }
  // Normalizing percent-encodes some characters, which can make the value longer.
  const path = pathname + url.search + url.hash
  return path.length > MAX_LENGTH ? HOME : path
}

/** The sign-in page, remembering `path` (pathname plus query) to come back to. */
export function signInPath(path: string): string {
  const next = safeNextPath(path)
  return next === HOME ? SIGN_IN : `${SIGN_IN}?next=${encodeURIComponent(next)}`
}
