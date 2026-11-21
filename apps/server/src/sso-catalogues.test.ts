import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'
import { createAuth, createAuthPool, MAGIC_LINK_CONFIRM_PATH, type Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, REST_COMMANDS } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import { openApiDocument, openApiRouteInventory } from './openapi-document.ts'
import { productionAppOptions, productionAuthOptions, productRoutes } from './server.ts'
import { MAILBOX_PROOF_CONSUME_PATH, MAILBOX_PROOF_SEND_PATH } from './sso-mailbox-proof.ts'
import { OIDC_CALLBACK_PATH, OIDC_COMPLETE_PATH, OIDC_SIGN_IN_PATH } from './sso-oidc-sign-in.ts'
import { createWorkerHealthApp } from './worker-health.ts'

// Lower-case names that run the acronym together with a neighbouring word have no case,
// digit or separator boundary to split on (ssoconfig, teamsso, getssoconfig). These few
// words are the ones the design and the plugin's own names join to it; `sso` must still
// come out as a whole token, so a word that merely contains the letters (lassoconfig,
// lassoflow) does not match.
const SSO_SUFFIX_WORDS = [
  'config',
  'provider',
  'login',
  'logout',
  'callback',
  'settings',
  'flow',
  'domain',
]
const SSO_PREFIX_WORDS = ['team', 'org', 'get']
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

// The SSO auth-protocol endpoints that are built and mounted while hard-off, because each must
// answer `404 sso_disabled` itself (docs/sso.md, Hard-off behaviour). The Mailbox proof and
// OIDC sign-in and completion paths are exempt by exact path from the route inventory and source
// literals only, and only because the suite below proves that each answers
// `404 {"error":"sso_disabled"}` in the app production assembles, before any other check.
const GUARDED_SSO_AUTH_PATHS = [
  '/api/auth/sso/mailbox-proof/send',
  '/api/auth/sso/mailbox-proof/consume',
  '/api/auth/sign-in/sso',
  '/api/auth/sso/callback/:providerId',
  '/api/auth/sso/oidc/complete',
] as const

const GUARDED_SSO_READS = [
  {
    path: '/api/v1/team/sso/providers',
    operationId: 'listSsoProviders',
    tool: 'list_sso_providers',
    command: 'sso providers list',
  },
  {
    path: '/api/v1/team/sso/policy',
    operationId: 'getSsoPolicy',
    tool: 'get_sso_policy',
    command: 'sso policy',
  },
] as const

// Session-only writes are registered and tested below for the hard-off response.
const GUARDED_SSO_WRITES = [
  {
    method: 'put',
    path: '/api/v1/team/sso/policy',
    runtimePath: '/api/v1/team/sso/policy',
    operationId: 'setSsoPolicy',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/domains',
    runtimePath: '/api/v1/team/sso/domains',
    operationId: 'createSsoDomainChallenge',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/domains/{domainId}/verify',
    runtimePath: '/api/v1/team/sso/domains/:domainId/verify',
    operationId: 'verifySsoDomain',
  },
  {
    method: 'delete',
    path: '/api/v1/team/sso/domains/{domainId}',
    runtimePath: '/api/v1/team/sso/domains/:domainId',
    operationId: 'deleteSsoDomain',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/providers',
    runtimePath: '/api/v1/team/sso/providers',
    operationId: 'createSsoProvider',
  },
  {
    method: 'patch',
    path: '/api/v1/team/sso/providers/{providerId}',
    runtimePath: '/api/v1/team/sso/providers/:providerId',
    operationId: 'updateSsoProvider',
  },
  {
    method: 'delete',
    path: '/api/v1/team/sso/providers/{providerId}',
    runtimePath: '/api/v1/team/sso/providers/:providerId',
    operationId: 'deleteSsoProvider',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/providers/{providerId}/test',
    runtimePath: '/api/v1/team/sso/providers/:providerId/test',
    operationId: 'testSsoProvider',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/providers/{providerId}/activation',
    runtimePath: '/api/v1/team/sso/providers/:providerId/activation',
    operationId: 'activateSsoProvider',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/providers/{providerId}/link',
    runtimePath: '/api/v1/team/sso/providers/:providerId/link',
    operationId: 'linkSsoAccount',
  },
  {
    method: 'delete',
    path: '/api/v1/team/sso/providers/{providerId}/link',
    runtimePath: '/api/v1/team/sso/providers/:providerId/link',
    operationId: 'unlinkSsoAccount',
  },
  {
    method: 'delete',
    path: '/api/v1/team/sso/providers/{providerId}/links/{linkId}',
    runtimePath: '/api/v1/team/sso/providers/:providerId/links/:linkId',
    operationId: 'removeSsoIdentityLink',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/delegations',
    runtimePath: '/api/v1/team/sso/delegations',
    operationId: 'bindSsoDelegation',
  },
  {
    method: 'delete',
    path: '/api/v1/team/sso/delegations/{bindingId}',
    runtimePath: '/api/v1/team/sso/delegations/:bindingId',
    operationId: 'revokeSsoDelegation',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/recovery',
    runtimePath: '/api/v1/team/sso/recovery',
    operationId: 'configureSsoRecovery',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/recovery/{enrollmentId}/accept',
    runtimePath: '/api/v1/team/sso/recovery/:enrollmentId/accept',
    operationId: 'acceptSsoRecoveryEnrollment',
  },
  {
    method: 'post',
    path: '/api/v1/team/sso/recovery/use',
    runtimePath: '/api/v1/team/sso/recovery/use',
    operationId: 'useSsoRecovery',
  },
] as const

function expectNoUnguardedSsoRoutes(paths: string[]) {
  expectNoSsoRoutes(
    paths.filter(
      (path) =>
        !(GUARDED_SSO_AUTH_PATHS as readonly string[]).includes(path) &&
        !GUARDED_SSO_READS.some((read) => read.path === path) &&
        !GUARDED_SSO_WRITES.some((write) => write.path === path || write.runtimePath === path),
    ),
  )
}

// The createApp and createAuth options exactly as startServer assembles them
// (productionAppOptions and productionAuthOptions in apps/server/src/server.ts), from a
// configuration that turns on every optional group: MCP OAuth, SCIM, the built web app, the
// Zoom event webhook, slot snippets, and Google and Microsoft sign-in. Only the collaborators
// startServer creates from live services (Better Auth, the job queue, the notifiers, the
// mailer) are stood in for, and registering routes or endpoints reaches none of them. None of
// these mounts is registered in openApiRouteInventory's document-only app.
const unavailable = async (): Promise<never> => {
  throw new Error('Route registration must not call the provider or the database')
}
const productionEnv = {
  DATABASE_URL: 'postgres://catalogue@127.0.0.1:9/catalogue',
  SSO_OIDC_ENABLED: 'true',
  SSO_SAML_ENABLED: 'true',
  SSO_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SSO_PRIVATE_TARGETS: 'idp.internal:8443',
  BETTER_AUTH_SECRET: 'catalogue-test-only-secret-at-least-32-characters',
  PUBLIC_URL: 'http://localhost',
  MCP_OAUTH_ENABLED: 'true',
  SCIM_PROVISIONING_ENABLED: 'true',
  WEB_DIST: 'web-dist-never-read',
  ZOOM_WEBHOOK_SECRET_TOKEN: 'catalogue-test-only-zoom-secret',
  SLOT_SNIPPETS_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'catalogue-google',
  GOOGLE_CLIENT_SECRET: 'catalogue-test-only-google-secret',
  MICROSOFT_CLIENT_ID: 'catalogue-microsoft',
  MICROSOFT_CLIENT_SECRET: 'catalogue-test-only-microsoft-secret',
}
const productionConfig = loadConfig(productionEnv)
function productionOptions(db: Db) {
  const config = productionConfig
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
    webhookQueue: { enqueue: unavailable },
    notify: unavailable,
    notifyAttendeeNoShow: unavailable,
    googleCalendar: undefined,
    microsoftCalendar: undefined,
    zoomConference: undefined,
    enqueueCalendarSync: unavailable,
    enqueueCalendarWritebackRecovery: unavailable,
    mailboxProofQueue: { enqueue: unavailable },
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

// Better Auth serves every endpoint of its plugins behind the one `/api/auth/*` mount, which
// the route inventory sees as a single route. Their own paths come from
// createAuth(productionAuthOptions(...)), the call startServer makes, with every input
// startServer passes supplied: once with every optional group of the configuration on, and
// once for each combination of the groups that change what createAuth registers (AUTH_GROUPS),
// every other setting at its default. Each combination's paths must be among the all-on
// ones, as the route inventory requires of the document-only app. The paths are read twice:
// from `auth.api`, which Better Auth builds before any plugin's init runs, and, once startup
// has settled, from the endpoints of the plugin objects in createAuth's options, which its
// router reads again on every request. An endpoint that createAuth registers for any of those
// inputs and combinations, by the end of plugin init, is seen wherever its path string comes
// from. One gated on the value of a setting the combinations do not vary (the signup mode,
// the PUBLIC_URL scheme) or on an input startServer does not pass is not, and neither is one
// added after startup has settled (from a timer, for example).
// A plugin's onRequest and onResponse run before and after Better Auth matches a route, so
// either can answer a path no endpoint registers, which no inventory sees. Better Auth runs
// them from the plugin list in its context: the declared plugins after every plugin's init,
// which can add plugins to that list. The suite pins, by id, the plugins Better Auth
// actually runs after plugin init, in every configuration it builds: they must be exactly
// the declared ones, and the ones with either hook exactly the known ones (the MCP OAuth
// provider plugin, which answers its own discovery documents). What that plugin's own hook
// answers is not checked, and neither is a plugin added to the list after startup has
// settled. Router middlewares and before/after hooks run only for a
// registered endpoint, whose path is checked.
// Hourmere is the OAuth authorization server for MCP clients, and this is that server's own
// OpenID discovery document (the OAuth provider plugin in mcpOAuthPlugins, served at
// /api/auth/.well-known/openid-configuration), not a route for signing users in through an
// identity provider. It is the single exemption from the `openid` rule among Better Auth
// endpoint paths; the same name fails on every other surface.
const MCP_OAUTH_AUTH_DISCOVERY_PATH = '/.well-known/openid-configuration'

function expectNoSsoAuthEndpoints(paths: string[]) {
  expectNoSso(paths.filter((path) => path !== MCP_OAUTH_AUTH_DISCOVERY_PATH))
}

// Server-only endpoints (signJWT, verifyApiKey…) have no path and no HTTP route.
function authEndpointPaths(api: object) {
  return Object.values(api).flatMap((endpoint: { path?: unknown }) =>
    typeof endpoint.path === 'string' ? [endpoint.path] : [],
  )
}

// A pool that never opens a connection: createAuth's startup work (Better Auth's schema check
// and the OAuth provider's resource seeding) asks for one and is refused at once, with no
// network access. Better Auth logs both refusals. pool.query uses the callback form.
function neverConnecting(pool: pg.Pool) {
  const refusal = () => new Error('This pool never connects')
  pool.connect = ((callback?: (error: Error) => void) => {
    if (!callback) return Promise.reject(refusal())
    queueMicrotask(() => callback(refusal()))
  }) as pg.Pool['connect']
  return pool
}

// createAuth(productionAuthOptions(...)) for a configuration, with every input startServer
// passes: the live collaborators are stubs, and the pools never connect.
async function productionAuth(config: Config) {
  const authPool = neverConnecting(createAuthPool(config.DATABASE_URL, config.signup))
  neverConnecting((authPool as pg.Pool & { organizationLocks: pg.Pool }).organizationLocks)
  const appPool = neverConnecting(createPool(config.DATABASE_URL))
  try {
    const db = createDb(appPool)
    const auth = createAuth(
      productionAuthOptions({
        config,
        pool: authPool,
        db,
        mailer: { send: unavailable },
        invitationDelivery: {
          db,
          queue: {
            enqueue: unavailable,
            retireExpiredInvitationEmailJobs: unavailable,
            hasLiveInvitationEmailJob: unavailable,
          },
        },
        invitationMailLimits: { secret: 'catalogue-test-only' },
        jobs: { enqueue: unavailable },
      }),
    )
    // Let startup settle against the refused pool before it is closed.
    const context = await auth.$context
    const declaredPlugins: { id: string; endpoints?: object }[] = auth.options.plugins
    // The list Better Auth's router runs onRequest and onResponse from, after plugin init.
    const plugins: { id: string; onRequest?: unknown; onResponse?: unknown }[] =
      context.options.plugins ?? []
    // auth.api is built before any plugin's init runs. The router builds its endpoints again on
    // every request from the endpoints of the plugin objects in createAuth's options, which an
    // init can add to, so those are read here too, after plugin init.
    const pluginEndpoints = Object.assign(
      {},
      ...declaredPlugins.map(({ endpoints }) => endpoints ?? {}),
    )
    return {
      paths: [...new Set([...authEndpointPaths(auth.api), ...authEndpointPaths(pluginEndpoints)])],
      providers: context.socialProviders.map(({ id }) => id).sort(),
      declaredPlugins: declaredPlugins.map(({ id }) => id),
      plugins: plugins.map(({ id }) => id),
      requestHookPlugins: plugins
        .filter(({ onRequest, onResponse }) => onRequest || onResponse)
        .map(({ id }) => id),
    }
  } finally {
    await authPool.end()
    await appPool.end()
  }
}

// The optional groups that change what createAuth registers, by the productionEnv settings
// that turn each on, the sign-in providers it adds and its plugins with request hooks.
const AUTH_GROUPS = [
  {
    name: 'MCP OAuth',
    settings: ['MCP_OAUTH_ENABLED'],
    providers: [],
    requestHookPlugins: ['oauth-provider'],
  },
  {
    name: 'Google',
    settings: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    providers: ['google'],
    requestHookPlugins: [],
  },
  {
    name: 'Microsoft',
    settings: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    providers: ['microsoft'],
    requestHookPlugins: [],
  },
] as const satisfies readonly {
  name: string
  settings: readonly (keyof typeof productionEnv)[]
  providers: readonly string[]
  requestHookPlugins: readonly string[]
}[]
type AuthGroup = (typeof AUTH_GROUPS)[number]
// Every combination of them, from none (a default instance) to all three. Each configuration
// sets only the chosen groups' settings on top of the base ones, so the rest are defaults.
const BASE_SETTINGS = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'PUBLIC_URL'] as const
const authGroupCombinations = Array.from({ length: 2 ** AUTH_GROUPS.length }, (_, mask) => {
  const groups: AuthGroup[] = AUTH_GROUPS.filter((_, bit) => mask & (1 << bit))
  return [groups.map(({ name }) => name).join(', ') || 'none', groups] as const
})
function configWith(groups: readonly AuthGroup[]) {
  const settings = [...BASE_SETTINGS, ...groups.flatMap(({ settings }) => settings)]
  return loadConfig(Object.fromEntries(settings.map((name) => [name, productionEnv[name]])))
}

// The installed SSO plugin, from the workspace that owns it. Only its endpoint list is read;
// it is not registered in any Better Auth instance.
async function ssoPluginEndpointPaths() {
  const location = createRequire(
    new URL('../../../packages/auth/package.json', import.meta.url),
  ).resolve('@better-auth/sso')
  const { sso } = (await import(pathToFileURL(location).href)) as {
    sso: (options: { domainVerification: { enabled: boolean } }) => {
      endpoints: Record<string, { path: string }>
    }
  }
  // Domain verification adds the only optional endpoints.
  return Object.values(sso({ domainVerification: { enabled: true } }).endpoints).map(
    ({ path }) => path,
  )
}

const root = new URL('../../../', import.meta.url)
const rootPath = fileURLToPath(root)

// Production source files under the src directory of every apps, packages and tools workspace.
function productionSources(): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        files.push(relative(rootPath, path))
    }
  }
  for (const group of ['apps', 'packages', 'tools'])
    for (const name of readdirSync(new URL(group, root))) {
      const source = new URL(`${group}/${name}/src`, root)
      try {
        if (statSync(source).isDirectory()) walk(fileURLToPath(source))
      } catch {
        // Not a workspace with sources.
      }
    }
  return files.sort()
}

// Source files beside the production code that do not ship, so a path a test scenario uses
// is not mistaken for a served route: test support and fixtures (named `test/`, `testing/`,
// `*testing.ts`, `test-app.ts`, `*fixtures.ts`, `*-seed*.ts`, `*.test-helper.ts`) and
// generated files (`*.d.ts`, the database table types). The same list and walk as the
// routing forms Off test's scan (scripts/routing-forms-off.test.ts), kept in step with it.
const NOT_SHIPPED: readonly RegExp[] = [
  /(^|\/)test\//,
  /(^|\/)testing\//,
  /(^|[-/])testing\.tsx?$/,
  /testing-clock\.ts$/,
  /test-app\.ts$/,
  /test-database-registry\.ts$/,
  /\.test-helper\.ts$/,
  /fixtures?\.tsx?$/,
  /-seed(-[a-z]+)?\.ts$/,
  /\.d\.ts$/,
  /^packages\/db\/src\/tables\.ts$/,
]

type Document = { paths: Record<string, Record<string, { operationId?: string }>> }
function expectNoSsoOperations(document: Document) {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (
        GUARDED_SSO_READS.some(
          (read) =>
            read.path === path && method === 'get' && read.operationId === operation.operationId,
        ) ||
        GUARDED_SSO_WRITES.some(
          (write) =>
            write.path === path &&
            write.method === method &&
            write.operationId === operation.operationId,
        )
      )
        continue
      expectNoSso([path, ...(operation.operationId ? [operation.operationId] : [])])
    }
  }
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
  it('publishes exactly the guarded SSO reads and session writes in OpenAPI', async () => {
    const document = (await openApiDocument()) as Document
    for (const read of GUARDED_SSO_READS)
      expect(document.paths[read.path]?.get?.operationId).toBe(read.operationId)
    for (const write of GUARDED_SSO_WRITES)
      expect(document.paths[write.path]?.[write.method]?.operationId).toBe(write.operationId)
    expectNoSsoOperations(document)
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
      expect(productionPaths).toEqual(expect.arrayContaining([...GUARDED_SSO_AUTH_PATHS]))
      expectNoUnguardedSsoRoutes(productionPaths)
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

  it('exempts exactly the guarded SSO auth-protocol endpoints and nothing else', () => {
    const rejects = (check: () => void) =>
      expect(check).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    // The exemption is the endpoints' own published paths, nothing broader.
    expect([
      MAILBOX_PROOF_SEND_PATH,
      MAILBOX_PROOF_CONSUME_PATH,
      OIDC_SIGN_IN_PATH,
      OIDC_CALLBACK_PATH,
      OIDC_COMPLETE_PATH,
    ]).toEqual([...GUARDED_SSO_AUTH_PATHS])
    expectNoUnguardedSsoRoutes([...GUARDED_SSO_AUTH_PATHS])
    // The ordinary rule is unchanged: the same paths fail every other check.
    for (const path of GUARDED_SSO_AUTH_PATHS) {
      rejects(() => expectNoSso([path]))
      rejects(() => expectNoSsoRoutes([path]))
      rejects(() => expectNoSsoAuthEndpoints([path]))
      rejects(() => expectNoSsoOperations({ paths: { [path]: { post: {} } } }))
    }
    for (const path of [
      `${MAILBOX_PROOF_SEND_PATH}/`,
      ` ${MAILBOX_PROOF_SEND_PATH}`,
      MAILBOX_PROOF_SEND_PATH.toUpperCase(),
      '/api/auth/sso/mailbox-proof',
      '/api/auth/sso/mailbox-proof/*',
      '/api/auth/sso/mailbox-proof/resend',
      '/api/auth/sign-in/sso/',
      '/api/auth/sso/callback',
      '/api/auth/sso/callback/*',
      '/api/auth/sso/callback/:providerId/complete',
      `${OIDC_COMPLETE_PATH}/`,
      '/api/auth/sso/oidc/*',
      '/api/auth/sso/oidc/complete/other',
      '/api/auth/sso/*',
      '/api/v1/sso/mailbox-proof/send',
      '/sso/mailbox-proof/consume',
    ]) {
      rejects(() => expectNoUnguardedSsoRoutes([path]))
      rejects(() => expectNoUnguardedSsoRoutes([...GUARDED_SSO_AUTH_PATHS, path]))
    }
    // The worker serves health only: no exemption applies there.
    rejects(() => expectNoSsoRoutes([...workerPaths(), MAILBOX_PROOF_SEND_PATH]))
  })

  it('answers 404 sso_disabled on every exempt endpoint as production assembles the app', async () => {
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    const previous = { oidc: process.env.SSO_OIDC_ENABLED, saml: process.env.SSO_SAML_ENABLED }
    process.env.SSO_OIDC_ENABLED = 'true'
    process.env.SSO_SAML_ENABLED = 'true'
    try {
      // The queue, the caller resolver and the database all refuse: an effect would be a 500.
      const app = createApp(productionOptions(db))
      for (const path of GUARDED_SSO_AUTH_PATHS)
        for (const method of ['POST', 'GET', 'PUT'])
          for (const headers of [
            {},
            { origin: 'http://localhost', 'content-type': 'application/json' },
            { origin: 'https://attacker.example', authorization: 'Bearer hm_x', cookie: 'a=b' },
          ])
            for (const id of ['0190f2c4-0000-7000-8000-000000000001', 'not-an-id']) {
              const requestPath =
                path === OIDC_CALLBACK_PATH
                  ? `${path.replace(':providerId', id)}?state=synthetic&code=synthetic`
                  : path
              const body =
                path === OIDC_SIGN_IN_PATH
                  ? { providerId: id, intent: 'sign_in' }
                  : path === OIDC_COMPLETE_PATH
                    ? { attemptId: id }
                    : { attemptId: id, token: 'synthetic' }
              const response = await app.request(requestPath, {
                method,
                headers,
                ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
              })
              expect(response.status, `${method} ${path}`).toBe(404)
              expect(await response.json()).toEqual({ error: 'sso_disabled' })
            }
    } finally {
      for (const [name, value] of [
        ['SSO_OIDC_ENABLED', previous.oidc],
        ['SSO_SAML_ENABLED', previous.saml],
      ] as const)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      await db.destroy()
    }
  })

  it('answers disabled for each SSO write before caller, input or database access', async () => {
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    try {
      const app = createApp(productionOptions(db))
      for (const write of GUARDED_SSO_WRITES)
        for (const id of ['0190f2c4-0000-7000-8000-000000000001', 'not-an-id'])
          for (const headers of [
            {},
            { origin: 'https://attacker.example', authorization: 'Bearer hm_x', cookie: 'a=b' },
          ]) {
            const response = await app.request(write.path.replace(/\{\w+Id\}/g, id), {
              method: write.method.toUpperCase(),
              headers,
              body: '{invalid-json',
            })
            expect(response.status).toBe(404)
            expect(await response.json()).toEqual({ error: 'sso_disabled' })
          }
    } finally {
      await db.destroy()
    }
  })

  it.each([
    [
      '/delegations',
      { credentialKind: 'api_key', credentialId: randomUUID(), expectedTrustGeneration: 1 },
    ],
    ['/recovery', { ownerUserId: randomUUID(), expectedRevision: 1 }],
    [`/recovery/${randomUUID()}/accept`, { expectedRevision: 1 }],
    ['/recovery/use', { expectedRevision: 1 }],
    [`/providers/${randomUUID()}/activation`, { expectedRevision: 1, enabled: true }],
  ])(
    'keeps proof inputs private in validation and request diagnostics for %s',
    async (suffix, fields) => {
      const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
      const publicUrl = 'http://localhost'
      const principal: Principal = {
        kind: 'session',
        sessionId: randomUUID(),
        user: { id: randomUUID(), name: 'Synthetic member', email: 'member@example.test' },
        organization: { id: randomUUID(), name: 'Team', slug: 'team', personal: false },
      }
      const marker = 'synthetic-sso-proof-marker'
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const app = createApp({
          checkDb: unavailable,
          authHandler: unavailable,
          publicUrl,
          routes: productRoutes({
            db,
            publicUrl,
            ssoOidcEnabled: true,
            socialProviders: {},
            invitationMailLimits: { secret: 'catalogue-test-only' },
          }),
          resolveCaller: async (headers) => {
            if (headers.has('x-test-fail')) throw new Error(marker)
            return { ok: true, principal, setCookie: [] }
          },
        })
        const input = { ...fields, proofAttemptId: randomUUID() }
        const headers = {
          origin: publicUrl,
          'content-type': 'application/json',
          'X-Expected-Organization-Id': principal.organization.id,
        }
        const path = `/api/v1/team/sso${suffix}?${marker}`
        const invalid = await app.request(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, [marker]: true }),
        })
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toEqual({ error: 'invalid_request' })
        const failed = await app.request(path, {
          method: 'POST',
          headers: { ...headers, 'x-test-fail': '1' },
          body: JSON.stringify(input),
        })
        expect(failed.status).toBe(500)
        expect(errorLog.mock.calls.flat().join('\n')).toContain('[private SSO diagnostic omitted]')
        expect(
          JSON.stringify([await failed.json(), log.mock.calls, errorLog.mock.calls]),
        ).not.toContain(marker)
      } finally {
        log.mockRestore()
        errorLog.mockRestore()
        await db.destroy()
      }
    },
  )

  it('exempts SSO writes only at their exact method, path and operation id', () => {
    for (const write of GUARDED_SSO_WRITES) {
      const check = (path: string, method: string, operationId: string) =>
        expectNoSsoOperations({ paths: { [path]: { [method]: { operationId } } } })
      check(write.path, write.method, write.operationId)
      for (const [path, method, operationId] of [
        [write.path, write.method === 'put' ? 'post' : 'put', write.operationId],
        [`${write.path}/`, write.method, write.operationId],
        [write.path, write.method, 'setSsoUnexpectedPolicy'],
      ])
        expect(() => check(path as string, method as string, operationId as string)).toThrow(
          expect.objectContaining({ name: 'AssertionError' }),
        )
      expect(() => expectNoSso([write.operationId])).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
  })

  it('answers disabled for draft reads before caller resolution or database access', async () => {
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    try {
      const app = createApp(productionOptions(db))
      for (const read of GUARDED_SSO_READS) {
        for (const query of ['', '?cursor=invalid&limit=not-a-number']) {
          for (const headers of [
            {},
            { authorization: 'Bearer hm_invalid', cookie: 'session=invalid' },
          ]) {
            const response = await app.request(`${read.path}${query}`, { headers })
            expect(response.status).toBe(404)
            expect(await response.json()).toEqual({ error: 'sso_disabled' })
          }
        }
      }
    } finally {
      await db.destroy()
    }
  })

  it('exempts only exact draft read paths, methods and operation IDs', () => {
    for (const read of GUARDED_SSO_READS) {
      expectNoSsoOperations({ paths: { [read.path]: { get: { operationId: read.operationId } } } })
      for (const [path, method, operationId] of [
        [read.path, 'post', read.operationId],
        [`${read.path}/`, 'get', read.operationId],
        [read.path, 'get', 'updateSsoProvider'],
        ['/api/v1/other', 'get', read.operationId],
      ] as const)
        expect(() =>
          expectNoSsoOperations({ paths: { [path]: { [method]: { operationId } } } }),
        ).toThrow()
    }
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

  it('registers no SSO Better Auth endpoint, as startServer assembles createAuth', async () => {
    const { paths, providers, declaredPlugins, plugins, requestHookPlugins } =
      await productionAuth(productionConfig)
    // One endpoint from each plugin group, so the inventory proves that it saw them: core
    // sessions, magic links, Google/Microsoft sign-in, organizations, API keys and MCP OAuth.
    expect(paths).toEqual(
      expect.arrayContaining([
        '/get-session',
        '/sign-in/magic-link',
        '/sign-in/social',
        '/callback/:id',
        '/organization/create',
        '/api-key/create',
        '/oauth2/authorize',
        MCP_OAUTH_AUTH_DISCOVERY_PATH,
      ]),
    )
    expectNoSsoAuthEndpoints(paths)
    // An OAuth/OIDC relying party for any other identity provider reuses /sign-in/social and
    // /callback/:id (Better Auth's genericOAuth adds no endpoint), so no name check sees it:
    // the sign-in providers must be exactly Google and Microsoft.
    expect(providers).toEqual(['google', 'microsoft'])
    expect(plugins).not.toContain('generic-oauth')
    expect(requestHookPlugins).toEqual(['oauth-provider'])
    expect(plugins).toEqual(declaredPlugins)
  })

  it.each(authGroupCombinations)(
    'registers no SSO Better Auth endpoint with optional sign-in groups: %s',
    async (_, groups) => {
      const allOn = await productionAuth(productionConfig)
      const built = await productionAuth(configWith(groups))
      expect(built.paths).toContain('/get-session')
      expect(built.paths.includes('/oauth2/authorize')).toBe(
        groups.some(({ name }) => name === 'MCP OAuth'),
      )
      expectNoSsoAuthEndpoints(built.paths)
      expect(allOn.paths).toEqual(expect.arrayContaining(built.paths))
      expect(built.providers).toEqual(groups.flatMap(({ providers }) => providers).sort())
      expect(built.plugins).not.toContain('generic-oauth')
      expect(built.requestHookPlugins).toEqual(
        groups.flatMap(({ requestHookPlugins }) => requestHookPlugins),
      )
      expect(built.plugins).toEqual(built.declaredPlugins)
    },
  )

  it('recognises every endpoint the installed Better Auth SSO plugin would register', async () => {
    const paths = await ssoPluginEndpointPaths()
    expect(paths).toEqual(
      expect.arrayContaining([
        '/sign-in/sso',
        '/sso/callback/:providerId',
        '/sso/callback',
        '/sso/saml2/sp/acs/:providerId',
        '/sso/register',
        '/sso/verify-domain',
      ]),
    )
    for (const path of paths)
      expect(() => expectNoSsoAuthEndpoints(['/get-session', path])).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
  })

  it('exempts exactly the MCP OAuth discovery endpoint among Better Auth paths', () => {
    const rejects = (check: () => void) =>
      expect(check).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    expectNoSsoAuthEndpoints([MCP_OAUTH_AUTH_DISCOVERY_PATH])
    // The rule is unchanged: the same name fails on every other surface, routes included.
    rejects(() => expectNoSso([MCP_OAUTH_AUTH_DISCOVERY_PATH]))
    rejects(() => expectNoSsoRoutes([MCP_OAUTH_AUTH_DISCOVERY_PATH]))
    for (const path of [
      `${MCP_OAUTH_AUTH_DISCOVERY_PATH}/`,
      ` ${MCP_OAUTH_AUTH_DISCOVERY_PATH}`,
      MCP_OAUTH_AUTH_DISCOVERY_PATH.toUpperCase(),
      `${MCP_OAUTH_AUTH_DISCOVERY_PATH}/sso`,
      `/sso${MCP_OAUTH_AUTH_DISCOVERY_PATH}`,
      MCP_OAUTH_DISCOVERY_PATH,
      '/.well-known/openid-configuration/:providerId',
      '/sso/.well-known/openid-configuration',
    ]) {
      rejects(() => expectNoSsoAuthEndpoints([path]))
      rejects(() => expectNoSsoAuthEndpoints([MCP_OAUTH_AUTH_DISCOVERY_PATH, path]))
    }
  })

  it('names no SSO path in a shipped source literal and imports no SSO plugin', () => {
    // Backstop for a surface no inventory sees: a route registered outside the shared
    // assembly, one behind a switch the tests leave off, or an endpoint behind /api/auth/*.
    // Its path has to be written somewhere, so every string literal that begins with `/` in
    // every shipped source (apps, packages and tools) is checked, wherever it lives.
    const files = productionSources()
    const shipped = files.filter((file) => !NOT_SHIPPED.some((pattern) => pattern.test(file)))
    expect(shipped).toEqual(
      expect.arrayContaining([
        'apps/server/src/server.ts',
        'apps/web/src/paths.ts',
        'packages/auth/src/index.ts',
        'tools/cli/src/cli.ts',
      ]),
    )
    expect(files.filter((file) => !shipped.includes(file))).toContain(
      'packages/auth/src/testing.ts',
    )
    const sources = shipped.map((file) => [file, readFileSync(new URL(file, root), 'utf8')])
    const literals = sources.flatMap(([, source = '']) =>
      [...source.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)].map(([, , literal = '']) => literal),
    )
    expect(literals.length).toBeGreaterThan(500)
    // Literals from the server, a package and the web app, and the one exempt route.
    expect(literals).toEqual(
      expect.arrayContaining([
        '/api/v1/bookings/{id}',
        MAGIC_LINK_CONFIRM_PATH,
        '/booking',
        MCP_OAUTH_DISCOVERY_PATH,
      ]),
    )
    expect(literals).toEqual(expect.arrayContaining([...GUARDED_SSO_AUTH_PATHS]))
    expectNoUnguardedSsoRoutes(literals)
    expect(() => expectNoUnguardedSsoRoutes([...literals, '/sso/callback'])).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    // The SSO plugin package is a development dependency, for evaluation only (docs/sso.md);
    // no shipped source imports it, so no Better Auth instance can register it.
    const ssoPluginImport = /(['"`])@better-auth\/sso(\/[^'"`]*)?\1/
    expect(sources.filter(([, source = '']) => ssoPluginImport.test(source))).toEqual([])
    expect(ssoPluginImport.test("import { sso } from '@better-auth/sso'")).toBe(true)
    expect(ssoPluginImport.test("import('@better-auth/sso/client')")).toBe(true)
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
      for (const read of GUARDED_SSO_READS) {
        const result = await client.callTool({ name: read.tool, arguments: {} })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain('sso_disabled')
      }
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

  it('publishes exactly the guarded SSO draft CLI commands and targets', () => {
    const commands = { ...COMMANDS, ...REST_COMMANDS }
    for (const read of GUARDED_SSO_READS)
      expect(commands[read.command as keyof typeof commands]).toBe(read.tool)
    expectNoSso(
      Object.entries(commands)
        .filter(
          ([command, target]) =>
            !GUARDED_SSO_READS.some((read) => read.command === command && read.tool === target),
        )
        .flat(),
    )
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
    ['getssoconfig', 'getssoconfig', 'getssoconfig'],
    ['ssoflow', 'startSsoflow', 'ssoflow'],
    ['ssodomain', 'verifySsodomain', 'ssodomain'],
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
    'lassoflow',
    'espressodomain',
    'getlasso',
    'gadgetssomething',
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
