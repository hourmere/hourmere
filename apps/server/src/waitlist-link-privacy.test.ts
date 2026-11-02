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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { securityHeaders } from './security-headers.ts'

const token = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
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
  app.use('*', headers())
  app.get('*', (c) => c.html('<title>Booking</title>'))
  const response = await app.request(`/ada/intro/waitlist/${token}/${suggested}`)
  expect(response.headers.get(name)).toBe(expected)
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
      await a.request(`/api/v1/unknown/waitlist/${token}/${suggested}`)
      expect(output.length).toBeGreaterThan(0)
      expect(JSON.stringify(output).includes(token)).toBe(false)
      expect(JSON.stringify(output).includes('w'.repeat(42))).toBe(false)
      for (const value of [
        token,
        token.replace('.', '%2E'),
        token.replace('.w', '.%77'),
        [...token].map((letter) => `%${letter.charCodeAt(0).toString(16)}`).join(''),
      ]) {
        expect(
          redactLogDetails(
            `https://schedule.example/ada/intro/waitlist/${value}/${suggested}`,
          ).includes('w'.repeat(42)),
        ).toBe(false)
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('waitlist capability privacy source-copy controls', () => {
  it.each([
    ['Referrer-Policy', "headers.set('Referrer-Policy', 'no-referrer')", 'no-referrer'],
    ['Cache-Control', "headers.set('Cache-Control', 'no-store')", 'no-store'],
  ])('detects removal of %s from path booking responses', async (name, before, expected) => {
    await assertHeaders(securityHeaders, name, expected)
    const copied = copy<typeof securityHeaders>(
      'apps/server/src/security-headers.ts',
      'securityHeaders',
      before,
      '',
      { isIP, embedParent, createMiddleware },
    )
    await expect(assertHeaders(copied, name, expected)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects bypassing capability redaction in the request logger', async () => {
    const source = readFileSync('apps/server/src/app.ts', 'utf8')
    const start = source.indexOf('const requestLogger =')
    const code = source.slice(start, source.indexOf('export function createApp', start))
    const assertion = async (value: string) => {
      const output: unknown[][] = []
      const middleware = new Function(
        'logger',
        'console',
        'escapeControlCharacters',
        'redactLogDetails',
        'COLORS',
        `${value}; return requestLogger`,
      )(
        logger,
        { log: (...values: unknown[]) => output.push(values) },
        (line: string) => line,
        redactLogDetails,
        /x^/,
      )
      const app = new Hono()
      app.use('*', middleware)
      app.get('*', (c) => c.text('ok'))
      await app.request(`/api/waitlist/${token}/${suggested}`)
      expect(JSON.stringify(output).includes('w'.repeat(43))).toBe(false)
    }
    await assertion(code)
    const before = "redactLogDetails(line.replace(COLORS, ''))"
    expect(code.includes(before)).toBe(true)
    await expect(assertion(code.replace(before, "line.replace(COLORS, '')"))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
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
    const encoded = [...token].map((letter) => `%${letter.charCodeAt(0).toString(16)}`).join('')
    const output = redact(`GET /ada/intro/waitlist/${encoded}/time?private-query`)
    expect(output.includes('%77')).toBe(false)
    expect(output.includes('private-query')).toBe(false)
  }
  it('keeps all source-copy diagnostic and encoded-path assertions passing', () =>
    assertRedacted(redactorCopy(source)))
  it.each(["'$1[redacted waitlist token]'", "'[redacted waitlist token]'"])(
    'detects removing %s redaction',
    (marker) => {
      assertRedacted()
      const index = source.indexOf(marker)
      expect(index).toBeGreaterThan(0)
      const start = source.lastIndexOf('.replace(', index)
      const end = source.indexOf('\n      )', index) + '\n      )'.length
      const copied = redactorCopy(source.slice(0, start) + source.slice(end))
      expect(() => assertRedacted(copied)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )
})
