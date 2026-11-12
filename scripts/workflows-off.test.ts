// Booking workflows are a pure definition contract behind the hard-off constant
// (docs/workflows.md, step 1): no workflow route, OpenAPI path or operation, `/instance` field,
// MCP tool, CLI command or web page exists yet. The names come from the document's REST, MCP
// and CLI table and its `/instance` field; only workflow-specific names are asserted, and no
// catalogue is snapshotted. Each step that adds an operation narrows the assertion for its
// own names, and step 4 for `workflowsEnabled`. Definition storage (step 2) and execution
// storage (step 3) are tables only: migrations 0076 and 0079, the generated table types and the
// storage test support exist, and no production module imports or queries the new tables. The
// first step that reads or writes them from service code narrows that scan to the modules that
// own workflow data access.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGoogleCalendarClient, createMicrosoftCalendarClient } from '@hourmere/calendars'
import { createZoomClient } from '@hourmere/conferences'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { createApp } from '../apps/server/src/app.ts'
import { loadConfig } from '../apps/server/src/config.ts'
import { prepareTools } from '../apps/server/src/mcp/tools.ts'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productionAppOptions, productTools } from '../apps/server/src/server.ts'
import { PATHS } from '../apps/web/src/paths.ts'
import { COMMANDS, REST_COMMANDS } from '../tools/cli/src/cli.ts'

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
]
const isStorageLayer = (file: string) =>
  file.startsWith('packages/db/migrations/') ||
  file === 'packages/db/src/tables.ts' ||
  STORAGE_SUPPORT.includes(file)
// The workflow tables of migrations 0076 and 0079.
const STORAGE_TABLES = [
  'workflow_definitions',
  'workflow_revisions',
  'workflow_enrollments',
  'workflow_runs',
  'workflow_recipient_claims',
  'workflow_run_history',
  'workflow_mail_reservations',
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

describe('booking workflows are off and expose no surface', () => {
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
  })

  it('publishes no workflow path, operation or instance field in OpenAPI', async () => {
    const openapi = (await openApiDocument()) as Record<string, unknown>
    expect(isRecord(openapi.paths)).toBe(true)
    const paths = openapi.paths as Record<string, unknown>
    expect(paths).toHaveProperty(['/api/v1/bookings/{id}'])
    const operationIds = Object.values(paths)
      .filter(isRecord)
      .flatMap((item) => Object.values(item).filter(isRecord))
      .map((operation) => operation.operationId)
    // Not every published operation names an ID yet; enough do for the check to see them.
    expect(operationIds.filter((id) => typeof id === 'string').length).toBeGreaterThan(20)
    for (const { path, operationId } of operations) {
      expect(Object.keys(paths)).not.toContain(path)
      expect(operationIds).not.toContain(operationId)
    }
    expect(Object.keys(paths).filter((path) => workflowSegment.test(path))).toEqual([])
    expect(operationIds.filter((id) => typeof id === 'string' && /workflow/i.test(id))).toEqual([])
    const instance = (openapi.components as { schemas: Record<string, { properties: object }> })
      .schemas.Instance
    expect(instance?.properties).toHaveProperty('followUpHostNotesEnabled')
    expect(instance?.properties).not.toHaveProperty('workflowsEnabled')
  })

  it('registers no workflow route on the app startServer serves, with every optional group on', async () => {
    // The production assembly, as scripts/routing-forms-off.test.ts builds it: every optional
    // route group switched on and no handler run, so no database or provider is contacted.
    const databaseUrl = 'postgres://workflows-off@127.0.0.1:9/workflows-off'
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
    const db = createDb(createPool(databaseUrl))
    const credentials = { clientId: 'workflows-off', clientSecret: 'workflows-off' }
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
      const paths = app.routes.map(({ path }) => path)
      for (const control of ['/api/v1/bookings/:id', '/api/v1/instance', '/mcp', '/assets/*'])
        expect(paths, control).toContain(control)
      for (const { path } of operations) expect(paths).not.toContain(honoPath(path))
      expect(paths.filter((path) => workflowSegment.test(path))).toEqual([])
      const instance = await app.request('/api/v1/instance')
      expect(instance.status).toBe(200)
      expect(await instance.json()).not.toHaveProperty('workflowsEnabled')
    } finally {
      await db.destroy()
    }
  })

  it('lists no workflow MCP tool, with every optional catalogue enabled', async () => {
    // No handlers run and no connection opens; the pool is still closed explicitly.
    const pool = createPool('postgres://workflows-off@127.0.0.1:9/workflows-off')
    try {
      const names = prepareTools(
        productTools({ db: createDb(pool), slotSnippetsEnabled: true }),
      ).map(({ tool }) => tool.name)
      expect(names).toContain('create_booking')
      for (const { tool } of operations) expect(names).not.toContain(tool)
      expect(names.filter((name) => /workflow/i.test(name))).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('offers no workflow CLI command or web page', () => {
    const commands = [
      ...Object.keys(COMMANDS),
      ...Object.values(COMMANDS),
      ...Object.keys(REST_COMMANDS),
      ...Object.values(REST_COMMANDS),
    ]
    expect(commands).toContain('book')
    for (const { command, tool } of operations) {
      expect(commands).not.toContain(command)
      expect(commands).not.toContain(tool)
    }
    expect(commands.filter((name) => /workflow/i.test(name))).toEqual([])
    expect(
      Object.entries(PATHS).filter(
        ([name, path]) => /workflow/i.test(name) || workflowSegment.test(path),
      ),
    ).toEqual([])
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

  it('keeps the workflow storage tables unreferenced outside the storage layer', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('packages/workflows/src/definition.ts')
    expect(sources).toContain('packages/workflows/src/testing.ts')
    expect(sources).toContain('packages/db/src/index.ts')
    const storage = sources.filter(isStorageLayer)
    // The matcher sees the storage layer itself, so a reference elsewhere cannot hide from it.
    expect(storage).toEqual(['packages/db/src/tables.ts', ...STORAGE_SUPPORT].sort())
    for (const file of storage)
      expect(STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')), file).toBe(true)
    const tables = readFileSync(new URL('packages/db/src/tables.ts', root), 'utf8')
    for (const table of STORAGE_TABLES)
      expect(tables, table).toMatch(new RegExp(`^ {2}${table}: ${rowType(table)};$`, 'm'))
    const referencing = sources
      .filter((file) => !isStorageLayer(file))
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
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
})
