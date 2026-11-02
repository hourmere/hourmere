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
): Promise<AppCopy> {
  const imports: Record<string, string> = securityReplacement
    ? { './security-headers.ts': moduleUrl('./security-headers.ts', securityReplacement) }
    : {}
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
            cause: { capability: token },
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
    if (route === 'error') expect(spies[2]?.mock.calls.length).toBe(1)
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

describe('one-time capability privacy source-copy controls', () => {
  it('runs real log, response and header assertions against the unmodified source', async () => {
    const module = await copy()
    await verifyLogs(module, 'ok')
    await verifyLogs(module, 'error')
    for (const route of ['domain', 'http', 'validate']) await verifyResponse(module, route)
    await verifyHeaders(module)
  })
  it('detects passing capability requests to the URL logger', async () => {
    const module = await copy([
      'isOneTimeLinkPath(c.req.path) ? next() : ordinaryRequestLogger(c, next)',
      'ordinaryRequestLogger(c, next)',
    ])
    await expect(verifyLogs(module, 'ok')).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects raw unexpected-error details entering the log', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: mutating literal source text
    const module = await copy(['? `${c.req.method} /book/[redacted]: request failed`', '? text'])
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
