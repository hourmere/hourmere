import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleWaitlist, type WaitlistEnv } from '../worker/index.ts'

let database: DatabaseSync
let env: WaitlistEnv
const headers = {
  Origin: 'https://hourmere.com',
  'CF-Connecting-IP': '192.0.2.10',
  'Content-Type': 'application/json',
}
const request = (body: unknown = { email: 'person@example.com' }, extra: HeadersInit = {}) =>
  new Request('https://hourmere.com/api/waitlist', {
    method: 'POST',
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  })
const rawRequest = (body: BodyInit, extra: HeadersInit = {}) =>
  new Request('https://hourmere.com/api/waitlist', {
    method: 'POST',
    headers: { ...headers, ...extra },
    body,
  })
const rows = () => database.prepare('SELECT * FROM waitlist ORDER BY email').all()

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec(
    readFileSync(new URL('../migrations/0001_cloud_waitlist.sql', import.meta.url), 'utf8'),
  )
  env = {
    ASSETS: { fetch: vi.fn(async () => new Response('unchanged asset', { status: 404 })) },
    WAITLIST_DB: {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: (string | null)[]) => ({
          // D1's prepare/bind/run interface backed by real SQLite constraints and SQL.
          run: async () => database.prepare(sql).run(...values),
        }),
      })),
    },
    WAITLIST_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  }
})

afterEach(() => {
  database.close()
  vi.useRealTimers()
})

describe('Cloud waitlist input', () => {
  it('normalizes one email and records only the disclosed fields and consent version', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-30T12:34:56.000Z'))
    const response = await handleWaitlist(
      request({
        email: '  Person+Launch@Example.COM ',
        source: 'cloud',
        locale: 'en',
        hm_extra: '',
      }),
      env,
    )
    expect(response.status).toBe(200)
    expect(rows()).toEqual([
      {
        email: 'person+launch@example.com',
        created_at: '2026-11-30T12:34:56.000Z',
        source: 'cloud',
        locale: 'en',
        consent_text_version: '2026-11-30',
      },
    ])
    expect(await response.text()).not.toContain('Person')
  })

  it.each(['pricing', 'cloud', 'faq'])('accepts the fixed %s source', async (source) => {
    expect(
      (await handleWaitlist(request({ email: 'person@example.com', source }), env)).status,
    ).toBe(200)
    expect(rows()[0]?.source).toBe(source)
  })

  it('keeps omitted source and locale null', async () => {
    expect((await handleWaitlist(request(), env)).status).toBe(200)
    expect(rows()[0]).toMatchObject({ source: null, locale: null })
  })

  it('binds a valid apostrophe email as data rather than SQL', async () => {
    const email = "o'connor+launch@example.com"
    expect((await handleWaitlist(request({ email }), env)).status).toBe(200)
    expect(rows()[0]?.email).toBe(email)
  })

  it('accepts a valid 254-character email but rejects 255 characters', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
    expect(email).toHaveLength(254)
    expect((await handleWaitlist(request({ email }), env)).status).toBe(200)
    expect((await handleWaitlist(request({ email: `${email}d` }), env)).status).toBe(400)
    expect(rows()).toHaveLength(1)
  })

  it.each([
    '',
    'missing-at.example.com',
    'a@@example.com',
    'one@example.com,two@example.com',
    'Person <one@example.com>',
    'one@example.com;two@example.com',
    'one @example.com',
    'one\n@example.com',
    '\r\none@example.com',
    'one@example.com\n',
    '\u0000one@example.com',
    'one@example.com\u007f',
    '.one@example.com',
    'one.@example.com',
    'one..two@example.com',
    `${'a'.repeat(65)}@example.com`,
    'one@localhost',
    'one@-example.com',
    'one@example-.com',
    `one@${'a'.repeat(64)}.com`,
    'one@example..com',
    'one@example.123',
    'one@éxample.com',
  ])('rejects malformed or multiple email addresses: %j', async (email) => {
    expect((await handleWaitlist(request({ email }), env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it.each([
    {},
    null,
    [],
    'person@example.com',
    { email: ['person@example.com'] },
    { email: 42 },
    { email: 'person@example.com', extra: 'ignored?' },
    { email: 'person@example.com', website: '' },
    { email: 'person@example.com', source: 'other' },
    { email: 'person@example.com', source: '' },
    { email: 'person@example.com', locale: 'fr' },
    { email: 'person@example.com', locale: null },
    { email: 'person@example.com', hm_extra: false },
    { email: 'person@example.com', hm_extra: 'x'.repeat(1025) },
  ])('rejects an invalid shape or non-allowlisted field: %j', async (input) => {
    expect((await handleWaitlist(request(input), env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it.each([
    '{',
    '{"email":"person@example.com",}',
    '{"email":"person@example.com"} trailing',
    '{"email":"person@example.com","email":"second@example.com"}',
    '{"email":"person@example.com","em\\u0061il":"second@example.com"}',
    '{"email":"person@example.com","hm_extra":{}}',
  ])('rejects malformed JSON and duplicate JSON fields: %s', async (body) => {
    expect((await handleWaitlist(rawRequest(body), env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('accepts URL-encoded forms and redirects a browser to an inline success state', async () => {
    const response = await handleWaitlist(
      rawRequest('email=Person%40Example.com&source=pricing&locale=en&hm_extra=', {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      env,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/?waitlist=success#cloud-waitlist-success')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('')
    expect(rows()[0]?.email).toBe('person@example.com')
  })

  it('accepts multipart text fields and JSON fetch responses for a form', async () => {
    const form = new FormData()
    form.set('email', 'Person@Example.com')
    form.set('source', 'faq')
    const formRequest = new Request('https://hourmere.com/api/waitlist', {
      method: 'POST',
      headers: {
        Origin: headers.Origin,
        'CF-Connecting-IP': '192.0.2.10',
        Accept: 'application/json',
      },
      body: form,
    })
    const response = await handleWaitlist(formRequest, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(rows()[0]?.email).toBe('person@example.com')
  })

  it('rejects uploaded files in form fields', async () => {
    const form = new FormData()
    form.set('email', 'person@example.com')
    form.set('hm_extra', new Blob(['text']), 'test.txt')
    const formRequest = new Request('https://hourmere.com/api/waitlist', {
      method: 'POST',
      headers: { Origin: headers.Origin, 'CF-Connecting-IP': '192.0.2.10' },
      body: form,
    })
    expect((await handleWaitlist(formRequest, env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it.each([
    'email=one%40example.com&email=two%40example.com',
    'email=one%40example.com&source=pricing&source=faq',
    'email=one%40example.com&extra=value',
    'email=one%40example.com&hm_extra=%ZZ',
  ])('rejects duplicate, extra and malformed form fields: %s', async (body) => {
    const response = await handleWaitlist(
      rawRequest(body, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      env,
    )
    expect(response.status).toBe(400)
    expect(rows()).toHaveLength(0)
    expect(await response.text()).not.toContain('one@example.com')
  })

  it('rejects unsupported content types', async () => {
    expect(
      (
        await handleWaitlist(
          rawRequest('{"email":"person@example.com"}', { 'Content-Type': 'text/plain' }),
          env,
        )
      ).status,
    ).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('bounds the body actually read rather than trusting Content-Length', async () => {
    const response = await handleWaitlist(
      rawRequest(`${' '.repeat(4096)}{"email":"person@example.com"}`, { 'Content-Length': '1' }),
      env,
    )
    expect(response.status).toBe(400)
    expect(rows()).toHaveLength(0)
  })

  it('does not decode malformed UTF-8 as a replacement character', async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"email":"person@example.com","hm_extra":"'),
      0xff,
      ...new TextEncoder().encode('"}'),
    ])
    expect((await handleWaitlist(rawRequest(body), env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
  })
})

describe('waitlist privacy and abuse protections', () => {
  it('returns an identical success body for a new email, a duplicate and a honeypot', async () => {
    const first = await handleWaitlist(request(), env)
    const duplicate = await handleWaitlist(request(), env)
    const bot = await handleWaitlist(request({ email: 'bot@example.com', hm_extra: 'filled' }), env)
    expect([first.status, duplicate.status, bot.status]).toEqual([200, 200, 200])
    const body = await first.text()
    expect(await duplicate.text()).toBe(body)
    expect(await bot.text()).toBe(body)
    expect(body).not.toContain('person@example.com')
    expect(rows()).toHaveLength(1)
    expect(env.WAITLIST_DB.prepare).toHaveBeenCalledTimes(2)
  })

  it('keeps original join time and consent metadata on duplicates using SQLite conflict handling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-30T00:00:00.000Z'))
    await handleWaitlist(request({ email: 'person@example.com', source: 'pricing' }), env)
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'))
    expect(
      (await handleWaitlist(request({ email: 'PERSON@example.com', source: 'faq' }), env)).status,
    ).toBe(200)
    expect(rows()).toEqual([
      {
        email: 'person@example.com',
        created_at: '2026-11-30T00:00:00.000Z',
        source: 'pricing',
        locale: null,
        consent_text_version: '2026-11-30',
      },
    ])
  })

  it.each(['filled', ' '])('stores nothing for a filled honeypot: %j', async (hm_extra) => {
    expect(
      (await handleWaitlist(request({ email: 'person@example.com', hm_extra }), env)).status,
    ).toBe(200)
    expect(rows()).toHaveLength(0)
    expect(env.WAITLIST_DB.prepare).not.toHaveBeenCalled()
  })

  it.each(['https://hourmere.com', 'https://www.hourmere.com'])(
    'allows the exact production origin %s',
    async (origin) => {
      expect((await handleWaitlist(request(undefined, { Origin: origin }), env)).status).toBe(200)
    },
  )

  it.each([
    '',
    'null',
    'http://hourmere.com',
    'https://hourmere.com.evil.example',
    'https://hourmere.com/',
    'https://hourmere.com:443',
    'http://localhost:4321',
    'https://evil.example',
  ])('rejects a missing or foreign Origin %j before touching storage', async (origin) => {
    const post = request(undefined, { Origin: origin })
    if (!origin) post.headers.delete('Origin')
    expect((await handleWaitlist(post, env)).status).toBe(400)
    expect(rows()).toHaveLength(0)
    expect(env.WAITLIST_RATE_LIMITER.limit).not.toHaveBeenCalled()
  })

  it('allows loopback Origin only in the explicit local development environment and at the same origin', async () => {
    const local = (origin: string) =>
      new Request('http://localhost:4321/api/waitlist', {
        method: 'POST',
        headers: { ...headers, Origin: origin },
        body: JSON.stringify({ email: 'person@example.com' }),
      })
    expect((await handleWaitlist(local('http://localhost:4321'), env)).status).toBe(400)
    env.WAITLIST_DEVELOPMENT = 'true'
    expect((await handleWaitlist(local('http://localhost:4321'), env)).status).toBe(200)
    expect((await handleWaitlist(local('http://localhost:4322'), env)).status).toBe(400)
    expect((await handleWaitlist(local('https://evil.example'), env)).status).toBe(400)
  })

  it('returns 429 before reading or storing a submission when the binding refuses it', async () => {
    env.WAITLIST_RATE_LIMITER.limit = vi.fn(async () => ({ success: false }))
    const response = await handleWaitlist(request(), env)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(rows()).toHaveLength(0)
    expect(env.WAITLIST_DB.prepare).not.toHaveBeenCalled()
    expect(await response.text()).not.toContain('192.0.2.10')
  })

  it('uses a stable client IP digest across minute boundaries without retaining the address', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-30T00:00:59.000Z'))
    await handleWaitlist(request(), env)
    await handleWaitlist(request(), env)
    await handleWaitlist(request(undefined, { 'CF-Connecting-IP': '192.0.2.11' }), env)
    vi.setSystemTime(new Date('2026-11-30T00:01:00.000Z'))
    await handleWaitlist(request(), env)
    const calls = vi.mocked(env.WAITLIST_RATE_LIMITER.limit).mock.calls
    const keys = calls.map(([options]) => options.key)
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[3]).toBe(keys[0])
    expect(JSON.stringify(calls)).not.toContain('192.0.2.')
    expect(JSON.stringify(rows())).not.toContain('192.0.2.')
  })

  it('keeps using the binding counter when a burst crosses a minute boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-30T00:00:59.000Z'))
    const counters = new Map<string, number>()
    env.WAITLIST_RATE_LIMITER.limit = vi.fn(async ({ key }) => {
      const count = (counters.get(key) ?? 0) + 1
      counters.set(key, count)
      return { success: count <= 5 }
    })
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await handleWaitlist(request(), env)).status).toBe(200)
    }
    vi.setSystemTime(new Date('2026-11-30T00:01:01.000Z'))
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await handleWaitlist(request(), env)).status).toBe(429)
    }
    expect(counters.size).toBe(1)
    expect(env.WAITLIST_DB.prepare).toHaveBeenCalledTimes(5)
    expect(rows()).toHaveLength(1)
  })

  it('fails closed if the trusted production client IP is absent', async () => {
    const post = request()
    post.headers.delete('CF-Connecting-IP')
    expect((await handleWaitlist(post, env)).status).toBe(503)
    expect(rows()).toHaveLength(0)
    expect(env.WAITLIST_RATE_LIMITER.limit).not.toHaveBeenCalled()
  })

  it.each(['limiter', 'database'])(
    'returns a safe unavailable response on %s failure',
    async (binding) => {
      const fail = () => {
        throw new Error('private database or provider detail')
      }
      if (binding === 'limiter') env.WAITLIST_RATE_LIMITER.limit = fail
      else env.WAITLIST_DB.prepare = fail
      const response = await handleWaitlist(request(), env)
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.text()).not.toContain('private database')
      expect(rows()).toHaveLength(0)
    },
  )

  it('sends no-store and the existing site security headers on all dynamic responses', async () => {
    const success = await handleWaitlist(request(), env)
    const invalid = await handleWaitlist(request({ email: 'invalid' }), env)
    env.WAITLIST_RATE_LIMITER.limit = async () => ({ success: false })
    const limited = await handleWaitlist(request(), env)
    for (const response of [success, invalid, limited]) {
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('X-Frame-Options')).toBe('DENY')
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('Permissions-Policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      )
    }
  })

  it('renders an accessible, input-free HTML error for the no-JS form', async () => {
    const response = await handleWaitlist(
      rawRequest('email=%3Cscript%3E', { 'Content-Type': 'application/x-www-form-urlencoded' }),
      env,
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    const html = await response.text()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('role="alert"')
    expect(html).toContain('href="/#cloud-waitlist"')
    expect(html).not.toContain('<script>')
  })

  it.each([
    ['GET', '/'],
    ['GET', '/privacy'],
    ['GET', '/api/waitlist'],
    ['POST', '/api/other'],
    ['OPTIONS', '/api/waitlist'],
  ])('delegates %s %s unchanged to static assets', async (method, path) => {
    const asset = new Response('exact asset bytes', {
      status: 404,
      headers: { 'X-Existing': 'kept' },
    })
    env.ASSETS.fetch = vi.fn(async () => asset)
    const incoming = new Request(`https://hourmere.com${path}`, { method })
    const response = await handleWaitlist(incoming, env)
    expect(response).toBe(asset)
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(incoming)
    expect(env.WAITLIST_RATE_LIMITER.limit).not.toHaveBeenCalled()
    expect(env.WAITLIST_DB.prepare).not.toHaveBeenCalled()
  })
})
