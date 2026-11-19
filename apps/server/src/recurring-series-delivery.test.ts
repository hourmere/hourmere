import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  createLogMailer,
  escapeHtml,
  formatMeetingTime,
  type Mailer,
  type MailMessage,
  MailRejectedError,
} from '@hourmere/mail'
import { mailMessage } from '@hourmere/mail/catalogue'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
  type NotificationDeps,
  seriesNotificationDispatchJob,
} from '@hourmere/notifications'
import {
  type CancelBookingSeriesInput,
  type CreateBookingSeriesInput,
  cancelManagedBooking,
  cancelManagedBookingSeries,
  createPublicBooking,
  createPublicTeamBookingSeries,
  expandRecurringRule,
  getManagedBooking,
  rescheduleManagedBooking,
  resolveSeriesCapability,
} from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const serverUrl = process.env.DATABASE_URL
// pg-boss accounts for job retention using PostgreSQL wall time.
const fixtureNow = Temporal.Instant.from('2030-11-02T00:00Z')
const firstLocalStart = '2030-11-04T09:00+00:00'
const timeZone = 'UTC'
const durationMinutes = 30
const publicUrl = 'https://hourmere.example.test'
const eventName = 'Weekly studio hours'
const hostName = (index: number) => `Series host ${index + 1}`
const booker = { name: 'Primary booker', email: 'booker@example.test', timeZone, locale: 'en' }
const guestAt = (index: number) => ({
  name: `Series guest ${index + 1}`,
  email: `guest-${index + 1}@example.test`,
})
const all = (): CancelBookingSeriesInput => ({
  scope: 'all',
  expectedRevision: '1',
  idempotencyKey: randomUUID(),
})

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing series delivery fixture value')
  return value
}

const seriesLink = /\/series\/manage#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g

function deliveredToken(message: MailMessage) {
  const text = [...message.text.matchAll(seriesLink)]
  const html = [...(message.html ?? '').matchAll(seriesLink)]
  expect(text.length).toBe(1)
  expect(html.length).toBe(1)
  const token = required(text[0]?.[1])
  // Assertions compare booleans so failure output cannot include a capability.
  expect(html[0]?.[1] === token).toBe(true)
  expect(message.text.includes(`${publicUrl}/series/manage#${token}`)).toBe(true)
  expect((message.html ?? '').includes(`href="${publicUrl}/series/manage#${token}"`)).toBe(true)
  return token
}

describe.skipIf(!serverUrl)('aggregate series notification delivery on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs>
  let clock = fixtureNow
  const now = () => clock
  const sent: MailMessage[] = []
  const attempts: MailMessage[] = []
  const logs: string[] = []
  const logMailer = createLogMailer((line) => logs.push(line))
  let refuseAddress: string | undefined
  const mailer: Mailer = {
    async send(message) {
      attempts.push(message)
      if (message.to === refuseAddress) {
        throw new MailRejectedError({ responseCode: 450, enhancedCode: '4.2.0', atRecipient: true })
      }
      // Run the genuine development logger too, for its capability redaction contract.
      if (message.text.includes('/series/manage#')) await logMailer.send(message)
      sent.push(message)
    },
  }
  const deps = (limits: Partial<NotificationDeps> = {}): NotificationDeps => ({
    db,
    mailer,
    publicUrl,
    secret: 'synthetic-series-mail-test-secret',
    now,
    log: (line) => logs.push(line),
    ...limits,
  })
  const context = () => ({ db, now, notify: bookingNotifier(jobs) })
  const jobRun = () => ({ id: randomUUID(), attempt: 1, signal: new AbortController().signal })
  const dispatch = (limits?: Partial<NotificationDeps>) =>
    seriesNotificationDispatchJob(deps(limits)).handler({}, jobRun())

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_delivery' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [bookingNotificationJob(deps()), seriesNotificationDispatchJob(deps())],
      log: (_level, line) => logs.push(line),
      maxConnections: 2,
      work: false,
      migrate: true,
    })
    await jobs.start()
  })

  beforeEach(async () => {
    clock = fixtureNow
    sent.length = 0
    attempts.length = 0
    logs.length = 0
    refuseAddress = undefined
    await db.deleteFrom('notification_email_sends').execute()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function seriesFixture(count = 2, guestCount = 0, hostCount = 1) {
    const fixtures = createFixtures(db)
    const hosts = []
    for (let index = 0; index < hostCount; index++) {
      const host = await createTestUser(db, hostName(index))
      const locale = index === 1 ? 'zh-CN' : 'en'
      await db
        .insertInto('profiles')
        .values({ user_id: host.id, handle: host.id, locale, time_zone: timeZone })
        .execute()
      await fixtures.schedule(host.id, { timeZone })
      hosts.push({ ...host, locale })
    }
    const team = await createTestTeam(
      db,
      hosts.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    const handle = team.as(required(hosts[0])).organization.slug
    const slug = 'studio-hours'
    const eventId = await fixtures.eventType(team.id, null, {
      slug,
      title: eventName,
      allowGuests: true,
      hosts: hosts.map(({ id }) => ({ userId: id })),
    })
    await db
      .updateTable('event_types')
      .set({
        scheduling_type: hostCount > 1 ? 'collective' : 'individual',
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 12 }),
      })
      .where('id', '=', eventId)
      .execute()
    const rule = { pattern: 'weekly', count } as const
    const guests = Array.from({ length: guestCount }, (_, index) => guestAt(index))
    const input: CreateBookingSeriesInput = {
      handle,
      slug,
      firstLocalStart,
      rule,
      invitee: booker,
      guests,
      idempotencyKey: randomUUID(),
      expectedPreview: {
        eventRevision: '0',
        timeZone,
        rule,
        durationMinutes,
        occurrences: expandRecurringRule({
          firstLocalStart,
          timeZone,
          rule,
          durationMinutes,
          now: now(),
        }).map(({ ordinal, localStart, start, end, offset }) => ({
          ordinal,
          localStart,
          start: start?.toString() ?? null,
          end: end?.toString() ?? null,
          offset,
        })),
      },
    }
    const actorDigest = randomBytes(32)
    const create = () =>
      createPublicTeamBookingSeries(context(), input, {
        recurringBookingsEnabled: true,
        actorDigest,
        notifyMemberEmail: bookingNotifier(jobs),
      })
    const result = await create()
    return { ...result, token: required(result.manageToken), hosts, guests, create }
  }
  type SeriesFixture = Awaited<ReturnType<typeof seriesFixture>>

  async function ordinaryBooking() {
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ timeZone, name: hostName(0) })
    await fixtures.schedule(host.userId, { timeZone })
    const slug = 'ordinary-studio-hours'
    await fixtures.eventType(host.organizationId, host.userId, { slug, title: eventName })
    const result = await createPublicBooking(context(), {
      handle: host.handle,
      slug,
      start: Temporal.Instant.from(firstLocalStart),
      invitee: booker,
    })
    return { bookingId: result.booking.id, token: required(result.manageToken) }
  }

  const ledger = () => db.selectFrom('notification_email_sends').selectAll().execute()

  const seriesReceipts = (seriesId: string) =>
    db
      .selectFrom('booking_series_notifications')
      .selectAll()
      .where('series_id', '=', seriesId)
      .where('row_type', '=', 'receipt')
      .orderBy('sequence')
      .execute()

  const seriesOutbox = (seriesId: string) =>
    db
      .selectFrom('booking_series_notifications')
      .select(['id', 'kind', 'attempts', 'outbox_state', 'due_at', 'lease_id'])
      .where('series_id', '=', seriesId)
      .where('row_type', '=', 'outbox')
      .orderBy('sequence')
      .execute()

  const bookingJobs = async (bookingIds: string[]) =>
    (
      await owned.pool.query<{ id: string; data: unknown; start_after: Date }>(
        `SELECT id, data, start_after FROM pgboss.job
        WHERE name = $1 AND data->>'bookingId' = ANY($2::text[]) ORDER BY created_on, id`,
        [BOOKING_NOTIFICATION_JOB, bookingIds],
      )
    ).rows.map(({ id, data, start_after }) => ({
      id,
      payload: BookingNotificationPayload.parse(data),
      startAfter: start_after,
    }))

  async function runBookingMail(bookingIds: string[], kind: string) {
    const handler = bookingNotificationJob(deps()).handler
    for (const { id, payload } of await bookingJobs(bookingIds)) {
      if (payload.kind === kind) await handler(payload, { ...jobRun(), id })
    }
  }

  async function assertNoRawCapabilities(tokens: string[]) {
    const { rows } = await owned.pool.query('SELECT data, output FROM pgboss.job')
    const durableJobs = JSON.stringify(rows)
    for (const token of tokens) {
      expect(durableJobs.includes(token)).toBe(false)
      expect(logs.some((line) => line.includes(token))).toBe(false)
    }
  }

  function assertCompleteBodies(f: SeriesFixture, messages: MailMessage[], cancelFrom?: number) {
    expect(messages.length).toBe(19)
    expect(messages.map(({ to }) => to).sort()).toEqual(
      [
        booker.email,
        ...f.guests.map(({ email }) => email),
        ...f.hosts.map(({ email }) => email),
      ].sort(),
    )
    const tokens: string[] = []
    for (const message of messages) {
      const host = f.hosts.find(({ email }) => email === message.to)
      const locale = host?.locale === 'zh-CN' ? 'zh-CN' : 'en'
      const t = (key: Parameters<typeof mailMessage>[1]) =>
        mailMessage(locale, key, { event: eventName })
      expect(message.subject).toBe(
        t(cancelFrom ? 'series.cancelled.subject' : 'series.confirmed.subject'),
      )
      expect(message.sensitive).toBe(true)
      const token = host ? undefined : deliveredToken(message)
      if (token) tokens.push(token)
      for (const [html, content] of [
        [false, message.text],
        [true, required(message.html)],
      ] as const) {
        const output = (value: string) => (html ? escapeHtml(value) : value)
        if (host) {
          expect(content.includes(`${publicUrl}/app/booking-series/${f.seriesId}`)).toBe(true)
          expect(content.includes('/series/manage#')).toBe(false)
        } else {
          expect(
            content.includes(message.to === booker.email ? t('series.manage') : t('series.view')),
          ).toBe(true)
          for (const other of f.guests.filter(({ email }) => email !== message.to)) {
            expect(content.includes(other.email)).toBe(false)
          }
        }
        const affectedHeading = content.indexOf(t('series.affected'))
        const unchangedHeading = content.indexOf(t('series.unchanged'))
        for (const { ordinal, start, end } of f.occurrences) {
          const time = output(
            formatMeetingTime(
              Temporal.Instant.from(start),
              Temporal.Instant.from(end),
              timeZone,
              locale,
            ),
          )
          const at = content.indexOf(time)
          expect(at, `display date for ordinal ${ordinal}`).toBeGreaterThanOrEqual(0)
          expect(content.lastIndexOf(time)).toBe(at)
          if (cancelFrom !== undefined) {
            if (ordinal >= cancelFrom) {
              expect(affectedHeading).toBeGreaterThanOrEqual(0)
              expect(at).toBeGreaterThan(affectedHeading)
              if (unchangedHeading !== -1) expect(at).toBeLessThan(unchangedHeading)
            } else {
              expect(unchangedHeading).toBeGreaterThan(affectedHeading)
              expect(at).toBeGreaterThan(unchangedHeading)
            }
          }
        }
      }
    }
    expect(new Set(tokens).size).toBe(11)
    return tokens
  }

  it.each([
    ['following', 8],
    ['all', 1],
  ] as const)(
    'delivers 19 complete confirmations and 19 complete %s cancellation copies at default budgets',
    async (scope, fromOrdinal) => {
      const f = await seriesFixture(12, 10, 8)
      const bookingIds = f.occurrences.map(({ bookingId }) => bookingId)
      expect(await seriesReceipts(f.seriesId)).toHaveLength(0)
      expect(await seriesOutbox(f.seriesId)).toMatchObject([
        { kind: 'confirmation', attempts: 0, outbox_state: 'pending' },
      ])
      const replay = await f.create()
      expect(replay.seriesId).toBe(f.seriesId)
      expect(replay.replayed).toBe(true)
      expect(replay.manageToken === null).toBe(true)

      await dispatch()
      await runBookingMail(bookingIds, 'confirmed')
      const confirmationTokens = assertCompleteBodies(f, sent)
      expect((await bookingJobs(bookingIds)).map(({ payload }) => payload.kind)).toEqual(
        Array.from({ length: 12 }, () => 'reminder'),
      )

      const request = { ...all(), ...(scope === 'following' ? { scope, fromOrdinal } : {}) }
      const cancel = () => cancelManagedBookingSeries(context(), f.token, request)
      const cancelled = await cancel()
      expect(cancelled.affected.map(({ ordinal }) => ordinal)).toEqual(
        f.occurrences.slice(fromOrdinal - 1).map(({ ordinal }) => ordinal),
      )
      await expect(cancel()).resolves.toEqual({ ...cancelled, replayed: true })
      await dispatch()
      await runBookingMail(bookingIds, 'cancelled')
      const cancellationTokens = assertCompleteBodies(f, sent.slice(19), fromOrdinal)
      expect(
        (await bookingJobs(bookingIds)).filter(({ payload }) => payload.kind === 'cancelled'),
      ).toHaveLength(0)
      expect(await seriesOutbox(f.seriesId)).toMatchObject([
        { kind: 'confirmation', attempts: 1, outbox_state: 'done' },
        { kind: 'cancellation', attempts: 1, outbox_state: 'done' },
      ])
      const receipts = await seriesReceipts(f.seriesId)
      expect(receipts).toHaveLength(38)
      expect(
        receipts.every((row) => row.outcome === 'delivered' && row.suppression_reason === null),
      ).toBe(true)
      expect(receipts.map(({ sent_at }) => sent_at)).toEqual(
        Array.from({ length: 38 }, () => new Date(now().epochMilliseconds)),
      )
      expect(await ledger()).toHaveLength(38)
      expect(new Set([...confirmationTokens, ...cancellationTokens, f.token]).size).toBe(23)
      await assertNoRawCapabilities([...confirmationTokens, ...cancellationTokens, f.token])
    },
    20_000,
  )

  it('stores only send-time digests and refuses every guest mutation through the series capability', async () => {
    const f = await seriesFixture(2, 2)
    await dispatch()
    const receipts = await seriesReceipts(f.seriesId)
    const bookerToken = deliveredToken(required(sent.find(({ to }) => to === booker.email)))
    const guest = required(f.guests[0])
    const guestToken = deliveredToken(required(sent.find(({ to }) => to === guest.email)))
    for (const [token, recipient_role, capability_scope] of [
      [bookerToken, 'booker', 'manage'],
      [guestToken, 'guest', 'read'],
    ] as const) {
      const digest = createHash('sha256').update(token, 'utf8').digest()
      expect(
        receipts.find(({ manage_token_hash }) => manage_token_hash?.equals(digest)),
      ).toMatchObject({
        recipient_role,
        capability_scope,
        outcome: 'delivered',
      })
    }
    expect(receipts.find(({ recipient_role }) => recipient_role === 'host')).toMatchObject({
      capability_scope: null,
      manage_token_hash: null,
    })
    await expect(
      resolveSeriesCapability(db, bookerToken, { scope: 'manage' }),
    ).resolves.toMatchObject({ seriesId: f.seriesId })
    const selector = { seriesManageToken: guestToken, ordinal: 1, expectedRevision: '1' }
    const visible = await getManagedBooking(context(), selector)
    expect(visible.attendees.map(({ email }) => email)).toEqual([guest.email])
    await expect(cancelManagedBooking(context(), selector)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(
      rescheduleManagedBooking(context(), selector, {
        start: Temporal.Instant.from(firstLocalStart).add({ hours: 2 }),
      }),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
    await expect(cancelManagedBookingSeries(context(), guestToken, all())).rejects.toMatchObject({
      code: 'series_not_found',
    })
    await expect(
      resolveSeriesCapability(db, guestToken, { scope: 'manage' }),
    ).resolves.toBeUndefined()
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', outbox_state: 'done' },
    ])
    await assertNoRawCapabilities([bookerToken, guestToken, f.token])
  })

  it('re-reads moved and cancelled members at confirmation delivery', async () => {
    const f = await seriesFixture(3)
    const [first, second] = f.occurrences
    const previous = required(first)
    const start = Temporal.Instant.from(previous.start).add({ hours: 2 })
    const selector = { seriesManageToken: f.token, ordinal: 1, expectedRevision: '1' }
    const moved = await rescheduleManagedBooking(context(), selector, { start })
    await cancelManagedBooking(context(), { ...selector, ordinal: 2, expectedRevision: '2' })
    await dispatch()

    const message = required(sent.find(({ to }) => to === booker.email))
    const display = ({ start, end }: { start: string; end: string }) =>
      formatMeetingTime(Temporal.Instant.from(start), Temporal.Instant.from(end), timeZone, 'en')
    expect(message.text.includes(display(moved.booking))).toBe(true)
    expect(message.text.includes(display(previous))).toBe(false)
    expect(message.text.includes(display(required(second)))).toBe(true)
    expect(message.text.includes(mailMessage('en', 'series.updatedSeparately'))).toBe(true)
    expect(message.text.includes(mailMessage('en', 'series.cancelled.member'))).toBe(true)
    expect(await seriesReceipts(f.seriesId)).toMatchObject([
      {
        reported_ordinals: [1, 2, 3],
        reported_link_states: ['updated_separately', 'cancelled', 'no_conference'],
      },
      {
        reported_ordinals: [1, 2, 3],
        reported_link_states: ['updated_separately', 'cancelled', 'no_conference'],
      },
    ])
  })

  it('keeps ordinary booking and single-member move, cancel and reminder delivery on the per-booking path', async () => {
    const f = await seriesFixture()
    const first = required(f.occurrences[0])
    const ordinary = await ordinaryBooking()
    await runBookingMail([ordinary.bookingId], 'confirmed')
    expect(sent.length).toBe(2)
    expect(sent.find(({ to }) => to === booker.email)?.text.includes('/booking#token=')).toBe(true)
    expect(await ledger()).toHaveLength(2)
    await dispatch()
    sent.length = 0

    const selector = { seriesManageToken: f.token, ordinal: 1, expectedRevision: '1' }
    const start = Temporal.Instant.from(first.start).add({ hours: 2 })
    const moved = await rescheduleManagedBooking(context(), selector, { start })
    const movedOrdinary = await rescheduleManagedBooking(context(), ordinary.token, { start })
    const movedIds = [moved.booking.id, movedOrdinary.booking.id]
    const verifyPerBooking = async (kind: 'rescheduled' | 'reminder' | 'cancelled') => {
      const baseline = sent.length
      const debits = (await ledger()).length
      for (const id of movedIds) {
        const before = sent.length
        await runBookingMail([id], kind)
        const messages = sent.slice(before)
        expect(messages.length).toBe(2)
        expect(messages.filter(({ to }) => to === booker.email).length).toBe(1)
        expect(messages.every((mail) => !mail.text.includes('/series/manage#'))).toBe(true)
        const inviteeText = required(messages.find(({ to }) => to === booker.email)).text
        expect(inviteeText.includes('/booking#token=')).toBe(kind !== 'cancelled')
      }
      expect((await ledger()).length - debits).toBe(4)
      expect(sent[baseline]?.subject).toBe(sent[baseline + 2]?.subject)
      expect(sent[baseline + 1]?.subject).toBe(sent[baseline + 3]?.subject)
    }
    await verifyPerBooking('rescheduled')

    clock = start.subtract({ hours: 24 })
    for (const id of movedIds) {
      const reminder = required(
        (await bookingJobs([id])).find(({ payload }) => payload.kind === 'reminder'),
      )
      expect(reminder.startAfter.toISOString()).toBe(
        new Date(now().epochMilliseconds).toISOString(),
      )
    }
    await verifyPerBooking('reminder')
    await cancelManagedBooking(context(), { ...selector, expectedRevision: '2' })
    await cancelManagedBooking(context(), required(movedOrdinary.manageToken))
    await verifyPerBooking('cancelled')
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', outbox_state: 'done' },
    ])
  })

  it.each([
    ['recipient_hourly_limit', { mailRecipientMaxPerHour: 1 }, 1],
    ['instance_hourly_limit', { mailMaxPerHour: 2 }, 3],
  ] as const)(
    'shares the ordinary booking ledger for %s and never retries suppression',
    async (reason, limits, suppressed) => {
      const ordinary = await ordinaryBooking()
      await runBookingMail([ordinary.bookingId], 'confirmed')
      expect(await ledger()).toHaveLength(2)
      const f = await seriesFixture(2, 1)
      await dispatch(limits)
      expect(sent.length).toBe(2 + 3 - suppressed)
      expect(await ledger()).toHaveLength(2 + 3 - suppressed)
      const receipts = await seriesReceipts(f.seriesId)
      const suppressedRows = receipts.filter(({ outcome }) => outcome === 'suppressed')
      expect(suppressedRows).toHaveLength(suppressed)
      for (const row of suppressedRows) {
        expect(row).toMatchObject({
          suppression_reason: reason,
          capability_scope: null,
          manage_token_hash: null,
        })
      }
      expect(suppressedRows.some(({ recipient_role }) => recipient_role === 'booker')).toBe(true)
      expect(await seriesOutbox(f.seriesId)).toMatchObject([{ outbox_state: 'done', attempts: 1 }])
      clock = clock.add({ hours: 25 })
      await dispatch(limits)
      expect(sent.length).toBe(2 + 3 - suppressed)
      await expect(
        resolveSeriesCapability(db, f.token, { scope: 'manage' }),
      ).resolves.toMatchObject({ seriesId: f.seriesId })
    },
  )

  it('retries only the temporary SMTP refusal with a fresh capability and dedupes a replayed outbox', async () => {
    const f = await seriesFixture(2, 1)
    refuseAddress = booker.email
    await dispatch()
    const failed = deliveredToken(required(attempts.find(({ to }) => to === booker.email)))
    await expect(resolveSeriesCapability(db, failed, { scope: 'read' })).resolves.toBeUndefined()
    expect(attempts.length).toBe(3)
    expect(sent.length).toBe(2)
    expect(await seriesReceipts(f.seriesId)).toHaveLength(2)
    expect(await ledger()).toHaveLength(2)
    const pending = required((await seriesOutbox(f.seriesId))[0])
    expect(pending).toMatchObject({ outbox_state: 'pending', attempts: 1, lease_id: null })
    expect(pending.due_at?.toISOString()).toBe(
      new Date(now().add({ minutes: 1 }).epochMilliseconds).toISOString(),
    )

    refuseAddress = undefined
    clock = now().add({ seconds: 59 })
    await dispatch()
    expect(attempts.length).toBe(3)
    clock = now().add({ seconds: 1 })
    await dispatch()
    expect(attempts.length).toBe(4)
    expect(sent.length).toBe(3)
    expect(await ledger()).toHaveLength(3)
    const successful = deliveredToken(required(sent.find(({ to }) => to === booker.email)))
    expect(successful === failed).toBe(false)
    await expect(
      resolveSeriesCapability(db, successful, { scope: 'manage' }),
    ).resolves.toMatchObject({ seriesId: f.seriesId })
    await expect(resolveSeriesCapability(db, failed, { scope: 'read' })).resolves.toBeUndefined()
    expect(await seriesOutbox(f.seriesId)).toMatchObject([{ outbox_state: 'done', attempts: 2 }])

    // Model a crash after the final recipient commit, before completing the durable intent.
    await db
      .updateTable('booking_series_notifications')
      .set({ outbox_state: 'pending', due_at: now().toString() })
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    await dispatch()
    expect(attempts.length).toBe(4)
    expect(sent.length).toBe(3)
    expect(await ledger()).toHaveLength(3)
    expect(await seriesReceipts(f.seriesId)).toHaveLength(3)
    expect(await seriesOutbox(f.seriesId)).toMatchObject([{ outbox_state: 'done', attempts: 3 }])
    await assertNoRawCapabilities([failed, successful, f.token])
  })
})
