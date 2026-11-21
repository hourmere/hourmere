import '@hono/zod-openapi'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { type ApiKeyScope, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { deliverMeetingPollEmail } from '@hourmere/notifications'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  collideFinalizeWrites,
  createFinalizeFixture,
  waitAtFinalizeGate,
} from '../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollTools } from './mcp/meeting-polls.ts'
import type {
  FinalizeMeetingPollOutput,
  MeetingPollLinkOutput,
  MeetingPollResultsOutput,
} from './meeting-poll-host-schemas.ts'
import type { MeetingPollBallotOutput, VerifyMeetingPollOutput } from './meeting-poll-schemas.ts'
import { meetingPollHostRoutes } from './routes/meeting-poll-host.ts'
import { meetingPollRoutes } from './routes/meeting-polls.ts'

const origin = 'https://poll-acceptance.example.test'
const hostPath = '/api/v1/meeting-polls'
const publicPath = '/api/v1/public/meeting-polls'
const protocol = '2026-07-28'
const zones = ['Asia/Shanghai', 'Europe/London', 'America/Los_Angeles'] as const

type Body = Record<string, unknown>

function fragment(link: URL, path: string) {
  expect(link.origin + link.pathname === origin + path, 'capability link path').toBe(true)
  expect(link.search === '', 'capability links must have no query').toBe(true)
  expect(link.hash.length).toBeGreaterThan(1)
  return link.hash.slice(1)
}

function expectNoCredentials(text: string, credentials: readonly string[]) {
  for (const credential of credentials) expect(text.includes(credential)).toBe(false)
}

function hasPrivatePollFields(response: string) {
  return /"(?:source|apiKeyId|oauthConsentId|roster|bookingId)"\s*:/.test(response)
}

describe.skipIf(!process.env.DATABASE_URL)('meeting poll transport acceptance on Postgres', () => {
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
      baseURL: origin,
      secret: 'synthetic-transport-acceptance-auth-secret',
      signup,
      mailer: {
        send: async () => {
          throw new Error('Unexpected sign-in mail')
        },
      },
    })
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await database?.drop()
    }
  })

  async function setup() {
    const f = await createFinalizeFixture(db)
    const deps = {
      db,
      publicUrl: origin,
      meetingPollSecret: f.ctx.meetingPollSecret,
      notify: waitAtFinalizeGate,
    }
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      publicUrl: origin,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [meetingPollHostRoutes(deps), meetingPollRoutes(deps)],
      mcp: mcpEndpoint({ tools: [...meetingPollHostTools(deps), ...meetingPollTools(deps)] }),
    })
    const makeKey = (scope: ApiKeyScope) =>
      auth.api.createApiKey({
        body: { userId: f.owner.id, metadata: { scope, organizationId: f.organizationId } },
      })
    const host = await makeKey('bookings')
    const viewer = await makeKey('read')
    const full = await makeKey('full')
    const knownCredentials = [host.key, viewer.key, full.key]
    const urls: string[] = []
    let nextAddress = 0
    async function fetch(input: string | Request | URL, init?: RequestInit) {
      const request = new Request(input, init)
      urls.push(request.url)
      return app.fetch(request, {
        incoming: { socket: { remoteAddress: `198.18.0.${++nextAddress}` } },
      })
    }
    function checkResponse(text: string, input: Body) {
      const supplied = [input.token, input.publicToken, input.idempotencyKey].filter(
        (value): value is string => typeof value === 'string',
      )
      expectNoCredentials(text, [...knownCredentials, ...supplied])
      expect(
        /"(?:manageToken|manageUrl|apiKeyId|oauthConsentId|publicToken|capabilityCiphertext)"\s*:/.test(
          text,
        ),
        'poll responses must omit private booking and credential fields',
      ).toBe(false)
    }
    async function rest(path: string, body?: Body, key?: string, method = body ? 'POST' : 'GET') {
      const { idempotencyKey, ...fields } = body ?? {}
      const headers = new Headers()
      if (key) headers.set('authorization', `Bearer ${key}`)
      if (typeof idempotencyKey === 'string') headers.set('idempotency-key', idempotencyKey)
      if (body) headers.set('content-type', 'application/json')
      const response = await fetch(`${origin}${path}`, {
        method,
        headers,
        ...(body && { body: JSON.stringify(fields) }),
      })
      if (path.startsWith(publicPath)) {
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      }
      const raw = await response.text()
      checkResponse(raw, body ?? {})
      return {
        status: response.status,
        body: raw ? JSON.parse(raw) : null,
        responseText: () => raw,
      }
    }
    async function mcp(name: string, input: Body, key = host.key) {
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': protocol,
          'mcp-method': 'tools/call',
          'mcp-name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: input,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': protocol,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      expect(response.status).toBe(200)
      const raw = await response.text()
      checkResponse(raw, input)
      const data = raw.split('\n').find((line) => line.startsWith('data: '))
      const payload = JSON.parse(data ? data.slice(6) : raw)
      expect(payload.error === undefined, 'MCP protocol call succeeded').toBe(true)
      const result = payload.result
      return {
        ok: !result.isError,
        body: result.isError ? JSON.parse(result.content[0].text) : result.structuredContent,
        responseText: () => raw,
      }
    }
    async function cli(command: string, input: Body, key = host.key) {
      let stdout = ''
      let stderr = ''
      const status = await runCli({
        argv: ['polls', command, '--input', '-'],
        env: { HOURMERE_URL: origin, HOURMERE_API_KEY: key },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch,
      })
      expect((status === 0 ? stderr : stdout).length).toBe(0)
      const raw = stdout + stderr
      checkResponse(raw, input)
      return { status, body: JSON.parse(raw), responseText: () => raw }
    }
    function createInput() {
      return {
        eventTypeId: f.eventTypeId,
        candidateStarts: f.poll.candidates.map(({ startAt }) => startAt),
        deadlineAt: f.poll.deadlineAt,
        displayTimeZone: 'America/Los_Angeles',
        admissionMode: 'public_link',
        idempotencyKey: randomUUID(),
      }
    }
    async function create() {
      const input = createInput()
      const created = await rest(hostPath, input, host.key)
      expect(created.status).toBe(201)
      const { poll, publicLink } = created.body as z.infer<typeof MeetingPollLinkOutput>
      assert(publicLink)
      const token = fragment(new URL(publicLink), '/poll')
      knownCredentials.push(token)
      return { input, poll, token }
    }
    return { ...f, deps, host, viewer, full, urls, knownCredentials, rest, mcp, cli, create }
  }

  it('crosses REST, MCP and CLI from invitation and ballot to one booking with ten guests', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    )
    try {
      const {
        eventTypeId,
        deps,
        host,
        viewer,
        full,
        urls,
        knownCredentials,
        rest,
        mcp,
        cli,
        create,
      } = await setup()
      const { poll, token: publicToken, input: createInput } = await create()
      const { id, candidates } = poll
      const [chosen, alternative] = candidates
      assert(chosen && alternative)
      expect(poll.source).toBe('api')
      const invitees = Array.from({ length: 12 }, (_, index) => ({
        name: `Voter ${index + 1}`,
        email: `transport-${index + 1}@example.test`,
        timeZone: zones[index % zones.length],
        locale: index % zones.length === 0 ? 'zh-CN' : 'en',
      }))
      const invitation = { id, invitees, idempotencyKey: randomUUID() }
      const invited = await mcp('invite_meeting_poll_voters', invitation)
      expect(invited).toMatchObject({ ok: true, body: { replayed: false } })
      const replayedInvite = await cli('invite', invitation)
      expect(replayedInvite).toMatchObject({ status: 0, body: { replayed: true } })
      const deliveries = await db
        .selectFrom('meeting_poll_deliveries')
        .select('id')
        .where('poll_id', '=', id)
        .where('kind', '=', 'invitation')
        .execute()
      expect(deliveries).toHaveLength(invitees.length)
      const mail: MailMessage[] = []
      for (const delivery of deliveries) {
        await deliverMeetingPollEmail(
          {
            ...deps,
            secret: 'synthetic-transport-acceptance-ledger-secret',
            smtpConfigured: true,
            mailMaxPerHour: 0,
            mailer: { send: async (message) => void mail.push(message) },
          },
          delivery,
        )
      }
      expect(mail.map(({ to }) => to).sort()).toEqual(invitees.map(({ email }) => email).sort())

      const tokens: string[] = []
      const votes = candidates.map(({ id: slotId }) => ({ slotId, value: 'yes' }))
      const ballots: z.infer<typeof MeetingPollBallotOutput>[] = []
      for (const [index, invitee] of invitees.entries()) {
        const message = mail.find(({ to }) => to === invitee.email)
        const voterLink = message?.text.match(/https:\/\/[^\s]+\/poll\/voter#[\w-]+/)?.[0]
        const optOutLink = message?.text.match(
          /https:\/\/[^\s]+\/poll\/reminder-opt-out#[\w-]+/,
        )?.[0]
        assert(voterLink && optOutLink, 'Mail must contain two fragment-only capability links')
        const token = fragment(new URL(voterLink), '/poll/voter')
        const optOut = fragment(new URL(optOutLink), '/poll/reminder-opt-out')
        tokens.push(token, optOut)
        knownCredentials.push(token, optOut)
        const verified = await rest(`${publicPath}/verify`, { token })
        expect(verified.status).toBe(200)
        const { voter, votingToken } = verified.body as z.infer<typeof VerifyMeetingPollOutput>
        expect(voter).toMatchObject({ ...invitee, status: 'verified' })
        expect(votingToken === null, 'already invited voter must not get a new token').toBe(true)
        const ballot = { token, votes, consent: true, expectedBallotRevision: 0 }
        if (index === 0) {
          expect(await rest(`${publicPath}/vote`, ballot, viewer.key)).toMatchObject({
            status: 403,
            body: { error: 'insufficient_scope' },
          })
          expect(await mcp('submit_meeting_poll_vote', ballot, viewer.key)).toMatchObject({
            ok: false,
            body: { error: 'insufficient_scope' },
          })
          expect(await cli('vote', ballot, viewer.key)).toMatchObject({
            status: 1,
            body: { error: 'insufficient_scope' },
          })
        }
        const result =
          index % zones.length === 0
            ? await rest(`${publicPath}/vote`, ballot)
            : index % zones.length === 1
              ? await mcp('submit_meeting_poll_vote', ballot, full.key)
              : await cli('vote', ballot)
        expect(result.body).toMatchObject({ voter, ballotRevision: 1, votes })
        ballots.push(result.body)
      }

      const resultPath = `${hostPath}/${id}/results`
      const results = await rest(resultPath, undefined, viewer.key)
      expect(results.status).toBe(200)
      const snapshot = results.body as z.infer<typeof MeetingPollResultsOutput>
      expect(snapshot.countedBallots).toBe(12)
      expect(snapshot.candidates).toEqual(
        candidates.map((slot) => ({
          ...slot,
          yes: 12,
          no: 0,
          ifNeedBe: 0,
          availability: 'available',
        })),
      )
      expect(await cli('results', { id }, viewer.key)).toMatchObject({
        status: 0,
        body: snapshot,
      })
      for (const ballot of ballots) {
        expect(
          snapshot.roster.find(({ voterId }) => voterId === ballot.voter.voterId),
        ).toMatchObject({
          timeZone: ballot.voter.timeZone,
          ballotRevision: 1,
          votes,
        })
      }

      const [bookerToken, , ...otherTokens] = tokens
      const [booker] = ballots
      assert(bookerToken && booker)
      const ownBallot = await cli('view', { token: bookerToken }, viewer.key)
      expect(ownBallot).toMatchObject({ status: 0, body: { ownBallot: booker, counts: null } })
      const credentials = [
        ...knownCredentials,
        createInput.idempotencyKey,
        invitation.idempotencyKey,
      ]
      expectNoCredentials(
        invited.responseText() +
          replayedInvite.responseText() +
          results.responseText() +
          ownBallot.responseText(),
        credentials,
      )
      expectNoCredentials(
        ownBallot.responseText(),
        invitees.slice(1).map(({ email }) => email),
      )
      expect(hasPrivatePollFields(ownBallot.responseText()), 'private ballot projection').toBe(
        false,
      )
      for (const message of mail) {
        const otherMailboxes = invitees
          .filter(({ email }) => email !== message.to)
          .map(({ email }) => email)
        expectNoCredentials(message.text + message.html, [
          publicToken,
          host.key,
          viewer.key,
          full.key,
          ...otherMailboxes,
        ])
        const own = invitees.findIndex(({ email }) => email === message.to)
        expectNoCredentials(
          message.text + message.html,
          tokens.filter((_, tokenIndex) => Math.floor(tokenIndex / 2) !== own),
        )
        expect(message.attachments ?? []).toHaveLength(0)
      }

      const finalizePath = `${hostPath}/${id}/finalize`
      const finalizeInput = (selected: typeof ballots, revision: number) => ({
        slotId: chosen.id,
        bookerVoterId: booker.voter.voterId,
        attendeeVoterIds: selected.map(({ voter }) => voter.voterId),
        expectedResultsRevision: revision,
        expectedBallotRevisions: Object.fromEntries(
          selected.map(({ voter, ballotRevision }) => [voter.voterId, ballotRevision]),
        ),
        acknowledgeConditional: false,
        idempotencyKey: randomUUID(),
      })
      const overLimit = finalizeInput(ballots, snapshot.resultsRevision)
      expect(await rest(finalizePath, overLimit, host.key)).toMatchObject({
        status: 400,
        body: { error: 'too_many_guests' },
      })
      expect(await mcp('finalize_meeting_poll', { id, ...overLimit })).toMatchObject({
        ok: false,
        body: { error: 'too_many_guests' },
      })
      expect(await cli('finalize', { id, ...overLimit })).toMatchObject({
        status: 1,
        body: { error: 'too_many_guests' },
      })
      const selected = ballots.slice(0, 11)
      const stale = finalizeInput(selected, snapshot.resultsRevision)
      const lastToken = otherTokens.at(-2)
      assert(lastToken)
      expect(
        await rest(`${publicPath}/vote`, {
          token: lastToken,
          votes: [
            { slotId: chosen.id, value: 'yes' },
            { slotId: alternative.id, value: 'no' },
          ],
          consent: true,
          expectedBallotRevision: 1,
        }),
      ).toMatchObject({ status: 200, body: { ballotRevision: 2 } })
      expect(await rest(finalizePath, stale, host.key)).toMatchObject({
        status: 409,
        body: { error: 'poll_changed' },
      })
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', eventTypeId)
          .execute(),
      ).toEqual([])
      const refreshed = await rest(resultPath, undefined, viewer.key)
      expect(refreshed.status).toBe(200)
      const current = finalizeInput(selected, refreshed.body.resultsRevision)
      expect(await cli('finalize', { id, ...current }, viewer.key)).toMatchObject({
        status: 1,
        body: { error: 'insufficient_scope' },
      })
      // Start the CLI while MCP holds the poll lock, before the MCP booking can commit.
      const [first, second] = await collideFinalizeWrites(
        db,
        () => mcp('finalize_meeting_poll', { id, ...current }),
        () => cli('finalize', { id, ...current }),
      )
      if (!('value' in first)) throw first.error
      if (!('value' in second)) throw second.error
      const mcpFinal = first.value
      const cliFinal = second.value
      expect(mcpFinal.ok).toBe(true)
      expect(cliFinal.status).toBe(0)
      const final = mcpFinal.body as z.infer<typeof FinalizeMeetingPollOutput>
      expect(final.replayed).toBe(false)
      expect(final.booking).toEqual({
        id: expect.any(String),
        eventTypeId,
        status: 'confirmed',
        source: 'mcp',
        start: new Date(chosen.startAt).toISOString(),
        end: new Date(chosen.endAt).toISOString(),
      })
      expect(final.poll).toMatchObject({
        status: 'scheduled',
        bookingId: final.booking.id,
        chosenSlotId: chosen.id,
        source: 'api',
      })
      expect(cliFinal.body).toEqual({ ...final, replayed: true })
      const restReplay = await rest(finalizePath, current, host.key)
      expect(restReplay).toMatchObject({ status: 200, body: { ...final, replayed: true } })
      expect(
        await rest(finalizePath, { ...current, slotId: alternative.id }, host.key),
      ).toMatchObject({
        status: 409,
        body: { error: 'idempotency_key_reused' },
      })
      expect(
        await rest(finalizePath, { ...current, idempotencyKey: randomUUID() }, host.key),
      ).toMatchObject({
        status: 409,
        body: { error: 'poll_already_scheduled' },
      })
      const finalizeResponses =
        mcpFinal.responseText() + cliFinal.responseText() + restReplay.responseText()
      expectNoCredentials(finalizeResponses, [...credentials, current.idempotencyKey])
      const booking = await db
        .selectFrom('bookings')
        .select(['id', 'source', 'api_key_id', 'oauth_consent_id'])
        .where('event_type_id', '=', eventTypeId)
        .execute()
      expect(booking).toEqual([
        { id: final.booking.id, source: 'mcp', api_key_id: host.id, oauth_consent_id: null },
      ])
      const attendees = await db
        .selectFrom('booking_attendees')
        .select(['email', 'is_booker', 'time_zone'])
        .where('booking_id', '=', final.booking.id)
        .execute()
      expect(attendees.map(({ email }) => email).sort()).toEqual(
        invitees
          .slice(0, 11)
          .map(({ email }) => email)
          .sort(),
      )
      expect(attendees.filter(({ is_booker }) => is_booker)).toEqual([
        { email: booker.voter.email, is_booker: true, time_zone: booker.voter.timeZone },
      ])
      const scheduled = await rest(`${publicPath}/read`, { token: publicToken })
      expect(scheduled).toMatchObject({
        status: 200,
        body: {
          id,
          status: 'scheduled',
          readOnly: true,
          chosenSlotId: chosen.id,
          counts: null,
          ownBallot: null,
        },
      })
      expect(hasPrivatePollFields(scheduled.responseText()), 'public outcome projection').toBe(
        false,
      )
      expectNoCredentials(scheduled.responseText(), credentials)
      expectNoCredentials(
        inspect(
          logs.flatMap((spy) => spy.mock.calls),
          { depth: null, maxArrayLength: null, maxStringLength: null },
        ),
        [...credentials, current.idempotencyKey, ...invitees.map(({ email }) => email)],
      )
      expect(urls.length).toBeGreaterThan(0)
      for (const target of urls) {
        const url = new URL(target)
        expect(url.origin === origin, 'poll request origin').toBe(true)
        expect(url.search === '' && url.hash === '', 'poll request URL').toBe(true)
        expectNoCredentials(target, credentials)
      }
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  it('replays create, rotation, close and cancel without redisclosing either link, even after deletion', async () => {
    const { host, rest, mcp, cli, create, knownCredentials } = await setup()
    const { poll, token: firstToken, input } = await create()
    const { id } = poll
    const path = `${hostPath}/${id}`
    const createReplay = () => rest(hostPath, input, host.key)
    const rotation = { id, expectedHostRevision: poll.hostRevision, idempotencyKey: randomUUID() }
    const rotated = await cli('rotate-link', rotation)
    expect(rotated.status).toBe(0)
    const { poll: afterRotation, publicLink } = rotated.body as z.infer<
      typeof MeetingPollLinkOutput
    >
    assert(publicLink)
    const secondToken = fragment(new URL(publicLink), '/poll')
    knownCredentials.push(secondToken)
    const replay = await mcp('rotate_meeting_poll_link', rotation)
    expect(replay).toMatchObject({ ok: false, body: { error: 'poll_link_already_rotated' } })
    expect(Object.hasOwn(replay.body, 'publicLink'), 'rotate replay must omit the link').toBe(false)
    expectNoCredentials(replay.responseText(), [firstToken, secondToken])
    const publicRead = (token: string) => rest(`${publicPath}/read`, { token })
    expect(await publicRead(firstToken)).toMatchObject({
      status: 404,
      body: { error: 'poll_not_found' },
    })
    expect(await publicRead(secondToken)).toMatchObject({
      status: 200,
      body: { id, status: 'open' },
    })

    const close = { expectedHostRevision: afterRotation.hostRevision }
    const closed = await rest(`${path}/close`, close, host.key)
    expect(closed).toMatchObject({ status: 200, body: { status: 'closed' } })
    expect(await mcp('close_meeting_poll', { id, ...close })).toMatchObject({
      ok: true,
      body: closed.body,
    })
    expect(await publicRead(secondToken)).toMatchObject({
      status: 200,
      body: { status: 'closed', readOnly: true },
    })
    const afterClose = await createReplay()
    expect(afterClose).toMatchObject({
      status: 409,
      body: { error: 'poll_already_created', pollId: id },
    })
    expectNoCredentials(afterClose.responseText(), [firstToken, secondToken])

    const cancellation = { id, expectedHostRevision: closed.body.hostRevision }
    const canceled = await cli('cancel', cancellation)
    expect(canceled).toMatchObject({ status: 0, body: { status: 'canceled' } })
    expect(await mcp('cancel_meeting_poll', cancellation)).toMatchObject({
      ok: true,
      body: canceled.body,
    })
    expect(await publicRead(secondToken)).toMatchObject({
      status: 200,
      body: { status: 'canceled', readOnly: true },
    })
    const afterCancel = await createReplay()
    expect(afterCancel).toMatchObject({
      status: 409,
      body: { error: 'poll_already_created', pollId: id },
    })
    expectNoCredentials(afterCancel.responseText(), [firstToken, secondToken])

    const deletion = { expectedHostRevision: canceled.body.hostRevision }
    const removed = await rest(path, deletion, host.key, 'DELETE')
    expect(removed.status).toBe(204)
    expect(await mcp('delete_meeting_poll', { id, ...deletion })).toMatchObject({
      ok: false,
      body: { error: 'poll_not_found' },
    })
    expect(await publicRead(secondToken)).toMatchObject({
      status: 404,
      body: { error: 'poll_not_found' },
    })
    const afterDelete = await createReplay()
    expect(afterDelete).toMatchObject({
      status: 409,
      body: { error: 'poll_already_created', pollId: null },
    })
    expect(Object.hasOwn(afterDelete.body, 'publicLink'), 'create replay must omit the link').toBe(
      false,
    )
    expectNoCredentials(afterDelete.responseText(), [firstToken, secondToken])
  })
})
