import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { describe, expect, it, vi } from 'vitest'
import { BrandingUpdate, BrandingView } from '../routes/branding.ts'
import { brandingTools } from './branding.ts'
import { defineTool, type McpCaller, runTool } from './tools.ts'

const principal: McpCaller = {
  kind: 'api_key',
  apiKeyId: randomUUID(),
  apiKeyScope: 'full',
  user: { id: randomUUID(), name: 'Host', email: 'host@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'host', personal: true },
}
const view = {
  brandLogo: null,
  brandPrimaryColor: '#123456',
  buttonTextColor: '#FFFFFF',
  backgroundContrast: 12,
  buttonTextContrast: 12,
}
function copy(change?: readonly [string, string]) {
  let source = readFileSync('apps/server/src/mcp/branding.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0])).toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const getBranding = vi.fn(async () => view)
  const setBranding = vi.fn(async () => view)
  const bindings = { z, BrandingUpdate, BrandingView, defineTool, getBranding, setBranding }
  const factory = new Function(...Object.keys(bindings), `${source}; return brandingTools`)(
    ...Object.values(bindings),
  ) as typeof brandingTools
  return { tools: factory({ db: {} as Db }), getBranding, setBranding }
}
async function verifyForwarding(instance: ReturnType<typeof copy>) {
  const input = { brandLogo: 'a'.repeat(64), brandPrimaryColor: '#123456' }
  const tool = instance.tools.find((tool) => tool.name === 'set_branding')
  if (!tool) throw new Error('Missing tool')
  const result = await runTool(tool, input, { caller: principal, rateLimit() {} }, vi.fn())
  expect(result.isError).not.toBe(true)
  expect(instance.setBranding).toHaveBeenCalledWith(expect.objectContaining({ principal }), input)
}
describe('branding MCP', () => {
  it('forwards the organization principal and complete patch to the shared service', async () => {
    await verifyForwarding(copy())
  })
  it('kills a source-copy mutation dropping the logo reference', async () => {
    await expect(
      verifyForwarding(
        copy([
          'setBranding(context(call.caller), args)',
          'setBranding(context(call.caller), { brandPrimaryColor: args.brandPrimaryColor })',
        ]),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it.each(['read', 'bookings'] as const)(
    'denies %s writes before calling the service',
    async (scope) => {
      const instance = copy()
      const tool = instance.tools.find((tool) => tool.name === 'set_branding')
      if (!tool) throw new Error('Missing tool')
      const result = await runTool(
        tool,
        { brandPrimaryColor: '#123456' },
        { caller: { ...principal, apiKeyScope: scope }, rateLimit() {} },
        vi.fn(),
      )
      expect(result.isError).toBe(true)
      expect(instance.setBranding).not.toHaveBeenCalled()
    },
  )
  it('rejects unknown fields and invalid color or reference inputs', async () => {
    const instance = copy()
    const tool = instance.tools.find((tool) => tool.name === 'set_branding')
    if (!tool) throw new Error('Missing tool')
    for (const input of [
      { brandPrimaryColor: 'red' },
      { brandLogo: 'https://example.test/logo.png' },
      { organizationId: randomUUID() },
    ]) {
      const result = await runTool(tool, input, { caller: principal, rateLimit() {} }, vi.fn())
      expect(result.isError).toBe(true)
    }
    expect(instance.setBranding).not.toHaveBeenCalled()
  })
  it('advertises the shared REST schemas', () => {
    const tools = brandingTools({ db: {} as Db })
    expect(tools[1]?.input).toBe(BrandingUpdate)
    for (const tool of tools) expect(tool.output).toBe(BrandingView)
  })
})
