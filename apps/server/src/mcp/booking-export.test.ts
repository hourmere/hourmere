import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { describe, expect, it, vi } from 'vitest'
import { bookingTools } from './bookings.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn(async () => ({})) }))
vi.mock('@hourmere/scheduling', async (original) => ({
  ...(await original<object>()),
  prepareBookingExport: prepare,
}))

const caller: McpCaller = {
  kind: 'api_key',
  apiKeyScope: 'read',
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Owner', email: 'owner@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'owner', personal: true },
}
const args = {
  from: '2026-11-01T00:00:00Z',
  to: '2026-12-01T00:00:00Z',
  timeZone: 'America/Los_Angeles',
  bom: true,
}
const tool = bookingTools({ db: {} as Db }).find((item) => item.name === 'export_bookings')
if (!tool) throw new Error('Missing export tool')
const call = (principal = caller) => ({ caller: principal, rateLimit() {} })

describe('MCP export pointer', () => {
  it('returns only a bounded credential-free pointer pinned to the organization', async () => {
    prepare.mockResolvedValue({})
    const result = await runTool(tool, args, call(), () => {})
    expect(result.isError).not.toBe(true)
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ principal: caller }), args)
    const output = result.structuredContent as { downloadPath: string }
    const url = new URL(output.downloadPath, 'https://example.test')
    expect(url.pathname).toBe('/api/v1/bookings/export.csv')
    expect(url.searchParams.get('expectedOrganizationId')).toBe(caller.organization.id)
    expect(url.searchParams.get('timeZone')).toBe(args.timeZone)
    expect(Object.keys(output).sort()).toEqual([
      'authentication',
      'containsPersonalData',
      'downloadPath',
    ])
    expect(JSON.stringify(result).length).toBeLessThan(2000)
  })
  it('rejects booking-only keys before authorization and preserves resource denials', async () => {
    prepare.mockClear()
    const denied = await runTool(tool, args, call({ ...caller, apiKeyScope: 'bookings' }), () => {})
    expect(denied.isError).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockRejectedValueOnce(new DomainError('forbidden', 'insufficient_role'))
    const resource = await runTool(tool, args, call(), () => {})
    expect(resource.isError).toBe(true)
    expect(resource.content).toEqual([{ type: 'text', text: '{"error":"insufficient_role"}' }])
  })
})

function copy(change?: [string, string]): Tool {
  const source = readFileSync('apps/server/src/mcp/bookings.ts', 'utf8')
  let block = source.slice(
    source.indexOf('  const exportBookings ='),
    source.indexOf('  const retryInput ='),
  )
  if (change) {
    expect(block).toContain(change[0])
    block = block.replace(...change)
  }
  return new Function(
    'z',
    'Instant',
    'defineTool',
    'prepareBookingExport',
    'context',
    `${stripTypeScriptTypes(block)}; return exportBookings`,
  )(z, z.string(), defineTool, prepare, (principal: McpCaller) => ({ principal })) as Tool
}

it.each([
  ['authorization', 'await prepareBookingExport(context(call.caller), args)', ''],
  ['organization pin', "query.set('expectedOrganizationId', call.caller.organization.id)", ''],
])('kills removed MCP %s in a source copy', async (_name, before, after) => {
  const verify = async (candidate: Tool) => {
    prepare.mockReset().mockResolvedValue({})
    const result = await runTool(candidate, args, call(), () => {})
    expect(result.isError).not.toBe(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    const output = result.structuredContent as { downloadPath: string }
    expect(
      new URL(output.downloadPath, 'https://example.test').searchParams.get(
        'expectedOrganizationId',
      ),
    ).toBe(caller.organization.id)
  }
  await verify(copy())
  await expect(verify(copy([before, after]))).rejects.toThrow()
})
