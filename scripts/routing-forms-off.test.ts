// Routing forms are storage only (docs/routing-forms.md, step a1a): migration 0072 and the
// packages/db storage files exist, and no product surface does. Step a1b adds the hard-off
// guard (apps/server/src/routing-forms.ts, tested in routing-forms.test.ts) and one surface,
// the `/instance` capability `routingFormsEnabled`, which reports false; the OpenAPI check
// below exempts exactly that field. This test asserts that the routing feature's own surface
// is otherwise absent, keyed on the names docs/routing-forms.md assigns to each surface. It
// never snapshots or compares whole catalogues and never consults a git base. Later plan
// steps delete or narrow one assertion each when they add their surface:
// - REST paths, operations and schemas: b1, b2 and b3 add `/routing-forms…`, c2a and c2b
//   add `/public/-/routing/…`, c4 and c5b add `/routing-continuations/…`.
// - MCP tools: b1 (`list_routing_forms`, `get_routing_form`, `create_routing_form`,
//   `update_routing_form`, `archive_routing_form`), b2 (`publish_routing_form`),
//   b3 (`preview_routing_form`), c2a (`get_public_routing_form`), c2b (`route_lead`),
//   c4 (`resolve_routing_continuation`, `find_routed_slots`). Those steps list the tools only
//   while `routingFormsEnabled` is true, so this assertion then moves into their off checks.
// - CLI commands: b1 onward add `routing-forms …` commands to the static command table.
// - Storage imports: a3 (configuration services) first imports the storage from service
//   code; the scan then narrows to the packages that may own routing data access.
// The web route table is asserted by apps/web/src/routing-forms-off.test.tsx (jsdom
// project), which c3, c6 and d1 narrow when they mount routing pages.
// The Hono routes are read from the app as startServer assembles it (productionAppOptions),
// with every optional route group turned on, so a route only production registers is seen too.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { createGoogleCalendarClient, createMicrosoftCalendarClient } from '@hourmere/calendars'
import { createZoomClient } from '@hourmere/conferences'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { prepareTools } from '../apps/server/src/mcp/tools.ts'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productionAppOptions, productTools } from '../apps/server/src/server.ts'
import { COMMANDS, REST_COMMANDS } from '../tools/cli/src/cli.ts'
import { isRoutingName } from './routing-forms-names.ts'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)

// Routing-form names are matched token by token (`isRoutingName`): `route`, `routing`,
// `routed` or `routings` as a whole word of a path, identifier or camelCase name.

const REST_PATHS = [
  '/api/v1/routing-forms',
  '/api/v1/routing-forms/{id}',
  '/api/v1/routing-forms/{id}/publish',
  '/api/v1/routing-forms/{id}/preview',
  '/api/v1/public/-/routing/{handle}/{slug}',
  '/api/v1/public/-/routing/teams/{teamSlug}/{slug}',
  '/api/v1/public/-/routing/{handle}/{slug}/route',
  '/api/v1/public/-/routing/teams/{teamSlug}/{slug}/route',
  '/api/v1/routing-continuations/resolve',
  '/api/v1/routing-continuations/slots',
  '/api/v1/routing-continuations/bookings',
]
const MCP_TOOLS = [
  'list_routing_forms',
  'get_routing_form',
  'create_routing_form',
  'update_routing_form',
  'archive_routing_form',
  'publish_routing_form',
  'preview_routing_form',
  'get_public_routing_form',
  'route_lead',
  'resolve_routing_continuation',
  'find_routed_slots',
]
const CLI_COMMANDS = [
  'list',
  'get',
  'create',
  'update',
  'archive',
  'publish',
  'preview',
  'public',
  'route',
  'resolve',
  'slots',
].map((verb) => `routing-forms ${verb}`)

// The storage layer: the migration, the generated table types and the storage test support.
const STORAGE_LAYER =
  /^packages\/db\/(migrations\/|src\/tables\.ts$|src\/routing-storage-[^/]+\.ts$)/
// A table name as a whole identifier, in any case (PostgreSQL folds unquoted identifiers):
// `list_routing_forms` or `routing_forms_disabled` is not one.
const STORAGE_NAMES =
  /routing-storage|(?<![a-z_])(?:routing_forms|routing_form_versions|routing_target_dependencies|routing_receipts|booking_routing)(?![a-z_])/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The one routing-named schema property a1b publishes: the effective routing state at
// `GET /api/v1/instance` (always false until the operator setting exists).
const INSTANCE_CAPABILITY = 'Instance.routingFormsEnabled'

/** `Schema.property` for every property of every component schema, nested ones included. */
function schemaPropertyNames(document: unknown): string[] {
  if (!isRecord(document) || !isRecord(document.components)) return []
  const schemas = document.components.schemas
  if (!isRecord(schemas)) return []
  const names: string[] = []
  const visit = (owner: string, value: unknown) => {
    if (Array.isArray(value)) for (const item of value) visit(owner, item)
    if (!isRecord(value)) return
    if (isRecord(value.properties))
      for (const property of Object.keys(value.properties)) names.push(`${owner}.${property}`)
    for (const child of Object.values(value)) visit(owner, child)
  }
  for (const [name, schema] of Object.entries(schemas)) visit(name, schema)
  return names
}

/** Every name the OpenAPI document assigns: paths, operation IDs, tags and component names. */
function openApiNames(document: unknown): string[] {
  if (!isRecord(document) || !isRecord(document.paths)) throw new Error('OpenAPI paths missing')
  const names: string[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    names.push(path)
    if (!isRecord(item)) continue
    for (const operation of Object.values(item)) {
      if (!isRecord(operation)) continue
      if (typeof operation.operationId === 'string') names.push(operation.operationId)
      if (Array.isArray(operation.tags))
        names.push(...operation.tags.filter((t) => typeof t === 'string'))
    }
  }
  if (isRecord(document.components))
    for (const group of Object.values(document.components))
      if (isRecord(group)) names.push(...Object.keys(group))
  return names
}

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
// generated files (`*.d.ts`, the database table types).
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

// Syntax trees for the scans below. Babel's node shapes are read structurally.
type SyntaxNode = { type: string; start?: number | null; end?: number | null } & Record<
  string,
  unknown
>
const POSITION_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'range',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
])
function parseSource(file: string, source: string) {
  return parse(source, {
    sourceType: 'module',
    plugins: file.endsWith('.tsx')
      ? ['typescript', 'jsx']
      : /\.m?js$/.test(file)
        ? []
        : ['typescript'],
  })
}
function isNode(value: unknown): value is SyntaxNode {
  return isRecord(value) && typeof value.type === 'string'
}
/** Calls `visit` for every node below `root`, with its parent. */
function walk(root: unknown, visit: (node: SyntaxNode, parent?: SyntaxNode) => void) {
  const stack: [unknown, SyntaxNode | undefined][] = [[root, undefined]]
  while (stack.length) {
    const [value, parent] = stack.pop() as [unknown, SyntaxNode | undefined]
    if (Array.isArray(value)) {
      for (const item of value) stack.push([item, parent])
      continue
    }
    if (!isNode(value)) continue
    visit(value, parent)
    for (const [key, child] of Object.entries(value))
      if (!POSITION_KEYS.has(key) && typeof child === 'object' && child !== null)
        stack.push([child, value])
  }
}

// Stands for an operand whose value the scan cannot know (an identifier, a call).
const UNKNOWN_PART = '{}'
// Alternatives kept per expression, so a long chain of conditionals stays cheap.
const MAX_VARIANTS = 64
function concatenations(parts: string[][]): string[] {
  let variants = ['']
  for (const options of parts)
    variants = variants
      .flatMap((prefix) => options.map((option) => prefix + option))
      .slice(0, MAX_VARIANTS)
  return variants
}
/**
 * The strings an expression can build from literals, templates, `+`, and both branches of
 * `?:`, `||`, `??` and `&&`, with each unknown operand as `{}`.
 */
function foldStrings(node: SyntaxNode): string[] {
  switch (node.type) {
    case 'StringLiteral':
      return [String(node.value)]
    case 'TemplateLiteral': {
      const quasis = node.quasis as { value: { cooked?: string | null; raw: string } }[]
      const expressions = node.expressions as SyntaxNode[]
      return concatenations(
        quasis.flatMap(({ value }, index) => {
          const expression = expressions[index]
          return [[value.cooked ?? value.raw], ...(expression ? [foldStrings(expression)] : [])]
        }),
      )
    }
    case 'BinaryExpression':
      return node.operator === '+'
        ? concatenations([
            foldStrings(node.left as SyntaxNode),
            foldStrings(node.right as SyntaxNode),
          ])
        : [UNKNOWN_PART]
    case 'ConditionalExpression':
      return [
        ...foldStrings(node.consequent as SyntaxNode),
        ...foldStrings(node.alternate as SyntaxNode),
      ].slice(0, MAX_VARIANTS)
    case 'LogicalExpression':
      return [
        ...foldStrings(node.left as SyntaxNode),
        ...foldStrings(node.right as SyntaxNode),
      ].slice(0, MAX_VARIANTS)
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return foldStrings(node.expression as SyntaxNode)
    default:
      return [UNKNOWN_PART]
  }
}
function isStringConcatenation(node: SyntaxNode): boolean {
  if (node.type !== 'BinaryExpression' || node.operator !== '+') return false
  return [node.left, node.right].some(
    (operand) =>
      isNode(operand) &&
      (operand.type === 'StringLiteral' ||
        operand.type === 'TemplateLiteral' ||
        isStringConcatenation(operand)),
  )
}
/**
 * The paths a source builds instead of writing them as one `/…` literal: every string that
 * a template literal or an outermost `+` concatenation with a string operand can build
 * (foldStrings), that begins with `/` after any unknown prefix (`${prefix}/route`,
 * `'/rout' + 'e'`, `` `/rout${'e'}` ``, `` `/${x ? 'route' : 'book'}` ``). A separator inside
 * the unknown part (`` `${API}route` ``) is not recognised; the literal scan still reads the
 * prefix constant and the inventory still sees a registered route.
 */
function builtPaths(file: string, source: string): string[] {
  const paths: string[] = []
  walk(parseSource(file, source), (node, parent) => {
    const outermost =
      node.type === 'TemplateLiteral' ||
      (isStringConcatenation(node) && !(parent && isStringConcatenation(parent)))
    if (!outermost) return
    for (const folded of foldStrings(node)) if (/^(?:\{\})*\//.test(folded)) paths.push(folded)
  })
  return paths
}

// The production entry points: the Docker image's command, its migration commands, the
// maintenance script it copies and the operator's Cal.com import command; the web app's page
// script, embed library and service workers; and the CLI. Anchored to the files that name
// them below.
const ENTRY_POINTS = [
  'apps/server/src/index.ts',
  'packages/db/src/migrate-cli.ts',
  'packages/jobs/src/migrate-cli.ts',
  'scripts/redispatch-calendar-writeback.ts',
  'packages/import-calcom/src/cli.ts',
  'apps/web/src/main.tsx',
  'apps/web/src/embed/entry.ts',
  'apps/web/pwa/worker.js',
  'apps/web/pwa/disabled-worker.js',
  'tools/cli/src/index.ts',
]

/**
 * The module specifiers a file loads at run time: value imports and re-exports (an import
 * with only inline `type` specifiers still loads its module under verbatimModuleSyntax),
 * literal dynamic imports, `new URL('./…', import.meta.url)` and `import.meta.glob`
 * patterns. Type-only imports and re-exports are erased before anything runs. A dynamic
 * import of a computed specifier fails, since the graph could not follow it.
 */
function runtimeSpecifiers(file: string, source: string): string[] {
  const specifiers: string[] = []
  const literal = (node: unknown) =>
    isNode(node) && node.type === 'StringLiteral'
      ? String(node.value)
      : isNode(node) &&
          node.type === 'TemplateLiteral' &&
          (node.expressions as unknown[]).length === 0
        ? foldStrings(node)[0]
        : undefined
  const isImportMeta = (node: unknown) =>
    isNode(node) &&
    node.type === 'MetaProperty' &&
    isRecord(node.meta) &&
    node.meta.name === 'import' &&
    isRecord(node.property) &&
    node.property.name === 'meta'
  walk(parseSource(file, source), (node) => {
    if (
      (node.type === 'ImportDeclaration' && node.importKind !== 'type') ||
      ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
        node.source &&
        node.exportKind !== 'type')
    )
      specifiers.push(String((node.source as SyntaxNode).value))
    const dynamic =
      node.type === 'ImportExpression'
        ? node.source
        : node.type === 'CallExpression' && isRecord(node.callee) && node.callee.type === 'Import'
          ? (node.arguments as unknown[])[0]
          : undefined
    if (dynamic !== undefined) {
      const specifier = literal(dynamic)
      if (specifier === undefined) throw new Error(`${file}: computed dynamic import`)
      specifiers.push(specifier)
    }
    const [first, second] = (node.arguments as unknown[] | undefined) ?? []
    if (
      node.type === 'NewExpression' &&
      isRecord(node.callee) &&
      node.callee.name === 'URL' &&
      literal(first)?.startsWith('.') &&
      isNode(second) &&
      second.type === 'MemberExpression' &&
      isImportMeta(second.object)
    )
      specifiers.push(literal(first) as string)
    if (
      node.type === 'CallExpression' &&
      isNode(node.callee) &&
      node.callee.type === 'MemberExpression' &&
      isImportMeta(node.callee.object) &&
      isRecord(node.callee.property) &&
      node.callee.property.name === 'glob'
    )
      for (const pattern of isNode(first) && first.type === 'ArrayExpression'
        ? (first.elements as unknown[])
        : [first]) {
        const value = literal(pattern)
        if (value === undefined) throw new Error(`${file}: computed import.meta.glob`)
        specifiers.push(`glob:${value}`)
      }
  })
  return specifiers
}

/** Workspace package name → directory and `exports`, for `@hourmere/…` specifiers. */
function workspacePackages() {
  const packages = new Map<string, { directory: string; exports: unknown }>()
  for (const group of ['apps', 'packages', 'tools'])
    for (const name of readdirSync(new URL(group, root))) {
      const manifest = join(rootPath, group, name, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (isRecord(parsed) && typeof parsed.name === 'string')
        packages.set(parsed.name, { directory: join(group, name), exports: parsed.exports })
    }
  return packages
}

const CODE_FILE = /\.(?:ts|tsx|js|mjs)$/
const isFile = (path: string) =>
  existsSync(join(rootPath, path)) && statSync(join(rootPath, path)).isFile()

/** Every file below `directory` whose path relative to it matches the glob. */
function globFiles(directory: string, glob: string): string[] {
  const literal = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^${glob
      .replace(/^\.\//, '')
      .split('**/')
      .map((part) => part.split('*').map(literal).join('[^/]*'))
      .join('(?:.*/)?')}$`,
  )
  const matches: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(join(rootPath, current))) {
      const path = join(current, entry)
      if (statSync(join(rootPath, path)).isDirectory()) visit(path)
      else if (pattern.test(relative(directory, path))) matches.push(path)
    }
  }
  const base = glob.startsWith('../') ? normalize(join(directory, '..')) : directory
  visit(base)
  return matches
}

/** The repository files the production entry points load at run time, transitively. */
function runtimeGraph(entries: readonly string[]): Set<string> {
  const packages = workspacePackages()
  const resolve = (from: string, specifier: string): string[] => {
    const directory = dirname(from)
    if (specifier.startsWith('glob:')) return globFiles(directory, specifier.slice(5))
    const bare = specifier.split('?')[0] ?? ''
    if (bare.startsWith('.')) {
      const base = normalize(join(directory, bare))
      // A directory URL (migrations, mail catalogues): whatever it holds may be loaded.
      if (existsSync(join(rootPath, base)) && statSync(join(rootPath, base)).isDirectory())
        return globFiles(base, '**/*')
      const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(isFile)
      if (!found) throw new Error(`${from}: cannot resolve ${specifier}`)
      return [found]
    }
    const name = [...packages.keys()].find((name) => bare === name || bare.startsWith(`${name}/`))
    if (!name) return [] // A dependency outside the repository.
    const { directory: packageDirectory, exports } = packages.get(name) as {
      directory: string
      exports: unknown
    }
    const subpath = `.${bare.slice(name.length)}`
    const target = isRecord(exports) ? exports[subpath] : subpath === '.' ? exports : undefined
    const file =
      typeof target === 'string'
        ? target
        : isRecord(target)
          ? (target.import ?? target.default)
          : undefined
    if (typeof file !== 'string') throw new Error(`${from}: ${specifier} is not exported`)
    return [normalize(join(packageDirectory, file))]
  }
  const reached = new Set<string>()
  const queue = [...entries]
  while (queue.length) {
    const file = queue.pop() as string
    if (reached.has(file)) continue
    reached.add(file)
    if (!CODE_FILE.test(file) || file.endsWith('.d.ts')) continue
    for (const specifier of runtimeSpecifiers(file, readFileSync(join(rootPath, file), 'utf8')))
      queue.push(...resolve(file, specifier))
  }
  return reached
}

/** The production sources an exclusion list removes from the scan. */
function excludedSources(patterns: readonly RegExp[]): string[] {
  return productionSources().filter((file) => patterns.some((pattern) => pattern.test(file)))
}

function expectExcludedUnreachable(patterns: readonly RegExp[], reached: Set<string>) {
  const excluded = excludedSources(patterns)
  expect(excluded.length).toBeGreaterThan(0)
  expect(excluded.filter((file) => reached.has(file))).toEqual([])
}

describe('routing forms are storage only', () => {
  it('names each documented routing surface so an added one is recognised', () => {
    for (const name of [
      ...REST_PATHS,
      ...MCP_TOOLS,
      ...CLI_COMMANDS,
      // camelCase operation IDs and component or tag names the later steps would use.
      'routeLead',
      'listRoutingForms',
      'RoutingForm',
      'Routing forms',
      'ROUTE_LEAD',
      '/api/v1/routing_forms',
      '/api/v1/forms/{id}/route',
      '/route/:handle/:slug',
      // An acronym run before the word, and a digit before or after it.
      'getMCPRoute',
      'MCPRoutingForm',
      'getV2Route',
      'v2Route',
      'route2',
      'Route2',
      'routing2',
      'v2route',
      'routings',
      // Run-together compounds.
      'routeforms',
      'routingforms',
      '/api/v1/routingforms',
      'routeleads',
      'ROUTEDSLOTS',
      'getRoutelead',
    ])
      expect(isRoutingName(name), name).toBe(true)
    // Words that merely contain the letters are not routing names.
    for (const name of [
      'reroute',
      'reroute_booking',
      'rerouting',
      'rerouted',
      '/api/v1/bookings/{id}/rerouting',
      'router',
      'router-status',
      'getRouterStatus',
      'RouterStatus',
      'routes',
      '/routes/:id',
      '/app/router',
      '/api/v1/bookings/{id}',
      '/api/auth/oauth2/authorize',
      'oauth2',
    ])
      expect(isRoutingName(name), name).toBe(false)
  })

  it('recognises routing table names as whole identifiers in any case', () => {
    for (const source of [
      "selectFrom('booking_routing')",
      'DELETE FROM "routing_receipts"',
      'SELECT 1 FROM ROUTING_RECEIPTS',
      'from Routing_Forms',
      "import './routing-storage-limits.ts'",
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(true)
    for (const source of ['list_routing_forms', 'ROUTING_FORMS_DISABLED', 'routing_forms_disabled'])
      expect(STORAGE_NAMES.test(source), source).toBe(false)
  })

  it('exposes no routing path, operation, tag or schema in the OpenAPI document', async () => {
    const document = await openApiDocument()
    const names = openApiNames(document)
    expect(names.length).toBeGreaterThan(100)
    expect(names).toContain('/api/v1/bookings/{id}')
    for (const path of REST_PATHS) expect(names).not.toContain(path)
    expect(names.filter(isRoutingName)).toEqual([])
    // Schema properties too: narrowed by a1b to its one `/instance` capability.
    const properties = schemaPropertyNames(document)
    expect(properties.length).toBeGreaterThan(500)
    expect(properties).toContain('Slot.start')
    expect(properties.filter(isRoutingName)).toEqual([INSTANCE_CAPABILITY])
  })

  it('registers no routing route on the app startServer serves, with every optional group on', async () => {
    // The production assembly (createApp of productionAppOptions, as startServer calls it),
    // from a configuration that enables each optional route group: SCIM, MCP OAuth, slot snippets,
    // webhooks, the Zoom event webhook, the waitlist pages and the built web app, with the
    // Google Calendar, Microsoft Calendar and Zoom clients built the way startServer builds
    // them (dummy credentials; no handler runs, so none is ever called). Creating the app
    // touches no database (Better Auth is stood in for, since creating it would check its
    // schema); the pool is still closed explicitly.
    const databaseUrl = 'postgres://routing-off@127.0.0.1:9/routing-off'
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: 'routing-off-secret-with-at-least-32-characters',
      PUBLIC_URL: 'http://localhost',
      SCIM_PROVISIONING_ENABLED: 'true',
      MCP_OAUTH_ENABLED: 'true',
      SLOT_SNIPPETS_ENABLED: 'true',
      WEBHOOKS_ENABLED: 'true',
      WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      ZOOM_WEBHOOK_SECRET_TOKEN: 'routing-off-zoom-webhook-token',
      WEB_DIST: rootPath,
    })
    const db = createDb(createPool(databaseUrl))
    const credentials = { clientId: 'routing-off', clientSecret: 'routing-off' }
    const encryptionKey = Buffer.alloc(32, 1).toString('base64')
    try {
      const app = createApp(
        productionAppOptions({
          config,
          db,
          auth: { handler: async () => new Response(null, { status: 404 }) },
          resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
          resolveMcpOAuth: async () => ({ ok: false, error: 'invalid_token' }),
          checkDb: async () => {},
          waitlist: { verify: async () => null, remove: async () => null },
          invitationMailLimits: { secret: 'routing-off' },
          webhookSettings: {
            enabled: config.WEBHOOKS_ENABLED,
            encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
          },
          webhookQueue: { enqueue: async () => null },
          notify: async () => {},
          notifyAttendeeNoShow: async () => {},
          // The optional clients currently register no client-gated route: their OAuth
          // callbacks below register unconditionally, so the inventory is the same with or
          // without them and no positive control for a client-gated route is possible yet.
          // The step that adds the first one should make it that client's control.
          googleCalendar: {
            client: createGoogleCalendarClient({ ...credentials, publicUrl: config.PUBLIC_URL }),
            encryptionKey,
          },
          microsoftCalendar: {
            client: createMicrosoftCalendarClient({ ...credentials, publicUrl: config.PUBLIC_URL }),
            encryptionKey,
          },
          zoomConference: {
            client: createZoomClient({ ...credentials, publicUrl: config.PUBLIC_URL }),
            encryptionKey,
            meetingsEnabled: true,
          },
          enqueueCalendarSync: async () => null,
          enqueueCalendarWritebackRecovery: async () => null,
        }),
      )
      const paths = app.routes.map(({ path }) => path)
      expect(paths.length).toBeGreaterThan(100)
      // A versioned API route, a page outside /api, one route from each group whose switch
      // registers routes (MCP, its OAuth authorize guard, the waitlist pages, the Zoom event
      // webhook, the web app's assets), the SCIM mount, and each client's OAuth callback.
      for (const control of [
        '/api/v1/bookings/:id',
        '/api/v1/instance',
        '/sign-in/confirm',
        '/mcp',
        '/api/auth/oauth2/authorize',
        '/booking/waitlist/verify',
        '/api/conference/zoom/events',
        '/assets/*',
        '/scim/*',
        '/api/calendar/google/callback',
        '/api/calendar/microsoft/callback',
        '/api/conference/zoom/callback',
      ])
        expect(paths, control).toContain(control)
      expect(paths.filter(isRoutingName)).toEqual([])
      // a1b: the effective state the production assembly reports.
      const instance = await app.request('/api/v1/instance')
      expect(instance.status).toBe(200)
      expect(await instance.json()).toHaveProperty('routingFormsEnabled', false)
    } finally {
      await db.destroy()
    }
  })

  it('names no routing path in a production source string literal, template or concatenation', () => {
    // Backstop for a route the inventory cannot see: one registered outside the shared
    // assembly (a `.get` on the app in startServer, say), one gated on something the test
    // does not configure, or a Better Auth endpoint behind /api/auth/*. Its path must be
    // written somewhere, so every non-test TypeScript/JavaScript source under each apps,
    // packages and tools workspace's `src` directory is checked, wherever the constant lives:
    // every string literal that begins with `/`, and every path built by a template literal
    // or a `+` concatenation (builtPaths).
    const sources = productionSources()
      .filter((file) => !NOT_SHIPPED.some((pattern) => pattern.test(file)))
      .map((file) => [file, readFileSync(new URL(file, root), 'utf8')] as const)
    const literals = sources
      .flatMap(([, source]) => [...source.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)])
      .map(([, , literal]) => literal ?? '')
    expect(literals.length).toBeGreaterThan(500)
    // One literal each from the server, a package and the web app.
    expect(literals).toContain('/api/v1/bookings/{id}')
    expect(literals).toContain('/sign-in/confirm')
    expect(literals).toContain('/booking')
    expect(literals.filter(isRoutingName)).toEqual([])
    const built = sources.flatMap(([file, source]) => builtPaths(file, source))
    expect(built.length).toBeGreaterThan(50)
    // The `${prefix}/…` idiom of the MCP OAuth consent routes.
    expect(built).toContain('{}/consent')
    expect(built.filter(isRoutingName)).toEqual([])
  }, 30_000)

  it('folds built paths so a routing path cannot hide in a template or concatenation', () => {
    const routing = [
      "const path = '/rout' + 'e'",
      "const path = '/api/v1/' + 'rout' + 'ing-forms'",
      `const path = \`/rout\${"e"}/{handle}\``,
      `const path = \`\${publicPrefix}/route\``,
      `app.get(\`\${prefix}/\${id}/routing-forms\`, handler)`,
      `createAuthEndpoint(\`\${prefix}/route\`, {}, handler)`,
      "const path = PREFIX + '/route'",
      "const path = (BASE as string) + '/routed-slots'",
      `const path = \`/\${listed ? 'route' : 'book'}/\${slug}\``,
      "const path = '/' + (kind ?? 'routing') + '-forms'",
    ]
    for (const source of routing)
      expect(builtPaths('probe.ts', source).filter(isRoutingName), source).not.toEqual([])
    // Neither a relative or package specifier, nor a word that merely contains the letters.
    for (const source of [
      "const module = 'hono/' + 'route'",
      'const file = `./route-error-scope.tsx`',
      `const path = \`\${base}/routes/\${id}\``,
      "const path = '/router' + '-status'",
      `const path = \`/\${team ? 'team' : 'personal'}/routes\``,
      `const path = \`\${origin}\${path}\``,
    ])
      expect(builtPaths('probe.ts', source).filter(isRoutingName), source).toEqual([])
  })

  it('excludes from the scan only files no production entry point loads', () => {
    // The entry points as the shipped artifacts name them.
    const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8')
    expect(dockerfile).toContain('CMD ["node", "apps/server/src/index.ts"]')
    expect(dockerfile).toContain('/app/scripts/redispatch-calendar-writeback.ts')
    const manifest = readFileSync(new URL('package.json', root), 'utf8')
    expect(manifest).toContain('packages/db/src/migrate-cli.ts')
    expect(manifest).toContain('packages/jobs/src/migrate-cli.ts')
    expect(readFileSync(new URL('packages/import-calcom/package.json', root), 'utf8')).toContain(
      '"import-calcom": "node src/cli.ts"',
    )
    expect(readFileSync(new URL('apps/web/index.html', root), 'utf8')).toContain(
      'src="/src/main.tsx"',
    )
    expect(readFileSync(new URL('apps/web/vite.embed.config.ts', root), 'utf8')).toContain(
      "'./src/embed/entry.ts'",
    )
    const workers = readFileSync(new URL('apps/web/pwa/build.ts', root), 'utf8')
    expect(workers).toContain("'./worker.js'")
    expect(workers).toContain("'./disabled-worker.js'")
    expect(readFileSync(new URL('tools/cli/tsconfig.build.json', root), 'utf8')).toContain(
      'src/index.ts',
    )
    const reached = runtimeGraph(ENTRY_POINTS)
    // The graph follows relative, workspace-package, dynamic and glob imports.
    for (const file of [
      'apps/server/src/server.ts',
      'apps/server/src/app.ts',
      'apps/server/src/routes/calendars.ts',
      'packages/auth/src/magic-link.ts',
      'packages/db/src/index.ts',
      'packages/scheduling/src/index.ts',
      'apps/web/src/App.tsx',
      'apps/web/src/i18n/catalogues/en/admin.ts',
      'tools/cli/src/cli.ts',
    ])
      expect(reached, file).toContain(file)
    // Imported by production only as types, which type stripping and bundling erase.
    expect(reached).not.toContain('packages/db/src/tables.ts')
    expect(reached).not.toContain('apps/web/src/api/schema.d.ts')
    expectExcludedUnreachable(NOT_SHIPPED, reached)
    // The graph starts from the server, web and CLI entry points only (not the marketing
    // site, the n8n node or the Zapier app), so every excluded file must belong to one of
    // the workspaces they load; extend ENTRY_POINTS before excluding a file elsewhere.
    expect(
      excludedSources(NOT_SHIPPED).filter(
        (file) => !/^(?:apps\/server|apps\/web|packages\/[^/]+|tools\/cli)\//.test(file),
      ),
    ).toEqual([])
    // Adding a shipped file to the exclusion list fails.
    for (const shipped of [
      /^packages\/scheduling\//,
      /^packages\/(?!auth\/)/,
      /server\.ts$/,
      /^apps\/web\/src\/paths\.ts$/,
      /^tools\/cli\//,
    ])
      expect(() => expectExcludedUnreachable([...NOT_SHIPPED, shipped], reached)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
  }, 30_000)

  it('follows exactly the imports that load a module at run time', () => {
    const source = [
      "import type { A } from './type-only.ts'",
      "import { type B } from './inline-type.ts'",
      "import C from './value.ts'",
      "import './side-effect.ts'",
      "export type * from './type-export.ts'",
      "export * from './value-export.ts'",
      "export type { D } from './type-named.ts'",
      "export { E } from './value-named.ts'",
      "const F = await import('./dynamic.ts')",
      "const G = new URL('./worker.js', import.meta.url)",
      "const H = import.meta.glob('./catalogues/*/admin.ts')",
      "type I = import('./type-query.ts').I",
    ].join('\n')
    expect(runtimeSpecifiers('probe.ts', source).sort()).toEqual(
      [
        './inline-type.ts',
        './value.ts',
        './side-effect.ts',
        './value-export.ts',
        './value-named.ts',
        './dynamic.ts',
        './worker.js',
        'glob:./catalogues/*/admin.ts',
      ].sort(),
    )
    expect(() => runtimeSpecifiers('probe.ts', `await import(\`./\${name}.ts\`)`)).toThrow(
      'computed dynamic import',
    )
    expect(() => runtimeSpecifiers('probe.ts', 'await import(name)')).toThrow(
      'computed dynamic import',
    )
  })

  it('lists no routing MCP tool, with every optional catalogue enabled', async () => {
    // No handlers run and no connection opens; the pool is still closed explicitly.
    const pool = createPool('postgres://routing-off@127.0.0.1:9/routing-off')
    try {
      const names = prepareTools(
        productTools({ db: createDb(pool), slotSnippetsEnabled: true }),
      ).map(({ tool }) => tool.name)
      expect(names.length).toBeGreaterThan(20)
      expect(names).toContain('create_booking')
      for (const tool of MCP_TOOLS) expect(names).not.toContain(tool)
      expect(names.filter(isRoutingName)).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('offers no routing CLI command', () => {
    const names = [
      ...Object.keys(COMMANDS),
      ...Object.values(COMMANDS),
      ...Object.keys(REST_COMMANDS),
      ...Object.values(REST_COMMANDS),
    ]
    expect(names).toContain('book')
    for (const command of CLI_COMMANDS) expect(names).not.toContain(command)
    expect(names.filter(isRoutingName)).toEqual([])
  })

  it('keeps the routing storage unreferenced outside the storage layer', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('packages/db/src/index.ts')
    const storage = sources.filter((file) => STORAGE_LAYER.test(file))
    // The matcher sees the storage layer itself, so an import elsewhere cannot hide from it.
    expect(storage).toContain('packages/db/src/tables.ts')
    expect(
      storage.some((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8'))),
    ).toBe(true)
    const referencing = sources
      .filter((file) => !STORAGE_LAYER.test(file))
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
  })
})
