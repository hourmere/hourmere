import { constants, readFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const key = 'hm_webhooks_cli_fixture'
// A lowercase synthetic secret can pass the ordinary stable error code pattern.
const secret = `whsec_${'a'.repeat(43)}`
const input = {
  url: 'https://hooks.example.test/bookings',
  events: ['booking.created', 'booking.attendee_no_show_changed'],
  isActive: false,
}
const webhook = {
  ...input,
  id: '019a0000-0000-7000-8000-000000000001',
  organizationId: '019a0000-0000-7000-8000-000000000002',
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
}
const reply = (result: object) => Response.json({ jsonrpc: '2.0', id: 1, result })

async function run(
  argv: string[],
  options: {
    input?: object
    response?: Response
    runner?: typeof runCli
    write?: (text: string) => Promise<void>
  } = {},
) {
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(async () => {
    return options.response ?? reply({ structuredContent: { webhook, secret } })
  })
  const code = await (options.runner ?? runCli)({
    argv,
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: key },
    stdin: (async function* () {
      yield JSON.stringify(options.input ?? input)
    })(),
    stdout: async (text) => {
      await options.write?.(text)
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  expect((stdout + stderr).includes(key)).toBe(false)
  expect(stderr.includes(secret)).toBe(false)
  return { code, stdout, stderr, fetcher }
}

const create = ['webhooks', 'create', '--input', '-']

async function verifyNoImplicitOutput(runner = runCli) {
  const result = await run(create, { runner })
  // Check the leak before exit status so the mutation demonstrates the privacy boundary.
  expect(result.stdout.includes(secret)).toBe(false)
  expect(result.stdout).toBe('')
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr).error).toBe('webhook_secret_output_required')
  expect(result.fetcher).not.toHaveBeenCalled()
}

function cliSourceCopy(removeOutputGuard = false): typeof runCli {
  let source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
  if (removeOutputGuard) {
    const anchor = "command === 'webhooks create' && !seen.has('--json') && !options.output"
    expect(source).toContain(anchor)
    source = source.replace(anchor, 'false')
  }
  source = stripTypeScriptTypes(source.replace(/^import\b[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { constants, ...client, open, unlink }
  return guardCopy(
    new Function(...Object.keys(bindings), `${source}; return runCli`)(...Object.values(bindings)),
  ) as typeof runCli
}

describe('webhook CLI', () => {
  it('advertises the commands and explicit secret output choices', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('webhooks list')
    expect(result.stdout).toContain('webhooks create --input FILE|- (--json | --output FILE)')
    expect(result.stdout).toContain('webhooks update --input FILE|- [--json]')
    expect(result.stdout).toContain('webhooks delete --input FILE|- --yes [--json]')
    expect(result.stdout).toContain('booking.attendee_no_show_changed')
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it('lists webhook metadata as JSON without signing secrets', async () => {
    const result = await run(['webhooks', 'list', '--json'], {
      response: reply({ structuredContent: { data: [webhook] } }),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.includes(secret)).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({ data: [webhook] })
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'list_webhooks',
      arguments: {},
    })
  })

  it('returns the signing secret once to explicitly requested JSON stdout', async () => {
    const result = await run([...create, '--json'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.split(secret).length - 1).toBe(1)
    expect(JSON.parse(result.stdout).secret === secret).toBe(true)
    expect(JSON.parse(result.stdout).webhook).toEqual(webhook)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'create_webhook',
      arguments: input,
    })
  })

  it('updates a webhook through the MCP tool and prints endpoint metadata', async () => {
    const patch = { id: webhook.id, isActive: true }
    const updated = { ...webhook, isActive: true }
    const result = await run(['webhooks', 'update', '--input', '-', '--json'], {
      input: patch,
      response: reply({ structuredContent: updated }),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(updated)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'update_webhook',
      arguments: patch,
    })
  })

  it('requires an explicit delete flag before reading input or making a request', async () => {
    const result = await run(['webhooks', 'delete', '--input', '/unused', '--json'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ error: 'webhook_delete_confirmation_required' })
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it('keeps the confirmation flag local and returns the deletion result', async () => {
    const target = { id: webhook.id }
    const result = await run(['webhooks', 'delete', '--input', '-', '--yes', '--json'], {
      input: target,
      response: reply({ structuredContent: { deleted: true } }),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ deleted: true })
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'delete_webhook',
      arguments: target,
    })
  })

  it('writes the secret only to a new private file and refuses an existing file before creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-webhooks-cli-'))
    try {
      const existing = join(directory, 'existing.json')
      await writeFile(existing, '{}', { mode: 0o600 })
      const refused = await run([...create, '--output', existing])
      expect(refused.code).toBe(1)
      expect(JSON.parse(refused.stderr).error).toBe('file_error')
      expect(refused.fetcher).not.toHaveBeenCalled()
      expect(await readFile(existing, 'utf8')).toBe('{}')

      const output = join(directory, 'created.json')
      const result = await run([...create, '--output', output])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.includes(secret)).toBe(false)
      expect(JSON.parse(result.stdout)).toEqual({ outputWritten: true })
      expect((await stat(output)).mode & 0o777).toBe(0o600)
      const data = await readFile(output, 'utf8')
      expect(data.split(secret).length - 1).toBe(1)
      expect(JSON.parse(data).secret === secret).toBe(true)
      expect(JSON.parse(data).webhook).toEqual(webhook)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires an explicit creation output before making a request', () => verifyNoImplicitOutput())

  it('detects default signing secret disclosure in a source copy with the output guard removed', async () => {
    await verifyNoImplicitOutput(cliSourceCopy())
    await expectKilled(cliSourceCopy(true), verifyNoImplicitOutput, {
      outcome: { actual: true, expected: false },
    })
  })

  it('prints safe error codes and suppresses signing secrets in both tool and HTTP errors', async () => {
    const toolError = (error: string) =>
      reply({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error, message: secret }) }],
      })
    for (const [response, expected] of [
      [toolError('insufficient_scope'), 'insufficient_scope'],
      [toolError(secret), 'tool_error'],
      [Response.json({ error: secret }, { status: 503 }), 'http_error'],
    ] as const) {
      const result = await run([...create, '--json'], { response })
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr).error).toBe(expected)
      expect(result.fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('handles asynchronous stdout failure without logging the secret or repeating creation', async () => {
    const result = await run([...create, '--json'], {
      write: async () => {
        throw new Error(secret)
      },
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ error: 'output_failed', outcomeMayBeUnknown: true })
    expect(result.fetcher).toHaveBeenCalledTimes(1)
  })
})
