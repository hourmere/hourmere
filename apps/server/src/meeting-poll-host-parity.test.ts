import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { type ApiKeyScope, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFinalizeFixture } from '../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { createMeetingPoll } from '../../../packages/scheduling/src/meeting-polls.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollHostRoutes } from './routes/meeting-poll-host.ts'

const publicUrl = 'https://poll-parity.example.test'
const protocol = '2026-07-28'
const tools = {
  list: 'list_meeting_polls',
  get: 'get_meeting_poll',
  results: 'get_meeting_poll_results',
  close: 'close_meeting_poll',
  cancel: 'cancel_meeting_poll',
  delete: 'delete_meeting_poll',
  finalize: 'finalize_meeting_poll',
}
type Command = keyof typeof tools
type Json = Record<string, unknown>

function expectSafeResponse(text: string, input: Json, apiKey: string) {
  expect(text.includes(apiKey)).toBe(false)
  expect(/"(?:manageToken|manageUrl)"\s*:/.test(text)).toBe(false)
  if (typeof input.idempotencyKey === 'string')
    expect(text.includes(input.idempotencyKey)).toBe(false)
}

describe.skipIf(!process.env.DATABASE_URL)('host poll transport parity on Postgres', () => {
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
      secret: 'synthetic-meeting-poll-parity-auth-secret',
      signup,
      mailer: {
        send: async () => {
          throw Error('Unexpected mail in poll parity test')
        },
      },
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  async function setup() {
    const fixture = await createFinalizeFixture(db)
    const deps = { db, meetingPollSecret: fixture.ctx.meetingPollSecret }
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      publicUrl,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [meetingPollHostRoutes(deps)],
      mcp: mcpEndpoint({ tools: meetingPollHostTools(deps) }),
    })
    async function key(scope: ApiKeyScope, organizationId = fixture.organizationId) {
      return (
        await auth.api.createApiKey({
          body: { userId: fixture.owner.id, metadata: { scope, organizationId } },
        })
      ).key
    }
    const bookings = await key('bookings')

    async function rest(command: Command, input: Json, apiKey = bookings) {
      const { id, idempotencyKey, ...body } = input
      const base = '/api/v1/meeting-polls'
      const suffix = ['results', 'close', 'cancel', 'finalize'].includes(command)
        ? `/${command}`
        : ''
      const url = new URL(command === 'list' ? base : `${base}/${id}${suffix}`, publicUrl)
      const method = ['list', 'get', 'results'].includes(command)
        ? 'GET'
        : command === 'delete'
          ? 'DELETE'
          : 'POST'
      const headers = new Headers({ authorization: `Bearer ${apiKey}` })
      if (typeof idempotencyKey === 'string') headers.set('idempotency-key', idempotencyKey)
      if (method === 'GET') {
        for (const [field, value] of Object.entries(body))
          url.searchParams.set(field, String(value))
      } else {
        headers.set('content-type', 'application/json')
      }
      const response = await app.request(url, {
        headers,
        method,
        ...(method !== 'GET' && { body: JSON.stringify(body) }),
      })
      expect(response.headers.get('cache-control')).toBe('no-store')
      const text = await response.text()
      expectSafeResponse(text, input, apiKey)
      return {
        status: response.status,
        body: response.status === 204 ? null : (JSON.parse(text) as Json),
      }
    }
    async function mcp(command: Command, input: Json, apiKey = bookings) {
      const response = await app.request(`${publicUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': protocol,
          'mcp-method': 'tools/call',
          'mcp-name': tools[command],
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: tools[command],
            arguments: input,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': protocol,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      const text = await response.text()
      expectSafeResponse(text, input, apiKey)
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      const payload = JSON.parse(data ? data.slice(6) : text)
      if (!response.ok) return { status: response.status, body: payload as Json }
      expect(payload.error).toBeUndefined()
      return {
        status: response.status,
        body: (payload.result.isError
          ? JSON.parse(payload.result.content[0].text)
          : payload.result.structuredContent) as Json,
      }
    }
    async function cli(command: Command, input: Json, apiKey = bookings) {
      let stdout = ''
      let stderr = ''
      const status = await runCli({
        argv: ['polls', command, '--input', '-'],
        env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: apiKey },
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
      expectSafeResponse(stdout + stderr, input, apiKey)
      expect(status === 0 ? stderr : stdout).toBe('')
      return { status, body: JSON.parse(stdout || stderr) as Json }
    }
    async function errorAcrossSurfaces(
      command: Command,
      input: Json,
      status: number,
      error: string,
      apiKey = bookings,
    ) {
      expect(await rest(command, input, apiKey)).toMatchObject({ status, body: { error } })
      expect(await mcp(command, input, apiKey)).toMatchObject({
        status: status === 401 ? 401 : 200,
        body: { error },
      })
      expect(await cli(command, input, apiKey)).toMatchObject({ status: 1, body: { error } })
    }
    return { ...fixture, key, rest, mcp, cli, errorAcrossSurfaces }
  }

  it('binds host scope and tenant for every ID access and refuses an invalid bearer', async () => {
    const f = await setup()
    const readKey = await f.key('read')
    const otherOrganizationKey = await f.key('full', f.owner.principal.organization.id)
    const id = f.poll.id
    const hostWrite = { id, expectedHostRevision: f.poll.hostRevision }
    const finalize = { ...(await f.input([await f.addVoter()])) }
    const requests = {
      get: { id },
      results: { id },
      close: hostWrite,
      cancel: hostWrite,
      delete: hostWrite,
      finalize,
    }
    for (const command of Object.keys(requests) as (keyof typeof requests)[]) {
      const input = requests[command]
      await f.errorAcrossSurfaces(command, input, 404, 'poll_not_found', otherOrganizationKey)
    }
    const otherList = { data: [], nextAfter: null }
    expect((await f.rest('list', {}, otherOrganizationKey)).body).toEqual(otherList)
    expect((await f.mcp('list', {}, otherOrganizationKey)).body).toEqual(otherList)
    expect((await f.cli('list', {}, otherOrganizationKey)).body).toEqual(otherList)
    await f.errorAcrossSurfaces('get', { id }, 401, 'unauthorized', 'hm_invalid_synthetic_bearer')
    await f.errorAcrossSurfaces('delete', hostWrite, 403, 'insufficient_scope', readKey)
    await f.errorAcrossSurfaces('finalize', finalize, 403, 'insufficient_scope', readKey)
    expect((await f.cli('get', { id }, readKey)).body).toEqual(f.poll)
  })

  it('shares pagination, revisions, conditional selection and exact replay across surfaces', async () => {
    const f = await setup()
    const other = await createMeetingPoll(f.ctx, {
      eventTypeId: f.eventTypeId,
      deadlineAt: f.poll.deadlineAt,
      candidateStarts: [f.chosen, f.alternative].map((slot) =>
        Temporal.Instant.from(slot.startAt).add({ hours: 3 }).toString(),
      ),
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    })
    const first = await f.rest('list', { limit: 1 })
    const after = first.body?.nextAfter
    expect(first.body).toMatchObject({ data: [other.poll], nextAfter: expect.any(String) })
    expect((await f.mcp('list', { limit: 1 })).body).toEqual(first.body)
    expect((await f.cli('list', { limit: 1 })).body).toEqual(first.body)
    const second = { data: [f.poll], nextAfter: null }
    for (const read of [f.rest, f.mcp, f.cli]) {
      expect((await read('list', { limit: 1, after })).body).toEqual(second)
      const result = await read('get', { id: other.poll.id })
      expect(JSON.stringify(result.body).includes(other.publicToken as string)).toBe(false)
      expect(result.body).toEqual(other.poll)
    }

    const voter = await f.addVoter({ value: 'if_need_be' })
    const id = f.poll.id
    const write = { id, expectedHostRevision: f.poll.hostRevision }
    await f.errorAcrossSurfaces(
      'close',
      { ...write, expectedHostRevision: 99 },
      409,
      'poll_changed',
    )
    const closed = await f.rest('close', write)
    expect(closed).toMatchObject({ status: 200, body: { status: 'closed' } })
    expect((await f.mcp('close', write)).body).toEqual(closed.body)
    expect((await f.cli('close', write)).body).toEqual(closed.body)

    const results = await f.rest('results', { id })
    expect(results.body).toMatchObject({
      poll: closed.body,
      resultsRevision: expect.any(Number),
      candidates: [
        { id: f.chosen.id, ifNeedBe: 1, availability: 'available' },
        { id: f.alternative.id, ifNeedBe: 1, availability: 'available' },
      ],
      roster: [{ voterId: voter.id, ballotRevision: voter.ballotRevision }],
    })
    expect((await f.mcp('results', { id })).body).toEqual(results.body)
    expect((await f.cli('results', { id })).body).toEqual(results.body)

    const input = { ...(await f.input([voter])) }
    await f.errorAcrossSurfaces('finalize', input, 400, 'poll_conditional_acknowledgment_required')
    const selected = { ...input, acknowledgeConditional: true }
    await f.errorAcrossSurfaces(
      'finalize',
      { ...selected, expectedResultsRevision: 99 },
      409,
      'poll_changed',
    )
    await f.errorAcrossSurfaces(
      'finalize',
      { ...selected, expectedBallotRevisions: { [voter.id]: 99 } },
      409,
      'poll_changed',
    )
    const finalized = await f.rest('finalize', selected)
    expect(finalized).toMatchObject({
      status: 201,
      body: {
        replayed: false,
        poll: { status: 'scheduled' },
        booking: { id: expect.any(String), source: 'api' },
      },
    })
    const exactReplay = { ...finalized.body, replayed: true }
    expect(await f.rest('finalize', selected)).toEqual({ status: 200, body: exactReplay })
    expect(await f.mcp('finalize', selected)).toEqual({ status: 200, body: exactReplay })
    expect(await f.cli('finalize', selected)).toEqual({ status: 0, body: exactReplay })
    await f.errorAcrossSurfaces('finalize', input, 409, 'idempotency_key_reused')

    const scheduled = finalized.body?.poll as { hostRevision: number; bookingId: string }
    const otherKey = { ...selected, idempotencyKey: randomUUID() }
    const reference = {
      id,
      status: 'scheduled',
      bookingId: scheduled.bookingId,
      chosenSlotId: f.chosen.id,
      hostRevision: scheduled.hostRevision,
    }
    const conflict = { error: 'poll_already_scheduled', poll: reference }
    expect(await f.rest('finalize', otherKey)).toMatchObject({ status: 409, body: conflict })
    expect(await f.mcp('finalize', otherKey)).toMatchObject({ status: 200, body: conflict })
    expect(await f.cli('finalize', otherKey)).toMatchObject({ status: 1, body: conflict })

    const cancel = { id: other.poll.id, expectedHostRevision: other.poll.hostRevision }
    const canceled = await f.mcp('cancel', cancel)
    expect(canceled.body).toMatchObject({ status: 'canceled' })
    expect((await f.rest('cancel', cancel)).body).toEqual(canceled.body)
    expect((await f.cli('cancel', cancel)).body).toEqual(canceled.body)
    expect(
      await f.rest('delete', { ...cancel, expectedHostRevision: canceled.body.hostRevision }),
    ).toEqual({ status: 204, body: null })

    const remove = { id, expectedHostRevision: scheduled.hostRevision }
    expect(await f.cli('delete', remove)).toEqual({ status: 0, body: { deleted: true } })
    await f.errorAcrossSurfaces('get', { id }, 404, 'poll_not_found')
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', scheduled.bookingId).execute(),
    ).toEqual([{ id: scheduled.bookingId }])
  })
})
