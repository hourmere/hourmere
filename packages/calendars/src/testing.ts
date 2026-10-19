import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { createGoogleCalendarClient, GOOGLE_CALENDAR_SCOPES } from './google.ts'
import { createMicrosoftCalendarClient } from './microsoft.ts'

export const TEST_CALENDAR_KEY = Buffer.alloc(32, 7).toString('base64')
export const TEST_PUBLIC_URL = 'http://localhost:5173'
export async function calendarTestSession(
  db: Db,
): Promise<Extract<Principal, { kind: 'session' }>> {
  const user = await createTestUser(db)
  const session = await db
    .insertInto('auth.session')
    .values({
      userId: user.id,
      token: randomUUID(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return {
    kind: 'session',
    sessionId: session.id,
    user: user.principal.user,
    organization: user.principal.organization,
  }
}

/** Fake credentials only. Exercises the real provider adapter, HTTP parsing and pagination. */
export function fakeGoogle() {
  const controls = {
    token: {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    } as Record<string, unknown>,
    tokenStatus: 200,
    tokenError: 'invalid_grant',
    tokenHook: undefined as (() => Promise<Response>) | undefined,
    identity: {
      sub: 'google-account-1',
      email: 'calendar@example.com',
      email_verified: true,
    } as Record<string, unknown>,
    pages: [
      {
        items: [
          {
            id: 'primary-calendar',
            summary: 'My calendar',
            primary: true,
            accessRole: 'owner',
            timeZone: 'America/Los_Angeles',
          },
        ],
      },
    ] as Record<string, unknown>[],
    listStatus: 200,
    listHook: undefined as ((url: URL) => Promise<Response>) | undefined,
    eventPages: [{ items: [], nextSyncToken: 'cursor-1' }] as Record<string, unknown>[],
    eventStatus: 200,
    eventPatchStatus: 200,
    eventHook: undefined as ((url: URL, init: RequestInit) => Promise<Response>) | undefined,
    storedEvents: new Map<string, Record<string, unknown>>(),
    conferencePollsBeforeReady: 1,
    conferenceOutcome: 'success' as 'success' | 'failure',
    conferenceRequests: new Map<
      string,
      { eventId: string; polls: number; patched: boolean; outcome?: 'success' | 'failure' }
    >(),
  }
  // Google accepts createRequest on import but never processes it. Only a PATCH
  // starts conference creation; replaying its request ID does not restart progress.
  const conferenceFor = (value: Record<string, unknown>, poll = false) => {
    const data = value.conferenceData as { createRequest?: { requestId?: string } } | undefined
    const requestId = data?.createRequest?.requestId
    const request = requestId ? controls.conferenceRequests.get(requestId) : undefined
    if (!request) return value
    if (poll && request.patched) request.polls++
    if (request.patched && request.polls >= controls.conferencePollsBeforeReady)
      request.outcome ??= controls.conferenceOutcome
    const status = request.outcome ?? 'pending'
    return {
      ...value,
      conferenceData: {
        createRequest: { ...data?.createRequest, status: { statusCode: status } },
        ...(status === 'success'
          ? {
              conferenceSolution: { key: { type: 'hangoutsMeet' } },
              entryPoints: [
                { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
              ],
            }
          : {}),
      },
    }
  }
  const calls: { url: URL; init: RequestInit }[] = []
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.href === 'https://oauth2.googleapis.com/token') {
      if (controls.tokenHook) return controls.tokenHook()
      return Response.json(
        controls.tokenStatus === 200
          ? controls.token
          : { ...controls.token, error: controls.token.error ?? controls.tokenError },
        {
          status: controls.tokenStatus,
        },
      )
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo')
      return Response.json(controls.identity)
    if (
      url.origin === 'https://www.googleapis.com' &&
      url.pathname === '/calendar/v3/users/me/calendarList'
    ) {
      if (controls.listHook) return controls.listHook(url)
      const page = Number(url.searchParams.get('pageToken') ?? '0')
      return Response.json(controls.pages[page] ?? {}, { status: controls.listStatus })
    }
    if (url.origin === 'https://www.googleapis.com' && url.pathname.includes('/events')) {
      if (controls.eventHook) return controls.eventHook(url, init)
      if (init.method === 'POST') {
        const value = JSON.parse(String(init.body))
        const stored = { ...value, id: `event-${controls.storedEvents.size + 1}`, etag: '"v1"' }
        const requestId = value.conferenceData?.createRequest?.requestId
        if (requestId)
          controls.conferenceRequests.set(requestId, {
            eventId: stored.id,
            polls: 0,
            patched: false,
          })
        const result = conferenceFor(stored)
        controls.storedEvents.set(stored.id, result)
        return Response.json(result)
      }
      if (init.method === 'PATCH') {
        if (controls.eventPatchStatus !== 200)
          return Response.json({}, { status: controls.eventPatchStatus })
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        const prior = controls.storedEvents.get(id)
        if (!prior) return Response.json({}, { status: 404 })
        const patch = JSON.parse(String(init.body))
        const requestId = patch.conferenceData?.createRequest?.requestId
        if (requestId) {
          const request = controls.conferenceRequests.get(requestId)
          if (request && request.eventId !== id) return Response.json({}, { status: 409 })
          if (request) request.patched = true
          else controls.conferenceRequests.set(requestId, { eventId: id, polls: 0, patched: true })
        }
        const stored = conferenceFor({ ...prior, ...patch, etag: '"v2"' })
        controls.storedEvents.set(id, stored)
        return Response.json(stored)
      }
      if (url.searchParams.has('iCalUID'))
        return Response.json({
          items: [...controls.storedEvents.values()]
            .filter(
              (e) =>
                e.iCalUID === url.searchParams.get('iCalUID') &&
                (e.status !== 'cancelled' || url.searchParams.get('showDeleted') === 'true'),
            )
            .map((value) => conferenceFor(value, true)),
        })
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      if (id !== 'events') {
        const stored = controls.storedEvents.get(id)
        if (!stored) return Response.json({}, { status: 404 })
        const result = conferenceFor(stored, true)
        controls.storedEvents.set(id, result)
        return Response.json(result)
      }
      const page = Number(url.searchParams.get('pageToken') ?? '0')
      return Response.json(controls.eventPages[page] ?? {}, { status: controls.eventStatus })
    }
    throw new Error('Unexpected provider endpoint')
  }
  return {
    controls,
    calls,
    request,
    client: createGoogleCalendarClient(
      {
        clientId: 'fake-calendar-client',
        clientSecret: 'fake-client-secret',
        publicUrl: TEST_PUBLIC_URL,
      },
      request,
    ),
  }
}

/** Fake Microsoft responses through the actual OAuth/Graph adapter. */
export function fakeMicrosoft() {
  const controls = {
    token: {
      access_token: 'fake-microsoft-access',
      refresh_token: 'fake-microsoft-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid email Calendars.ReadBasic',
    } as Record<string, unknown>,
    tokenStatus: 200,
    identity: { sub: 'microsoft-account-1', email: 'outlook@example.com' } as Record<
      string,
      unknown
    >,
    pages: [
      {
        value: [
          {
            id: 'microsoft-calendar-1',
            name: 'Outlook calendar',
            isDefaultCalendar: true,
            canEdit: true,
            canViewPrivateItems: true,
          },
        ],
      },
    ] as Record<string, unknown>[],
    listStatus: 200,
    listHook: undefined as ((url: URL) => Promise<Response>) | undefined,
  }
  const calls: { url: URL; init: RequestInit }[] = []
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.href === 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
      return Response.json(controls.token, { status: controls.tokenStatus })
    if (url.href === 'https://graph.microsoft.com/oidc/userinfo')
      return Response.json(controls.identity)
    if (url.origin === 'https://graph.microsoft.com' && url.pathname === '/v1.0/me/calendars') {
      if (controls.listHook) return controls.listHook(url)
      return Response.json(
        controls.pages[Number(url.searchParams.get('$skiptoken') ?? '0')] ?? {},
        { status: controls.listStatus },
      )
    }
    throw new Error('Unexpected provider endpoint')
  }
  return {
    controls,
    calls,
    client: createMicrosoftCalendarClient(
      {
        clientId: 'fake-microsoft-client',
        clientSecret: 'fake-microsoft-secret',
        publicUrl: TEST_PUBLIC_URL,
      },
      request,
    ),
  }
}
