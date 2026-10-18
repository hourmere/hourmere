import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { mcpEndpoint } from './endpoint.ts'
import { whoamiTool } from './whoami.ts'

const BASE = 'https://hourmere.test'
const query = () =>
  new URLSearchParams({
    client_id: 'unapproved-client',
    redirect_uri: 'https://connector.test/callback',
    response_type: 'code',
    resource: `${BASE}/mcp`,
    scope: 'mcp:tools offline_access',
    code_challenge_method: 'S256',
    code_challenge: 'A'.repeat(43),
  })
const noCaller = async () => ({ ok: false as const, error: 'unauthorized' as const, setCookie: [] })

describe('MCP authorize request boundary', () => {
  it('leaves authorize dispatch unchanged when MCP OAuth is disabled', async () => {
    let called = 0
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      resolveCaller: noCaller,
      authHandler: async () => {
        called++
        return new Response(null, { status: 404 })
      },
    })
    for (const path of ['/api/auth/oauth2/authorize', '/api/auth/oauth2/authorize/'])
      for (const method of ['GET', 'POST'])
        for (let count = 0; count < 31; count++)
          expect((await app.request(`${BASE}${path}`, { method })).status).toBe(404)
    expect(called).toBe(124)
  })
  it('refuses malformed authorization parameters before invoking the provider for GET and POST', async () => {
    let called = 0
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      mcpOAuthEnabled: true,
      resolveCaller: noCaller,
      authHandler: async () => {
        called++
        return Response.redirect('https://connector.test/callback?error=bad', 302)
      },
    })
    const invalid = [
      (q: URLSearchParams) => q.delete('client_id'),
      (q: URLSearchParams) => q.delete('redirect_uri'),
      (q: URLSearchParams) => q.set('response_type', 'token'),
      (q: URLSearchParams) => q.set('resource', 'https://other.test/mcp'),
      (q: URLSearchParams) => q.set('scope', 'admin'),
      (q: URLSearchParams) => q.set('scope', 'offline_access'),
      (q: URLSearchParams) => q.set('code_challenge_method', 'plain'),
      (q: URLSearchParams) => q.delete('code_challenge'),
      (q: URLSearchParams) => q.set('prompt', 'consent none'),
      (q: URLSearchParams) => q.append('client_id', 'duplicate'),
    ]
    for (const change of invalid)
      for (const method of ['GET', 'POST']) {
        const q = query()
        change(q)
        const response = await app.request(
          `${BASE}/api/auth/oauth2/authorize${method === 'GET' ? `?${q}` : ''}`,
          {
            method,
            ...(method === 'POST'
              ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q }
              : {}),
          },
        )
        expect(response.status).toBe(400)
        expect(response.headers.has('location')).toBe(false)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(await response.text()).toContain('Unable to connect to Hourmere')
      }
    expect(called).toBe(0)
  })
  it('renders provider errors locally and allows a successful browser continuation', async () => {
    for (const location of [
      `${BASE}/sign-in?error=invalid_client`,
      'https://connector.test/callback?error=invalid_redirect',
      'https://connector.test/callback#error=unsupported_response_type',
    ]) {
      const app = createApp({
        checkDb: async () => {},
        publicUrl: BASE,
        mcpOAuthEnabled: true,
        resolveCaller: noCaller,
        authHandler: async () => Response.redirect(location, 302),
      })
      const response = await app.request(`${BASE}/api/auth/oauth2/authorize?${query()}`)
      expect(response.status).toBe(400)
      expect(response.headers.has('location')).toBe(false)
    }
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      mcpOAuthEnabled: true,
      resolveCaller: noCaller,
      authHandler: async () => Response.redirect(`${BASE}/oauth/authorize?signed=true`, 302),
    })
    const response = await app.request(`${BASE}/api/auth/oauth2/authorize?${query()}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${BASE}/oauth/authorize?signed=true`)
  })
  it('rate limits malformed authorize attempts before provider dispatch without a mode switch', async () => {
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      mcpOAuthEnabled: true,
      resolveCaller: noCaller,
      authHandler: async () => new Response(null, { status: 404 }),
    })
    for (let count = 0; count < 30; count++)
      expect((await app.request(`${BASE}/api/auth/oauth2/authorize`)).status).toBe(400)
    const response = await app.request(`${BASE}/api/auth/oauth2/authorize`)
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  })
  it('renders JSON provider error redirects as the same local error page', async () => {
    for (const field of ['url', 'redirect_uri']) {
      const app = createApp({
        checkDb: async () => {},
        publicUrl: BASE,
        mcpOAuthEnabled: true,
        resolveCaller: noCaller,
        authHandler: async () =>
          Response.json({ redirect: true, [field]: `${BASE}/sign-in?error=invalid_client` }),
      })
      const response = await app.request(`${BASE}/api/auth/oauth2/authorize?${query()}`, {
        headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' },
      })
      expect(response.status).toBe(400)
      expect(response.headers.has('location')).toBe(false)
      expect(response.headers.get('content-type')).toContain('text/html')
    }
  })
})

describe('OAuth MCP challenge', () => {
  it('includes the exact resource metadata and required scope in an insufficient_scope challenge', async () => {
    const app = createApp({
      checkDb: async () => {},
      publicUrl: BASE,
      resolveCaller: noCaller,
      authHandler: async () => new Response(null, { status: 404 }),
      mcp: mcpEndpoint({
        tools: [whoamiTool],
        oauth: {
          resolve: async () => ({ ok: false, error: 'insufficient_scope' }),
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
    })
    const response = await app.request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer scope-limited-token' },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="mcp:tools"`,
    )
    expect(await response.json()).toEqual({ error: 'insufficient_scope' })
  })
})
