// Names that nobody may claim as the first segment of a public URL. Booking pages live at
// the root of the web app (/{handle}, /{handle}/{slug}), beside the app's own pages, the API
// and static files, so a handle (or, later, a team's slug) must never shadow one of those or
// pass for an official page such as /support or /security.
//
// The list is checked case-insensitively. Most entries cannot match the handle pattern anyway
// (dots), but listing every top-level path the server or the web app answers keeps this the
// one place to look. When the web app or the server gets a new top-level path, add it here
// (apps/web/src/public/routes.test.tsx checks the app's navigation against this list).

/** Lowercase names reserved as the first path segment; see isReservedName. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // The web app's own pages: the signed-in app (moving under /app), sign-in, the invitee's
  // manage page, and today's top-level app routes.
  'app',
  'booking',
  'bookings',
  'event-types',
  'availability',
  'api-keys',
  'settings',
  'sign-in',
  'sign-up',
  'sign-out',
  'signin',
  'signup',
  'signout',
  'login',
  'logout',
  'register',
  'account',
  'accounts',
  'admin',
  'dashboard',
  'billing',
  'integrations',
  'calendar',
  'calendars',
  'invite',
  'invitations',
  'join',
  'team',
  'teams',
  'org',
  'orgs',
  'organizations',
  'new',
  'embed',
  'unsubscribe',
  'verify',
  // Server paths: the API, Better Auth, the MCP endpoint, the web app's bundles.
  'api',
  'auth',
  'oauth',
  'mcp',
  'assets',
  'static',
  'public',
  'well-known',
  '.well-known',
  // Static files at the root.
  'favicon.ico',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
  'robots.txt',
  'sitemap.xml',
  'index.html',
  // Pages people expect from the product itself.
  'about',
  'blog',
  'changelog',
  'contact',
  'docs',
  'developers',
  'help',
  'hourmere',
  'legal',
  'pricing',
  'privacy',
  'security',
  'status',
  'support',
  'terms',
  't',
  'www',
])

/** Whether `name` is reserved (case-insensitively), e.g. `Admin` or `SIGN-IN`. */
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase())
}
