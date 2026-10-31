import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_CLI_OPERATIONS,
  API_KEY_MCP_OPERATIONS,
  API_KEY_REST_OPERATIONS,
} from '../packages/auth/src/api-key-operations.ts'
import {
  API_KEY_SCOPE_POLICIES,
  apiKeyScopeParityErrors,
  type ScopeInterfaceInventory,
  type ScopePolicies,
} from './api-key-scope-parity.ts'

function inventory(): ScopeInterfaceInventory {
  return {
    rest: API_KEY_REST_OPERATIONS.filter(
      (operation) => operation.path !== '/api/v1/openapi.json',
    ).map((operation) => ({
      method: operation.method.toLowerCase(),
      path: operation.path,
      security: operation.authentication === 'session_only' ? [{ session: [] }] : [{ apiKey: [] }],
    })),
    mcp: API_KEY_MCP_OPERATIONS.filter((operation) => operation.mode === undefined).map(
      (operation) => ({
        name: operation.tool,
        scopeModes: API_KEY_MCP_OPERATIONS.filter(
          (mode) => mode.tool === operation.tool && mode.mode !== undefined,
        ).map((mode) => mode.mode as string),
      }),
    ),
    cli: Object.fromEntries(
      API_KEY_CLI_OPERATIONS.map((operation) => [operation.command, operation.tool]),
    ),
  }
}

type Guard = typeof apiKeyScopeParityErrors

function sourceCopy(replacement?: readonly [string, string]): Guard {
  let source = readFileSync(new URL('./api-key-scope-parity.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function(
    'API_KEY_REST_OPERATIONS',
    'API_KEY_MCP_OPERATIONS',
    'API_KEY_CLI_OPERATIONS',
    `${source}; return apiKeyScopeParityErrors`,
  )(API_KEY_REST_OPERATIONS, API_KEY_MCP_OPERATIONS, API_KEY_CLI_OPERATIONS) as Guard
}

function verifyMissingRoute(guard: Guard) {
  const actual = inventory()
  actual.rest = [...actual.rest, { method: 'post', path: '/api/v1/new-operation' }]
  expect(guard(actual)).toContain('REST POST /api/v1/new-operation: missing scope classification.')
}

function verifyMissingMode(guard: Guard) {
  const actual = inventory()
  actual.mcp = actual.mcp.map((tool) =>
    tool.name === 'cancel_booking'
      ? { ...tool, scopeModes: ['host', 'manageToken', 'future'] }
      : tool,
  )
  expect(guard(actual)).toContain(
    'MCP mode mcp:cancel_booking:future: missing scope classification.',
  )
}

function verifyUndocumentedWrite(guard: Guard) {
  const actual = inventory()
  actual.registeredRest = [{ method: 'POST', path: '/api/v1/undocumented/:id' }]
  expect(guard(actual)).toContain(
    'REST POST /api/v1/undocumented/:id: missing OpenAPI registration and scope classification.',
  )
}

function verifyEquivalentScopes(guard: Guard) {
  const policy: ScopePolicies = {
    ...API_KEY_SCOPE_POLICIES,
    mcp: API_KEY_MCP_OPERATIONS.map((tool) =>
      tool.tool === 'get_profile' ? { ...tool, allowedScopes: ['full', 'read'] } : tool,
    ),
  }
  expect(guard(inventory(), policy)).toContain(
    'MCP mcp:get_profile: missing or differently scoped REST equivalent GET /api/v1/profile.',
  )
}

describe('scope interface parity guard', () => {
  it('accepts the complete classified inventory', () => {
    expect(apiKeyScopeParityErrors(inventory())).toEqual([])
  })

  it('rejects an unclassified REST route', () => verifyMissingRoute(apiKeyScopeParityErrors))
  it('rejects a plain Hono write without OpenAPI registration', () =>
    verifyUndocumentedWrite(apiKeyScopeParityErrors))
  it('rejects an unclassified MCP mode', () => verifyMissingMode(apiKeyScopeParityErrors))
  it('rejects differently scoped REST/MCP equivalents', () =>
    verifyEquivalentScopes(apiKeyScopeParityErrors))

  it.each(['get', 'head', 'options', 'trace', 'post', 'put', 'patch', 'delete'])(
    'requires explicit scope classification for a future %s route',
    (method) => {
      const actual = inventory()
      actual.rest = [...actual.rest, { method, path: '/api/v1/future' }]
      expect(apiKeyScopeParityErrors(actual)).toContain(
        `REST ${method.toUpperCase()} /api/v1/future: missing scope classification.`,
      )
    },
  )

  it('rejects a new MCP tool and a new CLI alias', () => {
    const actual = inventory()
    actual.mcp = [...actual.mcp, { name: 'future_tool' }]
    actual.cli = { ...actual.cli, future: 'whoami' }
    expect(apiKeyScopeParityErrors(actual)).toEqual(
      expect.arrayContaining([
        'MCP future_tool: missing scope classification.',
        'CLI future: missing scope classification.',
      ]),
    )
  })

  it('rejects stale route, tool, mode and CLI classifications', () => {
    const actual = inventory()
    actual.rest = actual.rest.filter((route) => route.path !== '/api/v1/profile')
    actual.mcp = actual.mcp
      .filter((tool) => tool.name !== 'get_profile')
      .map((tool) => (tool.name === 'cancel_booking' ? { ...tool, scopeModes: ['host'] } : tool))
    const { profile: _, ...cli } = actual.cli
    actual.cli = cli
    expect(apiKeyScopeParityErrors(actual)).toEqual(
      expect.arrayContaining([
        'REST GET /api/v1/profile: stale scope classification.',
        'REST PUT /api/v1/profile: stale scope classification.',
        'MCP get_profile: stale scope classification.',
        'MCP mode mcp:cancel_booking:manageToken: stale scope classification.',
        'CLI profile: stale scope classification.',
      ]),
    )
  })

  it('rejects duplicate policies, registrations and wildcard authority', () => {
    const actual = inventory()
    const firstRoute = actual.rest[0]
    const firstCli = API_KEY_CLI_OPERATIONS[0]
    if (!firstRoute || !firstCli) throw new Error('Parity fixtures must not be empty')
    actual.rest = [...actual.rest, firstRoute, { method: 'get', path: '/api/v1/*' }]
    actual.mcp = [...actual.mcp, { name: 'whoami' }]
    const policy: ScopePolicies = {
      ...API_KEY_SCOPE_POLICIES,
      cli: [...API_KEY_CLI_OPERATIONS, firstCli],
    }
    expect(apiKeyScopeParityErrors(actual, policy)).toEqual(
      expect.arrayContaining([
        'REST GET /api/v1/analytics/bookings: duplicate registration.',
        'REST GET /api/v1/*: wildcard registration is forbidden.',
        'MCP whoami: duplicate registration.',
        'CLI whoami: duplicate policy.',
      ]),
    )
  })

  it('rejects a native session exemption when API-key authentication is documented', () => {
    const actual = inventory()
    actual.rest = actual.rest.map((operation) =>
      operation.path === '/api/v1/readiness/self'
        ? { ...operation, security: [{ apiKey: [] }] }
        : operation,
    )
    expect(apiKeyScopeParityErrors(actual)).toContain(
      'REST GET /api/v1/readiness/self: native session exemption requires session-only OpenAPI security.',
    )
  })

  it('rejects a CLI alias retargeted to a different existing tool', () => {
    const actual = inventory()
    actual.cli = { ...actual.cli, profile: 'create_booking' }
    expect(apiKeyScopeParityErrors(actual)).toContain(
      'CLI profile: actual command invokes a different MCP tool.',
    )
  })
})

describe('scope parity source-copy mutation checks', () => {
  it('verifies the unmodified source copy', () => {
    verifyMissingRoute(sourceCopy())
    verifyMissingMode(sourceCopy())
    verifyEquivalentScopes(sourceCopy())
    verifyUndocumentedWrite(sourceCopy())
  })

  it.each([
    ['unclassified operation', ['if (!expected.includes(id))', 'if (false)'], verifyMissingRoute],
    [
      'mode classification',
      ['(tool.scopeModes ?? []).map', '([] as string[]).map'],
      verifyMissingMode,
    ],
    [
      'equivalent scope sets',
      ['!sameScopes(equivalent, operation)', 'false'],
      verifyEquivalentScopes,
    ],
    [
      'undocumented route coverage',
      ['inventory.registeredRest ?? []', '[]'],
      verifyUndocumentedWrite,
    ],
  ] as const)(
    'kills removing %s protection with a real guard assertion',
    (_label, replacement, verify) => {
      expect(() => verify(sourceCopy(replacement))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      verify(sourceCopy())
    },
  )
})
