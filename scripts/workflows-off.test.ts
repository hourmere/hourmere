// Booking workflows stay hard-off (docs/workflows.md, "Rollout and limitations"). Step 4 ships
// the definition reads while off: `GET /api/v1/workflows` (listWorkflows) and
// `GET /api/v1/workflows/{id}` (getWorkflow), the MCP tools `list_workflows` and
// `get_workflow`, the CLI commands `workflows list` and `workflows get`, and `/instance`
// `workflowsEnabled`, which reports false. Each operation answers 404 workflows_disabled, and
// tools/list omits the tools. Every other workflow route, OpenAPI path or operation, MCP tool,
// CLI command and web page is still absent. The names come from the document's REST, MCP and
// CLI table; only workflow-specific names are asserted, and no catalogue is snapshotted. Each
// later step that adds an operation admits its own names here. Definition storage (step 2) is
// read only by the guarded read service (packages/workflows/src/reads.ts); every other
// production module stays away from the tables.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { PATHS } from '../apps/web/src/paths.ts'
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

/** The operations step 4 ships while workflows are off; every other one is still absent. */
const SHIPPED = ['listWorkflows', 'getWorkflow']
const shipped = operations.filter(({ operationId }) => SHIPPED.includes(operationId))
const absent = operations.filter(({ operationId }) => !SHIPPED.includes(operationId))

/** A Hono path such as `/api/v1/workflows/:id`, from an OpenAPI path. */
const honoPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1')
/** Any workflow-named route, OpenAPI path or CLI command, beyond the documented ones. */
const workflowSegment = /(?:^|\/)workflows?(?:\/|$)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The storage layer: the migration, the generated table types and the storage test support.
const STORAGE_LAYER =
  /^packages\/db\/(migrations\/|src\/tables\.ts$|src\/workflow-storage-[^/]+\.ts$)/
// The modules that own workflow data access: only the guarded definition reads so far.
const DATA_ACCESS = ['packages/workflows/src/reads.ts']
// A new table name as a whole identifier in any case (PostgreSQL folds unquoted identifiers),
// its generated row type, or the storage test support. `WorkflowDefinitionSchema` or
// `workflow_definitions_guard` is not one.
const STORAGE_NAMES =
  /workflow-storage|(?<![A-Za-z0-9_])(?:workflow_definitions|workflow_revisions|WorkflowDefinitions|WorkflowRevisions)(?![A-Za-z0-9_])/i

/** Every non-test source file in the src directory of each apps, packages and tools workspace. */
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

describe('booking workflows are off and expose only the step 4 reads', () => {
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
      'GET /api/v1/workflows/{id}',
    ])
  })

  it('publishes only the read paths, operations and the instance field in OpenAPI', async () => {
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
      '/api/v1/workflows/{id}',
    ])
    for (const path of ['/api/v1/workflows', '/api/v1/workflows/{id}'])
      expect(Object.keys(paths[path] ?? {}), path).toEqual(['get'])
    expect(
      operationIds.filter((id) => typeof id === 'string' && /workflow/i.test(id)).sort(),
    ).toEqual([...SHIPPED].sort())
    const instance = (openapi.components as { schemas: Record<string, { properties: object }> })
      .schemas.Instance
    expect(instance?.properties).toHaveProperty('followUpHostNotesEnabled')
    expect(instance?.properties).toHaveProperty(['workflowsEnabled', 'type'], 'boolean')
  })

  it('serves only the read routes, each refusing while off, and reports workflows off', async () => {
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
        const path = (route.split(' ')[1] as string).replaceAll(':id', 'not-a-uuid')
        return [
          path,
          `${path}?ownerKind=personal&ownerId=${keys.full.user.id}`,
          `${path}?ownerKind=nobody&limit=0&cursor=x`,
          path.replace('not-a-uuid', randomUUID()),
        ]
      })
      expect(urls).toContain('/api/v1/workflows')
      expect(urls).toContain('/api/v1/workflows/not-a-uuid')
      for (const url of urls) {
        for (const scope of ['full', 'read'] as const) {
          const res = await app.request(url, { headers: { authorization: bearer(scope) } })
          expect(res.status, `${scope} ${url}`).toBe(404)
          expect(await res.json()).toEqual({ error: 'workflows_disabled' })
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
        const bookings = await app.request(url, { headers: { authorization: bearer('bookings') } })
        expect(bookings.status, url).toBe(403)
        expect(await bookings.json()).toMatchObject({ error: 'insufficient_scope' })
        expect((await app.request(url)).status, url).toBe(401)
      }
      const instance = await app.request('/api/v1/instance')
      expect(instance.status).toBe(200)
      expect(await instance.json()).toHaveProperty('workflowsEnabled', false)
    } finally {
      await db.destroy()
    }
  })

  it('catalogues only the read tools, lists none of them and refuses direct calls', async () => {
    // No handlers run and no connection opens; the pool is still closed explicitly.
    const databaseUrl = 'postgres://workflows-off@127.0.0.1:9/workflows-off'
    const db = createDb(createPool(databaseUrl))
    try {
      const names = prepareTools(productTools({ db, slotSnippetsEnabled: true })).map(
        ({ tool }) => tool.name,
      )
      expect(names).toContain('create_booking')
      for (const { tool } of absent) expect(names).not.toContain(tool)
      expect(names.filter((name) => /workflow/i.test(name))).toEqual(
        shipped.map(({ tool }) => tool),
      )
      const app = productionApp(db, databaseUrl)
      for (const scope of ['full', 'read'] as const) {
        const listed = (await mcp(app, scope, 'tools/list')).result?.tools?.map(({ name }) => name)
        expect(listed).toContain('whoami')
        expect(listed?.filter((name) => /workflow/i.test(name))).toEqual([])
        for (const { tool } of shipped)
          for (const args of [{}, { owner: { kind: 'personal', id: randomUUID() } }, { id: 'x' }])
            expect(
              toolError(await mcp(app, scope, 'tools/call', { name: tool, arguments: args })),
            ).toEqual({ error: 'workflows_disabled' })
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

  it('offers only the read CLI commands and no web page', () => {
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
      Object.entries(COMMANDS).filter(([command, tool]) => /workflow/i.test(command + tool)),
    ).toEqual(shipped.map(({ command, tool }) => [command, tool]))
    expect(Object.keys(REST_COMMANDS).filter((name) => /workflow/i.test(name))).toEqual([])
    expect(HELP).toContain('workflows_disabled')
    expect(
      Object.entries(PATHS).filter(
        ([name, path]) => /workflow/i.test(name) || workflowSegment.test(path),
      ),
    ).toEqual([])
  })

  it('recognises the definition storage tables as whole identifiers, in any case', () => {
    for (const source of [
      "selectFrom('workflow_definitions')",
      'DELETE FROM "workflow_revisions"',
      'SELECT 1 FROM WORKFLOW_DEFINITIONS',
      'from Workflow_Revisions r',
      "import type { WorkflowDefinitions } from '@hourmere/db'",
      'type Row = Selectable<WorkflowRevisions>',
      "import { workflowFixture } from './workflow-storage-protections.ts'",
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
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(false)
  })

  it('keeps the definition storage tables unreferenced outside storage and the guarded reads', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('packages/workflows/src/definition.ts')
    expect(sources).toContain('packages/workflows/src/testing.ts')
    expect(sources).toContain('packages/db/src/index.ts')
    const storage = sources.filter((file) => STORAGE_LAYER.test(file))
    // The matcher sees the storage layer itself, so a reference elsewhere cannot hide from it.
    expect(storage).toEqual(
      expect.arrayContaining([
        'packages/db/src/tables.ts',
        'packages/db/src/workflow-storage-protections.ts',
      ]),
    )
    for (const file of [...storage, ...DATA_ACCESS])
      expect(STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')), file).toBe(true)
    expect(readFileSync(new URL('packages/db/src/tables.ts', root), 'utf8')).toMatch(
      /^ {2}workflow_revisions: WorkflowRevisions;$/m,
    )
    const referencing = sources
      .filter((file) => !STORAGE_LAYER.test(file) && !DATA_ACCESS.includes(file))
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
    // Only the package entry loads the data-access module, so every production caller gets
    // the guarded operations and never the internal services behind them.
    const loaders = sources.filter((file) =>
      /['"`](?:\.\/reads|[^'"`]*workflows\/src\/reads)(?:\.ts)?['"`]/.test(
        readFileSync(new URL(file, root), 'utf8'),
      ),
    )
    expect(loaders).toEqual(['packages/workflows/src/index.ts'])
  })

  it('lets exactly one test file replace the hard-off module', () => {
    // The sanctioned seam for the enabled read path; every other test sees the real guards.
    const mocking: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (['node_modules', 'dist', '.git', 'temp'].includes(entry)) continue
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (
          /\.test\.tsx?$/.test(entry) &&
          /vi\.(?:do)?[mM]ock\([^)]*hard-off/.test(readFileSync(path, 'utf8'))
        )
          mocking.push(relative(fileURLToPath(root), path))
      }
    }
    for (const group of ['apps', 'packages', 'scripts', 'tools'])
      walk(fileURLToPath(new URL(group, root)))
    expect(mocking).toEqual(['apps/server/src/workflows-enabled.test.ts'])
  })

  it('exports only the guarded reads, which refuse before touching their context', async () => {
    const exported = Object.keys(workflows).filter((name) => /^(?:list|get)Workflow/.test(name))
    expect(exported.sort()).toEqual(['getWorkflow', 'listWorkflows'])
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('a guarded read must not touch its context while off')
        },
      },
    ) as Parameters<typeof workflows.listWorkflows>[0]
    for (const read of [
      () => workflows.listWorkflows(untouchable, { owner: { kind: 'team', id: randomUUID() } }),
      () => workflows.getWorkflow(untouchable, randomUUID()),
    ])
      await expect(read()).rejects.toMatchObject({ kind: 'not_found', code: 'workflows_disabled' })
  })
})
