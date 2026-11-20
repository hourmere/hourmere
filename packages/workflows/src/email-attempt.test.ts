import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createDb, type Db, guardPoolErrors } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createSmtpMailer, type Mailer, type MailMessage } from '@hourmere/mail'
import { createNotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fakeSmtpServer } from '../../mail/src/smtp-testing.ts'
import { reserveInvitationEmailBudget } from '../../notifications/src/invitation-mail-limits.ts'
import { type WorkflowAuditEvent, workflowAuditPort } from './audit.ts'
import { captureBookingWorkflows } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import {
  claimDueWorkflowRuns,
  repairWorkflowRunWakes,
  WORKFLOW_CLAIM_SECONDS,
  type WorkflowRunClaim,
} from './dispatcher.ts'
import type { WorkflowEmailAction } from './email.ts'
import {
  attemptWorkflowEmail,
  finishWorkflowEmailAttempt,
  markWorkflowEmailAttempt,
} from './email-attempt.ts'
import {
  expectWorkflowAuditRedacted,
  workflowExecutionAuditRow,
  workflowJournal,
} from './testing.ts'

const DUE = Temporal.Instant.from('2035-01-08T12:00:00Z')
const START = DUE.add({ minutes: 90 })
const END = START.add({ minutes: 30 })
const SECRET = 'synthetic-workflow-attempt-secret'
const PRIVATE_BODY = 'Confidential workflow SMTP fixture body'
const PRIVATE_ANSWER = 'Confidential workflow SMTP fixture answer'
const action: WorkflowEmailAction = { type: 'email', recipients: ['booker'] }
const atDate = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds)
const atInstant = (value: Date) => Temporal.Instant.fromEpochMilliseconds(value.getTime())

function localMailer(port: number) {
  return createSmtpMailer({
    url: `smtp://fake:password@127.0.0.1:${port}`,
    from: 'workflows@example.test',
  })
}

/** Observe the message passed to SMTP, including attempts that fail before MIME reaches DATA. */
function observeSmtp(mailer: Mailer, beforeSend: (message: MailMessage) => void): Mailer {
  const send = mailer.sendWorkflowAttempt
  if (!send) throw new Error('Expected a workflow SMTP mailer')
  return {
    ...mailer,
    async sendWorkflowAttempt(message) {
      beforeSend(message)
      return send.call(mailer, message)
    },
  }
}

describe.skipIf(!process.env.DATABASE_URL)('workflow email attempts', () => {
  let owned: TestDatabase
  let db: Db
  let attemptPool: pg.Pool | undefined
  let worker: Db
  let workerPid: number
  let smtp: ReturnType<typeof fakeSmtpServer>
  let mailer: Mailer

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'wf_email',
    })
    owned.pool.options.max = 3
    db = createDb(owned.pool)
    attemptPool = new pg.Pool({ connectionString: owned.url, max: 1, idleTimeoutMillis: 0 })
    guardPoolErrors(attemptPool)
    worker = createDb(attemptPool)
    const status = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(worker)
    workerPid = status.rows[0]?.pid as number
    await sql`CREATE TABLE test_email_wakes (run_id uuid PRIMARY KEY)`.execute(db)
  })

  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('workflow_mail_reservations').execute()
    smtp = fakeSmtpServer()
    smtp.server.listen(0, '127.0.0.1')
    await once(smtp.server, 'listening')
    mailer = localMailer((smtp.server.address() as { port: number }).port)
  })

  afterEach(async () => {
    for (const socket of smtp.sockets) socket.destroy()
    await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
  })

  afterAll(async () => {
    try {
      await attemptPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture(privateContent = false) {
    const user = await createTestUser(db)
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const fixtures = createFixtures(db)
    const title = 'Workflow attempt fixture'
    const eventTypeId = await fixtures.eventType(team.id, null, {
      title,
      hosts: [{ userId: user.id }],
    })
    const clock = { now: DUE.subtract({ hours: 72 }) }
    const context = testContext(db, team.as(user), () => clock.now)
    const workflow = await createWorkflowDefinition(context, {
      owner: { kind: 'team', id: team.id },
      idempotencyKey: randomUUID(),
      name: title,
      scope: { type: 'all_event_types' },
      trigger: { type: 'before_start', offsetMinutes: 90 },
      actions: [
        privateContent
          ? { ...action, content: { en: { subject: title, body: PRIVATE_BODY } } }
          : action,
      ],
      enabled: true,
    })
    const attendee = { name: 'Fixture booker', email: `${randomUUID()}@example.test` }
    const bookingId = await fixtures.booking(team.id, [user.id], START.toString(), END.toString(), {
      eventTypeId,
      attendee,
    })
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bookings')
        .set({
          ...(privateContent && { responses: JSON.stringify({ notes: PRIVATE_ANSWER }) }),
          notification_snapshot: JSON.stringify(
            createNotificationSnapshot({ reminders: [], followUps: [] }),
          ),
        })
        .where('id', '=', bookingId)
        .execute()
      await captureBookingWorkflows(
        trx,
        { type: 'created', bookingId, start: START },
        clock.now,
        SECRET,
      )
    })
    const run = await db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    const savedRun = () =>
      db.selectFrom('workflow_runs').selectAll().where('id', '=', run.id).executeTakeFirstOrThrow()
    const recipient = async (connection = db) => {
      const recipients = await connection
        .selectFrom('workflow_recipient_claims')
        .selectAll()
        .where('run_id', '=', run.id)
        .execute()
      expect(recipients).toHaveLength(1)
      const row = recipients[0]
      if (!row) throw new Error('Expected a captured recipient')
      return row
    }
    const savedHistory = () =>
      db.selectFrom('workflow_run_history').selectAll().where('run_id', '=', run.id).execute()
    const firstRecipient = await recipient()
    expect(run.due_at).toEqual(atDate(DUE))
    expect(run.expires_at).toEqual(atDate(DUE.add({ minutes: 60 })))
    expect(firstRecipient).toMatchObject({
      state: 'pending',
      intent_kind: 'before_start',
      intent_offset_minutes: 90,
    })
    const execution = (transport = mailer, database = worker) => ({
      db: database,
      now: context.now,
      mailer: transport,
      followUpHostNotesEnabled: () => true,
      budget: { secret: SECRET, workflowMailMaxPerHour: 1, workflowOwnerMailMaxPerHour: 1 },
    })
    const claimDue = (database = worker) =>
      claimDueWorkflowRuns(execution(mailer, database), { runId: run.id })
    const claim = async () => {
      const claims = await claimDue()
      expect(claims).toHaveLength(1)
      const taken = claims[0]
      if (!taken) throw new Error('Expected the due workflow run to be claimed')
      return taken
    }
    const attempt = (current: WorkflowRunClaim, transport = mailer) =>
      attemptWorkflowEmail(execution(transport), current, firstRecipient.id)
    clock.now = DUE
    return {
      attempt,
      claim,
      claimDue,
      clock,
      execution,
      firstRecipient,
      attendee,
      bookingId,
      recipient,
      run,
      savedHistory,
      savedRun,
      team,
      title,
      user,
      workflow,
    }
  }

  async function expectAudit(
    scenario: Awaited<ReturnType<typeof fixture>>,
    expected: readonly [WorkflowAuditEvent, ('dispatch' | 'repair')?][],
    connection = db,
  ) {
    const records = await workflowJournal(connection, scenario.team.id)
      .where('action', 'like', 'workflow.email_%')
      .execute()
    expectWorkflowAuditRedacted(records, [
      SECRET,
      PRIVATE_BODY,
      PRIVATE_ANSWER,
      scenario.title,
      scenario.attendee.email,
      scenario.attendee.name,
      scenario.bookingId,
      scenario.run.id,
      scenario.firstRecipient.id,
    ])
    expect(records).toEqual(
      expected.map(([event, job = 'dispatch']) =>
        workflowExecutionAuditRow(scenario.team.id, scenario.workflow.id, event, job, {
          revision: 1,
          trigger: 'before_start',
        }),
      ),
    )
  }

  async function oneCharge() {
    const reservations = await db.selectFrom('workflow_mail_reservations').selectAll().execute()
    expect(reservations).toHaveLength(1)
    const reservation = reservations[0]
    if (!reservation) throw new Error('Expected a workflow mail reservation')
    const charges = await db
      .selectFrom('notification_email_sends')
      .selectAll()
      .where('workflow_reservation_id', 'is not', null)
      .execute()
    expect(charges).toEqual([
      expect.objectContaining({
        workflow_reservation_id: reservation.id,
        sent_at: reservation.reserved_at,
      }),
    ])
    return reservation
  }

  async function retryAt(s: Awaited<ReturnType<typeof fixture>>) {
    const recipient = await s.recipient()
    expect(recipient).toMatchObject({ state: 'pending', claim_token: null, finished_at: null })
    expect(recipient.next_attempt_at).toBeInstanceOf(Date)
    return atInstant(recipient.next_attempt_at as Date)
  }

  it.each(['connection', 'greeting', 'authentication'] as const)(
    'retries a failed %s with the same reservation, recipient intent and Message-ID',
    async (phase) => {
      const s = await fixture(true)
      const ids: (string | undefined)[] = []
      const remember = (message: MailMessage) => ids.push(message.messageId)
      let failure = mailer
      if (phase === 'connection') {
        const unreachable = fakeSmtpServer()
        unreachable.server.listen(0, '127.0.0.1')
        await once(unreachable.server, 'listening')
        failure = localMailer((unreachable.server.address() as { port: number }).port)
        await new Promise<void>((resolve) => unreachable.server.close(() => resolve()))
      } else if (phase === 'greeting') {
        smtp.received.greetingReply = '421 4.3.2 unavailable'
      } else {
        smtp.received.authReply = '535 5.7.8 authentication failed'
      }
      const first = await s.claim()
      expect(await s.attempt(first, observeSmtp(failure, remember))).toBe('retry_scheduled')
      await expectAudit(s, [['workflow.email_attempted']])
      expect(smtp.received.to).toEqual([])
      expect(smtp.received.messages).toEqual([])
      const original = await oneCharge()
      expect(original).toMatchObject({
        claim_id: s.firstRecipient.id,
        run_id: s.run.id,
        reserved_at: atDate(DUE),
      })

      const due = await retryAt(s)
      const wake = {
        ensureWake: async (trx: Db, runId: string) => {
          await sql`INSERT INTO test_email_wakes (run_id) VALUES (${runId}) ON CONFLICT DO NOTHING`.execute(
            trx,
          )
        },
      }
      const savedWakes = () =>
        sql<{
          run_id: string
        }>`SELECT run_id FROM test_email_wakes WHERE run_id=${s.run.id}`.execute(db)
      s.clock.now = due.subtract({ milliseconds: 1 })
      await repairWorkflowRunWakes(s.execution(), wake)
      expect((await savedWakes()).rows).toEqual([])
      expect(await s.claimDue()).toEqual([])

      smtp.received.greetingReply = undefined
      smtp.received.authReply = undefined
      s.clock.now = due
      await repairWorkflowRunWakes(s.execution(), wake)
      await repairWorkflowRunWakes(s.execution(), wake)
      expect((await savedWakes()).rows).toEqual([{ run_id: s.run.id }])
      const second = await s.claim()
      expect(second.token).not.toBe(first.token)
      expect(await s.attempt(second, observeSmtp(mailer, remember))).toBe('sent')
      expect(ids).toEqual([expect.any(String), ids[0]])
      expect(smtp.received.messages).toHaveLength(1)
      const wireId = smtp.received.messages[0]
        ?.replace(/\r\n[ \t]+/g, ' ')
        .match(/^Message-ID: (.+)$/im)?.[1]
        ?.trim()
      expect(wireId?.replace(/[<>]/g, '')).toBe(ids[0]?.replace(/[<>]/g, ''))
      expect(await oneCharge()).toEqual({ ...original, reserved_at: atDate(due) })
      expect(await s.recipient()).toMatchObject({
        id: s.firstRecipient.id,
        intent_kind: s.firstRecipient.intent_kind,
        intent_offset_minutes: s.firstRecipient.intent_offset_minutes,
        recipient_hash: s.firstRecipient.recipient_hash,
        attempts: 2,
        state: 'sent',
        claim_token: null,
        next_attempt_at: null,
      })
      expect(await s.savedHistory()).toMatchObject([{ outcome: 'completed', sent: 1 }])
      expect(
        await finishWorkflowEmailAttempt(s.execution(), second, s.firstRecipient.id, 'sent'),
      ).toBe('stale')
      await expectAudit(s, [
        ['workflow.email_attempted'],
        ['workflow.email_attempted'],
        ['workflow.email_sent'],
      ])
    },
  )

  it('recounts shared capacity before a retry and suppresses SMTP without restamping a denied charge', async () => {
    const s = await fixture()
    const limits = { ...s.execution().budget, mailMaxPerHour: 5 }
    smtp.received.greetingReply = '421 4.3.2 unavailable'
    expect(
      await attemptWorkflowEmail(
        { ...s.execution(), budget: limits },
        await s.claim(),
        s.firstRecipient.id,
      ),
    ).toBe('retry_scheduled')
    const original = await oneCharge()
    s.clock.now = await retryAt(s)
    await db
      .insertInto('notification_email_sends')
      .values(
        Array.from({ length: 5 }, () => ({
          sent_at: atDate(s.clock.now),
          recipient_hash: null,
        })),
      )
      .execute()
    smtp.received.greetingReply = undefined
    expect(
      await attemptWorkflowEmail(
        { ...s.execution(), budget: limits },
        await s.claim(),
        s.firstRecipient.id,
      ),
    ).toBe('budget_suppressed')
    expect(smtp.received.connections).toBe(1)
    expect(await oneCharge()).toEqual(original)
    expect(await s.recipient()).toMatchObject({
      state: 'skipped',
      skip_reason: 'budget_suppressed',
      attempts: 1,
    })
  })

  it('does not send when the live attendee address no longer matches the captured recipient', async () => {
    const s = await fixture()
    const taken = await s.claim()
    await db
      .updateTable('booking_attendees')
      .set({ email: 'changed-after-capture@example.test' })
      .where('booking_id', '=', s.bookingId)
      .execute()
    expect(await s.attempt(taken)).toBe('stale')
    expect(smtp.received.connections).toBe(0)
    expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([])
    expect(await s.recipient()).toMatchObject({
      state: 'pending',
      attempts: 0,
      next_attempt_at: s.run.expires_at,
    })
    expect(await s.savedRun()).toMatchObject({ state: 'pending', claim_token: null })
    expect(await s.claimDue()).toEqual([])
  })

  it('cannot reverse a newer marker using the claim token of an earlier SMTP attempt', async () => {
    const s = await fixture()
    smtp.received.authReply = '535 5.7.8 authentication failed'
    const first = await s.claim()
    expect(await s.attempt(first)).toBe('retry_scheduled')
    s.clock.now = await retryAt(s)
    const second = await s.claim()
    expect(
      await markWorkflowEmailAttempt(s.execution(), second, s.firstRecipient.id),
    ).toMatchObject({ message: { to: s.attendee.email } })
    const marker = await s.recipient()
    expect(marker).toMatchObject({ state: 'dispatching', claim_token: second.token, attempts: 2 })
    expect(
      await finishWorkflowEmailAttempt(s.execution(), first, s.firstRecipient.id, 'known_not_sent'),
    ).toBe('stale')
    expect(await s.recipient()).toEqual(marker)
    expect(await s.savedRun()).toMatchObject({ state: 'claimed', claim_token: second.token })
    expect(await oneCharge()).toMatchObject({ reserved_at: atDate(s.clock.now) })
  })

  it.each(['MAIL', 'RCPT', 'DATA', 'after DATA'] as const)(
    'makes a definitive permanent %s rejection terminal',
    async (phase) => {
      const s = await fixture(true)
      const response = '550 5.7.1 message refused'
      if (phase === 'MAIL') smtp.received.mailReply = response
      if (phase === 'RCPT') smtp.received.rcptReplies.set(s.attendee.email, response)
      if (phase === 'DATA') smtp.received.dataStartReply = response
      if (phase === 'after DATA') smtp.received.dataReply = response
      const taken = await s.claim()
      expect(await s.attempt(taken)).toBe('rejected')
      expect(await s.recipient()).toMatchObject({
        state: 'rejected',
        attempts: 1,
        next_attempt_at: null,
      })
      expect(smtp.received.messages).toHaveLength(phase === 'after DATA' ? 1 : 0)
      await oneCharge()
      s.clock.now = DUE.add({ minutes: 30 })
      expect(await s.claimDue()).toEqual([])
      expect(await s.attempt(taken)).toBe('stale')
      expect(smtp.received.connections).toBe(1)
      expect(await s.savedHistory()).toMatchObject([{ outcome: 'completed', rejected: 1 }])
      await expectAudit(s, [['workflow.email_attempted'], ['workflow.email_rejected']])
    },
  )

  it('records terminal ambiguity after a disconnect after DATA and never replays SMTP', async () => {
    const s = await fixture(true)
    smtp.received.disconnectAfterData = true
    const taken = await s.claim()
    expect(await s.attempt(taken)).toBe('delivery_unknown')
    expect(await s.recipient()).toMatchObject({
      state: 'delivery_unknown',
      attempts: 1,
      claim_token: null,
      next_attempt_at: null,
    })
    const charged = await oneCharge()
    smtp.received.disconnectAfterData = false
    s.clock.now = DUE.add({ minutes: 30 })
    expect(await s.claimDue()).toEqual([])
    expect(await s.attempt(taken)).toBe('stale')
    expect(await s.savedHistory()).toMatchObject([{ outcome: 'completed', delivery_unknown: 1 }])
    expect(smtp.received.connections).toBe(1)
    expect(smtp.received.messages).toHaveLength(1)
    expect(await oneCharge()).toEqual(charged)
    await expectAudit(s, [['workflow.email_attempted'], ['workflow.email_delivery_unknown']])
  })

  it('repairs a worker lost after marker commit and before SMTP as delivery unknown', async () => {
    const s = await fixture(true)
    const taken = await s.claim()
    expect(await markWorkflowEmailAttempt(s.execution(), taken, s.firstRecipient.id)).toMatchObject(
      { message: { to: s.attendee.email } },
    )
    expect(await s.recipient()).toMatchObject({ state: 'dispatching', claim_token: taken.token })
    const charged = await oneCharge()
    s.clock.now = DUE.add({ seconds: WORKFLOW_CLAIM_SECONDS })
    expect(await s.claimDue(db)).toEqual([])
    expect(await s.recipient()).toMatchObject({
      state: 'delivery_unknown',
      attempts: 1,
      claim_token: null,
      next_attempt_at: null,
    })
    expect(await s.attempt(taken)).toBe('stale')
    expect(await s.savedHistory()).toMatchObject([{ outcome: 'completed', delivery_unknown: 1 }])
    expect(smtp.received.connections).toBe(0)
    expect(await oneCharge()).toEqual(charged)
    expect(await s.claimDue(db)).toEqual([])
    await expectAudit(s, [
      ['workflow.email_attempted'],
      ['workflow.email_delivery_unknown', 'repair'],
    ])
  })

  it('rolls back a recorded email marker and its charge before SMTP can run', async () => {
    const s = await fixture(true)
    const taken = await s.claim()
    const rollback = new Error('Rollback after recording the email marker')
    await expect(
      attemptWorkflowEmail(
        {
          ...s.execution(mailer, db),
          audit: {
            async record(trx, record) {
              expect(await s.recipient(trx)).toMatchObject({ state: 'dispatching', attempts: 1 })
              await workflowAuditPort.record(trx, record)
              await expectAudit(s, [['workflow.email_attempted']], trx)
              await expectAudit(s, [])
              throw rollback
            },
          },
        },
        taken,
        s.firstRecipient.id,
      ),
    ).rejects.toBe(rollback)
    await expectAudit(s, [])
    expect(await s.recipient()).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([])
    expect(smtp.received.connections).toBe(0)

    expect(await s.attempt(taken)).toBe('sent')
    await expectAudit(s, [['workflow.email_attempted'], ['workflow.email_sent']])
  })

  it('repairs a worker lost after actual SMTP acceptance and ignores its late result', async () => {
    const s = await fixture()
    const taken = await s.claim()
    const accepted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const send = mailer.sendWorkflowAttempt
    if (!send) throw new Error('Expected a workflow SMTP mailer')
    const interrupted = s.attempt(taken, {
      ...mailer,
      async sendWorkflowAttempt(message) {
        const outcome = await send.call(mailer, message)
        expect(outcome).toBe('sent')
        accepted.resolve()
        await release.promise
        return outcome
      },
    })
    try {
      const reached = await Promise.race([
        accepted.promise.then(() => true),
        interrupted.then(() => false),
      ])
      expect(reached).toBe(true)
      expect(await s.recipient()).toMatchObject({ state: 'dispatching', claim_token: taken.token })
      expect(smtp.received.messages).toHaveLength(1)
      expect(await s.claimDue(db)).toEqual([])
      expect(await s.attempt(taken)).toBe('stale')
      s.clock.now = DUE.add({ seconds: WORKFLOW_CLAIM_SECONDS })
      expect(await s.claimDue(db)).toEqual([])
      expect(await s.recipient()).toMatchObject({ state: 'delivery_unknown', attempts: 1 })
    } finally {
      release.resolve()
    }
    expect(await interrupted).toBe('stale')
    expect(await s.attempt(taken)).toBe('stale')
    expect(smtp.received.connections).toBe(1)
    expect(smtp.received.messages).toHaveLength(1)
    expect(await s.savedHistory()).toMatchObject([{ outcome: 'completed', delivery_unknown: 1 }])
    await oneCharge()
  })

  it('uses bounded backoff and expires at due plus 60 minutes during a longer outage', async () => {
    const s = await fixture()
    smtp.received.greetingReply = '421 4.3.2 unavailable'
    // Starting late makes the final backoff cross the due window unless it is clamped.
    s.clock.now = DUE.add({ seconds: 30 })
    const schedule = [90, 210, 450, 930, 1830, 2730, 3600]
    for (const seconds of schedule) {
      expect(await s.attempt(await s.claim())).toBe('retry_scheduled')
      const next = await retryAt(s)
      expect(next.equals(DUE.add({ seconds }))).toBe(true)
      s.clock.now = next.subtract({ milliseconds: 1 })
      expect(await s.claimDue()).toEqual([])
      s.clock.now = next
    }
    expect(await s.claimDue()).toEqual([])
    expect(await s.savedRun()).toMatchObject({
      state: 'skipped',
      skip_reason: 'expired',
      finished_at: atDate(DUE.add({ minutes: 60 })),
    })
    expect(await s.recipient()).toMatchObject({
      state: 'skipped',
      skip_reason: 'expired',
      attempts: schedule.length,
      next_attempt_at: null,
    })
    expect(await s.savedHistory()).toMatchObject([{ outcome: 'skipped', reason: 'expired' }])
    smtp.received.greetingReply = undefined
    s.clock.now = DUE.add({ hours: 2 })
    expect(await s.claimDue()).toEqual([])
    expect(smtp.received.connections).toBe(schedule.length)
    expect(smtp.received.messages).toEqual([])
    expect(await oneCharge()).toMatchObject({
      reserved_at: atDate(DUE.add({ minutes: 45, seconds: 30 })),
    })
  })

  it('lets an invitation competitor take the organization and budget first while a retry waits', async () => {
    const s = await fixture()
    smtp.received.authReply = '535 5.7.8 authentication failed'
    expect(await s.attempt(await s.claim())).toBe('retry_scheduled')
    smtp.received.authReply = undefined
    s.clock.now = await retryAt(s)
    const taken = await s.claim()
    const locked = Promise.withResolvers<number>()
    const proceed = Promise.withResolvers<void>()
    const invitation = db.transaction().execute(async (trx) => {
      const result = await sql<{
        pid: number
      }>`SELECT pg_backend_pid() AS pid FROM auth.organization WHERE id=${s.team.id} FOR UPDATE`.execute(
        trx,
      )
      locked.resolve(result.rows[0]?.pid as number)
      await proceed.promise
      return reserveInvitationEmailBudget(
        trx,
        { organizationId: s.team.id, userId: s.user.id, email: 'invitation@example.test' },
        { secret: SECRET },
        atDate(s.clock.now),
      )
    })
    const competitorPid = await locked.promise
    const pending = s.attempt(taken)
    try {
      // Use the database's wait graph to place the two transactions without a timer.
      let waiting = false
      for (let probe = 0; probe < 1000 && !waiting; probe++) {
        const result = await sql<{
          waiting: boolean
        }>`SELECT ${competitorPid}=ANY(pg_blocking_pids(${workerPid})) AS waiting`.execute(db)
        waiting = result.rows[0]?.waiting === true
      }
      expect(waiting).toBe(true)
      expect(smtp.received.connections).toBe(1)
    } finally {
      proceed.resolve()
    }
    expect(await invitation).toBe(true)
    expect(await pending).toBe('sent')
    expect(smtp.received.messages).toHaveLength(1)
    expect(smtp.received.to).toEqual([expect.stringContaining(`<${s.attendee.email}>`)])
    expect(await oneCharge()).toMatchObject({ reserved_at: atDate(s.clock.now) })
  })
})
