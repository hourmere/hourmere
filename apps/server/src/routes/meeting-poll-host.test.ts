import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import type { ApiKeyScope, Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFinalizeFixture } from '../../../../packages/scheduling/src/meeting-poll-finalize-fixture.ts'
import { createMeetingPoll } from '../../../../packages/scheduling/src/meeting-polls.ts'
import { meetingPollHostRoutes } from './meeting-poll-host.ts'
import {
  openApiDocument,
  PUBLIC_URL,
  productApp,
  responseAndRequestStrictness,
  syntheticSessionCookie,
} from './test-app.ts'

const path = '/api/v1/meeting-polls'
const item = (id: string) => `${path}/${id}`
const expectedOrganization = 'x-expected-organization-id'

describe('host meeting poll OpenAPI', () => {
  it('publishes all 13 host operations with strict bodies and extensible responses', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const operations = {
      [path]: ['get', 'post'],
      [item('{id}')]: ['get', 'delete'],
      [`${item('{id}')}/results`]: ['get'],
      [`${item('{id}')}/invitations`]: ['post'],
      [`${item('{id}')}/invitations/{voterId}/resend`]: ['post'],
      [`${item('{id}')}/voters/{voterId}`]: ['delete'],
      [`${item('{id}')}/remove-unverified`]: ['post'],
      [`${item('{id}')}/close`]: ['post'],
      [`${item('{id}')}/cancel`]: ['post'],
      [`${item('{id}')}/finalize`]: ['post'],
      [`${item('{id}')}/rotate-link`]: ['post'],
    }
    expect(
      Object.keys(doc.paths)
        .filter((key) => key.startsWith(path))
        .sort(),
    ).toEqual(Object.keys(operations).sort())
    for (const [route, methods] of Object.entries(operations)) {
      expect(Object.keys(doc.paths[route] ?? {}).sort()).toEqual([...methods].sort())
      for (const method of methods) {
        const operation = doc.paths[route]?.[method]
        expect(operation?.security).toEqual([{ apiKey: [] }, { session: [] }])
        expect(operation?.responses).toHaveProperty('401')
        expect(operation?.responses).toHaveProperty('403')
      }
    }
    expect(responseAndRequestStrictness(doc, Object.keys(operations))).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    const finalize = doc.paths[`${item('{id}')}/finalize`]?.post
    expect(finalize?.responses).toHaveProperty('201')
    expect(finalize?.responses).toHaveProperty('200')
    for (const route of [
      path,
      ...['invitations', 'invitations/{voterId}/resend', 'finalize', 'rotate-link'].map(
        (action) => `${item('{id}')}/${action}`,
      ),
    ])
      expect(doc.paths[route]?.post?.parameters).toContainEqual(
        expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
      )
    expect(doc.paths[item('{id}')]?.delete?.responses['204']?.content).toBeUndefined()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('host meeting poll REST on Postgres', () => {
  type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof productApp>
  let fixture: Fixture
  const principals = new Map<string, Principal>()

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'poll_host_rest',
    })
    db = createDb(owned.pool)
    fixture = await createFinalizeFixture(db)
    app = productApp(db, principals, [
      meetingPollHostRoutes({
        db,
        publicUrl: PUBLIC_URL,
        meetingPollSecret: fixture.ctx.meetingPollSecret,
      }),
    ])
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function key(scope: ApiKeyScope, principal = fixture.ctx.principal) {
    const { id } = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: principal.user.id,
        key: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        enabled: true,
        metadata: JSON.stringify({ scope, organizationId: principal.organization.id }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const token = `hm_${randomUUID()}`
    principals.set(token, { ...principal, kind: 'api_key', apiKeyId: id, apiKeyScope: scope })
    return { authorization: `Bearer ${token}` }
  }

  async function browser(principal: Principal = fixture.ctx.principal) {
    const row = await db
      .insertInto('auth.session')
      .values({
        userId: principal.user.id,
        token: randomUUID(),
        activeOrganizationId: principal.organization.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const cookieToken = randomUUID()
    principals.set(cookieToken, { ...principal, kind: 'session', sessionId: row.id })
    return {
      sessionId: row.id,
      headers: { cookie: syntheticSessionCookie(cookieToken), origin: PUBLIC_URL },
    }
  }

  async function createPoll() {
    return createMeetingPoll(fixture.ctx, {
      eventTypeId: fixture.eventTypeId,
      candidateStarts: fixture.poll.candidates.map(({ startAt }) => startAt),
      deadlineAt: fixture.poll.deadlineAt,
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    })
  }

  async function send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    const response = await app.request(url, {
      method,
      headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    expect(response.headers.get('cache-control')).toContain('no-store')
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  it('pages across service-created polls and keeps credentials out of metadata and results', async () => {
    const { poll, publicToken } = await createPoll()
    const read = await key('read')
    const first = await send('GET', `${path}?limit=1`, read)
    expect(first).toEqual({
      status: 200,
      body: { data: [poll], nextAfter: expect.any(String) },
    })
    const second = await send('GET', `${path}?limit=1&after=${first.body.nextAfter}`, read)
    expect(second).toEqual({
      status: 200,
      body: { data: [fixture.poll], nextAfter: null },
    })
    expect(await send('GET', `${path}?after=invalid`, read)).toEqual({
      status: 400,
      body: { error: 'invalid_cursor' },
    })
    expect(await send('GET', `${path}?limit=0`, read)).toEqual({
      status: 400,
      body: { error: 'invalid_limit' },
    })
    const detail = await send('GET', item(poll.id), read)
    expect(detail).toEqual({ status: 200, body: poll })
    const results = await send('GET', `${item(poll.id)}/results`, read)
    expect(results).toMatchObject({
      status: 200,
      body: {
        poll,
        resultsRevision: 1,
        countedBallots: 0,
        candidates: poll.candidates.map((candidate) => ({
          ...candidate,
          availability: 'available',
        })),
        roster: [],
      },
    })
    expect(publicToken).toBeTruthy()
    const payload = JSON.stringify([first, second, detail, results])
    expect(payload).not.toContain(publicToken)
    expect(payload).not.toMatch(/manageToken|publicToken|digest|settingsFingerprint/)
  })

  it('requires same-origin writes and a live matching session context before mutating', async () => {
    const { poll } = await createPoll()
    const { sessionId, headers } = await browser()
    const valid = { ...headers, [expectedOrganization]: fixture.organizationId }
    const target = `${item(poll.id)}/close`
    const revision = { expectedHostRevision: poll.hostRevision }
    const deniedContext = { status: 409, body: { error: 'organization_context_changed' } }
    expect(await send('POST', target, headers, revision)).toEqual(deniedContext)
    expect(
      await send('POST', target, { ...valid, origin: 'https://other.example' }, revision),
    ).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    const another = await createTestTeam(db, [{ user: fixture.owner, role: 'owner' }])
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: another.id })
      .where('id', '=', sessionId)
      .execute()
    expect(await send('POST', target, valid, revision)).toEqual(deniedContext)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: fixture.organizationId })
      .where('id', '=', sessionId)
      .execute()
    const closed = await send('POST', target, valid, revision)
    expect(closed).toMatchObject({
      status: 200,
      body: { id: poll.id, status: 'closed', hostRevision: poll.hostRevision + 1 },
    })
    expect(await send('POST', target, valid, revision)).toEqual(closed)
  })

  it('binds new polls and invitations to a same-origin session and its expected space', async () => {
    const { headers } = await browser()
    const createHeaders = { ...headers, 'idempotency-key': randomUUID() }
    const input = {
      eventTypeId: fixture.eventTypeId,
      candidateStarts: fixture.poll.candidates.map(({ startAt }) => startAt),
      deadlineAt: fixture.poll.deadlineAt,
      displayTimeZone: 'UTC',
      admissionMode: 'invited',
    }
    expect(await send('POST', path, createHeaders, input)).toEqual({
      status: 409,
      body: { error: 'organization_context_changed' },
    })
    const expectedSpace = { [expectedOrganization]: fixture.organizationId }
    const created = await send('POST', path, { ...createHeaders, ...expectedSpace }, input)
    expect(created).toMatchObject({
      status: 201,
      body: { poll: { organizationId: fixture.organizationId, source: 'web' }, publicLink: null },
    })
    const url = `${item(created.body.poll.id)}/invitations`
    const inviteHeaders = { ...headers, ...expectedSpace, 'idempotency-key': randomUUID() }
    const batch = { invitees: [{ name: 'Invitee', email: 'session-invitee@example.test' }] }
    expect(
      await send('POST', url, { ...inviteHeaders, origin: 'https://other.example' }, batch),
    ).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(await send('POST', url, inviteHeaders, batch)).toMatchObject({
      status: 202,
      body: { entries: [{ email: 'session-invitee@example.test', outcome: 'invited' }] },
    })
  })

  it('denies invalid bearer and read-key writes before validation or tenant lookup', async () => {
    const { poll } = await createPoll()
    const read = await key('read')
    const { headers } = await browser()
    const badBearer = { ...headers, authorization: 'Bearer hm_invalid' }
    expect(await send('GET', item(poll.id), badBearer)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    })
    const target = item(poll.id)
    for (const [method, url] of [
      ['POST', path],
      ['POST', `${target}/invitations`],
      ['POST', `${target}/invitations/${randomUUID()}/resend`],
      ['DELETE', `${target}/voters/${randomUUID()}`],
      ['POST', `${target}/remove-unverified`],
      ['POST', `${target}/rotate-link`],
      ['POST', `${target}/close`],
      ['POST', `${target}/cancel`],
      ['POST', `${target}/finalize`],
      ['DELETE', target],
    ] as const) {
      expect(await send(method, url, read, {})).toMatchObject({
        status: 403,
        body: { error: 'insufficient_scope' },
      })
    }
    const ordinaryMember = await key('full', fixture.memberCtx.principal)
    expect(await send('GET', target, ordinaryMember)).toEqual({
      status: 403,
      body: { error: 'team_management_access_denied' },
    })
    expect(await send('GET', target, read)).toMatchObject({
      status: 200,
      body: { status: 'open', hostRevision: poll.hostRevision },
    })
  })

  it('returns the same 404 for another organization’s polls and unknown IDs', async () => {
    const other = await createFinalizeFixture(db)
    const bookings = await key('bookings')
    const voter = await other.addVoter()
    const { id: _id, idempotencyKey, ...finalize } = await other.input([voter])
    const absent = randomUUID()
    const missing = { status: 404, body: { error: 'poll_not_found' } }
    for (const id of [other.poll.id, absent]) {
      const url = item(id)
      expect(await send('GET', url, bookings)).toEqual(missing)
      expect(await send('GET', `${url}/results`, bookings)).toEqual(missing)
      const revision = { expectedHostRevision: other.poll.hostRevision }
      expect(await send('POST', `${url}/close`, bookings, revision)).toEqual(missing)
      expect(await send('POST', `${url}/cancel`, bookings, revision)).toEqual(missing)
      expect(await send('DELETE', url, bookings, revision)).toEqual(missing)
      expect(
        await send(
          'POST',
          `${url}/finalize`,
          { ...bookings, 'idempotency-key': idempotencyKey },
          finalize,
        ),
      ).toEqual(missing)
    }
    expect(
      (await send('GET', path, bookings)).body.data.map(({ id }: { id: string }) => id),
    ).not.toContain(other.poll.id)
    expect(await other.revisions()).toMatchObject({ host_revision: other.poll.hostRevision })
  })

  it('cancels, finalizes, replays and deletes with only safe projections and revision enforcement', async () => {
    const { poll: cancelPoll } = await createPoll()
    const bookings = await key('bookings')
    const cancelUrl = `${item(cancelPoll.id)}/cancel`
    const cancelInput = { expectedHostRevision: cancelPoll.hostRevision }
    expect(
      await send('POST', cancelUrl, bookings, {
        expectedHostRevision: cancelPoll.hostRevision + 1,
      }),
    ).toEqual({
      status: 409,
      body: { error: 'poll_changed' },
    })
    const canceled = await send('POST', cancelUrl, bookings, cancelInput)
    expect(canceled).toMatchObject({ status: 200, body: { status: 'canceled' } })
    expect(await send('POST', cancelUrl, bookings, cancelInput)).toEqual(canceled)

    const voter = await fixture.addVoter({ value: 'if_need_be' })
    const { id, idempotencyKey, ...finalize } = await fixture.input([voter])
    const finalizeUrl = `${item(id)}/finalize`
    const headers = { ...bookings, 'idempotency-key': idempotencyKey }
    const changed = { status: 409, body: { error: 'poll_changed' } }
    expect(
      await send('POST', finalizeUrl, headers, {
        ...finalize,
        expectedResultsRevision: finalize.expectedResultsRevision - 1,
      }),
    ).toEqual(changed)
    expect(await send('POST', finalizeUrl, headers, finalize)).toEqual({
      status: 400,
      body: { error: 'poll_conditional_acknowledgment_required' },
    })
    const accepted = { ...finalize, acknowledgeConditional: true }
    const scheduled = await send('POST', finalizeUrl, headers, accepted)
    expect(scheduled).toMatchObject({
      status: 201,
      body: { poll: { id, status: 'scheduled' }, booking: { source: 'api' }, replayed: false },
    })
    expect(Object.keys(scheduled.body.booking).sort()).toEqual([
      'end',
      'eventTypeId',
      'id',
      'source',
      'start',
      'status',
    ])
    expect(await send('POST', finalizeUrl, headers, accepted)).toEqual({
      status: 200,
      body: { ...scheduled.body, replayed: true },
    })
    expect(
      await send('POST', finalizeUrl, { ...headers, 'idempotency-key': randomUUID() }, accepted),
    ).toEqual({
      status: 409,
      body: { error: 'poll_already_scheduled', poll: scheduled.body.poll },
    })
    const target = item(id)
    expect(
      await send('DELETE', target, bookings, { expectedHostRevision: fixture.poll.hostRevision }),
    ).toEqual(changed)
    expect(
      await send('DELETE', target, bookings, {
        expectedHostRevision: scheduled.body.poll.hostRevision,
      }),
    ).toEqual({ status: 204, body: null })
    expect(await send('GET', target, bookings)).toEqual({
      status: 404,
      body: { error: 'poll_not_found' },
    })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', scheduled.body.booking.id)
        .executeTakeFirst(),
    ).toBeDefined()
  })

  it('keeps malformed input and idempotency keys out of responses and diagnostics', async () => {
    const bookings = await key('bookings')
    const sentinel = 'synthetic-private-idempotency-key'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await send(
        'POST',
        `${item(fixture.poll.id)}/finalize`,
        {
          ...bookings,
          'idempotency-key': sentinel,
        },
        { [sentinel]: true },
      )
      expect(response).toEqual({ status: 400, body: { error: 'invalid_request' } })
      expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(sentinel)
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
})
