import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { DomainError, type DomainErrorKind } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, createApp, hasUnsafeJsonText } from './app.ts'
import { DEFAULT_BODY_LIMIT as MAX_BODY_BYTES } from './body-limit.ts'
import { CHUNK_SIZE, chunkedBody } from './chunked-body.ts'
import { authenticated, callerWithBodyLimit, json, type RouteModule } from './openapi.ts'

// Sign-in is covered by auth.test.ts against a real database.
const noAuth: Pick<AppDeps, 'authHandler' | 'resolveCaller' | 'publicUrl'> = {
  publicUrl: 'http://localhost:3000',
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
}

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    const app = createApp({ ...noAuth, checkDb: async () => {} })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('reports 503 when the database is unreachable', async () => {
    const app = createApp({
      ...noAuth,
      checkDb: async () => {
        throw new Error('connection refused')
      },
    })
    const res = await app.request('/api/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'degraded', database: 'unreachable' })
  })
})

describe('request log', () => {
  it('has neither query strings nor terminal colors', async () => {
    const app = createApp({ ...noAuth, checkDb: async () => {} })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await app.request('/api/health?token=secret')
      const lines = log.mock.calls.map((args) => args.join(' '))
      expect(lines).toEqual([
        '<-- GET /api/health',
        expect.stringMatching(/^--> GET \/api\/health 200 \d+m?s$/),
      ])
    } finally {
      log.mockRestore()
    }
  })
})

describe('API surface', () => {
  const app = createApp({ ...noAuth, checkDb: async () => {} })

  it('publishes an OpenAPI document that lists the routes', async () => {
    const res = await app.request('/api/v1/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/health', '/api/v1/me']))
  })

  it('answers 401 JSON on authenticated routes when nobody is signed in', async () => {
    const res = await app.request('/api/v1/me')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})

describe('serving the built web app', () => {
  let dist: string
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-web-'))
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'index.html'), '<title>Hourmere</title>')
    await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)')
    app = createApp({ ...noAuth, checkDb: async () => {}, webDist: dist })
  })

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  it('serves the app shell for client-side routes', async () => {
    const res = await app.request('/acme/intro-call')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>Hourmere</title>')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('asks browsers to revalidate the app shell at the root too', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('serves hashed bundles with a long-lived cache header', async () => {
    const res = await app.request('/assets/app-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('returns 404, not the app shell, for a missing bundle', async () => {
    const res = await app.request('/assets/app-old999.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBeNull()
  })

  it('serves the sign-in confirm page itself, keeping its headers', async () => {
    const res = await app.request('/sign-in/confirm')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign in to Hourmere</button>')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
})

describe('route modules and errors', () => {
  // A stand-in for the product API: an authenticated OpenAPI route module, as real modules
  // are written (see openapi.ts).
  const principal = {
    kind: 'api_key' as const,
    apiKeyId: '00000000-0000-7000-8000-000000000001',
    user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
    organization: {
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Ada',
      slug: 'ada',
      personal: true,
    },
  }
  const thing: RouteModule = ({ app, caller }) => {
    const Thing = z.object({ name: z.string().min(1), count: z.number().int() })
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/things',
        security: authenticated,
        middleware: caller,
        request: {
          query: z.object({ fail: z.string().optional() }),
          body: { content: json(Thing), required: true },
        },
        responses: { 200: { description: 'ok', content: json(Thing) } },
      }),
      (c) => {
        const fail = c.req.valid('query').fail
        if (fail === 'conflict')
          throw new DomainError('conflict', 'slot_taken', 'Someone booked this time first')
        if (fail === 'empty') throw new DomainError('invalid', 'bad_thing', '')
        if (fail === 'weird') throw new DomainError('weird' as DomainErrorKind, 'weird')
        if (fail === 'prepared')
          throw new HTTPException(418, { res: new Response('teapot', { status: 418 }) })
        if (fail === 'http500') throw new HTTPException(500, { message: 'db password is hunter2' })
        if (fail === 'caused')
          throw new DomainError('conflict', 'email_taken', 'That email is already in use', {
            cause: new Error('duplicate key value violates unique constraint\nKey (email)=(a@b.c)'),
          })
        if (fail === 'bug') throw new Error('unexpected')
        if (fail) throw new DomainError(fail as DomainErrorKind, `thing_${fail}`)
        return c.json(
          {
            ...c.req.valid('json'),
            name: `${c.var.principal.user.name}:${c.req.valid('json').name}`,
          },
          200,
        )
      },
    )
  }
  const app = createApp({
    ...noAuth,
    checkDb: async () => {},
    resolveCaller: async (headers) =>
      headers.get('authorization') === 'Bearer hm_test'
        ? { ok: true, principal, setCookie: [] }
        : { ok: false, error: 'unauthorized', setCookie: [] },
    routes: [thing],
  })
  const post = (query: string, body: string, auth = true) =>
    app.request(`/api/v1/things${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer hm_test' } : {}),
      },
      body,
    })
  const valid = JSON.stringify({ name: 'x', count: 1 })

  it('serves module routes behind the caller middleware with a typed principal', async () => {
    const res = await post('', valid)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Ada:x', count: 1 })
    expect((await post('', valid, false)).status).toBe(401)
  })

  it('lists module routes with their security in the OpenAPI document', async () => {
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, { post?: { security?: unknown } }>
    }
    expect(doc.paths['/api/v1/things']?.post?.security).toEqual([{ apiKey: [] }, { session: [] }])
  })

  it.each([
    ['invalid', 400],
    ['forbidden', 403],
    ['not_found', 404],
  ] as const)('maps a %s DomainError to %i with its code', async (kind, status) => {
    const res = await post(`?fail=${kind}`, valid)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: `thing_${kind}` })
  })

  it('includes the message only when one was given', async () => {
    const conflict = await post('?fail=conflict', valid)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: 'slot_taken',
      message: 'Someone booked this time first',
    })
    expect(await (await post('?fail=empty', valid)).json()).toEqual({ error: 'bad_thing' })
  })

  it('treats a DomainError with an unknown kind as a bug', async () => {
    const res = await post('?fail=weird', valid)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('answers invalid query, invalid body and malformed JSON with the documented shape', async () => {
    const badBody = await post('', JSON.stringify({ name: '', count: 1.5 }))
    expect(badBody.status).toBe(400)
    const body = (await badBody.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_request')
    expect(body.message).toMatch(/name/)
    expect(body.message).toMatch(/count/)

    const badQuery = await post('?fail=1&fail=2', valid)
    expect(badQuery.status).toBe(400)
    expect(await badQuery.json()).toMatchObject({ error: 'invalid_request' })

    const malformed = await post('', '{"name":')
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('content-type')).toMatch(/application\/json/)
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('passes a prepared HTTPException response through unchanged', async () => {
    const res = await post('?fail=prepared', valid)
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('teapot')
  })

  it('keeps other errors opaque', async () => {
    const res = await post('?fail=bug', valid)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('treats a DomainError whose kind is a prototype key as a bug', async () => {
    const res = await post('?fail=__proto__', valid)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('never shows the message of a 5xx HTTPException', async () => {
    const res = await post('?fail=http500', valid)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it("logs a DomainError's cause on one line, without sending it to the client", async () => {
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.join(' '))
    })
    try {
      const res = await post('?fail=caused', valid)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'email_taken',
        message: 'That email is already in use',
      })
    } finally {
      spy.mockRestore()
    }
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('email_taken caused by')
    expect(logged[0]).toContain('Key (email)=(a@b.c)')
    expect(logged[0]).not.toContain('\n')
  })

  it('refuses JSON with NUL or malformed Unicode anywhere before the route runs', async () => {
    for (const body of [
      JSON.stringify({ name: 'A\u0000B', count: 1 }),
      JSON.stringify({ name: 'a\ud800b', count: 1 }),
      '{"name":"x","count":1,"extra":{"deep":[1,["\\u0000"]]}}',
      '{"name":"x","count":1,"key\\udc00":true}',
    ]) {
      const res = await post('', body)
      expect(res.status, body).toBe(400)
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        message: 'Text in the request must not contain NUL characters or malformed Unicode',
      })
    }
    // Clean text, emoji included, reaches the route; malformed JSON is still the validator's.
    expect((await post('', JSON.stringify({ name: 'Ada 👩‍💻', count: 1 }))).status).toBe(200)
    expect(await (await post('', '{"name":')).json()).toMatchObject({ error: 'invalid_request' })
  })

  it('checks deeply nested JSON without overflowing the stack', () => {
    const deep = JSON.parse(`${'['.repeat(50_000)}"\\u0000"${']'.repeat(50_000)}`)
    expect(hasUnsafeJsonText(deep)).toBe(true)
    expect(hasUnsafeJsonText({ a: [{ b: 'fine' }], 'c d': null, e: 1 })).toBe(false)
    // Wide as well as deep: far more elements than a function call takes arguments.
    const wide = new Array(300_000).fill('a')
    expect(hasUnsafeJsonText(wide)).toBe(false)
    expect(hasUnsafeJsonText([...wide, 'A\u0000B'])).toBe(true)
    expect(hasUnsafeJsonText(Object.fromEntries(wide.map((v, i) => [`k${i}`, v])))).toBe(false)
  })

  it('refuses bodies over 64 KB with 413 payload_too_large', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES), count: 1 })
    const declared = await app.request('/api/v1/things', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(big.length),
        authorization: 'Bearer hm_test',
      },
      body: big,
    })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ error: 'payload_too_large' })
    // Without Content-Length the body is counted as it streams in.
    const streamed = await post('', big)
    expect(streamed.status).toBe(413)
    // Just under the limit is fine.
    const fits = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES - 100), count: 1 })
    expect((await post('', fits)).status).toBe(200)
  })

  it('applies the body limit to sign-in routes too, and passes their bodies on intact', async () => {
    let received: string | undefined
    const authApp = createApp({
      ...noAuth,
      checkDb: async () => {},
      authHandler: async (request) => {
        received = await request.text()
        return new Response(null, { status: 200 })
      },
    })
    const send = (body: string) =>
      authApp.request('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    const small = JSON.stringify({ email: 'ada@example.com', callbackURL: '/' })
    expect((await send(small)).status).toBe(200)
    expect(received).toBe(small)
    received = undefined
    const big = await send(JSON.stringify({ email: 'x'.repeat(MAX_BODY_BYTES) }))
    expect(big.status).toBe(413)
    expect(received).toBeUndefined()

    // Streamed bodies too: the handler reads them through the counting stream.
    const sendChunked = (body: string) =>
      authApp.request('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...chunkedBody(body).init,
      })
    const longEmail = JSON.stringify({ email: `${'a'.repeat(CHUNK_SIZE)}@example.com` })
    expect((await sendChunked(longEmail)).status).toBe(200)
    expect(received).toBe(longEmail)
    received = undefined
    const bigChunked = await sendChunked(JSON.stringify({ email: 'x'.repeat(MAX_BODY_BYTES) }))
    expect(bigChunked.status).toBe(413)
    expect(await bigChunked.json()).toEqual({ error: 'payload_too_large' })
    expect(received).toBeUndefined()
  })

  it('leaves a Cache-Control that a route sets itself', async () => {
    const cached: RouteModule = ({ app }) => {
      app.openapi(
        createRoute({
          method: 'get',
          path: '/api/v1/cacheable',
          responses: { 200: { description: 'ok', content: json(z.object({ ok: z.boolean() })) } },
        }),
        (c) => {
          c.header('Cache-Control', 'public, max-age=60')
          return c.json({ ok: true }, 200)
        },
      )
    }
    const cachedApp = createApp({ ...noAuth, checkDb: async () => {}, routes: [cached] })
    const res = await cachedApp.request('/api/v1/cacheable')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    // Everything else under /api/v1 is no-store, including errors raised by the HTTP layer.
    const tooBig = await post('', JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES), count: 1 }))
    expect(tooBig.status).toBe(413)
    expect(tooBig.headers.get('cache-control')).toBe('no-store')
    const bug = await post('?fail=bug', valid)
    expect(bug.status).toBe(500)
    expect(bug.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses reserved codes for DomainError', () => {
    expect(() => new DomainError('invalid', 'invalid_request')).toThrow(/reserved/)
    expect(() => new DomainError('not_found', 'not_found')).toThrow(/reserved/)
    expect(new DomainError('not_found', 'event_type_not_found').code).toBe('event_type_not_found')
  })
})

describe('streamed request bodies', () => {
  // A route with a large declared limit, as real create routes have, and another method on
  // the same path that keeps the default and reads the body itself instead of declaring it.
  const LIMIT = 2 * 1024 * 1024
  const uploads: RouteModule = ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/uploads',
        security: authenticated,
        middleware: callerWithBodyLimit(caller, LIMIT),
        request: { body: { content: json(z.object({ data: z.string() })), required: true } },
        responses: { 200: { description: 'ok', content: json(z.object({ length: z.number() })) } },
      }),
      (c) => c.json({ length: c.req.valid('json').data.length }, 200),
    )
    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/uploads',
        security: authenticated,
        middleware: caller,
        responses: { 200: { description: 'ok', content: json(z.object({ bytes: z.number() })) } },
      }),
      async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }, 200),
    )
  }
  const principal = {
    kind: 'api_key' as const,
    apiKeyId: '00000000-0000-7000-8000-000000000001',
    user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
    organization: {
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Ada',
      slug: 'ada',
      personal: true,
    },
  }
  const app = createApp({
    ...noAuth,
    checkDb: async () => {},
    resolveCaller: async (headers) =>
      headers.get('authorization') === 'Bearer hm_test'
        ? { ok: true, principal, setCookie: [] }
        : { ok: false, error: 'unauthorized', setCookie: [] },
    routes: [uploads],
  })
  const send = (
    method: string,
    body: string,
    { auth = true, headers = {} }: { auth?: boolean; headers?: Record<string, string> } = {},
  ) => {
    const chunked = chunkedBody(body)
    const res = app.request('/api/v1/uploads', {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer hm_test' } : {}),
        ...headers,
      },
      ...chunked.init,
    })
    return { res, pulled: chunked.pulled }
  }
  const upload = (length: number) => JSON.stringify({ data: 'x'.repeat(length) })

  it('refuses an unknown caller without reading its body', async () => {
    const sent = send('POST', upload(1_900_000), { auth: false })
    const res = await sent.res
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    // At most one chunk of read-ahead, not the 1.9 MB the route's limit would allow.
    expect(sent.pulled()).toBeLessThanOrEqual(CHUNK_SIZE)
  })

  it("counts the body against the route's limit while the route reads it", async () => {
    const fits = send('POST', upload(1_900_000))
    expect(await (await fits.res).json()).toEqual({ length: 1_900_000 })
    const tooBig = send('POST', upload(LIMIT))
    const res = await tooBig.res
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Reading stops at the limit.
    expect(tooBig.pulled()).toBeLessThanOrEqual(LIMIT + CHUNK_SIZE)
  })

  it('caps a body longer than its Content-Length', async () => {
    const lying = send('POST', upload(LIMIT), { headers: { 'content-length': '100' } })
    const res = await lying.res
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
    // A declared size over the limit is refused before the caller is even identified.
    const declared = send('POST', upload(10), {
      auth: false,
      headers: { 'content-length': String(LIMIT + 1) },
    })
    expect((await declared.res).status).toBe(413)
    expect(declared.pulled()).toBe(0)
  })

  it('answers 413, not 500, when a handler reads an oversized body itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // DELETE keeps the default limit although POST on the same path declares more.
      const res = await send('DELETE', 'x'.repeat(MAX_BODY_BYTES + 1)).res
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'payload_too_large' })
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
    expect(await (await send('DELETE', 'x'.repeat(MAX_BODY_BYTES)).res).json()).toEqual({
      bytes: MAX_BODY_BYTES,
    })
  })

  it('applies the JSON text guard while the route reads the body', async () => {
    const unsafe = {
      error: 'invalid_request',
      message: 'Text in the request must not contain NUL characters or malformed Unicode',
    }
    // The NUL is in the last chunk: the guard refuses at the end, whoever reads the body.
    const late = JSON.stringify({ data: 'x'.repeat(100_000), other: 'A\u0000B' })
    const viaValidator = await send('POST', late).res
    expect(viaValidator.status).toBe(400)
    expect(await viaValidator.json()).toEqual(unsafe)
    const viaHandler = await send('DELETE', JSON.stringify({ other: 'A\u0000B' })).res
    expect(viaHandler.status).toBe(400)
    expect(await viaHandler.json()).toEqual(unsafe)
    // A character split across chunks reaches the route whole.
    const prefix = '{"data":"'
    const split = `${prefix}${'x'.repeat(CHUNK_SIZE - prefix.length - 2)}👩‍💻"}`
    expect(await (await send('POST', split).res).json()).toEqual({
      length: CHUNK_SIZE - prefix.length - 2 + '👩‍💻'.length,
    })
  })
})
