import { createDb, createPool } from '@hourmere/db'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productTools } from '../apps/server/src/server.ts'
import { COMMANDS } from '../tools/cli/src/cli.ts'

const METHODS = ['get', 'head', 'options', 'trace', 'post', 'put', 'patch', 'delete'] as const
export type HttpMethod = (typeof METHODS)[number]
const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(['post', 'put', 'patch', 'delete'])

export interface RestOperation {
  path: string
  method: HttpMethod
  operationId?: unknown
}

export interface InterfaceInventory {
  rest: readonly RestOperation[]
  mcp: readonly string[]
  /** The command table also records which MCP tool each command actually invokes. */
  cli: Readonly<Record<string, string>>
}

export type InterfaceParityMapping = Record<
  string,
  { mcp: string; cli: string } | { exemption: string }
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep missing operation IDs visible so adding an undocumented write cannot bypass CI. */
export function restOperations(document: unknown): RestOperation[] {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error('The generated OpenAPI document must contain a paths object.')
  }
  const operations: RestOperation[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) continue
    if (!isRecord(item)) throw new Error(`OpenAPI path ${path} must contain an object.`)
    for (const method of METHODS) {
      if (!Object.hasOwn(item, method)) continue
      const operation = item[method]
      operations.push({
        path,
        method,
        operationId: isRecord(operation) ? operation.operationId : undefined,
      })
    }
  }
  return operations
}

/** Read the same route/tool/command registries used at runtime; never execute handlers. */
export async function loadInterfaceInventory(): Promise<InterfaceInventory> {
  const rest = restOperations(await openApiDocument())
  // Neither constructing the tool registry nor ending this pool opens a connection.
  const db = createDb(createPool('postgres://interface-parity@127.0.0.1:9/interface-parity'))
  try {
    return { rest, mcp: productTools({ db }).map((tool) => tool.name), cli: COMMANDS }
  } finally {
    await db.destroy()
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_]/.test(value) && !/[^A-Za-z0-9_.-]/.test(value)
}

function oneLineReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2028\u2029]/.test(value)
}

/** Return all failures together, with operation names and routes for actionable CI output. */
export function interfaceParityErrors(inventory: InterfaceInventory, mapping: unknown): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()
  const writes = new Map<string, string>()
  for (const operation of inventory.rest) {
    const route = `${operation.method.toUpperCase()} ${operation.path}`
    const write = WRITE_METHODS.has(operation.method)
    if (operation.operationId === undefined && !write) continue
    if (!identifier(operation.operationId)) {
      errors.push(`${route}: missing or malformed operationId; use a stable identifier.`)
      continue
    }
    const prior = seen.get(operation.operationId)
    if (prior)
      errors.push(`${operation.operationId}: duplicate operationId on ${prior} and ${route}.`)
    seen.set(operation.operationId, route)
    if (write) writes.set(operation.operationId, route)
  }

  if (!isRecord(mapping)) {
    errors.push('Interface parity mapping must be an object keyed by REST write operationId.')
    return errors
  }
  for (const [operationId, route] of writes) {
    if (!Object.hasOwn(mapping, operationId)) {
      errors.push(`${operationId} (${route}): missing MCP/CLI mapping or reasoned exemption.`)
    }
  }
  const tools = new Set(inventory.mcp)
  for (const [operationId, entry] of Object.entries(mapping)) {
    if (!writes.has(operationId)) {
      const kind = isRecord(entry) && Object.hasOwn(entry, 'exemption') ? 'exemption' : 'mapping'
      errors.push(`${operationId}: stale ${kind}; no REST write operation has this operationId.`)
    }
    if (!isRecord(entry)) {
      errors.push(`${operationId}: expected exactly {mcp, cli} or {exemption}.`)
      continue
    }
    const keys = Object.keys(entry)
    if (keys.length === 1 && Object.hasOwn(entry, 'exemption')) {
      if (!oneLineReason(entry.exemption)) {
        errors.push(`${operationId}: exemption needs a nonempty, one-line reason.`)
      }
      continue
    }
    if (
      keys.length !== 2 ||
      !Object.hasOwn(entry, 'mcp') ||
      !Object.hasOwn(entry, 'cli') ||
      !identifier(entry.mcp) ||
      !identifier(entry.cli)
    ) {
      errors.push(`${operationId}: expected exactly {mcp, cli} or {exemption}.`)
      continue
    }
    if (!tools.has(entry.mcp)) {
      errors.push(`${operationId}: MCP tool "${entry.mcp}" is not registered.`)
    }
    if (!Object.hasOwn(inventory.cli, entry.cli)) {
      errors.push(`${operationId}: CLI command "${entry.cli}" does not exist.`)
    } else if (inventory.cli[entry.cli] !== entry.mcp) {
      errors.push(
        `${operationId}: CLI command "${entry.cli}" invokes "${inventory.cli[entry.cli]}", not mapped MCP tool "${entry.mcp}".`,
      )
    }
  }
  return errors.sort()
}
