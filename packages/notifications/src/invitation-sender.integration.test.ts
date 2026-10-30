import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import { invitationResendDenial } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob } from '@hourmere/jobs'
import { type MailMessage, MailRejectedError } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { listPendingInvitationDeliveries } from './invitation-deliveries.ts'
import {
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  INVITATION_EMAIL_JOB,
  type InvitationEmailRequest,
  invitationEmailJob,
} from './invitation-email.ts'
import { reserveInvitationEmailBudget } from './invitation-mail-limits.ts'
import type { deliverInvitationEmail, InvitationEmailSenderDeps } from './invitation-sender.ts'
import { lockNotificationEmailBudget } from './mail-limits.ts'

const serverUrl = process.env.DATABASE_URL
const secret = 'synthetic-invitation-sender-secret'
const publicUrl = 'https://invitation.example.test'
const pollingProbe = defineJob({
  name: 'invitation-sender-polling-probe',
  payload: z.strictObject({}),
  async handler() {},
})
type SenderJobs = ReturnType<
  typeof createJobs<readonly [ReturnType<typeof invitationEmailJob>, typeof pollingProbe]>
>

// Mutations run as isolated module copies; concurrent tests never see modified sources.
async function senderCopy(replacements: { before: string; after: string }[] = []) {
  const location = new URL('./invitation-sender.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement.before), 'mutation matches its intended protection').toBe(
      true,
    )
    source = source.replace(replacement.before, replacement.after)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as typeof import('./invitation-sender.ts')
}

describe.skipIf(!serverUrl)('invitation sender with PostgreSQL and polling pg-boss workers', () => {
  let owned: TestDatabase
  let db: Db
  let queue: SenderJobs
  let inviterId: string
  let organizationId: string
  const workers: SenderJobs[] = []
  const sent: MailMessage[] = []
  const logs: string[] = []
  const send = vi.fn<InvitationEmailSenderDeps['mailer']['send']>()
  const deps = (overrides: Partial<InvitationEmailSenderDeps> = {}): InvitationEmailSenderDeps => ({
    db,
    publicUrl,
    secret,
    smtpConfigured: true,
    mailer: { send },
    log: (line) => logs.push(line),
    ...overrides,
  })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_sender' })
    db = createDb(owned.pool)
    queue = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob(), pollingProbe] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log: (_, line) => logs.push(line),
    })
    await queue.start()
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM pgboss.job')
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('invitation_email_requests').execute()
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    sent.length = 0
    logs.length = 0
    send.mockReset().mockImplementation(async (message) => {
      sent.push(message)
    })
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
        .values({ name: 'Original team', slug: 'sender-team', createdAt: new Date() })
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
      // The fixture pool and two small jobs pools remain far below CI's 100 connections.
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(8)
    } finally {
      await owned?.drop()
    }
  })

  async function invitation(options: { attempts?: number; generation?: number } = {}) {
    const row = await db
      .insertInto('auth.invitation')
      .values({
        id: randomUUID(),
        inviterId,
        organizationId,
        email: 'original@example.test',
        role: 'member',
        status: 'pending',
        createdAt: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('invitation_deliveries')
      .values({
        invitation_id: row.id,
        state: 'queued',
        attempts: options.attempts ?? 0,
        generation: options.generation ?? 1,
        created_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        generation_started_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        updated_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
      })
      .execute()
    return { invitationId: row.id, generation: options.generation ?? 1 }
  }
  const delivery = (invitationId: string) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', invitationId)
      .executeTakeFirstOrThrow()
  const ledger = () => db.selectFrom('notification_email_sends').selectAll().execute()
  const dispatch = (payload: InvitationEmailRequest) =>
    createInvitationEmailDispatcher({ db, queue })(payload)
  const repair = () => createInvitationEmailRepairer({ db, queue })()

  async function startWorker(overrides: Partial<InvitationEmailSenderDeps> = {}) {
    const worker = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob(deps(overrides)), pollingProbe] as const,
      work: true,
      migrate: false,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: (_, line) => logs.push(line),
    })
    workers.push(worker)
    await worker.start()
    return worker
  }
  async function waitJob(id: string, state = 'completed') {
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
      .toBe(state)
  }
  async function waitCurrentJob(payload: InvitationEmailRequest, state = 'completed') {
    const current = await delivery(payload.invitationId)
    expect(current.last_job_id).toEqual(expect.any(String))
    await waitJob(current.last_job_id as string, state)
    return delivery(payload.invitationId)
  }
  async function advanceDue(payload: InvitationEmailRequest) {
    await db
      .updateTable('invitation_deliveries')
      .set({ due_at: sql`clock_timestamp() - INTERVAL '1 second'` })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    await repair()
  }
  async function idlePoll() {
    const id = await queue.enqueue(pollingProbe.name, {})
    await waitJob(id as string)
    await setTimeout(550)
  }

  it.each(['canceled', 'accepted', 'rejected', 'expired'])(
    'rereads %s invitations after admission and never sends or retries them',
    async (status) => {
      const payload = await invitation()
      await dispatch(payload)
      await db
        .updateTable('auth.invitation')
        .set(
          status === 'expired'
            ? { expiresAt: sql`clock_timestamp() - INTERVAL '1 second'` }
            : { status },
        )
        .where('id', '=', payload.invitationId)
        .execute()
      await startWorker()
      expect(await waitCurrentJob(payload)).toMatchObject({
        state: 'skipped',
        attempts: 0,
        last_error_code: 'invitation_ineligible',
      })
      await repair()
      await idlePoll()
      expect(send).not.toHaveBeenCalled()
      expect(await ledger()).toHaveLength(0)
      expect((await delivery(payload.invitationId)).state).toBe('skipped')
    },
  )

  const authorizationChanges = [
    'inviter demoted',
    'inviter removed',
    'recipient joined',
    'invitation role disallowed',
    'team became personal',
  ] as const

  async function revokeInvitationEligibility(
    change: (typeof authorizationChanges)[number],
    payload: InvitationEmailRequest,
  ) {
    if (change === 'inviter demoted') {
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('userId', '=', inviterId)
        .where('organizationId', '=', organizationId)
        .execute()
    } else if (change === 'inviter removed') {
      await db
        .deleteFrom('auth.member')
        .where('userId', '=', inviterId)
        .where('organizationId', '=', organizationId)
        .execute()
    } else if (change === 'recipient joined') {
      const recipient = await db
        .insertInto('auth.user')
        .values({ name: 'Recipient', email: 'Original@Example.Test', emailVerified: true })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.member')
        .values({ userId: recipient.id, organizationId, role: 'member', createdAt: new Date() })
        .execute()
    } else if (change === 'invitation role disallowed') {
      await db
        .updateTable('auth.invitation')
        .set({ role: 'admin' })
        .where('id', '=', payload.invitationId)
        .execute()
    } else {
      await db
        .insertInto('personal_organizations')
        .values({ user_id: inviterId, organization_id: organizationId })
        .execute()
    }
  }

  it.each(authorizationChanges)(
    'skips without an attempt or retry when %s before the polling worker claims',
    async (change) => {
      const payload = await invitation()
      await dispatch(payload)
      await revokeInvitationEligibility(change, payload)
      await startWorker()
      expect(await waitCurrentJob(payload)).toMatchObject({
        state: 'skipped',
        attempts: 0,
        last_error_code: 'invitation_ineligible',
      })
      await repair()
      await idlePoll()
      expect(send).not.toHaveBeenCalled()
      expect(await ledger()).toHaveLength(0)
      expect(await delivery(payload.invitationId)).toMatchObject({ state: 'skipped', attempts: 0 })
    },
  )

  it.each(authorizationChanges)(
    'rechecks authorization before SMTP when %s after the claim commits',
    async (change) => {
      const payload = await invitation()
      let commits = 0
      const interleaved = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver)
          return () => {
            const builder = target.transaction()
            return new Proxy(builder, {
              get(transaction, key, transactionReceiver) {
                if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
                return async (callback: Parameters<typeof builder.execute>[0]) => {
                  const result = await transaction.execute(callback)
                  if (++commits === 1) await revokeInvitationEligibility(change, payload)
                  return result
                }
              },
            })
          }
        },
      })
      await dispatch(payload)
      await startWorker({ db: interleaved })
      expect(await waitCurrentJob(payload)).toMatchObject({
        state: 'skipped',
        attempts: 1,
        last_error_code: 'invitation_ineligible',
      })
      await repair()
      await idlePoll()
      expect(send).not.toHaveBeenCalled()
      expect(await ledger()).toHaveLength(1)
      expect(await delivery(payload.invitationId)).toMatchObject({ state: 'skipped', attempts: 1 })
    },
  )

  it('allows a current admin under the shared team management policy', async () => {
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('userId', '=', inviterId)
      .where('organizationId', '=', organizationId)
      .execute()
    const payload = await invitation()
    await dispatch(payload)
    await startWorker()
    expect(await waitCurrentJob(payload)).toMatchObject({ state: 'smtp_accepted', attempts: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('skips an invitation that expires while claim authorization waits on a member table lock', async () => {
    const payload = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: sql`clock_timestamp() + INTERVAL '2 seconds'` })
      .where('id', '=', payload.invitationId)
      .execute()
    const sender = await senderCopy()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE auth.member IN ACCESS EXCLUSIVE MODE')
    const sending = sender.deliverInvitationEmail(deps(), payload)
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await owned.pool.query<{ count: string }>(
                  "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%member%'",
                )
              ).rows[0]?.count,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query<{ expired: boolean }>(
                'SELECT "expiresAt" <= clock_timestamp() AS expired FROM auth.invitation WHERE id=$1',
                [payload.invitationId],
              )
            ).rows[0]?.expired,
          { timeout: 5_000, interval: 25 },
        )
        .toBe(true)
    } finally {
      await blocker.query('COMMIT')
      blocker.release()
      await sending
    }
    expect(await delivery(payload.invitationId)).toMatchObject({
      state: 'skipped',
      attempts: 0,
      last_error_code: 'invitation_ineligible',
    })
    expect(send).not.toHaveBeenCalled()
    expect(await ledger()).toHaveLength(0)
  }, 10_000)

  it('ignores a queued stale generation without retiring or sending its successor', async () => {
    const payload = await invitation()
    await dispatch(payload)
    const first = await delivery(payload.invitationId)
    await db
      .updateTable('invitation_deliveries')
      .set({ generation: 2, last_job_id: null, due_at: sql`clock_timestamp() + INTERVAL '1 hour'` })
      .where('invitation_id', '=', payload.invitationId)
      .execute()
    const successor = await delivery(payload.invitationId)
    await startWorker()
    await waitJob(first.last_job_id as string)
    await repair()
    await idlePoll()
    expect(await delivery(payload.invitationId)).toEqual(successor)
    expect(send).not.toHaveBeenCalled()
    expect(await ledger()).toHaveLength(0)
  })

  it('commits the attempt, random lease and one shared capacity debit before SMTP', async () => {
    const payload = await invitation()
    expect(
      await db
        .transaction()
        .execute((trx) =>
          reserveInvitationEmailBudget(
            trx,
            { userId: inviterId, organizationId, email: 'original@example.test' },
            { secret },
          ),
        ),
    ).toBe(true)
    await dispatch(payload)
    expect(await ledger(), 'admission must leave the shared SMTP budget untouched').toHaveLength(0)
    const initial = await delivery(payload.invitationId)
    send.mockImplementation(async (message, options) => {
      // A separate pool connection can see this only after the claim COMMIT.
      const committed = await delivery(payload.invitationId)
      expect(committed).toMatchObject({ state: 'sending', attempts: 1, smtp_accepted_at: null })
      expect(committed.lease_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(committed.last_attempt_at).toBeInstanceOf(Date)
      expect(committed.updated_at.getTime()).toBeGreaterThan(initial.updated_at.getTime())
      expect(
        (committed.lease_until as Date).getTime() - committed.updated_at.getTime(),
      ).toBeCloseTo(120_000, -2)
      expect(await ledger(), 'exactly one send-time debit is already durable').toHaveLength(1)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(message.sensitive).toBe(true)
      sent.push(message)
    })
    await startWorker()
    const result = await waitCurrentJob(payload)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(result).toMatchObject({
      state: 'smtp_accepted',
      attempts: 1,
      lease_id: null,
      lease_until: null,
    })
    expect(result.smtp_accepted_at).toBeInstanceOf(Date)
    expect(await ledger()).toHaveLength(1)
    const original = await db
      .selectFrom('auth.invitation')
      .selectAll()
      .where('id', '=', payload.invitationId)
      .executeTakeFirstOrThrow()
    expect(invitationResendDenial(original, result, new Date())).toBe('INVITATION_RESEND_COOLDOWN')
  })

  it('refuses SMTP when the registered attempt cannot commit', async () => {
    const payload = await invitation()
    await dispatch(payload)
    await owned.pool.query(`CREATE FUNCTION reject_sender_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'sending' THEN RAISE EXCEPTION 'synthetic claim commit failure'; END IF;
      RETURN NEW; END $$`)
    await owned.pool.query(`CREATE CONSTRAINT TRIGGER reject_sender_claim
      AFTER UPDATE ON invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_sender_claim()`)
    try {
      await startWorker()
      await waitCurrentJob(payload, 'failed')
      expect(send, 'a failed claim COMMIT must precede every network call').not.toHaveBeenCalled()
      expect(await delivery(payload.invitationId)).toMatchObject({ state: 'queued', attempts: 0 })
      expect(await ledger()).toHaveLength(0)
    } finally {
      await owned.pool.query('DROP TRIGGER reject_sender_claim ON invitation_deliveries')
      await owned.pool.query('DROP FUNCTION reject_sender_claim()')
    }
  })

  it('persists 60/120/240 second backoff, counts every attempt and retains the exhausted summary', async () => {
    const payload = await invitation()
    send.mockRejectedValue(new MailRejectedError({ responseCode: 450, atRecipient: true }))
    await dispatch(payload)
    await startWorker()
    let prior = (await delivery(payload.invitationId)).updated_at
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await waitCurrentJob(payload)
      expect(result.attempts).toBe(attempt)
      expect(result.updated_at.getTime()).toBeGreaterThan(prior.getTime())
      expect(result.last_attempt_at).toBeInstanceOf(Date)
      expect(send).toHaveBeenCalledTimes(attempt)
      expect(await ledger()).toHaveLength(attempt)
      prior = result.updated_at
      if (attempt < 4) {
        expect(result).toMatchObject({ state: 'queued', last_error_code: 'smtp_temporary' })
        const delay = result.due_at.getTime() - (result.last_attempt_at as Date).getTime()
        expect(delay).toBeGreaterThanOrEqual(60_000 * 2 ** (attempt - 1) - 1_000)
        expect(delay).toBeLessThan(60_000 * 2 ** (attempt - 1) + 1_000)
        const jobId = result.last_job_id
        await repair()
        await idlePoll()
        expect((await delivery(payload.invitationId)).last_job_id).toBe(jobId)
        expect(send).toHaveBeenCalledTimes(attempt)
        await advanceDue(payload)
      } else {
        expect(result).toMatchObject({ state: 'failed', last_error_code: 'attempts_exhausted' })
      }
    }
    await repair()
    await idlePoll()
    expect(send).toHaveBeenCalledTimes(4)
    expect(await listPendingInvitationDeliveries(db, organizationId)).toEqual([
      expect.objectContaining({
        id: payload.invitationId,
        delivery: expect.objectContaining({
          state: 'failed',
          attempts: 4,
          lastErrorCode: 'attempts_exhausted',
        }),
      }),
    ])
  }, 25_000)

  it('uses the current recipient, organization and locale when retrying an identity-only job', async () => {
    const payload = await invitation()
    send
      .mockRejectedValueOnce(new Error('synthetic transport failure'))
      .mockImplementation(async (message) => {
        sent.push(message)
      })
    await dispatch(payload)
    await startWorker()
    expect(await waitCurrentJob(payload)).toMatchObject({ state: 'queued', attempts: 1 })
    expect(send.mock.calls[0]?.[0].to).toBe('original@example.test')
    const replacement = await db
      .insertInto('auth.organization')
      .values({ name: 'Replacement team', slug: 'replacement-team', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: inviterId,
        organizationId: replacement.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    await db
      .updateTable('auth.invitation')
      .set({ email: 'current@example.test', organizationId: replacement.id })
      .where('id', '=', payload.invitationId)
      .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: inviterId, handle: 'sender-inviter', locale: 'zh-CN', time_zone: 'UTC' })
      .execute()
    await advanceDue(payload)
    expect(await waitCurrentJob(payload)).toMatchObject({ state: 'smtp_accepted', attempts: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'current@example.test', sensitive: true })
    expect(sent[0]?.text).toContain('Replacement team')
    expect(sent[0]?.text).not.toContain('Original team')
    expect(sent[0]?.html).toContain('lang="zh-CN"')
    const jobs = await owned.pool.query<{ data: unknown }>(
      'SELECT data FROM pgboss.job WHERE name=$1',
      [INVITATION_EMAIL_JOB],
    )
    expect(jobs.rows).toEqual([{ data: payload }, { data: payload }])
  })

  it('serializes two polling workers waiting on the same generation and sends once', async () => {
    const payload = await invitation()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM auth.invitation WHERE id=$1 FOR UPDATE', [
      payload.invitationId,
    ])
    const first = await queue.enqueue(INVITATION_EMAIL_JOB, payload, {
      singletonKey: `race-a:${payload.invitationId}`,
    })
    const second = await queue.enqueue(INVITATION_EMAIL_JOB, payload, {
      singletonKey: `race-b:${payload.invitationId}`,
    })
    try {
      await startWorker()
      await startWorker()
      await expect
        .poll(
          async () =>
            Number(
              (
                await owned.pool.query<{ count: string }>(
                  "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%invitation%'",
                )
              ).rows[0]?.count,
            ),
          { timeout: 10_000, interval: 25 },
        )
        .toBe(2)
    } finally {
      await blocker.query('COMMIT')
      blocker.release()
    }
    await waitJob(first as string)
    await waitJob(second as string)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await delivery(payload.invitationId)).toMatchObject({
      state: 'smtp_accepted',
      attempts: 1,
    })
    expect(await ledger()).toHaveLength(1)
  })

  it('treats completed jobs as nonlive while the worker repairs and sends a due retry', async () => {
    const payload = await invitation()
    send.mockRejectedValueOnce(new Error('synthetic temporary outage')).mockResolvedValue(undefined)
    await dispatch(payload)
    await startWorker()
    const first = await waitCurrentJob(payload)
    expect(first).toMatchObject({ state: 'queued', attempts: 1 })
    expect(
      await queue.hasLiveInvitationEmailJob({ ...payload, id: first.last_job_id as string }),
    ).toBe(false)
    await advanceDue(payload)
    const next = await delivery(payload.invitationId)
    expect(next.last_job_id).not.toBe(first.last_job_id)
    await waitJob(next.last_job_id as string)
    expect(await delivery(payload.invitationId)).toMatchObject({
      state: 'smtp_accepted',
      attempts: 2,
    })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it.each([0, 3])(
    'consumes an attempt when the worker stops after its commit and before SMTP, starting at %i',
    async (attempts) => {
      const payload = await invitation({ attempts })
      let reads = 0
      const crashed = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (result.rows[0]?.id === payload.invitationId && ++reads === 2) {
            // This independent read proves the crash cut is after the claim committed.
            expect(await delivery(payload.invitationId)).toMatchObject({
              state: 'sending',
              attempts: attempts + 1,
            })
            throw new Error('synthetic worker crash before SMTP')
          }
          return result
        },
      })
      await dispatch(payload)
      await startWorker({ db: crashed })
      expect(await waitCurrentJob(payload, 'failed')).toMatchObject({
        state: 'sending',
        attempts: attempts + 1,
      })
      expect(reads).toBe(2)
      expect(send).not.toHaveBeenCalled()
      await db
        .updateTable('invitation_deliveries')
        .set({
          lease_until: sql`clock_timestamp() - INTERVAL '1 second'`,
          due_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        })
        .where('invitation_id', '=', payload.invitationId)
        .execute()
      await repair()
      if (attempts === 3) {
        await idlePoll()
        expect(await delivery(payload.invitationId)).toMatchObject({
          state: 'failed',
          attempts: 4,
          last_error_code: 'attempts_exhausted',
        })
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(await waitCurrentJob(payload)).toMatchObject({
          state: 'smtp_accepted',
          attempts: 2,
        })
        expect(send).toHaveBeenCalledTimes(1)
      }
    },
  )

  it.each([0, 3])(
    'consumes a committed attempt after an outcome crash starting at attempt %i',
    async (attempts) => {
      const payload = await invitation({ attempts })
      await dispatch(payload)
      await owned.pool.query(`CREATE FUNCTION reject_sender_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'smtp_accepted' THEN RAISE EXCEPTION 'synthetic outcome commit failure'; END IF;
      RETURN NEW; END $$`)
      await owned.pool.query(`CREATE CONSTRAINT TRIGGER reject_sender_outcome
      AFTER UPDATE ON invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_sender_outcome()`)
      try {
        await startWorker()
        expect(await waitCurrentJob(payload, 'failed')).toMatchObject({
          state: 'sending',
          attempts: attempts + 1,
        })
        expect(send).toHaveBeenCalledTimes(1)
        expect(await ledger()).toHaveLength(1)
      } finally {
        await owned.pool.query('DROP TRIGGER reject_sender_outcome ON invitation_deliveries')
        await owned.pool.query('DROP FUNCTION reject_sender_outcome()')
      }
      await db
        .updateTable('invitation_deliveries')
        .set({
          lease_until: sql`clock_timestamp() - INTERVAL '1 second'`,
          due_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        })
        .where('invitation_id', '=', payload.invitationId)
        .execute()
      await repair()
      if (attempts === 3) {
        expect(await delivery(payload.invitationId)).toMatchObject({
          state: 'failed',
          attempts: 4,
          last_error_code: 'attempts_exhausted',
        })
        await repair()
        await idlePoll()
        expect(send).toHaveBeenCalledTimes(1)
        expect(await ledger()).toHaveLength(1)
      } else {
        expect(await waitCurrentJob(payload)).toMatchObject({ state: 'smtp_accepted', attempts: 2 })
        // SMTP accepted before the outcome commit failed: a duplicate is possible and budgeted.
        expect(send).toHaveBeenCalledTimes(2)
        expect(await ledger()).toHaveLength(2)
      }
    },
  )

  it('keeps an SMTP receipt as a tombstone when a completed job is replayed', async () => {
    const payload = await invitation()
    await dispatch(payload)
    await startWorker()
    const accepted = await waitCurrentJob(payload)
    expect(accepted.state).toBe('smtp_accepted')
    const replay = await queue.enqueue(INVITATION_EMAIL_JOB, payload, {
      singletonKey: `replay:${payload.invitationId}`,
    })
    await waitJob(replay as string)
    await repair()
    expect(await delivery(payload.invitationId)).toEqual(accepted)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await ledger()).toHaveLength(1)
  })

  it.each([
    [
      'permanent SMTP refusal',
      true,
      () => new MailRejectedError({ responseCode: 550, enhancedCode: '5.1.1', atRecipient: true }),
      'smtp_permanent',
      1,
    ],
    [
      'SMTP authentication failure',
      true,
      () => Object.assign(new Error('synthetic auth refusal'), { code: 'EAUTH' }),
      'smtp_auth',
      1,
    ],
    ['SMTP not configured', false, () => new Error('must not send'), 'smtp_not_configured', 0],
  ] as const)('stops retrying after %s', async (_, configured, error, code, attempts) => {
    const payload = await invitation()
    send.mockRejectedValue(error())
    await dispatch(payload)
    await startWorker({ smtpConfigured: configured })
    expect(await waitCurrentJob(payload)).toMatchObject({
      state: 'failed',
      attempts,
      last_error_code: code,
    })
    await repair()
    await idlePoll()
    expect(send).toHaveBeenCalledTimes(attempts)
    expect(await ledger()).toHaveLength(attempts)
  })

  it('shares the ordinary instance cap with other mail and leaves a rejected send unspent', async () => {
    const payload = await invitation()
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: null, sent_at: new Date() })
      .execute()
    await dispatch(payload)
    await startWorker({ mailMaxPerHour: 1 })
    expect(await waitCurrentJob(payload)).toMatchObject({
      state: 'failed',
      attempts: 0,
      last_error_code: 'mail_rate_limited',
    })
    expect(send).not.toHaveBeenCalled()
    expect(await ledger()).toHaveLength(1)
  })

  it('redacts private provider errors from sender logs, pg-boss diagnostics and stderr', async () => {
    const payload = await invitation()
    const canary = 'synthetic-private-canary'
    const privateError = `${canary}@example.test ${publicUrl}/app/join?invitationId=${payload.invitationId} token=${canary}`
    const stderr: string[] = []
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...parts) => stderr.push(parts.join(' ')))
    try {
      send.mockRejectedValue(
        Object.assign(new Error(privateError), {
          cause: new Error(privateError),
          response: privateError,
        }),
      )
      await dispatch(payload)
      await startWorker()
      expect(await waitCurrentJob(payload)).toMatchObject({
        state: 'queued',
        last_error_code: 'transport_error',
      })
      const jobs = await owned.pool.query('SELECT output FROM pgboss.job WHERE name=$1', [
        INVITATION_EMAIL_JOB,
      ])
      const diagnostics = JSON.stringify({
        logs,
        stderr,
        jobs: jobs.rows,
        delivery: await delivery(payload.invitationId),
      })
      expect(diagnostics.includes(canary)).toBe(false)
      expect(diagnostics.includes('/app/join')).toBe(false)
      expect(diagnostics.includes('original@example.test')).toBe(false)
      expect(diagnostics.includes('transport_error')).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('detects removed invitation lifecycle rereads with a real failed assertion in a source copy', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      const payload = await invitation()
      await db
        .updateTable('auth.invitation')
        .set({ status: 'canceled' })
        .where('id', '=', payload.invitationId)
        .execute()
      send.mockClear()
      await deliver(deps(), payload)
      expect(await delivery(payload.invitationId)).toMatchObject({ state: 'skipped', attempts: 0 })
      expect(send).not.toHaveBeenCalled()
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      {
        before: "if (invitation.status !== 'pending' || invitation.expiresAt <= initialNow) {",
        after: 'if (false) {',
      },
      {
        before: "if (invitation.status !== 'pending' || invitation.expiresAt <= now) {",
        after: 'if (false) {',
      },
      {
        before: "if (invitation.status !== 'pending' || invitation.expiresAt <= now) {",
        after: 'if (false) {',
      },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects removing only the final lifecycle check after a committed claim', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      await db.deleteFrom('notification_email_sends').execute()
      const payload = await invitation()
      send.mockClear()
      let commits = 0
      // The hook runs after the real first transaction COMMIT, before the sender's
      // second transaction. The cancellation is committed by another pool connection.
      const interleaved = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver)
          return () => {
            const builder = target.transaction()
            return new Proxy(builder, {
              get(transaction, key, transactionReceiver) {
                if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
                return async (callback: Parameters<typeof builder.execute>[0]) => {
                  const result = await transaction.execute(callback)
                  if (++commits === 1) {
                    expect(await delivery(payload.invitationId)).toMatchObject({
                      state: 'sending',
                      attempts: 1,
                    })
                    await db
                      .updateTable('auth.invitation')
                      .set({ status: 'canceled' })
                      .where('id', '=', payload.invitationId)
                      .execute()
                  }
                  return result
                }
              },
            })
          }
        },
      })
      await deliver(deps({ db: interleaved }), payload)
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'skipped',
        attempts: 1,
        last_error_code: 'invitation_ineligible',
      })
      expect(
        send,
        'the current invitation status must be checked after committing the claim',
      ).not.toHaveBeenCalled()
      expect(await ledger()).toHaveLength(1)
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      {
        before:
          "    if (invitation.status !== 'pending' || invitation.expiresAt <= now) {\n      await terminal(trx, claim, 'skipped', 'invitation_ineligible', now)",
        after:
          "    if (false) {\n      await terminal(trx, claim, 'skipped', 'invitation_ineligible', now)",
      },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects removing only the expiry check after waiting for the shared budget lock', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      await db.deleteFrom('notification_email_sends').execute()
      const payload = await invitation()
      send.mockClear()
      const held = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const blocker = db.transaction().execute(async (trx) => {
        await lockNotificationEmailBudget(trx)
        held.resolve()
        await release.promise
      })
      await held.promise
      await db
        .updateTable('auth.invitation')
        .set({ expiresAt: sql`clock_timestamp() + INTERVAL '2 seconds'` })
        .where('id', '=', payload.invitationId)
        .execute()
      const sending = deliver(deps(), payload)
      try {
        await expect
          .poll(
            async () =>
              Number(
                (
                  await owned.pool.query<{ count: string }>(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
                  )
                ).rows[0]?.count,
              ),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(1)
        // The invitation was eligible before the wait; let the database clock cross
        // its real expiry while the worker still owns the invitation row lock.
        await expect
          .poll(
            async () =>
              (
                await owned.pool.query<{ expired: boolean }>(
                  'SELECT "expiresAt" <= clock_timestamp() AS expired FROM auth.invitation WHERE id=$1',
                  [payload.invitationId],
                )
              ).rows[0]?.expired,
            { timeout: 5_000, interval: 25 },
          )
          .toBe(true)
      } finally {
        release.resolve()
        await blocker
        await sending
      }
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'skipped',
        attempts: 0,
        last_error_code: 'invitation_ineligible',
      })
      expect(send).not.toHaveBeenCalled()
      expect(
        await ledger(),
        'expiry during the lock wait must not consume send capacity',
      ).toHaveLength(0)
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      {
        before:
          "    if (invitation.status !== 'pending' || invitation.expiresAt <= now) {\n      await terminal(trx, request, 'skipped', 'invitation_ineligible', now)",
        after:
          "    if (false) {\n      await terminal(trx, request, 'skipped', 'invitation_ineligible', now)",
      },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 15_000)

  it.each(['lease', 'invitation'] as const)(
    'detects %s expiry while current template data is blocked on a database lock',
    async (expiring) => {
      const verify = async (deliver: typeof deliverInvitationEmail) => {
        const payload = await invitation()
        if (expiring === 'invitation') {
          await db
            .updateTable('auth.invitation')
            .set({ expiresAt: sql`clock_timestamp() + INTERVAL '1 second'` })
            .where('id', '=', payload.invitationId)
            .execute()
        }
        send.mockClear()
        const blocker = await owned.pool.connect()
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE auth.organization IN ACCESS EXCLUSIVE MODE')
        const sending = deliver(deps(), payload)
        try {
          await expect
            .poll(
              async () =>
                Number(
                  (
                    await owned.pool.query<{ count: string }>(
                      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%organization%'",
                    )
                  ).rows[0]?.count,
                ),
              { timeout: 5_000, interval: 10 },
            )
            .toBe(1)
          await expect
            .poll(
              async () =>
                (
                  await owned.pool.query<{ expired: boolean }>(
                    expiring === 'lease'
                      ? 'SELECT lease_until <= clock_timestamp() AS expired FROM invitation_deliveries WHERE invitation_id=$1'
                      : 'SELECT "expiresAt" <= clock_timestamp() AS expired FROM auth.invitation WHERE id=$1',
                    [payload.invitationId],
                  )
                ).rows[0]?.expired,
              { timeout: 5_000, interval: 25 },
            )
            .toBe(true)
        } finally {
          await blocker.query('COMMIT')
          blocker.release()
          await sending
        }
        expect(send, 'expiry while loading template data must prevent SMTP').not.toHaveBeenCalled()
        expect(await delivery(payload.invitationId)).toMatchObject({
          state: expiring === 'lease' ? 'sending' : 'skipped',
          attempts: 1,
        })
      }
      const shortenLease = { before: 'const LEASE_MS = 120_000', after: 'const LEASE_MS = 1_000' }
      const timing = expiring === 'lease' ? [shortenLease] : []
      await verify((await senderCopy(timing)).deliverInvitationEmail)
      const mutation = await senderCopy([
        ...timing,
        // Both final protections independently prevent an expired lease from sending.
        ...(expiring === 'lease'
          ? [
              {
                before:
                  '(current.delivery.lease_until as Date).getTime() - readyAt.getTime() - LEASE_SAFETY_MS',
                after: 'SMTP_TIMEOUT_MS',
              },
            ]
          : []),
        expiring === 'lease'
          ? {
              before: 'if (!ownsClaim(current, claim, readyAt)) return',
              after: 'if (false) return',
            }
          : {
              before: 'if (invitation.expiresAt <= readyAt) {',
              after: 'if (false) {',
            },
      ])
      await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
    15_000,
  )

  it('detects SMTP before the claim commit with a real failed assertion in a source copy', async () => {
    await owned.pool.query(`CREATE FUNCTION reject_mutation_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'sending' THEN RAISE EXCEPTION 'synthetic mutation claim failure'; END IF;
      RETURN NEW; END $$`)
    await owned.pool.query(`CREATE CONSTRAINT TRIGGER reject_mutation_claim
      AFTER UPDATE ON invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_mutation_claim()`)
    try {
      const verify = async (deliver: typeof deliverInvitationEmail) => {
        const payload = await invitation()
        send.mockClear()
        await deliver(deps(), payload).catch(() => {})
        expect(send, 'SMTP cannot happen before a failing attempt COMMIT').not.toHaveBeenCalled()
        expect(await delivery(payload.invitationId)).toMatchObject({ state: 'queued', attempts: 0 })
      }
      await verify((await senderCopy()).deliverInvitationEmail)
      const mutation = await senderCopy([
        {
          before: '// SMTP must begin only after this claim transaction has committed.',
          after:
            "await deps.mailer.send({ to: invitation.email, subject: 'synthetic', text: 'synthetic', sensitive: true })",
        },
      ])
      await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    } finally {
      await owned.pool.query('DROP TRIGGER reject_mutation_claim ON invitation_deliveries')
      await owned.pool.query('DROP FUNCTION reject_mutation_claim()')
    }
  })

  it('detects reading the recipient from the ID-only payload through a real failed assertion', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      const payload = await invitation()
      // The durable job identity was captured before the invited address changed.
      await db
        .updateTable('auth.invitation')
        .set({ email: 'changed@example.test' })
        .where('id', '=', payload.invitationId)
        .execute()
      send.mockClear()
      await deliver(deps(), payload)
      expect(send.mock.calls.map(([message]) => message.to)).toEqual(['changed@example.test'])
      expect((await delivery(payload.invitationId)).state).toBe('smtp_accepted')
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      {
        before: 'to: invitation.email,',
        after: 'to: (claim as unknown as { email: string }).email,',
      },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects a fifth attempt through a real terminal-state assertion rather than a constraint error', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      const payload = await invitation({ attempts: 4 })
      send.mockClear()
      // A raw constraint failure is not the assertion: the application must settle failed.
      await deliver(deps(), payload).catch(() => {})
      expect(await delivery(payload.invitationId)).toMatchObject({
        state: 'failed',
        attempts: 4,
        last_error_code: 'attempts_exhausted',
      })
      expect(send).not.toHaveBeenCalled()
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      { before: 'const MAX_ATTEMPTS = 4', after: 'const MAX_ATTEMPTS = 5' },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects removing the send-time capacity debit through a real failed ledger assertion', async () => {
    const verify = async (deliver: typeof deliverInvitationEmail) => {
      await db.deleteFrom('notification_email_sends').execute()
      const payload = await invitation()
      send.mockClear()
      await deliver(deps(), payload)
      expect(send).toHaveBeenCalledTimes(1)
      expect(await ledger(), 'one SMTP attempt must debit the shared instance budget').toHaveLength(
        1,
      )
    }
    await verify((await senderCopy()).deliverInvitationEmail)
    const mutation = await senderCopy([
      {
        before:
          "    await trx\n      .insertInto('notification_email_sends')\n      .values({ recipient_hash: recipientHash, sent_at: now })\n      .execute()",
        after: '',
      },
    ])
    await expect(verify(mutation.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
