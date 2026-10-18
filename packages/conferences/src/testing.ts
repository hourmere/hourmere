import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { createZoomClient, ZOOM_SCOPE } from './zoom.ts'
import { createZoomMeetingsClient } from './zoom-meetings.ts'

export const TEST_CONFERENCE_KEY = Buffer.alloc(32, 19).toString('base64')
export async function conferenceTestSession(
  db: Db,
): Promise<Extract<Principal, { kind: 'session' }>> {
  const user = await createTestUser(db)
  const session = await db
    .insertInto('auth.session')
    .values({
      userId: user.id,
      token: randomUUID(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
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
/** Synthetic responses through the real fixed-endpoint adapter; never contacts Zoom. */
export function fakeZoom(publicUrl = 'http://localhost:5173', now: () => number = Date.now) {
  const controls = {
    token: {
      access_token: 'synthetic-zoom-access',
      refresh_token: 'synthetic-zoom-refresh',
      expires_in: 3600,
      token_type: 'bearer',
      scope: ZOOM_SCOPE,
    } as Record<string, unknown>,
    identity: {
      id: 'synthetic-zoom-identity',
      email: 'zoom@example.com',
      display_name: 'Settings',
    } as Record<string, unknown>,
    storedMeetings: new Map<string, Record<string, unknown>>(),
    meetingHook: undefined as ((url: URL, init: RequestInit) => Promise<Response>) | undefined,
    tokenStatus: 200,
    identityStatus: 200,
    tokenHook: undefined as ((init: RequestInit) => Promise<Response>) | undefined,
    identityHook: undefined as (() => Promise<Response>) | undefined,
  }
  const calls: { url: string; init: RequestInit }[] = []
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === 'https://zoom.us/oauth/token')
      return controls.tokenHook
        ? controls.tokenHook(init)
        : Response.json(controls.token, { status: controls.tokenStatus })
    if (url === 'https://api.zoom.us/v2/users/me')
      return controls.identityHook
        ? controls.identityHook()
        : Response.json(controls.identity, { status: controls.identityStatus })
    const target = new URL(url)
    if (
      target.origin === 'https://api.zoom.us' &&
      (target.pathname === '/v2/users/me/meetings' || target.pathname.startsWith('/v2/meetings/'))
    ) {
      if (controls.meetingHook) return controls.meetingHook(target, init)
      const id = target.pathname.split('/').at(-1) as string
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)),
          meetingId = String(81234567890 + controls.storedMeetings.size)
        const value = {
          ...body,
          id: Number(meetingId),
          host_id: controls.identity.id,
          join_url: `https://us02web.zoom.us/j/${meetingId}?pwd=synthetic-only.1`,
          start_url: 'synthetic-private-start',
          password: 'synthetic-raw-passcode',
        }
        controls.storedMeetings.set(meetingId, value)
        return Response.json(value)
      }
      const prior = controls.storedMeetings.get(id)
      if (!prior) return Response.json({}, { status: 404 })
      if (init.method === 'DELETE') {
        controls.storedMeetings.delete(id)
        return new Response(null, { status: 204 })
      }
      if (init.method === 'PATCH') {
        controls.storedMeetings.set(id, { ...prior, ...JSON.parse(String(init.body)) })
        return new Response(null, { status: 204 })
      }
      return Response.json(prior)
    }
    throw new Error('Unexpected synthetic Zoom endpoint')
  }
  return {
    controls,
    calls,
    meetings: createZoomMeetingsClient(request),
    client: createZoomClient(
      { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', publicUrl },
      request,
      now,
    ),
  }
}
