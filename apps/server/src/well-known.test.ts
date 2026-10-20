import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'

const publicUrl = 'https://instance.example.com'
// These are all the explicitly mounted OAuth discovery paths. The provider deliberately
// returns 404 for the issuer-root alias and disabled OIDC metadata; preserve those too.
const discovery = [
  ['/.well-known/oauth-protected-resource', 200],
  ['/.well-known/oauth-protected-resource/mcp', 200],
  ['/.well-known/oauth-authorization-server', 404],
  ['/.well-known/oauth-authorization-server/api/auth', 200],
  ['/.well-known/openid-configuration/api/auth', 404],
] as const

describe('well-known routing', () => {
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'hourmere-well-known-'))
    await writeFile(join(dist, 'index.html'), '<title>SPA fallback</title>')
    await mkdir(join(dist, '.well-known'))
    await writeFile(join(dist, '.well-known', 'security.txt'), 'Must not publish this policy')
  })
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  for (const withSpa of [false, true]) {
    for (const mode of ['absent', 'api-key', 'oauth'] as const) {
      it(`returns plain-text 404 for unknown resources with SPA=${withSpa}, MCP=${mode}`, async () => {
        const unavailable = async (): Promise<never> => {
          throw new Error('Well-known routing must not depend on authentication or the database')
        }
        const app = createApp({
          publicUrl,
          checkDb: unavailable,
          authHandler: unavailable,
          resolveCaller: unavailable,
          ...(withSpa && { webDist: dist }),
          ...(mode !== 'absent' && {
            mcp: mcpEndpoint({
              tools: [],
              ...(mode === 'oauth' && {
                oauth: {
                  resolve: unavailable,
                  handler: async (request) => {
                    const path = new URL(request.url).pathname
                    const status = discovery.find(([known]) => known === path)?.[1]
                    if (status === undefined) throw new Error('Unexpected provider request')
                    return Response.json({ path }, { status })
                  },
                },
              }),
            }),
          }),
        })
        const paths = [
          '/.well-known/does-not-exist',
          '/.well-known/nested/does-not-exist',
          '/.well-known/security.txt',
          '/.well-known/oauth-protected-resource/does-not-exist',
          '/.well-known/oauth-authorization-server/does-not-exist',
          '/.well-known/openid-configuration/does-not-exist',
          ...(mode !== 'oauth' ? discovery.map(([path]) => path) : []),
        ]
        for (const path of paths) {
          for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
            const response = await app.request(path, { method })
            expect(response.status, `${method} ${path}`).toBe(404)
            expect(response.headers.get('content-type')?.toLowerCase()).toBe(
              'text/plain; charset=utf-8',
            )
            expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found')
          }
        }
        if (mode === 'oauth') {
          for (const [path, status] of discovery) {
            const response = await app.request(path)
            expect(response.status, path).toBe(status)
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(await response.json()).toEqual({ path })
          }
        }
        if (withSpa) {
          const page = await app.request('/sign-in')
          expect(page.status).toBe(200)
          expect(await page.text()).toBe('<title>SPA fallback</title>')
        }
      })
    }
  }
})
