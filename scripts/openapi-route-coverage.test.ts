import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createApp } from '../apps/server/src/app.ts'
import { openApiRouteInventory } from '../apps/server/src/openapi-document.ts'
import { undocumentedWriteRoutes } from './openapi-route-coverage.ts'

type Checker = typeof undocumentedWriteRoutes
const source = readFileSync(new URL('./openapi-route-coverage.ts', import.meta.url), 'utf8')

function verify(check: Checker) {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const route = { method, path: '/api/v1/widgets/:id' }
    expect(check([route, route], { paths: {} })).toEqual([
      `${method} /api/v1/widgets/:id: register every /api/v1 write with app.openapi().`,
    ])
    expect(
      check([route], { paths: { '/api/v1/widgets/{id}': { [method.toLowerCase()]: {} } } }),
    ).toEqual([])
    expect(check([route], { paths: { '/api/v1/widgets/{id}': { get: {} } } })).toHaveLength(1)
    expect(check([{ method, path: '/api/v1' }], { paths: {} })).toHaveLength(1)
    expect(check([{ method, path: '/api/v10/widget' }], { paths: {} })).toEqual([])
    expect(check([{ method, path: '/api/auth/widget' }], { paths: {} })).toEqual([])
  }
  expect(
    check(
      [
        { method: 'GET', path: '/api/v1/widgets' },
        { method: 'ALL', path: '/api/v1/*' },
      ],
      { paths: {} },
    ),
  ).toEqual([])
}

describe('registered REST writes appear in OpenAPI', () => {
  it('checks every product route from the actual server composition without opening a pool', async () => {
    const { routes, document } = await openApiRouteInventory()
    expect(routes.some(({ method }) => method === 'POST')).toBe(true)
    const errors = undocumentedWriteRoutes(routes, document as Parameters<Checker>[1])
    expect(errors, `Undocumented REST writes:\n${errors.join('\n')}`).toEqual([])
  })

  it('rejects a plain Hono write registered without OpenAPI metadata', async () => {
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost',
      routes: [({ app }) => app.post('/api/v1/unlisted/:id', (c) => c.json({ ok: true }))],
    })
    const response = await app.request('/api/v1/openapi.json')
    expect(response.status).toBe(200)
    expect(undocumentedWriteRoutes(app.routes, await response.json())).toEqual([
      'POST /api/v1/unlisted/:id: register every /api/v1 write with app.openapi().',
    ])
  })

  it('checks all four write methods, paths and normalized route parameters', () => {
    verify(undocumentedWriteRoutes)
  })
})

function sourceCopy(copy: string): Checker {
  const body = stripTypeScriptTypes(copy).replace(/^export /gm, '')
  return new Function(`${body}\nreturn undocumentedWriteRoutes`)() as Checker
}

describe('source-copy route coverage mutation checks', () => {
  it('passes the same assertions with the unchanged source', () => verify(sourceCopy(source)))

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`detects removal of ${method} coverage`, () => {
      const mutant = source.replace(`'${method}', `, '').replace(`, '${method}'`, '')
      expect(mutant).not.toBe(source)
      expect(() => verify(sourceCopy(mutant))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }
  for (const [name, from, to] of [
    ['route prefix', "path !== '/api/v1' && !path.startsWith('/api/v1/')", 'false'],
    ['parameter normalization', "path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')", 'path'],
    [
      'missing documentation',
      '!Object.hasOwn(document.paths[openApiPath] ?? {}, method.toLowerCase())',
      'false',
    ],
  ] as const) {
    it(`detects removal of ${name}`, () => {
      const mutant = source.replace(from, to)
      expect(mutant).not.toBe(source)
      expect(() => verify(sourceCopy(mutant))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }
})
