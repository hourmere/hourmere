import { constants, readFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
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
  events: [
    'booking.attendee_no_show_changed',
    'booking.cancelled',
    'booking.created',
    'booking.reschedule_request_expired',
    'booking.reschedule_requested',
    'booking.rescheduled',
  ],
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
const rotateInput = { id: webhook.id }

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
  const rotation = argv[0] === 'webhooks' && argv[1] === 'rotate-secret'
  const fetcher = vi.fn<typeof fetch>(async () => {
    return (
      options.response ?? reply({ structuredContent: rotation ? { secret } : { webhook, secret } })
    )
  })
  const code = await (options.runner ?? runCli)({
    argv,
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: key },
    stdin: (async function* () {
      yield JSON.stringify(options.input ?? (rotation ? rotateInput : input))
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
const rotate = ['webhooks', 'rotate-secret', '--input', '-']
const secretCommands = [
  { action: 'create', argv: create },
  { action: 'rotate-secret', argv: rotate },
] as const

async function verifyNoImplicitOutput(argv: string[], runner = runCli) {
  const result = await run(argv, { runner })
  // Check the leak before exit status so the mutation demonstrates the privacy boundary.
  expect(result.stdout.includes(secret)).toBe(false)
  expect(result.stdout).toBe('')
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr).error).toBe('webhook_secret_output_required')
  expect(result.fetcher).not.toHaveBeenCalled()
}

function cliSourceCopy(
  removeOutputGuard?: (typeof secretCommands)[number]['action'],
): typeof runCli {
  let source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')
  if (removeOutputGuard) {
    const anchor = "['webhooks create', 'webhooks rotate-secret'].includes(command)"
    expect(source).toContain(anchor)
    source = source.replace(anchor, anchor.replace(`'webhooks ${removeOutputGuard}'`, "''"))
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
    expect(result.stdout).toContain(
      'webhooks rotate-secret --input FILE|- (--json | --output FILE)',
    )
    expect(result.stdout).toContain('webhooks deliveries --input FILE|- [--json]')
    const eventList = result.stdout.slice(
      result.stdout.indexOf('\nEvents: '),
      result.stdout.indexOf('\nAdding workflow.executed'),
    )
    for (const event of [...input.events, 'workflow.executed']) expect(eventList).toContain(event)
    expect(result.stdout).toContain(
      'Adding workflow.executed on create or update requires WORKFLOWS_ENABLED=true.',
    )
    expect(result.stdout).toContain('Without it, the server returns workflows_disabled (REST 404).')
    expect(result.stdout).toContain(
      'On create this takes precedence over webhooks_disabled (REST 409).',
    )
    expect(result.stdout).toContain(
      'Endpoint events and delivery eventType are open enums. Ignore unknown event kinds.',
    )
    expect(result.fetcher).not.toHaveBeenCalled()
  })

  it('takes a credential-bearing webhook destination through stdin and refuses it as an argument', async () => {
    const destination = `${input.url}?key=fixture-receiver-credential`
    const refused = await run([...create, '--json', '--webhook-url', destination])
    expect(refused.code).toBe(1)
    expect(refused.stdout).toBe('')
    expect(JSON.parse(refused.stderr)).toEqual({ error: 'invalid_options' })
    expect(refused.fetcher).not.toHaveBeenCalled()

    const args = { ...input, url: destination }
    const accepted = await run([...create, '--json'], { input: args })
    expect(accepted.code).toBe(0)
    expect(accepted.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(accepted.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'create_webhook',
      arguments: args,
    })
  })

  it('lists known and future webhook kinds in JSON without signing secrets', async () => {
    const endpoint = {
      ...webhook,
      events: [...webhook.events, 'workflow.executed', 'workflow.future'],
    }
    const result = await run(['webhooks', 'list', '--json'], {
      response: reply({ structuredContent: { data: [endpoint] } }),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.includes(secret)).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({ data: [endpoint] })
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

  it('rotates once and returns only the new secret to explicitly requested JSON stdout', async () => {
    const result = await run([...rotate, '--json'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.split(secret).length - 1).toBe(1)
    const response = JSON.parse(result.stdout)
    expect(Object.keys(response)).toEqual(['secret'])
    expect(response.secret === secret).toBe(true)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'rotate_webhook_secret',
      arguments: rotateInput,
    })
  })

  it('forwards the delivery cursor and preserves event types and booking UUIDs', async () => {
    const args = {
      id: webhook.id,
      after: '019a0000-0000-7000-8000-000000000003',
    }
    const delivery = {
      id: '019a0000-0000-7000-8000-000000000004',
      eventId: '019a0000-0000-7000-8000-000000000005',
      eventType: 'booking.created',
      bookingId: '019a0000-0000-7000-8000-000000000006',
      status: 'delivered',
      attempts: 1,
      httpStatus: 200,
      lastError: null,
      createdAt: webhook.createdAt,
      lastAttemptAt: webhook.createdAt,
      deliveredAt: webhook.createdAt,
    }
    const page = {
      data: [
        delivery,
        { ...delivery, id: '019a0000-0000-7000-8000-000000000007', eventType: 'workflow.executed' },
        { ...delivery, id: '019a0000-0000-7000-8000-000000000008', eventType: 'workflow.future' },
      ],
      nextAfter: null,
    }
    const result = await run(['webhooks', 'deliveries', '--input', '-', '--json'], {
      input: args,
      response: reply({ structuredContent: page }),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.includes(secret)).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual(page)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'list_webhook_deliveries',
      arguments: args,
    })
  })

  it('updates a webhook through the MCP tool and prints endpoint metadata', async () => {
    const patch = { id: webhook.id, events: input.events, isActive: true }
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

  it.each(secretCommands)(
    'webhooks $action reserves a new private file before the request',
    async ({ action, argv }) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-webhooks-cli-'))
      try {
        const existing = join(directory, 'existing.json')
        await writeFile(existing, '{}', { mode: 0o600 })
        const refused = await run([...argv, '--output', existing])
        expect(refused.code).toBe(1)
        expect(JSON.parse(refused.stderr).error).toBe('file_error')
        expect(refused.fetcher).not.toHaveBeenCalled()
        expect(await readFile(existing, 'utf8')).toBe('{}')

        const output = join(directory, 'result.json')
        const link = join(directory, 'link.json')
        await symlink(output, link)
        const refusedLink = await run([...argv, '--output', link])
        expect(refusedLink.code).toBe(1)
        expect(JSON.parse(refusedLink.stderr).error).toBe('file_error')
        expect(refusedLink.fetcher).not.toHaveBeenCalled()
        await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })

        const result = await run([...argv, '--output', output])
        expect(result.code).toBe(0)
        expect(result.fetcher).toHaveBeenCalledTimes(1)
        expect(result.stderr).toBe('')
        expect(result.stdout.includes(secret)).toBe(false)
        expect(JSON.parse(result.stdout)).toEqual({ outputWritten: true })
        expect((await stat(output)).mode & 0o777).toBe(0o600)
        const data = await readFile(output, 'utf8')
        expect(data.split(secret).length - 1).toBe(1)
        const response = JSON.parse(data)
        expect(response.secret === secret).toBe(true)
        if (action === 'create') expect(response.webhook).toEqual(webhook)
        else expect(Object.keys(response)).toEqual(['secret'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it.each(secretCommands)(
    'webhooks $action requires an explicit output before making a request',
    ({ argv }) => verifyNoImplicitOutput(argv),
  )

  it.each(secretCommands)(
    'detects default $action signing secret disclosure in a source copy with the output guard removed',
    async ({ action, argv }) => {
      await verifyNoImplicitOutput(argv, cliSourceCopy())
      await expectKilled(cliSourceCopy(action), (runner) => verifyNoImplicitOutput(argv, runner), {
        outcome: { actual: true, expected: false },
      })
    },
  )

  it.each(secretCommands)(
    'webhooks $action prints safe error codes and suppresses signing secrets in both tool and HTTP errors',
    async ({ argv }) => {
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
        const result = await run([...argv, '--json'], { response })
        expect(result.code).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(JSON.parse(result.stderr).error).toBe(expected)
        expect(result.fetcher).toHaveBeenCalledTimes(1)
      }
    },
  )

  it.each(secretCommands)(
    'webhooks $action handles asynchronous stdout failure without logging the secret or repeating the request',
    async ({ argv }) => {
      const result = await run([...argv, '--json'], {
        write: async () => {
          throw new Error(secret)
        },
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toEqual({
        error: 'output_failed',
        outcomeMayBeUnknown: true,
      })
      expect(result.fetcher).toHaveBeenCalledTimes(1)
    },
  )
})
