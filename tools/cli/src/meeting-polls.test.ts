import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'

const KEY = 'hm_synthetic_poll_key'
const TOKEN = 'synthetic_poll_input_capability'
const NEW_TOKEN = 'synthetic_poll_new_voting_capability'
const commands = [
  ['view', 'read_meeting_poll'],
  ['join', 'enroll_meeting_poll_voter'],
  ['recover', 'recover_meeting_poll_voter'],
  ['verify', 'verify_meeting_poll_voter'],
  ['vote', 'submit_meeting_poll_vote'],
  ['withdraw', 'withdraw_meeting_poll_vote'],
  ['reminder-opt-out', 'opt_out_meeting_poll_reminder'],
] as const
async function run(
  command: string,
  extra = ['--input', '-'],
  runner = runCli,
  result: Record<string, unknown> = { accepted: true, echoed: TOKEN },
) {
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: { structuredContent: result },
    }),
  )
  const status = await runner({
    argv: ['polls', command, ...extra],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: KEY },
    stdin: (async function* () {
      yield JSON.stringify({ token: TOKEN, publicToken: TOKEN })
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  expect(stdout + stderr).not.toContain(KEY)
  expect(stdout + stderr).not.toContain(TOKEN)
  return { status, stdout, stderr, fetcher }
}
describe('meeting poll CLI capabilities', () => {
  it.each(commands)(
    'dispatches polls %s from stdin and redacts echoed input secrets',
    async (command, tool) => {
      const result = await run(command)
      expect(result.status).toBe(0)
      expect(result.fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
        name: tool,
        arguments: { token: TOKEN, publicToken: TOKEN },
      })
    },
  )
  it.each(
    [
      [],
      ['--input', '/unused/poll.json'],
      ['--input', '-', '--output', '/unused/poll-output.json'],
    ].map((args) => ({ args })),
  )('requires stdin and refuses stored input/output before dispatch: $args', async ({ args }) => {
    const result = await run('verify', args)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('poll_stdin_required')
    expect(result.fetcher).not.toHaveBeenCalled()
  })
  it('never accepts a capability argument or includes it in diagnostics', async () => {
    const result = await run('view', ['--token', TOKEN])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('invalid_options')
    expect(result.fetcher).not.toHaveBeenCalled()
  })
  it('returns a newly minted verification credential once without storing a file', async () => {
    const result = await run('verify', undefined, undefined, { votingToken: NEW_TOKEN })
    expect(result.status).toBe(0)
    expect(result.stdout.split(NEW_TOKEN)).toHaveLength(2)
  })
  it('keeps error diagnostics opaque and never retries', async () => {
    const runner: typeof runCli = (options) =>
      runCli({
        ...options,
        fetch: async () =>
          Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'poll_closed', message: NEW_TOKEN }),
                },
              ],
            },
          }),
      })
    const result = await run('verify', undefined, runner)
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain(NEW_TOKEN)
    expect(JSON.parse(result.stderr).error).toBe('poll_closed')
  })
})
