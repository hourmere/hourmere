import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { createZoomClient, ZOOM_SCOPE } from './zoom.ts'

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
export function fakeZoom(publicUrl = 'http://localhost:5173') {
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
    throw new Error('Unexpected synthetic Zoom endpoint')
  }
  return {
    controls,
    calls,
    client: createZoomClient(
      { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', publicUrl },
      request,
    ),
  }
}
