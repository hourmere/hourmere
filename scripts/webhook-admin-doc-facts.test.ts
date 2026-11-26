import { readFileSync } from 'node:fs'
import { apiKeyOperation } from '@hourmere/auth'
import { assert, expect, it } from 'vitest'
import { loadInterfaceInventory } from './interface-parity.ts'

const guide = readFileSync(new URL('../docs/webhook-admin.md', import.meta.url), 'utf8')
const parity: unknown = JSON.parse(
  readFileSync(new URL('./interface-parity.json', import.meta.url), 'utf8'),
)

it('documents every signed webhook operation with its shipped tool, command and scope', async () => {
  const inventory = await loadInterfaceInventory()
  const operations = new Map(
    inventory.rest
      .filter(({ path }) => path === '/api/v1/webhooks' || path.startsWith('/api/v1/webhooks/'))
      .map(({ method, path, operationId }) => [`${method.toUpperCase()} ${path}`, operationId]),
  )
  const section =
    guide.split('\n## Existing REST, MCP and CLI operations\n')[1]?.split('\n## ')[0] ?? ''
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
  expect(rows).toHaveLength(operations.size)
  const documented = new Map<string, string>()

  for (const row of rows) {
    const match = row.match(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| (.+) \|$/)
    assert(match, `Malformed webhook operation row: ${row}`)
    const [, route = '', operationId = '', mcp = '', cli = '', scopeCell = ''] = match
    documented.set(route, operationId)

    expect(parity, operationId).toMatchObject({ [operationId]: { mcp, cli } })
    expect(inventory.mcp, operationId).toContain(mcp)
    expect(inventory.cli[cli], cli).toBe(mcp)

    const scopes = scopeCell.split(', ').sort()
    for (const id of [route, `mcp:${mcp}`, `cli:${cli}`]) {
      const allowed = apiKeyOperation(id)?.allowedScopes
      expect(allowed?.map((scope) => `\`${scope}\``).sort(), id).toEqual(scopes)
    }
  }
  expect(documented).toEqual(operations)
})
