import '@hono/zod-openapi'
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { type ApiKeyScope, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { deliverMeetingPollEmail } from '@hourmere/notifications'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFinalizeFixture } from '../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollTools } from './mcp/meeting-polls.ts'
import { meetingPollHostRoutes } from './routes/meeting-poll-host.ts'
import { meetingPollRoutes } from './routes/meeting-polls.ts'

const publicUrl = 'https://poll-contract.example.test'
const protocol = '2026-07-28'
const hostPath = '/api/v1/meeting-polls'
const publicPath = '/api/v1/public/meeting-polls'
type App = ReturnType<typeof createApp>
type Json = Record<string, unknown>

function post(input: Json, key?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key && { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(input),
  }
}

async function mcp(app: App, key: string, operation: { name: string; input: Json } | null) {
  const method = operation ? 'tools/call' : 'tools/list'
  const request = post(
    {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...(operation && { name: operation.name, arguments: operation.input }),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    key,
  )
  const headers = new Headers(request.headers)
  headers.set('accept', 'application/json, text/event-stream')
  headers.set('mcp-protocol-version', protocol)
  headers.set('mcp-method', method)
  if (operation) headers.set('mcp-name', operation.name)
  const response = await app.request(`${publicUrl}/mcp`, { ...request, headers })
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data: '))
  const parsed = JSON.parse(data ? data.slice(6) : raw)
  if (response.ok) {
    expect(parsed.error).toBeUndefined()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = parsed.result
    const body = result.isError
      ? JSON.parse(result.content[0].text)
      : operation
        ? result.structuredContent
        : result
    return { status: response.status, body: body as Json, raw }
  }
  return { status: response.status, body: parsed as Json, raw }
}

async function cli(app: App, key: string, command: string, input: Json) {
  let stdout = ''
  let stderr = ''
  const status = await runCli({
    argv: ['polls', command, '--input', '-'],
    env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: key },
    stdin: (async function* () {
      yield JSON.stringify(input)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  })
  expect((status === 0 ? stderr : stdout).length).toBe(0)
  return { status, body: JSON.parse(stdout || stderr) as Json, raw: stdout + stderr }
}

function expectPrivate(text: string, secrets: readonly string[]) {
  for (const secret of secrets) expect(text.includes(secret)).toBe(false)
}

describe.skipIf(!process.env.DATABASE_URL)('public meeting poll transport contract', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>

  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret: 'synthetic-public-poll-contract-auth-secret',
      signup,
      mailer: {
        send: async () => {
          throw new Error('Unexpected sign-in email')
        },
      },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  async function setup() {
    const f = await createFinalizeFixture(db, { admissionMode: 'invited' })
    const meetingPollSecret = f.ctx.meetingPollSecret
    function makeApp(pollDb = db) {
      const deps = { db: pollDb, publicUrl, meetingPollSecret }
      return createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        publicUrl,
        resolveCaller: createCallerResolver({ auth, db }),
        routes: [meetingPollHostRoutes(deps), meetingPollRoutes(deps)],
        mcp: mcpEndpoint({ tools: [...meetingPollHostTools(deps), ...meetingPollTools(deps)] }),
      })
    }
    async function key(scope: ApiKeyScope, organizationId = f.organizationId) {
      return (
        await auth.api.createApiKey({
          body: { userId: f.owner.id, metadata: { scope, organizationId } },
        })
      ).key
    }
    return { ...f, app: makeApp(), makeApp, key }
  }

  it('accepts emailed voter credentials only on the public surface', async () => {
    const { app, poll, owner, ctx, key } = await setup()
    const host = await key('bookings')
    const read = await key('read', owner.principal.organization.id)
    const full = await key('full', owner.principal.organization.id)
    const email = 'voter-contract@example.test'
    const otherEmail = 'other-voter-contract@example.test'
    const resultsPath = `${hostPath}/${poll.id}/results`
    const inviteKey = randomUUID()
    const invitation = post(
      {
        invitees: [
          { name: 'Voter', email },
          { name: 'Other Voter', email: otherEmail },
        ],
      },
      host,
    )
    const headers = new Headers(invitation.headers)
    headers.set('idempotency-key', inviteKey)
    const accepted = await app.request(`${publicUrl}${hostPath}/${poll.id}/invitations`, {
      ...invitation,
      headers,
    })
    expect(accepted.status).toBe(202)
    const invitationResponse = await accepted.text()
    const delivery = await db
      .selectFrom('meeting_poll_deliveries as delivery')
      .innerJoin('meeting_poll_voters as voter', 'voter.id', 'delivery.voter_id')
      .select('delivery.id')
      .where('delivery.poll_id', '=', poll.id)
      .where('delivery.kind', '=', 'invitation')
      .where('voter.email', '=', email)
      .executeTakeFirstOrThrow()
    const mail: MailMessage[] = []
    await deliverMeetingPollEmail(
      {
        db,
        publicUrl,
        meetingPollSecret: ctx.meetingPollSecret,
        secret: 'synthetic-public-poll-mail-ledger-secret',
        smtpConfigured: true,
        mailMaxPerHour: 0,
        mailRecipientMaxPerHour: 1,
        mailer: { send: async (message: MailMessage) => void mail.push(message) },
      },
      delivery,
    )
    expect(mail.map(({ to }) => to)).toEqual([email])
    const token = /\/poll\/voter#([\w-]+)/.exec(mail[0]?.text ?? '')?.[1]
    const optOut = /\/poll\/reminder-opt-out#([\w-]+)/.exec(mail[0]?.text ?? '')?.[1]
    if (!token || !optOut) throw new Error('Expected voting and reminder links in invitation')
    expectPrivate(invitationResponse, [token, optOut])

    const unauthorized = await app.request(`${publicUrl}${resultsPath}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' })
    const hostResults = { name: 'get_meeting_poll_results', input: { id: poll.id } }
    expect(await mcp(app, token, hostResults)).toMatchObject({
      status: 401,
      body: { error: 'unauthorized' },
    })
    expect(await cli(app, token, 'results', { id: poll.id })).toMatchObject({
      status: 1,
      body: { error: 'invalid_api_key' },
    })
    const foreignResults = await app.request(`${publicUrl}${resultsPath}`, {
      headers: { authorization: `Bearer ${full}` },
    })
    expect(foreignResults.status).toBe(404)
    expect(await foreignResults.json()).toEqual({ error: 'poll_not_found' })
    expect(await mcp(app, full, hostResults)).toMatchObject({
      status: 200,
      body: { error: 'poll_not_found' },
    })
    expect(await cli(app, full, 'results', { id: poll.id })).toMatchObject({
      status: 1,
      body: { error: 'poll_not_found' },
    })
    for (const [apiKey, canWrite] of [
      [read, false],
      [host, true],
      [full, true],
    ] as const) {
      const discovery = await mcp(app, apiKey, null)
      expect(discovery.status).toBe(200)
      const tools = discovery.body.tools as { name: string; description: string }[]
      const names = tools.map(({ name }) => name)
      expect(tools.find(({ name }) => name === 'read_meeting_poll')?.description).toContain(
        'Omits the host roster',
      )
      expect(names).toContain('get_meeting_poll_results')
      expect(names.includes('submit_meeting_poll_vote')).toBe(canWrite)
      expect(names.includes('create_meeting_poll')).toBe(canWrite)
      expect(names.includes('finalize_meeting_poll')).toBe(canWrite)
      const join = tools.find(({ name }) => name === 'enroll_meeting_poll_voter')
      if (canWrite) expect(join?.description).toContain('Does not create a poll')
      else expect(join).toBeUndefined()
    }

    const input = {
      token,
      votes: poll.candidates.map(({ id }) => ({ slotId: id, value: 'yes' })),
      consent: true,
      expectedBallotRevision: 0,
    }
    const vote = (input: Json) => ({ name: 'submit_meeting_poll_vote', input })
    const restVote = (input: Json, key?: string) =>
      app.request(`${publicUrl}${publicPath}/vote`, post(input, key))
    for (const wrongToken of [optOut, full]) {
      const foreign = { ...input, token: wrongToken }
      const denied = await restVote(foreign, full)
      expect(denied.status).toBe(404)
      expect(await denied.json()).toEqual({ error: 'poll_not_found' })
      expect(await mcp(app, full, vote(foreign))).toMatchObject({
        status: 200,
        body: { error: 'poll_not_found' },
      })
      expect(await cli(app, full, 'vote', foreign)).toMatchObject({
        status: 1,
        body: { error: 'poll_not_found' },
      })
    }
    const readOnlyVote = await restVote(input, read)
    expect(readOnlyVote.status).toBe(403)
    expect(await readOnlyVote.json()).toMatchObject({ error: 'insufficient_scope' })
    expect(await mcp(app, read, vote(input))).toMatchObject({
      status: 200,
      body: { error: 'insufficient_scope' },
    })
    expect(await cli(app, read, 'vote', input)).toMatchObject({
      status: 1,
      body: { error: 'insufficient_scope' },
    })

    const submitted = await cli(app, full, 'vote', input)
    expectPrivate(submitted.raw, [token, optOut, otherEmail, full])
    expect(submitted).toMatchObject({
      status: 0,
      body: { voter: { pollId: poll.id, email }, ballotRevision: 1, votes: input.votes },
    })
    const ballotInput = { token }
    const restRead = await app.request(`${publicUrl}${publicPath}/read`, post(ballotInput))
    expect(restRead.status).toBe(200)
    expect(restRead.headers.get('cache-control')).toBe('private, no-store')
    const raw = await restRead.text()
    expectPrivate(raw, [token, optOut, otherEmail])
    const snapshot = JSON.parse(raw)
    expect(snapshot).toMatchObject({ id: poll.id, ownBallot: submitted.body })
    expect(snapshot).not.toHaveProperty('roster')
    const mcpRead = await mcp(app, read, { name: 'read_meeting_poll', input: ballotInput })
    const cliRead = await cli(app, full, 'view', ballotInput)
    expectPrivate(mcpRead.raw, [token, optOut, otherEmail, read])
    expectPrivate(cliRead.raw, [token, optOut, otherEmail, full])
    expect(mcpRead.status).toBe(200)
    expect(cliRead.status).toBe(0)
    expect(mcpRead.body).toEqual(snapshot)
    expect(cliRead.body).toEqual(snapshot)
  })

  it('omits credentials, links and mailboxes even when poll diagnostics contain them', async () => {
    const { app, makeApp, key, poll } = await setup()
    const full = await key('full')
    const token = randomBytes(32).toString('base64url')
    const mailbox = 'private-poll-diagnostic@example.test'
    const link = `${publicUrl}/poll/voter#${token}`
    const idempotencyKey = randomUUID()
    const sensitive = [token, mailbox, link, full, idempotencyKey]
    const brokenDb = {
      transaction() {
        throw new Error(`Poll storage failure for ${sensitive.join(' ')}`)
      },
    } as unknown as Db
    const broken = makeApp(brokenDb)
    const logs = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    )
    try {
      const invite = { id: poll.id, invitees: [{ name: 'Voter', email: mailbox }], idempotencyKey }
      const operations = [
        { name: 'read_meeting_poll', command: 'view', input: { token } },
        { name: 'invite_meeting_poll_voters', command: 'invite', input: invite },
      ]
      const extras = { [token]: token, [mailbox]: mailbox, [link]: link }
      for (const { name, command, input } of operations) {
        for (const [target, args, error] of [
          [app, { ...input, ...extras }, 'invalid_request'],
          [broken, input, 'internal_error'],
        ] as const) {
          const mcpReply = await mcp(target, full, { name, input: args })
          expectPrivate(mcpReply.raw, sensitive)
          expect(mcpReply).toMatchObject({ status: 200, body: { error } })
          const cliReply = await cli(target, full, command, args)
          expectPrivate(cliReply.raw, sensitive)
          expect(cliReply).toMatchObject({ status: 1, body: { error } })
        }
      }
      const captured = inspect(
        logs.flatMap((spy) => spy.mock.calls),
        { depth: null },
      )
      expectPrivate(captured, sensitive)
      expect(captured.includes('POST /mcp tools/call read_meeting_poll:')).toBe(true)
      expect(captured.includes('POST /mcp tools/call invite_meeting_poll_voters:')).toBe(true)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })
})
