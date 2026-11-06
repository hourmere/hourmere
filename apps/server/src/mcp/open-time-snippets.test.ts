import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { expect, it, vi } from 'vitest'
import * as schemas from '../routes/open-time-snippets.ts'
import { openTimeSnippetTools } from './open-time-snippets.ts'
import { defineTool, type McpCaller, runTool } from './tools.ts'

const input = {
  slug: 'chat',
  from: '2030-11-04T00:00:00Z',
  to: '2030-11-11T00:00:00Z',
  count: 3,
  locale: 'zh-CN',
  displayTimeZone: 'Asia/Shanghai',
}
const result = {
  bookingUrl: 'https://example.test/host/chat',
  durationMinutes: 30,
  locale: 'zh-CN',
  displayTimeZone: 'Asia/Shanghai',
  slots: [],
  text: '可预约时间',
  html: '<p>可预约时间</p>',
}
const caller: McpCaller = {
  kind: 'api_key',
  apiKeyScope: 'read',
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Host', email: 'host@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'host', personal: true },
}
function copy(change?: [string, string]) {
  let source = readFileSync('apps/server/src/mcp/open-time-snippets.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const service = vi.fn(async () => result)
  const bindings = { ...schemas, defineTool, generateOpenTimeSnippet: service }
  const factory = new Function(...Object.keys(bindings), `${source}; return openTimeSnippetTools`)(
    ...Object.values(bindings),
  ) as typeof openTimeSnippetTools
  return { service, factory }
}
async function verify(change?: [string, string]) {
  const { service, factory } = copy(change)
  const db = {} as Db
  const tool = factory({
    db,
    publicUrl: 'https://example.test',
    slotSnippetsEnabled: true,
    automaticMeet: true,
    automaticZoom: true,
  })[0]
  if (!tool) throw Error('Missing tool')
  for (const scope of ['read', 'bookings', 'full'] as const) {
    const principal = { ...caller, apiKeyScope: scope }
    const response = await runTool(
      tool,
      input,
      { caller: principal, rateLimit: () => {} },
      () => {},
    )
    expect(response.structuredContent).toEqual(result)
    expect(service).toHaveBeenLastCalledWith(
      expect.objectContaining({ db, principal, automaticMeet: true, automaticZoom: true }),
      input,
      {
        publicUrl: 'https://example.test',
        slotSnippetsEnabled: true,
      },
    )
  }
}
it('passes all read-capable scopes, input and instance options to the shared service', () =>
  verify())
it('kills dropped instance flag and requested options with real assertion failures', async () => {
  for (const change of [
    ['{ publicUrl, slotSnippetsEnabled }', '{ publicUrl, slotSnippetsEnabled: false }'],
    ['          args,', '          { ...args, count: 1 },'],
  ] as [string, string][]) {
    await expect(verify(change)).rejects.toMatchObject({ name: 'AssertionError' })
  }
})
it('fails closed when the instance flag is absent', async () => {
  const tool = openTimeSnippetTools({ db: {} as Db })[0]
  if (!tool) throw Error('Missing tool')
  const response = await runTool(tool, input, { caller, rateLimit: () => {} }, () => {})
  expect(response.isError).toBe(true)
  expect(response.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('slot_snippets_disabled') }),
    ]),
  )
})
it('propagates no-availability errors without producing a snippet', async () => {
  const { service, factory } = copy()
  service.mockRejectedValueOnce(new DomainError('conflict', 'no_available_slots'))
  const tool = factory({ db: {} as Db, slotSnippetsEnabled: true })[0]
  if (!tool) throw Error('Missing tool')
  const response = await runTool(tool, input, { caller, rateLimit: () => {} }, () => {})
  expect(response.isError).toBe(true)
  expect(response.structuredContent).toBeUndefined()
})
