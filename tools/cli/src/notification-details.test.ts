import { constants, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import type * as client from './client.ts'

type Replacement = readonly [string, string]
function sourceCopy(file: string, replacement?: Replacement) {
  let source = readFileSync(new URL(file, import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(...replacement)
  }
  return stripTypeScriptTypes(
    source.replace(/^import[^\n]*\n/gm, '').replaceAll('import.meta.url', 'clientModuleUrl'),
  ).replace(/^export /gm, '')
}
function clientCopy(replacement?: Replacement): typeof client {
  const source = sourceCopy('./client.ts', replacement)
  return new Function(
    'readFileSync',
    'clientModuleUrl',
    `${source}; return { CliError, callTool, endpoint, isObject, MAX_INPUT_BYTES, version }`,
  )(readFileSync, new URL('./client.ts', import.meta.url).href) as typeof client
}
function commandCopy(
  clientReplacement?: Replacement,
  commandReplacement?: Replacement,
): typeof runCli {
  const bindings = { constants, open, ...clientCopy(clientReplacement) }
  const source = sourceCopy('./cli.ts', commandReplacement)
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
}
async function run(message: unknown, code = 'invalid_notifications', command = runCli) {
  let stderr = ''
  const status = await command({
    argv: ['set-event-notifications'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_synthetic_validation' },
    stdin: (async function* () {})(),
    stdout: () => {},
    stderr: (text) => {
      stderr += text
    },
    fetch: async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
        },
      }),
  })
  expect(status).toBe(1)
  return JSON.parse(stderr) as { error: string; message?: string }
}
const messages = [
  'notifications.reminders: at most 5 messages are allowed',
  'notifications.followUps: at most 3 messages are allowed',
  'notifications.reminders[1].id: must be 1–64 letters, digits, "_" or "-"',
  'notifications.followUps[0].id: must not be __proto__',
  'notifications.followUps[1].id: must be unique across reminders and followUps',
  'notifications.reminders[1].offsetMinutes: must be an integer number of minutes',
  'notifications.reminders[4].offsetMinutes: must be between 5 and 43200 minutes',
  'notifications.followUps[1].offsetMinutes: must be unique within this message category',
  'notifications.reminders[0].recipients: at least one recipient must be selected',
  'notifications.followUps[1].hostNote: must contain at most 2000 UTF-16 code units',
  'notifications.followUps[0].hostNote: must contain well-formed Unicode',
  'notifications.followUps[2].hostNote: must not contain control characters other than LF',
  'notifications.followUps[1].hostNote: host notes are disabled by the operator',
]
async function verifyDetails(command = runCli) {
  for (const message of messages)
    expect(await run(message, 'invalid_notifications', command)).toMatchObject({
      error: 'invalid_notifications',
      message,
    })
}
async function verifyPrivacy(command = runCli) {
  for (const message of [
    'private-note',
    'notifications.followUps[0].hostNote: private-note',
    'notifications.followUps[0].hostNote: must contain at most 2000 UTF-16 code units: private-note',
    'notifications.followUps[0].hostNote: must contain at most 2000 UTF-16 code units\n',
    'notifications.followUps[0].privateField: must contain well-formed Unicode',
    'notifications.followUps[0].id: must contain well-formed Unicode',
    'notifications.reminders[0].hostNote: must contain well-formed Unicode',
    'notifications.followUps[3].hostNote: must contain well-formed Unicode',
    'notifications.reminders[5].id: must not be __proto__',
    null,
    1,
  ])
    expect((await run(message, 'invalid_notifications', command)).message).toBeUndefined()
  expect((await run(messages[0], 'slot_taken', command)).message).toBeUndefined()
}

describe('CLI notification validation details', () => {
  it('preserves every fixed notification constraint and its field path', async () => {
    await verifyDetails()
    await verifyDetails(commandCopy())
  })
  it('suppresses submitted text, arbitrary server messages and malformed detail paths', async () => {
    await verifyPrivacy()
    await verifyPrivacy(commandCopy())
  })
  it('detects dropping notification detail from the transport with a source-copy assertion failure', async () => {
    const command = commandCopy([
      'notificationDetail(code, isObject(detail) ? detail.message : undefined)',
      'undefined',
    ])
    await expect(verifyDetails(command)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects dropping notification detail from stderr with a source-copy assertion failure', async () => {
    const command = commandCopy(undefined, [
      'message: error.detail',
      'notificationMessage: error.detail',
    ])
    await expect(verifyDetails(command)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each<[string, Replacement]>([
    [
      'arbitrary notification text',
      [
        "  if (code !== 'invalid_notifications' || typeof value !== 'string') return undefined",
        "  if (typeof value === 'string') return value",
      ],
    ],
    [
      'unrelated error messages',
      [
        "code !== 'invalid_notifications' || typeof value !== 'string'",
        "typeof value !== 'string'",
      ],
    ],
    [
      'notes on reminders',
      ["  if (field === 'hostNote' && category !== 'followUps') return undefined", ''],
    ],
    [
      'invalid follow-up positions',
      ["  if (category === 'followUps' && Number(index) > 2) return undefined", ''],
    ],
    ['invalid reminder positions', ['([0-4])', '([0-9])']],
    [
      'unknown field constraints',
      [
        'return field && constraint && constraints[field]?.includes(constraint) ? value : undefined',
        'return value',
      ],
    ],
  ])('detects echoing %s with a source-copy assertion failure', async (_, replacement) => {
    const command = commandCopy(replacement)
    await expect(verifyPrivacy(command)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
