import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { COMMANDS, REST_COMMANDS } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openApiDocument, openApiRouteInventory } from './openapi-document.ts'
import { productionAppOptions, productRoutes } from './server.ts'
import { createWorkerHealthApp } from './worker-health.ts'

// Lower-case names that run the acronym together with a neighbouring word have no case,
// digit or separator boundary to split on (ssoconfig, teamsso). These few words are the
// ones the design joins to it; `sso` must still come out as a whole token, so a word that
// merely contains the letters (lassoconfig) does not match.
const SSO_SUFFIX_WORDS = ['config', 'provider', 'login', 'logout', 'callback', 'settings']
const SSO_PREFIX_WORDS = ['team', 'org']
const ssoSuffixBoundary = new RegExp(`(sso)(${SSO_SUFFIX_WORDS.join('|')})`, 'gi')
const ssoPrefixBoundary = new RegExp(`(${SSO_PREFIX_WORDS.join('|')})(sso)`, 'gi')

// Match camelCase operation ids as well as path segments, tool and command names.
function isSsoName(name: string) {
  const tokens = name
    // A plural or version suffix on the acronym is a word break: SSOs → SSO_s, ssov2 → sso_v2.
    .replace(/(sso)(s|v\d)/gi, '$1_$2')
    .replace(ssoSuffixBoundary, '$1_$2')
    .replace(ssoPrefixBoundary, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    // Digits are word breaks too: sso2 → sso_2, v2sso → v_2_sso.
    .replace(/\d+/g, '_$&_')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return (
    /saml|oidc|openid/i.test(name) ||
    tokens.includes('sso') ||
    tokens.join('').includes('singlesignon')
  )
}

// Hourmere is itself an OAuth authorization server for MCP clients, and this is that server's
// discovery document (apps/server/src/mcp/endpoint.ts), not a route for signing users in
// through an identity provider. It is the single exemption from the `openid` rule, for the
// route inventory only; the same name on any other surface still fails.
const MCP_OAUTH_DISCOVERY_PATH = '/.well-known/openid-configuration/api/auth'
const design = await readFile(new URL('../../../docs/sso.md', import.meta.url), 'utf8')
const ssoOperationIds = [
  ...design.matchAll(/^\| (?:GET|POST|PATCH|PUT|DELETE) .*?\| `([^`]+)` \|/gm),
].flatMap((match) => match[1] ?? [])

function expectNoSso(names: string[]) {
  expect(names.filter((name) => isSsoName(name) || ssoOperationIds.includes(name))).toEqual([])
}

function expectNoSsoRoutes(paths: string[]) {
  expectNoSso(paths.filter((path) => path !== MCP_OAUTH_DISCOVERY_PATH))
}

// The createApp options exactly as startServer assembles them (productionAppOptions in
// apps/server/src/server.ts), from a configuration that turns on every optional group: MCP
// OAuth, SCIM, the built web app, the Zoom event webhook and slot snippets. Only the
// collaborators startServer creates from live services (Better Auth, the job queue, the
// notifiers) are stood in for, and registering routes reaches none of them. None of these
// mounts is registered in openApiRouteInventory's document-only app.
const unavailable = async (): Promise<never> => {
  throw new Error('Route registration must not call the provider or the database')
}
function productionOptions(db: Db) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://catalogue@127.0.0.1:9/catalogue',
    BETTER_AUTH_SECRET: 'catalogue-test-only-secret-at-least-32-characters',
    PUBLIC_URL: 'http://localhost',
    MCP_OAUTH_ENABLED: 'true',
    SCIM_PROVISIONING_ENABLED: 'true',
    WEB_DIST: 'web-dist-never-read',
    ZOOM_WEBHOOK_SECRET_TOKEN: 'catalogue-test-only-zoom-secret',
    SLOT_SNIPPETS_ENABLED: 'true',
  })
  return productionAppOptions({
    config,
    db,
    auth: { handler: unavailable },
    resolveCaller: unavailable,
    resolveMcpOAuth: unavailable,
    checkDb: unavailable,
    waitlist: { verify: unavailable, remove: unavailable },
    invitationMailLimits: { secret: 'catalogue-test-only' },
    webhookSettings: { enabled: config.WEBHOOKS_ENABLED },
    notify: unavailable,
    notifyAttendeeNoShow: unavailable,
    googleCalendar: undefined,
    microsoftCalendar: undefined,
    zoomConference: undefined,
    enqueueCalendarSync: unavailable,
    enqueueCalendarWritebackRecovery: unavailable,
  })
}
// HOURMERE_ROLE=worker serves this app instead of createApp; its routes are inventoried too.
function workerPaths() {
  return createWorkerHealthApp({ checkDb: unavailable, checkJobs: unavailable }).routes.map(
    ({ path }) => path,
  )
}
// One representative path per optional group, so the inventory proves that it saw each of
// them: SCIM, MCP OAuth discovery and the guarded authorize route, the MCP endpoint, the
// waitlist pages, the web app's static files and the Zoom event webhook.
const productionOnlyPaths = [
  '/scim/*',
  '/.well-known/oauth-protected-resource/mcp',
  MCP_OAUTH_DISCOVERY_PATH,
  '/api/auth/oauth2/authorize',
  '/mcp',
  '/booking/waitlist/verify',
  '/booking/waitlist/remove',
  '/app/sw.js',
  '/assets/*',
  '/hourmere-embed.js',
  '/api/conference/zoom/events',
]

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

  it('registers no SSO route as production assembles the app, OpenAPI or not', async () => {
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    try {
      const { routes } = await openApiRouteInventory()
      const documentPaths = routes.map(({ path }) => path)
      const productionPaths = createApp(productionOptions(db)).routes.map(({ path }) => path)
      expect(productionPaths).toEqual(
        expect.arrayContaining([...documentPaths, ...productionOnlyPaths]),
      )
      expectNoSsoRoutes(productionPaths)
      const worker = workerPaths()
      expect(worker).toContain('/api/health')
      expectNoSsoRoutes(worker)
    } finally {
      await db.destroy()
    }
    const plainRoutes = new Hono()
    plainRoutes.get('/api/v1/associations', (c) => c.json({}))
    expectNoSsoRoutes(plainRoutes.routes.map(({ path }) => path))
    plainRoutes.get('/api/v1/saml2/metadata', (c) => c.json({}))
    expect(() => expectNoSsoRoutes(plainRoutes.routes.map(({ path }) => path))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('exempts exactly the MCP OAuth discovery route and nothing else', () => {
    const rejects = (check: () => void) =>
      expect(check).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    expectNoSsoRoutes([MCP_OAUTH_DISCOVERY_PATH])
    // The rule is unchanged: the same name fails on every other surface.
    rejects(() => expectNoSso([MCP_OAUTH_DISCOVERY_PATH]))
    rejects(() => expectNoSsoOperations({ paths: { [MCP_OAUTH_DISCOVERY_PATH]: { get: {} } } }))
    // Any variation of the path, including a neighbour under the same prefix, fails as a route.
    for (const path of [
      `${MCP_OAUTH_DISCOVERY_PATH}/`,
      ` ${MCP_OAUTH_DISCOVERY_PATH}`,
      MCP_OAUTH_DISCOVERY_PATH.toUpperCase(),
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration/',
      '/.well-known/openid-configuration/api',
      '/.well-known/openid-configuration/api/auth/jwks',
      '/.well-known/openid-configuration/api/sso',
      '/.well-known/openid-configuration/*',
      '/api/auth/.well-known/openid-configuration',
      '/api/v1/openid-configuration/api/auth',
    ]) {
      rejects(() => expectNoSsoRoutes([path]))
      rejects(() => expectNoSsoRoutes([MCP_OAUTH_DISCOVERY_PATH, path]))
    }
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
      // Production's MCP module (every tool startServer advertises, slot snippets on); only
      // the caller resolver is replaced, so the API key below authenticates.
      const app = createApp({
        ...productionOptions(db),
        resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      })
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: async (input, init) => app.request(input, init),
          requestInit: { headers: { authorization: 'Bearer hm_catalogue' } },
        }),
      )
      const tools = (await client.listTools()).tools.map((tool) => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['whoami', 'generate_open_time_snippet']))
      expectNoSso(tools)
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
    ['ssos', 'listSsos', 'list_ssos'],
    ['SSOs', 'listSSOs', 'SSOs_list'],
    ['SSOv2', 'getSSOv2Config', 'ssov2_config'],
    ['v2sso', 'getV2sso', 'v2sso_config'],
    ['saml20', 'getSaml20Metadata', 'saml20_metadata'],
    ['singlesignon', 'getsinglesignon', 'singlesignon'],
    ['singleSignon', 'singleSignonMetadata', 'single_signon'],
    ['openidconnect', 'getOpenidconnect', 'openidconnect'],
    // Run together with a neighbouring word, all lower case.
    ['ssoconfig', 'getSsoconfig', 'ssoconfig'],
    ['ssoprovider', 'getSsoprovider', 'ssoprovider'],
    ['ssologin', 'postSsologin', 'ssologin'],
    ['ssologout', 'postSsologout', 'ssologout'],
    ['ssocallback', 'getSsocallback', 'ssocallback'],
    ['ssosettings', 'getSsosettings', 'ssosettings'],
    ['teamsso', 'getTeamsso', 'teamsso'],
    ['orgsso', 'getOrgsso', 'orgsso'],
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

  it.each([
    'associations',
    'lasso',
    'lassos',
    'associated',
    'blossom',
    'missouri',
    'Missouri',
    'assortment',
    'espressos',
    // The letters followed or preceded by a listed word, inside another word.
    'lassoconfig',
    'teamlasso',
  ])('allows unrelated %s names on every catalogue surface', (name) => {
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
  })

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
