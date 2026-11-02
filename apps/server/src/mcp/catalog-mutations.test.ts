import { constants, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import * as scheduling from '@hourmere/scheduling'
import { describe, expect, it, vi } from 'vitest'
import type { runCli } from '../../../../tools/cli/src/cli.ts'
import * as cliClient from '../../../../tools/cli/src/client.ts'
import type { catalogTools } from './catalog.ts'
import { defineTool, type McpCaller } from './tools.ts'

const settings = {
  reminders: [
    { id: 'before', offsetMinutes: 60, recipients: { invitee: true, guests: false, host: true } },
  ],
  followUps: [
    {
      id: 'after',
      offsetMinutes: 5,
      recipients: { invitee: true, guests: false, host: false },
      hostNote: 'Thank you',
    },
  ],
}
const id = '019a0000-0000-7000-8000-000000000001'
const caller = { kind: 'api_key', apiKeyScope: 'full' } as McpCaller
const source = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8')

function toolCopy(replacement?: readonly [string, string]) {
  let copy = source
  if (replacement) {
    expect(copy.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    copy = copy.replace(replacement[0], replacement[1])
  }
  const updateEventType = vi.fn(
    async (
      _ctx: scheduling.ServiceContext,
      eventId: string,
      input: { notifications: scheduling.NotificationSettings },
    ) => ({ id: eventId, ...input }),
  )
  const dependencies = {
    ...scheduling,
    z,
    defineTool,
    updateEventType,
    EventType: z.object({ id: z.uuid(), notifications: scheduling.NotificationSettingsSchema }),
    Profile: z.object({}),
    Schedule: z.object({}),
  }
  const body = stripTypeScriptTypes(copy.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /^export /gm,
    '',
  )
  const factory = new Function(...Object.keys(dependencies), `${body}; return catalogTools`)(
    ...Object.values(dependencies),
  ) as typeof catalogTools
  const tool = factory({ db: {} as Db, followUpHostNotesEnabled: false }).find(
    (item) => item.name === 'set_event_type_notifications',
  )
  if (!tool) throw new Error('Missing notification write tool')
  return { tool, updateEventType }
}

async function verifyForwarding(copy: ReturnType<typeof toolCopy>) {
  const args = { id, notifications: settings }
  const result = await copy.tool.run(copy.tool.input.parse(args), { caller, rateLimit: () => {} })
  expect(copy.updateEventType).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ principal: caller, followUpHostNotesEnabled: false }),
    id,
    { notifications: settings },
  )
  expect(copy.tool.output.parse(result)).toEqual(args)
  expect(copy.tool.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
}

function verifyStrictInput(copy: ReturnType<typeof toolCopy>) {
  for (const args of [
    { id, notifications: null },
    { id, notifications: { reminders: [] } },
    { id, notifications: { ...settings, extra: true } },
    { id, notifications: settings, organizationId: id },
    {
      id,
      notifications: {
        reminders: [{ ...settings.reminders[0], hostNote: 'forbidden' }],
        followUps: [],
      },
    },
  ])
    expect(copy.tool.input.safeParse(args).success).toBe(false)
  expect(copy.tool.input.safeParse({ id, notifications: settings }).success).toBe(true)
  // Numeric semantics belong to the service so all interfaces return invalid_notifications.
  expect(
    copy.tool.input.safeParse({
      id,
      notifications: {
        reminders: [{ ...settings.reminders[0], offsetMinutes: 5.5 }],
        followUps: [],
      },
    }).success,
  ).toBe(true)
}

async function verifyCommand(commandSource: string) {
  const dependencies = { constants, open, ...cliClient }
  const body = stripTypeScriptTypes(
    commandSource.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/^export /gm, '')
  const run = new Function(...Object.keys(dependencies), `${body}; return runCli`)(
    ...Object.values(dependencies),
  ) as typeof runCli
  const calls: unknown[] = []
  const code = await run({
    argv: ['set-event-notifications', '--input', '-'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_synthetic_test' },
    stdin: (async function* () {
      yield JSON.stringify({ id, notifications: settings })
    })(),
    stdout: () => {},
    stderr: () => {},
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)).params)
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { id, notifications: settings } },
      })
    },
  })
  expect(code).toBe(0)
  expect(calls).toEqual([
    expect.objectContaining({
      name: 'set_event_type_notifications',
      arguments: { id, notifications: settings },
    }),
  ])
}

describe('notification interface source-copy mutation checks', () => {
  it('verifies the unchanged tool source forwards settings and the operator switch', async () => {
    await verifyForwarding(toolCopy())
    verifyStrictInput(toolCopy())
  })

  it.each([
    [
      'notification forwarding',
      'notifications: args.notifications,',
      'notifications: { reminders: [], followUps: [] },',
    ],
    [
      'operator switch forwarding',
      '    followUpHostNotesEnabled,\n  })',
      '    followUpHostNotesEnabled: true,\n  })',
    ],
    [
      'full EventType response',
      '      output: EventType,\n      annotations: { ...annotations, readOnlyHint: false }',
      '      output: EventType.omit({ notifications: true }),\n      annotations: { ...annotations, readOnlyHint: false }',
    ],
  ] as const)('kills removing %s', async (_name, from, to) => {
    await expect(verifyForwarding(toolCopy([from, to]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verifyForwarding(toolCopy())
  })

  it.each([
    [
      'strict argument keys',
      'input: z.strictObject({ ...IdInput.shape, notifications: NotificationSettingsSchema })',
      'input: z.object({ ...IdInput.shape, notifications: NotificationSettingsSchema })',
    ],
    [
      'notification input schema',
      'notifications: NotificationSettingsSchema })',
      'notifications: z.unknown() })',
    ],
  ] as const)('kills removing %s', (_name, from, to) => {
    expect(() => verifyStrictInput(toolCopy([from, to]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyStrictInput(toolCopy())
  })

  it('kills retargeting the actual CLI command with its request assertion', async () => {
    const commandSource = readFileSync(
      new URL('../../../../tools/cli/src/cli.ts', import.meta.url),
      'utf8',
    )
    await verifyCommand(commandSource)
    const mutant = commandSource.replace(
      "'set-event-notifications': 'set_event_type_notifications'",
      "'set-event-notifications': 'get_event_type'",
    )
    expect(mutant).not.toBe(commandSource)
    await expect(verifyCommand(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyCommand(commandSource)
  })
})
