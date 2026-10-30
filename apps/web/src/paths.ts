// Addresses of the app's pages. Signed-in pages live under /app; the root belongs to public
// booking pages (/{handle}/{slug}), and /sign-in stays where it is.

export const APP_BASE = '/app'

export const PATHS = {
  /** The default signed-in page (/app redirects there). */
  home: APP_BASE,
  join: `${APP_BASE}/join`,
  eventTypes: `${APP_BASE}/event-types`,
  newEventType: `${APP_BASE}/event-types/new`,
  availability: `${APP_BASE}/availability`,
  newSchedule: `${APP_BASE}/availability/new`,
  bookings: `${APP_BASE}/bookings`,
  teamBookings: `${APP_BASE}/team/bookings`,
  analytics: `${APP_BASE}/analytics`,
  conferences: `${APP_BASE}/conferences`,
  calendars: `${APP_BASE}/calendars`,
  connectedApps: `${APP_BASE}/connected-apps`,
  apiKeys: `${APP_BASE}/api-keys`,
  settings: `${APP_BASE}/settings`,
  newTeam: `${APP_BASE}/teams/new`,
  signIn: '/sign-in',
} as const

export const eventTypePath = (id: string) => `${PATHS.eventTypes}/${encodeURIComponent(id)}`
export const schedulePath = (id: string) => `${PATHS.availability}/${encodeURIComponent(id)}`
export const bookingPath = (id: string) => `${PATHS.bookings}/${encodeURIComponent(id)}`

/** The public booking page of a personal event type, as a full URL to share. */
export const publicPageUrl = (handle: string, slug: string) =>
  `${window.location.origin}/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`

/** A single-host team event in a separate namespace from personal handles. */
export const publicTeamPageUrl = (teamSlug: string, slug: string) =>
  `${window.location.origin}/team/${encodeURIComponent(teamSlug)}/${encodeURIComponent(slug)}`

export const TEAM_LINK_SLUG_HINT =
  'Choose a non-reserved team slug of 1–64 letters, numbers or hyphens, starting and ending with a letter or number.'
