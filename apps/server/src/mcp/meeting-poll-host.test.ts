import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { InvalidApiKeyError } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingNotifier, FinalizeMeetingPollResult } from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFinalizeFixture } from '../../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { createApp } from '../app.ts'
import { mcpEndpoint } from './endpoint.ts'
import { meetingPollHostTools } from './meeting-poll-host.ts'
import { type McpCaller, runTool, type Tool } from './tools.ts'

const PUBLIC_URL = 'http://localhost:4187'
const hostTools = [
  'list_meeting_polls',
  'get_meeting_poll',
  'get_meeting_poll_results',
  'close_meeting_poll',
  'cancel_meeting_poll',
  'delete_meeting_poll',
  'finalize_meeting_poll',
  'create_meeting_poll',
  'invite_meeting_poll_voters',
  'resend_meeting_poll_invitation',
  'remove_meeting_poll_voter',
  'remove_unverified_meeting_poll_voters',
  'rotate_meeting_poll_link',
]

const privateKey = 'synthetic-private-meeting-poll-idempotency-key'
const privateMailbox = 'synthetic-private-meeting-poll-mailbox@example.test'
const bookerVoterId = randomUUID()

it.each([
  {
    name: 'finalize_meeting_poll',
    input: {
      id: randomUUID(),
      slotId: randomUUID(),
      bookerVoterId,
      attendeeVoterIds: [bookerVoterId],
      expectedResultsRevision: 1,
      expectedBallotRevisions: { [bookerVoterId]: 1 },
      acknowledgeConditional: false,
      idempotencyKey: privateKey,
    },
    privateValue: privateKey,
  },
  {
    name: 'invite_meeting_poll_voters',
    input: {
      id: randomUUID(),
      invitees: [{ name: 'Invitee', email: privateMailbox }],
      idempotencyKey: privateKey,
    },
    privateValue: privateMailbox,
  },
])(
  'redacts invalid input and unexpected failures for $name',
  async ({ name, input, privateValue }) => {
    const tool = meetingPollHostTools({ db: {} as Db, publicUrl: PUBLIC_URL }).find(
      (entry) => entry.name === name,
    ) as Tool
    const caller: McpCaller = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'bookings',
      user: { id: randomUUID(), name: 'Agent', email: 'agent@example.test' },
      organization: { id: randomUUID(), name: 'Personal', slug: 'personal', personal: true },
    }
    const invoke = vi.fn(async () => {
      throw Error(`${privateValue} ${privateKey}`)
    })
    const log = vi.fn()
    const call = (args: unknown) =>
      runTool({ ...tool, run: invoke }, args, { caller, rateLimit: () => {} }, log)
    const malformed = await call({ ...input, [privateValue]: true })
    expect(malformed).toMatchObject({ isError: true })
    expect(JSON.stringify(malformed)).not.toContain(privateValue)
    expect(invoke).not.toHaveBeenCalled()
    const failed = await call(input)
    expect(failed).toMatchObject({ isError: true })
    expect(invoke).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
    const diagnostic = JSON.stringify([failed, log.mock.calls])
    expect(diagnostic).not.toContain(privateValue)
    expect(diagnostic).not.toContain(privateKey)

    invoke.mockRejectedValueOnce(new InvalidApiKeyError())
    expect(await call(input)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'unauthorized' }) }],
    })
    expect(log).toHaveBeenCalledOnce()
  },
)

describe.skipIf(!process.env.DATABASE_URL)('host meeting polls over MCP OAuth', () => {
  let database: TestDatabase
  let db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })

  async function setup() {
    const fixture = await createFinalizeFixture(db)
    const { organizationId, member, team } = fixture
    const role = (value: string) =>
      db
        .updateTable('auth.member')
        .set({ role: value })
        .where('organizationId', '=', organizationId)
        .where('userId', '=', member.id)
        .executeTakeFirstOrThrow()
    await role('admin')
    const principal = {
      ...team.as(member),
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'polls-test-client',
      scopes: ['mcp:tools'],
    } as const
    const notify = vi.fn<BookingNotifier>()
    const bearer = 'Bearer synthetic-poll-oauth-access-token'
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: PUBLIC_URL,
      mcp: mcpEndpoint({
        tools: meetingPollHostTools({
          db,
          meetingPollSecret: fixture.ctx.meetingPollSecret,
          notify,
          publicUrl: PUBLIC_URL,
        }),
        oauth: {
          resolve: async (request) =>
            request.headers.get('authorization') === bearer
              ? { ok: true, principal }
              : { ok: false, error: 'invalid_token' },
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
    })
    const rpc = (method: string, params: Record<string, unknown> = {}, authorization = bearer) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    async function result(response: Response) {
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const text = await response.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data ? data.slice(6) : text).result
    }
    const call = async (name: string, args: unknown) =>
      result(await rpc('tools/call', { name, arguments: args }))
    return { fixture, role, principal, notify, rpc, result, call }
  }

  it('uses current team authority for reading and replay, and enqueues only one outcome', async () => {
    const { fixture, role, principal, notify, rpc, result, call } = await setup()
    const { poll } = fixture
    expect((await result(await rpc('tools/list'))).tools.map((tool: Tool) => tool.name)).toEqual(
      hostTools,
    )
    expect((await rpc('tools/list', {}, 'Bearer unknown-oauth-token')).status).toBe(401)

    const booker = await fixture.addVoter()
    const notified = await fixture.addVoter({ state: 'invited' })
    const results = await call('get_meeting_poll_results', { id: poll.id })
    expect(results.structuredContent).toMatchObject({
      poll: { id: poll.id },
      countedBallots: 1,
      candidates: [
        { yes: 1, availability: 'available' },
        { yes: 1, availability: 'available' },
      ],
    })
    expect(JSON.stringify(results)).not.toMatch(/publicToken|votingToken|ciphertext|digest/i)

    const request = await fixture.input([booker])
    const finalized = await call('finalize_meeting_poll', request)
    const response = finalized.structuredContent as FinalizeMeetingPollResult
    expect(response).toMatchObject({
      poll: { id: poll.id, status: 'scheduled' },
      booking: { eventTypeId: fixture.eventTypeId, source: 'mcp', status: 'confirmed' },
      replayed: false,
    })
    expect(JSON.stringify(finalized)).not.toMatch(/manageToken|manageUrl|publicToken|votingToken/i)
    expect((await call('finalize_meeting_poll', request)).structuredContent).toEqual({
      ...response,
      replayed: true,
    })
    const conflict = await call('finalize_meeting_poll', {
      ...request,
      idempotencyKey: randomUUID(),
    })
    expect(conflict.isError).toBe(true)
    expect(JSON.parse(conflict.content[0].text)).toEqual({
      error: 'poll_already_scheduled',
      poll: response.poll,
    })
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0]?.[1]).toMatchObject({
      type: 'created',
      bookingId: response.booking.id,
    })
    expect(
      await db
        .selectFrom('bookings')
        .select(['source', 'oauth_consent_id', 'api_key_id'])
        .where('id', '=', response.booking.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ source: 'mcp', oauth_consent_id: principal.oauthConsentId, api_key_id: null })
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select('voter_id')
        .where('poll_id', '=', poll.id)
        .where('kind', '=', 'selected')
        .execute(),
    ).toEqual([{ voter_id: notified.id }])

    await role('member')
    for (const [name, input] of [
      ['get_meeting_poll_results', { id: poll.id }],
      ['finalize_meeting_poll', request],
    ] as const) {
      const denied = await call(name, input)
      expect(denied.isError).toBe(true)
      expect(JSON.parse(denied.content[0].text)).toEqual({ error: 'team_management_access_denied' })
    }
  })

  it('creates as a team admin and rechecks authority before creation and invitation replays', async () => {
    const { fixture, role, call } = await setup()
    const request = {
      eventTypeId: fixture.eventTypeId,
      candidateStarts: fixture.poll.candidates.map((candidate) => candidate.startAt),
      deadlineAt: fixture.poll.deadlineAt,
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    }
    const created = await call('create_meeting_poll', request)
    const { poll, publicLink } = created.structuredContent
    expect(poll).toMatchObject({
      eventTypeId: request.eventTypeId,
      createdByUserId: fixture.member.id,
      source: 'mcp',
    })
    expect(publicLink).toMatch(/^http:\/\/localhost:4187\/poll#[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(created)).not.toMatch(/publicToken|manageToken|manageUrl|idempotencyKey/)

    const replay = await call('create_meeting_poll', request)
    expect(replay.isError).toBe(true)
    expect(JSON.parse(replay.content[0].text)).toEqual({
      error: 'poll_already_created',
      pollId: poll.id,
    })
    const invitation = {
      id: poll.id,
      invitees: [{ name: 'Invitee', email: privateMailbox, locale: 'zh-CN' }],
      idempotencyKey: randomUUID(),
    }
    const invited = await call('invite_meeting_poll_voters', invitation)
    expect(invited.structuredContent).toMatchObject({
      entries: [{ email: privateMailbox, status: 'invited', outcome: 'invited' }],
      replayed: false,
    })
    expect(JSON.stringify(invited)).not.toMatch(/publicLink|publicToken|votingToken|manageToken/i)
    expect((await call('invite_meeting_poll_voters', invitation)).structuredContent).toMatchObject({
      entries: [{ email: privateMailbox, status: 'invited', outcome: 'unchanged' }],
      replayed: true,
    })
    expect(
      await db
        .selectFrom('meeting_poll_deliveries as delivery')
        .innerJoin('meeting_poll_voters as voter', 'voter.id', 'delivery.voter_id')
        .select(['voter.email', 'voter.locale'])
        .where('delivery.poll_id', '=', poll.id)
        .where('delivery.kind', '=', 'invitation')
        .execute(),
    ).toEqual([{ email: privateMailbox, locale: 'zh-CN' }])

    await role('member')
    for (const [name, input] of [
      ['create_meeting_poll', request],
      ['invite_meeting_poll_voters', invitation],
    ] as const) {
      const denied = await call(name, input)
      expect(denied.isError).toBe(true)
      expect(JSON.parse(denied.content[0].text)).toEqual({ error: 'team_management_access_denied' })
    }
  })
})
