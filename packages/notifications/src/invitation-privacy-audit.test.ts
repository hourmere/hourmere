import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInvitationEmailDispatcher,
  INVITATION_EMAIL_JOB,
  InvitationEmailPayload,
  type InvitationEmailRequest,
  invitationEmailJob,
} from './invitation-email.ts'
import { deliverInvitationEmail, type InvitationEmailSenderDeps } from './invitation-sender.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://audit.example.test'
const recipient = 'synthetic-private-recipient@example.test'
const privateMarker = 'synthetic-private-smtp-marker'
type Jobs = ReturnType<typeof createJobs<readonly [ReturnType<typeof invitationEmailJob>]>>

// Execute copies without changing sources used by other tests or concurrent tasks.
async function moduleCopy<File extends 'invitation-sender.ts' | 'invitation-email.ts'>(
  file: File,
  before: string,
  after: string,
) {
  const location = new URL(`./${file}`, import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(original.includes(before), 'mutation matches its intended protection').toBe(true)
  const javascript = stripTypeScriptTypes(original.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!serverUrl)('invitation privacy audit with PostgreSQL and polling pg-boss', () => {
  let owned: TestDatabase
  let db: Db
  let queue: Jobs
  let worker: Jobs | undefined
  let inviterId: string
  let organizationId: string
  const logs: string[] = []
  const messages: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_privacy' })
    db = createDb(owned.pool)
    queue = createJobs({
      connectionString: owned.url,
      definitions: [invitationEmailJob()] as const,
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
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    logs.length = 0
    messages.length = 0
    inviterId = (
      await db
        .insertInto('auth.user')
        .values({ name: 'Audit inviter', email: 'audit-owner@example.test', emailVerified: true })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    organizationId = (
      await db
        .insertInto('auth.organization')
        .values({ name: 'Audit team', slug: 'privacy-audit-team', createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('auth.member')
      .values({ userId: inviterId, organizationId, role: 'owner', createdAt: new Date() })
      .execute()
  })
  afterEach(async () => {
    await worker?.stop()
    worker = undefined
  })
  afterAll(async () => {
    try {
      await worker?.stop()
      await queue?.stop()
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
        email: recipient,
        role: 'member',
        status: 'pending',
        createdAt: new Date(),
        expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .execute()
    await db
      .insertInto('invitation_deliveries')
      .values({ invitation_id: invitationId, state: 'queued' })
      .execute()
    return { invitationId, generation: 1 }
  }
  const delivery = (payload: InvitationEmailRequest) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', payload.invitationId)
      .executeTakeFirstOrThrow()
  const deps = (
    send: InvitationEmailSenderDeps['mailer']['send'],
    database = db,
  ): InvitationEmailSenderDeps => ({
    db: database,
    smtpConfigured: true,
    mailer: { send },
    publicUrl,
    secret: 'synthetic-invitation-privacy-audit-secret',
    log: (line) => logs.push(line),
  })
  async function runPollingWorker(
    payload: InvitationEmailRequest,
    senderDeps: InvitationEmailSenderDeps,
    sender = deliverInvitationEmail,
    expectedJobState = 'completed',
  ) {
    await createInvitationEmailDispatcher({ db, queue })(payload)
    const definition = invitationEmailJob(senderDeps)
    worker = createJobs({
      connectionString: owned.url,
      definitions: [
        {
          ...definition,
          handler: (request, run) => sender(senderDeps, request, run.signal, run.id),
        },
      ] as const,
      work: true,
      migrate: false,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: (_, line) => logs.push(line),
    })
    await worker.start()
    await expect
      .poll(
        async () =>
          (
            await owned.pool.query<{ state: string }>('SELECT state FROM pgboss.job WHERE id=$1', [
              (await delivery(payload)).last_job_id,
            ])
          ).rows[0]?.state,
        { timeout: 10_000, interval: 25 },
      )
      .toBe(expectedJobState)
  }
  async function assertPrivateArtifacts(payload: InvitationEmailRequest) {
    const jobs = await owned.pool.query('SELECT data, output FROM pgboss.job WHERE name=$1', [
      INVITATION_EMAIL_JOB,
    ])
    expect(
      jobs.rows.every(
        (job) =>
          Object.keys(job.data).length === 2 &&
          job.data.invitationId === payload.invitationId &&
          job.data.generation === payload.generation,
      ),
    ).toBe(true)
    const stored = JSON.stringify({ logs, jobs: jobs.rows, delivery: await delivery(payload) })
    // Boolean assertions avoid putting private fixture values in failure diagnostics.
    expect(stored.includes(recipient), 'recipient omitted from diagnostic artifacts').toBe(false)
    expect(stored.includes(privateMarker), 'SMTP details omitted from diagnostic artifacts').toBe(
      false,
    )
    expect(stored.includes('/app/join'), 'usable invitation link omitted from artifacts').toBe(
      false,
    )
    expect(stored.includes('token='), 'credential omitted from artifacts').toBe(false)
  }
  const privateError = (payload: InvitationEmailRequest) =>
    Object.assign(
      new Error(
        `${privateMarker} ${recipient} ${publicUrl}/app/join?invitationId=${payload.invitationId} token=${privateMarker}`,
      ),
      { response: privateMarker, cause: new Error(privateMarker), envelope: { to: recipient } },
    )

  it('keeps the actual private message confined to the mailer on successful polling delivery', async () => {
    const payload = await invitation()
    await runPollingWorker(
      payload,
      deps(async (message) => {
        messages.push(message)
      }),
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.sensitive).toBe(true)
    expect(messages[0]?.to === recipient).toBe(true)
    expect(messages[0]?.text.includes('/app/join')).toBe(true)
    expect(await delivery(payload)).toMatchObject({ state: 'smtp_accepted', attempts: 1 })
    await assertPrivateArtifacts(payload)
  })

  it.each(['reply', 'throwing properties', 'string', 'null'])(
    'persists a fixed safe outcome for arbitrary SMTP %s errors',
    async (kind) => {
      const payload = await invitation()
      const failure =
        kind === 'reply'
          ? Object.assign(privateError(payload), { responseCode: 550 })
          : kind === 'throwing properties'
            ? Object.defineProperty(privateError(payload), 'code', {
                get() {
                  throw privateError(payload)
                },
              })
            : kind === 'string'
              ? privateError(payload).message
              : null
      await runPollingWorker(
        payload,
        deps(async () => {
          throw failure
        }),
      )
      expect(await delivery(payload)).toMatchObject({
        state: kind === 'reply' ? 'failed' : 'queued',
        attempts: 1,
        last_error_code: kind === 'reply' ? 'smtp_permanent' : 'transport_error',
      })
      await assertPrivateArtifacts(payload)
    },
  )

  async function failResultCommit(payload: InvitationEmailRequest) {
    // This is a real deferred COMMIT failure, after the fake SMTP transport accepted.
    await owned.pool.query(`CREATE FUNCTION audit_reject_result() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state = 'smtp_accepted' THEN RAISE EXCEPTION '${privateMarker}'; END IF;
        RETURN NEW; END $$`)
    await owned.pool.query(`CREATE CONSTRAINT TRIGGER audit_reject_result
      AFTER UPDATE ON invitation_deliveries DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION audit_reject_result()`)
    return async () => {
      await owned.pool.query('DROP TRIGGER audit_reject_result ON invitation_deliveries')
      await owned.pool.query('DROP FUNCTION audit_reject_result()')
      expect(await delivery(payload)).toMatchObject({ state: 'sending', attempts: 1 })
    }
  }

  it('wraps a post-SMTP database exception before pg-boss stores or logs it', async () => {
    const payload = await invitation()
    const cleanup = await failResultCommit(payload)
    try {
      await runPollingWorker(
        payload,
        deps(async () => {}),
        deliverInvitationEmail,
        'failed',
      )
      expect(logs.some((line) => line.includes('invitation_email_delivery_unavailable'))).toBe(true)
      await assertPrivateArtifacts(payload)
    } finally {
      await cleanup()
    }
  })

  async function verifySafeQueueError(dispatcher = createInvitationEmailDispatcher) {
    const payload = await invitation()
    const dispatch = dispatcher({
      db,
      queue: {
        ...queue,
        enqueue: async () => {
          throw privateError(payload)
        },
      },
    })
    const error = await dispatch(payload).catch((error: unknown) => error)
    expect(error instanceof Error && error.message === 'invitation_email_queue_unavailable').toBe(
      true,
    )
    expect(error instanceof Error && error.cause === undefined).toBe(true)
    expect(await delivery(payload)).toMatchObject({
      state: 'queued',
      attempts: 0,
      last_job_id: null,
    })
    expect((await db.selectFrom('auth.member').selectAll().execute()).length).toBe(1)
  }

  it('returns a fixed queue error while preserving the queued invitation for recovery', async () => {
    await verifySafeQueueError()
  })

  it('detects recipient disclosure in a sender source copy through a real assertion failure', async () => {
    const mutation = (await moduleCopy(
      'invitation-sender.ts',
      "event: 'invitation_email_attempt',",
      "event: 'invitation_email_attempt', recipient: prepared.message.to,",
    )) as typeof import('./invitation-sender.ts')
    const payload = await invitation()
    await mutation.deliverInvitationEmail(
      deps(async () => {}),
      payload,
    )
    await expect(assertPrivateArtifacts(payload)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects an unwrapped database error in a sender source copy through a real assertion failure', async () => {
    const mutation = (await moduleCopy(
      'invitation-sender.ts',
      "  } catch {\n    // A failure after SMTP acceptance deliberately leaves the consumed claim for repair.\n    // Its next finite retry can duplicate mail; no SMTP exactly-once guarantee is possible.\n    throw new Error('invitation_email_delivery_unavailable')\n  }",
      '  } catch (error) { throw error }',
    )) as typeof import('./invitation-sender.ts')
    const payload = await invitation()
    const cleanup = await failResultCommit(payload)
    try {
      await runPollingWorker(
        payload,
        deps(async () => {}),
        mutation.deliverInvitationEmail,
        'failed',
      )
      await expect(assertPrivateArtifacts(payload)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    } finally {
      await cleanup()
    }
  })

  it('detects a permissive payload source copy through a real assertion failure', async () => {
    const verify = (schema: typeof InvitationEmailPayload) => {
      expect(
        schema.safeParse({
          invitationId: randomUUID(),
          generation: 1,
          email: recipient,
          body: privateMarker,
          token: privateMarker,
          link: `${publicUrl}/app/join`,
        }).success,
        'private values cannot enter an invitation job payload',
      ).toBe(false)
    }
    verify(InvitationEmailPayload)
    const mutation = (await moduleCopy(
      'invitation-email.ts',
      'export const InvitationEmailPayload = z.strictObject({',
      'export const InvitationEmailPayload = z.looseObject({',
    )) as typeof import('./invitation-email.ts')
    expect(() => verify(mutation.InvitationEmailPayload)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects an unwrapped queue error in a dispatcher source copy through a real assertion failure', async () => {
    const mutation = (await moduleCopy(
      'invitation-email.ts',
      '    } catch {\n      throw new InvitationEmailQueueError()\n    }',
      '    } catch (error) { throw error }',
    )) as typeof import('./invitation-email.ts')
    await expect(
      verifySafeQueueError(mutation.createInvitationEmailDispatcher),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
