import { execFileSync } from 'node:child_process'
import { createDb, createPool } from '@hourmere/db'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productTools } from '../apps/server/src/server.ts'
import { COMMANDS } from '../tools/cli/src/cli.ts'

const METHODS = ['get', 'head', 'options', 'trace', 'post', 'put', 'patch', 'delete'] as const
export type HttpMethod = (typeof METHODS)[number]
const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(['post', 'put', 'patch', 'delete'])

const KNOWN_GAPS_PATH = 'scripts/interface-parity-known-gaps.json'
// Bootstrap only: the original 20 gaps, used before this guard first reaches main.
// Once the file exists at the base commit, that committed list is the only baseline.
const INITIAL_KNOWN_GAPS = [
  'activateRoundRobin',
  'configureCalendar',
  'confirmDefaultSchedule',
  'createEventType',
  'createSchedule',
  'createWebhook',
  'deleteEventType',
  'deleteSchedule',
  'deleteScheduleOverride',
  'deleteWebhook',
  'refreshCalendarList',
  'rotateWebhookSecret',
  'setCalendarDestination',
  'setScheduleOverride',
  'syncCalendar',
  'updateDisplayName',
  'updateEventType',
  'updateProfile',
  'updateSchedule',
  'updateWebhook',
] as const

export interface RestOperation {
  path: string
  method: HttpMethod
  operationId?: unknown
  /** Effective OpenAPI security: an operation overrides the document's default. */
  security?: unknown
}

export interface InterfaceInventory {
  rest: readonly RestOperation[]
  mcp: readonly string[]
  /** The command table also records which MCP tool each command actually invokes. */
  cli: Readonly<Record<string, string>>
}

export type InterfaceParityMapping = Record<
  string,
  { mcp: string; cli: string } | { exemption: 'browser-session-only'; reason: string }
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
        security:
          isRecord(operation) && Object.hasOwn(operation, 'security')
            ? operation.security
            : document.security,
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

function browserSessionOnly(security: unknown): boolean {
  if (!Array.isArray(security) || security.length !== 1) return false
  const requirement: unknown = security[0]
  return (
    isRecord(requirement) &&
    Object.keys(requirement).length === 1 &&
    Object.hasOwn(requirement, 'session') &&
    Array.isArray(requirement.session) &&
    requirement.session.length === 0
  )
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A verified base commit makes removed gaps impossible to reintroduce in later changes. */
export function loadKnownGapBaseline(
  base = process.env.HOURMERE_PARITY_BASE ?? 'origin/main',
  git: (args: string[]) => string = gitOutput,
): unknown {
  let commit: string
  try {
    commit = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
  } catch {
    throw new Error('Cannot resolve the interface-parity base commit; fetch its Git history.')
  }
  // A shallow or missing base must never silently reset the ratchet to its initial ceiling.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error('The interface-parity base must resolve to a full Git commit ID.')
  }
  const path = git(['ls-tree', '--name-only', commit, '--', KNOWN_GAPS_PATH]).trim()
  if (path === '') return Object.fromEntries(INITIAL_KNOWN_GAPS.map((id) => [id, true]))
  if (path !== KNOWN_GAPS_PATH) throw new Error('Unexpected interface-parity baseline path.')
  return JSON.parse(git(['show', `${commit}:${KNOWN_GAPS_PATH}`])) as unknown
}

/** The committed known-gap list is a ratchet: additions must implement all interfaces. */
export function knownGapRatchetErrors(knownGaps: unknown, baseline: unknown): string[] {
  if (!isRecord(baseline)) return ['The committed interface-parity gap baseline must be an object.']
  if (!isRecord(knownGaps)) return [] // The ordinary parity validation reports this shape error.
  return Object.keys(knownGaps)
    .filter((operationId) => !Object.hasOwn(baseline, operationId))
    .map(
      (operationId) =>
        `${operationId}: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.`,
    )
    .sort()
}

/** Return all failures together, with operation names and routes for actionable CI output. */
export function interfaceParityErrors(
  inventory: InterfaceInventory,
  mapping: unknown,
  knownGaps: unknown = {},
): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()
  const writes = new Map<string, { route: string; security: unknown }>()
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
    if (write) writes.set(operation.operationId, { route, security: operation.security })
  }

  if (!isRecord(mapping)) {
    errors.push('Interface parity mapping must be an object keyed by REST write operationId.')
    return errors
  }
  if (!isRecord(knownGaps)) {
    errors.push('Known MCP/CLI gaps must be an object keyed by REST write operationId.')
    return errors
  }
  for (const [operationId, { route }] of writes) {
    if (!Object.hasOwn(mapping, operationId) && !Object.hasOwn(knownGaps, operationId)) {
      errors.push(
        `${operationId} (${route}): missing MCP/CLI mapping, verified browser-session-only exemption or frozen known gap.`,
      )
    }
  }
  for (const [operationId, reason] of Object.entries(knownGaps)) {
    const operation = writes.get(operationId)
    if (!operation) {
      errors.push(`${operationId}: stale known gap; no REST write operation has this operationId.`)
    } else if (Object.hasOwn(mapping, operationId) || browserSessionOnly(operation.security)) {
      errors.push(
        `${operationId}: stale known gap; remove it and keep the mapping or verified exemption.`,
      )
    }
    if (!oneLineReason(reason)) {
      errors.push(`${operationId}: known gap needs a nonempty, one-line reason.`)
    }
  }
  const tools = new Set(inventory.mcp)
  for (const [operationId, entry] of Object.entries(mapping)) {
    if (!writes.has(operationId)) {
      const kind = isRecord(entry) && Object.hasOwn(entry, 'exemption') ? 'exemption' : 'mapping'
      errors.push(`${operationId}: stale ${kind}; no REST write operation has this operationId.`)
    }
    if (!isRecord(entry)) {
      errors.push(
        `${operationId}: expected exactly {mcp, cli} or {exemption: "browser-session-only", reason}.`,
      )
      continue
    }
    const keys = Object.keys(entry)
    if (
      keys.length === 2 &&
      entry.exemption === 'browser-session-only' &&
      Object.hasOwn(entry, 'reason')
    ) {
      if (!oneLineReason(entry.reason)) {
        errors.push(`${operationId}: exemption needs a nonempty, one-line reason.`)
      }
      const operation = writes.get(operationId)
      if (operation && !browserSessionOnly(operation.security)) {
        errors.push(
          `${operationId}: browser-session-only exemption requires OpenAPI security exactly [{session: []}]; add the MCP tool and CLI command instead.`,
        )
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
      errors.push(
        `${operationId}: expected exactly {mcp, cli} or {exemption: "browser-session-only", reason}.`,
      )
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
