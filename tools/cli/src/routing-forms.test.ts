import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, HELP, runCli } from './cli.ts'

const commands = [
  ['list', 'list_routing_forms'],
  ['get', 'get_routing_form'],
  ['create', 'create_routing_form'],
  ['update', 'update_routing_form'],
  ['archive', 'archive_routing_form'],
] as const

async function run(command: string, disabled = false) {
  const input = { id: '019a0000-0000-7000-8000-000000000001', expectedRevision: 1 }
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: disabled
        ? {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'routing_forms_disabled' }) }],
          }
        : { structuredContent: { id: input.id, revision: 2 } },
    }),
  )
  const code = await runCli({
    argv: ['routing-forms', command, '--input', '-'],
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_routing_cli_test' },
    stdin: (async function* () {
      yield JSON.stringify(input)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  return { code, stdout, stderr, fetcher, input }
}

describe('routing form CLI configuration commands', () => {
  it.each(commands)('dispatches %s through the shared MCP adapter', async (command, tool) => {
    const result = await run(command)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ id: result.input.id, revision: 2 })
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: tool,
      arguments: result.input,
    })
  })

  it.each(commands)('prints the hard-off error for %s without retrying', async (command) => {
    const result = await run(command, true)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toBe('routing_forms_disabled')
    expect(result.fetcher).toHaveBeenCalledTimes(1)
  })

  it('advertises exactly the configuration commands', () => {
    expect(Object.keys(COMMANDS).filter((command) => command.startsWith('routing-forms '))).toEqual(
      commands.map(([command]) => `routing-forms ${command}`),
    )
    expect(HELP).toContain('routing-forms list|get|create|update|archive')
  })
})
