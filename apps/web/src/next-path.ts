// Where to send someone after they sign in. The destination arrives in the URL
// (/sign-in?next=…), which anyone can craft, so only the app's own signed-in pages are
// accepted: anything else would make the sign-in page an open redirect, or send people to a
// page that only looks like part of the app (a public booking page at /{handle}/{slug}).
import { APP_BASE, PATHS } from './paths.ts'

const HOME = PATHS.home
const SIGN_IN = PATHS.signIn
// Any origin works for resolving: only the path, query and fragment are kept.
const BASE = 'https://app.invalid'
// Far beyond any page of the app; a longer value is not worth carrying through sign-in.
const MAX_LENGTH = 2048

/** Whether `pathname` (normalized) is a signed-in page: /app or below it. */
const isAppPage = (pathname: string) => pathname === APP_BASE || pathname.startsWith(`${APP_BASE}/`)

/**
 * `raw` if it is a signed-in page of this app (/app or below, normalized), else the default
 * page. Refuses anything outside /app: other sites (absolute URLs, protocol-relative and
 * backslash forms such as `//host` and `/\host`), the sign-in pages, the API, public booking
 * pages and old top-level app addresses. Also refuses control characters and whitespace
 * (which browsers drop, possibly turning a harmless-looking value into one of the above).
 *
 * Also refuses what Better Auth would refuse as a callbackURL, so a crafted link cannot
 * make sign-in fail: encoded separators (`%2F`, `%5C`) in the path. And overlong values.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.length > MAX_LENGTH) return HOME
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) return HOME
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return HOME
  }
  const { pathname } = url
  // Normalizing resolves dot segments first, so `/app/../api` is checked as `/api`.
  if (url.origin !== BASE || !isAppPage(pathname) || /%2f|%5c/i.test(pathname)) return HOME
  // Normalizing percent-encodes some characters, which can make the value longer.
  const path = pathname + url.search + url.hash
  return path.length > MAX_LENGTH ? HOME : path
}

/** The sign-in page, remembering `path` (pathname plus query) to come back to. */
export function signInPath(path: string): string {
  const next = safeNextPath(path)
  return next === HOME ? SIGN_IN : `${SIGN_IN}?next=${encodeURIComponent(next)}`
}
