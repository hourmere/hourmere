import { constants, readFileSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const args = {
  slug: 'chat',
  from: '2030-11-04T00:00:00Z',
  to: '2030-11-11T00:00:00Z',
  count: 3,
  locale: 'zh-CN',
  displayTimeZone: 'America/New_York',
}
const snippet = {
  text: '可预约时间',
  html: '<p>可预约时间</p>',
  slots: [{ url: 'https://example.test/host/chat?start=2030-11-04T09%3A00%3A00Z' }],
}
async function verify(runner = runCli) {
  let stdout = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: snippet } }),
  )
  const code = await runner({
    argv: ['open-time-snippet', '--json', '--input', '-'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_test' },
    stdin: (async function* () {
      yield JSON.stringify(args)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: () => {},
    fetch: fetcher,
  })
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual(snippet)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
    name: 'generate_open_time_snippet',
    arguments: args,
  })
}
function copy(change?: [string, string], callTool = client.callTool): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { constants, open, unlink, ...client, callTool }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  )
}
it('forwards snippet options and prints both formats with explicit --json', () => verify())
it('checks unchanged source and kills changed dispatch and lost output', async () => {
  await verify(copy())
  for (const change of [
    [
      "'open-time-snippet': 'generate_open_time_snippet'",
      "'open-time-snippet': 'find_available_slots'",
    ],
    [
      'options.stdout(printable(result, [...secrets, token]))',
      'options.stdout(printable({}, [...secrets, token]))',
    ],
  ] as [string, string][]) {
    await expect(verify(copy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  }
})

const hiddenTool = {
  jsonrpc: '2.0',
  id: 1,
  error: { code: -32602, message: 'Tool generate_open_time_snippet not found' },
}
async function verifyDisabled(runner = runCli, reply: unknown = hiddenTool) {
  let stdout = ''
  let stderr = ''
  const code = await runner({
    argv: ['open-time-snippet', '--json', '--input', '-'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_test' },
    stdin: (async function* () {
      yield JSON.stringify(args)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: async () => Response.json(reply),
  })
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(JSON.parse(stderr)).toEqual({ error: 'slot_snippets_disabled' })
}
function clientCopy(...changes: [string, string][]): typeof client.callTool {
  let source = readFileSync('tools/cli/src/client.ts', 'utf8')
  for (const change of changes) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = source
    .replace(/export const \{ version \} = JSON.parse\([\s\S]*?as \{ version: string \}/, '')
    .replace(/export class CliError extends Error \{[\s\S]*?^\}/m, '')
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function('version', 'CliError', `${source}; return callTool`)(
    client.version,
    client.CliError,
  )
}
it('reports hidden and explicitly disabled snippets as a definite client error', async () => {
  await verifyDisabled()
  await verifyDisabled(runCli, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'slot_snippets_disabled' }) }],
    },
  })
})
it('does not mistake other tools or malformed protocol replies for disabled snippets', async () => {
  for (const [tool, reply] of [
    [
      'create_booking',
      { ...hiddenTool, error: { ...hiddenTool.error, message: 'Tool create_booking not found' } },
    ],
    ['generate_open_time_snippet', { ...hiddenTool, id: 2 }],
    ['generate_open_time_snippet', { ...hiddenTool, jsonrpc: '1.0' }],
    ['generate_open_time_snippet', { ...hiddenTool, error: { ...hiddenTool.error, code: -32603 } }],
    [
      'generate_open_time_snippet',
      { ...hiddenTool, error: { ...hiddenTool.error, message: 'Other error' } },
    ],
  ] as const) {
    await expect(
      client.callTool({
        url: new URL('https://example.test/mcp'),
        key: 'hm_test',
        tool,
        input: args,
        fetch: async () => Response.json(reply),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  }
})
it('kills removed disabled mapping and restored outcome ambiguity in source copies', async () => {
  await verifyDisabled(copy(undefined, clientCopy()))
  await expect(
    verifyDisabled(
      copy(
        undefined,
        clientCopy([
          "throw new CliError('slot_snippets_disabled')",
          "throw new CliError('invalid_response')",
        ]),
      ),
    ),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await expect(
    verifyDisabled(
      copy(["!(command === 'open-time-snippet' && code === 'slot_snippets_disabled')", 'true']),
    ),
  ).rejects.toMatchObject({ name: 'AssertionError' })
})

async function verifyOtherCommand(runner = runCli, explicitDisabled = false) {
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(
      explicitDisabled
        ? {
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [
                { type: 'text', text: JSON.stringify({ error: 'slot_snippets_disabled' }) },
              ],
            },
          }
        : {
            ...hiddenTool,
            error: { ...hiddenTool.error, message: 'Tool create_one_time_link not found' },
          },
    ),
  )
  const code = await runner({
    argv: ['one-time-links', 'create', '--json', '--input', '-'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_test' },
    stdin: (async function* () {
      yield JSON.stringify({ eventTypeId: 'event', idempotencyKey: 'test-create' })
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params.name).toBe(
    'create_one_time_link',
  )
  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(JSON.parse(stderr)).toEqual({
    error: explicitDisabled ? 'slot_snippets_disabled' : 'invalid_response',
    outcomeMayBeUnknown: true,
  })
}
it('keeps other unknown tools ambiguous with invalid_response and exit 1', () =>
  verifyOtherCommand())
it('keeps other commands ambiguous even when they return the snippets error code', () =>
  verifyOtherCommand(runCli, true))
it('kills mapping every tool not-found reply and exempting every command in source copies', async () => {
  await verifyOtherCommand(copy(undefined, clientCopy()))
  await verifyOtherCommand(copy(), true)
  await expect(
    verifyOtherCommand(
      copy(
        undefined,
        clientCopy(
          ["tool === 'generate_open_time_snippet' &&", ''],
          [
            "reply.error.message === 'Tool generate_open_time_snippet not found'",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal mutated source
            'reply.error.message === `Tool ${tool} not found`',
          ],
        ),
      ),
    ),
  ).rejects.toMatchObject({ name: 'AssertionError' })
  await expect(
    verifyOtherCommand(copy(["command === 'open-time-snippet' && ", '']), true),
  ).rejects.toMatchObject({ name: 'AssertionError' })
})
