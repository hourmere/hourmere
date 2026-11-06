import { execFileSync } from 'node:child_process'
import { constants, readFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'
import { CliError, callTool, endpoint, MAX_INPUT_BYTES } from './client.ts'

// Synthetic sentinels only. Assertions compare presence, so failure output cannot print capabilities.
const KEY = 'hm_cli_test_sentinel'
const TOKEN = 'synthetic_management_capability_sentinel_12'
const env = { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: KEY }
const response = (structuredContent: unknown = { ok: true }) =>
  Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent } })
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function dir() {
  const path = await mkdtemp(join(tmpdir(), 'hourmere-cli-test-'))
  directories.push(path)
  return path
}
async function run(
  argv: string[],
  input?: unknown,
  overrides: {
    env?: NodeJS.ProcessEnv
    fetch?: typeof fetch
    raw?: string
    runner?: typeof runCli
  } = {},
) {
  let stdout = ''
  let stderr = ''
  const fetcher = overrides.fetch ?? vi.fn<typeof fetch>(async () => response())
  const code = await (overrides.runner ?? runCli)({
    argv,
    env: overrides.env ?? env,
    stdin: (async function* () {
      if (overrides.raw !== undefined) yield overrides.raw
      else if (input !== undefined) yield JSON.stringify(input)
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
  expect((stdout + stderr).includes(TOKEN)).toBe(false)
  return { code, stdout, stderr, fetcher }
}

function sourceCopy(change?: readonly [string, string]): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[^\n]+\n/gm, '')).replace(/\bexport /g, '')
  const bindings = { constants, open, ...client }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
}

function clientSourceCopy(change?: readonly [string, string]): typeof callTool {
  let source = readFileSync('tools/cli/src/client.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = source.replace(
    /export const \{ version \} = JSON.parse\([\s\S]*?as \{ version: string \}/,
    '',
  )
  source = stripTypeScriptTypes(source.replace(/^import[^\n]+\n/gm, '')).replace(/\bexport /g, '')
  return new Function('version', `${source}; return callTool`)(client.version) as typeof callTool
}

describe('CLI transport and arguments', () => {
  const waitlistToken =
    '12345678-1234-4123-8123-123456789abc.synthetic_waitlist_capability_sentinel_123456'
  async function verifyWaitlistPrivacy(runner = runCli, privateFile = false) {
    const outputPath = privateFile ? join(await dir(), 'waitlist-result.json') : undefined
    const result = await run(
      ['book', '--input', '-', ...(outputPath ? ['--output', outputPath] : [])],
      { handle: 'host', slug: 'intro', waitlistToken, idempotencyKey: 'waitlist-test-key' },
      { runner, fetch: async () => response({ nested: { message: `echo ${waitlistToken}` } }) },
    )
    expect(result.code).toBe(0)
    const printed = outputPath ? await readFile(outputPath, 'utf8') : result.stdout
    expect(printed.includes(waitlistToken)).toBe(false)
    expect(JSON.parse(printed).nested.message).toBe('echo [redacted]')
  }
  it('accepts waitlist attribution only through JSON and redacts echoed capabilities', async () => {
    await verifyWaitlistPrivacy()
    await verifyWaitlistPrivacy(runCli, true)
    const result = await run(['book', '--waitlist-token', waitlistToken])
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
    expect(result.stderr.includes(waitlistToken)).toBe(false)
  })
  it.each([false, true])(
    'kills removed waitlist capability privacy in privateFile=%s',
    async (privateFile) => {
      const change: readonly [string, string] = privateFile
        ? ['[key, oneTimeToken, waitlistToken]', '[key, oneTimeToken]']
        : ['secrets.push(input.waitlistToken)', '']
      await verifyWaitlistPrivacy(sourceCopy(), privateFile)
      await expect(verifyWaitlistPrivacy(sourceCopy(change), privateFile)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
  const oneTimeToken = 'synthetic_one_time_capability_sentinel_1234'
  async function verifyOneTimePrivacy(runner = runCli, privateFile = false) {
    const outputPath = privateFile ? join(await dir(), 'one-time-result.json') : undefined
    const args = ['book', '--input', '-', ...(outputPath ? ['--output', outputPath] : [])]
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const sent = JSON.parse(String(init?.body)).params.arguments
      expect(sent.oneTimeToken === oneTimeToken).toBe(true)
      return response({ replayed: true, nested: { note: `echo ${oneTimeToken}` } })
    })
    const result = await run(
      args,
      { oneTimeToken, idempotencyKey: 'one-time-test-key' },
      { runner, fetch: fetcher },
    )
    expect(result.code).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const printable = outputPath ? await readFile(outputPath, 'utf8') : result.stdout
    expect(printable.includes(oneTimeToken)).toBe(false)
    expect(JSON.parse(printable).nested.note).toBe('echo [redacted]')
  }
  async function verifyOneTimeRejection(runner = runCli, mixed = false) {
    for (const extra of mixed
      ? [{ handle: 'host' }, { teamSlug: 'team' }, { slug: 'event' }]
      : [{ oneTimeToken: 'bad' }, { oneTimeToken: 42 }]) {
      const result = await run(
        ['book', '--input', '-'],
        { oneTimeToken, idempotencyKey: 'one-time-test-key', ...extra },
        { runner },
      )
      expect(result.code).toBe(1)
      expect(result.fetcher).not.toHaveBeenCalled()
      expect(result.stderr.includes(oneTimeToken)).toBe(false)
    }
  }
  it('consumes one-time links through JSON input and redacts echoed capabilities', () =>
    verifyOneTimePrivacy())
  it('redacts a supplied one-time capability even from private output files', () =>
    verifyOneTimePrivacy(runCli, true))
  it('rejects malformed one-time capabilities before any request', () => verifyOneTimeRejection())
  it('rejects mixed one-time and public namespaces before any request', () =>
    verifyOneTimeRejection(runCli, true))
  it('rejects one-time capability command-line flags without echo', async () => {
    const result = await run(['book', '--one-time-token', oneTimeToken])
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
    expect(result.stderr.includes(oneTimeToken)).toBe(false)
  })
  async function verifyOneTimeCommand(runner = runCli) {
    const result = await run(['slots', '--input', '-'], { oneTimeToken }, { runner })
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
  }
  it('restricts one-time capabilities to booking commands', () => verifyOneTimeCommand())
  it('exercises unchanged one-time CLI source copies', async () => {
    await verifyOneTimePrivacy(sourceCopy())
    await verifyOneTimePrivacy(sourceCopy(), true)
    await verifyOneTimeRejection(sourceCopy())
    await verifyOneTimeRejection(sourceCopy(), true)
  })
  it.each<[string, readonly [string, string], (runner: typeof runCli) => Promise<void>]>([
    ['booking command restriction', ["args.command !== 'book' ||", ''], verifyOneTimeCommand],
    ['stdout capability redaction', ['secrets.push(input.oneTimeToken)', ''], verifyOneTimePrivacy],
    [
      'private file capability redaction',
      ['[key, oneTimeToken, waitlistToken]', '[key, waitlistToken]'],
      (runner) => verifyOneTimePrivacy(runner, true),
    ],
    [
      'capability shape validation',
      ['!/^[A-Za-z0-9_-]{43}$/.test(input.oneTimeToken)', 'false'],
      (runner) => verifyOneTimeRejection(runner),
    ],
    [
      'exclusive namespace validation',
      ["['handle', 'teamSlug', 'slug'].some((field) => Object.hasOwn(input, field))", 'false'],
      (runner) => verifyOneTimeRejection(runner, true),
    ],
  ])('kills removed one-time %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifyEventTypeWrite(runner: typeof runCli, update: boolean) {
    const command = update ? 'update-event' : 'create-event'
    const input = {
      ...(update
        ? { id: '12345678-1234-4123-8123-123456789abc' }
        : { slug: 'intro', title: 'Intro' }),
      durationMinutes: 30,
      allowedDurationsMinutes: [15, 30, 60],
    }
    const result = await run([command, '--input', '-'], input, { runner })
    expect(result.code).toBe(0)
    const init = (result.fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).params).toMatchObject({
      name: update ? 'update_event_type' : 'create_event_type',
      arguments: input,
    })
  }
  it.each([false, true])(
    'forwards all event type duration settings for update=%s',
    async (update) => {
      await verifyEventTypeWrite(runCli, update)
      await verifyEventTypeWrite(sourceCopy(), update)
    },
  )

  async function verifyRedirectFlags(runner = runCli) {
    for (const command of ['create-event', 'update-event']) {
      const redirect = {
        url: 'https://target.example/thanks?from=calendar#done',
        parameters: ['eventTypeSlug', 'start', 'inviteeName', 'inviteeEmail'],
        includeInviteePersonalData: true,
        allowEmbedParent: false,
      }
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const sent = JSON.parse(String(init?.body)).params.arguments
        expect(sent.successRedirect).toEqual(redirect)
        return response({ id: 'event-id', successRedirect: sent.successRedirect })
      })
      const result = await run(
        [
          command,
          '--success-redirect-url',
          redirect.url,
          '--success-redirect-parameters',
          redirect.parameters.join(','),
          '--success-redirect-include-invitee-personal-data',
          'true',
          '--success-redirect-allow-embed-parent',
          'false',
        ],
        undefined,
        { runner, fetch: fetcher },
      )
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).successRedirect).toEqual(redirect)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  }

  async function verifyRedirectClear(runner = runCli) {
    const result = await run(['update-event', '--clear-success-redirect'], undefined, { runner })
    expect(result.code).toBe(0)
    const init = (result.fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).params.arguments).toEqual({ successRedirect: null })
  }

  async function verifyRedirectConflict(runner = runCli) {
    const result = await run(
      ['update-event', '--input', '-', '--success-redirect-url', 'https://new.example'],
      { successRedirect: { url: 'https://saved.example' } },
      { runner },
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('invalid_success_redirect_options')
    expect(result.fetcher).not.toHaveBeenCalled()
  }

  async function verifyRedirectRejection(runner: typeof runCli, argv: string[], input?: unknown) {
    const result = await run(argv, input, { runner })
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
  }

  it('round-trips all after-booking flags through existing event-type write tools', () =>
    verifyRedirectFlags())
  it('clears the redirect explicitly without needing an input file', () => verifyRedirectClear())
  it('rejects conflicting JSON settings before making a write', () => verifyRedirectConflict())
  it('merges matching JSON and flags and supports an empty parameter list', async () => {
    const result = await run(
      [
        'update-event',
        '--input',
        '-',
        '--success-redirect-url',
        'https://target.example',
        '--success-redirect-parameters',
        '',
        '--success-redirect-include-invitee-personal-data',
        'false',
      ],
      {
        id: 'event-id',
        successRedirect: { url: 'https://target.example', allowEmbedParent: true },
      },
    )
    expect(result.code).toBe(0)
    const init = (result.fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).params.arguments).toEqual({
      id: 'event-id',
      successRedirect: {
        url: 'https://target.example',
        parameters: [],
        includeInviteePersonalData: false,
        allowEmbedParent: true,
      },
    })
  })
  it('round-trips JSON configuration, null and event reads without injecting untouched settings', async () => {
    for (const command of ['create-event', 'update-event', 'event']) {
      for (const input of [
        { id: 'event-id' },
        { successRedirect: null },
        {
          successRedirect: {
            url: 'https://target.example',
            parameters: ['hostName'],
            allowEmbedParent: true,
          },
        },
      ]) {
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
          expect(JSON.parse(String(init?.body)).params.arguments).toEqual(input)
          return response(input)
        })
        const result = await run([command, '--input', '-'], input, { fetch: fetcher })
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(input)
      }
    }
  })
  it('leaves URL and parameter policy validation to the service', async () => {
    const result = await run([
      'update-event',
      '--success-redirect-url',
      'http://localhost',
      '--success-redirect-parameters',
      'unknown,unknown',
    ])
    expect(result.code).toBe(0)
    const init = (result.fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).params.arguments.successRedirect).toEqual({
      url: 'http://localhost',
      parameters: ['unknown', 'unknown'],
    })
  })
  it.each([
    ['event', '--success-redirect-url', 'https://target.example'],
    ['book', '--clear-success-redirect'],
    ['update-event', '--clear-success-redirect', 'false'],
    [
      'update-event',
      '--clear-success-redirect',
      '--success-redirect-url',
      'https://target.example',
    ],
    ['update-event', '--clear-success-redirect', '--clear-success-redirect'],
    [
      'update-event',
      '--success-redirect-url',
      'https://target.example',
      '--success-redirect-url',
      'https://target.example',
    ],
    ['update-event', '--success-redirect-allow-embed-parent', 'yes'],
    ['update-event', '--success-redirect-include-invitee-personal-data', '1'],
  ])('rejects invalid after-booking options %j', (...argv) => verifyRedirectRejection(runCli, argv))
  it.each([null, false, 'invalid'])('refuses redirect flags over JSON %j', (successRedirect) =>
    verifyRedirectRejection(
      runCli,
      ['update-event', '--input', '-', '--success-redirect-url', 'https://target.example'],
      { successRedirect },
    ),
  )
  it('refuses a clear flag that conflicts with JSON configuration', () =>
    verifyRedirectRejection(runCli, ['update-event', '--input', '-', '--clear-success-redirect'], {
      successRedirect: { url: 'https://target.example' },
    }))
  it('exercises unchanged after-booking source copies before mutation controls', async () => {
    await verifyRedirectFlags(sourceCopy())
    await verifyRedirectClear(sourceCopy())
    await verifyRedirectConflict(sourceCopy())
  })
  it.each<[string, readonly [string, string], (runner: typeof runCli) => Promise<void>]>([
    ['flag forwarding', ['input.successRedirect = redirect', ''], verifyRedirectFlags],
    ['explicit clearing', ['input.successRedirect = null', ''], verifyRedirectClear],
    [
      'JSON conflict guard',
      ['JSON.stringify(redirect[field]) !== JSON.stringify(value)', 'false'],
      verifyRedirectConflict,
    ],
    [
      'event command restriction',
      ["redirectFlag && !['create-event', 'update-event'].includes(command)", 'false'],
      (runner) =>
        verifyRedirectRejection(runner, [
          'event',
          '--success-redirect-url',
          'https://target.example',
        ]),
    ],
    [
      'clear and configuration exclusivity',
      ['options.clearSuccessRedirect && options.successRedirect', 'false'],
      (runner) =>
        verifyRedirectRejection(runner, [
          'update-event',
          '--clear-success-redirect',
          '--success-redirect-url',
          'https://target.example',
        ]),
    ],
    [
      'boolean syntax',
      ["value !== 'true' && value !== 'false'", 'false'],
      (runner) =>
        verifyRedirectRejection(runner, [
          'update-event',
          '--success-redirect-allow-embed-parent',
          'yes',
        ]),
    ],
    [
      'JSON object guard',
      ["Object.hasOwn(input, 'successRedirect') && !isObject(input.successRedirect)", 'false'],
      (runner) =>
        verifyRedirectRejection(
          runner,
          ['update-event', '--input', '-', '--success-redirect-url', 'https://target.example'],
          { successRedirect: null },
        ),
    ],
    [
      'clear JSON conflict guard',
      ["Object.hasOwn(input, 'successRedirect') && input.successRedirect !== null", 'false'],
      (runner) =>
        verifyRedirectRejection(
          runner,
          ['update-event', '--input', '-', '--clear-success-redirect'],
          { successRedirect: { url: 'https://target.example' } },
        ),
    ],
  ])(
    'kills removed after-booking %s with a real assertion failure',
    async (_name, change, verify) => {
      await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  const redirectFields = [
    'successRedirect',
    'successRedirect.url',
    'successRedirect.parameters',
    'successRedirect.includeInviteePersonalData',
    'successRedirect.allowEmbedParent',
  ]
  const redirectError = (field: string, error = 'invalid_success_redirect') =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error,
              field,
              message: 'untrusted server text https://private.example/?email=private@example.test',
            }),
          },
        ],
      },
    })
  async function verifyRedirectField(runner = runCli) {
    for (const field of redirectFields) {
      const result = await run(['update-event'], undefined, {
        runner,
        fetch: vi.fn<typeof fetch>(async () => redirectError(field)),
      })
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr)).toEqual({
        error: 'invalid_success_redirect',
        field,
        outcomeMayBeUnknown: true,
      })
      expect(result.stderr).not.toContain('private.example')
    }
  }
  it('reports only stable redirect error fields, with no arbitrary server messages', () =>
    verifyRedirectField())
  it('kills removed stable error field forwarding', async () => {
    await expect(
      verifyRedirectField(sourceCopy(['error.field !== undefined', 'false'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function verifyFieldFilter(caller = callTool) {
    for (const [field, error, expected] of [
      ['successRedirect.url', 'invalid_request', 'successRedirect.url'],
      ['successRedirect.parameters', 'invalid_success_redirect', 'successRedirect.parameters'],
      ['https://private.example', 'invalid_success_redirect', undefined],
      ['successRedirect.url', 'insufficient_scope', undefined],
    ] as const) {
      await expect(
        caller({
          url: new URL('https://hourmere.example/mcp'),
          key: KEY,
          tool: 'update_event_type',
          input: {},
          fetch: vi.fn<typeof fetch>(async () => redirectError(field, error)),
        }),
      ).rejects.toMatchObject({ field: expected })
    }
  }
  it('filters redirect fields by error code and a fixed safe field list', async () => {
    await verifyFieldFilter()
    await verifyFieldFilter(clientSourceCopy())
  })
  it.each([
    ["if (!['invalid_request', 'invalid_success_redirect'].includes(code)) return undefined", ''],
    ['    ].includes(value)', '    ].includes(value) || true'],
  ] as const)('kills removed client redirect field filter %j', async (before, after) => {
    await expect(verifyFieldFilter(clientSourceCopy([before, after]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  it.each([false, true])(
    'detects a retargeted event type write alias for update=%s',
    async (update) => {
      const command = update ? 'update-event' : 'create-event'
      const tool = update ? 'update_event_type' : 'create_event_type'
      await expect(
        verifyEventTypeWrite(
          sourceCopy([`'${command}': '${tool}'`, `'${command}': 'get_event_type'`]),
          update,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  async function verifyDurationForwarding(runner = runCli) {
    for (const command of ['slots', 'book', 'reschedule']) {
      const input = { idempotencyKey: 'duration-test-key' }
      const result = await run([command, '--input', '-', '--duration-minutes', '60'], input, {
        runner,
      })
      expect(result.code).toBe(0)
      const init = (result.fetcher as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls[0]?.[1]
      expect(JSON.parse(String(init?.body)).params.arguments).toEqual({
        ...input,
        durationMinutes: 60,
      })
    }
  }

  async function verifyDurationRejection(
    runner: typeof runCli,
    command: string,
    value: string,
    input: Record<string, unknown> = {},
    error?: string,
  ) {
    const result = await run([command, '--input', '-', '--duration-minutes', value], input, {
      runner,
    })
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
    if (error) expect(JSON.parse(result.stderr).error).toBe(error)
  }

  async function verifyInvalidDurationRequest(runner = runCli, value = '1441') {
    for (const command of ['slots', 'book', 'reschedule']) {
      await verifyDurationRejection(runner, command, value, {}, 'invalid_request')
    }
  }

  it('forwards the duration option on slots, booking and rescheduling', async () => {
    await verifyDurationForwarding()
  })

  it.each(['0', '1441', '1.5', '30min', '1e2', 'Infinity', 'NaN', ' 30', '999999999999999999'])(
    'reports invalid_request for duration option %s before a request',
    async (value) => {
      await verifyInvalidDurationRequest(runCli, value)
    },
  )

  it.each(['slots', 'book', 'reschedule'])(
    'preserves invalid_duration from the server for a disallowed %s length',
    async (command) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_duration' }) }],
          },
        }),
      )
      const result = await run(
        [command, '--input', '-', '--duration-minutes', '60'],
        { idempotencyKey: 'duration-test-key' },
        { fetch: fetcher },
      )
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr).error).toBe('invalid_duration')
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it('allows a matching JSON selection and refuses a conflicting option', async () => {
    const accepted = await run(['slots', '--input', '-', '--duration-minutes', '30'], {
      durationMinutes: 30,
    })
    expect(accepted.code).toBe(0)
    for (const durationMinutes of [15, '30', null]) {
      await verifyDurationRejection(runCli, 'slots', '30', { durationMinutes })
    }
  })

  it('restricts duration options to the three booking commands and refuses duplicates', async () => {
    await verifyDurationRejection(runCli, 'cancel', '30')
    const result = await run(['slots', '--duration-minutes', '30', '--duration-minutes', '30'])
    expect(result.code).toBe(1)
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it('exercises an unchanged CLI source copy before its negative controls', async () => {
    const runner = sourceCopy()
    await verifyDurationForwarding(runner)
    await verifyInvalidDurationRequest(runner)
    await verifyDurationRejection(runner, 'slots', '1441')
    await verifyDurationRejection(runner, 'cancel', '30')
    await verifyDurationRejection(runner, 'slots', '30', { durationMinutes: 15 })
  })

  it.each<[string, readonly [string, string], (runner: typeof runCli) => Promise<void>]>([
    [
      'duration option forwarding',
      ['      input.durationMinutes = args.durationMinutes', ''],
      verifyDurationForwarding,
    ],
    [
      'invalid duration request error code',
      ["throw new CliError('invalid_request')", "throw new CliError('invalid_duration')"],
      verifyInvalidDurationRequest,
    ],
    [
      'duration lower bound',
      ['durationMinutes < 1', 'durationMinutes < 0'],
      (runner) => verifyDurationRejection(runner, 'slots', '0'),
    ],
    [
      'duration upper bound',
      ['durationMinutes > 1440', 'durationMinutes > 9999'],
      (runner) => verifyDurationRejection(runner, 'slots', '1441'),
    ],
    [
      'whole-minute duration syntax',
      ['!/^[0-9]+$/.test(value)', 'false'],
      (runner) => verifyDurationRejection(runner, 'slots', '1.5'),
    ],
    [
      'duration command restriction',
      ["!['slots', 'book', 'reschedule'].includes(command)", 'false'],
      (runner) => verifyDurationRejection(runner, 'cancel', '30'),
    ],
    [
      'conflicting JSON selection guard',
      [
        "Object.hasOwn(input, 'durationMinutes') && input.durationMinutes !== args.durationMinutes",
        'false',
      ],
      (runner) => verifyDurationRejection(runner, 'slots', '30', { durationMinutes: 15 }),
    ],
  ])('detects removal of %s with a real assertion failure', async (_name, change, verify) => {
    await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('runs the actual Node entrypoint without credentials', () => {
    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./index.ts', import.meta.url)), '--help'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    )
    expect(stdout).toContain('Commands: whoami')
    expect(stdout.includes(KEY)).toBe(false)
  })
  it.each([
    ['whoami', 'whoami'],
    ['profile', 'get_profile'],
    ['catalog', 'list_event_types'],
    ['event', 'get_event_type'],
    ['create-event', 'create_event_type'],
    ['update-event', 'update_event_type'],
    ['set-event-notifications', 'set_event_type_notifications'],
    ['schedules', 'list_schedules'],
    ['schedule', 'get_schedule'],
    ['schedule-availability', 'get_schedule_availability'],
    ['save-availability', 'save_schedule_availability'],
    ['slots', 'find_available_slots'],
    ['book', 'create_booking'],
    ['list', 'list_bookings'],
    ['reschedule', 'reschedule_booking'],
    ['cancel', 'cancel_booking'],
    ['retry-meeting', 'retry_conference'],
    ['retry-calendar-copy', 'retry_calendar_copy'],
  ])(
    'maps %s to the existing %s tool and sends one authenticated request',
    async (command, tool) => {
      const input = command === 'book' ? { idempotencyKey: 'random-test-key' } : { limit: 7 }
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe('https://hourmere.example/mcp')
        expect(init?.redirect).toBe('error')
        expect(init?.credentials).toBe('omit')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization') === `Bearer ${KEY}`).toBe(true)
        expect(headers.has('cookie')).toBe(false)
        expect(headers.has('origin')).toBe(false)
        expect(headers.get('Mcp-Method')).toBe('tools/call')
        expect(headers.get('Mcp-Name')).toBe(tool)
        expect(headers.get('MCP-Protocol-Version')).toBe('2026-07-28')
        const body = JSON.parse(String(init?.body))
        expect(body.id).toBe(1)
        expect(body.method).toBe('tools/call')
        expect(body.params.name).toBe(tool)
        expect(body.params.arguments).toEqual(input)
        expect(body.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
        return response({ data: [], nextAfter: null })
      })
      const result = await run([command, '--input', '-'], input, { fetch: fetcher })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ data: [], nextAfter: null })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it.each([[], ['--help']].map((argv) => ({ argv })))(
    'shows help without credentials or network',
    async ({ argv }) => {
      const result = await run(argv, undefined, { env: {} })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('Commands:')
      expect(result.fetcher).not.toHaveBeenCalled()
    },
  )

  it('shows the package version without credentials, stdin or network', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const result = await run(['--version'], undefined, { env: {} })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${manifest.version}\n`)
    expect(result.stderr).toBe('')
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it.each(
    [
      ['__proto__'],
      ['constructor'],
      ['toString'],
      ['unknown'],
      ['--help', 'whoami'],
      ['whoami', '--key', 'secret'],
      ['whoami', '--url'],
      ['whoami', '--input', '--output'],
      ['whoami', '--url', 'https://one.example', '--url', 'https://two.example'],
      ['whoami', 'unexpected'],
    ].map((argv) => ({ argv })),
  )('rejects invalid argv without echo or request', async ({ argv }) => {
    const result = await run(argv)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.fetcher).not.toHaveBeenCalled()
    expect(result.stderr).not.toContain('secret')
  })

  it.each([
    '',
    'http://hourmere.example',
    'file:///tmp/x',
    'https://user:pass@hourmere.example',
    'https://hourmere.example/api',
    'https://hourmere.example/?key=secret',
    'https://hourmere.example/#secret',
    'http://localhost.evil.example',
  ])('refuses unsafe configured URLs without echo: %s', async (url) => {
    const result = await run(['whoami'], undefined, { env: { ...env, HOURMERE_URL: url } })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('invalid_url')
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost:4187',
    'http://127.0.0.1:4187',
    'http://[::1]:4187',
    'https://hourmere.example/',
  ])('accepts %s', (url) => {
    expect(endpoint(url).pathname).toBe('/mcp')
  })

  it.each(['', 'not-a-key', 'hm_space key', 'hm_bad\nheader'])(
    'rejects malformed credentials',
    async (key) => {
      const result = await run(['whoami'], undefined, { env: { ...env, HOURMERE_API_KEY: key } })
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr).error).toBe('invalid_api_key')
      expect(result.fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['[]', 'null', '"text"', '{invalid', ' '.repeat(MAX_INPUT_BYTES + 1)])(
    'rejects malformed or oversized stdin without echo',
    async (raw) => {
      const result = await run(['book', '--input', '-'], undefined, { raw })
      expect(result.code).toBe(1)
      expect(result.fetcher).not.toHaveBeenCalled()
    },
  )

  it('requires a caller-retained idempotency key before booking', async () => {
    for (const input of [{}, { idempotencyKey: '' }, { idempotencyKey: 'bad\nkey' }]) {
      const result = await run(['book', '--input', '-'], input)
      expect(JSON.parse(result.stderr).error).toBe('idempotency_key_required')
      expect(result.fetcher).not.toHaveBeenCalled()
    }
  })

  it.each(['error', '', 'x'.repeat(44), 42])(
    'rejects malformed management tokens locally',
    async (manageToken) => {
      const result = await run(['cancel', '--input', '-'], { manageToken })
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr).error).toBe('invalid_manage_token')
      expect(result.fetcher).not.toHaveBeenCalled()
    },
  )

  it('reads JSON files, but refuses missing files, symlinks, directories and oversized files', async () => {
    const root = await dir()
    const path = join(root, 'input.json')
    await writeFile(path, '{"after":"opaque-cursor"}')
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).params.arguments).toEqual({ after: 'opaque-cursor' })
      return response()
    })
    expect((await run(['catalog', '--input', path], undefined, { fetch: fetcher })).code).toBe(0)
    await symlink(path, join(root, 'link'))
    await writeFile(join(root, 'large'), 'x'.repeat(MAX_INPUT_BYTES + 1))
    for (const input of [root, join(root, 'absent'), join(root, 'link'), join(root, 'large')]) {
      const result = await run(['catalog', '--input', input])
      expect(result.code).toBe(1)
      expect(result.fetcher).not.toHaveBeenCalled()
    }
  })

  it('redacts returned and supplied management capabilities throughout stdout', async () => {
    const result = await run(
      ['reschedule', '--input', '-'],
      { manageToken: TOKEN, start: '2026-11-02T08:00:00Z' },
      {
        fetch: async () =>
          response({ manageToken: TOKEN, booking: { note: `prefix ${TOKEN} ${KEY}` } }),
      },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).manageToken).toBe('[redacted]')
  })

  it('redacts a newly returned booking capability at the top level and inside nested text', async () => {
    const returnedToken = 'returned_management_capability_only_here_x'
    const result = await run(
      ['book', '--input', '-'],
      { idempotencyKey: 'random-test-key' },
      {
        fetch: async () =>
          response({
            manageToken: returnedToken,
            booking: { note: `nested ${returnedToken}` },
          }),
      },
    )
    expect(result.code).toBe(0)
    expect(result.stdout.includes(returnedToken)).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({
      manageToken: '[redacted]',
      booking: { note: 'nested [redacted]' },
    })
  })

  it('creates a private, exclusive capability file and gives stdout only a receipt', async () => {
    const path = join(await dir(), 'booking.json')
    const result = await run(
      ['book', '--input', '-', '--output', path],
      { idempotencyKey: 'random-test-key' },
      {
        fetch: async () => response({ manageToken: TOKEN, reflectedKey: KEY }),
      },
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ outputWritten: true })
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.manageToken === TOKEN).toBe(true)
    expect(saved.reflectedKey.includes(KEY)).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const again = await run(['book', '--input', '-', '--output', path], {
      idempotencyKey: 'random-test-key',
    })
    expect(again.code).toBe(1)
    expect(again.fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path, 'utf8')).manageToken === TOKEN).toBe(true)
  })

  it('reports known tool errors without server text or secrets and never retries', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'slot_taken', message: `${TOKEN} ${KEY}` }),
            },
          ],
        },
      }),
    )
    const result = await run(
      ['book', '--input', '-'],
      { idempotencyKey: 'random-test-key' },
      { fetch: fetcher },
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('slot_taken')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('redacts server error codes that happen to repeat credentials', async () => {
    const result = await run(['whoami'], undefined, {
      fetch: async () => Response.json({ error: KEY }, { status: 401 }),
    })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('[redacted]')
  })

  it.each([
    { name: 'empty', value: '' },
    { name: 'uppercase', value: 'Unsafe_code' },
    { name: 'digit-prefixed', value: '1unsafe_code' },
    { name: 'punctuated', value: 'unsafe-code' },
    { name: 'control-bearing', value: 'unsafe\u001b[31mcode' },
    { name: 'overlong', value: 'x'.repeat(81) },
    { name: 'non-string', value: 42 },
  ])('replaces $name server error codes with a safe fallback', async ({ value }) => {
    for (const kind of ['http', 'tool'] as const) {
      const result = await run(['whoami'], undefined, {
        fetch: async () =>
          kind === 'http'
            ? Response.json({ error: value }, { status: 400 })
            : Response.json({
                jsonrpc: '2.0',
                id: 1,
                result: {
                  isError: true,
                  content: [{ type: 'text', text: JSON.stringify({ error: value }) }],
                },
              }),
      })
      expect(result.code).toBe(kind === 'http' ? 3 : 1)
      expect(JSON.parse(result.stderr).error).toBe(`${kind}_error`)
    }
  })

  it('keeps rate-limit guidance machine-readable', async () => {
    const result = await run(['list'], undefined, {
      fetch: async () =>
        Response.json(
          { error: 'rate_limited', message: KEY },
          { status: 429, headers: { 'retry-after': '17' } },
        ),
    })
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: 'rate_limited',
      status: 429,
      retryAfterSeconds: 17,
    })
  })

  it('preserves HTTP status for proxy errors without printing HTML', async () => {
    const result = await run(['whoami'], undefined, {
      fetch: async () =>
        new Response(`<p>${KEY}</p>`, { status: 502, headers: { 'content-type': 'text/html' } }),
    })
    expect(result.code).toBe(3)
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'http_error', status: 502 })
  })

  it('suppresses network exception details and does not retry mutations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(`${TOKEN} ${KEY}`)
    })
    const result = await run(
      ['reschedule', '--input', '-'],
      { manageToken: TOKEN },
      { fetch: fetcher },
    )
    expect(result.code).toBe(3)
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: 'request_failed',
      outcomeMayBeUnknown: true,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('parses JSON and CRLF/multiline SSE with notifications', async () => {
    const body =
      ': ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,\r\ndata: "result":{"structuredContent":{"ok":true}}}\r\n\r\n'
    const result = await run(['whoami'], undefined, {
      fetch: async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true })
  })

  it.each([
    { jsonrpc: '2.0', id: 2, result: { structuredContent: {} } },
    { jsonrpc: '1.0', id: 1, result: { structuredContent: {} } },
    { jsonrpc: '2.0', id: 1, error: { message: 'unsafe' } },
    { jsonrpc: '2.0', id: 1, result: { content: [] } },
    { jsonrpc: '2.0', id: 1, result: { isError: 'yes', structuredContent: {} } },
  ])('refuses malformed protocol envelopes', async (body) => {
    const result = await run(['whoami'], undefined, { fetch: async () => Response.json(body) })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('invalid_response')
  })

  it('bounds response reads, including a stream without Content-Length', async () => {
    const result = await run(['whoami'], undefined, {
      fetch: async () =>
        new Response('x'.repeat(8 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    expect(JSON.parse(result.stderr).error).toBe('response_too_large')
  })

  it('refuses a real HTTP redirect before a key reaches another listener', async () => {
    let forwarded = false
    const target = createServer((_req, res) => {
      forwarded = true
      res.end('{}')
    })
    const redirect = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetAddress}/mcp` })
      res.end()
    })
    servers.push(target, redirect)
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetAddress = (target.address() as { port: number }).port
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    const port = (redirect.address() as { port: number }).port
    await expect(
      callTool({ url: endpoint(`http://127.0.0.1:${port}`), key: KEY, tool: 'whoami', input: {} }),
    ).rejects.toBeInstanceOf(CliError)
    expect(forwarded).toBe(false)
  })
})
