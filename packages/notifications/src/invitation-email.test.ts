import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
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
const pollingProbe = defineJob({
  name: 'invitation-queue-polling-probe',
  payload: z.strictObject({}),
  async handler() {},
})

// Each mutation imports a source copy, leaving production files and other workers alone.
async function sourceCopy(replace?: { before: string; after: string }) {
  const location = new URL('./invitation-email.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (replace) {
    expect(source.includes(replace.before), 'mutation matches the intended protection').toBe(true)
    source = source.replace(replace.before, replace.after)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => `from '${import.meta.resolve(specifier)}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as typeof import('./invitation-email.ts')
}

describe.skipIf(!serverUrl)('invitation email queue and repair', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<
    typeof createJobs<readonly [ReturnType<typeof invitationEmailJob>, typeof pollingProbe]>
  >
  let organizationId: string
  let inviterId: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob(), pollingProbe] as const,
      work: true,
      pollingIntervalSeconds: 0.5,
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
    (
      await owned.pool.query('SELECT * FROM pgboss.job WHERE name=$1 ORDER BY created_on, id', [
        INVITATION_EMAIL_JOB,
      ])
    ).rows

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

  async function verifyUnconsumedGeneration(definition: ReturnType<typeof invitationEmailJob>) {
    const pollingJobs = createJobs({
      connectionString: owned.url,
      definitions: [definition, pollingProbe] as const,
      work: true,
      migrate: false,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: () => {},
    })
    try {
      await pollingJobs.start()
      const payload = await invitation()
      await createInvitationEmailDispatcher({ db, queue: pollingJobs })(payload)
      const before = await delivery(payload.invitationId)
      const repair = createInvitationEmailRepairer({ db, queue: pollingJobs })
      for (let pass = 0; pass < 3; pass += 1) {
        const probeId = await pollingJobs.enqueue(pollingProbe.name, {})
        await expect
          .poll(async () => {
            const result = await owned.pool.query<{ state: string }>(
              'SELECT state FROM pgboss.job WHERE id=$1',
              [probeId],
            )
            return result.rows[0]?.state
          })
          .toBe('completed')
        // Give each real invitation worker an entire additional polling interval.
        await new Promise((resolve) => setTimeout(resolve, 550))
        await repair()
        expect(
          (await jobRows()).map((row) => ({ id: row.id, state: row.state })),
          'one generation keeps exactly one created job across real worker polls and repairs',
        ).toEqual([{ id: before.last_job_id, state: 'created' }])
      }
      expect(await delivery(payload.invitationId)).toEqual(before)
    } finally {
      await pollingJobs.stop()
    }
  }

  it('keeps one unconsumed job per generation with real workers polling through three repairs', async () => {
    await verifyUnconsumedGeneration((await sourceCopy()).invitationEmailJob())
  }, 15_000)

  it('detects a completing placeholder consumer through the one-job-per-generation assertion', async () => {
    const copy = await sourceCopy({
      before: '    deleteAfterSeconds: 604800,\n  }',
      after: '    deleteAfterSeconds: 604800,\n    async handler() {},\n  }',
    })
    await expect(verifyUnconsumedGeneration(copy.invitationEmailJob())).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('one generation keeps exactly one created job'),
    })
  }, 15_000)

  it('creates exactly one replacement after pg-boss removes a created job at retention expiry', async () => {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
    const expiredId = (await delivery(payload.invitationId)).last_job_id as string
    await owned.pool.query(
      "UPDATE pgboss.job SET keep_until=pgboss.job_now() - INTERVAL '1 second' WHERE id=$1",
      [expiredId],
    )
    expect(await jobs.hasLiveInvitationEmailJob({ id: expiredId, ...payload })).toBe(false)
    const maintenance = new PgBoss({
      connectionString: owned.url,
      max: 1,
      migrate: false,
      supervise: false,
      schedule: false,
    })
    try {
      await maintenance.start()
      await maintenance.supervise(INVITATION_EMAIL_JOB)
    } finally {
      await maintenance.stop()
    }
    expect(await jobRows()).toEqual([])
    const repair = createInvitationEmailRepairer({ db, queue: jobs })
    await repair()
    await repair()
    const rows = await jobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ data: payload, state: 'created' })
    expect(rows[0].id).not.toBe(expiredId)
    expect((await delivery(payload.invitationId)).last_job_id).toBe(rows[0].id)
  })

  async function verifyRetainedExpiry(factory = createInvitationEmailRepairer) {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
    const expiredId = (await delivery(payload.invitationId)).last_job_id as string
    await owned.pool.query(
      "UPDATE pgboss.job SET keep_until=pgboss.job_now() - INTERVAL '1 second' WHERE id=$1",
      [expiredId],
    )
    await factory({ db, queue: jobs })()
    const rows = await jobRows()
    expect(
      rows.filter((row) => row.state === 'created'),
      'repair replaces an expired exclusive job before maintenance purges it',
    ).toHaveLength(1)
    expect(
      rows.find((row) => row.id === expiredId)?.state,
      'repair replaces an expired exclusive job before maintenance purges it',
    ).toBe('cancelled')
    expect((await delivery(payload.invitationId)).last_job_id).not.toBe(expiredId)
  }

  it('replaces a retained expired exclusive job without waiting for maintenance', async () => {
    await verifyRetainedExpiry()
  })

  it('detects missing retirement of the retained exclusive job in a source copy', async () => {
    const copy = await sourceCopy({
      before: 'await queue.retireExpiredInvitationEmailJobs(payload, trx)',
      after: 'void payload',
    })
    await expect(verifyRetainedExpiry(copy.createInvitationEmailRepairer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('repair replaces an expired exclusive job'),
    })
  })

  async function sending(attempts = 1, live = false, futureDue = false) {
    const payload = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({
        state: 'sending',
        attempts,
        lease_id: randomUUID(),
        lease_until: live
          ? sql`clock_timestamp() + INTERVAL '120 seconds'`
          : sql`clock_timestamp() - INTERVAL '1 second'`,
        due_at: futureDue
          ? sql`clock_timestamp() + INTERVAL '1 minute'`
          : sql`clock_timestamp() - INTERVAL '1 second'`,
      })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    return payload
  }

  it('does not steal a live sending lease even when its job is missing', async () => {
    const payload = await sending(1, true)
    const before = await delivery(payload.invitationId)
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await delivery(payload.invitationId)).toEqual(before)
    expect(await jobRows()).toEqual([])
  })

  it('waits for the old active job even after the sending lease expires', async () => {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
    const jobId = (await delivery(payload.invitationId)).last_job_id
    await owned.pool.query(
      "UPDATE pgboss.job SET state='active', started_on=pgboss.job_now() WHERE id=$1",
      [jobId],
    )
    await db
      .updateTable('invitation_deliveries')
      .set({
        state: 'sending',
        attempts: 1,
        lease_id: randomUUID(),
        lease_until: sql`clock_timestamp() - INTERVAL '1 second'`,
      })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    const before = await delivery(payload.invitationId)
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await delivery(payload.invitationId)).toEqual(before)
    expect((await jobRows()).map((row) => row.state)).toEqual(['active'])
  })

  it('preserves an abandoned claim attempt and backoff before scheduling its retry', async () => {
    const payload = await sending(2, false, true)
    const before = await delivery(payload.invitationId)
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await delivery(payload.invitationId)).toMatchObject({
      state: 'queued',
      attempts: 2,
      due_at: before.due_at,
      lease_id: null,
      lease_until: null,
      last_error_code: 'interrupted',
    })
    expect(await jobRows()).toEqual([])
  })

  async function verifyLastCrash(factory = createInvitationEmailRepairer) {
    const payload = await sending(4)
    await factory({ db, queue: jobs })()
    expect(
      (await delivery(payload.invitationId)).state,
      'the last abandoned attempt must fail without another job',
    ).toBe('failed')
    expect(await delivery(payload.invitationId)).toMatchObject({
      attempts: 4,
      last_error_code: 'attempts_exhausted',
    })
    expect(await jobRows()).toEqual([])
  }

  it('fails the last abandoned claim without granting another job', async () => {
    await verifyLastCrash()
  })

  it('detects crash recovery granting a fifth attempt in a source copy', async () => {
    const copy = await sourceCopy({
      before: 'const exhausted = delivery.attempts >= 4',
      after: 'const exhausted = delivery.attempts >= 5',
    })
    await expect(verifyLastCrash(copy.createInvitationEmailRepairer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('the last abandoned attempt'),
    })
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

  it('repairs a missing job without resetting attempt, due or error metadata', async () => {
    const payload = await invitation()
    await db
      .updateTable('invitation_deliveries')
      .set({ attempts: 2, last_error_code: 'transport_error', last_job_id: randomUUID() })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    const before = await delivery(payload.invitationId)
    await createInvitationEmailRepairer({ db, queue: jobs })()
    expect(await jobRows()).toHaveLength(1)
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
      'SELECT id, keep_until > clock_timestamp() AS retained FROM pgboss.job WHERE name=$1',
      [INVITATION_EMAIL_JOB],
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

  it.each(['canceled', 'accepted', 'rejected', 'expired'])(
    'repairer rereads %s invitations before considering their retained jobs',
    async (status) => {
      const payload = await invitation()
      await createInvitationEmailDispatcher({ db, queue: jobs })(payload)
      const before = await jobRows()
      await db
        .updateTable('auth.invitation')
        .set(
          status === 'expired'
            ? { expiresAt: sql`clock_timestamp() - INTERVAL '1 second'` }
            : { status },
        )
        .where('id', '=', payload.invitationId)
        .execute()
      const repair = createInvitationEmailRepairer({ db, queue: jobs })
      await repair()
      await repair()
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'skipped',
        last_error_code: 'invitation_ineligible',
        attempts: 0,
      })
      expect(await jobRows()).toEqual(before)
    },
  )

  it.each(['canceled', 'accepted', 'rejected', 'expired'])(
    'repairer skips an unqueued %s invitation without creating a job',
    async (status) => {
      const payload = await invitation({
        status: status === 'expired' ? 'pending' : status,
        expired: status === 'expired',
      })
      await createInvitationEmailRepairer({ db, queue: jobs })()
      expect((await delivery(payload.invitationId)).state).toBe('skipped')
      expect(await jobRows()).toEqual([])
    },
  )

  async function verifyStaleScan(factory = createInvitationEmailRepairer) {
    const payload = await invitation()
    const writer = await owned.pool.connect()
    let repairing: Promise<void> | undefined
    try {
      await writer.query('BEGIN')
      const blocker = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await writer.query('SELECT id FROM auth.invitation WHERE id=$1 FOR UPDATE', [
        payload.invitationId,
      ])
      repairing = factory({ db, queue: jobs })()
      await expect
        .poll(async () => {
          const blocked = await owned.pool.query<{ blocked: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
            [blocker.rows[0]?.pid],
          )
          return blocked.rows[0]?.blocked
        })
        .toBe(true)
      await writer.query('UPDATE invitation_deliveries SET generation=2 WHERE invitation_id=$1', [
        payload.invitationId,
      ])
      await writer.query('COMMIT')
      const before = await delivery(payload.invitationId)
      await repairing
      expect(
        await jobRows(),
        'a stale repair candidate cannot queue an obsolete generation',
      ).toEqual([])
      expect(await delivery(payload.invitationId)).toEqual(before)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      await repairing
    }
  }

  it('ignores a stale repair candidate without queuing it or changing its successor', async () => {
    await verifyStaleScan()
  })

  it('detects a repairer that trusts the scanned generation after waiting for its locks', async () => {
    const copy = await sourceCopy({
      before: 'if (!current || current.delivery.generation !== payload.generation) return false',
      after: 'if (!current) return false',
    })
    await expect(verifyStaleScan(copy.createInvitationEmailRepairer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('a stale repair candidate cannot queue'),
    })
  })

  async function verifyIneligibleRepair(factory = createInvitationEmailRepairer) {
    const payload = await invitation({ status: 'canceled' })
    await factory({ db, queue: jobs })()
    expect(
      (await delivery(payload.invitationId)).state,
      'repairer marks an ineligible generation skipped before queuing',
    ).toBe('skipped')
    expect(await jobRows()).toEqual([])
  }

  it('runs the unchanged source copy through the repairer eligibility assertion', async () => {
    await verifyIneligibleRepair((await sourceCopy()).createInvitationEmailRepairer)
  })

  it('detects repairer eligibility checks removed before queuing', async () => {
    const copy = await sourceCopy({
      before: "if (invitation.status !== 'pending' || !invitation.unexpired) {",
      after: 'if (false) {',
    })
    await expect(verifyIneligibleRepair(copy.createInvitationEmailRepairer)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('repairer marks an ineligible generation skipped'),
    })
  })

  it('deletion makes retained jobs harmless to the repairer', async () => {
    const payload = await invitation()
    await db.deleteFrom('auth.invitation').where('id', '=', payload.invitationId).execute()
    await createInvitationEmailRepairer({ db, queue: jobs })()
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
