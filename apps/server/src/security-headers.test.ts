import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallerResult, Principal } from '@hourmere/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { APP_CSP, DEFAULT_HSTS_MAX_AGE, strictTransportSecurity } from './security-headers.ts'
import { createWorkerHealthApp } from './worker-health.ts'

const principal: Principal = {
  kind: 'api_key',
  apiKeyId: '00000000-0000-7000-8000-000000000001',
  user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
  organization: {
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Ada',
    slug: 'ada',
    personal: true,
  },
}

const resolveCaller = async (headers: Headers): Promise<CallerResult> =>
  headers.get('authorization') === 'Bearer hm_good'
    ? { ok: true, principal, setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }

/** Stands in for Better Auth: JSON, a redirect, and a response with headers of its own. */
const authHandler = async (request: Request) => {
  const { pathname } = new URL(request.url)
  if (pathname === '/api/auth/redirect') {
    return new Response(null, { status: 302, headers: { location: '/sign-in?error=x' } })
  }
  if (pathname === '/api/auth/own-headers') {
    return new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'SAMEORIGIN',
      },
    })
  }
  return Response.json({ ok: true })
}

const deps = (overrides: Partial<AppDeps> = {}): AppDeps => ({
  checkDb: async () => {},
  authHandler,
  resolveCaller,
  publicUrl: 'http://localhost:3000',
  mcp: mcpEndpoint({ tools: [whoamiTool] }),
  ...overrides,
})

/** The headers this module adds, as a response has them (null when absent). */
function securityHeadersOf(res: Response) {
  const h = res.headers
  return {
    nosniff: h.get('x-content-type-options'),
    frame: h.get('x-frame-options'),
    referrer: h.get('referrer-policy'),
    csp: h.get('content-security-policy'),
    coop: h.get('cross-origin-opener-policy'),
    hsts: h.get('strict-transport-security'),
  }
}

const EVERY_RESPONSE = {
  nosniff: 'nosniff',
  frame: 'DENY',
  referrer: 'strict-origin-when-cross-origin',
  hsts: null,
}
const NOT_HTML = { ...EVERY_RESPONSE, csp: null, coop: null }
const APP_PAGE = { ...EVERY_RESPONSE, csp: APP_CSP, coop: 'same-origin' }

describe('security headers', () => {
  let dist: string
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-web-'))
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hourmere</title>')
    await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)')
    await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    app = createApp(deps({ webDist: dist }))
  })

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  it('allow the web app only its own files, plus inlined images', () => {
    // Checked against the built app in a browser; see APP_CSP. Changes here need that again.
    expect(APP_CSP.split('; ')).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ])
  })

  it('give the web app shell its CSP and opener isolation, at the root and on deep links', async () => {
    for (const path of ['/', '/index.html', '/event-types', '/acme/intro-call?month=2026-11']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type'), path).toMatch(/^text\/html/)
      expect(securityHeadersOf(res), path).toEqual(APP_PAGE)
      // Still revalidated on every load.
      expect(res.headers.get('cache-control'), path).toBe('no-cache')
    }
  })

  it('send no Referer from the invitee manage page', async () => {
    for (const path of ['/booking', '/booking/', '/booking/anything']) {
      const res = await app.request(path)
      expect(securityHeadersOf(res), path).toEqual({ ...APP_PAGE, referrer: 'no-referrer' })
    }
    // Other pages that only start alike keep the default.
    for (const path of ['/bookings', '/booking-x']) {
      expect((await app.request(path)).headers.get('referrer-policy'), path).toBe(
        'strict-origin-when-cross-origin',
      )
    }
  })

  it('leave hashed bundles and other files their own type and long-lived cache', async () => {
    const bundle = await app.request('/assets/app-abc123.js')
    expect(bundle.status).toBe(200)
    expect(securityHeadersOf(bundle)).toEqual(NOT_HTML)
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const missing = await app.request('/assets/app-old999.js')
    expect(missing.status).toBe(404)
    expect(securityHeadersOf(missing)).toEqual(NOT_HTML)

    const icon = await app.request('/favicon.svg')
    expect(icon.headers.get('content-type')).toMatch(/^image\/svg\+xml/)
    expect(securityHeadersOf(icon)).toEqual(NOT_HTML)
  })

  it('keep the sign-in confirm page its own stricter CSP and no-referrer', async () => {
    const res = await app.request('/sign-in/confirm')
    expect(res.status).toBe(200)
    const headers = securityHeadersOf(res)
    expect(headers).toEqual({
      ...APP_PAGE,
      referrer: 'no-referrer',
      csp: expect.stringMatching(/^default-src 'none'; script-src 'sha256-/),
    })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('cover the API, its errors and the health check', async () => {
    const cases: [string, RequestInit | undefined, number][] = [
      ['/api/health', undefined, 200],
      ['/api/v1/openapi.json', undefined, 200],
      ['/api/v1/me', undefined, 401],
      ['/api/v1/me', { headers: { authorization: 'Bearer hm_good' } }, 200],
      ['/api/nope', undefined, 404],
      // 413 from the body limit, answered by the error handler.
      [
        '/api/v1/me',
        { method: 'POST', headers: { 'content-length': '70000' }, body: 'x'.repeat(70_000) },
        413,
      ],
    ]
    for (const [path, init, status] of cases) {
      const res = await app.request(path, init)
      expect(res.status, path).toBe(status)
      expect(securityHeadersOf(res), `${path} ${status}`).toEqual(NOT_HTML)
    }
    // Next to the API's own Cache-Control.
    expect((await app.request('/api/v1/me')).headers.get('cache-control')).toBe('no-store')
  })

  it("cover Better Auth's responses without replacing headers it sets", async () => {
    const ok = await app.request('/api/auth/get-session')
    expect(securityHeadersOf(ok)).toEqual(NOT_HTML)
    const redirect = await app.request('/api/auth/redirect')
    expect(redirect.status).toBe(302)
    expect(securityHeadersOf(redirect)).toEqual(NOT_HTML)
    const own = await app.request('/api/auth/own-headers')
    expect(securityHeadersOf(own)).toEqual({
      ...NOT_HTML,
      referrer: 'no-referrer',
      frame: 'SAMEORIGIN',
    })
  })

  it('cover the MCP endpoint, refused or answered', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }
    const post = (headers: Record<string, string>) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(initialize),
      })
    const refused = await post({})
    expect(refused.status).toBe(401)
    expect(securityHeadersOf(refused)).toEqual(NOT_HTML)
    const answered = await post({ authorization: 'Bearer hm_good' })
    expect(answered.status).toBe(200)
    expect(securityHeadersOf(answered)).toEqual(NOT_HTML)
    expect(answered.headers.get('cache-control')).toBe('no-store')
    await answered.body?.cancel()
  })

  it('cover requests that match no route', async () => {
    const res = await app.request('/anything', { method: 'PUT' })
    expect(res.status).toBe(404)
    expect(securityHeadersOf(res)).toEqual(NOT_HTML)
  })

  it('cover the worker role, which only answers health checks', async () => {
    const worker = createWorkerHealthApp({ checkDb: async () => {}, checkJobs: async () => {} })
    for (const path of ['/api/health', '/']) {
      expect(securityHeadersOf(await worker.request(path)), path).toEqual(NOT_HTML)
    }
  })

  describe('Strict-Transport-Security', () => {
    it('is sent on every response when PUBLIC_URL is https on a real host name', async () => {
      const https = createApp(deps({ publicUrl: 'https://cal.example.com', webDist: dist }))
      for (const path of ['/', '/api/health', '/api/auth/get-session', '/sign-in/confirm']) {
        expect((await https.request(path)).headers.get('strict-transport-security'), path).toBe(
          `max-age=${DEFAULT_HSTS_MAX_AGE}`,
        )
      }
      expect(DEFAULT_HSTS_MAX_AGE).toBe(15_552_000)
      const custom = createApp(deps({ publicUrl: 'https://cal.example.com', hstsMaxAge: 0 }))
      expect((await custom.request('/api/health')).headers.get('strict-transport-security')).toBe(
        'max-age=0',
      )
    })

    it('is not sent over http, on localhost or on IP addresses', async () => {
      for (const publicUrl of [
        'http://cal.example.com',
        'https://localhost:3000',
        'https://hourmere.localhost',
        'https://127.0.0.1',
        'https://[::1]:8443',
      ]) {
        expect(strictTransportSecurity(publicUrl, 3600), publicUrl).toBeUndefined()
        const res = await createApp(deps({ publicUrl })).request('/api/health')
        expect(res.headers.get('strict-transport-security'), publicUrl).toBeNull()
      }
      expect(strictTransportSecurity('https://cal.example.com', 3600)).toBe('max-age=3600')
    })
  })
})
