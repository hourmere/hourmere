import {
  API_KEY_CLI_OPERATIONS,
  API_KEY_MCP_OPERATIONS,
  API_KEY_NATIVE_REST_BOUNDARIES,
  API_KEY_REST_OPERATIONS,
  type ApiKeyOperation,
  type ApiKeyOperationClass,
} from '../packages/auth/src/api-key-operations.ts'

export const SCOPE_DOC_FILES = [
  { path: 'docs/api-keys.md', section: 'all' },
  { path: 'apps/site/src/content/docs/docs/api-keys.md', section: 'all' },
  { path: 'docs/mcp.md', section: 'mcp' },
  { path: 'apps/site/src/content/docs/docs/mcp.md', section: 'mcp' },
] as const

export interface ScopeDocumentationPolicy {
  rest: typeof API_KEY_REST_OPERATIONS
  mcp: typeof API_KEY_MCP_OPERATIONS
  cli: typeof API_KEY_CLI_OPERATIONS
  native: readonly string[]
}

export const SCOPE_DOCUMENTATION_POLICY: ScopeDocumentationPolicy = {
  rest: API_KEY_REST_OPERATIONS,
  mcp: API_KEY_MCP_OPERATIONS,
  cli: API_KEY_CLI_OPERATIONS,
  native: API_KEY_NATIVE_REST_BOUNDARIES,
}

const groupNames: Record<ApiKeyOperationClass, string> = {
  booking_read: 'Booking workflow reads',
  booking_write: 'Booking actions and repairs',
  other_read: 'Other account reads',
  other_write: 'Account settings and configuration writes',
  session_only: 'Browser session operations',
  public_metadata: 'Public instance and API metadata',
}

const boundaryNames = {
  key: 'Session or API key',
  optional_key: 'Public or manage token; check a supplied key',
  session_only: 'Browser session only',
  public_metadata: 'Public; no key needed',
} as const

export const SCOPE_TABLE_START = '<!-- api-key-scope-table:start -->'
export const SCOPE_TABLE_END = '<!-- api-key-scope-table:end -->'

const code = (value: string) => `\`${value}\``
const scopes = (operation: ApiKeyOperation) => operation.allowedScopes.map(code).join(', ') || '—'

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')
}

/** Published permissions are rendered from the same exact registry used by authorization. */
export function renderScopeTables(
  section: 'all' | 'mcp',
  policy: ScopeDocumentationPolicy = SCOPE_DOCUMENTATION_POLICY,
): string {
  const mcp = table(
    ['MCP tool / mode', 'CLI command', 'Allowed key scopes'],
    policy.mcp.map((operation) => [
      code(operation.tool) + (operation.mode === undefined ? '' : ` / ${code(operation.mode)}`),
      policy.cli
        .filter((command) => command.tool === operation.tool)
        .map((command) => code(command.command))
        .join(', ') || '—',
      scopes(operation),
    ]),
  )
  const parts = [SCOPE_TABLE_START]
  if (section === 'all') {
    const groups = [...new Set(policy.rest.map((operation) => operation.operationClass))]
    parts.push(
      '### Operation groups',
      table(
        ['Operation group', '`full`', '`read`', '`bookings`'],
        groups.map((group) => {
          const operations = policy.rest.filter((operation) => operation.operationClass === group)
          return [
            groupNames[group],
            ...(['full', 'read', 'bookings'] as const).map((scope) =>
              operations.every((operation) => operation.allowedScopes.includes(scope))
                ? 'Allowed'
                : operations.some((operation) => operation.allowedScopes.includes(scope))
                  ? 'Some; see exact operations below'
                  : '—',
            ),
          ]
        }),
      ),
      '### REST operations',
      table(
        ['Method and path', 'Authentication boundary', 'Allowed key scopes'],
        policy.rest.map((operation) => [
          code(operation.id),
          boundaryNames[operation.authentication],
          scopes(operation),
        ]),
      ),
      '### MCP tools and CLI commands',
    )
  }
  parts.push(mcp)
  if (section === 'all') {
    parts.push(
      '### Native protocol boundaries',
      'These routes keep their own authentication; API key scopes do not authorize them.',
      table(
        ['Method and path', 'Authentication boundary'],
        policy.native.map((operation) => [
          code(operation),
          operation === 'GET /api/health'
            ? 'Public health check; no key needed'
            : operation === 'POST /api/conference/zoom/events'
              ? 'Provider signature'
              : 'Browser session and bound OAuth state',
        ]),
      ),
    )
  }
  parts.push(SCOPE_TABLE_END)
  return parts.join('\n\n')
}

export function replaceScopeTables(document: string, section: 'all' | 'mcp'): string {
  const start = document.indexOf(SCOPE_TABLE_START)
  const end = document.indexOf(SCOPE_TABLE_END)
  if (start === -1 || end < start) throw new Error('Missing generated API key scope table markers')
  if (
    document.indexOf(SCOPE_TABLE_START, start + 1) !== -1 ||
    document.indexOf(SCOPE_TABLE_END, end + 1) !== -1
  )
    throw new Error('Duplicate generated API key scope table markers')
  return (
    document.slice(0, start) +
    renderScopeTables(section) +
    document.slice(end + SCOPE_TABLE_END.length)
  )
}

export function scopeDocumentationMatches(document: string, section: 'all' | 'mcp'): boolean {
  return replaceScopeTables(document, section) === document
}
