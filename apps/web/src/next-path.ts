// Where to send someone after they sign in. The destination arrives in the URL
// (/sign-in?next=…), which anyone can craft, so only paths on this site are accepted:
// anything else would make the sign-in page an open redirect.

const HOME = '/'
const SIGN_IN = '/sign-in'
// Any origin works for resolving: only the path, query and fragment are kept.
const BASE = 'https://app.invalid'

/**
 * `raw` if it is a path on this site (normalized), else the start page. Refuses
 * protocol-relative and backslash forms (`//host`, `/\host`, which browsers treat as other
 * sites), absolute URLs, control characters and whitespace (which browsers drop, possibly
 * turning a harmless-looking value into one of the above), and the sign-in page itself.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//')) return HOME
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) return HOME
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return HOME
  }
  // Normalizing can produce `//` again, e.g. from `/.//host`.
  if (url.origin !== BASE || url.pathname === SIGN_IN || url.pathname.startsWith('//')) return HOME
  return url.pathname + url.search + url.hash
}

/** The sign-in page, remembering `path` (pathname plus query) to come back to. */
export function signInPath(path: string): string {
  const next = safeNextPath(path)
  return next === HOME ? SIGN_IN : `${SIGN_IN}?next=${encodeURIComponent(next)}`
}
