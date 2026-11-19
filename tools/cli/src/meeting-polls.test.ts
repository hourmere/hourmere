import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'

const KEY = 'hm_synthetic_poll_key'
const TOKEN = 'synthetic_poll_input_capability'
const NEW_TOKEN = 'synthetic_poll_new_voting_capability'
const IDEMPOTENCY_KEY = 'synthetic_poll_idempotency_key'
const ID = '824c120f-17fc-47d5-9de1-a438ffefada0'
const SLOT_ID = '0771948d-5915-4576-8ede-4033b4d21a24'
const VOTER_ID = 'd4bbd56f-227f-4d9e-920c-c5bd2cd06e9c'
const hostWrite = { id: ID, expectedHostRevision: 3 }
const create = {
  eventTypeId: ID,
  candidateStarts: ['2026-11-20T09:00:00Z', '2026-11-20T09:30:00Z'],
  durationMinutes: 30,
  deadlineAt: '2026-11-19T17:00:00Z',
  displayTimeZone: 'UTC',
  admissionMode: 'public_link',
  visibility: 'private',
  idempotencyKey: IDEMPOTENCY_KEY,
}
const invite = {
  id: ID,
  invitees: [{ name: 'Voter', email: 'voter@example.test', locale: 'en' }],
  idempotencyKey: IDEMPOTENCY_KEY,
}
const rotate = { ...hostWrite, idempotencyKey: IDEMPOTENCY_KEY }
const finalize = {
  id: ID,
  slotId: SLOT_ID,
  bookerVoterId: VOTER_ID,
  attendeeVoterIds: [VOTER_ID],
  expectedResultsRevision: 7,
  expectedBallotRevisions: { [VOTER_ID]: 2 },
  acknowledgeConditional: true,
  idempotencyKey: IDEMPOTENCY_KEY,
}
const hostCommands = [
  ['create', 'create_meeting_poll', create],
  ['list', 'list_meeting_polls', { limit: 10, after: 'opaque-next-page' }],
  ['get', 'get_meeting_poll', { id: ID }],
  ['results', 'get_meeting_poll_results', { id: ID }],
  ['invite', 'invite_meeting_poll_voters', invite],
  [
    'resend-invitation',
    'resend_meeting_poll_invitation',
    { ...hostWrite, voterId: VOTER_ID, idempotencyKey: IDEMPOTENCY_KEY },
  ],
  ['remove-voter', 'remove_meeting_poll_voter', { ...hostWrite, voterId: VOTER_ID }],
  ['remove-unverified', 'remove_unverified_meeting_poll_voters', hostWrite],
  ['rotate-link', 'rotate_meeting_poll_link', rotate],
  ['close', 'close_meeting_poll', hostWrite],
  ['cancel', 'cancel_meeting_poll', hostWrite],
  ['delete', 'delete_meeting_poll', hostWrite],
  ['finalize', 'finalize_meeting_poll', finalize],
] as const
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
  input: Record<string, unknown> = { token: TOKEN, publicToken: TOKEN },
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

describe('meeting poll CLI host commands', () => {
  it.each(hostCommands)(
    'sends polls %s input unchanged from stdin',
    async (command, name, input) => {
      const result = await run(command, undefined, undefined, { ok: true }, input)
      expect(result.status).toBe(0)
      expect(result.fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
        name,
        arguments: input,
      })
    },
  )

  it.each([
    {
      command: 'finalize',
      input: finalize,
      flags: ['--idempotency-key', IDEMPOTENCY_KEY],
      code: 'invalid_options',
    },
    {
      command: 'create',
      input: create,
      flags: ['--idempotency-key', IDEMPOTENCY_KEY],
      code: 'invalid_options',
    },
    {
      command: 'invite',
      input: invite,
      flags: ['--input', IDEMPOTENCY_KEY],
      code: 'poll_stdin_required',
    },
    {
      command: 'rotate-link',
      input: rotate,
      flags: ['--input', '-', '--output', '/unused/poll-result.json'],
      code: 'poll_stdin_required',
    },
  ])(
    'refuses $command secrets outside stdin and rejects output files',
    async ({ command, input, flags, code }) => {
      const result = await run(command, flags, undefined, {}, input)
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stderr).error).toBe(code)
      expect(result.stderr.includes(IDEMPOTENCY_KEY)).toBe(false)
      expect(result.fetcher).not.toHaveBeenCalled()
    },
  )

  it('keeps echoed finalize keys and management capabilities out of results', async () => {
    const manageUrl = `https://example.test/m/${NEW_TOKEN}`
    const result = await run(
      'finalize',
      undefined,
      undefined,
      {
        echoed: IDEMPOTENCY_KEY,
        manageToken: NEW_TOKEN,
        manageUrl,
        booking: { id: ID, manageToken: NEW_TOKEN, manageUrl },
        replayed: false,
      },
      finalize,
    )
    expect(result.status).toBe(0)
    expect(result.stdout.includes(IDEMPOTENCY_KEY)).toBe(false)
    expect(result.stdout.includes(NEW_TOKEN)).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({
      echoed: '[redacted]',
      booking: { id: ID },
      replayed: false,
    })
  })

  it('redacts an echoed punctuation key without changing JSON or timestamps', async () => {
    const start = '2026-11-20T09:00:00Z'
    const result = await run(
      'finalize',
      undefined,
      undefined,
      { echoed: ':', booking: { start } },
      { ...finalize, idempotencyKey: ':' },
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ echoed: '[redacted]', booking: { start } })
  })

  it('keeps only the safe scheduled poll reference in a finalize conflict', async () => {
    const poll = {
      id: ID,
      bookingId: VOTER_ID,
      chosenSlotId: SLOT_ID,
      hostRevision: 3,
      status: 'scheduled',
    }
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
                  text: JSON.stringify({
                    error: 'poll_already_scheduled',
                    message: IDEMPOTENCY_KEY,
                    poll: { ...poll, manageToken: NEW_TOKEN, title: IDEMPOTENCY_KEY },
                  }),
                },
              ],
            },
          }),
      })
    const result = await run('finalize', undefined, runner, {}, finalize)
    expect(result.status).toBe(1)
    expect(result.stderr.includes(IDEMPOTENCY_KEY)).toBe(false)
    expect(result.stderr.includes(NEW_TOKEN)).toBe(false)
    expect(JSON.parse(result.stderr)).toEqual({
      error: 'poll_already_scheduled',
      poll,
      outcomeMayBeUnknown: true,
    })
  })

  it.each([
    ['create', create],
    ['rotate-link', rotate],
  ] as const)(
    'prints a newly issued link once on %s and redacts the request key',
    async (command, input) => {
      const publicLink = `https://example.test/poll#${NEW_TOKEN}`
      const result = await run(
        command,
        undefined,
        undefined,
        { publicLink, echoed: IDEMPOTENCY_KEY },
        input,
      )
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ publicLink, echoed: '[redacted]' })
      expect(result.stdout.split(NEW_TOKEN)).toHaveLength(2)
      expect(result.stderr).toBe('')
    },
  )

  it('passes invitation outcomes through without echoing an unexpected public link', async () => {
    const entries = [
      { email: 'voter@example.test', outcome: 'unchanged', voterId: VOTER_ID, status: 'invited' },
    ]
    const publicLink = `https://example.test/poll#${NEW_TOKEN}`
    const result = await run(
      'invite',
      undefined,
      undefined,
      { entries, replayed: true, publicLink },
      invite,
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ entries, replayed: true })
  })

  it.each([
    { command: 'create', input: create, detail: { error: 'poll_already_created', pollId: ID } },
    { command: 'create', input: create, detail: { error: 'poll_already_created', pollId: null } },
    {
      command: 'create',
      input: create,
      detail: { error: 'slot_unavailable', unavailableStarts: ['2026-11-20T09:00:00.123456Z'] },
    },
    { command: 'rotate-link', input: rotate, detail: { error: 'poll_link_already_rotated' } },
    { command: 'rotate-link', input: rotate, detail: { error: 'poll_link_unavailable' } },
    { command: 'invite', input: invite, detail: { error: 'rate_limited', retryAfterSeconds: 60 } },
  ])(
    'preserves safe details for $detail.error and discards secret diagnostics',
    async ({ command, input, detail }) => {
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
                    text: JSON.stringify({
                      ...detail,
                      message: IDEMPOTENCY_KEY,
                      publicLink: NEW_TOKEN,
                    }),
                  },
                ],
              },
            }),
        })
      const result = await run(command, undefined, runner, {}, input)
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toEqual({ ...detail, outcomeMayBeUnknown: true })
    },
  )
})
