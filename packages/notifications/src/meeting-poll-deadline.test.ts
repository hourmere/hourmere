import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupMeetingPolls,
  persistMeetingPollDeadlines,
} from '../../scheduling/src/meeting-poll-cleanup.ts'
import { ensureMeetingPollKey } from '../../scheduling/src/meeting-poll-key.ts'
import { deliverMeetingPollEmail, type MeetingPollEmailDeps } from './meeting-polls.ts'
import { rawMailCapture } from './testing/raw-mime.ts'

const serverUrl = process.env.DATABASE_URL
const DEADLINE = Temporal.Instant.from('2042-01-15T22:30:00Z')
const CREATED = DEADLINE.subtract({ hours: 48 }).toString()
const SECRET = 'test-only-meeting-poll-deadline-secret'
const PUBLIC_URL = 'https://poll.example.test'

describe.skipIf(!serverUrl)('meeting poll deadline closure and creator mail', () => {
  let owned: TestDatabase
  let db: Db
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  const pollIds: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_deadline' })
    db = createDb(owned.pool)
    await db.transaction().execute((trx) => ensureMeetingPollKey(trx, SECRET))
    capture = await rawMailCapture('polls@example.test')
  })
  afterEach(async () => {
    if (pollIds.length > 0)
      await db.deleteFrom('meeting_polls').where('id', 'in', pollIds.splice(0)).execute()
    if (capture) capture.sent.length = 0
  })
  afterAll(async () => {
    await capture?.close()
    await owned?.drop()
  })

  async function setup() {
    const fixtures = createFixtures(db)
    const creator = await createTestUser(db, 'Poll creator')
    const admin = await createTestUser(db, 'Another team admin')
    const team = await createTestTeam(db, [
      { user: creator, role: 'member, admin' },
      { user: admin, role: 'owner' },
    ])
    const event = await fixtures.eventType(team.id, null)
    async function poll(deadline = DEADLINE) {
      const row = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('meeting_polls')
          .values({
            organization_id: team.id,
            event_type_id: event,
            created_by_user_id: creator.id,
            title: 'Planning session',
            created_at: deadline.subtract({ hours: 48 }).toString(),
            updated_at: deadline.subtract({ hours: 48 }).toString(),
            deadline_at: deadline.toString(),
            display_time_zone: 'UTC',
            duration_minutes: 30,
            settings_snapshot: '{}',
            settings_fingerprint: Buffer.alloc(32),
            admission_mode: 'invited',
            host_revision: 9,
            results_revision: 6,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('meeting_poll_slots')
          .values(
            [0, 1].map((position) => {
              const start = deadline.add({ hours: position + 1 })
              return {
                organization_id: team.id,
                poll_id: inserted.id,
                position,
                start_at: start.toString(),
                end_at: start.add({ minutes: 30 }).toString(),
              }
            }),
          )
          .execute()
        return inserted
      })
      pollIds.push(row.id)
      return row
    }
    const removeCreator = () =>
      db
        .deleteFrom('auth.member')
        .where('organizationId', '=', team.id)
        .where('userId', '=', creator.id)
        .execute()
    return { creator, team, poll, removeCreator }
  }

  const current = (id: string) =>
    db.selectFrom('meeting_polls').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const deliveries = (id: string) =>
    db.selectFrom('meeting_poll_deliveries').selectAll().where('poll_id', '=', id).execute()
  const sweep = (at = DEADLINE, limit = 500) =>
    persistMeetingPollDeadlines(db, { now: () => at, limit })
  const send = (id: string, options: Partial<MeetingPollEmailDeps> = {}) =>
    deliverMeetingPollEmail(
      {
        db,
        meetingPollSecret: SECRET,
        secret: SECRET,
        publicUrl: PUBLIC_URL,
        mailer: capture.mailer,
        smtpConfigured: true,
        now: () => DEADLINE.add({ minutes: 1 }),
        mailMaxPerHour: 0,
        ...options,
      },
      { id },
    )

  it('closes at deadline equality, preserves revisions and sends one private notice to the creator', async () => {
    const fx = await setup()
    const poll = await fx.poll()
    await db
      .insertInto('meeting_poll_voters')
      .values(
        [true, false].map((responded, i) => ({
          organization_id: fx.team.id,
          poll_id: poll.id,
          name: 'Private voter',
          email: `hidden-${i}@example.test`,
          email_key: Buffer.alloc(32, i),
          time_zone: 'UTC',
          locale: 'en',
          created_at: CREATED,
          invited_at: CREATED,
          verified_at: responded ? CREATED : null,
          ballot_submitted_at: responded ? CREATED : null,
          join_consent_at: responded ? CREATED : null,
          responses: responded ? '{"answer":"private answer"}' : '{}',
        })),
      )
      .execute()
    expect(await sweep(DEADLINE.subtract({ microseconds: 1 }))).toEqual({ closed: 0, more: false })
    expect(await current(poll.id)).toMatchObject({ status: 'open', closed_at: null })
    expect(await deliveries(poll.id)).toEqual([])

    expect(await sweep()).toEqual({ closed: 1, more: false })
    expect(await current(poll.id)).toMatchObject({
      status: 'closed',
      closed_at: new Date(DEADLINE.toString()),
      host_revision: 9,
      results_revision: 6,
    })
    expect(await deliveries(poll.id)).toMatchObject([
      { kind: 'deadline_closed', host_user_id: fx.creator.id, voter_id: null, state: 'pending' },
    ])
    const [delivery] = await deliveries(poll.id)
    if (!delivery) throw new Error('Missing creator notice')
    // The mail uses the creator's current profile, including changes since closure.
    await db
      .insertInto('profiles')
      .values({
        user_id: fx.creator.id,
        handle: `poll-${randomUUID().slice(0, 8)}`,
        time_zone: 'Asia/Tokyo',
        locale: 'zh-CN',
      })
      .execute()
    await send(delivery.id)
    expect(await sweep(DEADLINE.add({ hours: 1 }))).toEqual({ closed: 0, more: false })
    await send(delivery.id)
    expect(await deliveries(poll.id)).toMatchObject([
      { state: 'sent', attempts: 1, capability_ciphertext: null },
    ])
    expect(capture.sent).toHaveLength(1)
    const [message] = capture.sent
    expect(message?.envelope).toEqual([fx.creator.email])
    expect(message?.decoded).toContain('Planning session')
    expect(message?.decoded).toContain('7:30')
    expect(message?.decoded).toContain('Asia/Tokyo')
    expect(message?.decoded).toContain('共收到 1 份答复。')
    expect(message?.decoded).toContain(`${PUBLIC_URL}/api/v1/meeting-polls/${poll.id}/results`)
    expect(message?.decoded).not.toMatch(/Private voter|hidden-[01]@|private answer|\/poll\/voter#/)
    expect(message?.ics).toBeUndefined()
  })

  it('bounds each page and skips a locked poll then closes it with the original deadline', async () => {
    const fx = await setup()
    const locked = await fx.poll(DEADLINE.subtract({ hours: 1 }))
    const other = await fx.poll()
    const another = await fx.poll()
    const trx = await db.startTransaction().execute()
    try {
      await trx
        .selectFrom('meeting_polls')
        .select('id')
        .where('id', '=', locked.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      expect(await sweep(DEADLINE, 2)).toEqual({ closed: 1, more: true })
      expect(await current(locked.id)).toMatchObject({ status: 'open' })
      expect(
        [await current(other.id), await current(another.id)].map((p) => p.status).sort(),
      ).toEqual(['closed', 'open'])
    } finally {
      await trx.rollback().execute()
    }
    expect(await sweep(DEADLINE, 2)).toEqual({ closed: 2, more: true })
    expect(await current(locked.id)).toMatchObject({
      closed_at: new Date(DEADLINE.subtract({ hours: 1 }).toString()),
      host_revision: 9,
    })
  })

  it('skips early closure and departure before enqueue or before send', async () => {
    const earlySpace = await setup()
    const early = await earlySpace.poll()
    await db
      .updateTable('meeting_polls')
      .set({ status: 'closed', closed_at: DEADLINE.subtract({ minutes: 2 }).toString() })
      .where('id', '=', early.id)
      .execute()
    const absentSpace = await setup()
    const absent = await absentSpace.poll()
    await absentSpace.removeCreator()
    const leavingSpace = await setup()
    const leaving = await leavingSpace.poll()
    expect(await sweep()).toEqual({ closed: 2, more: false })
    expect(await deliveries(early.id)).toEqual([])
    expect(await deliveries(absent.id)).toEqual([])
    expect(await current(absent.id)).toMatchObject({ status: 'closed' })
    const [delivery] = await deliveries(leaving.id)
    if (!delivery) throw new Error('Missing creator notice')
    await leavingSpace.removeCreator()
    await send(delivery.id)
    expect(capture.sent.length, 'departure before SMTP suppresses the old creator').toBe(0)
    expect(await deliveries(leaving.id)).toMatchObject([{ state: 'skipped', attempts: 0 }])
  })

  it('uses the hourly cleanup path and suppresses notices canceled before dispatch', async () => {
    const fx = await setup()
    const { at } = await db
      .selectNoFrom(sql<string>`(clock_timestamp() - interval '1 minute')::text`.as('at'))
      .executeTakeFirstOrThrow()
    const deadline = Temporal.Instant.from(new Date(at).toISOString())
    const poll = await fx.poll(deadline)
    await cleanupMeetingPolls(db)
    expect(await current(poll.id)).toMatchObject({ closed_at: new Date(deadline.toString()) })
    const [delivery] = await deliveries(poll.id)
    if (!delivery) throw new Error('Missing creator notice')
    await db
      .updateTable('meeting_polls')
      .set({ status: 'canceled', canceled_at: new Date() })
      .where('id', '=', poll.id)
      .execute()
    await send(delivery.id)
    expect(capture.sent).toEqual([])
    expect(await deliveries(poll.id)).toMatchObject([{ state: 'skipped', attempts: 0 }])
  })
})
