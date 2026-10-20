import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

describe('hosted security.txt', () => {
  let dist: string
  let policy: string

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-security-txt-'))
    await writeFile(join(dist, 'index.html'), '<title>SPA fallback</title>')
    policy = await readFile(
      new URL('../../site/public/.well-known/security.txt', import.meta.url),
      'utf8',
    )
  })

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  for (const withSpa of [false, true]) {
    it(`serves the website policy as plain text with SPA=${withSpa}`, async () => {
      const unavailable = async (): Promise<never> => {
        throw new Error('Security disclosure must not depend on authentication or the database')
      }
      const app = createApp({
        publicUrl: 'https://app.hourmere.com',
        checkDb: unavailable,
        authHandler: unavailable,
        resolveCaller: unavailable,
        ...(withSpa && { webDist: dist }),
      })
      const response = await app.request('/.well-known/security.txt')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')?.toLowerCase()).toBe('text/plain; charset=utf-8')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
      expect(await response.text()).toBe(policy)

      const head = await app.request('/.well-known/security.txt', { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-type')?.toLowerCase()).toBe('text/plain; charset=utf-8')
      expect(await head.text()).toBe('')
    })
  }
})
