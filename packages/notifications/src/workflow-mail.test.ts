import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { executionFixture } from '../../db/src/workflow-storage-execution-protections.ts'
import { enrollMeetingPollVoter } from '../../scheduling/src/meeting-poll-voters.ts'
import { createMeetingPoll } from '../../scheduling/src/meeting-polls.ts'
import { workflowRecipientHash as capturedRecipientHash } from '../../workflows/src/capture.ts'
import { reserveInvitationEmailBudget } from './invitation-mail-limits.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
  signInEmailBudget,
  signInRecipientHash,
  workflowRecipientHash,
} from './mail-limits.ts'
import { deliverMeetingPollEmail } from './meeting-polls.ts'
import { admitWorkflowEmail, readmitWorkflowEmail } from './workflow-mail.ts'

const serverUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-workflow-mail-secret'
const NOW = new Date('2026-11-17T12:00:00Z')
const HOUR = 3_600_000

describe.skipIf(!serverUrl)('workflow shared mail admission', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  const clock =
    (at = NOW) =>
    () =>
      Temporal.Instant.fromEpochMilliseconds(at.getTime())
  const deps = (limits = {}, at = NOW) => ({ db, secret: SECRET, now: clock(at), ...limits })
  const request = (owner = organizationId, email = `${randomUUID()}@example.test`) => ({
    organizationId: owner,
    runId: randomUUID(),
    claimId: randomUUID(),
    email,
  })
  async function organization() {
    const id = randomUUID()
    await sql`INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES (${id},'Synthetic owner',${id},now())`.execute(
      db,
    )
    return id
  }
  const rows = () => db.selectFrom('notification_email_sends').selectAll().execute()
  const reservations = () => db.selectFrom('workflow_mail_reservations').selectAll().execute()
  async function history(count: number, at = NOW, hash: Buffer | null = null) {
    if (count)
      await db
        .insertInto('notification_email_sends')
        .values(Array.from({ length: count }, () => ({ recipient_hash: hash, sent_at: at })))
        .execute()
  }
  async function core(trx: Db, invitee = true, at = NOW) {
    await lockNotificationEmailBudget(trx)
    const hash = notificationRecipientHash(`${randomUUID()}@example.test`, SECRET)
    const suppressed = await notificationEmailBudget(trx, {}, hash, invitee, at)
    if (!suppressed)
      await trx
        .insertInto('notification_email_sends')
        .values({ recipient_hash: hash, sent_at: at })
        .execute()
    return !suppressed
  }
  async function waiting(event = 'advisory') {
    for (let i = 0; i < 200; i++) {
      const result = await sql<{
        waiting: boolean
      }>`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event=${event}) AS waiting`.execute(
        db,
      )
      if (result.rows[0]?.waiting) return
      await setTimeout(5)
    }
    throw new Error(`contender did not wait on ${event}`)
  }
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_mail' })
    owned.pool.options.max = 3
    db = createDb(owned.pool)
    organizationId = await organization()
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('workflow_mail_reservations').execute()
    await db.deleteFrom('invitation_email_requests').execute()
  })
  afterAll(async () => {
    try {
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(3)
    } finally {
      await owned?.drop()
    }
  })

  it('charges both rows atomically and isolates normalized workflow hashes from core purposes', async () => {
    const req = request(organizationId, ' Mail@Example.test ')
    const admitted = await admitWorkflowEmail(deps(), req)
    expect(admitted.status).toBe('admitted')
    const ledger = await rows()
    const reserved = await reservations()
    expect(ledger).toHaveLength(1)
    expect(reserved).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      workflow_reservation_id: reserved[0]?.id,
      sent_at: NOW,
      recipient_hash: workflowRecipientHash('mail@example.test', SECRET),
    })
    expect(reserved[0]).toMatchObject({
      organization_id: organizationId,
      run_id: req.runId,
      claim_id: req.claimId,
      reserved_at: NOW,
    })
    expect(workflowRecipientHash(req.email, SECRET)).toEqual(
      capturedRecipientHash(req.email, SECRET),
    )
    expect(workflowRecipientHash(req.email, SECRET)).not.toEqual(
      notificationRecipientHash(req.email, SECRET),
    )
    expect(workflowRecipientHash(req.email, SECRET)).not.toEqual(
      signInRecipientHash(req.email, SECRET),
    )
    expect(workflowRecipientHash(req.email, SECRET)).not.toEqual(
      workflowRecipientHash(req.email, 'another-secret'),
    )
    expect(
      await notificationEmailBudget(
        db,
        { mailRecipientMaxPerHour: 1 },
        notificationRecipientHash(req.email, SECRET),
        true,
        NOW,
      ),
    ).toBeUndefined()
    expect(
      await signInEmailBudget(
        db,
        { signInMailMaxPerHour: 1 },
        signInRecipientHash(req.email, SECRET),
        NOW,
      ),
    ).toBeUndefined()
    expect(await admitWorkflowEmail(deps(), req)).toMatchObject({ status: 'already_reserved' })
    expect(await rows()).toHaveLength(1)
    expect(await reservations()).toHaveLength(1)
  })

  it('rolls back the ledger insertion if the paired reservation fails', async () => {
    await sql`CREATE FUNCTION reject_synthetic_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic reservation failure'; END $$`.execute(
      db,
    )
    await sql`CREATE TRIGGER reject_synthetic_reservation BEFORE INSERT ON workflow_mail_reservations FOR EACH ROW EXECUTE FUNCTION reject_synthetic_reservation()`.execute(
      db,
    )
    try {
      await expect(admitWorkflowEmail(deps(), request())).rejects.toThrow(
        'synthetic reservation failure',
      )
      expect(await rows()).toHaveLength(0)
      expect(await reservations()).toHaveLength(0)
    } finally {
      await sql`DROP TRIGGER reject_synthetic_reservation ON workflow_mail_reservations`.execute(db)
      await sql`DROP FUNCTION reject_synthetic_reservation()`.execute(db)
    }
  })

  it('a workflow flood leaves eighty base and twenty host reserve slots', async () => {
    const owners = await Promise.all(Array.from({ length: 4 }, () => organization()))
    for (const owner of owners) {
      for (let i = 0; i < 5; i++)
        expect(await admitWorkflowEmail(deps(), request(owner))).toMatchObject({
          status: 'admitted',
        })
      expect(await admitWorkflowEmail(deps(), request(owner))).toMatchObject({
        status: 'budget_suppressed',
      })
    }
    expect(await admitWorkflowEmail(deps(), request(await organization()))).toMatchObject({
      status: 'budget_suppressed',
    })
    for (let i = 0; i < 80; i++)
      expect(await db.transaction().execute((trx) => core(trx))).toBe(true)
    expect(await db.transaction().execute((trx) => core(trx))).toBe(false)
    for (let i = 0; i < 20; i++)
      expect(await db.transaction().execute((trx) => core(trx, false))).toBe(true)
    expect(await db.transaction().execute((trx) => core(trx, false))).toBe(false)
    expect(await rows()).toHaveLength(120)
  })

  it.each([1, 2, 3, 4])(
    'a positive core cap of %s has no workflow share',
    async (mailMaxPerHour) => {
      expect(await admitWorkflowEmail(deps({ mailMaxPerHour }), request())).toMatchObject({
        status: 'budget_suppressed',
      })
      expect(await rows()).toHaveLength(0)
    },
  )
  it.each(['workflowMailMaxPerHour', 'workflowOwnerMailMaxPerHour'])(
    'zero %s disables workflow mail even with unlimited global mail',
    async (key) => {
      expect(
        await admitWorkflowEmail(deps({ mailMaxPerHour: 0, [key]: 0 }), request()),
      ).toMatchObject({ status: 'budget_suppressed' })
      expect(await rows()).toHaveLength(0)
    },
  )
  it('unlimited global mail still honors configured workflow subcaps', async () => {
    await history(120)
    const limits = { mailMaxPerHour: 0, workflowMailMaxPerHour: 2, workflowOwnerMailMaxPerHour: 1 }
    expect(await admitWorkflowEmail(deps(limits), request())).toMatchObject({ status: 'admitted' })
    expect(await admitWorkflowEmail(deps(limits), request())).toMatchObject({
      status: 'budget_suppressed',
    })
    expect(await admitWorkflowEmail(deps(limits), request(await organization()))).toMatchObject({
      status: 'admitted',
    })
    expect(await admitWorkflowEmail(deps(limits), request(await organization()))).toMatchObject({
      status: 'budget_suppressed',
    })
  })
  it('fixed recipient windows span owners and exclude exact hourly and daily boundaries', async () => {
    const email = 'repeat@example.test'
    const req = () => request(organizationId, email)
    expect(await admitWorkflowEmail(deps(), req())).toMatchObject({ status: 'admitted' })
    expect(
      await admitWorkflowEmail(deps(), request(await organization(), email.toUpperCase())),
    ).toMatchObject({ status: 'budget_suppressed' })
    for (const hours of [1, 2])
      expect(
        await admitWorkflowEmail(deps({}, new Date(+NOW + hours * HOUR)), req()),
      ).toMatchObject({ status: 'admitted' })
    expect(await admitWorkflowEmail(deps({}, new Date(+NOW + 3 * HOUR)), req())).toMatchObject({
      status: 'budget_suppressed',
    })
    expect(await admitWorkflowEmail(deps({}, new Date(+NOW + 24 * HOUR)), req())).toMatchObject({
      status: 'admitted',
    })
  })
  it('excludes exact global, workflow and owner hourly boundaries', async () => {
    await history(99, new Date(+NOW - HOUR))
    expect(
      await admitWorkflowEmail(
        deps({ workflowMailMaxPerHour: 1, workflowOwnerMailMaxPerHour: 1 }, new Date(+NOW - HOUR)),
        request(),
      ),
    ).toMatchObject({ status: 'admitted' })
    expect(
      await admitWorkflowEmail(
        deps({ workflowMailMaxPerHour: 1, workflowOwnerMailMaxPerHour: 1 }),
        request(),
      ),
    ).toMatchObject({ status: 'admitted' })
  })

  it('re-admits without its own row and restamps both rows, then suppresses without adding or changing charges', async () => {
    const req = request()
    const limits = { workflowMailMaxPerHour: 1, workflowOwnerMailMaxPerHour: 1 }
    const first = await admitWorkflowEmail(deps(limits), req)
    expect(first.status).toBe('admitted')
    if (first.status !== 'admitted') throw new Error('admission missing')
    await history(99)
    const retryAt = new Date(+NOW + 1_000)
    expect(
      await readmitWorkflowEmail(deps(limits, retryAt), {
        ...req,
        reservationId: first.reservationId,
      }),
    ).toMatchObject({ status: 'admitted', reservationId: first.reservationId, sentAt: retryAt })
    expect(await rows()).toHaveLength(100)
    expect((await reservations())[0]?.reserved_at).toEqual(retryAt)
    await history(1)
    const before = await rows()
    expect(
      await readmitWorkflowEmail(deps(limits, new Date(+NOW + 2_000)), {
        ...req,
        reservationId: first.reservationId,
      }),
    ).toMatchObject({ status: 'budget_suppressed' })
    expect(await rows()).toEqual(before)
    expect((await reservations())[0]?.reserved_at).toEqual(retryAt)
  })

  it.each(['owner', 'recipient'] as const)(
    'an aged retry recounts the current %s window',
    async (cap) => {
      const req = request()
      const limits = { workflowOwnerMailMaxPerHour: cap === 'owner' ? 1 : 5 }
      const first = await admitWorkflowEmail(deps(limits), req)
      if (first.status !== 'admitted') throw new Error('admission missing')
      const later = new Date(+NOW + HOUR)
      const fresh = request(organizationId, cap === 'recipient' ? req.email : undefined)
      expect(await admitWorkflowEmail(deps(limits, later), fresh)).toMatchObject({
        status: 'admitted',
      })
      const before = await rows()
      expect(
        await readmitWorkflowEmail(deps(limits, later), {
          ...req,
          reservationId: first.reservationId,
        }),
      ).toMatchObject({ status: 'budget_suppressed' })
      expect(await rows()).toEqual(before)
      expect(await reservations()).toHaveLength(2)
    },
  )

  it('cannot re-admit another owner, run, claim, or mailbox reservation', async () => {
    const req = request()
    const first = await admitWorkflowEmail(deps(), req)
    if (first.status !== 'admitted') throw new Error('admission missing')
    const before = await rows()
    for (const change of [
      { organizationId: await organization() },
      { runId: randomUUID() },
      { claimId: randomUUID() },
      { email: 'foreign@example.test' },
    ]) {
      expect(
        await readmitWorkflowEmail(deps(), {
          ...req,
          ...change,
          reservationId: first.reservationId,
        }),
      ).toMatchObject({ status: 'unavailable' })
    }
    expect(await rows()).toEqual(before)
    expect(await reservations()).toHaveLength(1)
  })

  it.each(['core', 'workflow'] as const)(
    'the %s contender waits before racing for the shared last slot',
    async (contender) => {
      await history(99)
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const blocker = db.transaction().execute(async (trx) => {
        await lockNotificationEmailBudget(trx)
        held.resolve()
        await release.promise
        return core(trx)
      })
      await held.promise
      const pending =
        contender === 'workflow'
          ? admitWorkflowEmail(deps(), request()).then((result) => result.status === 'admitted')
          : db.transaction().execute((trx) => core(trx))
      try {
        await waiting()
      } finally {
        release.resolve()
      }
      expect(await blocker).toBe(true)
      expect(await pending).toBe(false)
      expect(await rows()).toHaveLength(100)
    },
  )

  it('admission waits for invitation organization lock before taking the global budget lock', async () => {
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const invitation = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM auth.organization WHERE id=${organizationId} FOR UPDATE`.execute(trx)
      held.resolve()
      await release.promise
      return reserveInvitationEmailBudget(
        trx,
        { organizationId, userId: randomUUID(), email: 'invite@example.test' },
        { secret: SECRET },
        NOW,
      )
    })
    await held.promise
    const pending = admitWorkflowEmail(deps(), request())
    try {
      await waiting('transactionid')
    } finally {
      release.resolve()
    }
    expect(await invitation).toBe(true)
    expect(await pending).toMatchObject({ status: 'admitted' })
  })

  it('deleting a booking and its owner cannot reset the shared workflow charge', async () => {
    const f = await executionFixture(owned.pool)
    const captured = await f.capture()
    expect(
      await admitWorkflowEmail(deps(), {
        organizationId: captured.organization,
        runId: captured.run,
        claimId: captured.claim,
        email: 'deleted@example.test',
      }),
    ).toMatchObject({ status: 'admitted' })
    await db.deleteFrom('bookings').where('id', '=', captured.booking).execute()
    expect(await reservations()).toHaveLength(1)
    await sql`DELETE FROM auth.organization WHERE id=${captured.organization}`.execute(db)
    expect(await reservations()).toHaveLength(0)
    expect(await rows()).toHaveLength(1)
    expect(await admitWorkflowEmail(deps({ workflowMailMaxPerHour: 1 }), request())).toMatchObject({
      status: 'budget_suppressed',
    })
    expect(
      await notificationEmailBudget(
        db,
        { mailMaxPerHour: 1 },
        notificationRecipientHash('core@example.test', SECRET),
        true,
        NOW,
      ),
    ).toBe('instance_hourly_limit')
  })
  it('workflow wins when it queues for the final shared slot before a core worker', async () => {
    await history(99)
    const held = Promise.withResolvers<Db>(),
      release = Promise.withResolvers<void>()
    const blocker = db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      held.resolve(trx)
      await release.promise
    })
    const holder = await held.promise
    const workflow = admitWorkflowEmail(deps(), request())
    let booking: Promise<boolean> | undefined
    try {
      await waiting()
      booking = db.transaction().execute((trx) => core(trx))
      let count = 0
      for (let i = 0; i < 200; i++) {
        const result = await sql<{
          count: string
        }>`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`.execute(
          holder,
        )
        count = Number(result.rows[0]?.count)
        if (count === 2) break
        await setTimeout(5)
      }
      expect(count).toBe(2)
    } finally {
      release.resolve()
    }
    await blocker
    expect(await workflow).toMatchObject({ status: 'admitted' })
    expect(await booking).toBe(false)
    expect(await rows()).toHaveLength(100)
  })

  it('meeting poll, workflow and core mail share the same final slot and reserve ceiling', async () => {
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `poll-${randomUUID().slice(0, 8)}`, time_zone: 'UTC' })
      .execute()
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const principal = {
      kind: 'session' as const,
      sessionId: randomUUID(),
      user: owner.principal.user,
      organization: owner.principal.organization,
    }
    const eventTypeId = await fixtures.eventType(principal.organization.id, owner.id)
    const now = Temporal.Now.instant().round({ smallestUnit: 'millisecond', roundingMode: 'floor' })
    const deadline = now.round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({ hours: 24 })
    const ctx = { ...testContext(db, principal), meetingPollSecret: SECRET }
    const poll = await createMeetingPoll(ctx, {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 25 }).toString(),
        deadline.add({ hours: 26 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    })
    await enrollMeetingPollVoter(
      { db, meetingPollSecret: SECRET, trustedIp: '192.0.2.19' },
      {
        publicToken: poll.publicToken as string,
        name: 'Synthetic voter',
        email: 'poll-budget@example.test',
        timeZone: 'UTC',
      },
    )
    await enrollMeetingPollVoter(
      { db, meetingPollSecret: SECRET, trustedIp: '192.0.2.19' },
      {
        publicToken: poll.publicToken as string,
        name: 'Another synthetic voter',
        email: 'poll-contender@example.test',
        timeZone: 'UTC',
      },
    )
    const deliveries = await db
      .selectFrom('meeting_poll_deliveries')
      .select('id')
      .where('poll_id', '=', poll.poll.id)
      .orderBy('id')
      .execute()
    const firstDelivery = deliveries[0],
      delivery = deliveries[1]
    if (!firstDelivery || !delivery) throw new Error('poll deliveries missing')
    const at = new Date(now.add({ seconds: 1 }).epochMilliseconds)
    let sent = 0
    const pollDeps = {
      db,
      secret: SECRET,
      meetingPollSecret: SECRET,
      publicUrl: 'https://poll.example.test',
      smtpConfigured: true,
      now: clock(at),
      mailer: {
        send: async () => {
          sent++
        },
      },
    }
    await deliverMeetingPollEmail(pollDeps, firstDelivery)
    expect(sent).toBe(1)
    await history(97, at)
    expect(await admitWorkflowEmail(deps({}, at), request())).toMatchObject({ status: 'admitted' })
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const blocker = db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      held.resolve()
      await release.promise
      return core(trx, true, at)
    })
    await held.promise
    const pending = deliverMeetingPollEmail(pollDeps, delivery)
    try {
      await waiting()
    } finally {
      release.resolve()
    }
    expect(await blocker).toBe(true)
    await pending
    expect(sent).toBe(1)
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select(['state', 'error_class'])
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'suppressed', error_class: 'instance_hourly_limit' })
    expect(await rows()).toHaveLength(100)
    for (let i = 0; i < 20; i++)
      expect(await db.transaction().execute((trx) => core(trx, false, at))).toBe(true)
    expect(await db.transaction().execute((trx) => core(trx, false, at))).toBe(false)
    expect(await rows()).toHaveLength(120)
  })

  async function copy(from: string, to: string) {
    const location = new URL('./workflow-mail.ts', import.meta.url)
    const original = readFileSync(location, 'utf8')
    expect(original.includes(from), 'mutation matches production source').toBe(true)
    const source = stripTypeScriptTypes(original.replace(from, to)).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
    )
    return import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    ) as Promise<typeof import('./workflow-mail.ts')>
  }
  it('detects a removed workflow share ceiling in a source copy', async () => {
    const anchor = 'Math.min(configured, Math.floor(global / 5))'
    const verify = async (admit: typeof admitWorkflowEmail) => {
      await db.deleteFrom('notification_email_sends').execute()
      await db.deleteFrom('workflow_mail_reservations').execute()
      const limits = {
        mailMaxPerHour: 5,
        workflowMailMaxPerHour: 20,
        workflowOwnerMailMaxPerHour: 20,
      }
      expect(await admit(deps(limits), request())).toMatchObject({ status: 'admitted' })
      expect(await admit(deps(limits), request())).toMatchObject({ status: 'budget_suppressed' })
    }
    await verify((await copy(anchor, anchor)).admitWorkflowEmail)
    await expect(
      verify((await copy(anchor, 'configured')).admitWorkflowEmail),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify((await copy(anchor, anchor)).admitWorkflowEmail)
  })
  it('detects removed reservation owner binding in a source copy', async () => {
    const req = request()
    const admitted = await admitWorkflowEmail(deps(), req)
    if (admitted.status !== 'admitted') throw new Error('admission missing')
    const foreign = {
      ...req,
      organizationId: await organization(),
      reservationId: admitted.reservationId,
    }
    const verify = async (retry: typeof readmitWorkflowEmail) =>
      expect(await retry(deps(), foreign)).toMatchObject({ status: 'unavailable' })
    const anchor = 'existing.organization_id !== request.organizationId ||'
    await verify((await copy(anchor, anchor)).readmitWorkflowEmail)
    await expect(verify((await copy(anchor, '')).readmitWorkflowEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verify((await copy(anchor, anchor)).readmitWorkflowEmail)
  })
  it('detects removed shared admission locking in a source copy', async () => {
    const verify = async (admit: typeof admitWorkflowEmail) => {
      await db.deleteFrom('notification_email_sends').execute()
      await db.deleteFrom('workflow_mail_reservations').execute()
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const blocker = db.transaction().execute(async (trx) => {
        await lockNotificationEmailBudget(trx)
        held.resolve()
        await release.promise
      })
      await held.promise
      const pending = admit(deps(), request())
      try {
        expect(await Promise.race([pending.then(() => true), setTimeout(150, false)])).toBe(false)
      } finally {
        release.resolve()
        await blocker
        await pending
      }
    }
    const anchor = 'await lockNotificationEmailBudget(db)'
    await verify((await copy(anchor, anchor)).admitWorkflowEmail)
    await expect(verify((await copy(anchor, '')).admitWorkflowEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verify((await copy(anchor, anchor)).admitWorkflowEmail)
  })
})
