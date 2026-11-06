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
import { slackTestLimiter } from '../slack-test-limit.ts'
import { slackDestinationTools } from './slack-destinations.ts'
import { defineTool, type McpCaller, RateLimited, runTool, type Tool } from './tools.ts'

const secret = 'https://hooks.slack.com/services/Tfixture/Bfixture/mcp-secret-fixture'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
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
  const invalid = await runTool(
    tool,
    { url: secret, events: [] },
    { caller, rateLimit: () => {} },
    () => {},
  )
  expect(JSON.stringify(invalid)).toContain('Invalid Slack configuration')
  expect(JSON.stringify(invalid)).not.toContain(secret)
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
  const bindings = {
    z,
    ...webhooks,
    serviceContext,
    SlackDestination,
    defineTool,
    slackTestLimiter,
    RateLimited,
  }
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
  const wordingSource = baselineScript.replaceAll(
    "privateValidationMessage: 'Invalid Slack configuration',",
    '',
  )
  expect(wordingSource).not.toBe(baselineScript)
  const wordingMutation = new Function(
    ...Object.keys(bindings),
    `${wordingSource}; return slackDestinationTools`,
  )(...Object.values(bindings)) as typeof slackDestinationTools
  await expect(verifyPrivacy(wordingMutation)).rejects.toMatchObject({ name: 'AssertionError' })
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
  async function verifyLimit(factory = slackDestinationTools) {
    const user = await createTestUser(db)
    const jobs: unknown[] = []
    const tools = factory({
      db,
      ...settings,
      queue: {
        enqueue: async (...args) => {
          jobs.push(args)
          return randomUUID()
        },
      },
    })
    const invoke = (name: string, args: unknown) =>
      runTool(
        tools.find((t) => t.name === name) as Tool,
        args,
        { caller: user.principal as McpCaller, rateLimit: () => {} },
        () => {},
      )
    const created = await invoke('create_slack_destination', {
      url: secret,
      events: ['booking.created'],
    })
    const id = (created.structuredContent as { id: string }).id
    const first = await invoke('test_slack_destination', { id })
    expect(first.isError).not.toBe(true)
    const pending = await invoke('test_slack_destination', { id })
    expect(pending.content).toEqual([
      { type: 'text', text: JSON.stringify({ error: 'slack_test_pending' }) },
    ])
    expect(jobs).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      await db
        .updateTable('webhook_deliveries')
        .set({ status: 'delivered' })
        .where('webhook_id', '=', id)
        .execute()
      expect((await invoke('test_slack_destination', { id })).isError).not.toBe(true)
    }
    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'delivered' })
      .where('webhook_id', '=', id)
      .execute()
    const refused = await invoke('test_slack_destination', { id })
    expect(refused.isError).toBe(true)
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      error: 'rate_limited',
    })
    expect(jobs).toHaveLength(4)
  }
  it('bounds shared-queue jobs with pending protection and an organization limit', () =>
    verifyLimit())
  it('source-copy mutation detects removing the MCP organization limit', async () => {
    const source = readFileSync('apps/server/src/mcp/slack-destinations.ts', 'utf8')
    const anchor = 'slackTestLimiter.hit(call.caller.organization.id)'
    expect(source).toContain(anchor)
    const bindings = {
      z,
      ...webhooks,
      serviceContext,
      SlackDestination,
      defineTool,
      slackTestLimiter,
      RateLimited,
    }
    const compile = (text: string) =>
      new Function(
        ...Object.keys(bindings),
        `${stripTypeScriptTypes(text.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, '')).replace(/\bexport /g, '')}; return slackDestinationTools`,
      )(...Object.values(bindings)) as typeof slackDestinationTools
    await verifyLimit(compile(source))
    await expect(verifyLimit(compile(source.replace(anchor, 'undefined')))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it('names Slack configuration in private validation failures without exposing URLs', async () => {
    const user = await createTestUser(db)
    const tools = slackDestinationTools({ db, ...settings })
    const result = await runTool(
      tools.find((t) => t.name === 'create_slack_destination') as Tool,
      { url: secret, events: [] },
      { caller: user.principal as McpCaller, rateLimit: () => {} },
      () => {},
    )
    expect(JSON.stringify(result)).toContain('Invalid Slack configuration')
    expect(JSON.stringify(result)).not.toContain(secret)
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
