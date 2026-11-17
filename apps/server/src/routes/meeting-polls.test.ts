import '@hono/zod-openapi'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  inviteMeetingPollVoters,
  meetingPollCapabilityDigest,
  openMeetingPollCredential,
} from '../../../../packages/scheduling/src/meeting-poll-voters.ts'
import { createMeetingPoll } from '../../../../packages/scheduling/src/meeting-polls.ts'
import { meetingPollRoutes } from './meeting-polls.ts'
import { openApiDocument, productApp, responseAndRequestStrictness } from './test-app.ts'

const secret = 'synthetic-public-poll-route-test-secret'
const operations = [
  'read',
  'enroll',
  'recover',
  'verify',
  'vote',
  'withdraw',
  'reminder-opt-out',
] as const
const path = (operation: string) => `/api/v1/public/meeting-polls/${operation}`
const serverUrl = process.env.DATABASE_URL

describe('public meeting poll OpenAPI', () => {
  it('documents seven public POST operations, strict inputs, open responses and optional bearer errors', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(responseAndRequestStrictness(doc, operations.map(path))).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    for (const operation of operations) {
      expect(Object.keys(doc.paths[path(operation)] ?? {})).toEqual(['post'])
      expect(doc.paths[path(operation)]?.post?.security).toBeUndefined()
      expect(doc.paths[path(operation)]?.post?.responses).toHaveProperty('401')
      expect(doc.paths[path(operation)]?.post?.responses).toHaveProperty('403')
    }
  })
})

describe.skipIf(!serverUrl)('public meeting poll REST on Postgres', () => {
  let owned: TestDatabase
  let db: Db
  let app: ReturnType<typeof productApp>
  const principals = new Map<string, Principal>()
  let sequence = 0
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_rest' })
    db = createDb(owned.pool)
    app = productApp(db, principals, [meetingPollRoutes({ db, meetingPollSecret: secret })])
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function send(
    operation: string,
    body: unknown,
    bearer?: string,
    target = app,
    ip?: string,
  ) {
    const response = await target.request(
      path(operation),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      },
      {
        incoming: {
          socket: {
            remoteAddress: ip ?? `198.51.${Math.floor(++sequence / 250)}.${(sequence % 250) + 1}`,
          },
        },
      },
    )
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    }
  }
  async function poll(mode: 'public_link' | 'invited' = 'public_link') {
    const user = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        time_zone: 'UTC',
        handle: `poll-${randomBytes(6).toString('hex')}`,
      })
      .execute()
    const fixtures = createFixtures(db)
    await fixtures.schedule(user.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id)
    const ctx = {
      ...testContext(db, {
        kind: 'session',
        sessionId: randomUUID(),
        user: user.principal.user,
        organization: user.principal.organization,
      }),
      meetingPollSecret: secret,
    }
    const { rows } = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db)
    const deadline = Temporal.Instant.from((rows[0] as { at: Date }).at.toISOString())
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    const created = await createMeetingPoll(ctx, {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 24 }).toString(),
        deadline.add({ hours: 25 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'UTC',
      admissionMode: mode,
      idempotencyKey: randomUUID(),
    })
    return { ...created, ctx, user }
  }
  async function credential(pollId: string, email: string) {
    const row = await db
      .selectFrom('meeting_poll_capabilities as c')
      .innerJoin('meeting_poll_voters as v', 'v.id', 'c.voter_id')
      .select([
        'c.organization_id',
        'c.poll_id',
        'c.voter_id',
        'c.generation',
        'c.capability_ciphertext',
      ])
      .where('c.poll_id', '=', pollId)
      .where('v.email', '=', email)
      .where('c.revoked_at', 'is', null)
      .where('c.consumed_at', 'is', null)
      .orderBy('c.generation', 'desc')
      .executeTakeFirstOrThrow()
    return openMeetingPollCredential(
      secret,
      {
        organizationId: row.organization_id,
        pollId,
        voterId: row.voter_id,
        generation: row.generation,
      },
      row.capability_ciphertext,
    )?.token as string
  }

  it('serves the no-login verification, complete ballot, stale replay, withdrawal and read-only flow', async () => {
    const p = await poll()
    const read = await send('read', { token: p.publicToken })
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({
      id: p.poll.id,
      ownBallot: null,
      counts: null,
      readOnly: false,
    })
    for (const [header, value] of [
      ['cache-control', 'private, no-store'],
      ['referrer-policy', 'no-referrer'],
      ['x-robots-tag', 'noindex, nofollow'],
    ])
      expect(read.headers.get(header as string)).toBe(value)
    const enrollment = {
      publicToken: p.publicToken,
      name: 'Voter',
      email: 'voter@example.test',
      timeZone: 'UTC',
    }
    expect((await send('enroll', enrollment)).body).toEqual({ accepted: true })
    expect((await send('enroll', enrollment)).body).toEqual({ accepted: true })
    const verificationToken = await credential(p.poll.id, enrollment.email)
    const verified = await send('verify', { token: verificationToken })
    expect(verified.status).toBe(200)
    const token = verified.body.votingToken as string
    expect(typeof token).toBe('string')
    expect((await send('verify', { token: verificationToken })).body.votingToken).toBeNull()
    const vote = {
      token,
      votes: p.poll.candidates.map((candidate) => ({ slotId: candidate.id, value: 'yes' })),
      consent: true,
      expectedBallotRevision: 0,
    }
    expect((await send('vote', vote)).body).toMatchObject({ ballotRevision: 1, votes: vote.votes })
    expect((await send('vote', vote)).body).toMatchObject({ error: 'poll_changed' })
    expect((await send('read', { token })).body.ownBallot).toMatchObject({
      ballotRevision: 1,
      votes: vote.votes,
    })
    expect((await send('withdraw', { token, expectedBallotRevision: 1 })).body).toMatchObject({
      ballotRevision: 2,
      votes: [],
      voter: { status: 'withdrawn' },
    })
    expect((await send('withdraw', { token, expectedBallotRevision: 2 })).body).toMatchObject({
      ballotRevision: 2,
    })
    await db
      .updateTable('meeting_polls')
      .set({ status: 'closed', closed_at: new Date() })
      .where('id', '=', p.poll.id)
      .execute()
    expect((await send('read', { token })).body).toMatchObject({ status: 'closed', readOnly: true })
    expect((await send('vote', { ...vote, expectedBallotRevision: 2 })).body).toMatchObject({
      error: 'poll_closed',
    })
  })

  it('recovery needs no capability and answers identically for absent polls and mailboxes', async () => {
    const p = await poll('invited')
    await inviteMeetingPollVoters(p.ctx, {
      id: p.poll.id,
      invitees: [{ name: 'Invitee', email: 'recover@example.test' }],
      idempotencyKey: randomUUID(),
    })
    const original = await credential(p.poll.id, 'recover@example.test')
    for (const input of [
      { pollId: randomUUID(), email: 'recover@example.test' },
      { pollId: p.poll.id, email: 'absent@example.test' },
      { pollId: p.poll.id, email: 'recover@example.test' },
      { pollId: p.poll.id, email: 'recover@example.test' },
    ]) {
      const response = await send('recover', input)
      expect(response.status).toBe(202)
      expect(response.body).toEqual({ accepted: true })
    }
    expect(await credential(p.poll.id, 'recover@example.test')).toBe(original)
    const deliveries = await db
      .selectFrom('meeting_poll_deliveries')
      .select('id')
      .where('poll_id', '=', p.poll.id)
      .where('kind', '=', 'recovery')
      .execute()
    expect(deliveries).toHaveLength(1)
  })

  it('refuses supplied invalid bearers and read-key writes without anonymous fallback', async () => {
    const p = await poll()
    principals.set('read-key', {
      ...p.user.principal,
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'read',
    })
    const body = {
      publicToken: p.publicToken,
      name: 'Voter',
      email: 'blocked@example.test',
      timeZone: 'UTC',
    }
    expect((await send('enroll', body, 'invalid')).status).toBe(401)
    expect((await send('enroll', body, 'read-key')).status).toBe(403)
    expect((await send('read', { token: p.publicToken }, 'read-key')).status).toBe(200)
    expect(
      await db
        .selectFrom('meeting_poll_voters')
        .select('id')
        .where('poll_id', '=', p.poll.id)
        .execute(),
    ).toHaveLength(0)
  })

  it('full-capacity enrollment is uniform even for an already-known mailbox', async () => {
    const p = await poll()
    await inviteMeetingPollVoters(p.ctx, {
      id: p.poll.id,
      invitees: Array.from({ length: 40 }, (_, i) => ({
        name: `Voter ${i}`,
        email: `full-${i}@example.test`,
      })),
      idempotencyKey: randomUUID(),
    })
    for (const email of ['full-0@example.test', 'unknown@example.test']) {
      const response = await send('enroll', {
        publicToken: p.publicToken,
        name: 'Voter',
        email,
        timeZone: 'UTC',
      })
      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({ error: 'poll_full' })
    }
  })

  it('opt-out is purpose-limited and idempotent without granting ballot access', async () => {
    const p = await poll('invited')
    await inviteMeetingPollVoters(p.ctx, {
      id: p.poll.id,
      invitees: [{ name: 'Invitee', email: 'optout@example.test' }],
      idempotencyKey: randomUUID(),
    })
    const voter = await db
      .selectFrom('meeting_poll_voters')
      .select(['id', 'organization_id'])
      .where('poll_id', '=', p.poll.id)
      .executeTakeFirstOrThrow()
    const token = randomBytes(32).toString('base64url')
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        poll_id: p.poll.id,
        organization_id: voter.organization_id,
        voter_id: voter.id,
        purpose: 'reminder_opt_out',
        token_digest: meetingPollCapabilityDigest('reminder_opt_out', token),
        generation: 2,
        expires_at: new Date(p.poll.deadlineAt),
      })
      .execute()
    const first = await send('reminder-opt-out', { token })
    expect(first.status).toBe(200)
    expect((await send('reminder-opt-out', { token })).body).toEqual(first.body)
    expect((await send('read', { token })).body).toMatchObject({ error: 'poll_not_found' })
  })

  it('refuses every public operation under a mismatched installation key', async () => {
    const p = await poll()
    await send('enroll', {
      publicToken: p.publicToken,
      name: 'Voter',
      email: 'key@example.test',
      timeZone: 'UTC',
    })
    const wrong = productApp(db, principals, [
      meetingPollRoutes({ db, meetingPollSecret: 'wrong-secret' }),
    ])
    const token = await credential(p.poll.id, 'key@example.test')
    const inputs = {
      read: { token: p.publicToken },
      enroll: {
        publicToken: p.publicToken,
        name: 'Voter',
        email: 'key@example.test',
        timeZone: 'UTC',
      },
      recover: { pollId: p.poll.id, email: 'key@example.test' },
      verify: { token },
      vote: { token, votes: [], consent: true, expectedBallotRevision: 0 },
      withdraw: { token, expectedBallotRevision: 0 },
      'reminder-opt-out': { token },
    }
    for (const operation of operations) {
      const response = await send(operation, inputs[operation], undefined, wrong)
      expect(response.status, operation).toBe(503)
      expect(response.body).toEqual({ error: 'meeting_poll_key_mismatch' })
    }
  })

  it('shares admission rate limits across route instances and operations', async () => {
    const second = productApp(db, principals, [
      meetingPollRoutes({ db, meetingPollSecret: secret }),
    ])
    const input = { pollId: randomUUID(), email: 'rate@example.test' }
    for (let i = 0; i < 10; i++)
      expect(
        (await send('recover', input, undefined, i % 2 ? app : second, '203.0.113.222')).status,
      ).toBe(202)
    const refused = await send('verify', { token: 'unknown' }, undefined, second, '203.0.113.222')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('redacts database diagnostics on capability routes', async () => {
    const diagnostic = 'private-capability-and-mailbox@example.test'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const broken = productApp(
        {
          transaction() {
            throw new Error(diagnostic)
          },
        } as unknown as Db,
        principals,
        [
          meetingPollRoutes({
            db: {
              transaction() {
                throw new Error(diagnostic)
              },
            } as unknown as Db,
            meetingPollSecret: secret,
          }),
        ],
      )
      expect((await send('read', { token: diagnostic }, undefined, broken)).status).toBe(500)
      expect(JSON.stringify([...spy.mock.calls, ...warn.mock.calls])).not.toContain(diagnostic)
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})
