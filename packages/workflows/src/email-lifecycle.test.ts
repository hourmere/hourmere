import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createDb, type Db, guardPoolErrors } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createSmtpMailer, type Mailer } from '@hourmere/mail'
import {
  deliverScheduledBookingEmail,
  enqueueScheduledBookingEmails,
  type NotificationDeps,
  reserveInvitationEmailBudget,
  scheduledBookingEmailJob,
} from '@hourmere/notifications'
import { type BookingNotifier, cancelHostBooking } from '@hourmere/scheduling'
import { createNotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSmtpServer } from '../../mail/src/smtp-testing.ts'
import { alignSmtpDateNowWithDatabase } from '../../notifications/src/testing-clock.ts'
import { captureBookingWorkflows } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'
import { claimDueWorkflowRuns, type WorkflowRunClaim } from './dispatcher.ts'
import { attemptWorkflowEmail } from './email-attempt.ts'
import { updateWorkflowDefinition } from './updates.ts'

// Keep the scheduled wake within pg-boss retention on the real database clock.
const CREATED = Temporal.Instant.from('2036-11-01T12:00:00Z')
const START = CREATED.add({ hours: 72 })
const END = START.add({ minutes: 30 })
const OFFSET_MINUTES = 90
const DUE = START.subtract({ minutes: OFFSET_MINUTES })
const SECRET = 'synthetic-email-lifecycle-secret'
const TITLE = 'Workflow lifecycle fixture'
const CUSTOM = { subject: 'Stored custom subject', body: 'Stored custom body' }
const reminder = {
  id: 'overlapping-reminder',
  offsetMinutes: OFFSET_MINUTES,
  recipients: { invitee: true, guests: false, host: false },
}

async function reached<T>(barrier: Promise<T>, operation: Promise<unknown>) {
  return Promise.race([
    barrier,
    operation.then(() => {
      throw new Error('Operation finished before its barrier')
    }),
  ])
}

describe.skipIf(!process.env.DATABASE_URL)('workflow email lifecycle', () => {
  let owned: TestDatabase
  let db: Db
  let marker: Db
  let competitor: Db
  let markerPid: number
  let jobs: ReturnType<typeof createJobs<readonly [ReturnType<typeof scheduledBookingEmailJob>]>>
  let smtp: ReturnType<typeof fakeSmtpServer>
  let mailer: Mailer
  const pools: pg.Pool[] = []

  const notificationDeps = (now: () => Temporal.Instant): NotificationDeps => ({
    db,
    get mailer() {
      return mailer
    },
    secret: SECRET,
    publicUrl: 'https://schedule.example.test',
    now,
    log: () => {},
  })

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'wf_email_life',
    })
    db = createDb(owned.pool)
    function roleConnection() {
      const pool = new pg.Pool({
        connectionString: owned.url,
        max: 1,
        idleTimeoutMillis: 0,
        options: '-c lock_timeout=5000',
      })
      guardPoolErrors(pool)
      pools.push(pool)
      return createDb(pool)
    }
    marker = roleConnection()
    competitor = roleConnection()
    markerPid = await backendPid(marker)
    expect(markerPid).not.toBe(await backendPid(competitor))
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [scheduledBookingEmailJob(notificationDeps(() => DUE))] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await Promise.all(pools.map((pool) => pool.end()))
      await owned?.drop()
    }
  })

  beforeEach(async () => {
    smtp = fakeSmtpServer()
    smtp.server.listen(0, '127.0.0.1')
    await once(smtp.server, 'listening')
    const address = smtp.server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback SMTP port')
    mailer = createSmtpMailer({
      url: `smtp://fake:password@127.0.0.1:${address.port}`,
      from: 'workflows@example.test',
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const socket of smtp?.sockets ?? []) socket.destroy()
    if (smtp?.server.listening)
      await new Promise<void>((resolve) => smtp.server.close(() => resolve()))
  })

  async function backendPid(database: Db) {
    return (
      await database.selectNoFrom(sql<number>`pg_backend_pid()`.as('pid')).executeTakeFirstOrThrow()
    ).pid
  }

  async function waitForCompetitor(competitorPid: number) {
    for (let probe = 0; probe < 1000; probe++) {
      const { waiting } = await db
        .selectNoFrom(
          sql<boolean>`${competitorPid}=ANY(pg_blocking_pids(${markerPid}))`.as('waiting'),
        )
        .executeTakeFirstOrThrow()
      if (waiting) return
    }
    throw new Error('Workflow marker never waited for its competitor')
  }

  async function raceAhead<T>(
    mutate: (pause: (trx: Db) => Promise<void>) => Promise<T>,
    attempt: () => ReturnType<typeof attemptWorkflowEmail>,
    whileWaiting?: () => void,
  ) {
    const locked = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const mutation = mutate(async (trx) => {
      locked.resolve(await backendPid(trx))
      await release.promise
    })
    const blocker = await reached(locked.promise, mutation)
    const pending = attempt()
    try {
      await waitForCompetitor(blocker)
      expect(smtp.received.connections).toBe(0)
      whileWaiting?.()
    } finally {
      release.resolve()
      await Promise.all([mutation, pending])
    }
    return pending
  }

  async function fixture({ overlap = false, custom = false, guest = false } = {}) {
    const user = await createTestUser(db)
    const organizationId = user.principal.organization.id
    const fixtures = createFixtures(db)
    const handle = `mail-${randomUUID().slice(0, 8)}`
    const slug = 'lifecycle'
    const eventTypeId = await fixtures.eventType(organizationId, user.id, { title: TITLE, slug })
    if (custom)
      await db
        .insertInto('profiles')
        .values({ user_id: user.id, handle, time_zone: 'UTC' })
        .execute()
    const clock = { now: CREATED }
    const now = () => clock.now
    const policy = { enabled: true }
    const ctx = (database = competitor) => testContext(database, user.principal, now)
    const workflow = await createWorkflowDefinition(
      { ...ctx(db), followUpHostNotesEnabled: policy.enabled },
      {
        owner: { kind: 'personal', id: user.id },
        idempotencyKey: randomUUID(),
        name: TITLE,
        scope: { type: 'all_event_types' },
        trigger: { type: 'before_start', offsetMinutes: OFFSET_MINUTES },
        actions: [
          {
            type: 'email',
            recipients: guest ? ['booker', 'guests'] : ['booker'],
            ...(custom && {
              content: { en: { ...CUSTOM, body: `${CUSTOM.body}\n{{event_type.public_path}}` } },
            }),
          },
        ],
        enabled: true,
      },
    )
    const bookerEmail = `${randomUUID()}@example.test`
    const bookingId = await fixtures.booking(
      organizationId,
      [user.id],
      START.toString(),
      END.toString(),
      {
        eventTypeId,
        attendee: { name: 'Booker', email: bookerEmail },
      },
    )
    const notify: BookingNotifier = (trx, event, at) =>
      captureBookingWorkflows(trx, event, at, SECRET)
    const guestEmail = `${randomUUID()}@example.test`
    const { id: bookerId } = await db
      .updateTable('booking_attendees')
      .set({ locale: 'en' })
      .where('booking_id', '=', bookingId)
      .where('is_booker', '=', true)
      .returning('id')
      .executeTakeFirstOrThrow()
    const guestRow = guest
      ? await db
          .insertInto('booking_attendees')
          .values({ booking_id: bookingId, name: 'Guest', email: guestEmail, time_zone: 'UTC' })
          .returning('id')
          .executeTakeFirstOrThrow()
      : undefined
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bookings')
        .set({
          notification_snapshot: JSON.stringify(
            createNotificationSnapshot({
              reminders: overlap ? [reminder] : [],
              followUps: [],
            }),
          ),
        })
        .where('id', '=', bookingId)
        .execute()
      await enqueueScheduledBookingEmails(jobs, trx, bookingId, clock.now)
      await notify(trx, { type: 'created', bookingId, start: START }, clock.now)
    })
    const run = () =>
      db
        .selectFrom('workflow_runs')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .executeTakeFirstOrThrow()
    const { id: runId } = await run()
    const recipient = (attendeeId = bookerId) =>
      db
        .selectFrom('workflow_recipient_claims')
        .selectAll()
        .where('run_id', '=', runId)
        .where('recipient', '=', `attendee:${attendeeId}`)
        .executeTakeFirstOrThrow()
    const reservations = () =>
      db
        .selectFrom('workflow_mail_reservations')
        .select('claim_id')
        .where('run_id', '=', runId)
        .execute()
    const scheduledReminder = () =>
      db
        .selectFrom('booking_scheduled_messages')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .executeTakeFirstOrThrow()
    const execution = (transport = mailer, database = marker) => ({
      db: database,
      now,
      mailer: transport,
      budget: { secret: SECRET },
      followUpHostNotesEnabled: () => policy.enabled,
    })
    const claim = async () => {
      const claims = await claimDueWorkflowRuns(execution(), { runId })
      expect(claims).toHaveLength(1)
      const taken = claims[0]
      if (!taken) throw new Error('Expected a due email run')
      return taken
    }
    const attempt = async (taken: WorkflowRunClaim, transport = mailer) =>
      attemptWorkflowEmail(execution(transport), taken, (await recipient()).id)
    clock.now = DUE
    return {
      attempt,
      bookingId,
      bookerEmail,
      bookingPath: `/${handle}/${slug}`,
      claim,
      ctx,
      execution,
      guestEmail,
      guestRow,
      now,
      notify,
      organizationId,
      policy,
      recipient,
      reservations,
      run,
      scheduledReminder,
      user,
      workflow,
    }
  }

  it('gives an overlapping booker intent to the core reminder and still sends to a non-overlapping guest', async () => {
    await alignSmtpDateNowWithDatabase(db)
    const s = await fixture({ overlap: true, guest: true })
    const reminderRow = await s.scheduledReminder()
    expect(reminderRow).toMatchObject({
      kind: 'reminder',
      rule_id: reminder.id,
      last_job_id: expect.any(String),
    })
    const taken = await s.claim()
    const [booker, guest] = await Promise.all([s.recipient(), s.recipient(s.guestRow?.id)])
    expect(booker).toMatchObject({
      state: 'skipped',
      skip_reason: 'existing_notification',
      intent_kind: null,
      attempts: 0,
    })
    const [, workflowBooker] = await Promise.all([
      deliverScheduledBookingEmail(notificationDeps(s.now), reminderRow.id),
      s.attempt(taken),
    ])
    expect(workflowBooker).toBe('existing_notification')
    expect(await attemptWorkflowEmail(s.execution(), taken, guest.id)).toBe('sent')
    expect(smtp.received.to).toEqual([`RCPT TO:<${s.bookerEmail}>`, `RCPT TO:<${s.guestEmail}>`])
    expect(smtp.received.messages).toHaveLength(2)
    expect(smtp.received.messages[0]).not.toContain('workflow-')
    expect(smtp.received.messages[1]).toContain(`workflow-${guest.id}`)
    expect(await s.recipient()).toMatchObject({
      state: 'skipped',
      skip_reason: 'existing_notification',
      attempts: 0,
    })
    expect(await s.reservations()).toEqual([{ claim_id: guest.id }])
  })

  it('rechecks reminder overlap when the booker changes to the guest mailbox after claim', async () => {
    await alignSmtpDateNowWithDatabase(db)
    const s = await fixture({ overlap: true, guest: true })
    const guest = await s.recipient(s.guestRow?.id)
    expect(guest).toMatchObject({ state: 'pending', intent_kind: 'before_start', attempts: 0 })
    const taken = await s.claim()
    const updatedAddress = s.guestEmail.replace(/^[^@]+/, (local) => local.toUpperCase())
    await expect(
      raceAhead(
        (pause) =>
          competitor.transaction().execute(async (trx) => {
            await trx
              .updateTable('booking_attendees')
              .set({ email: updatedAddress })
              .where('booking_id', '=', s.bookingId)
              .where('is_booker', '=', true)
              .executeTakeFirstOrThrow()
            await pause(trx)
          }),
        () => attemptWorkflowEmail(s.execution(), taken, guest.id),
      ),
    ).resolves.toBe('existing_notification')
    expect(await s.recipient(s.guestRow?.id)).toMatchObject({
      state: 'skipped',
      skip_reason: 'existing_notification',
      attempts: 0,
    })
    expect(await s.reservations()).toEqual([])
    const reminderRow = await s.scheduledReminder()
    await deliverScheduledBookingEmail(notificationDeps(s.now), reminderRow.id)
    expect(smtp.received.to).toEqual([`RCPT TO:<${updatedAddress}>`])
    expect(smtp.received.messages).toHaveLength(1)
  })

  const changes = ['cancel', 'disable', 'delete'] as const
  type Change = (typeof changes)[number]

  async function change(
    s: Awaited<ReturnType<typeof fixture>>,
    operation: Change,
    pause?: (trx: Db) => Promise<void>,
  ) {
    if (operation === 'cancel') {
      // A cancellation can commit without workflow capture while the feature is hard-off.
      // That case leaves the lease for the marker's booking-status check to invalidate.
      await cancelHostBooking({ ...s.ctx(), notify: pause ?? s.notify }, s.bookingId)
    } else {
      const ctx = { ...s.ctx(), audit: { record: pause ?? (async () => {}) } }
      if (operation === 'disable')
        await updateWorkflowDefinition(ctx, s.workflow.id, { expectedRevision: 1, enabled: false })
      else await deleteWorkflowDefinition(ctx, s.workflow.id, { expectedRevision: 1 })
    }
  }

  it.each(changes)(
    'commits %s before a blocked marker and never reaches SMTP',
    async (operation) => {
      const s = await fixture()
      const taken = await s.claim()
      await expect(
        raceAhead(
          (pause) => change(s, operation, pause),
          () => s.attempt(taken),
        ),
      ).resolves.toBe('stale')
      const disabled = operation === 'disable'
      expect(await s.run()).toMatchObject({
        state: disabled ? 'skipped' : 'retired',
        skip_reason: disabled ? 'workflow_disabled' : null,
        lease_until: null,
      })
      expect(await s.recipient()).toMatchObject({ attempts: 0, claim_token: null })
      expect(await s.reservations()).toEqual([])
      expect(smtp.received.connections).toBe(0)
      expect(smtp.received.messages).toEqual([])
    },
  )

  it.each(changes)(
    'permits only the committed attempt when %s commits before SMTP begins',
    async (operation) => {
      const s = await fixture({ guest: true })
      const taken = await s.claim()
      const guest = await s.recipient(s.guestRow?.id)
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const send = mailer.sendWorkflowAttempt
      if (!send) throw new Error('Expected workflow SMTP transport')
      const pending = s.attempt(taken, {
        ...mailer,
        async sendWorkflowAttempt(message) {
          ready.resolve()
          await release.promise
          return send.call(mailer, message)
        },
      })
      try {
        await reached(ready.promise, pending)
        expect(await s.recipient()).toMatchObject({
          state: 'dispatching',
          claim_token: taken.token,
        })
        expect(smtp.received.connections).toBe(0)
        await change(s, operation)
        const replay = s.execution(mailer, competitor)
        expect(await attemptWorkflowEmail(replay, taken, (await s.recipient()).id)).toBe('stale')
        expect(await attemptWorkflowEmail(replay, taken, guest.id)).toBe('stale')
        expect(smtp.received.connections).toBe(0)
      } finally {
        release.resolve()
        await pending
      }
      expect(await pending).toBe('sent')
      const [booker, unsentGuest] = await Promise.all([s.recipient(), s.recipient(s.guestRow?.id)])
      expect(booker).toMatchObject({ state: 'sent', attempts: 1 })
      expect(unsentGuest).toMatchObject({ attempts: 0 })
      expect(smtp.received.to).toEqual([`RCPT TO:<${s.bookerEmail}>`])
      expect(await s.reservations()).toEqual([{ claim_id: booker.id }])
      expect(await claimDueWorkflowRuns(s.execution(), { runId: taken.runId })).toEqual([])
      expect(await s.attempt(taken)).toBe('stale')
      expect(smtp.received.messages).toHaveLength(1)
    },
  )

  it.each([true, false])(
    'applies the live host-text switch (%s) after a booking lock wait',
    async (enabled) => {
      const s = await fixture({ custom: true })
      const taken = await s.claim()
      const lockBooking = (pause: (trx: Db) => Promise<void>) =>
        competitor.transaction().execute(async (trx) => {
          await trx
            .selectFrom('bookings')
            .select('id')
            .where('id', '=', s.bookingId)
            .forUpdate()
            .executeTakeFirstOrThrow()
          await pause(trx)
        })
      await expect(
        raceAhead(
          lockBooking,
          () => s.attempt(taken),
          () => {
            s.policy.enabled = enabled
          },
        ),
      ).resolves.toBe('sent')
      expect(smtp.received.messages).toHaveLength(1)
      const message = smtp.received.messages[0]
      expect(message).toContain(
        `Subject: ${enabled ? CUSTOM.subject : `Upcoming booking: ${TITLE}`}`,
      )
      if (enabled) {
        expect(message).toContain(CUSTOM.body)
        expect(message).toContain(s.bookingPath)
      } else {
        expect(message).toContain(`Your booking for ${TITLE} starts soon.`)
        expect(message).not.toContain(CUSTOM.body)
        expect(message).not.toContain(s.bookingPath)
      }
    },
  )

  it('releases the shared budget lock before SMTP waits for DATA', async () => {
    const s = await fixture()
    const taken = await s.claim()
    const paused = Promise.withResolvers<() => void>()
    smtp.server.once('connection', (socket) => {
      let commands = ''
      const pauseDataReply = (chunk: Buffer) => {
        commands += chunk.toString('ascii')
        if (!/(?:^|\r\n)DATA\r\n/i.test(commands)) return
        socket.removeListener('data', pauseDataReply)
        // Hold the fake server's 354 reply while a separate transaction spends shared budget.
        socket.cork()
        paused.resolve(() => socket.uncork())
      }
      socket.prependListener('data', pauseDataReply)
    })
    const pending = s.attempt(taken)
    const release = await reached(paused.promise, pending)
    try {
      expect(smtp.received.connections).toBe(1)
      expect(smtp.received.messages).toEqual([])
      expect(await s.recipient()).toMatchObject({ state: 'dispatching' })
      await expect(
        competitor.transaction().execute(async (trx) => {
          await sql`SET LOCAL lock_timeout = '1500ms'`.execute(trx)
          return reserveInvitationEmailBudget(
            trx,
            { userId: s.user.id, organizationId: s.organizationId, email: 'invited@example.test' },
            { secret: SECRET },
            new Date(s.now().epochMilliseconds),
          )
        }),
      ).resolves.toBe(true)
      expect(smtp.received.messages).toEqual([])
    } finally {
      release()
      await pending
    }
    expect(await pending).toBe('sent')
    expect(smtp.received.messages).toHaveLength(1)
  })
})
