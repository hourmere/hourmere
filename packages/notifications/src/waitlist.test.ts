import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, defineJob } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import * as mail from '@hourmere/mail'
import * as scheduling from '@hourmere/scheduling'
import { createFixtures, type Fixtures, weekdays } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as limits from './mail-limits.ts'
import {
  createWaitlistEmailWorker,
  deliverWaitlistEmail,
  type WaitlistEmailDeps,
  waitlistEmailJob,
} from './waitlist.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2027-01-04T00:00:00Z')
const START = '2027-01-05T08:00:00Z'
const END = '2027-01-05T11:00:00Z'
const SECRET = 'waitlist-notification-test-secret-with-32-characters'
type Sender = typeof deliverWaitlistEmail

/** Run isolated compiled source copies; mutations never rewrite production files. */
function sourceCopy(
  before: string,
  after: string,
  extra: [string, string][] = [],
): Sender & { worker: typeof createWaitlistEmailWorker } {
  let source = readFileSync(new URL('./waitlist.ts', import.meta.url), 'utf8')
  for (const [target, replacement] of [[before, after], ...extra]) {
    expect(source.includes(target as string), 'mutation must match its protection').toBe(true)
    source = source.replaceAll(target as string, replacement as string)
  }
  // Use the same real service dependencies for the lazy import in evaluated copies.
  source = source.replace(/await import\(\s*'@hourmere\/scheduling'\s*\)/g, 'schedulingModule')
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    randomBytes,
    randomUUID,
    defineJob,
    sql,
    z,
    schedulingModule: scheduling,
    ...mail,
    ...scheduling,
    ...limits,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return Object.assign(deliverWaitlistEmail, {worker:createWaitlistEmailWorker})`,
  )(...Object.values(bindings))
}

describe.skipIf(!serverUrl)('waitlist durable mail delivery', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_mail' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    await db
      .transaction()
      .execute((trx) => scheduling.ensureWaitlistKey(trx, SECRET, new Date(NOW.epochMilliseconds)))
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(locale = 'en', at = NOW) {
    const host = await f.host({ timeZone: 'Europe/Berlin' })
    const scheduleId = await f.schedule(host.userId, { timeZone: 'Europe/Berlin', weeklyHours: {} })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      minimumNoticeMinutes: 0,
    })
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', eventTypeId)
      .execute()
    const messages: MailMessage[] = []
    const logs: string[] = []
    let current = at
    const deps: WaitlistEmailDeps = {
      db,
      secret: SECRET,
      publicUrl: 'https://booking.example.test',
      trustedIp: `192.0.2.${Math.floor(Math.random() * 254) + 1}`,
      now: () => current,
      smtpConfigured: true,
      // Most tests isolate lifecycle from budgets; budget tests set their own low caps.
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 1000,
      mailRecipientMaxPerDay: 1000,
      mailer: {
        send: async (message) => {
          messages.push(message)
        },
      },
      log: (line) => logs.push(line),
    }
    const join = async (email = `${randomUUID()}@example.test`) => {
      await scheduling.joinWaitlist(deps, {
        handle: host.handle,
        slug: 'intro',
        email,
        consent: true,
        locale,
        preferredWindow: { start: START, end: END, timeZone: 'Europe/Berlin' },
      })
      const row = await db
        .selectFrom('waitlist_entries')
        .selectAll()
        .where('event_type_id', '=', eventTypeId)
        .where('email', '=', email)
        .executeTakeFirstOrThrow()
      const outbox = await db
        .selectFrom('waitlist_verification_outbox')
        .selectAll()
        .where('entry_id', '=', row.id)
        .executeTakeFirstOrThrow()
      const opened = scheduling.openWaitlistVerificationOutbox(deps, outbox)
      expect(opened).toBeDefined()
      return { ...row, outboxId: outbox.id, verificationToken: opened?.verificationToken as string }
    }
    const activate = async (email?: string) => {
      const entry = await join(email)
      await scheduling.verifyWaitlist(deps, { token: entry.verificationToken })
      return entry
    }
    const open = async (end = '12:00') => {
      await db
        .updateTable('schedules')
        .set({ weekly_hours: JSON.stringify(weekdays({ start: '09:00', end })) })
        .where('id', '=', scheduleId)
        .execute()
      await scheduling.scanWaitlistEvent(deps, eventTypeId)
      return db
        .selectFrom('waitlist_candidates')
        .selectAll()
        .where('event_type_id', '=', eventTypeId)
        .orderBy('entry_id')
        .execute()
    }
    return {
      ...host,
      eventTypeId,
      scheduleId,
      deps,
      messages,
      logs,
      join,
      activate,
      open,
      advance: (milliseconds: number) => {
        current = current.add({ milliseconds })
      },
    }
  }

  it.each(['en', 'zh-CN', 'de', 'fr', 'es', 'pt-BR'])(
    'delivers verification and freed-slot mail in %s with private path capabilities',
    async (locale) => {
      const s = await setup(locale)
      const entry = await s.join()
      await deliverWaitlistEmail(s.deps, { kind: 'verification', id: entry.outboxId })
      expect(s.messages).toHaveLength(1)
      const verification = s.messages[0] as MailMessage
      expect(verification.sensitive).toBe(true)
      expect(verification.text).toContain(
        `/waitlist/verify#token=${entry.verificationToken}&management=`,
      )
      expect(verification.html).toContain(entry.verificationToken)
      const verifyRow = await db
        .selectFrom('waitlist_verification_outbox')
        .selectAll()
        .where('id', '=', entry.outboxId)
        .executeTakeFirstOrThrow()
      expect(verifyRow).toMatchObject({ state: 'accepted', attempts: 1, encrypted_payload: null })
      await scheduling.verifyWaitlist(s.deps, { token: entry.verificationToken })
      const candidates = await s.open()
      expect(candidates).toHaveLength(1)
      await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidates[0]?.id as string })
      expect(s.messages).toHaveLength(2)
      const notice = s.messages[1] as MailMessage
      expect(notice).toEqual(
        mail.waitlistNotificationEmail({
          to: notice.to,
          publicUrl: s.deps.publicUrl,
          removalToken: notice.text.match(/\/waitlist\/remove#(\S+)/)?.[1] as string,
          token: notice.text.match(/\/waitlist\/remove#(\S+)/)?.[1] as string,
          eventTitle: (await scheduling.resolveWaitlistEventById(db, s.eventTypeId))
            ?.title as string,
          expiresAt: candidates[0]?.expires_at as Date,
          bookingPath: `/${s.handle}/intro`,
          timeZone: 'Europe/Berlin',
          slots: candidates[0]?.slots as { start: string; end: string }[],
          language: locale,
        }),
      )
      const links = notice.text.match(/https:\/\/\S+/g) ?? []
      const bookingLinks = links.filter((url) => url.includes('/intro/waitlist/'))
      expect(bookingLinks).toHaveLength(3)
      for (const link of links) expect(new URL(link).search).toBe('')
      for (const link of bookingLinks) {
        expect(new URL(link).pathname).toContain(`/waitlist/${entry.id}.`)
        expect(notice.html).toContain(link)
      }
      expect(
        await db
          .selectFrom('waitlist_entries')
          .select('status')
          .where('id', '=', entry.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'notified' })
      expect(s.logs.join('\n')).not.toContain(entry.verificationToken)
      expect(s.logs.join('\n')).not.toContain(entry.email)
      expect(s.logs.join('\n')).not.toMatch(/[a-f\d-]{36}\.[A-Za-z0-9_-]{43}/)
    },
  )

  async function budgetScenario(send: Sender) {
    const s = await setup()
    const a = await s.activate()
    const b = await s.activate()
    const before = await db
      .selectFrom('notification_email_sends')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow()
    // Other fixture sends are outside this fixture's hour; count them so exactly one
    // instance send remains, preserving the shared ledger used by the normal pipeline.
    s.deps.mailMaxPerHour = Number(before.count) + 1
    const candidates = await s.open()
    await Promise.all(candidates.map((row) => send(s.deps, { kind: 'notification', id: row.id })))
    expect(s.messages).toHaveLength(1)
    const results = await db
      .selectFrom('waitlist_candidates')
      .select('state')
      .where('event_type_id', '=', s.eventTypeId)
      .execute()
    expect(results.map((row) => row.state).sort()).toEqual(['accepted', 'suppressed'])
    const caps = await db
      .selectFrom('waitlist_capabilities')
      .selectAll()
      .where('purpose', '=', 'management')
      .where('entry_id', 'in', [a.id, b.id])
      .execute()
    expect(caps).toHaveLength(1)
    s.advance(3_600_001)
    await createWaitlistEmailWorker(s.deps)()
    expect(s.messages).toHaveLength(1)
  }
  it('partially delivers a broadcast at the exact shared instance cap, without reserve or backfill', async () =>
    budgetScenario(deliverWaitlistEmail))
  it('detects source-copy removal of budget suppression', async () => {
    await expect(
      budgetScenario(
        sourceCopy(
          "if (suppressed) return finish(db, claim, row, 'suppressed', at, suppressed)",
          'if (false && suppressed) return',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects source-copy removal of committed shared-budget charging', async () => {
    await expect(
      budgetScenario(
        sourceCopy(
          "await db\n          .insertInto('notification_email_sends')\n          .values({ recipient_hash: hash, sent_at: sentAt })\n          .execute()",
          '',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects source-copy removal of the cross-worker budget fence', async () => {
    await expect(
      budgetScenario(sourceCopy('await lockNotificationEmailBudget(db)', '')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('shares booking-recipient budgets for verification and notification across events', async () => {
    const s = await setup()
    const entry = await s.join()
    const hash = limits.notificationRecipientHash(entry.email as string, SECRET)
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: hash, sent_at: new Date(NOW.epochMilliseconds) })
      .execute()
    s.deps.mailRecipientMaxPerHour = 1
    await deliverWaitlistEmail(s.deps, { kind: 'verification', id: entry.outboxId })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_verification_outbox')
        .select(['state', 'error_code'])
        .where('id', '=', entry.outboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'suppressed', error_code: 'recipient_hourly_limit' })
    expect(
      await db
        .selectFrom('waitlist_capabilities')
        .select('id')
        .where('entry_id', '=', entry.id)
        .where('purpose', '=', 'management')
        .execute(),
    ).toHaveLength(0)
    await scheduling.verifyWaitlist(s.deps, { token: entry.verificationToken })
    const [candidate] = await s.open()
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select('state')
        .where('id', '=', candidate?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'suppressed' })
  })

  async function generationScenario(send: Sender) {
    const s = await setup()
    const entry = await s.join()
    await db
      .updateTable('waitlist_entries')
      .set({ verification_generation: 2 })
      .where('id', '=', entry.id)
      .execute()
    await send(s.deps, { kind: 'verification', id: entry.outboxId })
    expect(s.messages).toHaveLength(0)
  }
  it('refuses an older verification generation even if its ciphertext and capability remain valid', async () =>
    generationScenario(deliverWaitlistEmail))
  it('detects source-copy removal of verification generation binding', async () => {
    await expect(
      generationScenario(sourceCopy('entry.verification_generation !== row.generation', 'false')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifiedScenario(send: Sender) {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    await db
      .updateTable('waitlist_entries')
      .set({ status: 'pending_verification', verified_at: null })
      .where('id', '=', entry.id)
      .execute()
    await send(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
  }
  it('rechecks email verification instead of trusting stale discovery candidates', async () =>
    verifiedScenario(deliverWaitlistEmail))
  it('detects source-copy removal of the verified-entry requirement', async () => {
    await expect(
      verifiedScenario(
        sourceCopy(
          "!entry.verified_at ||\n    !['active', 'notified'].includes(entry.status) ||",
          '',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('deduplicates accepted candidates across concurrent deliveries, scans and a fresh worker', async () => {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    const request = { kind: 'notification' as const, id: candidate?.id as string }
    await Promise.all([
      deliverWaitlistEmail(s.deps, request),
      deliverWaitlistEmail(s.deps, request),
    ])
    expect(s.messages).toHaveLength(1)
    await deliverWaitlistEmail(s.deps, request)
    await scheduling.scanWaitlistEvent(s.deps, s.eventTypeId)
    const candidates = await db
      .selectFrom('waitlist_candidates')
      .selectAll()
      .where('event_type_id', '=', s.eventTypeId)
      .execute()
    expect(
      candidates.filter((row) =>
        (row.slots as { start: string }[]).some(
          (slot) => slot.start === ((candidate?.slots ?? []) as { start: string }[])[0]?.start,
        ),
      ),
    ).toHaveLength(1)
    await createWaitlistEmailWorker(s.deps)()
    expect(s.messages.length).toBeLessThanOrEqual(2) // Only later, unconsumed suggestions can send.
  })

  it('lets two notified invitees race through ordinary booking, with one winner and the loser still waiting', async () => {
    const s = await setup()
    const a = await s.activate()
    const b = await s.activate()
    const candidates = await s.open('09:30')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.cohort_id).toBe(candidates[1]?.cohort_id)
    await Promise.all(
      candidates.map((candidate) =>
        deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate.id }),
      ),
    )
    expect(s.messages).toHaveLength(2)
    const results = await Promise.allSettled(
      s.messages.map((message) => {
        const link = message.text.match(/https:\/\/\S+\/intro\/waitlist\/\S+/)?.[0] as string
        const path = new URL(link).pathname.split('/').filter(Boolean)
        const token = path[3] as string
        return scheduling.createPublicBooking(
          { ...s.deps, waitlistSecret: SECRET, now: s.deps.now as () => Temporal.Instant },
          {
            handle: s.handle,
            slug: 'intro',
            start: Temporal.Instant.from(decodeURIComponent(path[4] as string)),
            invitee: { name: 'Waiting invitee', email: message.to, timeZone: 'Europe/Berlin' },
            waitlistToken: token,
          },
        )
      }),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(['slot_taken', 'slot_unavailable']).toContain(loser.reason.code)
    const states = await db
      .selectFrom('waitlist_entries')
      .select('status')
      .where('id', 'in', [a.id, b.id])
      .execute()
    expect(states.map((entry) => entry.status).sort()).toEqual(['booked', 'notified'])
    await scheduling.scanWaitlistEvent(s.deps, s.eventTypeId)
    for (const candidate of candidates)
      await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate.id })
    expect(s.messages).toHaveLength(2)
  })

  async function staleScenario(send: Sender) {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{}' })
      .where('id', '=', s.scheduleId)
      .execute()
    await send(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select('state')
        .where('id', '=', candidate?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'obsolete' })
  }
  it('rechecks all exact suggestions before SMTP and never backfills a vanished slot', async () =>
    staleScenario(deliverWaitlistEmail))
  it('detects source-copy removal of exact availability revalidation', async () => {
    await expect(
      staleScenario(sourceCopy('!slots.every((slot) =>', 'false && !slots.every((slot) =>')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('rereads slot availability after waiting for another sender to release the shared budget lock', async () => {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    let release: () => void = () => {}
    let locked: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const hold = db.transaction().execute(async (trx) => {
      await limits.lockNotificationEmailBudget(trx)
      locked()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await ready
    const sending = deliverWaitlistEmail(s.deps, {
      kind: 'notification',
      id: candidate?.id as string,
    })
    try {
      await vi.waitFor(async () => {
        expect(
          await db
            .selectFrom('waitlist_candidates')
            .select('state')
            .where('id', '=', candidate?.id as string)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'pending' })
      })
      await db
        .updateTable('schedules')
        .set({ weekly_hours: '{}' })
        .where('id', '=', s.scheduleId)
        .execute()
    } finally {
      release()
      await hold
    }
    await sending
    expect(s.messages).toHaveLength(0)
  })

  it('self-removal during SMTP erases immediately, revokes old links and cannot be resurrected by completion', async () => {
    const s = await setup()
    const entry = await s.activate()
    const token = await db
      .transaction()
      .execute((trx) =>
        scheduling.mintWaitlistManagementToken(trx, entry.id, new Date(NOW.epochMilliseconds)),
      )
    const [candidate] = await s.open()
    let release: () => void = () => {}
    let inSmtp: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      inSmtp = resolve
    })
    s.deps.mailer = {
      send: async () => {
        inSmtp()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    }
    const sending = deliverWaitlistEmail(s.deps, {
      kind: 'notification',
      id: candidate?.id as string,
    })
    await ready
    try {
      await scheduling.removeWaitlist(s.deps, { token })
      expect(
        await db
          .selectFrom('waitlist_entries')
          .select(['status', 'email', 'window_start'])
          .where('id', '=', entry.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'removed', email: null, window_start: null })
    } finally {
      release()
    }
    await sending
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select('state')
        .where('id', '=', candidate?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'obsolete' })
    await expect(scheduling.getWaitlistEntry(s.deps, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
  }, 10_000)

  async function leaseCommitScenario(send: Sender) {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    const request = { kind: 'notification' as const, id: candidate?.id as string }
    let releaseEntry: () => void = () => {}
    let locked: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const hold = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('waitlist_entries')
        .select('id')
        .where('id', '=', entry.id)
        .forUpdate()
        .execute()
      locked()
      await new Promise<void>((resolve) => {
        releaseEntry = resolve
      })
    })
    await ready
    const sendingA = send(s.deps, request)
    let sendingB: Promise<void> | undefined
    const waits = async (locktype: string) =>
      (
        await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a USING(pid)
      WHERE a.datname=current_database() AND NOT l.granted AND l.locktype=${locktype}`.execute(db)
      ).rows[0]?.count ?? 0
    try {
      await vi.waitFor(async () => {
        expect(s.messages).toHaveLength(1)
        expect(await waits('transactionid')).toBeGreaterThan(0)
      })
      // SMTP has accepted, but its receipt is blocked on the unrelated entry row.
      // Expiring the lease must not let a successor replace that in-flight receipt.
      s.advance(120_001)
      sendingB = send(s.deps, request)
      await vi.waitFor(async () => expect(await waits('advisory')).toBeGreaterThan(0))
      expect(
        await db
          .selectFrom('waitlist_candidates')
          .select(['state', 'attempts'])
          .where('id', '=', request.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'processing', attempts: 1 })
    } finally {
      releaseEntry()
      await hold
      await Promise.all([sendingA, sendingB])
    }
    expect(s.messages).toHaveLength(1)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select(['state', 'attempts'])
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'accepted', attempts: 1 })
    const ledger = await db
      .selectFrom('notification_email_sends')
      .select('sent_at')
      .where('recipient_hash', '=', limits.notificationRecipientHash(entry.email as string, SECRET))
      .execute()
    expect(ledger).toHaveLength(1)
    expect(
      await db
        .selectFrom('waitlist_capabilities')
        .select('id')
        .where('entry_id', '=', entry.id)
        .where('purpose', '=', 'management')
        .execute(),
    ).toHaveLength(1)
  }
  it('keeps a receipt committing after lease expiry from being replaced by a successor', async () =>
    leaseCommitScenario(deliverWaitlistEmail))
  it('detects source-copy takeover of an accepted receipt blocked after lease expiry', async () => {
    await expect(
      leaseCommitScenario(
        sourceCopy(
          'await lockNotificationEmailBudget(db)\n    const row = await workRow(db, request, true)',
          'const row = await workRow(db, request, true)',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function expiryScenario(send: Sender) {
    const s = await setup()
    const entry = await s.join()
    s.advance(30 * 60_000)
    await send(s.deps, { kind: 'verification', id: entry.outboxId })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_verification_outbox')
        .select('state')
        .where('id', '=', entry.outboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'expired' })
  }
  it('expires verification links instead of sending them after their original deadline', async () =>
    expiryScenario(deliverWaitlistEmail))
  it('does not send after notification expiry, and cleanup expires the entry without deadline extension', async () => {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    s.advance(24 * 3_600_000)
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select('state')
        .where('id', '=', candidate?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'expired' })
    s.advance(2 * 86_400_000)
    await scheduling.cleanupWaitlist(s.deps)
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select(['status', 'email', 'expires_at'])
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'expired', email: null, expires_at: new Date(END) })
  })

  async function retriesScenario(send: Sender) {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    let attempts = 0
    s.deps.mailer = {
      send: async () => {
        attempts++
        throw new Error(`private ${entry.email} ${entry.verificationToken}`)
      },
    }
    const request = { kind: 'notification' as const, id: candidate?.id as string }
    await send(s.deps, request)
    await send(s.deps, request)
    expect(attempts).toBe(1)
    s.advance(60_000)
    await send(s.deps, request)
    expect(attempts).toBe(2)
    s.advance(119_999)
    await send(s.deps, request)
    expect(attempts).toBe(2)
    s.advance(1)
    await send(s.deps, request)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select('state')
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'failed' })
    s.advance(3_600_000)
    await send(s.deps, request)
    expect(attempts).toBe(3)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select(['state', 'attempts', 'error_code'])
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'failed', attempts: 3, error_code: 'attempts_exhausted' })
    expect(s.logs.join('\n')).not.toContain(entry.verificationToken)
    expect(s.logs.join('\n')).not.toContain(entry.email)
  }
  it('persists exactly three attempts and 60/120-second retries, with fixed safe errors', async () =>
    retriesScenario(deliverWaitlistEmail))
  it('detects source-copy removal of the retry deadline', async () => {
    await expect(
      retriesScenario(sourceCopy(' || row.next_attempt_at > at', '')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects source-copy removal of the finite attempt outcome', async () => {
    await expect(
      retriesScenario(sourceCopy('claim.attempt >= MAX_ATTEMPTS', 'false')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function liveClaimScenario(send: Sender) {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    await db
      .updateTable('waitlist_candidates')
      .set({
        state: 'processing',
        attempts: 1,
        claim_token: randomUUID(),
        lease_until: new Date(NOW.epochMilliseconds + 120_000),
      })
      .where('id', '=', candidate?.id as string)
      .execute()
    await send(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
  }
  it('does not steal a still-live attempt from another worker', async () =>
    liveClaimScenario(deliverWaitlistEmail))
  it('detects source-copy removal of the live lease fence', async () => {
    await expect(
      liveClaimScenario(
        sourceCopy(
          "if (row.state === 'processing' && row.lease_until && row.lease_until > at) return",
          '',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function notificationDeadlineScenario(send: Sender) {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    s.advance(24 * 3_600_000)
    await send(s.deps, { kind: 'notification', id: candidate?.id as string })
    expect(s.messages).toHaveLength(0)
  }
  it('detects source-copy removal of notification deadline checks', async () => {
    await expect(
      notificationDeadlineScenario(
        sourceCopy('row.expires_at <= at', 'false', [
          ['row.expires_at.getTime(),', 'Number.POSITIVE_INFINITY,'],
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('recovers spent crash claims once after lease expiry, never resetting attempts on worker restart', async () => {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    const id = candidate?.id as string
    const interrupted = sourceCopy(
      'await deps.db.transaction().execute(async (db) => {\n      const { ensureWaitlistKey }',
      "throw new Error('simulated_crash_after_claim'); await deps.db.transaction().execute(async (db) => {\n      const { ensureWaitlistKey }",
    )
    await expect(interrupted(s.deps, { kind: 'notification', id })).rejects.toThrow(
      'waitlist_email_delivery_unavailable',
    )
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id })
    expect(s.messages).toHaveLength(0)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select(['state', 'attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'processing', attempts: 1 })
    s.advance(120_001)
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id })
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id })
    expect(s.messages).toHaveLength(1)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select(['state', 'attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'accepted', attempts: 2 })
  })

  it('records the bounded SMTP acceptance/failed-commit duplicate window', async () => {
    const s = await setup()
    await s.activate()
    const [candidate] = await s.open()
    const id = candidate?.id as string
    const interrupted = sourceCopy(
      "await db\n          .insertInto('notification_email_sends')",
      "throw new Error('simulated_receipt_failure'); await db\n          .insertInto('notification_email_sends')",
    )
    await expect(interrupted(s.deps, { kind: 'notification', id })).rejects.toThrow(
      'waitlist_email_delivery_unavailable',
    )
    expect(s.messages).toHaveLength(1)
    s.advance(120_001)
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id })
    expect(s.messages).toHaveLength(2)
    expect(
      await db
        .selectFrom('waitlist_candidates')
        .select(['state', 'attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'accepted', attempts: 2 })
  })

  async function noSmtpScenario(send: Sender) {
    const s = await setup()
    const entry = await s.join()
    const printed: string[] = []
    s.deps.mailer = mail.createLogMailer((line) => printed.push(line))
    s.deps.smtpConfigured = false
    await send(s.deps, { kind: 'verification', id: entry.outboxId })
    expect(printed).toEqual([])
    expect(
      await db
        .selectFrom('waitlist_verification_outbox')
        .select(['state', 'error_code'])
        .where('id', '=', entry.outboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'failed', error_code: 'smtp_not_configured' })
  }
  it('never treats a resolving development log mailer as SMTP acceptance', async () =>
    noSmtpScenario(deliverWaitlistEmail))
  it('detects source-copy removal of SMTP configuration eligibility', async () => {
    await expect(
      noSmtpScenario(
        sourceCopy(
          "if (!deps.smtpConfigured) return finish(db, claim, row, 'failed', at, 'smtp_not_configured')",
          '',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function projectionScenario(factory: typeof createWaitlistEmailWorker) {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate?.id as string })
    const worker = factory(s.deps)
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '09:30', end: '10:00' })) })
      .where('id', '=', s.scheduleId)
      .execute()
    for (let run = 0; run < 5; run++) await worker()
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('status')
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'notified' })
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{}' })
      .where('id', '=', s.scheduleId)
      .execute()
    for (let run = 0; run < 5; run++) await worker()
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('status')
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'active' })
  }
  it('returns notified entries to waiting when every advertised suggestion disappears before its deadline', async () =>
    projectionScenario(createWaitlistEmailWorker))
  it('detects source-copy removal of current suggestion projection', async () => {
    await expect(
      projectionScenario(sourceCopy('if (offered) continue', 'if (true) continue').worker),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function unknownProjectionScenario(factory: typeof createWaitlistEmailWorker) {
    const s = await setup()
    const entry = await s.activate()
    const [candidate] = await s.open()
    await deliverWaitlistEmail(s.deps, { kind: 'notification', id: candidate?.id as string })
    const { calendarId } = await f.calendarBusy(s.userId, [])
    const calendar = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', calendarId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('id', '=', calendar.connection_id)
      .execute()
    const worker = factory(s.deps)
    for (let run = 0; run < 5; run++) await worker()
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('status')
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'notified' })
  }
  it('keeps unknown calendar readiness neutral while projecting delivered suggestions', async () =>
    unknownProjectionScenario(createWaitlistEmailWorker))
  it('detects source-copy treating calendar failure as missing suggestions', async () => {
    await expect(
      unknownProjectionScenario(
        sourceCopy(
          '// Keep the delivered marker and move on; a later pass will check again.',
          "await deps.db.updateTable('waitlist_entries').set({ status:'active' }).where('id','=',entry.id).execute()",
        ).worker,
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('runs the delivery worker from the real jobs pipeline and stores no capability in queue payloads', async () => {
    const s = await setup()
    const entry = await s.join()
    const job = waitlistEmailJob(createWaitlistEmailWorker(s.deps))
    const queue = createJobs({
      connectionString: owned.url,
      definitions: [job],
      work: true,
      migrate: true,
      maxConnections: 2,
      pollingIntervalSeconds: 0.5,
      log: () => {},
    })
    try {
      await queue.start()
      await queue.enqueue('waitlist-email-v1', {})
      await vi.waitFor(() => expect(s.messages).toHaveLength(1), { timeout: 10_000 })
      const jobs = await owned.pool.query<{ data: unknown }>(
        "SELECT data FROM pgboss.job WHERE name='waitlist-email-v1'",
      )
      expect(jobs.rows.every((row) => JSON.stringify(row.data) === '{}')).toBe(true)
      expect(JSON.stringify(jobs.rows)).not.toContain(entry.verificationToken)
      expect(job.payload.safeParse({ token: entry.verificationToken }).success).toBe(false)
    } finally {
      await queue.stop()
    }
  }, 20_000)
})
