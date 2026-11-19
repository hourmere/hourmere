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
]

it('keeps invalid finalize input and unexpected failures out of MCP diagnostics', async () => {
  const tool = meetingPollHostTools({ db: {} as Db }).find(
    (entry) => entry.name === 'finalize_meeting_poll',
  ) as Tool
  const caller: McpCaller = {
    kind: 'api_key',
    apiKeyId: randomUUID(),
    apiKeyScope: 'bookings',
    user: { id: randomUUID(), name: 'Agent', email: 'agent@example.test' },
    organization: { id: randomUUID(), name: 'Personal', slug: 'personal', personal: true },
  }
  const bookerVoterId = randomUUID()
  const privateValue = 'synthetic-private-finalization-input'
  const input = {
    id: randomUUID(),
    slotId: randomUUID(),
    bookerVoterId,
    attendeeVoterIds: [bookerVoterId],
    expectedResultsRevision: 1,
    expectedBallotRevisions: { [bookerVoterId]: 1 },
    acknowledgeConditional: false,
    idempotencyKey: privateValue,
  }
  const invoke = vi.fn(async () => {
    throw Error(privateValue)
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
  expect(JSON.stringify([failed, log.mock.calls])).not.toContain(privateValue)

  invoke.mockRejectedValueOnce(new InvalidApiKeyError())
  expect(await call(input)).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'unauthorized' }) }],
  })
  expect(log).toHaveBeenCalledOnce()
})

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

  it('uses current team authority for reading and replay, and enqueues only one outcome', async () => {
    const fixture = await createFinalizeFixture(db)
    const { organizationId, poll, member, team } = fixture
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
})
