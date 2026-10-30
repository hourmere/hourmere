// Test support: the network boundary (fetch) replaced by scripted answers, and the app
// rendered at a given address.
import { act, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { vi } from 'vitest'
import { App } from '../App.tsx'
import type { Schemas } from '../api/client.ts'
import { recordUnexpectedRequest } from './unexpected-requests.ts'

export interface Call {
  method: string
  /** Pathname plus query. */
  path: string
  /** The parsed JSON body, if any. */
  body: unknown
  headers: Headers
}

export type Handler = (call: Call) => Response | Promise<Response>

/** `"GET /api/v1/me"` (method and pathname, no query) → answer. */
export type Routes = Record<string, Handler>

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Replaces fetch for the current test (setup.ts restores it). A request to a route that is
 * not listed fails like a network error and then fails the test, so every call is deliberate.
 */
export function fakeApi(routes: Routes) {
  // Public layouts discover the hosted service destination independently of sessions.
  const scripted: Routes = {
    'GET /api/v1/instance': () =>
      json(200, {
        hostedSignupUrl: 'https://hourmere.com',
        signIn: { email: true, google: false, microsoft: false },
      }),
    // The shared admin frame discovers team choices and the active membership. Tests
    // with no team fixtures start with no listed teams and an unavailable role.
    'GET /api/auth/organization/list': () => json(200, []),
    'GET /api/auth/organization/get-active-member': () => json(404, { code: 'MEMBER_NOT_FOUND' }),
    ...routes,
  }
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(new URL(String(input), location.origin), init)
    const url = new URL(request.url)
    const text = await request.text()
    const call = {
      method: request.method,
      path: url.pathname + url.search,
      body: text ? JSON.parse(text) : undefined,
      headers: request.headers,
    }
    calls.push(call)
    const route = `${request.method} ${url.pathname}`
    const handler = Object.hasOwn(scripted, route) ? scripted[route] : undefined
    if (!handler) {
      recordUnexpectedRequest(`${request.method} ${call.path}`)
      throw new TypeError('Failed to fetch')
    }
    return handler(call)
  })
  vi.stubGlobal('fetch', fetch)
  return {
    calls,
    /** The calls to one route, e.g. `to('POST /api/auth/api-key/create')`. */
    to: (route: string) => calls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === route),
  }
}

export const ME: Schemas['Me'] = {
  user: { id: '00000000-0000-7000-8000-000000000001', name: 'Ada', email: 'ada@example.com' },
  personalOrganizationId: '00000000-0000-7000-8000-000000000002',
  organization: {
    id: '00000000-0000-7000-8000-000000000002',
    name: 'Ada',
    slug: 'ada',
    personal: true,
  },
  principal: { kind: 'session', apiKeyId: null },
}

export const signedInAs = (me: Schemas['Me']): Routes => ({
  'GET /api/v1/instance': () =>
    json(200, {
      automaticGoogleMeet: false,
      signIn: { email: true, google: false, microsoft: false },
    }),
  'GET /api/v1/me': () => json(200, me),
  'GET /api/auth/organization/get-active-member': () =>
    json(200, {
      id: 'membership-1',
      organizationId: me.organization.id,
      userId: me.user.id,
      role: 'owner',
      createdAt: '2026-10-01T09:00:00.000Z',
    }),
  // Existing page tests make no readiness claim unless they supply explicit event summaries.
  'GET /api/v1/readiness/self': () =>
    json(200, {
      member: { subject: { kind: 'member', organizationId: me.organization.id } },
      eventTypes: { data: [], nextCursor: null },
    }),
  [`GET /api/v1/teams/${me.organization.id}/readiness`]: () =>
    json(200, {
      organizationId: me.organization.id,
      members: { data: [], nextCursor: null },
      eventTypes: { data: [], nextCursor: null },
    }),
  'GET /api/v1/profile': () => json(404, { error: 'profile_not_found' }),
  [`GET /api/v1/teams/${me.organization.id}/member-readiness`]: () =>
    json(200, { organizationId: me.organization.id, members: [] }),
})
export const signedIn = signedInAs(ME)
/** Opt in when a scenario opens team settings but makes no claims about either list. */
export const emptyTeamLists: Routes = {
  'GET /api/auth/organization/list-members': () => json(200, { members: [], total: 0 }),
  'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
}
/** Better Auth's list of the signed-in user's organizations. */
export const organizations = (
  list: { id: string; name: string }[] = [ME.organization],
): Routes => ({
  'GET /api/auth/organization/list': () => json(200, list),
})
/**
 * A response the test sends when it chooses: hand `response` to a route, then `answer` it,
 * e.g. after the person has moved on to another page.
 */
export function later() {
  let answer: (response: Response) => void = () => {}
  const response = new Promise<Response>((resolve) => {
    answer = resolve
  })
  return {
    response,
    /** Sends the answer and lets the page take it in. */
    answer: (value: Response) =>
      act(async () => {
        answer(value)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }),
  }
}

/** Ada's profile: her handle in booking links, her time zone and language. */
export const PROFILE: Schemas['Profile'] = {
  handle: 'ada',
  timeZone: 'Europe/Berlin',
  locale: 'en',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
}

export const profile = (value: Schemas['Profile'] | null = PROFILE): Routes => ({
  'GET /api/v1/profile': () =>
    value
      ? json(200, value)
      : json(404, {
          error: 'profile_not_found',
          message: 'Create a profile with PUT /api/v1/profile',
        }),
})

/**
 * What the admin pages read for an account with nothing set up yet: no profile, no
 * schedules, no event types.
 */
export const emptyAccount: Routes = {
  ...profile(null),
  'GET /api/v1/schedules': () => json(200, { data: [] }),
  'GET /api/v1/event-types': () => json(200, { data: [] }),
}

export const signedOut: Routes = {
  'GET /api/v1/me': () => json(401, { error: 'unauthorized' }),
}
export const instance = (providers: { google?: boolean; microsoft?: boolean } = {}): Routes => ({
  'GET /api/v1/instance': () =>
    json(200, {
      signIn: {
        email: true,
        google: providers.google ?? false,
        microsoft: providers.microsoft ?? false,
      },
    }),
})

/** Shows the router's current address, so tests can check redirects. */
function CurrentLocation() {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{pathname + search}</output>
}

/** Renders the whole app as if the browser had opened `path`. */
export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <CurrentLocation />
    </MemoryRouter>,
  )
}
