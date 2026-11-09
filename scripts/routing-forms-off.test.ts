// Routing forms are storage only (docs/routing-forms.md, step a1a): migration 0072 and the
// packages/db storage files exist, and no product surface does. This test asserts that the
// routing feature's own surface is absent, keyed on the names docs/routing-forms.md assigns
// to each surface. It never snapshots or compares whole catalogues and never consults a git
// base. Later plan steps delete or narrow one assertion each when they add their surface:
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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { prepareTools } from '../apps/server/src/mcp/tools.ts'
import { openApiDocument, openApiRouteInventory } from '../apps/server/src/openapi-document.ts'
import { productTools } from '../apps/server/src/server.ts'
import { COMMANDS, REST_COMMANDS } from '../tools/cli/src/cli.ts'
import { isRoutingName } from './routing-forms-names.ts'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)

// Routing-form names are matched token by token (`isRoutingName`): `route`, `routing` or
// `routed` as a whole word of a path, identifier or camelCase name.

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
      '/api/v1/routing_forms',
      '/api/v1/forms/{id}/route',
      '/route/:handle/:slug',
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
      '/routes/:id',
      '/app/router',
      '/api/v1/bookings/{id}',
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

  it('exposes no routing path, operation, tag or schema in the OpenAPI document or a Hono route', async () => {
    const document = await openApiDocument()
    const names = openApiNames(document)
    expect(names.length).toBeGreaterThan(100)
    expect(names).toContain('/api/v1/bookings/{id}')
    for (const path of REST_PATHS) expect(names).not.toContain(path)
    expect(names.filter(isRoutingName)).toEqual([])
    // Every route registered on the Hono app, including plain GET routes and pages that the
    // OpenAPI document need not list.
    const { routes } = await openApiRouteInventory()
    expect(routes.length).toBeGreaterThan(100)
    expect(routes.map(({ path }) => path)).toContain('/api/v1/bookings/:id')
    expect(routes.filter(({ path }) => isRoutingName(path))).toEqual([])
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
