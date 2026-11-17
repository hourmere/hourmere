import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expireMeetingPollCapabilities } from './meeting-poll-capability-expiry.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import { MEETING_POLL_RETENTION } from './meeting-poll-policy.ts'
import { enrollMeetingPollVoter } from './meeting-poll-voters.ts'
import { createMeetingPoll } from './meeting-polls.ts'
import { createFixtures, createTestUser, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const secret = 'meeting-poll-expiry-test-secret-0123456789'
describe.skipIf(!serverUrl)('meeting poll capability expiry', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_expiry' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verify(expire: typeof expireMeetingPollCapabilities) {
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `expiry-${randomUUID().slice(0, 8)}`, time_zone: 'UTC' })
      .execute()
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const eventTypeId = await fixtures.eventType(owner.principal.organization.id, owner.id)
    const deadline = Temporal.Now.instant()
      .add({ hours: 24 })
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
    const created = await createMeetingPoll(
      testContext(db, {
        kind: 'session',
        sessionId: randomUUID(),
        user: owner.principal.user,
        organization: owner.principal.organization,
      }),
      {
        eventTypeId,
        candidateStarts: [25, 26].map((hours) => deadline.add({ hours }).toString()),
        deadlineAt: deadline.toString(),
        displayTimeZone: 'UTC',
        admissionMode: 'public_link',
        idempotencyKey: randomUUID(),
      },
    )
    for (let i = 0; i < 3; i++) {
      await enrollMeetingPollVoter(
        { db, meetingPollSecret: secret, trustedIp: '192.0.2.11' },
        {
          publicToken: created.publicToken as string,
          name: 'Voter',
          email: `expiry-${i}@example.test`,
          timeZone: 'UTC',
        },
      )
    }
    const all = await db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .where('poll_id', '=', created.poll.id)
      .orderBy('id')
      .execute()
    expect(all).toHaveLength(3)
    const ids = all.slice(0, 2).map((row) => row.id)
    await sql`UPDATE meeting_poll_capabilities SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = ANY(${ids}::uuid[])`.execute(
      db,
    )
    await expect(expire(db, `${secret}-wrong`)).rejects.toMatchObject({
      code: 'meeting_poll_key_mismatch',
    })
    const blocker = await owned.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query("SET LOCAL statement_timeout = '5s'")
      await blocker.query('SELECT id FROM meeting_polls WHERE id=$1 FOR UPDATE', [created.poll.id])
      expect(await expire(db, secret)).toEqual({ cleared: 0, more: false })
      await blocker.query('ROLLBACK')
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM meeting_poll_capabilities WHERE id=ANY($1::uuid[]) FOR UPDATE',
        [ids],
      )
      expect(await expire(db, secret)).toEqual({ cleared: 0, more: false })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    expect(await expire(db, secret, { limit: 1 })).toEqual({ cleared: 1, more: true })
    expect(await expire(db, secret, { limit: 1 })).toEqual({ cleared: 1, more: true })
    expect(await expire(db, secret)).toEqual({ cleared: 0, more: false })
    const after = await db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .where('poll_id', '=', created.poll.id)
      .orderBy('id')
      .execute()
    expect(after.map((row) => row.token_digest)).toEqual(all.map((row) => row.token_digest))
    expect(after.slice(0, 2).map((row) => row.capability_ciphertext)).toEqual([null, null])
    expect(after[2]?.capability_ciphertext).toEqual(all[2]?.capability_ciphertext)
    expect(after[2]?.capability_ciphertext).not.toBeNull()
    await expect(expire(db, secret, { limit: 501 })).rejects.toThrow(TypeError)
  }
  it('bounds pages, skips locked polls and children, preserves digests and refuses a mismatched key', async () => {
    await verify(expireMeetingPollCapabilities)
  }, 20_000)
  it('detects a source copy without the key fence', async () => {
    const original = readFileSync(
      new URL('./meeting-poll-capability-expiry.ts', import.meta.url),
      'utf8',
    )
    const fence = '    await ensureMeetingPollKey(trx, secret)\n'
    expect(original.split(fence)).toHaveLength(2)
    const source = stripTypeScriptTypes(original.replace(fence, ''))
      .replace(/^import .*\n/gm, '')
      .replace(/\bexport /g, '')
    const mutated = new Function(
      'sql',
      'ensureMeetingPollKey',
      'MEETING_POLL_RETENTION',
      `${source}; return expireMeetingPollCapabilities`,
    )(sql, ensureMeetingPollKey, MEETING_POLL_RETENTION)
    await expect(verify(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
  }, 20_000)
})
