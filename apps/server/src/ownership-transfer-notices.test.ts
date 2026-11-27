import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { Mailer, MailMessage } from '@hourmere/mail'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueOwnershipTransferNotice,
  type OwnershipTransferNoticeQueue,
  ownershipTransferNoticeJob,
} from './ownership-transfer-notices.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://transfer.example.test'
const teamName = 'Paper Kites'
type Notice = Parameters<OwnershipTransferNoticeQueue['enqueue']>[1]

describe.skipIf(!databaseUrl)('ownership transfer mail', () => {
  let owned: TestDatabase
  let db: Db
  let job: ReturnType<typeof ownershipTransferNoticeJob>
  let jobs: OwnershipTransferNoticeQueue & { stop(): Promise<void> }
  const send = vi.fn<Mailer['send']>(async () => {})

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = createDb(owned.pool)
    job = ownershipTransferNoticeJob({ db, publicUrl, mailer: { send } })
    const producer = createJobs({
      connectionString: owned.url,
      definitions: [job],
      migrate: true,
      work: false,
      maxConnections: 2,
    })
    await producer.start()
    jobs = producer
  })

  beforeEach(() => send.mockClear())

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture() {
    const initiator = await createTestUser(db)
    const target = await createTestUser(db)
    const otherOwner = await createTestUser(db)
    const team = await createTestTeam(
      db,
      [
        { user: initiator, role: 'owner' },
        { user: target, role: 'member' },
        { user: otherOwner, role: 'owner' },
      ],
      teamName,
    )
    return { initiator, target, otherOwner, organizationId: team.id }
  }

  async function queued(organizationId: string) {
    const result = await owned.pool.query<{ id: string; data: Notice }>(
      "SELECT id, data FROM pgboss.job WHERE name = $1 AND data->>'organizationId' = $2",
      [job.name, organizationId],
    )
    return result.rows
  }

  async function queueOffer({
    initiator,
    target,
    organizationId,
  }: Awaited<ReturnType<typeof fixture>>) {
    const members = db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organizationId)
    return db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('organization_ownership_transfers')
        .values({
          organization_id: organizationId,
          initiator_user_id: initiator.id,
          initiator_membership_id: members.where('userId', '=', initiator.id),
          target_user_id: target.id,
          target_membership_id: members.where('userId', '=', target.id),
          created_at: sql<Date>`clock_timestamp()`,
          expires_at: sql<Date>`clock_timestamp() + interval '24 hours'`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await enqueueOwnershipTransferNotice(jobs, trx, {
        organizationId,
        kind: 'offered',
        transferId: id,
        userIds: [target.id],
      })
      return id
    })
  }

  function deliver(data: Notice, id: string = randomUUID()) {
    return job.handler(data, { id, attempt: 1, signal: new AbortController().signal })
  }

  function expectSafeLink(message: MailMessage) {
    const link = new URL(message.text.trim().split('\n').at(-1) ?? '')
    expect(link.href).toBe(`${publicUrl}/app/settings#team-members`)
    expect(message.sensitive).toBe(true)
  }

  it('queues only the offer recipient and uses their live verified mailbox and admin language', async () => {
    const f = await fixture()
    const transferId = await queueOffer(f)
    const rows = await queued(f.organizationId)
    expect(rows.map(({ data }) => data)).toEqual([
      { kind: 'offered', organizationId: f.organizationId, transferId, userId: f.target.id },
    ])
    const liveMailbox = `${randomUUID()}@example.test`
    await db
      .updateTable('auth.user')
      .set({ email: liveMailbox })
      .where('id', '=', f.target.id)
      .execute()
    await db
      .insertInto('profiles')
      .values({
        user_id: f.target.id,
        handle: `u-${f.target.id}`,
        locale: 'zh-CN',
        time_zone: 'UTC',
      })
      .execute()

    for (const { id, data } of rows) await deliver(data, id)
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0]?.[0] as MailMessage
    expect(message).toMatchObject({ to: liveMailbox, subject: '团队所有权转移邀请' })
    expect(message.text).toContain(teamName)
    expect(message.text).not.toContain(transferId)
    expectSafeLink(message)
  })

  it('queues each completion recipient once and sends English when no admin language is set', async () => {
    const { organizationId, target, initiator, otherOwner } = await fixture()
    await db.transaction().execute((trx) =>
      enqueueOwnershipTransferNotice(jobs, trx, {
        organizationId,
        kind: 'confirmed',
        userIds: [target.id, otherOwner.id, initiator.id, target.id],
      }),
    )
    const rows = await queued(organizationId)
    expect(rows.map(({ data }) => data.userId).sort()).toEqual(
      [target.id, initiator.id, otherOwner.id].sort(),
    )
    for (const { id, data } of rows) await deliver(data, id)
    const messages = send.mock.calls.map(([message]) => message)
    expect(messages.map((message) => message.to).sort()).toEqual(
      [target.email, initiator.email, otherOwner.email].sort(),
    )
    for (const message of messages) {
      expect(message.subject).toBe('Team ownership transfer completed')
      expectSafeLink(message)
    }
  })

  it('rolls back previously enqueued mail and related writes when a recipient cannot be queued', async () => {
    const { organizationId, target, initiator } = await fixture()
    const failSecond: OwnershipTransferNoticeQueue = {
      enqueue: (name, data, options) =>
        data.userId === initiator.id ? Promise.resolve(null) : jobs.enqueue(name, data, options),
    }
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .updateTable('auth.organization')
          .set({ name: 'Changed team' })
          .where('id', '=', organizationId)
          .execute()
        await enqueueOwnershipTransferNotice(failSecond, trx, {
          organizationId,
          kind: 'confirmed',
          userIds: [target.id, initiator.id],
        })
      }),
    ).rejects.toThrow('Ownership transfer email could not be queued')
    expect(await queued(organizationId)).toEqual([])
    expect(
      await db
        .selectFrom('auth.organization')
        .select('name')
        .where('id', '=', organizationId)
        .executeTakeFirst(),
    ).toEqual({ name: teamName })
  })

  it('withholds mail for revoked offers, the wrong recipient, unverified accounts and deleted teams', async () => {
    const f = await fixture()
    const transferId = await queueOffer(f)
    const offered = {
      kind: 'offered',
      organizationId: f.organizationId,
      userId: f.target.id,
      transferId,
    } as const
    const confirmed = {
      kind: 'confirmed',
      organizationId: f.organizationId,
      userId: f.target.id,
    } as const
    await deliver({ ...offered, userId: f.otherOwner.id })
    await db
      .updateTable('organization_ownership_transfers')
      .set({ state: 'revoked', terminal_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', transferId)
      .execute()
    await deliver(offered)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.target.id)
      .execute()
    await deliver(confirmed)

    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', f.target.id)
      .execute()
    await db.deleteFrom('auth.organization').where('id', '=', f.organizationId).execute()
    await deliver(confirmed)
    expect(send).not.toHaveBeenCalled()
  })
})
