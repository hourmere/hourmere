import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pwaStatic } from './pwa-static.ts'

type Change = readonly [string, string]

function sourceCopy<T>(file: string, name: string, change?: Change): T {
  let source = readFileSync(new URL(file, import.meta.url), 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function('serveStatic', `${source}; return ${name}`)(serveStatic) as T
}

describe('PWA static response protections', () => {
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-pwa-server-'))
    await mkdir(join(dist, 'app'))
    await writeFile(join(dist, 'app/sw.js'), '// synthetic worker')
    await writeFile(join(dist, 'app/manifest.webmanifest'), '{"name":"Hourmere"}')
  })
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  async function verify(factory = pwaStatic) {
    const app = new Hono()
    app.on(
      'GET',
      ['/app/sw.js', '/app/manifest.webmanifest'],
      factory(relative(process.cwd(), dist)),
    )
    app.get('/missing/*', factory(relative(process.cwd(), dist)))
    app.get('*', (c) => c.html('<title>SPA fallback</title>'))
    const worker = await app.request('/app/sw.js')
    expect(worker.status).toBe(200)
    expect(await worker.text()).toBe('// synthetic worker')
    expect(worker.headers.get('cache-control')).toBe('no-cache')
    expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(worker.headers.get('service-worker-allowed')).toBe('/app/')
    const manifest = await app.request('/app/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toEqual({ name: 'Hourmere' })
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8')
    expect(manifest.headers.get('service-worker-allowed')).toBeNull()
    const missing = await app.request('/missing/sw.js')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('Not found')
    expect(missing.headers.get('content-type')).toMatch(/^text\/plain/)
  }

  it('serves only static bytes and rejects missing resources', () => verify())
  it('passes the same assertions with an unchanged source copy', () =>
    verify(sourceCopy('./pwa-static.ts', 'pwaStatic')))

  it.each([
    ['revalidation', "'Cache-Control', 'no-cache'", "'Cache-Control', 'max-age=31536000'"],
    ['scope boundary', "'Service-Worker-Allowed', '/app/'", "'Service-Worker-Allowed', '/'"],
    ['worker MIME', 'text/javascript; charset=utf-8', 'text/html; charset=utf-8'],
    ['manifest MIME', 'application/manifest+json; charset=utf-8', 'text/html; charset=utf-8'],
    ['real missing status', "c.text('Not found', 404)", "c.text('Not found', 200)"],
  ])('kills weakened %s with a real assertion', async (_, from, to) => {
    await expect(
      verify(sourceCopy('./pwa-static.ts', 'pwaStatic', [from, to])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  function verifyPolicy(policy: string) {
    expect(policy.split('; ')).toContain("worker-src 'self'")
    expect(policy.split('; ')).toContain("manifest-src 'self'")
  }
  it('preserves the explicit same-origin CSP in an unchanged source copy', () => {
    verifyPolicy(sourceCopy('./security-headers.ts', 'APP_CSP'))
  })
  it.each(['worker-src', 'manifest-src'])(
    'kills broadened %s with a real assertion',
    (directive) => {
      expect(() =>
        verifyPolicy(
          sourceCopy('./security-headers.ts', 'APP_CSP', [`${directive} 'self'`, `${directive} *`]),
        ),
      ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
    },
  )
})
