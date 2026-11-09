import { constants, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const KEY = 'hm_one_time_cli_test'
const TOKEN = 'synthetic_one_time_capability_sentinel_1234'
const URL = `https://hourmere.example/book/${TOKEN}`
const env = { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: KEY }
const input = {
  eventTypeId: '019a0000-0000-7000-8000-000000000001',
  idempotencyKey: 'retained-creation-key',
  expiresAt: '2030-11-03T01:30:00-07:00',
  prefill: { name: 'Invitee', email: 'invitee@example.test' },
}
const metadata = { id: '019a0000-0000-7000-8000-000000000002', state: 'active' }

type Change = readonly [string, string]
function sourceCopy(change?: Change, opener = open): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { constants, ...client, open: opener }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
}
async function run(
  command: string,
  args: Record<string, unknown> = input,
  options: { runner?: typeof runCli; output?: string; response?: Response } = {},
) {
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      options.response ??
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { ...metadata, ...(command === 'create' && { url: URL }) } },
      }),
  )
  const code = await (options.runner ?? runCli)({
    argv: [
      'one-time-links',
      command,
      '--input',
      '-',
      ...(options.output ? ['--output', options.output] : []),
    ],
    env,
    stdin: (async function* () {
      yield JSON.stringify(args)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  expect((stdout + stderr).includes(KEY)).toBe(false)
  return { code, stdout, stderr, fetcher }
}
async function verifyCreate(runner = runCli) {
  const result = await run('create', input, { runner })
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout.split(TOKEN).length - 1).toBe(1)
  expect(JSON.parse(result.stdout).url === URL).toBe(true)
  expect(result.fetcher).toHaveBeenCalledTimes(1)
  const call = result.fetcher.mock.calls[0]
  expect(JSON.parse(String(call?.[1]?.body)).params).toMatchObject({
    name: 'create_one_time_link',
    arguments: input,
  })
}
async function verifyNoOutput(runner = runCli) {
  const result = await run('create', input, { runner, output: '/unused/one-time-link.json' })
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr).error).toBe('one_time_link_output_forbidden')
  expect(result.fetcher).not.toHaveBeenCalled()
  expect(result.stdout).toBe('')
}
async function verifyIdempotency(runner = runCli) {
  for (const key of [undefined, '', 'bad\nkey', 'x'.repeat(256)]) {
    const result = await run('create', { ...input, idempotencyKey: key }, { runner })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('idempotency_key_required')
    expect(result.fetcher).not.toHaveBeenCalled()
  }
}
async function verifyNoFiles(runner?: typeof runCli) {
  const opener = vi.fn<typeof open>(async () => {
    throw Error('No files may be opened')
  })
  await verifyCreate(runner ?? sourceCopy(undefined, opener))
  expect(opener).not.toHaveBeenCalled()
}
async function verifyNoSpaces(runner = runCli) {
  const result = await run('create', { ...input, idempotencyKey: 'not a random key' }, { runner })
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr).error).toBe('idempotency_key_required')
  expect(result.fetcher).not.toHaveBeenCalled()
}

describe('one-time link CLI administration', () => {
  it('prints the new secret URL once and forwards the retained idempotency key', () =>
    verifyCreate())
  it('does not create config, history or result files', () => verifyNoFiles())
  it('refuses --output before creating a link', () => verifyNoOutput())
  it('requires a caller-retained idempotency key before creation', () => verifyIdempotency())
  it('matches the service idempotency contract by refusing spaces', () => verifyNoSpaces())
  it.each([
    ['list', 'list_one_time_links'],
    ['revoke', 'revoke_one_time_link'],
  ] as const)('dispatches %s without printing a capability', async (command, tool) => {
    const args = {
      eventTypeId: input.eventTypeId,
      ...(command === 'revoke' && { id: metadata.id }),
    }
    const result = await run(command, args)
    expect(result.code).toBe(0)
    expect(result.stdout.includes(TOKEN)).toBe(false)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: tool,
      arguments: args,
    })
  })
  it.each(['http', 'tool', 'network'] as const)(
    'never prints sensitive %s error text or retries',
    async (mode) => {
      const response =
        mode === 'http'
          ? Response.json({ error: `${TOKEN} ${URL}` }, { status: 500 })
          : Response.json({
              jsonrpc: '2.0',
              id: 1,
              result: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'creation_failed', message: `${TOKEN} ${URL}` }),
                  },
                ],
              },
            })
      let result: Awaited<ReturnType<typeof run>>
      if (mode === 'network') {
        const runner: typeof runCli = (options) =>
          runCli({
            ...options,
            fetch: async () => {
              throw Error(`${TOKEN} ${URL}`)
            },
          })
        result = await run('create', input, { runner })
      } else result = await run('create', input, { response })
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr.includes(TOKEN)).toBe(false)
      expect(result.stderr.includes(URL)).toBe(false)
      if (mode !== 'network') expect(result.fetcher).toHaveBeenCalledTimes(1)
    },
  )
  it('exercises unchanged source copies before mutation controls', async () => {
    await verifyCreate(sourceCopy())
    await verifyNoOutput(sourceCopy())
    await verifyIdempotency(sourceCopy())
    await verifyNoSpaces(sourceCopy())
  })
  it.each<[string, Change, (runner: typeof runCli) => Promise<void>]>([
    [
      'create dispatch',
      [
        "'one-time-links create': 'create_one_time_link'",
        "'one-time-links create': 'create_booking'",
      ],
      verifyCreate,
    ],
    [
      'one-time URL output',
      [
        'options.stdout(printable(result, [...secrets, token]))',
        'options.stdout(printable({ saved: true }, [...secrets, token]))',
      ],
      verifyCreate,
    ],
    [
      'private file refusal',
      ["command === 'one-time-links create' && options.output", 'false'],
      verifyNoOutput,
    ],
    [
      'retained idempotency requirement',
      ["['book', 'one-time-links create'].includes(args.command)", "args.command === 'book'"],
      verifyIdempotency,
    ],
    [
      'visible idempotency characters',
      ['!/^[\\x21-\\x7e]{1,255}$/.test(input.idempotencyKey as string)', 'false'],
      verifyNoSpaces,
    ],
  ])('kills removed %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
