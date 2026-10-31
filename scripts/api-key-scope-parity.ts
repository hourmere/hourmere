import {
  API_KEY_CLI_OPERATIONS,
  API_KEY_MCP_OPERATIONS,
  API_KEY_REST_OPERATIONS,
  type ApiKeyCliOperation,
  type ApiKeyMcpOperation,
  type ApiKeyOperation,
  type ApiKeyRestOperation,
} from '../packages/auth/src/api-key-operations.ts'

export interface ScopeInterfaceInventory {
  rest: readonly { method: string; path: string; operationId?: unknown; security?: unknown }[]
  registeredRest?: readonly { method: string; path: string }[]
  mcp: readonly { name: string; scopeModes?: readonly string[] }[]
  cli: Readonly<Record<string, string>>
}

export interface ScopePolicies {
  rest: readonly ApiKeyRestOperation[]
  mcp: readonly ApiKeyMcpOperation[]
  cli: readonly ApiKeyCliOperation[]
}

export const API_KEY_SCOPE_POLICIES: ScopePolicies = Object.freeze({
  rest: API_KEY_REST_OPERATIONS,
  mcp: API_KEY_MCP_OPERATIONS,
  cli: API_KEY_CLI_OPERATIONS,
})

function sameScopes(a: ApiKeyOperation, b: ApiKeyOperation): boolean {
  return [...a.allowedScopes].sort().join(',') === [...b.allowedScopes].sort().join(',')
}

function exactRows(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): string[] {
  const errors: string[] = []
  for (const [rows, kind] of [
    [expected, 'policy'],
    [actual, 'registration'],
  ] as const) {
    const seen = new Set<string>()
    for (const id of rows) {
      if (seen.has(id)) errors.push(`${label} ${id}: duplicate ${kind}.`)
      seen.add(id)
      if (id.includes('*')) errors.push(`${label} ${id}: wildcard ${kind} is forbidden.`)
    }
  }
  for (const id of new Set(actual)) {
    if (!expected.includes(id)) errors.push(`${label} ${id}: missing scope classification.`)
  }
  for (const id of new Set(expected)) {
    if (!actual.includes(id)) errors.push(`${label} ${id}: stale scope classification.`)
  }
  return errors
}

/** Compare actual registrations with the exact policy, including tool modes and CLI aliases. */
export function apiKeyScopeParityErrors(
  inventory: ScopeInterfaceInventory,
  policy: ScopePolicies = API_KEY_SCOPE_POLICIES,
): string[] {
  const errors: string[] = []
  // The document endpoint is registered by Hono's document publisher and is not in itself.
  const rest = policy.rest.filter((operation) => operation.id !== 'GET /api/v1/openapi.json')
  const productRest = inventory.rest.filter((operation) => operation.path.startsWith('/api/v1/'))
  errors.push(
    ...exactRows(
      rest.map((operation) => operation.id),
      productRest.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`),
      'REST',
    ),
  )
  // Hono repeats middleware registrations; only undocumented business routes matter here.
  for (const registration of inventory.registeredRest ?? []) {
    if (registration.path !== '/api/v1' && !registration.path.startsWith('/api/v1/')) continue
    if (
      !['GET', 'HEAD', 'OPTIONS', 'TRACE', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
        registration.method,
      )
    )
      continue
    if (registration.method === 'GET' && registration.path === '/api/v1/openapi.json') continue
    const template = registration.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    if (
      !productRest.some(
        (operation) =>
          operation.method.toUpperCase() === registration.method && operation.path === template,
      )
    ) {
      errors.push(
        `REST ${registration.method} ${registration.path}: missing OpenAPI registration and scope classification.`,
      )
    }
  }
  for (const operation of policy.rest) {
    if (operation.id !== `${operation.method} ${operation.path}`) {
      errors.push(`REST ${operation.id}: scope ID differs from its method and route template.`)
    }
    if (
      (operation.operationClass === 'session_only') !==
      (operation.authentication === 'session_only')
    ) {
      errors.push(`REST ${operation.id}: native session exemption differs from its scope class.`)
    }
  }
  for (const actual of productRest) {
    const id = `${actual.method.toUpperCase()} ${actual.path}`
    const row = rest.find((operation) => operation.id === id)
    if (row?.authentication === 'session_only') {
      if (JSON.stringify(actual.security) !== JSON.stringify([{ session: [] }])) {
        errors.push(`REST ${id}: native session exemption requires session-only OpenAPI security.`)
      }
    }
  }

  const tools = policy.mcp.filter((operation) => operation.mode === undefined)
  errors.push(
    ...exactRows(
      tools.map((operation) => operation.tool),
      inventory.mcp.map((tool) => tool.name),
      'MCP',
    ),
  )
  errors.push(
    ...exactRows(
      policy.mcp
        .filter((operation) => operation.mode !== undefined)
        .map((operation) => operation.id),
      inventory.mcp.flatMap((tool) =>
        (tool.scopeModes ?? []).map((mode) => `mcp:${tool.name}:${mode}`),
      ),
      'MCP mode',
    ),
  )
  for (const operation of policy.mcp) {
    const expectedId = `mcp:${operation.tool}${operation.mode === undefined ? '' : `:${operation.mode}`}`
    if (operation.id !== expectedId) errors.push(`MCP ${operation.id}: invalid scope ID.`)
    if (operation.mode !== undefined) {
      const parent = tools.find((tool) => tool.tool === operation.tool)
      if (!parent || !sameScopes(parent, operation)) {
        errors.push(`MCP ${operation.id}: mode scope differs from its tool classification.`)
      }
    }
    if (operation.rest.length === 0) errors.push(`MCP ${operation.id}: missing REST equivalent.`)
    for (const id of operation.rest) {
      const equivalent = rest.find((row) => row.id === id)
      if (!equivalent || !sameScopes(equivalent, operation)) {
        errors.push(`MCP ${operation.id}: missing or differently scoped REST equivalent ${id}.`)
      }
    }
  }

  errors.push(
    ...exactRows(
      policy.cli.map((operation) => operation.command),
      Object.keys(inventory.cli),
      'CLI',
    ),
  )
  for (const operation of policy.cli) {
    if (operation.id !== `cli:${operation.command}`) {
      errors.push(`CLI ${operation.command}: invalid scope ID.`)
    }
    const tool = tools.find((row) => row.tool === operation.tool)
    if (!tool || !sameScopes(tool, operation)) {
      errors.push(`CLI ${operation.command}: missing or differently scoped MCP tool.`)
    }
    if (
      Object.hasOwn(inventory.cli, operation.command) &&
      inventory.cli[operation.command] !== operation.tool
    ) {
      errors.push(`CLI ${operation.command}: actual command invokes a different MCP tool.`)
    }
  }
  return [...new Set(errors)].sort()
}
