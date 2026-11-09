import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { COMMANDS, REST_COMMANDS } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { openApiDocument, openApiRouteInventory } from './openapi-document.ts'
import { productRoutes, productTools } from './server.ts'

// Match camelCase operation ids as well as path segments, tool and command names.
function isSsoName(name: string) {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return (
    /saml|oidc|openid/i.test(name) ||
    tokens.some((token) => /^sso\d*$/.test(token)) ||
    tokens.join('_').includes('single_sign_on')
  )
}
const design = await readFile(new URL('../../../docs/sso.md', import.meta.url), 'utf8')
const ssoOperationIds = [
  ...design.matchAll(/^\| (?:GET|POST|PATCH|PUT|DELETE) .*?\| `([^`]+)` \|/gm),
].flatMap((match) => match[1] ?? [])

function expectNoSso(names: string[]) {
  expect(names.filter((name) => isSsoName(name) || ssoOperationIds.includes(name))).toEqual([])
}

type Document = { paths: Record<string, Record<string, { operationId?: string }>> }
function expectNoSsoOperations(document: Document) {
  expectNoSso(Object.keys(document.paths))
  expectNoSso(
    Object.values(document.paths).flatMap((path) =>
      Object.values(path).flatMap((operation) => operation.operationId ?? []),
    ),
  )
}

// Parse syntax rather than hashing source: unrelated routes, formatting and comments
// can evolve. Inspect route attributes (including component names/expressions) and
// the shared path definitions, so both literal and PATHS-based SSO routes are caught.
// Scope: JSX <Route> attributes in apps/web/src/App.tsx (including nested <Routes>)
// and strings/template parts/identifiers in apps/web/src/paths.ts. This does not
// inspect imported route components, other files, or route-object definitions;
// extend this inventory when the web routing sources change.
function webRouteNames(app: string, paths: string) {
  const names: string[] = []
  for (const [file, source] of [
    ['App.tsx', app],
    ['paths.ts', paths],
  ] as const) {
    const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    function visit(value: unknown) {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const child of value) visit(child)
        return
      }
      const node = value as {
        type?: string
        name?: { name?: string }
        start?: number
        end?: number
      }
      if (
        (node.type === 'JSXOpeningElement' && node.name?.name === 'Route') ||
        (file === 'paths.ts' &&
          ['StringLiteral', 'TemplateElement', 'Identifier'].includes(node.type ?? ''))
      )
        names.push(source.slice(node.start, node.end))
      for (const child of Object.values(value)) visit(child)
    }
    visit(tree)
  }
  return names
}

describe('SSO hard-off excludes only SSO from the published catalogues', () => {
  it('publishes no SSO OpenAPI paths or designed operation ids', async () => {
    expectNoSsoOperations((await openApiDocument()) as Document)
  })

  it('registers no SSO route, including handlers omitted from OpenAPI', async () => {
    const { routes } = await openApiRouteInventory()
    expectNoSso(routes.map(({ path }) => path))
    const plainRoutes = new Hono()
    plainRoutes.get('/api/v1/associations', (c) => c.json({}))
    expectNoSso(plainRoutes.routes.map(({ path }) => path))
    plainRoutes.get('/api/v1/saml2/metadata', (c) => c.json({}))
    expect(() => expectNoSso(plainRoutes.routes.map(({ path }) => path))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('keeps the MCP tools advertised to a full-scope caller', async () => {
    // tools/list never accesses the database; this pool is never connected.
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    const principal: Principal = {
      kind: 'api_key',
      apiKeyScope: 'full',
      apiKeyId: '00000000-0000-7000-8000-000000000001',
      user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
      organization: {
        id: '00000000-0000-7000-8000-000000000003',
        name: 'Ada',
        slug: 'ada',
        personal: true,
      },
    }
    const client = new Client({ name: 'catalogue-test', version: '1.0.0' })
    try {
      const app = createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
        publicUrl: 'http://localhost',
        mcp: mcpEndpoint({ tools: productTools({ db }) }),
      })
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: async (input, init) => app.request(input, init),
          requestInit: { headers: { authorization: 'Bearer hm_catalogue' } },
        }),
      )
      expectNoSso((await client.listTools()).tools.map((tool) => tool.name))
    } finally {
      await client.close()
      await db.destroy()
    }
  })

  it('publishes the new instance capabilities as optional booleans on an open object', async () => {
    const document = (await openApiDocument()) as {
      components: {
        schemas: {
          Instance: {
            properties: Record<string, unknown>
            required?: string[]
            additionalProperties?: unknown
          }
        }
      }
    }
    const instance = document.components.schemas.Instance
    expect(instance.additionalProperties).not.toBe(false)
    for (const field of ['ssoOidcEnabled', 'ssoSamlEnabled']) {
      expect(instance.properties[field]).toMatchObject({ type: 'boolean' })
      expect(instance.required ?? []).not.toContain(field)
    }
  })

  it('publishes no SSO CLI commands or targets', () => {
    expectNoSso(Object.entries({ ...COMMANDS, ...REST_COMMANDS }).flat())
  })

  it('publishes no SSO web routes or shared paths', async () => {
    const [app, paths] = await Promise.all([
      readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../web/src/paths.ts', import.meta.url), 'utf8'),
    ])
    expectNoSso(webRouteNames(app, paths))
    // Source-copy probes exercise the same assertion as the real route sources.
    expectNoSso(
      webRouteNames(
        `${app}\n<Route path="/app/associations" element={<AssociationsPage />} />`,
        paths,
      ),
    )
    for (const name of ['sso', 'SAML', 'oidc']) {
      expect(() =>
        expectNoSso(webRouteNames(`${app}\n<Route path="/app/${name}" />`, paths)),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
      expect(() =>
        expectNoSso(webRouteNames(app, `${paths}\nexport const nextPath = '/app/${name}'`)),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    }
  })

  it('allows unrelated operations but rejects SSO paths and every designed operation id', async () => {
    expect(ssoOperationIds).toHaveLength(19)
    const document = (await openApiDocument()) as Document
    const withOperation = (path: string, operationId: string): Document => ({
      paths: { ...document.paths, [path]: { get: { operationId } } },
    })
    expectNoSsoOperations(withOperation('/api/v1/associations', 'listAssociations'))
    for (const name of ['sso', 'SAML', 'oidc']) {
      expect(() => expectNoSsoOperations(withOperation(`/api/v1/${name}`, 'listReports'))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      expect(() => expectNoSso([`list_${name}_providers`])).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      expect(() => expectNoSso([`${name} providers list`])).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
    for (const operationId of ssoOperationIds) {
      expect(() => expectNoSsoOperations(withOperation('/api/v1/providers', operationId))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
    expectNoSso(['list_associations', 'associations list'])
  })

  it.each([
    ['saml2/metadata', 'getSaml2Metadata', 'saml2_metadata'],
    ['single-sign-on', 'getSingleSignOn', 'single_sign_on'],
    ['singleSignOn', 'singleSignOnMetadata', 'singleSignOn'],
    ['openid-connect', 'getOpenidConnect', 'openid_connect'],
    ['sso2', 'getSso2Metadata', 'sso2_metadata'],
    ['customSAMLmetadata', 'getCustomSAMLmetadata', 'customSAMLmetadata'],
    ['customOIDCmetadata', 'getCustomOIDCmetadata', 'customOIDCmetadata'],
  ])('rejects %s names on every catalogue surface', (path, operationId, tool) => {
    const rejects = (check: () => void) =>
      expect(check).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    rejects(() => expectNoSsoOperations({ paths: { [`/api/v1/${path}`]: { get: {} } } }))
    rejects(() => expectNoSsoOperations({ paths: { '/api/v1/reports': { get: { operationId } } } }))
    rejects(() => expectNoSso([tool]))
    rejects(() => expectNoSso([`${path} metadata`]))
    rejects(() => expectNoSso([`GET /api/v1/${path}`]))
    rejects(() => expectNoSso(webRouteNames(`<Routes><Route path="/app/${path}" /></Routes>`, '')))
    rejects(() => expectNoSso(webRouteNames('', `export const nextPath = '/app/${path}'`)))
  })

  it.each(['associations', 'lasso', 'associated', 'blossom'])(
    'allows unrelated %s names on every catalogue surface',
    (name) => {
      expectNoSsoOperations({
        paths: { [`/api/v1/${name}`]: { get: { operationId: `get${name}` } } },
      })
      expectNoSso([`list_${name}`, `${name} list`, `GET /api/v1/${name}`])
      expectNoSso(
        webRouteNames(
          `<Routes><Route path="/app/${name}" /></Routes>`,
          `export const nextPath = '/app/${name}'`,
        ),
      )
    },
  )

  it('reports both SSO capabilities false at /instance', async () => {
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    try {
      const app = createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        publicUrl: 'http://localhost',
        routes: productRoutes({
          db,
          socialProviders: {},
          invitationMailLimits: { secret: 'catalogue-test-only' },
        }),
      })
      const response = await app.request('/api/v1/instance')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: false })
    } finally {
      await db.destroy()
    }
  })
})
