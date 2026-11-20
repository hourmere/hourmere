// Workflow definition operations and creation capture stay behind the pinned hard-off guard.
// This inventory admits only those interfaces and the exact data-access modules below.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { CallerResolver, Principal } from '@hourmere/auth'
import { createGoogleCalendarClient, createMicrosoftCalendarClient } from '@hourmere/calendars'
import { createZoomClient } from '@hourmere/conferences'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { prepareTools } from '../apps/server/src/mcp/tools.ts'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productionAppOptions, productTools } from '../apps/server/src/server.ts'
import { workflowsGuard } from '../apps/server/src/workflows.ts'
import { PATHS, workflowEditPath, workflowRunHistoryPath } from '../apps/web/src/paths.ts'
// After the server modules, which extend zod for OpenAPI before any schema is built.
import * as workflows from '../packages/workflows/src/index.ts'
import { COMMANDS, HELP, REST_COMMANDS } from '../tools/cli/src/cli.ts'

const root = new URL('..', import.meta.url)
const document = readFileSync(new URL('docs/workflows.md', root), 'utf8')

/** The document's operation table: method and path, operationId, MCP tool and CLI command. */
const operations = [
  ...document.matchAll(
    /^\| (GET|POST|PATCH|DELETE) `(\/workflows[^`]*)` \| `(\w+)` \| `(\w+)` \| `(workflows [a-z]+)` \|$/gm,
  ),
].map(([, method, path, operationId, tool, command]) => ({
  method: method as string,
  path: `/api/v1${path}`,
  operationId: operationId as string,
  tool: tool as string,
  command: command as string,
}))

/** The operations shipped while workflows are off; every other one is still absent. */
const SHIPPED = [
  'listWorkflows',
  'createWorkflow',
  'getWorkflow',
  'updateWorkflow',
  'deleteWorkflow',
  'previewWorkflow',
  'listWorkflowRuns',
]
const shipped = operations.filter(({ operationId }) => SHIPPED.includes(operationId))
const absent = operations.filter(({ operationId }) => !SHIPPED.includes(operationId))

/** A Hono path such as `/api/v1/workflows/:id`, from an OpenAPI path. */
const honoPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1')
/** Any workflow-named route, OpenAPI path or CLI command, beyond the documented ones. */
const workflowSegment = /(?:^|\/)workflows?(?:\/|$)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The storage layer: the migrations, the generated table types and exactly these storage test
// support modules (test files are not production sources). A new module is not exempt because
// of its name: it must be added here by name.
const STORAGE_SUPPORT = [
  'packages/db/src/workflow-storage-protections.ts',
  'packages/db/src/workflow-storage-execution-protections.ts',
  'packages/db/src/workflow-storage-creation-keys-protections.ts',
  'packages/db/src/workflow-storage-lock-order.ts',
]
const isStorageLayer = (file: string) =>
  file.startsWith('packages/db/migrations/') ||
  file === 'packages/db/src/tables.ts' ||
  STORAGE_SUPPORT.includes(file)
// The workflow tables of migrations 0076, 0079 and 0087.
const STORAGE_TABLES = [
  'workflow_definitions',
  'workflow_revisions',
  'workflow_enrollments',
  'workflow_runs',
  'workflow_recipient_claims',
  'workflow_run_history',
  'workflow_mail_reservations',
  'workflow_creation_keys',
]
/** `workflow_run_history` → `WorkflowRunHistory`, the generated row type. */
const rowType = (table: string) =>
  table.replace(/(?:^|_)([a-z])/g, (_, letter: string) => letter.toUpperCase())
// A table name as a whole identifier in any case (PostgreSQL folds unquoted identifiers), its
// generated row type, or the storage test support. `WorkflowDefinitionSchema`,
// `workflowRunTiming` or `workflow_runs_due` is not one. A name scan has a known limit: a
// module that builds a table name at run time (joining its parts, say) does not contain it, so
// review must still catch such code.
const STORAGE_NAMES = new RegExp(
  `workflow-storage|(?<![A-Za-z0-9_])(?:${[...STORAGE_TABLES, ...STORAGE_TABLES.map(rowType)].join('|')})(?![A-Za-z0-9_])`,
  'i',
)
// The modules that own workflow data access, including guarded definition and history reads.
// Deletion retires pending runs; capture writes enrollments, runs, claims and skip history.
const DATA_ACCESS = [
  'packages/workflows/src/reads.ts',
  'packages/workflows/src/creates.ts',
  'packages/workflows/src/updates.ts',
  'packages/workflows/src/deletes.ts',
  'packages/workflows/src/capture.ts',
  'packages/workflows/src/dispatcher.ts',
  'packages/workflows/src/email-attempt.ts',
  'packages/notifications/src/workflow-mail.ts',
]
const DEFINITION_TABLES = ['workflow_definitions', 'workflow_revisions', 'workflow_creation_keys']
const WEBHOOK_DELIVERY_TEST_FIXTURE = 'packages/webhooks/src/workflow-delivery-fixture.ts'

/** Process source in each workspace, with standalone scripts when checking audit wiring. */
function productionSources(): string[] {
  const rootPath = fileURLToPath(root)
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        files.push(relative(rootPath, path))
    }
  }
  for (const group of ['apps', 'packages', 'tools'])
    for (const name of readdirSync(new URL(group, root)))
      for (const directory of ['src', 'scripts']) {
        const source = new URL(`${group}/${name}/${directory}`, root)
        try {
          if (statSync(source).isDirectory()) walk(fileURLToPath(source))
        } catch {
          // Not a workspace with sources.
        }
      }
  walk(fileURLToPath(new URL('scripts', root)))
  return files.filter((file) => file !== WEBHOOK_DELIVERY_TEST_FIXTURE).sort()
}

// Frozen alongside the package hard-off module: availability and tool discovery must never
// acquire a configuration, environment or caller-controlled escape hatch.
const FROZEN_SERVER_GUARD_STATEMENTS = [
  `import { DomainError } from '@hourmere/scheduling'`,
  `import { requireWorkflowsImplemented, workflowOperation } from '@hourmere/workflows'`,
  `import type { Context, Next } from 'hono'`,
  `import { createMiddleware } from 'hono/factory'`,
  `import type { CallerEnv } from './caller.ts'`,
  `import type { Tool } from './mcp/tools.ts'`,
  `export const workflowsGuard = createMiddleware<CallerEnv>(
  workflowOperation(async (_c: Context<CallerEnv>, next: Next) => {
    await next()
  }),
)`,
  `export function workflowFeatureTools(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => ({ ...tool, requireAvailable: requireWorkflowsImplemented }))
}`,
  `export function workflowsAvailable(): boolean {
  try {
    requireWorkflowsImplemented()
    return true
  } catch (error) {
    if (error instanceof DomainError && error.code === 'workflows_disabled') return false
    throw error
  }
}`,
]

// Protect real source identities, including re-exports and the services behind the guard.
const PROTECTED_MOCK_FILES = new Set(
  [
    ...productionSources().filter((file) => file.startsWith('packages/workflows/src/')),
    'apps/server/src/workflows.ts',
  ].map((file) => realpathSync(new URL(file, root))),
)

/** Resolve from the importing test, with TypeScript's .js-to-.ts source substitution. */
function mockTarget(name: string, testFile: string): string | undefined {
  if (isBuiltin(name)) return name
  try {
    const path = name.startsWith('file:')
      ? fileURLToPath(name)
      : name.startsWith('.') || isAbsolute(name)
        ? resolve(dirname(testFile), name)
        : // Workspace export maps resolve package names/subpaths to their source entry.
          createRequire(testFile).resolve(name)
    for (const candidate of [
      path.replace(/\.js$/, '.ts'),
      path,
      `${path}.ts`,
      `${path}.js`,
      join(path, 'index.ts'),
      join(path, 'index.js'),
    ]) {
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate)
      } catch {
        // Try the next source extension or directory entry.
      }
    }
  } catch {
    // An unresolved target cannot be proved to leave the guards intact.
  }
  return undefined
}

/**
 * Reject protected module mocks and unresolved targets conservatively. Runtime-built paths
 * cannot prove they leave the guards intact. Inspect syntax, not adjacent source text, so
 * computed member names, namespace aliases and dynamic-import mock syntax are covered.
 * This is a source guard, not a JavaScript interpreter: extracted/aliased mock functions,
 * eval and custom test-loader aliases/indirection still require review. Node export maps
 * cover the workspace packages; unresolved literals and runtime-built paths fail closed.
 */
function hasWorkflowMock(source: string, testFile: string): boolean {
  let forbidden = false
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isRecord(value)) return
    if (value.type === 'CallExpression' && isRecord(value.callee)) {
      const callee = value.callee
      const property = isRecord(callee.property) ? callee.property : undefined
      const method = callee.computed ? property?.value : property?.name
      if (
        callee.type === 'MemberExpression' &&
        (method === 'mock' || method === 'doMock' || method === 'importMock')
      ) {
        let target = Array.isArray(value.arguments) ? value.arguments[0] : undefined
        if (isRecord(target) && target.type === 'ImportExpression') target = target.source
        if (
          isRecord(target) &&
          target.type === 'CallExpression' &&
          isRecord(target.callee) &&
          target.callee.type === 'Import'
        )
          target = Array.isArray(target.arguments) ? target.arguments[0] : undefined
        const name = isRecord(target) && target.type === 'StringLiteral' ? target.value : undefined
        const resolved = typeof name === 'string' ? mockTarget(name, testFile) : undefined
        if (resolved === undefined || PROTECTED_MOCK_FILES.has(resolved)) forbidden = true
      }
    }
    Object.values(value).forEach(visit)
  }
  visit(parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program)
  return forbidden
}

/** API-key callers the production assembly's resolver accepts; no database is contacted. */
function keyCaller(apiKeyScope: 'full' | 'read' | 'bookings'): Principal {
  return {
    kind: 'api_key',
    apiKeyScope,
    apiKeyId: randomUUID(),
    user: { id: randomUUID(), name: 'Workflows off', email: 'workflows-off@example.test' },
    organization: {
      id: randomUUID(),
      name: 'Workflows off',
      slug: 'workflows-off',
      personal: true,
    },
  }
}
const keys = { full: keyCaller('full'), read: keyCaller('read'), bookings: keyCaller('bookings') }
const resolveCaller: CallerResolver = async (headers) => {
  const scope = headers.get('authorization')?.match(/^Bearer hm_workflows_off_(\w+)$/)?.[1]
  return scope !== undefined && Object.hasOwn(keys, scope)
    ? { ok: true, principal: keys[scope as keyof typeof keys], setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}
const bearer = (scope: keyof typeof keys) => `Bearer hm_workflows_off_${scope}`

/** The production assembly, as scripts/routing-forms-off.test.ts builds it. */
function productionApp(db: ReturnType<typeof createDb>, databaseUrl: string) {
  // Every optional route group switched on; no handler that would contact the database runs.
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: 'workflows-off-secret-with-at-least-32-characters',
    PUBLIC_URL: 'http://localhost',
    SCIM_PROVISIONING_ENABLED: 'true',
    MCP_OAUTH_ENABLED: 'true',
    SLOT_SNIPPETS_ENABLED: 'true',
    WEBHOOKS_ENABLED: 'true',
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ZOOM_WEBHOOK_SECRET_TOKEN: 'workflows-off-zoom-webhook-token',
    WEB_DIST: fileURLToPath(root),
  })
  const credentials = { clientId: 'workflows-off', clientSecret: 'workflows-off' }
  const encryptionKey = Buffer.alloc(32, 1).toString('base64')
  return createApp(
    productionAppOptions({
      config,
      db,
      auth: { handler: async () => new Response(null, { status: 404 }) },
      resolveCaller,
      resolveMcpOAuth: async () => ({ ok: false, error: 'invalid_token' }),
      checkDb: async () => {},
      waitlist: { verify: async () => null, remove: async () => null },
      invitationMailLimits: { secret: 'workflows-off' },
      webhookSettings: {
        enabled: config.WEBHOOKS_ENABLED,
        encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
      },
      webhookQueue: { enqueue: async () => null },
      notify: async () => {},
      notifyAttendeeNoShow: async () => {},
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
      mailboxProofQueue: { enqueue: async () => null },
    }),
  )
}

/** One JSON-RPC MCP request with an API key; the result or protocol error. */
async function mcp(
  app: ReturnType<typeof productionApp>,
  scope: keyof typeof keys,
  method: 'tools/list' | 'tools/call',
  params: Record<string, unknown> = {},
) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: bearer(scope),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : text) as {
    result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] }
  }
}
const toolError = (message: Awaited<ReturnType<typeof mcp>>) => {
  expect(message.result?.isError).toBe(true)
  return JSON.parse(message.result?.content?.[0]?.text ?? '{}')
}

describe('booking workflows are off and expose the shipped operations', () => {
  it('reads every documented workflow operation from the design', () => {
    expect(operations.map(({ operationId }) => operationId)).toEqual([
      'listWorkflows',
      'createWorkflow',
      'getWorkflow',
      'updateWorkflow',
      'deleteWorkflow',
      'previewWorkflow',
      'listWorkflowRuns',
    ])
    expect(new Set(operations.map(({ tool }) => tool)).size).toBe(operations.length)
    expect(new Set(operations.map(({ command }) => command)).size).toBe(operations.length)
    expect(document).toContain('`workflowsEnabled`')
    expect(shipped.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/v1/workflows',
      'POST /api/v1/workflows',
      'GET /api/v1/workflows/{id}',
      'PATCH /api/v1/workflows/{id}',
      'DELETE /api/v1/workflows/{id}',
      'POST /api/v1/workflows/preview',
      'GET /api/v1/workflows/{id}/runs',
    ])
  })

  it('publishes the shipped paths, operations and the instance field in OpenAPI', async () => {
    const openapi = (await openApiDocument()) as Record<string, unknown>
    expect(isRecord(openapi.paths)).toBe(true)
    const paths = openapi.paths as Record<string, Record<string, unknown>>
    expect(paths).toHaveProperty(['/api/v1/bookings/{id}'])
    const operationIds = Object.values(paths)
      .filter(isRecord)
      .flatMap((item) => Object.values(item).filter(isRecord))
      .map((operation) => operation.operationId)
    // Not every published operation names an ID yet; enough do for the check to see them.
    expect(operationIds.filter((id) => typeof id === 'string').length).toBeGreaterThan(20)
    for (const { method, path, operationId } of shipped) {
      const operation = paths[path]?.[method.toLowerCase()] as Record<string, unknown>
      expect(operation?.operationId, operationId).toBe(operationId)
      // Each says it is not available yet, as the design requires of every listed interface.
      expect(String(operation?.description)).toContain('404 workflows_disabled')
    }
    for (const { method, path, operationId } of absent) {
      expect(paths[path]?.[method.toLowerCase()], `${method} ${path}`).toBeUndefined()
      expect(operationIds).not.toContain(operationId)
    }
    expect(Object.keys(paths).filter((path) => workflowSegment.test(path))).toEqual([
      '/api/v1/workflows',
      '/api/v1/workflows/preview',
      '/api/v1/workflows/{id}',
      '/api/v1/workflows/{id}/runs',
    ])
    expect(Object.keys(paths['/api/v1/workflows/preview'] ?? {})).toEqual(['post'])
    expect(Object.keys(paths['/api/v1/workflows/{id}/runs'] ?? {})).toEqual(['get'])
    for (const path of ['/api/v1/workflows', '/api/v1/workflows/{id}'])
      expect(Object.keys(paths[path] ?? {}).sort(), path).toEqual(
        path === '/api/v1/workflows' ? ['get', 'post'] : ['delete', 'get', 'patch'],
      )
    expect(
      operationIds.filter((id) => typeof id === 'string' && /workflow/i.test(id)).sort(),
    ).toEqual([...SHIPPED].sort())
    const instance = (openapi.components as { schemas: Record<string, { properties: object }> })
      .schemas.Instance
    expect(instance?.properties).toHaveProperty('followUpHostNotesEnabled')
    expect(instance?.properties).toHaveProperty(['workflowsEnabled', 'type'], 'boolean')
  })

  it('serves the shipped workflow routes, each refusing while off, and reports workflows off', async () => {
    const databaseUrl = 'postgres://workflows-off@127.0.0.1:9/workflows-off'
    const db = createDb(createPool(databaseUrl))
    try {
      const app = productionApp(db, databaseUrl)
      const routes = app.routes.map(({ path }) => path)
      for (const control of ['/api/v1/bookings/:id', '/api/v1/instance', '/mcp', '/assets/*'])
        expect(routes, control).toContain(control)
      const workflowRoutes = [
        ...new Set(
          app.routes
            .filter(({ path }) => workflowSegment.test(path))
            .map(({ method, path }) => `${method} ${path}`),
        ),
      ].sort()
      expect(workflowRoutes).toEqual(
        shipped.map(({ method, path }) => `${method} ${honoPath(path)}`).sort(),
      )
      // Every registered workflow route, not only today's, carries the workflow guard.
      for (const route of workflowRoutes)
        expect(
          app.routes.some(
            ({ method, path, handler }) =>
              `${method} ${path}` === route && handler === workflowsGuard,
          ),
          route,
        ).toBe(true)
      // Hard-off is behavior: every caller the scope allows gets 404 workflows_disabled, for
      // any input, before validation or lookup (the pool's address refuses connections). The
      // requests come from the registered routes, so a later route is checked the same way.
      const urls = workflowRoutes.flatMap((route) => {
        const [method, rawPath] = route.split(' ')
        const path = (rawPath as string).replaceAll(':id', 'not-a-uuid')
        return [
          path,
          `${path}?ownerKind=personal&ownerId=${keys.full.user.id}`,
          `${path}?ownerKind=nobody&limit=0&cursor=x`,
          path.replace('not-a-uuid', randomUUID()),
        ].map((url) => ({ method, url }))
      })
      expect(urls.map(({ url }) => url)).toContain('/api/v1/workflows')
      expect(urls.map(({ url }) => url)).toContain('/api/v1/workflows/not-a-uuid')
      for (const { method, url } of urls) {
        for (const scope of ['full', 'read'] as const) {
          const res = await app.request(url, { method, headers: { authorization: bearer(scope) } })
          const refusedScope =
            (method === 'POST' || method === 'PATCH' || method === 'DELETE') && scope === 'read'
          expect(res.status, `${scope} ${method} ${url}`).toBe(refusedScope ? 403 : 404)
          expect(await res.json()).toMatchObject({
            error: refusedScope ? 'insufficient_scope' : 'workflows_disabled',
          })
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
        const bookings = await app.request(url, {
          method,
          headers: { authorization: bearer('bookings') },
        })
        expect(bookings.status, url).toBe(403)
        expect(await bookings.json()).toMatchObject({ error: 'insufficient_scope' })
        expect((await app.request(url, { method })).status, url).toBe(401)
      }
      const instance = await app.request('/api/v1/instance')
      expect(instance.status).toBe(200)
      expect(await instance.json()).toHaveProperty('workflowsEnabled', false)
    } finally {
      await db.destroy()
    }
  })

  it('catalogues the shipped tools, lists none of them and refuses direct calls', async () => {
    // No handlers run and no connection opens; the pool is still closed explicitly.
    const databaseUrl = 'postgres://workflows-off@127.0.0.1:9/workflows-off'
    const db = createDb(createPool(databaseUrl))
    try {
      const names = prepareTools(productTools({ db, slotSnippetsEnabled: true })).map(
        ({ tool }) => tool.name,
      )
      expect(names).toContain('create_booking')
      for (const { tool } of absent) expect(names).not.toContain(tool)
      expect(names.filter((name) => /workflow/i.test(name)).sort()).toEqual(
        shipped.map(({ tool }) => tool).sort(),
      )
      const app = productionApp(db, databaseUrl)
      for (const scope of ['full', 'read'] as const) {
        const listed = (await mcp(app, scope, 'tools/list')).result?.tools?.map(({ name }) => name)
        expect(listed).toContain('whoami')
        expect(listed?.filter((name) => /workflow/i.test(name))).toEqual([])
        for (const { tool, method } of shipped)
          for (const args of [{}, { owner: { kind: 'personal', id: randomUUID() } }, { id: 'x' }])
            expect(
              toolError(await mcp(app, scope, 'tools/call', { name: tool, arguments: args })),
            ).toMatchObject({
              error:
                method !== 'GET' && scope === 'read' ? 'insufficient_scope' : 'workflows_disabled',
            })
      }
      // The API-key scope check keeps its precedence over the switch.
      for (const { tool } of shipped)
        expect(
          toolError(await mcp(app, 'bookings', 'tools/call', { name: tool, arguments: {} })),
        ).toMatchObject({ error: 'insufficient_scope' })
    } finally {
      await db.destroy()
    }
  })

  it('registers only the shipped workflow CLI commands and app paths', () => {
    const commands = [
      ...Object.keys(COMMANDS),
      ...Object.values(COMMANDS),
      ...Object.keys(REST_COMMANDS),
      ...Object.values(REST_COMMANDS),
    ]
    expect(commands).toContain('book')
    for (const { command, tool } of absent) {
      expect(commands).not.toContain(command)
      expect(commands).not.toContain(tool)
    }
    expect(
      Object.entries(COMMANDS)
        .filter(([command, tool]) => /workflow/i.test(command + tool))
        .sort(),
    ).toEqual(shipped.map(({ command, tool }) => [command, tool]).sort())
    expect(Object.keys(REST_COMMANDS).filter((name) => /workflow/i.test(name))).toEqual([])
    expect(HELP).toContain('workflows_disabled')
    // App route and editor tests verify these paths stay hidden while off.
    expect(
      Object.entries(PATHS).filter(
        ([name, path]) => /workflow/i.test(name) || workflowSegment.test(path),
      ),
    ).toEqual([
      ['workflows', '/app/workflows'],
      ['newWorkflow', '/app/workflows/new'],
    ])
    expect(workflowEditPath('workflow-id')).toBe('/app/workflows/workflow-id/edit')
    expect(workflowRunHistoryPath('workflow-id')).toBe('/app/workflows/workflow-id/runs')
  })

  it('recognises the workflow storage tables as whole identifiers, in any case', () => {
    for (const source of [
      "selectFrom('workflow_definitions')",
      'DELETE FROM "workflow_revisions"',
      'SELECT 1 FROM WORKFLOW_DEFINITIONS',
      'from Workflow_Revisions r',
      "import type { WorkflowDefinitions } from '@hourmere/db'",
      'type Row = Selectable<WorkflowRevisions>',
      "import { workflowFixture } from './workflow-storage-protections.ts'",
      "selectFrom('workflow_runs')",
      'UPDATE workflow_recipient_claims SET',
      'INSERT INTO "workflow_enrollments"',
      'FROM Workflow_Run_History h',
      'DELETE FROM workflow_mail_reservations',
      'type Run = Selectable<WorkflowRuns>',
      "import type { WorkflowEnrollments, WorkflowMailReservations } from '@hourmere/db'",
      'Insertable<WorkflowRecipientClaims>',
      'Selectable<WorkflowRunHistory>',
      '"./store": "./src/workflow-storage-store.ts"',
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(true)
    for (const source of [
      'WorkflowDefinitionSchema',
      'type WorkflowDefinition',
      'validateWorkflowDefinition',
      'workflow_definitions_guard',
      'listWorkflowDefinitions',
      'workflowRevision',
      '/api/v1/workflows',
      'workflowRunTiming',
      'type WorkflowRunTiming',
      'workflow_runs_due',
      'listWorkflowRuns',
      'workflow_reservation_id',
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(false)
  })

  it('keeps the workflow storage tables unreferenced outside storage and the guarded definitions', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('packages/workflows/src/definition.ts')
    expect(sources).toContain('packages/workflows/src/testing.ts')
    expect(sources).toContain('packages/db/src/index.ts')
    const storage = sources.filter(isStorageLayer)
    // The matcher sees the storage layer itself, so a reference elsewhere cannot hide from it.
    expect(storage).toEqual(['packages/db/src/tables.ts', ...STORAGE_SUPPORT].sort())
    for (const file of [...storage, ...DATA_ACCESS])
      expect(STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')), file).toBe(true)
    const tables = readFileSync(new URL('packages/db/src/tables.ts', root), 'utf8')
    for (const table of STORAGE_TABLES)
      expect(tables, table).toMatch(new RegExp(`^ {2}${table}: ${rowType(table)};$`, 'm'))
    const referencing = sources
      .filter((file) => !isStorageLayer(file) && !DATA_ACCESS.includes(file))
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
    // Each operation names only the execution tables it needs.
    const executionNames = new RegExp(
      `(?<![A-Za-z0-9_])(?:${STORAGE_TABLES.filter((table) => !DEFINITION_TABLES.includes(table))
        .flatMap((table) => [table, rowType(table)])
        .join('|')})(?![A-Za-z0-9_])`,
      'i',
    )
    expect(executionNames.test('selectFrom("workflow_runs")')).toBe(true)
    for (const file of DATA_ACCESS) {
      const source = readFileSync(new URL(file, root), 'utf8')
      if (file === 'packages/workflows/src/reads.ts') {
        expect(source).toContain('workflow_run_history')
        for (const table of STORAGE_TABLES.filter(
          (table) => ![...DEFINITION_TABLES, 'workflow_run_history'].includes(table),
        ))
          expect(source).not.toMatch(new RegExp(`\\b(?:${table}|${rowType(table)})\\b`, 'i'))
      } else if (file === 'packages/workflows/src/deletes.ts') {
        for (const table of ['workflow_runs', 'workflow_enrollments'])
          expect(source).toContain(table)
        const forbidden = STORAGE_TABLES.filter(
          (table) =>
            ![...DEFINITION_TABLES, 'workflow_runs', 'workflow_enrollments'].includes(table),
        )
        for (const table of forbidden) expect(source).not.toContain(table)
      } else if (
        file === 'packages/workflows/src/capture.ts' ||
        file === 'packages/workflows/src/dispatcher.ts'
      ) {
        for (const table of [
          'workflow_enrollments',
          'workflow_runs',
          'workflow_recipient_claims',
          'workflow_run_history',
        ])
          expect(source).toContain(table)
        for (const table of ['workflow_mail_reservations', 'workflow_creation_keys'])
          expect(source).not.toContain(table)
      } else if (file === 'packages/notifications/src/workflow-mail.ts') {
        expect(source).toContain('workflow_mail_reservations')
        for (const table of STORAGE_TABLES.filter((name) => name !== 'workflow_mail_reservations'))
          expect(source).not.toContain(table)
      } else if (file === 'packages/workflows/src/email-attempt.ts') {
        expect(source).toContain('workflow_recipient_claims')
        expect(source).toContain('workflow_runs')
        for (const table of STORAGE_TABLES.filter(
          (name) => name !== 'workflow_recipient_claims' && name !== 'workflow_runs',
        ))
          expect(source).not.toContain(table)
      } else expect(executionNames.test(source), file).toBe(false)
    }
    // Only the package entry and definition services load definition modules. Production
    // callers outside those modules receive only the guarded operations.
    const loaders = sources.filter((file) => {
      const source = readFileSync(new URL(file, root), 'utf8')
      return (
        /['"`](?:\.\/(?:reads|creates|updates|deletes|capture|dispatcher|email-attempt)|[^'"`]*workflows\/src\/(?:reads|creates|updates|deletes|preview|capture|dispatcher|email-attempt))(?:\.ts)?['"`]/.test(
          source,
        ) ||
        (file.startsWith('packages/workflows/src/') && /['"`]\.\/preview\.ts['"`]/.test(source))
      )
    })
    expect(loaders).toEqual([
      'packages/workflows/src/creates.ts',
      'packages/workflows/src/deletes.ts',
      'packages/workflows/src/email-attempt.ts',
      'packages/workflows/src/index.ts',
      'packages/workflows/src/preview.ts',
      'packages/workflows/src/updates.ts',
    ])
  })

  it('lets only the internal attempt service stamp workflow mail while hard-off', () => {
    const admission = 'packages/notifications/src/workflow-mail.ts'
    const callers = productionSources().filter((file) => {
      if (file === admission) return false
      const source = readFileSync(new URL(file, root), 'utf8')
      return /\b(?:admitWorkflowEmail|readmitWorkflowEmail|stampWorkflowEmail)\b|['"`][^'"`]*workflow-mail(?:\.ts)?['"`]/.test(
        source,
      )
    })
    expect(callers).toEqual(['packages/workflows/src/email-attempt.ts'])
  })

  it('exposes no storage module through a package entry point', () => {
    // A package subpath could publish a storage module to production importers whose own
    // source names only the subpath, so every workspace manifest's entry points are scanned.
    const manifests = ['apps', 'packages', 'tools'].flatMap((group) =>
      readdirSync(new URL(group, root)).flatMap((name) => {
        try {
          return [
            {
              file: `${group}/${name}/package.json`,
              json: JSON.parse(
                readFileSync(new URL(`${group}/${name}/package.json`, root), 'utf8'),
              ),
            },
          ]
        } catch {
          return [] // Not a workspace.
        }
      }),
    )
    expect(manifests.map(({ file }) => file)).toContain('packages/db/package.json')
    expect(
      manifests
        .filter(({ json }) =>
          STORAGE_NAMES.test(JSON.stringify([json.main, json.exports, json.imports])),
        )
        .map(({ file }) => file),
    ).toEqual([])
  })

  it('pins every statement of the server guard and discovery helpers', () => {
    const source = readFileSync(new URL('apps/server/src/workflows.ts', root), 'utf8')
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program
    expect(program.interpreter ?? null).toBeNull()
    expect(program.directives).toEqual([])
    expect(
      program.body.map((statement) => source.slice(statement.start ?? 0, statement.end ?? 0)),
    ).toEqual(FROZEN_SERVER_GUARD_STATEMENTS)
  })

  it('wires only guarded lifecycle capture after core intents in the production notifier', () => {
    const server = readFileSync(new URL('apps/server/src/server.ts', root), 'utf8')
    expect(server).toContain("import { captureWorkflowBooking } from '@hourmere/workflows'")
    expect(server).toContain(
      'const notifyAttendeeNoShow = webhookAttendeeNoShowNotifier(jobs, webhookSettings)',
    )
    const notifier = server.slice(server.indexOf('const notify: BookingNotifier = async'))
    const core = notifier.indexOf('await emailNotifier(trx, event, now)')
    const capture = notifier.indexOf(
      'await captureWorkflowBooking(trx, event, now, config.BETTER_AUTH_SECRET)',
    )
    expect(core).toBeGreaterThanOrEqual(0)
    expect(capture).toBeGreaterThan(core)
    const service = readFileSync(new URL('packages/workflows/src/capture.ts', root), 'utf8')
    expect(service).toContain(
      'export const captureWorkflowBooking = workflowCapture((...args: CaptureArgs) =>\n' +
        '  captureBookingWorkflows(...args, workflowAuditPort),',
    )
  })

  it('keeps dispatcher and repair handlers guarded and absent from production registration', () => {
    const service = readFileSync(new URL('packages/workflows/src/dispatcher.ts', root), 'utf8')
    expect(service).toContain('export const dispatchWorkflowRuns = workflowExecution(')
    expect(service).toContain(
      'dispatchDueWorkflowRuns({ ...ctx, audit: workflowAuditPort }, options)',
    )
    expect(service).toContain('export const repairWorkflowWakes = workflowExecution(')
    expect(service).toContain(
      'repairWorkflowRunWakes({ ...ctx, audit: workflowAuditPort }, port, limit)',
    )
    for (const file of productionSources().filter(
      (file) => !file.startsWith('packages/workflows/src/'),
    )) {
      const source = readFileSync(new URL(file, root), 'utf8')
      expect(source, file).not.toMatch(/\bworkflowJobs\b|workflow-dispatch-v1|workflow-repair-v1/)
    }
  })

  it('keeps the retired audit port out of server, worker, CLI and script wiring', () => {
    const sources = productionSources()
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('packages/webhooks/src/delivery.ts')
    expect(sources).toContain('tools/cli/src/cli.ts')
    expect(sources).toContain('scripts/webhook-reconciliation-benchmark.ts')
    for (const file of sources) {
      const source = readFileSync(new URL(file, root), 'utf8')
      expect(source, file).not.toMatch(/\b(?:hardOffWorkflowAuditPort|noopAuditPort)\b/)
    }
  })

  it('lets the shared webhook worker reach workflow sends only through the hard-off guard', () => {
    const deliveryFile = 'packages/webhooks/src/delivery.ts'
    const eligibilityModules = [
      deliveryFile,
      'packages/workflows/src/dispatcher.ts',
      'packages/workflows/src/index.ts',
    ]
    const service = readFileSync(new URL(deliveryFile, root), 'utf8')
    expect(service).toContain(
      'const guardedWorkflowWebhook = workflowExecution(deliverWorkflowWebhook)',
    )
    expect(service).toMatch(
      /if \(retry === 'workflow'\)\s+return guardedWorkflowWebhook\(deps, deliveryId, signal, jobAttempt\)/,
    )
    for (const file of productionSources()) {
      const source = readFileSync(new URL(file, root), 'utf8')
      expect(source, file).not.toContain('workflow-delivery-fixture')
      if (file !== deliveryFile) expect(source, file).not.toContain('deliverWorkflowWebhook')
      if (!eligibilityModules.includes(file))
        expect(source, file).not.toContain('lockWorkflowWebhookRun')
    }
  })

  it.each(['mock', 'doMock', 'importMock'])(
    'rejects resolved protected targets passed to %s',
    (method) => {
      const file = fileURLToPath(new URL('apps/server/src/mock-fixture.test.ts', root))
      for (const target of [
        '../../../packages/workflows/src/index.ts',
        '../../../packages/workflows/src/index.js',
        '../../../packages/workflows/src/index',
        '../../../packages/workflows/src',
        '@hourmere/workflows',
        './workflows.js',
        './workflows.ts',
        './workflows',
        './mcp/../workflows.js',
        '../../../packages/workflows/src/creates.ts',
        '../../../packages/workflows/src/creates.js',
        '../../../packages/workflows/src/reads',
        '../../../packages/workflows/src/hard-off.ts',
        fileURLToPath(new URL('packages/workflows/src/index.ts', root)),
        new URL('packages/workflows/src/creates.ts', root).href,
      ]) {
        const source = `vi.${method}(${JSON.stringify(target)}, () => ({}))`
        expect(hasWorkflowMock(source, file), source).toBe(true)
      }
      // Ordinary package and sibling mocks still resolve from this test's directory.
      for (const target of ['node:fs', '@hourmere/core/locales', './caller.ts', './caller.js']) {
        const source = `vi.${method}(${JSON.stringify(target)}, () => ({}))`
        expect(hasWorkflowMock(source, file), source).toBe(false)
      }
    },
  )

  it('recognises computed paths and mock syntax without executing source', () => {
    const file = fileURLToPath(new URL('packages/workflows/src/mock-fixture.test.ts', root))
    for (const source of [
      "vi.mock('./hard-off.ts', () => ({}))",
      'vi.doMock(seam, () => ({}))',
      "vi.importMock('./' + moduleName)",
      "vi.mock('./unknown-module.ts', () => ({}))",
      "vitest['doMock']('./hard-off.ts', () => ({}))",
      "vi.mock(import('@hourmere/workflows'), () => ({}))",
    ])
      expect(hasWorkflowMock(source, file), source).toBe(true)
    expect(hasWorkflowMock('vi.mocked(fn).mockResolvedValue(true)', file)).toBe(false)
    expect(hasWorkflowMock("vi.importActual('@hourmere/workflows')", file)).toBe(false)
  })

  it('lets exactly one test file replace the hard-off module', () => {
    // The sanctioned seam for enabled definition operations; every other test sees the real guards.
    const mocking: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (['node_modules', 'dist', '.git', 'temp'].includes(entry)) continue
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.test\.tsx?$/.test(entry) && hasWorkflowMock(readFileSync(path, 'utf8'), path))
          mocking.push(relative(fileURLToPath(root), path))
      }
    }
    for (const group of ['apps', 'packages', 'scripts', 'tools'])
      walk(fileURLToPath(new URL(group, root)))
    expect(mocking).toEqual(['apps/server/src/workflows-enabled.test.ts'])
  })

  it('exports only guarded workflow operations, which refuse before touching their context', async () => {
    const exported = Object.keys(workflows).filter((name) =>
      /^(?:list|get|create|update|delete|preview)Workflow/.test(name),
    )
    expect(exported.sort()).toEqual([
      'createWorkflow',
      'deleteWorkflow',
      'getWorkflow',
      'listWorkflowRuns',
      'listWorkflows',
      'previewWorkflow',
      'updateWorkflow',
    ])
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('a guarded operation must not touch its context while off')
        },
      },
    ) as Parameters<typeof workflows.createWorkflow>[0]
    for (const read of [
      () => workflows.listWorkflows(untouchable, { owner: { kind: 'team', id: randomUUID() } }),
      () => workflows.getWorkflow(untouchable, randomUUID()),
      () =>
        workflows.listWorkflowRuns(
          untouchable as Parameters<typeof workflows.listWorkflowRuns>[0],
          randomUUID(),
          {},
        ),
      () => workflows.createWorkflow(untouchable, {} as never),
      () => workflows.updateWorkflow(untouchable, randomUUID(), {} as never),
      () => workflows.deleteWorkflow(untouchable, randomUUID(), {} as never),
      () => workflows.previewWorkflow(untouchable, {}),
    ])
      await expect(read()).rejects.toMatchObject({ kind: 'not_found', code: 'workflows_disabled' })
  })
})
