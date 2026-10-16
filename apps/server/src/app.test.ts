import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    const app = createApp({ checkDb: async () => {} })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('reports 503 when the database is unreachable', async () => {
    const app = createApp({
      checkDb: async () => {
        throw new Error('connection refused')
      },
    })
    const res = await app.request('/api/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'degraded', database: 'unreachable' })
  })
})

describe('API surface', () => {
  const app = createApp({ checkDb: async () => {} })

  it('publishes an OpenAPI document that lists the health route', async () => {
    const res = await app.request('/api/v1/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toContain('/api/health')
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
    app = createApp({ checkDb: async () => {}, webDist: dist })
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
})
