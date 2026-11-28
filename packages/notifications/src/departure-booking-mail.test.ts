import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createLogMailer, type MailMessage } from '@hourmere/mail'
import { applyDepartureHandoff } from '@hourmere/scheduling/departure-handoff-admin'
import { createFixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createHandoffTestFixture,
  HANDOFF_END,
  HANDOFF_NOW,
  HANDOFF_START,
  handoffTestRecords,
} from '../../scheduling/src/departure-handoff-apply-test-fixture.ts'
import { bookingNotificationJob, bookingNotifier } from './index.ts'

const databaseUrl = process.env.DATABASE_URL
const now = () => HANDOFF_NOW.subtract({ hours: 1 })
const oldSender = 'original-calendar@example.test'
const newSender = 'replacement-calendar@example.test'
const attendees = ['booker@example.test', 'guest@example.test']
const teamsMailStates = {
  join_url_pending: {
    writeback: { status: 'retrying', teamsStatus: 'join_url_pending' },
    source: 'The Teams link for the original booking was still pending at cancellation.',
    replacement: 'The Teams link will appear in the booking details when it’s ready.',
  },
  teams_unavailable: {
    writeback: { status: 'succeeded', teamsStatus: 'teams_unavailable' },
    source: 'Teams was unavailable for the original booking.',
    replacement:
      'Microsoft Teams is unavailable. This booking falls back to the Outlook calendar event.',
  },
  writeback_failed: {
    writeback: { status: 'failed', teamsStatus: 'join_url_pending' },
    source: 'The Teams link for the original booking could not be added to the calendar.',
    replacement: 'The Teams link is unavailable. This booking is still scheduled.',
  },
} as const

function calendar(message: MailMessage) {
  const attachment = message.attachments?.find(({ filename }) => filename.endsWith('.ics'))
  expect(attachment).toBeDefined()
  const content = attachment?.content ?? ''
  expect(content).toMatch(/\r\n$/)
  expect(content.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
  for (const line of content.split('\r\n'))
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
  const ical = new ICAL.Component(ICAL.parse(content))
  const method = ical.getFirstPropertyValue('method')
  expect(attachment?.contentType).toContain(`method=${method};`)
  expect(ical.getAllSubcomponents('vevent')).toHaveLength(1)
  const event = ical.getFirstSubcomponent('vevent')
  const organizer = event?.getFirstProperty('organizer')
  return {
    method,
    uid: event?.getFirstPropertyValue('uid'),
    sequence: event?.getFirstPropertyValue('sequence'),
    organizer: organizer?.getFirstValue(),
    sentBy: organizer?.getParameter('sent-by') ?? null,
    start: event?.getFirstPropertyValue('dtstart')?.toString(),
    end: event?.getFirstPropertyValue('dtend')?.toString(),
  }
}

interface QueuedMail {
  id: string
  data: { bookingId: string; kind: string; handoff?: string }
  singleton_key: string
}

describe.skipIf(!databaseUrl)('departure handoff booking mail in PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let stopJobs: (() => Promise<void>) | undefined
  let enqueue: ReturnType<typeof bookingNotifier>

  function mail(senderEmail: string) {
    const sent: MailMessage[] = []
    const job = bookingNotificationJob({
      db,
      now,
      publicUrl: 'https://hourmere.example.test',
      secret: 'synthetic-notification-secret',
      mailer: {
        senderEmail,
        async send(message) {
          sent.push(message)
        },
      },
    })
    return {
      job,
      sent,
      run: async (data: unknown, id: string = crypto.randomUUID()) =>
        job.handler(job.payload.parse(data), {
          id,
          attempt: 1,
          signal: new AbortController().signal,
        }),
    }
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'handoff_mail',
    })
    owned.pool.options.max = 6
    db = createDb(owned.pool)
    // Queue through pg-boss in the real booking transaction, then choose delivery order explicitly.
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [mail(newSender).job],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    stopJobs = () => jobs.stop()
    await jobs.start()
    enqueue = bookingNotifier(jobs)
  })

  afterEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
  })

  afterAll(async () => {
    try {
      await stopJobs?.()
    } finally {
      await owned?.drop()
    }
  })

  async function setup(options: Parameters<typeof createHandoffTestFixture>[1] = {}) {
    const notify = vi.fn(enqueue)
    const fixture = await createHandoffTestFixture(db, {
      ...options,
      now,
      sourceContext: { ...options.sourceContext, notify },
      applyContext: { ...options.applyContext, notify },
    })
    const records = handoffTestRecords(db)
    return {
      ...fixture,
      notify,
      approve: () =>
        records.offer(fixture.ctx, fixture.input, { departingUserId: fixture.departing.id }),
      apply: () => applyDepartureHandoff(fixture.ctx, fixture.input, records.store),
    }
  }

  async function queued(...bookingIds: string[]) {
    const { rows } = await owned.pool.query<QueuedMail>(
      `SELECT id, data, singleton_key FROM pgboss.job
       WHERE name = 'booking-notification' AND data->>'bookingId' = ANY($1::text[])
       ORDER BY id`,
      [bookingIds],
    )
    return rows
  }

  function requireJob(jobs: QueuedMail[], bookingId: string, kind: string) {
    const job = jobs.find(({ data }) => data.bookingId === bookingId && data.kind === kind)
    if (!job) throw new Error(`Missing queued ${kind} mail`)
    return job
  }

  function organizerPin(id: string) {
    return db
      .selectFrom('bookings')
      .select(['ical_organizer_email', 'ical_organizer_name'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function enableTeamsCalendar(userId: string) {
    const { calendarId } = await createFixtures(db).calendarBusy(userId, [], {
      checkConflicts: false,
    })
    const { connection_id } = await db
      .updateTable('calendars')
      .set({ access_role: 'owner' })
      .where('id', '=', calendarId)
      .returning('connection_id')
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active', scopes: ['Calendars.ReadWrite'] })
      .where('id', '=', connection_id)
      .execute()
    await db
      .insertInto('profiles')
      .values({
        user_id: userId,
        handle: `teams-${userId.slice(0, 8)}-${userId.slice(-12)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendarId,
      })
      .execute()
  }

  async function teamsWriteback(
    bookingId: string,
    userId: string,
    state: keyof typeof teamsMailStates,
  ) {
    const { destination_calendar_id } = await db
      .selectFrom('profiles')
      .select('destination_calendar_id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow()
    if (!destination_calendar_id) throw new Error('Missing Teams calendar destination')
    const microsoft_writeback = JSON.stringify({
      ...teamsMailStates[state].writeback,
      attempts: 1,
      teamsJoinUrl: 'https://teams.microsoft.com/l/meetup-join/stale-link/0',
    })
    await db
      .insertInto('booking_calendar_targets')
      .values({
        root_booking_id: bookingId,
        user_id: userId,
        calendar_id: destination_calendar_id,
        microsoft_writeback,
      })
      .onConflict((oc) =>
        oc.columns(['root_booking_id', 'user_id']).doUpdateSet({ microsoft_writeback }),
      )
      .execute()
  }

  it.each([true, false])(
    'preserves both calendar identities (cancellation first: %s)',
    async (cancelFirst) => {
      const fixture = await setup()
      const sourceId = fixture.booking.id
      const sourceRootId = await createFixtures(db).booking(
        fixture.team.id,
        [fixture.departing.id],
        HANDOFF_START.subtract({ hours: 1 }).toString(),
        HANDOFF_END.subtract({ hours: 1 }).toString(),
        { status: 'cancelled', eventTypeId: fixture.eventTypeId, attendee: null },
      )
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: sourceRootId })
        .where('id', '=', sourceId)
        .execute()
      const previous = mail(oldSender)
      await previous.run({ bookingId: sourceId, kind: 'rescheduled' })
      const oldInvite = previous.sent.find(({ to }) => to === attendees[0])
      if (!oldInvite) throw new Error('Missing historical invitation')
      expect(calendar(oldInvite)).toMatchObject({
        method: 'REQUEST',
        uid: `${sourceRootId}@hourmere`,
        sequence: 1,
        organizer: `mailto:${oldSender}`,
      })
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', fixture.team.id)
        .where('userId', '=', fixture.departing.id)
        .execute()
      await fixture.approve()
      fixture.notify.mockClear()
      const receipt = await fixture.apply()
      const replacementId = receipt.replacementBookingId
      const jobs = await queued(sourceId, replacementId)
      const cancellation = requireJob(jobs, sourceId, 'cancelled')
      const confirmation = requireJob(jobs, replacementId, 'confirmed')
      expect(cancellation).toMatchObject({
        singleton_key: `${sourceId}:cancelled`,
        data: { bookingId: sourceId, kind: 'cancelled', handoff: 'source' },
      })
      expect(confirmation).toMatchObject({
        singleton_key: `${replacementId}:confirmed`,
        data: { bookingId: replacementId, kind: 'confirmed', handoff: 'replacement' },
      })
      expect(requireJob(jobs, replacementId, 'reminder').data).toEqual({
        bookingId: replacementId,
        kind: 'reminder',
      })
      const worker = mail(newSender)
      const obsoleteReminder = requireJob(jobs, sourceId, 'reminder')
      const obsoleteConfirmation = requireJob(jobs, sourceId, 'confirmed')
      await worker.run(obsoleteReminder.data, obsoleteReminder.id)
      await worker.run(obsoleteConfirmation.data, obsoleteConfirmation.id)
      expect(worker.sent).toEqual([])

      const deliveryOrder = cancelFirst
        ? [cancellation, confirmation]
        : [confirmation, cancellation]
      for (const job of deliveryOrder) await worker.run(job.data, job.id)
      expect(worker.sent.map(({ to }) => to).sort()).toEqual(
        [...attendees, ...attendees, fixture.candidate.email].sort(),
      )
      for (const message of worker.sent) expect(message.sensitive).toBe(true)
      for (const recipient of attendees) {
        const messages = worker.sent.filter(({ to }) => to === recipient)
        const [cancellationMail, confirmationMail] = cancelFirst
          ? messages
          : [...messages].reverse()
        if (!cancellationMail || !confirmationMail) throw new Error('Missing handoff mail')
        expect(cancellationMail.subject).toMatch(/^Host changed · /)
        expect(confirmationMail.subject).toMatch(/^Host changed · /)
        expect(cancellationMail.text).toContain('The original booking was cancelled.')
        expect(confirmationMail.text).toContain('This booking replaces the original booking.')
        expect(cancellationMail.text).not.toContain('#token=')
        expect(confirmationMail.text.includes('#token=')).toBe(recipient === attendees[0])

        const cancelled = calendar(cancellationMail)
        const confirmed = calendar(confirmationMail)
        expect(cancelled.uid).toBe(`${sourceRootId}@hourmere`)
        expect(confirmed.uid).toBe(`${replacementId}@hourmere`)
        expect(confirmed.uid).not.toBe(cancelled.uid)
        expect([
          { ...cancelled, uid: 'OLD-ROOT@hourmere' },
          { ...confirmed, uid: 'REPLACEMENT-ROOT@hourmere' },
        ]).toMatchInlineSnapshot(`
        [
          {
            "end": "2026-11-02T17:30:00Z",
            "method": "CANCEL",
            "organizer": "mailto:original-calendar@example.test",
            "sentBy": "mailto:replacement-calendar@example.test",
            "sequence": 2,
            "start": "2026-11-02T17:00:00Z",
            "uid": "OLD-ROOT@hourmere",
          },
          {
            "end": "2026-11-02T17:30:00Z",
            "method": "REQUEST",
            "organizer": "mailto:replacement-calendar@example.test",
            "sentBy": null,
            "sequence": 0,
            "start": "2026-11-02T17:00:00Z",
            "uid": "REPLACEMENT-ROOT@hourmere",
          },
        ]
      `)
      }
      expect(await organizerPin(sourceRootId)).toMatchObject({ ical_organizer_email: oldSender })
      expect(await organizerPin(replacementId)).toMatchObject({ ical_organizer_email: newSender })

      expect(fixture.notify).toHaveBeenCalledTimes(2)
      expect(await fixture.apply()).toEqual(receipt)
      expect(fixture.notify).toHaveBeenCalledTimes(2)
      expect(await queued(sourceId, replacementId)).toEqual(jobs)
      await Promise.all(deliveryOrder.map((job) => worker.run(job.data, job.id)))
      expect(worker.sent).toHaveLength(5)
      const recipientReceipts = await db
        .selectFrom('booking_notifications')
        .select(['booking_id', 'kind', 'outcome'])
        .where('booking_id', 'in', [sourceId, replacementId])
        .where('recipient', 'like', 'attendee:%')
        .where('kind', 'in', ['cancelled', 'confirmed'])
        .orderBy('kind')
        .execute()
      expect(recipientReceipts).toEqual([
        ...Array.from({ length: 2 }, () => ({
          booking_id: sourceId,
          kind: 'cancelled',
          outcome: 'sent',
        })),
        ...Array.from({ length: 2 }, () => ({
          booking_id: replacementId,
          kind: 'confirmed',
          outcome: 'sent',
        })),
      ])
    },
  )

  it('sends a plain-text cancellation and leaves the old organizer unset when history is missing', async () => {
    const fixture = await setup()
    const sourceId = fixture.booking.id
    await fixture.approve()
    const { replacementBookingId } = await fixture.apply()
    const jobs = await queued(sourceId, replacementBookingId)
    const cancellation = requireJob(jobs, sourceId, 'cancelled')
    const confirmation = requireJob(jobs, replacementBookingId, 'confirmed')
    const print = vi.fn()
    const sink = bookingNotificationJob({
      db,
      now,
      publicUrl: 'https://hourmere.example.test',
      secret: 'synthetic-notification-secret',
      mailer: createLogMailer(print),
    })
    for (const job of [cancellation, confirmation]) {
      await sink.handler(sink.payload.parse(job.data), {
        id: job.id,
        attempt: 1,
        signal: new AbortController().signal,
      })
    }
    expect(print).not.toHaveBeenCalled()
    expect(await organizerPin(replacementBookingId)).toMatchObject({ ical_organizer_email: null })
    const worker = mail(newSender)
    await worker.run(cancellation.data, cancellation.id)
    expect(worker.sent.map(({ to }) => to)).toEqual([fixture.departing.email, ...attendees])
    for (const message of worker.sent) {
      expect(message.sensitive).toBe(true)
      expect(message.subject).toMatch(/^Host changed · /)
      expect(message.text).toContain('The original booking was cancelled.')
      expect(message.attachments).toBeUndefined()
      expect(message.html).toBeUndefined()
    }
    expect(await organizerPin(sourceId)).toEqual({
      ical_organizer_email: null,
      ical_organizer_name: null,
    })
    worker.sent.length = 0
    // A provider can release confirmation later, with only the booking ID and kind.
    await worker.run({ bookingId: replacementBookingId, kind: 'confirmed' })
    for (const message of worker.sent) expect(message.sensitive).toBe(true)
    const replacement = worker.sent.find(({ to }) => to === attendees[0])
    if (!replacement) throw new Error('Missing replacement invitation')
    expect(replacement.subject).toMatch(/^Host changed · /)
    expect(calendar(replacement)).toMatchObject({
      method: 'REQUEST',
      uid: `${replacementBookingId}@hourmere`,
      sequence: 0,
      organizer: `mailto:${newSender}`,
    })
  })

  it.each([
    ['join_url_pending', 'teams_unavailable'],
    ['teams_unavailable', 'writeback_failed'],
    ['writeback_failed', 'join_url_pending'],
  ] as const)(
    'projects each chain’s Teams status (%s, %s) without a stale join link',
    async (sourceState, replacementState) => {
      const fixture = await setup({
        sourceContext: { microsoftCalendarEnabled: true },
        applyContext: { microsoftCalendarEnabled: true },
        async configureSource({ eventTypeId, departing }) {
          await db
            .updateTable('event_types')
            .set({ locations: JSON.stringify([{ id: 'teams', kind: 'microsoft_teams' }]) })
            .where('id', '=', eventTypeId)
            .execute()
          await enableTeamsCalendar(departing.id)
        },
        async configureTarget({ candidate }) {
          await enableTeamsCalendar(candidate.id)
        },
      })
      const sourceId = fixture.booking.id
      await teamsWriteback(sourceId, fixture.departing.id, sourceState)
      await fixture.approve()
      const { replacementBookingId } = await fixture.apply()
      await teamsWriteback(replacementBookingId, fixture.candidate.id, replacementState)
      const jobs = await queued(sourceId, replacementBookingId)
      const worker = mail(newSender)
      const cancellation = requireJob(jobs, sourceId, 'cancelled')
      const confirmation = requireJob(jobs, replacementBookingId, 'confirmed')
      await worker.run(cancellation.data, cancellation.id)
      await worker.run(confirmation.data, confirmation.id)
      for (const message of worker.sent) expect(message.sensitive).toBe(true)
      for (const attendee of attendees) {
        const notices = worker.sent.filter(({ to }) => to === attendee)
        expect(notices).toHaveLength(2)
        expect(notices[0]?.text).toContain(teamsMailStates[sourceState].source)
        expect(notices[1]?.text).toContain(teamsMailStates[replacementState].replacement)
        expect(notices[0]?.text).not.toContain(teamsMailStates[replacementState].replacement)
        expect(notices[1]?.text).not.toContain(teamsMailStates[sourceState].source)
        expect(JSON.stringify(notices)).not.toContain('stale-link')
      }
    },
  )
})
