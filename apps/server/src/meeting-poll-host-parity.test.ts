import '@hono/zod-openapi'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { type ApiKeyScope, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { deliverMeetingPollEmail } from '@hourmere/notifications'
import { MEETING_POLL_LIMITS } from '@hourmere/scheduling'
import { createTestTeam } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFinalizeFixture } from '../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { createMeetingPoll } from '../../../packages/scheduling/src/meeting-polls.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollHostRoutes } from './routes/meeting-poll-host.ts'
import { meetingPollRoutes } from './routes/meeting-polls.ts'

const publicUrl = 'https://poll-parity.example.test'
const protocol = '2026-07-28'
const tools = {
  create: 'create_meeting_poll',
  list: 'list_meeting_polls',
  get: 'get_meeting_poll',
  results: 'get_meeting_poll_results',
  invite: 'invite_meeting_poll_voters',
  'resend-invitation': 'resend_meeting_poll_invitation',
  'remove-voter': 'remove_meeting_poll_voter',
  'remove-unverified': 'remove_unverified_meeting_poll_voters',
  'rotate-link': 'rotate_meeting_poll_link',
  close: 'close_meeting_poll',
  cancel: 'cancel_meeting_poll',
  delete: 'delete_meeting_poll',
  finalize: 'finalize_meeting_poll',
}
type Command = keyof typeof tools
type Json = Record<string, unknown>

function expectSafeResponse(text: string, input: Json, apiKey: string) {
  expect(text.includes(apiKey)).toBe(false)
  expect(
    /"(?:manageToken|manageUrl|voterToken|publicToken|capabilityCiphertext)"\s*:/.test(text),
  ).toBe(false)
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
    const deps = { db, publicUrl, meetingPollSecret: fixture.ctx.meetingPollSecret }
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      publicUrl,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [meetingPollHostRoutes(deps), meetingPollRoutes(deps)],
      mcp: mcpEndpoint({ tools: meetingPollHostTools(deps) }),
    })
    async function key(
      scope: ApiKeyScope,
      organizationId = fixture.organizationId,
      userId = fixture.owner.id,
    ) {
      return (
        await auth.api.createApiKey({
          body: { userId, metadata: { scope, organizationId } },
        })
      ).key
    }
    const bookings = await key('bookings')

    async function rest(command: Command, input: Json, apiKey = bookings) {
      const { id, voterId, idempotencyKey, ...body } = input
      const base = '/api/v1/meeting-polls'
      const suffix = {
        results: '/results',
        invite: '/invitations',
        'resend-invitation': `/invitations/${voterId}/resend`,
        'remove-voter': `/voters/${voterId}`,
        'remove-unverified': '/remove-unverified',
        'rotate-link': '/rotate-link',
        close: '/close',
        cancel: '/cancel',
        finalize: '/finalize',
      }
      const url = new URL(
        command === 'list' || command === 'create'
          ? base
          : `${base}/${id}${suffix[command as keyof typeof suffix] ?? ''}`,
        publicUrl,
      )
      const method = ['list', 'get', 'results'].includes(command)
        ? 'GET'
        : command === 'delete' || command === 'remove-voter'
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
      const retryAfter = response.headers.get('retry-after')
      return {
        status: response.status,
        body: response.status === 204 ? null : (JSON.parse(text) as Json),
        ...(retryAfter !== null && { retryAfterSeconds: Number(retryAfter) }),
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
      const restResult = await rest(command, input, apiKey)
      expect(restResult).toMatchObject({ status, body: { error } })
      const mcpResult = await mcp(command, input, apiKey)
      expect(mcpResult).toMatchObject({ status: status === 401 ? 401 : 200, body: { error } })
      const cliResult = await cli(command, input, apiKey)
      expect(cliResult).toMatchObject({ status: 1, body: { error } })
      return [restResult, mcpResult, cliResult]
    }
    function createInput(admissionMode = 'public_link') {
      return {
        eventTypeId: fixture.eventTypeId,
        candidateStarts: fixture.poll.candidates.map(({ startAt }) => startAt),
        deadlineAt: fixture.poll.deadlineAt,
        displayTimeZone: 'UTC',
        admissionMode,
        idempotencyKey: randomUUID(),
      }
    }
    async function publicRead(link: string) {
      const token = new URL(link).hash.slice(1)
      const response = await app.request(`${publicUrl}/api/v1/public/meeting-polls/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const text = await response.text()
      expect(text.includes(token)).toBe(false)
      return { status: response.status, body: JSON.parse(text) as Json }
    }
    function invitationDeliveries(id: string) {
      return db
        .selectFrom('meeting_poll_deliveries as delivery')
        .innerJoin('meeting_poll_voters as voter', 'voter.id', 'delivery.voter_id')
        .select([
          'delivery.id',
          'delivery.error_class',
          'delivery.generation',
          'delivery.state',
          'voter.email',
        ])
        .where('delivery.poll_id', '=', id)
        .where('delivery.kind', '=', 'invitation')
        .orderBy('voter.email')
        .orderBy('delivery.generation')
        .execute()
    }
    return {
      ...fixture,
      key,
      rest,
      mcp,
      cli,
      errorAcrossSurfaces,
      createInput,
      publicRead,
      invitationDeliveries,
    }
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

  it('discloses create and rotation links once and immediately invalidates the old link', async () => {
    const f = await setup()
    const input = f.createInput()
    const created = await f.rest('create', input)
    expect(created.status).toBe(201)
    expect(created.body?.poll).toMatchObject({
      eventTypeId: input.eventTypeId,
      status: 'open',
      source: 'api',
      createdByUserId: f.owner.id,
    })
    assert(created.body)
    const { id, hostRevision } = created.body.poll as { id: string; hostRevision: number }
    const firstLink = created.body.publicLink as string
    const first = new URL(firstLink)
    expect(first.origin + first.pathname).toBe(`${publicUrl}/poll`)
    expect(first.hash.length).toBeGreaterThan(1)
    expect(await f.publicRead(firstLink)).toMatchObject({ status: 200, body: { id } })

    const createReplay = await f.errorAcrossSurfaces('create', input, 409, 'poll_already_created')
    for (const { body } of createReplay) {
      expect(body?.pollId).toBe(id)
      expect(body).not.toHaveProperty('publicLink')
    }
    await f.errorAcrossSurfaces(
      'create',
      { ...input, visibility: 'aggregate' },
      409,
      'idempotency_key_reused',
    )
    const unoffered = Temporal.Instant.from(f.chosen.startAt).add({ minutes: 1 }).toString()
    for (const { body } of await f.errorAcrossSurfaces(
      'create',
      { ...f.createInput(), candidateStarts: [unoffered, f.alternative.startAt] },
      409,
      'slot_unavailable',
    )) {
      expect(body?.unavailableStarts).toEqual([unoffered])
    }
    for (const read of [f.rest, f.mcp, f.cli]) {
      const result = await read('get', { id })
      expect(JSON.stringify(result.body).includes(first.hash.slice(1))).toBe(false)
      expect(result.body).toEqual(created.body?.poll)
    }

    const rotation = { id, expectedHostRevision: hostRevision, idempotencyKey: randomUUID() }
    const rotated = await f.cli('rotate-link', rotation)
    expect(rotated.status).toBe(0)
    expect(rotated.body?.poll).toMatchObject({ id, hostRevision: hostRevision + 1 })
    const newLink = rotated.body.publicLink as string
    expect(newLink === firstLink).toBe(false)
    expect(await f.publicRead(firstLink)).toEqual({
      status: 404,
      body: { error: 'poll_not_found' },
    })
    expect(await f.publicRead(newLink)).toMatchObject({ status: 200, body: { id } })
    for (const { body } of await f.errorAcrossSurfaces(
      'rotate-link',
      rotation,
      409,
      'poll_link_already_rotated',
    )) {
      expect(body).not.toHaveProperty('publicLink')
    }
    await f.errorAcrossSurfaces(
      'rotate-link',
      { ...rotation, expectedHostRevision: hostRevision + 1 },
      409,
      'idempotency_key_reused',
    )
  })

  it('returns invitation outcomes, mails only supplied recipients and replays without more mail', async () => {
    const f = await setup()
    const id = f.poll.id
    const upgraded = await f.addVoter({ state: 'pending' })
    const unchanged = await f.addVoter({ state: 'invited' })
    const removed = await f.addVoter({ state: 'pending' })
    const fresh = 'fresh-invitee@example.test'
    const input = {
      id,
      invitees: [
        { name: 'Fresh Invitee', email: fresh.toUpperCase(), locale: 'zh-CN' },
        { name: upgraded.name, email: upgraded.email },
        { name: unchanged.name, email: unchanged.email },
      ],
      idempotencyKey: randomUUID(),
    }
    const accepted = await f.rest('invite', input)
    expect(accepted).toMatchObject({
      status: 202,
      body: {
        replayed: false,
        entries: [
          { email: fresh, outcome: 'invited', voterId: expect.any(String), status: 'invited' },
          { email: upgraded.email, outcome: 'upgraded', voterId: upgraded.id, status: 'invited' },
          {
            email: unchanged.email,
            outcome: 'unchanged',
            voterId: unchanged.id,
            status: 'invited',
          },
        ],
      },
    })
    const body = accepted.body as { entries: { voterId: string; outcome: string }[] }
    const voterId = body.entries[0]?.voterId as string
    const replay = {
      ...accepted.body,
      replayed: true,
      entries: body.entries.map((entry) => ({ ...entry, outcome: 'unchanged' })),
    }
    expect(await f.rest('invite', input)).toEqual({ status: 202, body: replay })
    expect(await f.mcp('invite', input)).toEqual({ status: 200, body: replay })
    expect(await f.cli('invite', input)).toEqual({ status: 0, body: replay })
    await f.errorAcrossSurfaces(
      'invite',
      { ...input, invitees: input.invitees.slice(1) },
      409,
      'idempotency_key_reused',
    )

    const mail: MailMessage[] = []
    const mailDeps = {
      db,
      publicUrl,
      meetingPollSecret: f.ctx.meetingPollSecret,
      secret: 'synthetic-mail-ledger-key',
      smtpConfigured: true,
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 1,
      mailer: { send: async (message: MailMessage) => void mail.push(message) },
    }
    const queued = await f.invitationDeliveries(id)
    const recipients = [fresh, upgraded.email].sort()
    expect(queued.map(({ email }) => email)).toEqual(recipients)
    for (const delivery of queued) await deliverMeetingPollEmail(mailDeps, delivery)
    expect(mail.map(({ to }) => to)).toEqual(recipients)
    for (const { text, to } of mail) {
      const credential = /\/poll\/voter#([\w-]+)/.exec(text)?.[1]
      if (!credential) throw new Error('Invitation did not contain a voting link')
      expect(text.includes(recipients.find((email) => email !== to) as string)).toBe(false)
      expect(JSON.stringify([accepted.body, replay]).includes(credential)).toBe(false)
    }

    const bulk = await f.cli('remove-unverified', {
      id,
      expectedHostRevision: (await f.revisions()).host_revision,
    })
    expect(bulk).toMatchObject({ status: 0, body: { removedVoterIds: [removed.id] } })
    const resend = {
      id,
      voterId,
      expectedHostRevision: (await f.revisions()).host_revision,
      idempotencyKey: randomUUID(),
    }
    const sent = await f.mcp('resend-invitation', resend)
    expect(sent).toMatchObject({ status: 200, body: { replayed: false, voterId } })
    expect(await f.rest('resend-invitation', resend)).toEqual({
      status: 202,
      body: { ...sent.body, replayed: true },
    })
    const cooled = await f.cli('resend-invitation', {
      ...resend,
      expectedHostRevision: (await f.revisions()).host_revision,
      idempotencyKey: randomUUID(),
    })
    expect(cooled).toMatchObject({
      status: 1,
      body: { error: 'rate_limited', retryAfterSeconds: expect.any(Number) },
    })
    const pending = (await f.invitationDeliveries(id)).filter(({ state }) => state === 'pending')
    expect(pending.map(({ email }) => email)).toEqual([fresh])
    for (const delivery of pending) await deliverMeetingPollEmail(mailDeps, delivery)
    expect(mail.map(({ to }) => to)).toEqual(recipients)
    expect(await f.invitationDeliveries(id)).toContainEqual(
      expect.objectContaining({
        email: fresh,
        state: 'suppressed',
        error_class: 'recipient_hourly_limit',
      }),
    )

    const remove = { id, voterId, expectedHostRevision: (await f.revisions()).host_revision }
    expect(await f.rest('remove-voter', remove)).toMatchObject({
      status: 200,
      body: { removedVoterIds: [voterId] },
    })
    await f.errorAcrossSurfaces('remove-voter', remove, 404, 'poll_not_found')
    expect((await f.mcp('results', { id })).body).toMatchObject({
      roster: expect.arrayContaining([
        expect.objectContaining({ voterId: upgraded.id }),
        expect.objectContaining({ voterId: unchanged.id }),
      ]),
    })
    expect(
      await db.selectFrom('meeting_poll_voters').select('id').where('poll_id', '=', id).execute(),
    ).toHaveLength(2)
  })

  it('requires current management authority and keeps foreign poll mutations opaque', async () => {
    const f = await setup()
    const other = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
    const otherKey = await f.key('full', other.id)
    const readKey = await f.key('read')
    const memberKey = await f.key('full', f.organizationId, f.member.id)
    const id = f.poll.id
    const revision = { id, expectedHostRevision: f.poll.hostRevision }
    const voterId = (await f.addVoter({ state: 'invited' })).id
    const requests = {
      create: f.createInput(),
      invite: {
        id,
        invitees: [{ name: 'Invitee', email: 'invitee@example.test' }],
        idempotencyKey: randomUUID(),
      },
      'resend-invitation': { ...revision, voterId, idempotencyKey: randomUUID() },
      'remove-voter': { ...revision, voterId },
      'remove-unverified': revision,
      'rotate-link': { ...revision, idempotencyKey: randomUUID() },
    }
    for (const command of Object.keys(requests) as (keyof typeof requests)[]) {
      const input = requests[command]
      await f.errorAcrossSurfaces(command, input, 403, 'insufficient_scope', readKey)
      await f.errorAcrossSurfaces(command, input, 403, 'team_management_access_denied', memberKey)
      await f.errorAcrossSurfaces(
        command,
        input,
        404,
        command === 'create' ? 'event_type_not_found' : 'poll_not_found',
        otherKey,
      )
    }
    expect(await f.rest('invite', { ...requests.invite, id: randomUUID() }, otherKey)).toEqual({
      status: 404,
      body: { error: 'poll_not_found' },
    })
    expect(await f.invitationDeliveries(id)).toEqual([])
    const invitedMode = await f.rest('create', f.createInput('invited'))
    expect(invitedMode.status).toBe(201)
    assert(invitedMode.body)
    const foreignPoll = invitedMode.body.poll as { id: string; hostRevision: number }
    await f.errorAcrossSurfaces(
      'rotate-link',
      {
        id: foreignPoll.id,
        expectedHostRevision: foreignPoll.hostRevision,
        idempotencyKey: randomUUID(),
      },
      404,
      'poll_not_found',
      otherKey,
    )

    async function setRole(role: string) {
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', f.organizationId)
        .where('userId', '=', f.member.id)
        .execute()
    }
    await setRole('admin')
    const invited = await f.mcp('invite', requests.invite, memberKey)
    expect(invited).toMatchObject({ status: 200, body: { replayed: false, poll: { id } } })
    const created = await f.mcp('create', requests.create, memberKey)
    expect(created).toMatchObject({
      status: 200,
      body: { poll: { source: 'mcp', createdByUserId: f.member.id } },
    })
    await setRole('member')
    await f.errorAcrossSurfaces(
      'create',
      requests.create,
      403,
      'team_management_access_denied',
      memberKey,
    )
    await f.errorAcrossSurfaces(
      'invite',
      requests.invite,
      403,
      'team_management_access_denied',
      memberKey,
    )
  })

  it('lets a personal event owner create invited polls without a public link', async () => {
    const f = await setup()
    const personal = f.owner.principal.organization.id
    await db
      .insertInto('profiles')
      .values({
        user_id: f.owner.id,
        handle: `poll-${randomUUID().slice(0, 18)}`,
        time_zone: 'UTC',
      })
      .execute()
    const eventTypeId = await f.fixtures.eventType(personal, f.owner.id)
    const full = await f.key('full', personal)
    const created = await f.cli('create', { ...f.createInput('invited'), eventTypeId }, full)
    expect(created).toMatchObject({
      status: 0,
      body: { poll: { organizationId: personal, admissionMode: 'invited' }, publicLink: null },
    })
    const { id, hostRevision } = created.body.poll as { id: string; hostRevision: number }
    await f.errorAcrossSurfaces(
      'rotate-link',
      { id, expectedHostRevision: hostRevision, idempotencyKey: randomUUID() },
      409,
      'poll_link_unavailable',
      full,
    )
  })

  it('shares host admission limits across adapters and keys before enqueuing invitation mail', async () => {
    const f = await setup()
    const created = await f.rest('create', f.createInput('invited'))
    expect(created.status).toBe(201)
    assert(created.body)
    const { id } = created.body.poll as { id: string }
    const approved = MEETING_POLL_LIMITS.admissionRequestsPerWindow - 1
    const transports = [
      [f.rest, 202],
      [f.mcp, 200],
      [f.cli, 0],
    ] as const
    for (let i = 0; i < approved; i++) {
      const [request, status] = transports[i % transports.length] as (typeof transports)[number]
      expect(
        await request('invite', {
          id,
          invitees: [{ name: 'Approved Invitee', email: `approved-${i}@example.test` }],
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({ status, body: { replayed: false } })
    }
    const alternateKey = await f.key('full')
    const [rest, mcp, cli] = await f.errorAcrossSurfaces(
      'invite',
      {
        id,
        invitees: [{ name: 'Blocked Invitee', email: 'blocked@example.test' }],
        idempotencyKey: randomUUID(),
      },
      429,
      'rate_limited',
      alternateKey,
    )
    expect(rest).toMatchObject({ retryAfterSeconds: expect.any(Number) })
    expect(mcp?.body).toMatchObject({ retryAfterSeconds: expect.any(Number) })
    expect(cli?.body).toMatchObject({ retryAfterSeconds: expect.any(Number) })
    expect((await f.invitationDeliveries(id)).map(({ email }) => email)).toEqual(
      Array.from({ length: approved }, (_, i) => `approved-${i}@example.test`).sort(),
    )
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
