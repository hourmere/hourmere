import '@hono/zod-openapi'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  DomainError,
  enrollMeetingPollVoter,
  type MeetingPollOwnBallot,
  readMeetingPoll,
  type VerifyMeetingPollVoterResult,
} from '@hourmere/scheduling'
import { createFixtures, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  meetingPollCapabilityDigest,
  openMeetingPollCredential,
} from '../../../../packages/scheduling/src/meeting-poll-voters.ts'
import { createMeetingPoll } from '../../../../packages/scheduling/src/meeting-polls.ts'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { enforceMeetingPollRateLimit } from '../meeting-poll-rate-limit.ts'
import { mcpEndpoint } from './endpoint.ts'
import { meetingPollTools } from './meeting-polls.ts'
import { type McpCaller, runTool, type Tool } from './tools.ts'

const secret = 'synthetic-meeting-poll-mcp-secret'
const sentinel = 'synthetic-private-meeting-poll-token'
const principal: McpCaller = {
  kind: 'api_key',
  apiKeyScope: 'full',
  apiKeyId: randomUUID(),
  user: { id: randomUUID(), name: 'Agent', email: 'agent@example.test' },
  organization: { id: randomUUID(), name: 'Other space', slug: 'other-space', personal: true },
}
const names = [
  'read_meeting_poll',
  'enroll_meeting_poll_voter',
  'recover_meeting_poll_voter',
  'verify_meeting_poll_voter',
  'submit_meeting_poll_vote',
  'withdraw_meeting_poll_vote',
  'opt_out_meeting_poll_reminder',
] as const
const find = (tools: Tool[], name: string) => {
  const tool = tools.find((tool) => tool.name === name)
  if (!tool) throw Error('Missing poll tool')
  return tool
}
function error(result: Awaited<ReturnType<typeof runTool>>) {
  expect(result.isError).toBe(true)
  const content = result.content[0]
  if (content?.type !== 'text') throw Error('Expected error text')
  return JSON.parse(content.text) as { error: string; retryAfterSeconds?: number }
}
const validInputs: Record<(typeof names)[number], Record<string, unknown>> = {
  read_meeting_poll: { token: sentinel },
  enroll_meeting_poll_voter: {
    publicToken: sentinel,
    name: 'Voter',
    email: 'voter@example.test',
    timeZone: 'UTC',
  },
  recover_meeting_poll_voter: { pollId: randomUUID(), email: 'voter@example.test' },
  verify_meeting_poll_voter: { token: sentinel },
  submit_meeting_poll_vote: {
    token: sentinel,
    votes: [],
    consent: true,
    expectedBallotRevision: 0,
  },
  withdraw_meeting_poll_vote: { token: sentinel, expectedBallotRevision: 0 },
  opt_out_meeting_poll_reminder: { token: sentinel },
}

describe('MCP poll privacy boundaries', () => {
  const tools = meetingPollTools({ db: {} as Db, meetingPollSecret: secret })
  it.each(names)('never emits private diagnostics for %s', async (name) => {
    const log = vi.fn()
    for (const thrown of [
      Error(sentinel),
      new DomainError('invalid', 'invalid_request', sentinel),
    ]) {
      const tool = {
        ...find(tools, name),
        run: async () => {
          throw thrown
        },
      }
      const result = await runTool(
        tool,
        validInputs[name],
        { caller: principal, rateLimit: () => {} },
        log,
      )
      expect(result.isError).toBe(true)
      expect(JSON.stringify([result, log.mock.calls])).not.toContain(sentinel)
    }
    const invalid = { ...validInputs[name], token: sentinel, unknown: sentinel }
    const result = await runTool(
      find(tools, name),
      invalid,
      { caller: principal, rateLimit: () => {} },
      log,
    )
    expect(error(result).error).toBe('invalid_request')
    expect(JSON.stringify([result, log.mock.calls])).not.toContain(sentinel)
  })
  it('hides a newly minted credential in failed output-validation diagnostics', async () => {
    const log = vi.fn()
    const tool = {
      ...find(tools, 'verify_meeting_poll_voter'),
      run: async () => ({ votingToken: sentinel }),
    }
    const result = await runTool(
      tool,
      { token: 'input-token' },
      { caller: principal, rateLimit: () => {} },
      log,
    )
    expect(error(result).error).toBe('internal_error')
    expect(JSON.stringify([result, log.mock.calls])).not.toContain(sentinel)
  })
  it.each(names.filter((name) => name !== 'read_meeting_poll'))(
    'refuses read keys before %s enters a service',
    async (name) => {
      const run = vi.fn(async () => ({}))
      const result = await runTool(
        { ...find(tools, name), run },
        validInputs[name],
        {
          caller: { ...principal, apiKeyScope: 'read' },
          rateLimit: () => {},
        },
        () => {},
      )
      expect(error(result).error).toBe('insufficient_scope')
      expect(run).not.toHaveBeenCalled()
    },
  )
})

describe.skipIf(!process.env.DATABASE_URL)('MCP and CLI poll services on Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let tools: Tool[]
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    tools = meetingPollTools({ db, meetingPollSecret: secret })
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function poll() {
    const fixtures = createFixtures(db)
    const host = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({
        user_id: host.id,
        time_zone: 'UTC',
        handle: `poll-${randomBytes(6).toString('hex')}`,
      })
      .execute()
    await fixtures.schedule(host.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const eventTypeId = await fixtures.eventType(host.principal.organization.id, host.id)
    const deadline = Temporal.Now.instant()
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    return createMeetingPoll(
      testContext(db, {
        kind: 'session',
        sessionId: randomUUID(),
        user: host.principal.user,
        organization: host.principal.organization,
      }),
      {
        eventTypeId,
        candidateStarts: [
          deadline.add({ hours: 24 }).toString(),
          deadline.add({ hours: 25 }).toString(),
        ],
        deadlineAt: deadline.toString(),
        displayTimeZone: 'UTC',
        admissionMode: 'public_link',
        visibility: 'aggregate',
        idempotencyKey: randomUUID(),
      },
    )
  }
  const call = (name: string, input: unknown, ip = '192.0.2.51', registry = tools) =>
    runTool(
      find(registry, name),
      input,
      { caller: principal, trustedIp: ip, rateLimit: () => {} },
      () => {},
    )
  async function mailToken(pollId: string) {
    const row = await db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .where('poll_id', '=', pollId)
      .where('purpose', '=', 'verification')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      secret,
      {
        organizationId: row.organization_id,
        pollId,
        voterId: row.voter_id,
        generation: row.generation,
      },
      row.capability_ciphertext,
    )
    expect(credential).not.toBeNull()
    return { token: credential?.token as string, row }
  }
  it('round-trips every public operation with capability authority, replay and safe projections', async () => {
    const p = await poll()
    const token = p.publicToken as string
    const read = await call('read_meeting_poll', { token })
    expect(read.isError).toBeFalsy()
    expect(read.structuredContent).toEqual(
      await readMeetingPoll({ db, meetingPollSecret: secret }, { token }),
    )
    expect(read.structuredContent).toMatchObject({ counts: null, ownBallot: null })
    const join = { publicToken: token, name: 'Voter', email: 'voter@example.test', timeZone: 'UTC' }
    const accepted = await call('enroll_meeting_poll_voter', join)
    expect(accepted.structuredContent).toEqual({ accepted: true })
    expect(await call('enroll_meeting_poll_voter', join)).toEqual(accepted)
    const mail = await mailToken(p.poll.id)
    const verified = await call('verify_meeting_poll_voter', { token: mail.token })
    expect(verified.isError).toBeFalsy()
    const state = verified.structuredContent as unknown as VerifyMeetingPollVoterResult
    expect(state.votingToken).toBeTypeOf('string')
    const voterToken = state.votingToken as string
    expect(
      (await call('verify_meeting_poll_voter', { token: mail.token })).structuredContent,
    ).toMatchObject({ votingToken: null })
    const input = {
      token: voterToken,
      votes: p.poll.candidates.map((slot) => ({ slotId: slot.id, value: 'yes' })),
      consent: true,
      expectedBallotRevision: 0,
    }
    const submitted = await call('submit_meeting_poll_vote', input)
    expect(submitted.isError).toBeFalsy()
    expect(submitted.structuredContent).toMatchObject({ ballotRevision: 1 })
    expect(error(await call('submit_meeting_poll_vote', input)).error).toBe('poll_changed')
    expect(
      (await call('read_meeting_poll', { token: voterToken })).structuredContent,
    ).toMatchObject({
      ownBallot: { ballotRevision: 1 },
      counts: p.poll.candidates.map((slot) => ({ slotId: slot.id, yes: 1, ifNeedBe: 0, no: 0 })),
    })
    expect(error(await call('opt_out_meeting_poll_reminder', { token: voterToken })).error).toBe(
      'poll_not_found',
    )
    const optOut = randomBytes(32).toString('base64url')
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: mail.row.organization_id,
        poll_id: p.poll.id,
        voter_id: mail.row.voter_id,
        purpose: 'reminder_opt_out',
        token_digest: meetingPollCapabilityDigest('reminder_opt_out', optOut),
        generation: 1,
        expires_at: p.poll.deadlineAt,
      })
      .execute()
    const optedOut = await call('opt_out_meeting_poll_reminder', { token: optOut })
    expect(optedOut.isError).toBeFalsy()
    expect(await call('opt_out_meeting_poll_reminder', { token: optOut })).toEqual(optedOut)
    const withdrawn = await call('withdraw_meeting_poll_vote', {
      token: voterToken,
      expectedBallotRevision: 1,
    })
    expect(withdrawn.structuredContent as unknown as MeetingPollOwnBallot).toMatchObject({
      ballotRevision: 2,
      votes: [],
      voter: { status: 'withdrawn' },
    })
    const recovery = await call('recover_meeting_poll_voter', {
      pollId: p.poll.id,
      email: join.email,
    })
    expect(recovery.structuredContent).toEqual({ accepted: true })
    expect(
      await call('recover_meeting_poll_voter', {
        pollId: randomUUID(),
        email: 'unknown@example.test',
      }),
    ).toEqual(recovery)
    expect(
      error(await call('read_meeting_poll', { token: randomBytes(32).toString('base64url') }))
        .error,
    ).toBe('poll_not_found')
  })
  it('refuses every public operation under a mismatched installation key', async () => {
    const p = await poll()
    await enrollMeetingPollVoter(
      { db, meetingPollSecret: secret, trustedIp: '192.0.2.54' },
      {
        publicToken: p.publicToken as string,
        name: 'Key fence voter',
        email: 'key-fence@example.test',
        timeZone: 'UTC',
      },
    )
    const wrong = meetingPollTools({
      db,
      meetingPollSecret: 'another-synthetic-installation-secret',
    })
    for (const name of names)
      expect(error(await call(name, validInputs[name], '192.0.2.52', wrong)).error).toBe(
        'meeting_poll_key_mismatch',
      )
  })
  it('uses the shared durable admission budget and carries Retry-After', async () => {
    const ip = '192.0.2.53'
    for (let i = 0; i < 10; i++)
      await enforceMeetingPollRateLimit({ db, meetingPollSecret: secret }, 'admission', ip)
    const result = error(
      await call(
        'recover_meeting_poll_voter',
        { pollId: randomUUID(), email: 'unknown@example.test' },
        ip,
      ),
    )
    expect(result.error).toBe('rate_limited')
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })
  it('runs CLI recovery through the actual MCP HTTP adapter without a token or account impersonation', async () => {
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      publicUrl: 'http://localhost:4186',
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      routes: [],
      mcp: mcpEndpoint({ tools }),
    })
    let stdout = ''
    const stderr = vi.fn()
    const status = await runCli({
      argv: ['polls', 'recover', '--input', '-'],
      env: { HOURMERE_URL: 'http://localhost:4186', HOURMERE_API_KEY: 'hm_synthetic_poll_cli' },
      stdin: (async function* () {
        yield JSON.stringify({ pollId: randomUUID(), email: 'missing@example.test' })
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    })
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ accepted: true })
    expect(stderr).not.toHaveBeenCalled()
  })
})
