import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { DomainError } from '@hourmere/scheduling'
import type { HTTPException } from 'hono/http-exception'
import { describe, expect, it, vi } from 'vitest'
import type { createApp } from './app.ts'

type AppCopy = {
  createApp: typeof createApp
  DomainError: typeof DomainError
  HTTPException: typeof HTTPException
}
type Replacement = readonly [string, string]

function moduleUrl(file: string, replacement?: Replacement, imports: Record<string, string> = {}) {
  const location = new URL(file, import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (replacement) expect(original.includes(replacement[0]), 'mutation matches source').toBe(true)
  const modified = replacement ? original.replace(...replacement) : original
  const source = stripTypeScriptTypes(modified).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      const resolved =
        imports[specifier] ??
        (specifier.startsWith('node:')
          ? specifier
          : specifier.startsWith('.')
            ? new URL(specifier, location).href
            : import.meta.resolve(specifier))
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

async function copy(
  replacement?: Replacement,
  securityReplacement?: Replacement,
  privacyReplacement?: Replacement,
): Promise<AppCopy> {
  const imports: Record<string, string> = {}
  if (securityReplacement)
    imports['./security-headers.ts'] = moduleUrl('./security-headers.ts', securityReplacement)
  if (privacyReplacement)
    imports['./one-time-link-privacy.ts'] = moduleUrl(
      './one-time-link-privacy.ts',
      privacyReplacement,
    )
  const url = moduleUrl('./app.ts', replacement, imports)
  const source =
    Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString() +
    '\nexport { DomainError, HTTPException };'
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

const token = 'p'.repeat(43)
function application(module: AppCopy) {
  return module.createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    publicUrl: 'http://localhost',
    routes: [
      ({ app }) => {
        app.get('/api/v1/book/:token/ok', (c) => c.json({ ok: true }))
        app.get('/api/v1/book/:token/error', () => {
          throw new module.DomainError('invalid', 'booking_failed', undefined, {
            cause: new TypeError(`Storage unavailable ${token}\nretry later`),
          })
        })
        app.get('/api/v1/book/:token/unexpected', () => {
          throw new Error(`Booking failed ${token}\nretry later`, {
            cause: new TypeError('Underlying driver failed'),
          })
        })
        app.get('/api/v1/book/:token/domain', () => {
          throw new module.DomainError('invalid', 'booking_failed', token)
        })
        app.get('/api/v1/book/:token/http', () => {
          throw new module.HTTPException(400, { message: token })
        })
        app.openapi(
          createRoute({
            method: 'post',
            path: '/api/v1/book/{token}/validate',
            request: {
              body: {
                required: true,
                content: { 'application/json': { schema: z.strictObject({ value: z.string() }) } },
              },
            },
            responses: { 200: { description: 'Accepted' } },
          }),
          (c) => c.json({ ok: true }),
        )
      },
    ],
  })
}

async function verifyLogs(module: AppCopy, route: string) {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  try {
    const app = application(module)
    await app.request(`/api/v1/book/${token}/${route}`)
    expect(spies[0]?.mock.calls).toHaveLength(0)
    if (route === 'error' || route === 'unexpected') {
      expect(spies[2]?.mock.calls.length).toBe(1)
      const line = spies[2]?.mock.calls[0]?.map(String).join(' ') ?? ''
      expect(line).toContain('/book/[redacted]: ')
      expect(line).toContain(
        route === 'error' ? 'TypeError: Storage unavailable' : 'Booking failed',
      )
      if (route === 'unexpected') expect(line).toContain('TypeError: Underlying driver failed')
      expect(line).toContain('at ')
      expect(line).toContain('\\n')
      expect(line.includes('\n')).toBe(false)
    }
    const diagnostics = spies.flatMap((spy) => spy.mock.calls)
    expect(JSON.stringify(diagnostics).includes(token)).toBe(false)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

async function verifyResponse(module: AppCopy, route: string) {
  const response = await application(module).request(
    `/api/v1/book/${token}/${route}`,
    route === 'validate'
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'valid', [token]: true }),
        }
      : undefined,
  )
  expect(response.status, route).toBe(400)
  expect((await response.text()).includes(token)).toBe(false)
}

async function verifyHeaders(module: AppCopy) {
  const response = await application(module).request(`/book/${token}`)
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
}

async function verifyAdminPrivacy(module: AppCopy) {
  const base = '/api/v1/event-types/00000000-0000-4000-8000-000000000000/one-time-links'
  const template = '/api/v1/event-types/:eventTypeId/one-time-links'
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  try {
    const app = module.createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      routes: [
        ({ app }) => {
          app.get(`${template}/unexpected`, () => {
            throw new Error(`Unexpected storage failure ${token}`)
          })
          app.get(`${template}/domain`, () => {
            throw new module.DomainError('invalid', 'invalid_one_time_link', token, {
              cause: new Error(`Driver failed ${token}`),
            })
          })
          app.get(`${template}/http`, () => {
            throw new module.HTTPException(400, { message: token })
          })
          app.get(`${template}/replay`, () => {
            throw new module.DomainError('conflict', 'one_time_link_already_created', token)
          })
          app.openapi(
            createRoute({
              method: 'post',
              path: '/api/v1/event-types/{eventTypeId}/one-time-links/validate',
              request: {
                body: {
                  required: true,
                  content: {
                    'application/json': { schema: z.strictObject({ value: z.string() }) },
                  },
                },
              },
              responses: { 200: { description: 'Accepted' } },
            }),
            (c) => c.json({ ok: true }),
          )
        },
      ],
    })
    for (const [route, status] of [
      ['unexpected', 500],
      ['domain', 400],
      ['http', 400],
      ['replay', 409],
      ['validate', 400],
    ] as const) {
      const response = await app.request(
        `${base}/${route}`,
        route === 'validate'
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ value: 'valid', [token]: true }),
            }
          : undefined,
      )
      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      const body = await response.text()
      expect(body.includes(token)).toBe(false)
      if (route === 'replay') expect(body).toContain('cannot be retrieved')
      expect(spies[0]?.mock.calls.at(-1)).toEqual([
        `--> ${route === 'validate' ? 'POST' : 'GET'} ${template}/${route} ${status}`,
      ])
    }
    expect(spies[2]?.mock.calls.length).toBe(2)
    const errors = spies[2]?.mock.calls.map((values) => values.map(String).join(' ')) ?? []
    expect(errors[0]).toContain(
      ` ERROR GET ${template}/unexpected: Error: Unexpected storage failure`,
    )
    expect(errors[1]).toContain(` ERROR GET ${template}/domain: invalid_one_time_link caused by`)
    expect(JSON.stringify(errors)).not.toContain('/book/[redacted]')
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls)).includes(token)).toBe(false)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

async function verifyAdminRequestLogs(module: AppCopy) {
  const base = '/api/v1/event-types/00000000-0000-4000-8000-000000000000/one-time-links'
  const linkId = '00000000-0000-4000-8000-000000000001'
  const template = '/api/v1/event-types/:eventTypeId/one-time-links'
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const app = module.createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      routes: [
        ({ app }) => {
          app.get(template, (c) => c.json({ data: [] }))
          app.post(template, (c) => c.json({ ok: true, url: `/book/${token}` }, 201))
          app.delete(`${template}/:id`, (c) => c.json({ ok: true }))
        },
      ],
    })
    for (const [method, suffix, status] of [
      ['GET', '', 200],
      ['POST', '', 201],
      ['DELETE', `/${linkId}`, 200],
    ] as const) {
      const response = await app.request(`${base}${suffix}?private-query=${token}`, {
        method,
        ...(method === 'POST' && {
          headers: { 'content-type': 'application/json', 'idempotency-key': token },
          body: JSON.stringify({ prefill: { name: token } }),
        }),
      })
      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(log.mock.calls.at(-1)).toEqual([
        `--> ${method} ${template}${method === 'DELETE' ? '/:id' : ''} ${status}`,
      ])
    }
    expect(log.mock.calls).toHaveLength(3)
    const diagnostics = JSON.stringify(log.mock.calls)
    expect(diagnostics.includes(token)).toBe(false)
    expect(diagnostics).not.toContain('private-query')
    expect(diagnostics).not.toContain(base)
    expect(diagnostics).not.toContain(linkId)
  } finally {
    log.mockRestore()
  }
}

describe('one-time capability privacy source-copy controls', () => {
  it('runs real log, response and header assertions against the unmodified source', async () => {
    const module = await copy()
    await verifyLogs(module, 'ok')
    await verifyLogs(module, 'error')
    await verifyLogs(module, 'unexpected')
    for (const route of ['domain', 'http', 'validate']) await verifyResponse(module, route)
    await verifyHeaders(module)
    await verifyAdminPrivacy(module)
  })
  it('logs management methods, registered route templates and statuses without request or response data', async () => {
    await verifyAdminRequestLogs(await copy())
  })
  it('detects skipping administration request logs', async () => {
    const module = await copy([
      'if (!isOneTimeLinkPath(c.req.path)) return ordinaryRequestLogger(c, next)',
      'if (isOneTimeLinkPath(c.req.path)) return next()',
    ])
    await expect(verifyAdminRequestLogs(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects management request paths replacing registered route templates', async () => {
    const module = await copy([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mutating literal source text
      '${routePath(c)} ${c.res.status}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mutating literal source text
      '${c.req.path} ${c.res.status}',
    ])
    await expect(verifyAdminRequestLogs(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects public booking labels replacing management error route templates', async () => {
    const module = await copy(['? routePath(c)', "? '/book/[redacted]'"])
    await expect(verifyAdminPrivacy(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects missing administration privacy coverage with real captured diagnostics and responses', async () => {
    const module = await copy(undefined, undefined, [
      ' || /(?:^|\\/)one-time-links(?:\\/|$)/i.test(path)',
      '',
    ])
    await expect(verifyAdminPrivacy(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects passing capability requests to the URL logger', async () => {
    const module = await copy([
      'if (isOneTimeCapabilityPath(c.req.path)) return next()',
      'if (false) return next()',
    ])
    await expect(verifyLogs(module, 'ok')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects raw unexpected-error details entering the log', async () => {
    const module = await copy(['redactOneTimeLogDetails(message)', 'text'])
    await expect(verifyLogs(module, 'error')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects dropping private error diagnostics', async () => {
    const module = await copy(['redactOneTimeLogDetails(message)', "'request failed'"])
    await expect(verifyLogs(module, 'unexpected')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('detects removing capability redaction from diagnostics', async () => {
    const module = await copy(undefined, undefined, [
      ".replace(/[A-Za-z0-9_-]{43,}/g, '[redacted capability]')",
      '',
    ])
    await expect(verifyLogs(module, 'error')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects reflected domain-error details', async () => {
    const module = await copy(['err.detail && !isOneTimeLinkPath(c.req.path)', 'err.detail'])
    await expect(verifyResponse(module, 'domain')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects reflected HTTP error messages', async () => {
    const module = await copy(['err.message && !isOneTimeLinkPath(c.req.path)', 'err.message'])
    await expect(verifyResponse(module, 'http')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects reflected validation input', async () => {
    const module = await copy([
      "if (isOneTimeLinkPath(c.req.path)) return c.json({ error: 'invalid_request' }, 400)",
      "if (false) return c.json({ error: 'invalid_request' }, 400)",
    ])
    await expect(verifyResponse(module, 'validate')).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('detects removing the capability cache protection', async () => {
    const module = await copy(undefined, ["headers.set('Cache-Control', 'no-store')", 'void 0'])
    await expect(verifyHeaders(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects removing the capability referrer protection', async () => {
    const module = await copy(undefined, ['if (isOneTimeLinkPath(c.req.path)) {', 'if (false) {'])
    await expect(verifyHeaders(module)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
