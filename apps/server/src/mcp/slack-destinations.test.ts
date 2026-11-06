import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import * as webhooks from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serviceContext } from '../openapi.ts'
import { SlackDestination } from '../routes/slack-destinations.ts'
import { slackDestinationTools } from './slack-destinations.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

const secret = 'https://hooks.slack.com/services/Tfixture/Bfixture/mcp-secret-fixture'
const settings = { enabled: false, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
async function verifyPrivacy(factory = slackDestinationTools) {
  const tools = factory({ db: {} as Db, ...settings })
  const logs: unknown[] = []
  const caller = { kind: 'api_key', apiKeyScope: 'full' } as McpCaller
  const tool = tools.find((t) => t.name === 'create_slack_destination') as Tool
  const result = await runTool(
    {
      ...tool,
      run: async () => {
        throw new Error(secret)
      },
    },
    { url: secret, events: ['booking.created'] },
    { caller, rateLimit: () => {} },
    (...args) => logs.push(args),
  )
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(logs).toHaveLength(1)
  expect(JSON.stringify(logs)).not.toContain(secret)
}
it('suppresses diagnostics containing Slack URLs', () => verifyPrivacy())
it('source-copy mutation detects removing private diagnostics', async () => {
  let source = readFileSync('apps/server/src/mcp/slack-destinations.ts', 'utf8')
  expect(source).toContain('privateDiagnostics: true,')
  const baseline = source
  source = source.replaceAll('privateDiagnostics: true,', '')
  source = source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  const bindings = { z, ...webhooks, serviceContext, SlackDestination, defineTool }
  const factory = new Function(...Object.keys(bindings), `${source}; return slackDestinationTools`)(
    ...Object.values(bindings),
  ) as typeof slackDestinationTools
  const baselineScript = stripTypeScriptTypes(
    baseline.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  const control = new Function(
    ...Object.keys(bindings),
    `${baselineScript}; return slackDestinationTools`,
  )(...Object.values(bindings)) as typeof slackDestinationTools
  await verifyPrivacy(control)
  await expect(verifyPrivacy(factory)).rejects.toMatchObject({ name: 'AssertionError' })
})
const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('Slack MCP service adapters', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it('supports all five commands with masked data and enforces scopes before writes', async () => {
    const user = await createTestUser(db)
    const tools = slackDestinationTools({
      db,
      ...settings,
      queue: { enqueue: async () => randomUUID() },
    })
    const invoke = async (
      name: string,
      args: unknown = {},
      scope: 'full' | 'read' | 'bookings' = 'full',
    ) => {
      const tool = tools.find((t) => t.name === name) as Tool
      const result = await runTool(
        tool,
        args,
        { caller: { ...user.principal, apiKeyScope: scope } as McpCaller, rateLimit: () => {} },
        () => {},
      )
      expect(JSON.stringify(result)).not.toContain('mcp-secret-fixture')
      return result
    }
    const created = await invoke('create_slack_destination', {
      url: secret,
      events: ['booking.created'],
    })
    expect(created.isError).not.toBe(true)
    const id = (created.structuredContent as { id: string }).id
    expect((await invoke('list_slack_destinations', {}, 'read')).structuredContent).toMatchObject({
      data: [{ id }],
    })
    expect((await invoke('test_slack_destination', { id })).structuredContent).toHaveProperty(
      'deliveryId',
    )
    expect(
      (await invoke('update_slack_destination', { id, isActive: false })).structuredContent,
    ).toMatchObject({ id, isActive: false })
    for (const name of [
      'create_slack_destination',
      'update_slack_destination',
      'delete_slack_destination',
      'test_slack_destination',
    ]) {
      for (const scope of ['read', 'bookings'] as const)
        expect((await invoke(name, {}, scope)).isError).toBe(true)
    }
    expect((await invoke('delete_slack_destination', { id })).structuredContent).toEqual({
      deleted: true,
    })
    expect((await invoke('list_slack_destinations')).structuredContent).toEqual({ data: [] })
  })
})
