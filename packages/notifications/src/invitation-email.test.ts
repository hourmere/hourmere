import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, type JobRun } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  INVITATION_EMAIL_JOB,
  InvitationEmailPayload,
  type InvitationEmailQueue,
  InvitationEmailQueueError,
  invitationEmailJob,
  invitationEmailRepairJob,
} from './invitation-email.ts'

const serverUrl = process.env.DATABASE_URL
const run: JobRun = { id: randomUUID(), attempt: 1, signal: new AbortController().signal }

describe.skipIf(!serverUrl)('invitation email queue and repair', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<readonly [ReturnType<typeof invitationEmailJob>]>>
  let organizationId: string
  let inviterId: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob({ db })] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM pgboss.job')
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    const user = await db
      .insertInto('auth.user')
      .values({ name: 'Synthetic inviter', email: 'inviter@example.com', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    inviterId = user.id
    const organization = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic team', slug: 'synthetic-team', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    organizationId = organization.id
  })
  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function invitation(options: { id?: string; status?: string; expired?: boolean } = {}) {
    const row = await db
      .insertInto('auth.invitation')
      .values({
        id: options.id ?? randomUUID(),
        inviterId,
        organizationId,
        email: 'invitee@example.com',
        role: 'member',
        status: options.status ?? 'pending',
        expiresAt: options.expired
          ? sql`clock_timestamp() - INTERVAL '1 second'`
          : sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('invitation_deliveries')
      .values({ invitation_id: row.id, state: 'queued' })
      .execute()
    return { invitationId: row.id, generation: 1 }
  }
  const delivery = (invitationId: string) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', invitationId)
      .executeTakeFirstOrThrow()
  const jobRows = async () =>
    (await owned.pool.query('SELECT * FROM pgboss.job ORDER BY created_on, id')).rows

  it('queues only the exact identity and exclusive key with application-owned retries', async () => {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
    const rows = await jobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: INVITATION_EMAIL_JOB,
      data: payload,
      singleton_key: `invitation-email:v1:${payload.invitationId}:1`,
      policy: 'exclusive',
      retry_limit: 0,
      expire_seconds: 180,
      deletion_seconds: 604800,
    })
    expect(rows[0].keep_until.getTime() - rows[0].start_after.getTime()).toBe(86400_000)
    expect((await delivery(payload.invitationId)).last_job_id).toBe(rows[0].id)
    expect(
      InvitationEmailPayload.safeParse({ ...payload, email: 'private@example.com' }).success,
    ).toBe(false)
  })

  it('does not enqueue when repair finds the retained current live job, across repeated runs', async () => {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
    const enqueue = vi.fn(jobs.enqueue.bind(jobs))
    const repair = createInvitationEmailRepairer({ db, queue: { ...jobs, enqueue } })
    await repair()
    await repair()
    expect(enqueue).not.toHaveBeenCalled()
    expect(await jobRows()).toHaveLength(1)
  })

  it('preserves the committed due row on queue failure, then repairs it once', async () => {
    const payload = await invitation()
    const before = await delivery(payload.invitationId)
    const failing: InvitationEmailQueue = {
      ...jobs,
      enqueue: async () => {
        throw new Error('synthetic private database details')
      },
    }
    const failed = createInvitationEmailDispatcher({ db, queue: failing })(payload)
    await expect(failed).rejects.toBeInstanceOf(InvitationEmailQueueError)
    await expect(failed).rejects.toThrow('invitation_email_queue_unavailable')
    await expect(failed).rejects.not.toHaveProperty('cause')
    expect(await delivery(payload.invitationId)).toEqual(before)
    const repair = createInvitationEmailRepairer({ db, queue: jobs })
    await repair()
    await repair()
    expect(await jobRows()).toHaveLength(1)
    expect((await delivery(payload.invitationId)).state).toBe('queued')
  })

  it('treats an exclusive conflict as failure and rolls back rather than trusting another job', async () => {
    const payload = await invitation()
    const occupied = await jobs.enqueue(INVITATION_EMAIL_JOB, payload, {
      singletonKey: `invitation-email:v1:${payload.invitationId}:1`,
    })
    const before = await delivery(payload.invitationId)
    await expect(createInvitationEmailDispatcher({ db, queue: jobs })(payload)).rejects.toThrow(
      'invitation_email_queue_unavailable',
    )
    expect(await delivery(payload.invitationId)).toEqual(before)
    expect((await jobRows()).map((row) => row.id)).toEqual([occupied])
  })

  it('rolls back the job when retaining its identity cannot commit', async () => {
    const payload = await invitation()
    const before = await delivery(payload.invitationId)
    await owned.pool.query(`
      CREATE FUNCTION fail_invitation_job_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`)
    await owned.pool.query(`
      CREATE CONSTRAINT TRIGGER fail_invitation_job_commit
      AFTER UPDATE ON invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fail_invitation_job_commit()`)
    try {
      await expect(createInvitationEmailDispatcher({ db, queue: jobs })(payload)).rejects.toThrow(
        'invitation_email_queue_unavailable',
      )
      expect(await jobRows()).toEqual([])
      expect(await delivery(payload.invitationId)).toEqual(before)
    } finally {
      await owned.pool.query('DROP TRIGGER fail_invitation_job_commit ON invitation_deliveries')
      await owned.pool.query('DROP FUNCTION fail_invitation_job_commit()')
    }
  })

  it('repairs a missing or finished job without resetting attempt, due or error metadata', async () => {
    const payload = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ attempts: 2, last_error_code: 'transport_error', last_job_id: randomUUID() })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    const before = await delivery(payload.invitationId)
    await createInvitationEmailRepairer({ db, queue: jobs })()
    const first = (await jobRows())[0]
    await owned.pool.query(
      "UPDATE pgboss.job SET state='completed', completed_on=clock_timestamp() WHERE id=$1",
      [first.id],
    )
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await jobRows()).toHaveLength(2)
    expect(await delivery(payload.invitationId)).toMatchObject({
      attempts: before.attempts,
      due_at: before.due_at,
      updated_at: before.updated_at,
      last_error_code: before.last_error_code,
      state: 'queued',
    })
  })

  it('gives an overdue repaired job fresh retention without changing delivery metadata', async () => {
    const payload = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({
        due_at: sql`clock_timestamp() - INTERVAL '2 days'`,
        attempts: 2,
        last_error_code: 'transport_error',
      })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    const before = await delivery(payload.invitationId)
    const repair = createInvitationEmailRepairer({ db, queue: jobs })
    await repair()
    const rows = await owned.pool.query<{ id: string; retained: boolean }>(
      'SELECT id, keep_until > clock_timestamp() AS retained FROM pgboss.job',
    )
    expect(rows.rows).toEqual([{ id: expect.any(String), retained: true }])
    const id = rows.rows[0]?.id as string
    expect(await jobs.hasLiveInvitationEmailJob({ id, ...payload })).toBe(true)
    await repair()
    expect((await jobRows()).map((row) => row.id)).toEqual([id])
    expect(await delivery(payload.invitationId)).toEqual({ ...before, last_job_id: id })
  })

  it('bounds batches and advances failed candidates before wrapping fairly', async () => {
    const payloads = []
    for (let n = 1; n <= 102; n += 1) {
      payloads.push(
        await invitation({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }),
      )
    }
    const visited: string[] = []
    const repair = createInvitationEmailRepairer({
      db,
      queue: {
        ...jobs,
        enqueue: async (_name, payload) => {
          visited.push(payload.invitationId)
          throw new Error('synthetic unavailable queue')
        },
      },
    })
    await repair()
    expect(visited).toEqual(payloads.slice(0, 100).map((payload) => payload.invitationId))
    await repair()
    expect(visited).toEqual(payloads.map((payload) => payload.invitationId))
    await repair()
    expect(visited.slice(102)).toEqual(
      payloads.slice(0, 100).map((payload) => payload.invitationId),
    )
  })

  it('does not select future due rows or terminal tombstones', async () => {
    const future = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ due_at: sql`clock_timestamp() + INTERVAL '1 hour'` })
      .where('invitation_id', '=', future.invitationId)
      .execute()
    for (const state of ['failed', 'skipped']) {
      const payload = await invitation()
      await db
        .updateTable('invitation_deliveries')
        .set({ state, last_error_code: 'invitation_ineligible' })
        .where('invitation_id', '=', payload.invitationId)
        .execute()
    }
    const missing = await invitation()
    await db
      .deleteFrom('invitation_deliveries')
      .where('invitation_id', '=', missing.invitationId)
      .execute()
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await jobRows()).toEqual([])
    expect(invitationEmailRepairJob(async () => {}).schedule).toEqual({
      cron: '* * * * *',
      payload: {},
    })
  })

  it('rechecks the due time under its locks after the repair scan waits for a writer', async () => {
    const payload = await invitation()
    const writer = await owned.pool.connect()
    let repairing: Promise<void> | undefined
    try {
      await writer.query('BEGIN')
      const blocker = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await writer.query('SELECT id FROM auth.invitation WHERE id=$1 FOR UPDATE', [
        payload.invitationId,
      ])
      repairing = createInvitationEmailRepairer({ db, queue: jobs })()
      const deadline = Date.now() + 5000
      while (true) {
        const blocked = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
          [blocker.rows[0]?.pid],
        )
        if (blocked.rows[0]?.blocked) break
        if (Date.now() >= deadline) throw new Error('repair did not wait for the invitation lock')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await writer.query(
        "UPDATE invitation_deliveries SET due_at=clock_timestamp() + INTERVAL '1 hour' WHERE invitation_id=$1",
        [payload.invitationId],
      )
      await writer.query('COMMIT')
      await repairing
      expect(await jobRows()).toEqual([])
      expect((await delivery(payload.invitationId)).last_job_id).toBeNull()
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      await repairing
    }
  })

  it.each(['canceled', 'accepted', 'rejected'])(
    'worker rereads %s status after enqueue and marks the current row skipped',
    async (status) => {
      const payload = await invitation()
      await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
      await db
        .updateTable('auth.invitation')
        .set({ status })
        .where('id', '=', payload.invitationId)
        .execute()
      await invitationEmailJob({ db }).handler(payload, run)
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'skipped',
        last_error_code: 'invitation_ineligible',
        attempts: 0,
      })
    },
  )

  it('worker rereads expiry and does not alter a current pending row', async () => {
    const pending = await invitation()
    const before = await delivery(pending.invitationId)
    await invitationEmailJob({ db }).handler(pending, run)
    expect(await delivery(pending.invitationId)).toEqual(before)
    const expired = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: sql`clock_timestamp() - INTERVAL '1 second'` })
      .where('id', '=', expired.invitationId)
      .execute()
    await invitationEmailJob({ db }).handler(expired, run)
    expect((await delivery(expired.invitationId)).state).toBe('skipped')
  })

  it('stale jobs cannot overwrite the only current generation row, including canceled successors', async () => {
    const stale = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ generation: 2 })
      .where('invitation_id', '=', stale.invitationId)
      .execute()
    await db
      .updateTable('auth.invitation')
      .set({ status: 'canceled' })
      .where('id', '=', stale.invitationId)
      .execute()
    const before = await delivery(stale.invitationId)
    await invitationEmailJob({ db }).handler(stale, run)
    expect(await delivery(stale.invitationId)).toEqual(before)
    await invitationEmailJob({ db }).handler({ ...stale, generation: 2 }, run)
    expect((await delivery(stale.invitationId)).state).toBe('skipped')
  })

  it('deletion makes retained jobs harmless', async () => {
    const payload = await invitation()
    await db.deleteFrom('auth.invitation').where('id', '=', payload.invitationId).execute()
    await invitationEmailJob({ db }).handler(payload, run)
    await expect(createInvitationEmailDispatcher({ db, queue: jobs })(payload)).rejects.toThrow(
      'invitation_email_queue_unavailable',
    )
    expect(await jobRows()).toEqual([])
  })

  it('does not confirm missing, stale, ineligible or terminal rows as durably queued', async () => {
    const dispatch = createInvitationEmailDispatcher({ db, queue: jobs })
    for (const status of ['accepted', 'canceled', 'rejected']) {
      const payload = await invitation({ status })
      await expect(dispatch(payload)).rejects.toThrow('invitation_email_queue_unavailable')
      expect((await delivery(payload.invitationId)).state).toBe('skipped')
    }
    const expired = await invitation({ expired: true })
    await expect(dispatch(expired)).rejects.toThrow('invitation_email_queue_unavailable')
    expect((await delivery(expired.invitationId)).state).toBe('skipped')
    const stale = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ generation: 2 })
      .where('invitation_id', '=', stale.invitationId)
      .execute()
    await expect(dispatch(stale)).rejects.toThrow('invitation_email_queue_unavailable')
    expect((await delivery(stale.invitationId)).generation).toBe(2)
    const missing = await invitation()
    await db
      .deleteFrom('invitation_deliveries')
      .where('invitation_id', '=', missing.invitationId)
      .execute()
    await expect(dispatch(missing)).rejects.toThrow('invitation_email_queue_unavailable')
    const terminal = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ state: 'failed', last_error_code: 'legacy_delivery_unknown' })
      .where('invitation_id', '=', terminal.invitationId)
      .execute()
    await expect(dispatch(terminal)).rejects.toThrow('invitation_email_queue_unavailable')
    expect(await jobRows()).toEqual([])
  })
})
