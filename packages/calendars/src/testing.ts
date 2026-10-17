import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { createGoogleCalendarClient, GOOGLE_CALENDAR_SCOPES } from './google.ts'

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
    eventPages: [{ items: [], nextSyncToken: 'cursor-1' }] as Record<string, unknown>[],
    eventStatus: 200,
    eventHook: undefined as ((url: URL, init: RequestInit) => Promise<Response>) | undefined,
    storedEvents: new Map<string, Record<string, unknown>>(),
  }
  const calls: { url: URL; init: RequestInit }[] = []
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.href === 'https://oauth2.googleapis.com/token')
      return Response.json(controls.token, { status: controls.tokenStatus })
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo')
      return Response.json(controls.identity)
    if (
      url.origin === 'https://www.googleapis.com' &&
      url.pathname === '/calendar/v3/users/me/calendarList'
    ) {
      const page = Number(url.searchParams.get('pageToken') ?? '0')
      return Response.json(controls.pages[page] ?? {}, { status: controls.listStatus })
    }
    if (url.origin === 'https://www.googleapis.com' && url.pathname.includes('/events')) {
      if (controls.eventHook) return controls.eventHook(url, init)
      if (init.method === 'POST') {
        const value = JSON.parse(String(init.body))
        const stored = { ...value, id: `event-${controls.storedEvents.size + 1}`, etag: '"v1"' }
        controls.storedEvents.set(stored.id, stored)
        return Response.json(stored)
      }
      if (init.method === 'PATCH') {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        const prior = controls.storedEvents.get(id)
        if (!prior) return Response.json({}, { status: 404 })
        const stored = { ...prior, ...JSON.parse(String(init.body)), etag: '"v2"' }
        controls.storedEvents.set(id, stored)
        return Response.json(stored)
      }
      if (url.searchParams.has('iCalUID'))
        return Response.json({
          items: [...controls.storedEvents.values()].filter(
            (e) => e.iCalUID === url.searchParams.get('iCalUID') && e.status !== 'cancelled',
          ),
        })
      const page = Number(url.searchParams.get('pageToken') ?? '0')
      return Response.json(controls.eventPages[page] ?? {}, { status: controls.eventStatus })
    }
    throw new Error('Unexpected provider endpoint')
  }
  return {
    controls,
    calls,
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
