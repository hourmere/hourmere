import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactLogDetails } from '@hourmere/auth'
import { embedParent } from '@hourmere/core/embed'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { logger } from 'hono/logger'
import { routePath } from 'hono/route'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { isOneTimeCapabilityPath, isOneTimeLinkPath } from './one-time-link-privacy.ts'
import { securityHeaders } from './security-headers.ts'

const token = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
const encodedToken = [...token].map((letter) => `%${letter.charCodeAt(0).toString(16)}`).join('')
const suggested = encodeURIComponent('2026-11-02T14:00:00.000Z')

function copy<T>(
  path: string,
  exported: string,
  before: string,
  after: string,
  bindings: Record<string, unknown>,
): T {
  let source = readFileSync(path, 'utf8')
  expect(source.includes(before), 'mutation must match source').toBe(true)
  source = source.replaceAll(before, after)
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(...Object.keys(bindings), `${source}; return ${exported}`)(
    ...Object.values(bindings),
  ) as T
}
async function assertHeaders(
  headers = securityHeaders,
  name = 'Referrer-Policy',
  expected = 'no-referrer',
) {
  const app = new Hono()
  app.onError((error) => {
    throw error
  })
  app.use('*', headers())
  app.get('*', (c) => c.html('<title>Booking</title>'))
  const response = await app.request(`/ada/intro/waitlist/${token}/${suggested}`)
  expect(response.status).toBe(200)
  expect(response.headers.get(name), `${name} on the successful waitlist page`).toBe(expected)
}

describe('waitlist path capability privacy', () => {
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-link-'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Booking</title>')
  })
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  function app() {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'https://schedule.example',
      webDist: dist,
      routes: [
        ({ app }) => {
          app.get('/fail/:token', () => {
            throw new Error(`Synthetic failure ${token}`)
          })
          app.get('/fail-encoded', () => {
            throw new Error(`Synthetic URL /ada/intro/%77aitlist/${encodedToken}/time`)
          })
        },
      ],
    })
  }

  it('keeps personal and team booking links no-referrer and no-store', async () => {
    const a = app()
    for (const prefix of ['/ada/intro', '/team/alpha/intro']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await a.request(`${prefix}/waitlist/${token}/${suggested}`, { method })
        expect(response.status).toBe(200)
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
      }
    }
  })

  it('redacts full capabilities in errors, request logs and encoded paths', async () => {
    const output: unknown[][] = []
    const spies = (['log', 'error', 'warn'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...values) => {
        output.push(values)
      }),
    )
    try {
      const a = app()
      expect((await a.request(`/fail/${token}`)).status).toBe(500)
      expect((await a.request('/fail-encoded')).status).toBe(500)
      await a.request(`/api/v1/waitlist/${token}/${suggested}`)
      expect(output.length).toBeGreaterThan(0)
      expect(JSON.stringify(output).includes(token)).toBe(false)
      expect(JSON.stringify(output).includes('w'.repeat(42))).toBe(false)
      expect(JSON.stringify(output).includes('%77'.repeat(42))).toBe(false)
      for (const value of [
        token,
        token.replaceAll('.', '%2E'),
        token.replace('.w', '.%77'),
        encodedToken,
      ]) {
        for (const segment of ['waitlist', '%77aitlist', '%77%61%69%74%6c%69%73%74']) {
          const redacted = redactLogDetails(
            `https://schedule.example/ada/intro/${segment}/${value}/${suggested}`,
          )
          expect(redacted.includes('w'.repeat(42))).toBe(false)
          expect(redacted.includes('%77'.repeat(42))).toBe(false)
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('retains ordinary booking UUIDs in request lines while stripping queries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const id = '00000000-0000-4000-8000-000000000092'
      await app().request(`/api/v1/bookings/${id}?private-query`)
      expect(log.mock.calls.length).toBeGreaterThan(0)
      const output = JSON.stringify(log.mock.calls)
      expect(output.includes(`/api/v1/bookings/${id}`)).toBe(true)
      expect(output.includes('private-query')).toBe(false)
    } finally {
      log.mockRestore()
    }
  })
})

describe('waitlist capability privacy source-copy controls', () => {
  it.each([
    ['Referrer-Policy', "headers.set('Referrer-Policy', 'no-referrer')", 'no-referrer'],
    ['Cache-Control', "headers.set('Cache-Control', 'no-store')", 'no-store'],
  ])('detects removal of %s from path booking responses', async (name, before, expected) => {
    await assertHeaders(securityHeaders, name, expected)
    const bindings = { isIP, embedParent, createMiddleware, isOneTimeLinkPath }
    const unchanged = copy<typeof securityHeaders>(
      'apps/server/src/security-headers.ts',
      'securityHeaders',
      before,
      before,
      bindings,
    )
    await assertHeaders(unchanged, name, expected)
    const copied = copy<typeof securityHeaders>(
      'apps/server/src/security-headers.ts',
      'securityHeaders',
      before,
      '',
      bindings,
    )
    await expect(assertHeaders(copied, name, expected)).rejects.toThrow(
      expect.objectContaining({
        name: 'AssertionError',
        message: expect.stringContaining(`${name} on the successful waitlist page`),
      }),
    )
    await assertHeaders(unchanged, name, expected)
  })
  it('propagates runtime faults instead of counting them as header mutation failures', async () => {
    const before = "headers.set('Cache-Control', 'no-store')"
    const copied = copy<typeof securityHeaders>(
      'apps/server/src/security-headers.ts',
      'securityHeaders',
      before,
      before,
      { isIP, embedParent, createMiddleware },
    )
    await expect(assertHeaders(copied)).rejects.toMatchObject({ name: 'ReferenceError' })
  })
  it('detects bypassing capability redaction in the request logger', async () => {
    const source = readFileSync('apps/server/src/app.ts', 'utf8')
    const start = source.indexOf('function isWaitlistLinkPath(')
    const code = source.slice(start, source.indexOf('export function createApp', start))
    const assertion = async (value: string) => {
      const output: unknown[][] = []
      const middleware = new Function(
        'logger',
        'console',
        'escapeControlCharacters',
        'redactLogDetails',
        'createMiddleware',
        'isOneTimeCapabilityPath',
        'isOneTimeLinkPath',
        'isSlackDestinationPath',
        'routePath',
        'COLORS',
        `${stripTypeScriptTypes(value)}; return requestLogger`,
      )(
        logger,
        { log: (...values: unknown[]) => output.push(values) },
        (line: string) => line,
        redactLogDetails,
        createMiddleware,
        isOneTimeCapabilityPath,
        isOneTimeLinkPath,
        (path: string) => /^\/api\/v1\/slack-destinations(?:\/|$)/i.test(path),
        routePath,
        /x^/,
      )
      const app = new Hono()
      app.use('*', middleware)
      app.get('*', (c) => c.text('ok'))
      for (const segment of ['waitlist', '%77aitlist']) {
        await app.request(`/ada/intro/${segment}/${token}/${suggested}`)
      }
      await app.request(`/team/alpha/intro/waitlist/${token}/${suggested}`)
      await app.request(`/ada%2Fintro%2Fwaitlist%2F${token}`)
      expect(JSON.stringify(output).includes('w'.repeat(43))).toBe(false)
    }
    await assertion(code)
    const before = 'isWaitlistLinkPath(c.req.path)'
    expect(code.includes(before)).toBe(true)
    await expect(assertion(code.replace(before, 'false'))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects blanket UUID redaction in ordinary request lines', async () => {
    const source = readFileSync('apps/server/src/app.ts', 'utf8')
    const start = source.indexOf('function isWaitlistLinkPath(')
    const code = source.slice(start, source.indexOf('export function createApp', start))
    const assertion = async (value: string) => {
      const output: unknown[][] = []
      const middleware = new Function(
        'logger',
        'console',
        'escapeControlCharacters',
        'redactLogDetails',
        'createMiddleware',
        'isOneTimeCapabilityPath',
        'isOneTimeLinkPath',
        'isSlackDestinationPath',
        'routePath',
        'COLORS',
        `${stripTypeScriptTypes(value)}; return requestLogger`,
      )(
        logger,
        { log: (...values: unknown[]) => output.push(values) },
        (line: string) => line,
        redactLogDetails,
        createMiddleware,
        isOneTimeCapabilityPath,
        isOneTimeLinkPath,
        (path: string) => /^\/api\/v1\/slack-destinations(?:\/|$)/i.test(path),
        routePath,
        /x^/,
      )
      const app = new Hono()
      app.use('*', middleware)
      app.get('*', (c) => c.text('ok'))
      const id = '00000000-0000-4000-8000-000000000092'
      await app.request(`/api/v1/bookings/${id}?private-query`)
      const logged = JSON.stringify(output)
      expect(logged.includes(`/api/v1/bookings/${id}`)).toBe(true)
      expect(logged.includes('private-query')).toBe(false)
      for (const path of [
        '/waitlist/intro',
        '/team/waitlist/intro',
        '/api/v1/public/waitlist/intro',
        '/api/v1/public/team/waitlist/intro',
        '/booking/waitlist/verify',
        '/booking/waitlist/remove',
      ]) {
        const count = output.length
        await app.request(path)
        expect(output.length).toBeGreaterThan(count)
        expect(JSON.stringify(output.slice(count)).includes(path)).toBe(true)
      }
    }
    await assertion(code)
    const before = "line.replace(/\\?\\S*/, '').replace(COLORS, '')"
    expect(code.includes(before)).toBe(true)
    await expect(assertion(code.replace(before, `redactLogDetails(${before})`))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    const route = 'isWaitlistLinkPath(c.req.path)'
    await expect(
      assertion(code.replace(route, '/\\/waitlist\\//i.test(c.req.path)')),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})

describe('encoded and diagnostic capability source-copy controls', () => {
  const source = readFileSync('packages/auth/src/log.ts', 'utf8')
  function redactorCopy(value: string): typeof redactLogDetails {
    return new Function(
      `${stripTypeScriptTypes(value.replace(/^import[^\n]*\n/gm, '')).replace(/\bexport /g, '')}; return redactLogDetails`,
    )()
  }
  function assertRedacted(redact = redactLogDetails) {
    expect(redact(`Synthetic failure ${token}`).includes('w'.repeat(43))).toBe(false)
    const output = redact(`GET /ada/intro/waitlist/${encodedToken}/time?private-query`)
    expect(output.includes('%77')).toBe(false)
    expect(output.includes('private-query')).toBe(false)
    for (const diagnostic of [
      `GET /ada/intro/%77aitlist/${encodedToken}/time`,
      `GET %2fada%2fintro%2f%77aitlist%2f${encodedToken}%2ftime`,
      `Synthetic failure ${encodedToken}`,
    ]) {
      expect(redact(diagnostic).includes('%77'.repeat(43))).toBe(false)
    }
    for (const path of ['/waitlist/intro', '/team/waitlist/intro', '/%77aitlist/intro'])
      expect(redact(path)).toBe(path)
  }
  it('keeps all source-copy diagnostic and encoded-path assertions passing', () =>
    assertRedacted(redactorCopy(source)))
  it('detects removing capability redaction from an isolated source copy', () => {
    assertRedacted()
    const index = source.indexOf("'[redacted waitlist token]'")
    expect(index).toBeGreaterThan(0)
    const start = source.lastIndexOf('.replace(', index)
    const end = source.indexOf('\n      )', index) + '\n      )'.length
    const copied = redactorCopy(source.slice(0, start) + source.slice(end))
    expect(() => assertRedacted(copied)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects blanket redaction of ordinary waitlist handle paths', () => {
    const before = ".replace(UUID, '[redacted UUID]')"
    expect(source.includes(before), 'mutation must match source').toBe(true)
    const copied = redactorCopy(
      source.replace(before, `${before}.replace(/(\\/waitlist\\/)[^\\s/]+/gi, '$1[redacted]')`),
    )
    expect(() => assertRedacted(copied)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects bypassing candidate decoding in an isolated source copy', () => {
    const before = 'decodeURIComponent(token)'
    expect(source.includes(before), 'mutation must match source').toBe(true)
    const copied = redactorCopy(source.replace(before, 'token'))
    expect(() => assertRedacted(copied)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
