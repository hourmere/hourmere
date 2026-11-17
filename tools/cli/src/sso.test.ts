import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'

const commands = [
  { args: ['sso', 'providers', 'list'], tool: 'list_sso_providers' },
  { args: ['sso', 'policy'], tool: 'get_sso_policy' },
]
async function run(argv: string[], fetcher: typeof fetch, input: object = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    argv: [...argv, '--input', '-'],
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_synthetic_sso' },
    stdin: (async function* () {
      yield JSON.stringify(input)
    })(),
    stdout: (value) => {
      stdout += value
    },
    stderr: (value) => {
      stderr += value
    },
    fetch: fetcher,
  })
  return { code, stdout, stderr }
}

describe('SSO read commands', () => {
  it.each(commands)(
    'dispatches $tool and preserves open response fields',
    async ({ args, tool }) => {
      const output = { futureField: { futureStatus: 'new_status' }, data: [], nextCursor: null }
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { structuredContent: output },
        }),
      )
      const input = tool === 'list_sso_providers' ? { cursor: 'opaque-cursor', limit: 5 } : {}
      const result = await run(args, fetcher, input)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(output)
      expect(result.stderr).toBe('')
      expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).params).toMatchObject({
        name: tool,
        arguments: input,
      })
    },
  )

  it.each(commands)('returns sso_disabled from $tool without output', async ({ args }) => {
    const result = await run(args, async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: '{"error":"sso_disabled"}' }] },
      }),
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'sso_disabled' })
  })

  it('rejects incomplete and unowned commands before sending credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const args of [
      ['sso'],
      ['sso', 'providers'],
      ['sso', 'providers', 'create'],
      ['sso', 'policy', 'set'],
    ]) {
      const result = await run(args, fetcher)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})
