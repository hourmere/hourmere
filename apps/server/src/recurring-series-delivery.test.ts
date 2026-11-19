import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import {
  bookingConferenceJob,
  calendarEncryptionKey,
  conferenceBookingNotifier,
  encryptCredential,
  retryBookingConference,
  tokenAad,
} from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  createLogMailer,
  createSmtpMailer,
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
  dispatchConferenceNotifications,
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
  type PublicContext,
  rescheduleManagedBooking,
  resolveSeriesCapability,
} from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../../packages/calendars/src/testing.ts'
import { fakeSmtpServer } from '../../../packages/mail/src/smtp-testing.ts'

const serverUrl = process.env.DATABASE_URL
// pg-boss accounts for job retention using PostgreSQL wall time.
const fixtureNow = Temporal.Instant.from('2030-11-02T00:00Z')
const firstLocalStart = '2030-11-04T09:00+00:00'
const timeZone = 'UTC'
const durationMinutes = 30
const publicUrl = 'https://hourmere.example.test'
const eventName = 'Weekly studio hours'
const senderEmail = 'calendar@hourmere.example.test'
const meetJoinUrl = 'https://meet.google.com/abc-defg-hij'
const linkUpdateSubject = 'Synthetic series link update'
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

function parseCalendar(message: MailMessage) {
  expect(message.attachments).toHaveLength(1)
  const attachment = required(message.attachments?.[0])
  const calendar = new ICAL.Component(ICAL.parse(attachment.content))
  expect(calendar.name).toBe('vcalendar')
  expect(calendar.getFirstPropertyValue('version')).toBe('2.0')
  const events = calendar.getAllSubcomponents('vevent')
  expect(calendar.getAllSubcomponents()).toEqual(events)
  return { attachment, calendar, events }
}

type CalendarOccurrence = {
  bookingId: string
  start: string
  end: string
  depth?: number
}

function expectCalendarEvents(
  events: readonly ICAL.Component[],
  occurrences: readonly CalendarOccurrence[],
  stamp: Temporal.Instant,
  status: 'CONFIRMED' | 'CANCELLED',
  organizerEmail = senderEmail,
) {
  expect(events.map((event) => event.getFirstPropertyValue('uid'))).toEqual(
    occurrences.map(({ bookingId }) => `${bookingId}@hourmere`),
  )
  for (const [index, occurrence] of occurrences.entries()) {
    const event = required(events[index])
    for (const [name, expected] of [
      ['dtstart', Temporal.Instant.from(occurrence.start)],
      ['dtend', Temporal.Instant.from(occurrence.end)],
      ['dtstamp', stamp],
    ] as const) {
      const value = event.getFirstPropertyValue(name)
      expect(value).toBeInstanceOf(ICAL.Time)
      const time = value as ICAL.Time
      expect(time.zone.tzid).toBe('UTC')
      expect(time.toJSDate().toISOString()).toBe(new Date(expected.epochMilliseconds).toISOString())
    }
    expect(event.getFirstPropertyValue('status')).toBe(status)
    expect(event.getFirstPropertyValue('sequence')).toBe(
      (occurrence.depth ?? 0) + (status === 'CANCELLED' ? 1 : 0),
    )
    expect(event.getFirstPropertyValue('rrule')).toBeNull()
    expect(event.getFirstPropertyValue('recurrence-id')).toBeNull()
    expect(event.getFirstPropertyValue('organizer')).toBe(`mailto:${organizerEmail}`)
  }
}

function expectSeriesCalendar(
  message: MailMessage,
  occurrences: readonly CalendarOccurrence[],
  stamp: Temporal.Instant,
  status: 'CONFIRMED' | 'CANCELLED',
  organizerEmail = senderEmail,
) {
  if (occurrences.length === 0) {
    expect(message.attachments ?? []).toHaveLength(0)
    return []
  }
  const { attachment, calendar, events } = parseCalendar(message)
  expect(attachment.filename).toBe('series.ics')
  expect(attachment.contentType).toBe('text/calendar; charset=UTF-8')
  expect(calendar.getFirstPropertyValue('method')).toBeNull()
  expectCalendarEvents(events, occurrences, stamp, status, organizerEmail)
  return events
}

describe.skipIf(!serverUrl)('aggregate series notification delivery on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs>
  let clock = fixtureNow
  const now = () => clock
  const providerNow = () => now().epochMilliseconds
  let google: ReturnType<typeof fakeGoogle>
  const sent: MailMessage[] = []
  const attempts: MailMessage[] = []
  const logs: string[] = []
  const logMailer = createLogMailer((line) => logs.push(line))
  let smtp: (ReturnType<typeof fakeSmtpServer> & { mailer?: Mailer }) | undefined
  let refuseAddress: string | undefined
  let permanentRefusal = false
  const mailer: Mailer = {
    senderEmail,
    async send(message, options) {
      attempts.push(message)
      const refused = message.to === refuseAddress && message.subject !== linkUpdateSubject
      if (smtp?.mailer) {
        const { rcptReplies } = smtp.received
        rcptReplies.clear()
        if (refused) {
          rcptReplies.set(
            message.to,
            permanentRefusal ? '550 5.1.1 Mailbox unavailable' : '450 4.2.0 Mailbox deferred',
          )
        }
        await smtp.mailer.send(message, options)
      } else if (refused) {
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
  const context = (automaticMeet = false): PublicContext => ({
    db,
    now,
    automaticMeet,
    notify: async (trx, event, at) => {
      if (automaticMeet && !('requestId' in event))
        await conferenceBookingNotifier(jobs)(trx, event)
      await bookingNotifier(jobs)(trx, event, at)
    },
  })
  const jobRun = () => ({ id: randomUUID(), attempt: 1, signal: new AbortController().signal })
  const dispatch = (limits?: Partial<NotificationDeps>) =>
    seriesNotificationDispatchJob(deps(limits)).handler({}, jobRun())
  const dispatchLinkUpdates = () =>
    seriesNotificationDispatchJob(deps(), ({ recipient }) => ({
      to: recipient.email,
      subject: linkUpdateSubject,
      text: linkUpdateSubject,
    })).handler({}, jobRun())
  const meetJob = () =>
    bookingConferenceJob({
      db,
      now: providerNow,
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
    })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_delivery' })
    db = createDb(owned.pool)
    google = fakeGoogle(providerNow)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [
        bookingNotificationJob(deps()),
        seriesNotificationDispatchJob(deps()),
        meetJob(),
      ],
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
    permanentRefusal = false
    google = fakeGoogle(providerNow)
    google.controls.importedConferenceRequestMode = 'process_duplicate'
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('booking_conference_notifications').execute()
    // Each case advances its own clock through unrelated outbox due times.
    await db.deleteFrom('booking_series_notifications').execute()
  })

  afterEach(async () => {
    const loopback = smtp
    smtp = undefined
    if (!loopback) return
    for (const socket of loopback.sockets) socket.destroy()
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()))
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function seriesFixture(count = 2, guestCount = 0, hostCount = 1, automaticMeet = false) {
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
    const organizer = required(hosts[0])
    if (automaticMeet) await configureMeet(organizer.id)
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
      ...(automaticMeet && { location: { kind: 'google_meet', autoCreate: true } }),
    })
    await db
      .updateTable('event_types')
      .set({
        scheduling_type: hostCount > 1 ? 'collective' : 'individual',
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 12 }),
        ...(automaticMeet && { conference_organizer_user_id: organizer.id }),
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
      createPublicTeamBookingSeries(context(automaticMeet), input, {
        recurringBookingsEnabled: true,
        actorDigest,
        notifyMemberEmail: bookingNotifier(jobs),
        ...(automaticMeet && { notifyMemberConference: conferenceBookingNotifier(jobs) }),
      })
    const result = await create()
    return { ...result, token: required(result.manageToken), hosts, guests, create, team }
  }
  type SeriesFixture = Awaited<ReturnType<typeof seriesFixture>>

  async function configureMeet(organizerId: string) {
    const account = 'synthetic-meet-account'
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: organizerId,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          tokenAad(organizerId, account),
          JSON.stringify({
            accessToken: 'synthetic-meet-access',
            refreshToken: 'synthetic-meet-refresh',
            expiresAt: now().add({ hours: 2 }).epochMilliseconds,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'synthetic-primary',
        name: 'Synthetic Meet calendar',
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calendar.id })
      .where('user_id', '=', organizerId)
      .execute()
  }

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

  const linkOutbox = (seriesId: string) =>
    db
      .selectFrom('booking_series_notifications')
      .select([
        'id',
        'after_action_revision',
        'recipient_id',
        'recipient_role',
        'outbox_state',
        'waiting_for_earlier',
        'attempts',
        'due_at',
        'lease_id',
        'lease_until',
      ])
      .where('series_id', '=', seriesId)
      .where('row_type', '=', 'outbox')
      .where('kind', '=', 'link_update')
      .orderBy('id')
      .execute()

  const bookerLinkOutbox = async (seriesId: string) =>
    required((await linkOutbox(seriesId)).find(({ recipient_role }) => recipient_role === 'booker'))

  // Observe the wake before the dispatcher can claim the link update again. The matching
  // xmin verifies the earlier copy became final in the very transaction that woke it.
  async function observeLinkWake(outboxId: string, dispatchWake: () => Promise<void>) {
    await owned.pool.query(`
      CREATE TABLE series_link_wakes_test (
        outbox_id uuid, due_at timestamptz, attempts smallint,
        outcome text, outbox_state text
      );
      CREATE FUNCTION observe_series_link_wake_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO series_link_wakes_test
        SELECT NEW.id, NEW.due_at, NEW.attempts,
          (SELECT n.outcome FROM booking_series_notifications n
           WHERE (n.organization_id, n.series_id) = (NEW.organization_id, NEW.series_id)
             AND n.kind = 'confirmation' AND n.row_type = 'receipt'
             AND (n.recipient_role, n.recipient_id) = (NEW.recipient_role, NEW.recipient_id)
             AND n.xmin = pg_current_xact_id()::text::xid),
          (SELECT n.outbox_state FROM booking_series_notifications n
           WHERE (n.organization_id, n.series_id) = (NEW.organization_id, NEW.series_id)
             AND n.kind = 'confirmation' AND n.row_type = 'outbox'
             AND n.xmin = pg_current_xact_id()::text::xid);
        RETURN NULL;
      END $$;
      CREATE TRIGGER observe_series_link_wake_test
        AFTER UPDATE ON booking_series_notifications FOR EACH ROW
        WHEN (OLD.waiting_for_earlier AND NOT NEW.waiting_for_earlier AND NEW.outbox_state = 'pending')
        EXECUTE FUNCTION observe_series_link_wake_test();
    `)
    try {
      await dispatchWake()
      const { rows } = await owned.pool.query<{
        due_at: Date
        attempts: number
        outcome: string | null
        outbox_state: string | null
      }>(
        `SELECT due_at, attempts, outcome, outbox_state FROM series_link_wakes_test WHERE outbox_id = $1`,
        [outboxId],
      )
      return rows
    } finally {
      await owned.pool.query(`
        DROP TRIGGER observe_series_link_wake_test ON booking_series_notifications;
        DROP FUNCTION observe_series_link_wake_test();
        DROP TABLE series_link_wakes_test;
      `)
    }
  }

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

  type ConferenceState = 'ready' | 'failed' | 'pending'
  type ConferenceMarker = ConferenceState | 'started' | 'cancelled'

  async function meetSeries(firstStartInMinutes?: number) {
    if (firstStartInMinutes !== undefined)
      clock = Temporal.Instant.from(firstLocalStart).subtract({ minutes: firstStartInMinutes })
    const series = await seriesFixture(12, 10, 8, true)
    const ids = series.occurrences.map(({ bookingId }) => bookingId)
    const jobs = await owned.pool.query<{ root_id: string }>(
      `SELECT data->>'rootBookingId' AS root_id FROM pgboss.job
        WHERE name = $1 AND data->>'rootBookingId' = ANY($2::text[])`,
      [meetJob().name, ids],
    )
    expect(jobs.rows.map(({ root_id }) => root_id).sort()).toEqual([...ids].sort())
    const conferences = await db
      .selectFrom('booking_conferences')
      .select(['booking_id', 'state'])
      .where('root_booking_id', 'in', ids)
      .execute()
    expect(conferences).toHaveLength(12)
    expect(conferences.every(({ state }) => state === 'pending')).toBe(true)
    expect(google.calls).toHaveLength(0)
    return series
  }

  async function provision({ bookingId }: CalendarOccurrence, state: ConferenceState) {
    google.controls.conferencePollsBeforeReady = state === 'pending' ? Infinity : 0
    google.controls.conferenceOutcome = state === 'failed' ? 'failure' : 'success'
    await meetJob().handler({ rootBookingId: bookingId }, jobRun())
    const conference = await db
      .selectFrom('booking_conferences')
      .select('state')
      .where('root_booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    expect(conference.state).toBe(state)
  }

  async function repairConference(f: SeriesFixture, index: number) {
    const occurrence = required(f.occurrences[index])
    await retryBookingConference(
      { ...context(true), principal: f.team.as(required(f.hosts[0])) },
      occurrence.bookingId,
    )
    await provision(occurrence, 'ready')
  }

  async function failedConferenceSeries(count = 2, guestCount = 0, hostCount = 2) {
    smtp = fakeSmtpServer()
    const listening = once(smtp.server, 'listening')
    smtp.server.listen(0, '127.0.0.1')
    await listening
    const { port } = smtp.server.address() as AddressInfo
    smtp.mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: senderEmail })
    const f = await seriesFixture(count, guestCount, hostCount, true)
    for (const occurrence of f.occurrences) await provision(occurrence, 'failed')
    expect(await linkOutbox(f.seriesId)).toEqual([])
    return f
  }

  const sentLinkUpdates = () => sent.filter(({ subject }) => subject === linkUpdateSubject)
  const bookerLinkAttempts = () =>
    attempts.filter(({ to, subject }) => to === booker.email && subject === linkUpdateSubject)

  async function expectConferenceConfirmation(f: SeriesFixture, states: ConferenceMarker[]) {
    const ids = f.occurrences.map(({ bookingId }) => bookingId)
    await dispatch()
    await dispatchConferenceNotifications(deps())
    await runBookingMail(ids, 'confirmed')
    await dispatch()
    assertCompleteBodies(f, sent)
    expect(attempts.length).toBe(19)
    const receipts = await seriesReceipts(f.seriesId)
    expect(receipts).toHaveLength(19)
    expect(await ledger()).toHaveLength(19)
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', attempts: 1, outbox_state: 'done', due_at: new Date(providerNow()) },
    ])
    const labels = {
      failed: 'series.failed',
      pending: 'series.pending',
      started: 'series.started',
      cancelled: 'series.cancelled.member',
    } as const
    for (const message of sent) {
      const host = f.hosts.find(({ email }) => email === message.to)
      const locale = host?.locale === 'zh-CN' ? 'zh-CN' : 'en'
      const isOrganizer = required(f.hosts[0]).email === message.to
      const attached = f.occurrences.filter(({ ordinal }) => {
        const state = states[ordinal - 1]
        if (isOrganizer) return state === 'failed'
        return state !== 'started' && state !== 'cancelled'
      })
      const events = expectSeriesCalendar(message, attached, now(), 'CONFIRMED')
      for (const [index, event] of events.entries()) {
        const state = required(states[required(attached[index]).ordinal - 1])
        const description = state === 'ready' ? meetJoinUrl : mailMessage(locale, labels[state])
        expect(event.getFirstPropertyValue('description')).toBe(description)
        expect(event.getFirstPropertyValue('location')).toBe(state === 'ready' ? meetJoinUrl : null)
      }
      for (const state of ['ready', 'failed', 'pending', 'started', 'cancelled'] as const) {
        const label = state === 'ready' ? meetJoinUrl : mailMessage(locale, labels[state])
        const count = states.filter((value) => value === state).length
        expect(message.text.split(label).length - 1).toBe(count)
        expect(required(message.html).split(escapeHtml(label)).length - 1).toBe(count)
      }
      expect(message.text.includes(mailMessage(locale, 'series.repair'))).toBe(
        Boolean(host) && states.includes('failed'),
      )
    }
    for (const receipt of receipts) {
      expect({
        outcome: receipt.outcome,
        suppression: receipt.suppression_reason,
        sentAt: receipt.sent_at,
        reportedOrdinals: receipt.reported_ordinals,
        reportedStates: receipt.reported_link_states,
      }).toEqual({
        outcome: 'delivered',
        suppression: null,
        sentAt: new Date(providerNow()),
        reportedOrdinals: f.occurrences.map(({ ordinal }) => ordinal),
        reportedStates: states,
      })
    }
    await expectNoOccurrenceConferenceMail(ids)
  }

  async function expectNoOccurrenceConferenceMail(ids: string[]) {
    const notices = await db
      .selectFrom('booking_conference_notifications')
      .select('kind')
      .where('booking_id', 'in', ids)
      .where('kind', 'in', ['confirmed', 'conference_failed'])
      .execute()
    expect(notices).toEqual([])
    const receipts = await db
      .selectFrom('booking_notifications')
      .select('kind')
      .where('booking_id', 'in', ids)
      .where('kind', 'in', ['confirmed', 'conference_failed'])
      .execute()
    expect(receipts).toEqual([])
  }

  async function expectConferenceStillWaiting(f: SeriesFixture) {
    await dispatch()
    expect(sent.length).toBe(0)
    expect(attempts.length).toBe(0)
    expect(await seriesReceipts(f.seriesId)).toHaveLength(0)
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', attempts: 0, outbox_state: 'pending' },
    ])
  }

  it.each([
    ['all ready', 12],
    ['eight ready and four failed', 8],
    ['all failed', 0],
  ] as const)(
    'sends one series confirmation per recipient at the last terminal result with %s',
    async (_label, readyCount) => {
      const f = await meetSeries()
      const states = f.occurrences.map(({ ordinal }) =>
        ordinal <= readyCount ? 'ready' : 'failed',
      )
      await expectConferenceStillWaiting(f)
      clock = fixtureNow.add({ seconds: 5 })
      for (const [index, occurrence] of f.occurrences.slice(0, -1).entries())
        await provision(occurrence, required(states[index]))
      await expectConferenceStillWaiting(f)
      clock = fixtureNow.add({ seconds: 10 })
      await provision(required(f.occurrences.at(-1)), required(states.at(-1)))
      await expectConferenceConfirmation(f, states)
    },
    20_000,
  )

  it('confirms with the first link after ten seconds when the first start is imminent', async () => {
    const f = await meetSeries(10)
    const [first, second, ...rest] = f.occurrences
    const committed = now()
    await provision(required(first), 'pending')
    await provision(required(second), 'pending')
    for (const occurrence of rest) await provision(occurrence, 'ready')
    clock = committed.add({ seconds: 10 }).subtract({ milliseconds: 1 })
    await expectConferenceStillWaiting(f)
    clock = committed.add({ seconds: 10 })
    await provision(required(first), 'ready')
    await expectConferenceConfirmation(f, ['ready', 'pending', ...rest.map(() => 'ready' as const)])
  }, 20_000)

  it('keeps the deadline when the organizer retries a failed first link before the sweep', async () => {
    const f = await meetSeries(10)
    const [first, ...rest] = f.occurrences
    const bookingId = required(first).bookingId
    const committed = now()
    for (const occurrence of rest) await provision(occurrence, 'pending')
    await expectConferenceStillWaiting(f)
    clock = committed.add({ seconds: 10 })
    await provision(required(first), 'failed')
    expect(await seriesOutbox(f.seriesId)).toMatchObject([{ due_at: new Date(providerNow()) }])
    clock = committed.add({ seconds: 20 })
    await retryBookingConference(
      { ...context(true), principal: f.team.as(required(f.hosts[0])) },
      bookingId,
    )
    await expectConferenceConfirmation(
      f,
      f.occurrences.map(() => 'pending'),
    )
  }, 20_000)

  it.each([
    [10, 5],
    [14, 5],
    [16, 5],
    [25, 10],
    [60, 30],
  ])(
    'confirms for a start %i minutes after commit at minute %i with the first link pending',
    async (firstStart, confirmationDue) => {
      const f = await meetSeries(firstStart)
      const [first, ...rest] = f.occurrences
      const committed = now()
      await provision(required(first), 'pending')
      for (const occurrence of rest) await provision(occurrence, 'ready')
      clock = committed.add({ minutes: confirmationDue }).subtract({ milliseconds: 1 })
      await expectConferenceStillWaiting(f)
      clock = committed.add({ minutes: confirmationDue })
      await expectConferenceConfirmation(f, ['pending', ...rest.map(() => 'ready' as const)])
    },
    20_000,
  )

  it('honors a first start before the imminent deadline and omits its started calendar entry', async () => {
    const f = await meetSeries(3)
    const [first, ...rest] = f.occurrences
    for (const occurrence of f.occurrences) await provision(occurrence, 'pending')
    const start = Temporal.Instant.from(required(first).start)
    clock = start.subtract({ milliseconds: 1 })
    await expectConferenceStillWaiting(f)
    clock = start
    await expectConferenceConfirmation(f, ['started', ...rest.map(() => 'pending' as const)])
  }, 20_000)

  it('ignores a cancelled member still pending at the other members’ terminal point', async () => {
    const f = await meetSeries(60)
    const [first, ...rest] = f.occurrences
    const committed = now()
    await provision(required(first), 'pending')
    await cancelManagedBooking(context(true), {
      seriesManageToken: f.token,
      ordinal: 1,
      expectedRevision: '1',
    })
    for (const occurrence of rest.slice(0, -1)) await provision(occurrence, 'ready')
    await expectConferenceStillWaiting(f)
    clock = committed.add({ seconds: 1 })
    await provision(required(rest.at(-1)), 'ready')
    await expectConferenceConfirmation(f, ['cancelled', ...rest.map(() => 'ready' as const)])
  }, 20_000)

  it('uses the next root when the first ready root is cancelled before its lead point', async () => {
    const f = await meetSeries(25)
    const [first, ...rest] = f.occurrences
    const committed = now()
    for (const occurrence of rest) await provision(occurrence, 'pending')
    clock = committed.add({ seconds: 10 })
    await provision(required(first), 'ready')
    await expectConferenceStillWaiting(f)
    clock = committed.add({ minutes: 1 })
    await cancelManagedBooking(context(true), {
      seriesManageToken: f.token,
      ordinal: 1,
      expectedRevision: '1',
    })
    clock = committed.add({ minutes: 10 })
    await expectConferenceStillWaiting(f)
    clock = committed.add({ minutes: 30 })
    await expectConferenceConfirmation(f, ['cancelled', ...rest.map(() => 'pending' as const)])
  }, 20_000)

  it('skips a waiting conference confirmation and sends every copy of a whole cancellation', async () => {
    const f = await meetSeries(60)
    for (const occurrence of f.occurrences) await provision(occurrence, 'pending')
    await expectConferenceStillWaiting(f)
    clock = now().add({ seconds: 1 })
    await cancelManagedBookingSeries(context(true), f.token, all())
    await dispatch()
    await dispatchConferenceNotifications(deps())
    assertCompleteBodies(f, sent, 1)
    expect(attempts.length).toBe(19)
    expect(sent.every(({ attachments }) => !attachments?.length)).toBe(true)
    expect(await ledger()).toHaveLength(19)
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', outbox_state: 'skipped' },
      { kind: 'cancellation', outbox_state: 'done', attempts: 1 },
    ])
    const receipts = await seriesReceipts(f.seriesId)
    expect(receipts).toHaveLength(19)
    expect(
      receipts.every(
        (row) =>
          row.kind === 'cancellation' &&
          row.outcome === 'delivered' &&
          row.suppression_reason === null &&
          row.sent_at?.getTime() === providerNow() &&
          row.calendar_ordinals?.length === 0 &&
          row.reported_link_states?.length === 12 &&
          row.reported_link_states.every((state) => state === 'cancelled'),
      ),
    ).toBe(true)
    await expectNoOccurrenceConferenceMail(f.occurrences.map(({ bookingId }) => bookingId))
  }, 20_000)

  it('coalesces late provider results and releases only the booker’s waiting copy with its receipt', async () => {
    const f = await failedConferenceSeries(3, 10, 8)
    const committed = now()
    refuseAddress = booker.email
    await dispatch()
    expect(sent).toHaveLength(18)
    expect(attempts.filter(({ to }) => to === booker.email)).toHaveLength(1)

    clock = committed.add({ seconds: 10 })
    await repairConference(f, 0)
    const queued = await linkOutbox(f.seriesId)
    expect(queued).toHaveLength(19)
    expect(
      queued.every(({ attempts, outbox_state }) => attempts === 0 && outbox_state === 'pending'),
    ).toBe(true)
    clock = committed.add({ seconds: 20 })
    await repairConference(f, 1)
    expect((await linkOutbox(f.seriesId)).map(({ id }) => id)).toEqual(queued.map(({ id }) => id))

    await dispatchLinkUpdates()
    expect(
      sentLinkUpdates()
        .map(({ to }) => to)
        .sort(),
    ).toEqual([...f.hosts, ...f.guests].map(({ email }) => email).sort())
    expect(bookerLinkAttempts()).toHaveLength(0)
    const waiting = await bookerLinkOutbox(f.seriesId)
    expect(waiting).toMatchObject({
      outbox_state: 'pending',
      waiting_for_earlier: true,
      attempts: 0,
      lease_id: null,
      lease_until: null,
    })

    clock = committed.add({ minutes: 1 })
    await dispatchLinkUpdates()
    expect(bookerLinkAttempts()).toHaveLength(0)
    expect(await bookerLinkOutbox(f.seriesId)).toEqual(waiting)
    expect(attempts.filter(({ to }) => to === booker.email)).toHaveLength(2)

    clock = committed.add({ minutes: 3 })
    refuseAddress = undefined
    expect(await observeLinkWake(waiting.id, dispatchLinkUpdates)).toEqual([
      expect.objectContaining({
        due_at: new Date(providerNow()),
        attempts: 0,
        outcome: 'delivered',
      }),
    ])
    expect(
      sent
        .filter(({ to }) => to === booker.email)
        .map(({ subject }) => subject === linkUpdateSubject),
    ).toEqual([false, true])
    expect(sentLinkUpdates()).toHaveLength(19)
    expect(await bookerLinkOutbox(f.seriesId)).toMatchObject({ outbox_state: 'done', attempts: 1 })
    expect(await ledger()).toHaveLength(38)
    await expectNoOccurrenceConferenceMail(f.occurrences.map(({ bookingId }) => bookingId))
  }, 20_000)

  it.each(['permanent', 'exhausted'] as const)(
    'wakes the booker’s link update when its confirmation refusal becomes %s',
    async (finalState) => {
      const f = await failedConferenceSeries()
      const committed = now()
      refuseAddress = booker.email
      await dispatch()
      clock = committed.add({ seconds: 10 })
      await repairConference(f, 0)
      await dispatchLinkUpdates()
      const hostEmails = f.hosts.map(({ email }) => email)
      expect(
        sentLinkUpdates()
          .map(({ to }) => to)
          .sort(),
      ).toEqual(hostEmails.toSorted())
      expect(bookerLinkAttempts()).toHaveLength(0)
      const waiting = await bookerLinkOutbox(f.seriesId)
      expect(waiting).toMatchObject({ waiting_for_earlier: true, attempts: 0 })

      if (finalState === 'exhausted') {
        for (const minutes of [1, 3, 7, 15, 31, 63, 123, 183, 243, 303, 363]) {
          clock = committed.add({ minutes })
          await dispatchLinkUpdates()
          expect(await bookerLinkOutbox(f.seriesId)).toEqual(waiting)
        }
        expect(bookerLinkAttempts()).toHaveLength(0)
        clock = committed.add({ minutes: 423 })
      } else {
        clock = committed.add({ minutes: 1 })
        permanentRefusal = true
      }

      expect(await observeLinkWake(waiting.id, dispatchLinkUpdates)).toEqual([
        expect.objectContaining({
          due_at: new Date(providerNow()),
          attempts: 0,
          ...(finalState === 'permanent' ? { outcome: 'rejected' } : { outbox_state: 'exhausted' }),
        }),
      ])
      expect(await seriesOutbox(f.seriesId)).toContainEqual(
        expect.objectContaining({
          kind: 'confirmation',
          outbox_state: finalState === 'exhausted' ? 'exhausted' : 'done',
          attempts: finalState === 'exhausted' ? 13 : 2,
        }),
      )
      const confirmationAttempts = () =>
        attempts.filter(({ to, subject }) => to === booker.email && subject !== linkUpdateSubject)
      const count = finalState === 'exhausted' ? 13 : 2
      expect(confirmationAttempts()).toHaveLength(count)
      expect(
        sentLinkUpdates()
          .map(({ to }) => to)
          .sort(),
      ).toEqual([...hostEmails, booker.email].sort())
      clock = now().add({ minutes: 60 })
      await dispatchLinkUpdates()
      expect(confirmationAttempts()).toHaveLength(count)
      expect(bookerLinkAttempts()).toHaveLength(1)
    },
    20_000,
  )

  it('skips a waiting link update with zero attempts after whole-series cancellation', async () => {
    const f = await failedConferenceSeries()
    refuseAddress = booker.email
    await dispatch()
    clock = now().add({ seconds: 10 })
    await repairConference(f, 0)
    await dispatchLinkUpdates()
    const waiting = await bookerLinkOutbox(f.seriesId)
    expect(waiting).toMatchObject({ waiting_for_earlier: true, attempts: 0 })

    clock = now().add({ seconds: 10 })
    await repairConference(f, 1)
    expect(await bookerLinkOutbox(f.seriesId)).toEqual(waiting)
    await cancelManagedBookingSeries(context(true), f.token, all())
    refuseAddress = undefined
    await dispatch()
    expect(await bookerLinkOutbox(f.seriesId)).toMatchObject({
      id: waiting.id,
      outbox_state: 'skipped',
      waiting_for_earlier: false,
      attempts: 0,
      lease_id: null,
      lease_until: null,
    })
    expect(bookerLinkAttempts()).toHaveLength(0)
    expect(await seriesReceipts(f.seriesId)).toContainEqual(
      expect.objectContaining({
        kind: 'cancellation',
        recipient_role: 'booker',
        outcome: 'delivered',
      }),
    )
  }, 20_000)

  it('orders a later link update behind a retried earlier partial cancellation per recipient', async () => {
    const f = await failedConferenceSeries()
    await dispatch()
    const confirmed = now()
    clock = confirmed.add({ seconds: 10 })
    refuseAddress = booker.email
    await cancelManagedBookingSeries(context(true), f.token, {
      ...all(),
      scope: 'following',
      fromOrdinal: 2,
    })
    await dispatch()
    expect(await seriesOutbox(f.seriesId)).toMatchObject([
      { kind: 'confirmation', outbox_state: 'done' },
      { kind: 'cancellation', outbox_state: 'pending', attempts: 1 },
    ])

    clock = confirmed.add({ seconds: 20 })
    await repairConference(f, 0)
    const legacyLink = await bookerLinkOutbox(f.seriesId)
    await db
      .updateTable('booking_series_notifications')
      .set({ after_action_revision: null })
      .where('id', '=', legacyLink.id)
      .executeTakeFirstOrThrow()
    await dispatchLinkUpdates()
    const hostEmails = f.hosts.map(({ email }) => email)
    expect(
      sentLinkUpdates()
        .map(({ to }) => to)
        .sort(),
    ).toEqual(hostEmails.toSorted())
    expect(bookerLinkAttempts()).toHaveLength(0)
    expect(await bookerLinkOutbox(f.seriesId)).toMatchObject({
      after_action_revision: '2',
      waiting_for_earlier: true,
      attempts: 0,
    })

    clock = confirmed.add({ seconds: 70 })
    refuseAddress = undefined
    await dispatchLinkUpdates()
    expect(
      sentLinkUpdates()
        .map(({ to }) => to)
        .sort(),
    ).toEqual([...hostEmails, booker.email].sort())
    expect(await seriesOutbox(f.seriesId)).toContainEqual(
      expect.objectContaining({
        kind: 'cancellation',
        outbox_state: 'done',
        attempts: 2,
      }),
    )
  }, 20_000)

  it('does not send a queued link update to a host whose team membership was removed', async () => {
    const f = await failedConferenceSeries(2, 1, 2)
    const formerHost = required(f.hosts[1])
    await dispatch()
    clock = now().add({ seconds: 10 })
    await repairConference(f, 0)
    const formerHostCopy = async () =>
      required(
        (await linkOutbox(f.seriesId)).find(({ recipient_id }) => recipient_id === formerHost.id),
      )
    expect(await formerHostCopy()).toMatchObject({ outbox_state: 'pending', attempts: 0 })

    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', formerHost.id)
      .executeTakeFirstOrThrow()
    await dispatchLinkUpdates()

    expect(
      sentLinkUpdates()
        .map(({ to }) => to)
        .sort(),
    ).toEqual([booker.email, required(f.guests[0]).email, required(f.hosts[0]).email].sort())
    expect(
      attempts.some(({ to, subject }) => to === formerHost.email && subject === linkUpdateSubject),
    ).toBe(false)
    expect(await formerHostCopy()).toMatchObject({ outbox_state: 'skipped', attempts: 0 })
  }, 20_000)

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
      for (const message of sent) expectSeriesCalendar(message, f.occurrences, now(), 'CONFIRMED')
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
      for (const message of sent.slice(19))
        expectSeriesCalendar(message, f.occurrences.slice(fromOrdinal - 1), now(), 'CANCELLED')
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
    const guestMessage = required(sent.find(({ to }) => to === guest.email))
    const guestToken = deliveredToken(guestMessage)
    const guestEvents = expectSeriesCalendar(guestMessage, f.occurrences, now(), 'CONFIRMED')
    for (const event of guestEvents) {
      const attendeeProperties = event.getAllProperties('attendee')
      expect(attendeeProperties.map((property) => property.getFirstValue())).toEqual([
        `mailto:${guest.email}`,
      ])
      expect(attendeeProperties.map((property) => property.getParameter('cn'))).toEqual([
        guest.name,
      ])
      expect(event.toString()).not.toContain(booker.name)
      expect(event.toString()).not.toContain(booker.email)
      expect(event.toString()).not.toContain(required(f.guests[1]).name)
      expect(event.toString()).not.toContain(required(f.guests[1]).email)
    }
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
    const f = await seriesFixture(4)
    const [first, second, third] = f.occurrences
    const previous = required(second)
    const start = Temporal.Instant.from(previous.start).add({ hours: 2 })
    const selector = { seriesManageToken: f.token, ordinal: 2, expectedRevision: '1' }
    const moved = await rescheduleManagedBooking(context(), selector, { start })
    await cancelManagedBooking(context(), { ...selector, ordinal: 3, expectedRevision: '2' })
    clock = Temporal.Instant.from(required(first).start)
    await dispatch()

    const message = required(sent.find(({ to }) => to === booker.email))
    expectSeriesCalendar(message, f.occurrences.slice(3), now(), 'CONFIRMED')
    const display = ({ start, end }: { start: string; end: string }) =>
      formatMeetingTime(Temporal.Instant.from(start), Temporal.Instant.from(end), timeZone, 'en')
    expect(message.text.includes(display(moved.booking))).toBe(true)
    expect(message.text.includes(display(previous))).toBe(false)
    expect(message.text.includes(display(required(third)))).toBe(true)
    expect(message.text.includes(mailMessage('en', 'series.started'))).toBe(true)
    expect(message.text.includes(mailMessage('en', 'series.updatedSeparately'))).toBe(true)
    expect(message.text.includes(mailMessage('en', 'series.cancelled.member'))).toBe(true)
    expect(await seriesReceipts(f.seriesId)).toMatchObject([
      {
        reported_ordinals: [1, 2, 3, 4],
        reported_link_states: ['started', 'updated_separately', 'cancelled', 'no_conference'],
      },
      {
        reported_ordinals: [1, 2, 3, 4],
        reported_link_states: ['started', 'updated_separately', 'cancelled', 'no_conference'],
      },
    ])
  })

  it('includes all twelve root events while a conference is pending and hides stale join URLs', async () => {
    const f = await seriesFixture(12, 1)
    const [pending, ready] = f.occurrences
    const organizer = required(f.hosts[0])
    const readyUrl = 'https://meet.google.com/synthetic-ready'
    const staleUrl = 'https://meet.google.com/synthetic-stale'
    for (const [occurrence, state, url] of [
      [required(pending), 'pending', staleUrl],
      [required(ready), 'ready', readyUrl],
    ] as const) {
      await db
        .updateTable('bookings')
        .set({ location: { kind: 'google_meet', autoCreate: true, url } })
        .where('id', '=', occurrence.bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: occurrence.bookingId,
          booking_id: occurrence.bookingId,
          organization_id: f.team.id,
          organizer_user_id: organizer.id,
          state,
          applied_revision: state === 'ready' ? 0 : null,
        })
        .execute()
    }
    await dispatch()
    expect(sent).toHaveLength(3)
    for (const message of sent) {
      const events = expectSeriesCalendar(message, f.occurrences, now(), 'CONFIRMED')
      expect(required(events[0]).getFirstPropertyValue('description')).toContain(
        mailMessage('en', 'series.pending'),
      )
      expect(required(events[1]).getFirstPropertyValue('description')).toContain(readyUrl)
      expect(events.map((event) => event.toString()).join('\n')).not.toContain(staleUrl)
      expect(message.text).not.toContain(staleUrl)
    }
  })

  it('excludes exactly the provider copies each host has and retains a failed Meet event', async () => {
    const f = await seriesFixture(4, 1, 3)
    const allHost = required(f.hosts[0])
    const partialHost = required(f.hosts[1])
    const meetHost = required(f.hosts[2])
    const [first, second, third, fourth] = f.occurrences
    const initialPin = required(first)
    const meetReady = required(second)
    const meetFailed = required(third)
    // The second host is also a guest on this series, with the same verified mailbox.
    await db
      .updateTable('booking_attendees')
      .set({ email: partialHost.email })
      .where(
        'booking_id',
        'in',
        f.occurrences.map(({ bookingId }) => bookingId),
      )
      .where('email', '=', required(f.guests[0]).email)
      .execute()
    const calendarFor = async (userId: string) => {
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: userId,
          provider: 'google',
          external_account_id: 'synthetic-calendar-account',
          credentials: Buffer.from('synthetic'),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: connection.id,
          external_id: 'synthetic-primary',
          name: 'Synthetic calendar',
          supports_google_meet: true,
          access_role: 'owner',
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { calendarId: calendar.id, connectionId: connection.id }
    }
    const everyHostCalendar = await calendarFor(allHost.id)
    const partialHostCalendar = await calendarFor(partialHost.id)
    const meetCalendar = await calendarFor(meetHost.id)
    const pin = (root: CalendarOccurrence, hostId: string, calendarId: string) =>
      db
        .insertInto('booking_calendar_targets')
        .values({ root_booking_id: root.bookingId, user_id: hostId, calendar_id: calendarId })
        .execute()
    for (const occurrence of f.occurrences)
      await pin(occurrence, allHost.id, everyHostCalendar.calendarId)
    await pin(initialPin, partialHost.id, partialHostCalendar.calendarId)

    for (const [occurrence, state] of [
      [meetReady, 'ready'],
      [meetFailed, 'failed'],
      [required(fourth), 'pending'],
    ] as const) {
      await db
        .updateTable('bookings')
        .set({
          location: {
            kind: 'google_meet',
            autoCreate: true,
            ...(state === 'ready' && { url: 'https://meet.google.com/synthetic-ready' }),
          },
        })
        .where('id', '=', occurrence.bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: occurrence.bookingId,
          booking_id: occurrence.bookingId,
          organization_id: f.team.id,
          organizer_user_id: meetHost.id,
          calendar_id: meetCalendar.calendarId,
          connection_id: meetCalendar.connectionId,
          state,
          applied_revision: state === 'ready' ? 0 : null,
          external_event_id: state === 'failed' ? null : `synthetic-${state}-event`,
          error_code: state === 'failed' ? 'provider_unavailable' : null,
        })
        .execute()
    }

    const mailTo = (email: string) => required(sent.find(({ to }) => to === email))
    const partialHostMails = () => sent.filter(({ to }) => to === partialHost.email)
    await dispatch()
    expect(sent).toHaveLength(5)
    expectSeriesCalendar(mailTo(allHost.email), [], now(), 'CONFIRMED')
    expect(partialHostMails()).toHaveLength(2)
    for (const message of partialHostMails())
      expectSeriesCalendar(message, f.occurrences.slice(1), now(), 'CONFIRMED')
    const meetEvents = expectSeriesCalendar(
      mailTo(meetHost.email),
      [initialPin, meetFailed],
      now(),
      'CONFIRMED',
    )
    expect(required(meetEvents[1]).getFirstPropertyValue('description')).toContain(
      mailMessage('en', 'series.failed'),
    )
    const bookerEvents = expectSeriesCalendar(
      mailTo(booker.email),
      f.occurrences,
      now(),
      'CONFIRMED',
    )
    const pendingEntry = required(bookerEvents[3])
    expect(pendingEntry.getFirstPropertyValue('description')).toBe(
      mailMessage('en', 'series.pending'),
    )
    expect(pendingEntry.hasProperty('location')).toBe(false)

    // Removing a calendar cannot make a never-delivered entry eligible for cancellation.
    // A newly pinned copy must also be excluded, even if that entry was delivered by mail.
    await db
      .deleteFrom('booking_calendar_targets')
      .where('root_booking_id', '=', initialPin.bookingId)
      .where('user_id', '=', partialHost.id)
      .execute()
    await pin(meetReady, partialHost.id, partialHostCalendar.calendarId)
    clock = now().add({ minutes: 1 })
    await cancelManagedBookingSeries(context(), f.token, all())
    // A no-op provider cancellation can settle as ready even when no event ever existed.
    await db
      .updateTable('booking_conferences')
      .set((eb) => ({ state: 'ready', applied_revision: eb.ref('revision'), error_code: null }))
      .where('root_booking_id', '=', meetFailed.bookingId)
      .execute()
    sent.length = 0
    await dispatch()
    expect(sent).toHaveLength(5)
    expectSeriesCalendar(mailTo(allHost.email), [], now(), 'CANCELLED')
    expect(partialHostMails()).toHaveLength(2)
    for (const message of partialHostMails())
      expectSeriesCalendar(message, f.occurrences.slice(2), now(), 'CANCELLED')
    expectSeriesCalendar(mailTo(meetHost.email), [initialPin, meetFailed], now(), 'CANCELLED')
    expectSeriesCalendar(mailTo(booker.email), f.occurrences, now(), 'CANCELLED')
  })

  it('keeps the original fallback organizer when a sender is configured before cancellation', async () => {
    const f = await seriesFixture(2, 1, 2)
    const mailerWithoutSender = { send: mailer.send }
    const fallbackEmail = 'calendar@hourmere.invalid'
    await dispatch({ mailer: mailerWithoutSender })
    expect(sent).toHaveLength(4)
    const organizers = new Map(
      sent.map((message) => [
        message.to,
        expectSeriesCalendar(message, f.occurrences, now(), 'CONFIRMED', fallbackEmail).map(
          (event) => event.getFirstProperty('organizer')?.toJSON(),
        ),
      ]),
    )

    await cancelManagedBookingSeries(context(), f.token, all())
    sent.length = 0
    await dispatch()
    expect(sent).toHaveLength(4)
    for (const message of sent) {
      const events = expectSeriesCalendar(message, f.occurrences, now(), 'CANCELLED', fallbackEmail)
      expect(events.map((event) => event.getFirstProperty('organizer')?.toJSON())).toEqual(
        organizers.get(message.to),
      )
    }
  })

  it('cancels only delivered entries per recipient, including an ordinary move at depth two', async () => {
    const f = await seriesFixture(3, 1)
    const first = required(f.occurrences[0])
    const guest = required(f.guests[0])
    const selector = { seriesManageToken: f.token, ordinal: 1, expectedRevision: '1' }
    await rescheduleManagedBooking(context(), selector, {
      start: Temporal.Instant.from(first.start).add({ hours: 2 }),
    })
    refuseAddress = guest.email
    await dispatch()
    expect(sent).toHaveLength(2)
    for (const message of sent) {
      expectSeriesCalendar(message, f.occurrences.slice(1), now(), 'CONFIRMED')
    }
    expect(attempts.some(({ to }) => to === guest.email)).toBe(true)

    refuseAddress = undefined
    sent.length = 0
    clock = now().add({ seconds: 10 })
    const moved = await rescheduleManagedBooking(
      context(),
      { ...selector, expectedRevision: '2' },
      { start: Temporal.Instant.from(first.start).add({ hours: 3 }) },
    )
    const movedOccurrence = {
      bookingId: first.bookingId,
      start: moved.booking.start,
      end: moved.booking.end,
      depth: 2,
    }
    await runBookingMail([moved.booking.id], 'rescheduled')
    expect(sent).toHaveLength(3)
    for (const message of sent) {
      const { calendar, events } = parseCalendar(message)
      expect(calendar.getFirstPropertyValue('method')).toBe('REQUEST')
      expectCalendarEvents(events, [movedOccurrence], now(), 'CONFIRMED')
    }

    // Bulk cancel before the refused confirmation can retry. The guest gets only the
    // moved entry in the attachment, while the body still lists every cancelled date.
    clock = now().add({ seconds: 10 })
    await cancelManagedBookingSeries(context(), f.token, { ...all(), expectedRevision: '3' })
    sent.length = 0
    await dispatch()
    expect(sent).toHaveLength(3)
    const allCancelled = [movedOccurrence, ...f.occurrences.slice(1)]
    for (const message of sent) {
      const isGuest = message.to === guest.email
      expectSeriesCalendar(message, isGuest ? [movedOccurrence] : allCancelled, now(), 'CANCELLED')
      for (const { start, end } of allCancelled) {
        expect(message.text).toContain(
          formatMeetingTime(
            Temporal.Instant.from(start),
            Temporal.Instant.from(end),
            timeZone,
            'en',
          ),
        )
      }
    }
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
    const seriesConfirmation = required(sent.slice(2).find(({ to }) => to === booker.email))
    expectSeriesCalendar(seriesConfirmation, f.occurrences, now(), 'CONFIRMED')
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
        const inviteeMail = required(messages.find(({ to }) => to === booker.email))
        expect(inviteeMail.text.includes('/booking#token=')).toBe(kind !== 'cancelled')
        if (id === moved.booking.id && kind === 'rescheduled') {
          const { calendar, events } = parseCalendar(inviteeMail)
          expect(calendar.getFirstPropertyValue('method')).toBe('REQUEST')
          expectCalendarEvents(
            events,
            [
              {
                bookingId: first.bookingId,
                start: moved.booking.start,
                end: moved.booking.end,
                depth: 1,
              },
            ],
            now(),
            'CONFIRMED',
          )
        }
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
