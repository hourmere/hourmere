import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  type InvitationEmailRequest,
  invitationEmailJob,
} from './invitation-email.ts'
import { deliverInvitationEmail, type InvitationEmailSenderDeps } from './invitation-sender.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://invitation.example.test'
type SenderJobs = ReturnType<typeof createJobs<readonly [ReturnType<typeof invitationEmailJob>]>>

/** Shorten only the lease in an isolated source copy; production modules remain untouched. */
async function senderWithLease(milliseconds: number) {
  const location = new URL('./invitation-sender.ts', import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.includes('const LEASE_MS = 120_000')).toBe(true)
  const javascript = stripTypeScriptTypes(
    source.replace('const LEASE_MS = 120_000', `const LEASE_MS = ${milliseconds}`),
  ).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as typeof import('./invitation-sender.ts')
}

describe.skipIf(!serverUrl)('invitation sender lease ownership with PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let queue: SenderJobs
  let inviterId: string
  let organizationId: string
  const workers: SenderJobs[] = []
  const send = vi.fn<InvitationEmailSenderDeps['mailer']['send']>()
  const deps = (overrides: Partial<InvitationEmailSenderDeps> = {}): InvitationEmailSenderDeps => ({
    db,
    publicUrl,
    secret: 'synthetic-invitation-lease-secret',
    smtpConfigured: true,
    mailer: { send },
    log() {},
    ...overrides,
  })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_lease' })
    db = createDb(owned.pool)
    queue = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob()] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log() {},
    })
    await queue.start()
  })

  beforeEach(async () => {
    await owned.pool.query('DELETE FROM pgboss.job')
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    send.mockReset().mockResolvedValue(undefined)
    inviterId = (
      await db
        .insertInto('auth.user')
        .values({ name: 'Synthetic inviter', email: 'inviter@example.test', emailVerified: true })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    organizationId = (
      await db
        .insertInto('auth.organization')
        .values({ name: 'Lease team', slug: 'lease-team', createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('auth.member')
      .values({ userId: inviterId, organizationId, role: 'owner', createdAt: new Date() })
      .execute()
  })

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  })

  afterAll(async () => {
    try {
      await queue?.stop()
      // One fixture pool and bounded queue/worker pools stay far below CI's limit of 100.
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(8)
    } finally {
      await owned?.drop()
    }
  })

  async function invitation(): Promise<InvitationEmailRequest> {
    const invitationId = randomUUID()
    await db
      .insertInto('auth.invitation')
      .values({
        id: invitationId,
        inviterId,
        organizationId,
        email: 'recipient@example.test',
        role: 'member',
        status: 'pending',
        createdAt: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .execute()
    await db
      .insertInto('invitation_deliveries')
      .values({ invitation_id: invitationId, generation: 1, state: 'queued', attempts: 0 })
      .execute()
    return { invitationId, generation: 1 }
  }

  const delivery = (invitationId: string) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', invitationId)
      .executeTakeFirstOrThrow()

  async function startWorker(overrides: Partial<InvitationEmailSenderDeps> = {}) {
    const worker = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob(deps(overrides))] as const,
      work: true,
      migrate: false,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log() {},
    })
    workers.push(worker)
    await worker.start()
    return worker
  }

  async function waitJob(id: string) {
    await expect
      .poll(
        async () =>
          (
            await owned.pool.query<{ state: string }>('SELECT state FROM pgboss.job WHERE id=$1', [
              id,
            ])
          ).rows[0]?.state,
        { timeout: 10_000, interval: 25 },
      )
      .toBe('completed')
  }

  /** The hook runs only after the selected real transaction COMMIT has completed. */
  function afterCommit(transactionNumber: number, hook: () => Promise<void>): Db {
    let commits = 0
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver)
        return () => {
          const builder = target.transaction()
          return new Proxy(builder, {
            get(transaction, key, transactionReceiver) {
              if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
              return async (callback: Parameters<typeof builder.execute>[0]) => {
                const result = await transaction.execute(callback)
                if (++commits === transactionNumber) await hook()
                return result
              }
            },
          })
        }
      },
    })
  }

  async function waitForTemplateLock() {
    await expect
      .poll(
        async () =>
          Number(
            (
              await owned.pool.query<{ count: string }>(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%profiles%'",
              )
            ).rows[0]?.count,
          ),
        { timeout: 5_000, interval: 10 },
      )
      .toBe(1)
  }

  async function leaseRemaining(invitationId: string) {
    const result = await owned.pool.query<{ milliseconds: number }>(
      'SELECT EXTRACT(EPOCH FROM (lease_until-clock_timestamp())) * 1000 AS milliseconds FROM invitation_deliveries WHERE invitation_id=$1',
      [invitationId],
    )
    return Number(result.rows[0]?.milliseconds)
  }

  it('does not let a stale SMTP completion overwrite the replacement polling worker claim', async () => {
    const payload = await invitation()
    const releaseOld = Promise.withResolvers<void>()
    const releaseNew = Promise.withResolvers<void>()
    const oldEntered = Promise.withResolvers<void>()
    const newEntered = Promise.withResolvers<void>()
    let calls = 0
    send.mockImplementation(async () => {
      if (++calls === 1) {
        oldEntered.resolve()
        await releaseOld.promise
      } else {
        newEntered.resolve()
        await releaseNew.promise
      }
    })
    const oldAttempt = deliverInvitationEmail(deps(), payload)
    let replacementJob: string | null = null
    try {
      await oldEntered.promise
      const first = await delivery(payload.invitationId)
      expect(first).toMatchObject({ state: 'sending', attempts: 1 })
      await db
        .updateTable('invitation_deliveries')
        .set({
          lease_until: sql`clock_timestamp() - INTERVAL '1 second'`,
          due_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        })
        .where('invitation_id', '=', payload.invitationId)
        .execute()
      await createInvitationEmailRepairer({ db, queue })()
      replacementJob = (await delivery(payload.invitationId)).last_job_id
      expect(replacementJob).toEqual(expect.any(String))
      await startWorker()
      await newEntered.promise
      const replacement = await delivery(payload.invitationId)
      expect(replacement).toMatchObject({ state: 'sending', attempts: 2, smtp_accepted_at: null })
      expect(replacement.lease_id).not.toBe(first.lease_id)
      releaseOld.resolve()
      await oldAttempt
      expect(
        await delivery(payload.invitationId),
        'the old lease cannot mark acceptance or clear the replacement lease',
      ).toEqual(replacement)
      releaseNew.resolve()
      await waitJob(replacementJob as string)
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'smtp_accepted',
        attempts: 2,
        lease_id: null,
      })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      releaseOld.resolve()
      releaseNew.resolve()
      await oldAttempt
      if (replacementJob) await waitJob(replacementJob)
    }
  }, 15_000)

  it('shortens SMTP timeout by time spent waiting for current template data', async () => {
    const payload = await invitation()
    const sender = await senderWithLease(6_000)
    const shutdown = new AbortController()
    const releaseSend = Promise.withResolvers<void>()
    const blocker = await owned.pool.connect()
    let locked = false
    let startedAt = 0
    let abortedAt = 0
    let remainingAtSend = 0
    send.mockImplementation(async (_, options) => {
      startedAt = performance.now()
      options?.signal?.addEventListener(
        'abort',
        () => {
          abortedAt = performance.now()
        },
        { once: true },
      )
      remainingAtSend = await leaseRemaining(payload.invitationId)
      await releaseSend.promise
    })
    const sending = sender.deliverInvitationEmail(
      deps({
        db: afterCommit(1, async () => {
          await blocker.query('BEGIN')
          await blocker.query('LOCK TABLE profiles IN ACCESS EXCLUSIVE MODE')
          locked = true
        }),
      }),
      payload,
      shutdown.signal,
    )
    try {
      await waitForTemplateLock()
      await expect
        .poll(() => leaseRemaining(payload.invitationId), { timeout: 5_000, interval: 25 })
        .toBeLessThanOrEqual(4_000)
      await blocker.query('COMMIT')
      locked = false
      await expect.poll(() => send.mock.calls.length, { timeout: 2_000, interval: 10 }).toBe(1)
      await expect.poll(() => abortedAt, { timeout: 4_500, interval: 25 }).toBeGreaterThan(0)
      await sending
      expect(remainingAtSend).toBeGreaterThan(2_000)
      expect(remainingAtSend).toBeLessThan(4_100)
      expect(
        abortedAt - startedAt,
        'SMTP must stop waiting before the remaining lease, including its safety margin',
      ).toBeLessThan(remainingAtSend - 500)
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error_code: 'transport_error',
      })
    } finally {
      if (locked) await blocker.query('ROLLBACK')
      blocker.release()
      shutdown.abort()
      releaseSend.resolve()
      await sending
    }
  }, 15_000)

  it('refuses to start SMTP when a template lock leaves less than a second of usable lease', async () => {
    const payload = await invitation()
    const sender = await senderWithLease(3_000)
    const blocker = await owned.pool.connect()
    let locked = false
    const sending = sender.deliverInvitationEmail(
      deps({
        db: afterCommit(1, async () => {
          await blocker.query('BEGIN')
          await blocker.query('LOCK TABLE profiles IN ACCESS EXCLUSIVE MODE')
          locked = true
        }),
      }),
      payload,
    )
    try {
      await waitForTemplateLock()
      await expect
        .poll(() => leaseRemaining(payload.invitationId), { timeout: 5_000, interval: 25 })
        .toBeLessThanOrEqual(1_600)
      expect(await leaseRemaining(payload.invitationId)).toBeGreaterThan(500)
      await blocker.query('COMMIT')
      locked = false
      await sending
      expect(send, 'a live lease alone does not leave enough time for SMTP').not.toHaveBeenCalled()
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error_code: 'interrupted',
      })
    } finally {
      if (locked) await blocker.query('ROLLBACK')
      blocker.release()
      await sending
    }
  }, 10_000)

  it('counts pre-SMTP transaction completion time before deciding whether to start SMTP', async () => {
    const payload = await invitation()
    const sender = await senderWithLease(3_000)
    let completedTransactions = 0
    await sender.deliverInvitationEmail(
      deps({
        db: afterCommit(2, async () => {
          // Message preparation has committed, but returning from the database layer
          // can still consume the usable budget before the caller starts SMTP.
          completedTransactions++
          await expect
            .poll(() => leaseRemaining(payload.invitationId), { timeout: 5_000, interval: 25 })
            .toBeLessThanOrEqual(1_600)
          expect(await leaseRemaining(payload.invitationId)).toBeGreaterThan(500)
        }),
      }),
      payload,
    )
    expect(completedTransactions).toBe(1)
    expect(
      send,
      'returning a prepared message does not preserve its earlier SMTP budget',
    ).not.toHaveBeenCalled()
    expect(await delivery(payload.invitationId)).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error_code: 'interrupted',
      lease_id: null,
      lease_until: null,
    })
  }, 10_000)

  it('records a template rendering failure with its fixed transport code and never retries it', async () => {
    const payload = await invitation()
    await createInvitationEmailDispatcher({ db, queue })(payload)
    await startWorker({ publicUrl: 'synthetic invalid instance origin' })
    const current = await delivery(payload.invitationId)
    await waitJob(current.last_job_id as string)
    const failed = await delivery(payload.invitationId)
    expect(failed).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error_code: 'transport_error',
      lease_id: null,
      lease_until: null,
    })
    await createInvitationEmailRepairer({ db, queue })()
    expect(await delivery(payload.invitationId)).toEqual(failed)
    expect(send).not.toHaveBeenCalled()
  })
})
