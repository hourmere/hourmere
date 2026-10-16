import { describe, expect, it } from 'vitest'
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
    const res = await app.request('/api/openapi.json')
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
