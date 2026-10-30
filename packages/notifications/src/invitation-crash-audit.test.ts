import { type ChildProcess, fork } from 'node:child_process'
import { once } from 'node:events'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fakeSmtpServer } from '../../mail/src/smtp-testing.ts'
import {
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  INVITATION_EMAIL_REPAIR_JOB,
  invitationEmailJob,
  invitationEmailRepairJob,
} from './invitation-email.ts'

const serverUrl = process.env.DATABASE_URL
const definitions = [invitationEmailJob(), invitationEmailRepairJob(async () => {})] as const
type AuditJobs = ReturnType<typeof createJobs<typeof definitions>>

describe.skipIf(!serverUrl)('invitation crash audit with polling pg-boss and loopback SMTP', () => {
  let owned: TestDatabase
  let db: Db
  let queue: AuditJobs
  let invitationId: string
  let smtp: ReturnType<typeof fakeSmtpServer>
  let smtpUrl: string
  const children = new Set<ChildProcess>()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_crash' })
    db = createDb(owned.pool)
    queue = createJobs({
      connectionString: owned.url,
      definitions,
      work: false,
      migrate: true,
      maxConnections: 2,
      log() {},
    })
    await queue.start()
  })

  beforeEach(async () => {
    await owned.pool.query('DELETE FROM pgboss.job')
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    await db.deleteFrom('notification_email_sends').execute()
    const inviter = await db
      .insertInto('auth.user')
      .values({ name: 'Synthetic owner', email: 'owner@example.test', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    const organization = await db
      .insertInto('auth.organization')
      .values({ name: 'Crash team', slug: 'crash-team', createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: inviter.id,
        organizationId: organization.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        inviterId: inviter.id,
        organizationId: organization.id,
        email: 'recipient@example.test',
        role: 'member',
        status: 'pending',
        createdAt: new Date(),
        expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    invitationId = invitation.id
    await db
      .insertInto('invitation_deliveries')
      .values({ invitation_id: invitationId, generation: 1, attempts: 0, state: 'queued' })
      .execute()
    smtp = fakeSmtpServer()
    smtp.server.listen(0, '127.0.0.1')
    await once(smtp.server, 'listening')
    const address = smtp.server.address()
    if (!address || typeof address === 'string') throw new Error('fake_smtp_address_unavailable')
    smtpUrl = `smtp://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    for (const child of children) await kill(child)
    for (const socket of smtp?.sockets ?? []) socket.destroy()
    if (smtp?.server.listening)
      await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
  })

  afterAll(async () => {
    try {
      await queue?.stop()
    } finally {
      await owned?.drop()
    }
  })

  const delivery = () =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', invitationId)
      .executeTakeFirstOrThrow()
  const payload = () => ({ invitationId, generation: 1 })
  const repair = () => createInvitationEmailRepairer({ db, queue })()

  async function worker(phase: 'claim' | 'smtp' | 'normal') {
    const child = fork(new URL('./testing/invitation-crash-worker.ts', import.meta.url), [], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.add(child)
    const events = new Set<unknown>()
    child.on('message', (event) => events.add(event))
    child.send({ url: owned.url, smtpUrl, phase })
    await expect.poll(() => events.has('ready'), { timeout: 10_000 }).toBe(true)
    return {
      child,
      async wait(event: string) {
        await expect.poll(() => events.has(event), { timeout: 10_000 }).toBe(true)
      },
    }
  }

  async function kill(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      const [, signal] = await exited
      expect(signal).toBe('SIGKILL')
    }
    children.delete(child)
  }

  async function expireClaim() {
    const current = await delivery()
    const delay = current.due_at.getTime() - (current.last_attempt_at as Date).getTime()
    expect(delay).toBeGreaterThanOrEqual(60_000 * 2 ** Math.min(current.attempts - 1, 2) - 100)
    expect(delay).toBeLessThanOrEqual(60_000 * 2 ** Math.min(current.attempts - 1, 2) + 100)
    await db
      .updateTable('invitation_deliveries')
      .set({
        lease_until: sql`clock_timestamp() - INTERVAL '1 second'`,
        due_at: sql`clock_timestamp() - INTERVAL '1 second'`,
      })
      .where('invitation_id', '=', invitationId)
      .execute()
  }

  async function expireJob() {
    const row = await delivery()
    await owned.pool.query(
      "UPDATE pgboss.job SET started_on=pgboss.job_now() - INTERVAL '181 seconds' WHERE id=$1 AND state='active'",
      [row.last_job_id],
    )
  }

  async function polledRepair() {
    const id = await queue.enqueue(INVITATION_EMAIL_REPAIR_JOB, {})
    await expect
      .poll(
        async () =>
          (await owned.pool.query('SELECT state FROM pgboss.job WHERE id=$1', [id])).rows[0]?.state,
        { timeout: 10_000 },
      )
      .toBe('completed')
  }

  async function assertTerminal(
    state: 'smtp_accepted' | 'failed',
    attempts: number,
    sends: number,
  ) {
    await expect.poll(async () => (await delivery()).state, { timeout: 10_000 }).toBe(state)
    const terminal = await delivery()
    expect(terminal).toMatchObject({ attempts, lease_id: null, lease_until: null })
    expect(smtp.received.to.length).toBe(sends)
    expect((await db.selectFrom('notification_email_sends').selectAll().execute()).length).toBe(
      attempts,
    )
    // A terminal tombstone survives repeated actual repair jobs; SMTP never creates a member.
    await polledRepair()
    await polledRepair()
    expect(await delivery()).toEqual(terminal)
    expect(smtp.received.to.length).toBe(sends)
    expect((await db.selectFrom('auth.member').selectAll().execute()).length).toBe(1)
    const connections = await owned.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()',
    )
    expect(connections.rows[0]?.count).toBeLessThanOrEqual(16)
    expect(
      (await db.selectFrom('auth.invitation').select('status').executeTakeFirstOrThrow()).status,
    ).toBe('pending')
  }

  it('keeps both crash recovery fences, then continues the consumed pre-SMTP attempt', async () => {
    await createInvitationEmailDispatcher({ db, queue })(payload())
    const first = await worker('claim')
    await first.wait('claim_committed')
    const claimed = await delivery()
    expect(claimed).toMatchObject({ state: 'sending', attempts: 1, smtp_accepted_at: null })
    expect(claimed.last_attempt_at).toBeInstanceOf(Date)
    expect(smtp.received.to.length).toBe(0)
    await kill(first.child)

    const restarted = await worker('normal')
    await polledRepair()
    expect(await delivery(), 'a live lease cannot be stolen after restart').toEqual(claimed)
    await expireClaim()
    const expiredLease = await delivery()
    await polledRepair()
    expect(await delivery(), 'a still-live pg-boss attempt also fences repair').toEqual(
      expiredLease,
    )
    await expireJob()
    await polledRepair()
    await assertTerminal('smtp_accepted', 2, 1)
    await kill(restarted.child)
  }, 40_000)

  it('allows one documented duplicate after SMTP acceptance and a process crash before receipt commit', async () => {
    await createInvitationEmailDispatcher({ db, queue })(payload())
    const first = await worker('smtp')
    await first.wait('smtp_accepted')
    expect(smtp.received.data !== undefined).toBe(true)
    expect(await delivery()).toMatchObject({
      state: 'sending',
      attempts: 1,
      smtp_accepted_at: null,
    })
    expect(smtp.received.to.length).toBe(1)
    await kill(first.child)
    await expireClaim()
    await expireJob()
    const restarted = await worker('normal')
    await assertTerminal('smtp_accepted', 2, 2)
    await kill(restarted.child)
  }, 40_000)

  it('ends failed after four pre-SMTP crashes without granting a fifth attempt', async () => {
    await createInvitationEmailDispatcher({ db, queue })(payload())
    for (let attempt = 1; attempt <= 4; attempt++) {
      const current = await worker('claim')
      await current.wait('claim_committed')
      expect(await delivery()).toMatchObject({ state: 'sending', attempts: attempt })
      await kill(current.child)
      await expireClaim()
      await expireJob()
      if (attempt < 4) await repair()
    }
    const restarted = await worker('normal')
    await assertTerminal('failed', 4, 0)
    expect((await delivery()).last_error_code).toBe('attempts_exhausted')
    await kill(restarted.child)
  }, 60_000)

  it('bounds repeated SMTP-accepted crashes to four submissions, then stays failed', async () => {
    await createInvitationEmailDispatcher({ db, queue })(payload())
    for (let attempt = 1; attempt <= 4; attempt++) {
      const current = await worker('smtp')
      await current.wait('smtp_accepted')
      expect(await delivery()).toMatchObject({ state: 'sending', attempts: attempt })
      expect(smtp.received.to.length).toBe(attempt)
      await kill(current.child)
      await expireClaim()
      await expireJob()
      if (attempt < 4) await repair()
    }
    const restarted = await worker('normal')
    await assertTerminal('failed', 4, 4)
    expect((await delivery()).last_error_code).toBe('attempts_exhausted')
    await kill(restarted.child)
  }, 60_000)
})
