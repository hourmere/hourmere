import { randomUUID } from 'node:crypto'
import type { CallerResolver } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { ssoPolicyRoutes } from './sso-policy.ts'

const path = '/api/v1/team/sso/policy'
const publicUrl = 'https://hourmere.example.test'
const organizationId = randomUUID()
const input = { expectedRevision: 1, requireSso: true, admission: 'invitation_only' }
const session: CallerResolver = async () => ({
  ok: true,
  principal: {
    kind: 'session',
    sessionId: randomUUID(),
    user: { id: randomUUID(), name: 'Owner', email: 'owner@example.test' },
    organization: { id: organizationId, name: 'Team', slug: 'team', personal: false },
  },
  setCookie: [],
})

function app(enabled: boolean, resolveCaller: CallerResolver) {
  return createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    routes: [
      ssoPolicyRoutes({
        db: {} as Db,
        publicUrl,
        capabilities: { ssoOidcEnabled: enabled, ssoSamlEnabled: false },
      }),
    ],
  })
}

function request(
  a: ReturnType<typeof app>,
  body: string,
  headers: Record<string, string> = {},
  query = '',
) {
  return a.request(`${path}${query}`, {
    method: 'PUT',
    headers: {
      origin: publicUrl,
      'content-type': 'application/json',
      'X-Expected-Organization-Id': organizationId,
      ...headers,
    },
    body,
  })
}

it('answers sso_disabled before resolving a caller or validating policy input', async () => {
  const resolveCaller = vi.fn(session)
  const response = await request(app(false, resolveCaller), '{', { origin: 'null' })
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'sso_disabled' })
  expect(resolveCaller).not.toHaveBeenCalled()
})

it('requires an exact Origin and refuses bearer credentials even alongside a cookie', async () => {
  const resolveCaller = vi.fn(session)
  const a = app(true, resolveCaller)
  const rejectedHeaders: Record<string, string>[] = [
    { origin: `${publicUrl}/app` },
    { authorization: 'Bearer synthetic', cookie: 'synthetic=session' },
  ]
  for (const headers of rejectedHeaders) {
    const response = await request(a, JSON.stringify(input), headers)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
  }
  expect(resolveCaller).not.toHaveBeenCalled()
})

it('rejects unknown fields and keeps policy proof material out of responses and diagnostics', async () => {
  const marker = 'synthetic-policy-proof-marker'
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const invalid = await request(app(true, session), JSON.stringify({ ...input, [marker]: true }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_request' })

    const unavailable = app(true, async () => {
      throw new Error(marker)
    })
    const failed = await request(
      unavailable,
      JSON.stringify({ ...input, proofAttemptId: randomUUID() }),
      {},
      `?proof=${marker}`,
    )
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'internal_error' })
    expect(JSON.stringify([...logged.mock.calls, ...errors.mock.calls])).not.toContain(marker)
  } finally {
    logged.mockRestore()
    errors.mockRestore()
  }
})
