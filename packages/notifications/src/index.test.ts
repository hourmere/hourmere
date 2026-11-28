// Booking notifications against a throwaway database, with bookings made by the real booking
// services: who gets which email, once, and only while it is still true.
import { createHash } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { type Mailer, type MailMessage, type MailRefusal, MailRejectedError } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  getManagedBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotificationJob,
  enqueueBookingNotifications,
  type NotificationDeps,
  NotificationRetryError,
  sendBookingNotification,
} from './index.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (iso: string) => Temporal.Instant.from(iso)
// Sunday; the host's Berlin schedule offers Monday and Tuesday 09:00–17:00 (08:00Z–16:00Z).
const NOW = instant('2026-11-01T12:00:00Z')
const START = '2026-11-03T09:00:00Z'
const PUBLIC_URL = 'https://cal.example.com'

// Refusals as the SMTP mailer reports them.
const NO_SUCH_USER: MailRefusal = { responseCode: 550, enhancedCode: '5.1.1', atRecipient: true }
const GREYLISTED: MailRefusal = { responseCode: 450, enhancedCode: '4.2.0', atRecipient: true }
const RELAY_DENIED: MailRefusal = { responseCode: 554, enhancedCode: '5.7.1', atRecipient: true }
const DAILY_LIMIT: MailRefusal = { responseCode: 550, enhancedCode: '5.4.5', atRecipient: false }

/**
 * Records what it sends. `hold` makes sends wait (until the signal aborts), `failFor` makes
 * sends to an address fail like an unreachable server, `refuse` like a server refusing it,
 * and `during` runs inside each send.
 */
function testMailer() {
  const sent: MailMessage[] = []
  const state: {
    failFor?: string
    refuse: Map<string, MailRefusal>
    hold?: Promise<void>
    started?: () => void
    during?: (message: MailMessage) => Promise<void> | void
    aborted: number
  } = { refuse: new Map(), aborted: 0 }
  const mailer: Mailer = {
    async send(message, { signal } = {}) {
      state.started?.()
      await state.during?.(message)
      if (state.hold) {
        await new Promise<void>((resolve, reject) => {
          state.hold?.then(resolve)
          signal?.addEventListener('abort', () => {
            state.aborted++
            reject(signal.reason)
          })
        })
      }
      if (message.to === state.failFor) throw new Error(`mailbox ${message.to} unavailable`)
      const refusal = state.refuse.get(message.to)
      if (refusal) throw new MailRejectedError(refusal)
      sent.push(message)
    },
  }
  return { mailer, sent, state }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest()
const tokenIn = (message: MailMessage | undefined) =>
  message?.text.match(/#token=([A-Za-z0-9_-]+)&action=reschedule/)?.[1]
const to = (address: string) => (m: MailMessage) => m.to === address

function invitation(message: MailMessage | undefined) {
  const content = message?.attachments?.[0]?.content
  if (!content) return undefined
  const calendar = new ICAL.Component(ICAL.parse(content))
  const event = calendar.getFirstSubcomponent('vevent')
  return {
    method: calendar.getFirstPropertyValue('method'),
    uid: event?.getFirstPropertyValue('uid'),
    sequence: event?.getFirstPropertyValue('sequence'),
    summary: event?.getFirstPropertyValue('summary'),
    location: event?.getFirstPropertyValue('location'),
    description: event?.getFirstPropertyValue('description'),
    organizerName: event?.getFirstProperty('organizer')?.getParameter('cn'),
  }
}

describe.skipIf(!serverUrl)('booking notifications', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await testDb?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
  })

  const mixedOptions = ['الخطة (Pro)', '中文', 'עברית (Team)']
  const mixedBooking = {
    host: 'נועה (Noa) [42]',
    invitee: 'ليلى (Layla)',
    guest: 'יעל (Yael)',
    event: '📅 12 مراجعة (Review) & צוות',
    location: 'شارع النور (Oak St), Room 12',
    question: 'מה הנושא? (Topic)',
    answer: 'راسلني <ada@example.com>\nراجع https://docs.example.test/brief?tab=2&mode=review',
  }

  /** A Berlin-scheduled host in New York with one event type, booked from Tokyo. */
  async function booked(
    options: {
      guests?: boolean
      now?: Temporal.Instant
      start?: Temporal.Instant
      mixedContent?: boolean
    } = {},
  ) {
    const host = await f.host({
      name: options.mixedContent ? mixedBooking.host : 'Grace Hopper',
      timeZone: 'America/New_York',
    })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      // These scenarios exercise a host that explicitly enabled guests.
      allowGuests: true,
      title: options.mixedContent ? mixedBooking.event : 'Intro call',
      location: options.mixedContent
        ? { kind: 'in_person', address: mixedBooking.location }
        : { kind: 'link', url: 'https://meet.example.com/abc' },
      questions: [
        {
          id: 'topic',
          label: options.mixedContent ? mixedBooking.question : 'What should we talk about?',
          type: 'long_text',
          required: false,
        },
        ...(options.mixedContent
          ? [
              {
                id: 'plans',
                label: 'Plans',
                type: 'multi_select',
                required: false,
                options: mixedOptions,
              },
            ]
          : []),
      ],
    })
    const result = await createPublicBooking(
      { ...ctx, now: () => options.now ?? NOW },
      {
        handle: host.handle,
        slug: 'intro',
        start: options.start ?? instant(START),
        invitee: {
          name: options.mixedContent ? mixedBooking.invitee : 'Ada Lovelace',
          email: 'ada@example.com',
          timeZone: 'Asia/Tokyo',
        },
        guests: options.guests
          ? [
              {
                name: options.mixedContent ? mixedBooking.guest : 'Charles Babbage',
                email: 'charles@example.com',
              },
            ]
          : [],
        responses: {
          topic: options.mixedContent ? mixedBooking.answer : 'Engines,\nanalytical ones.',
          ...(options.mixedContent && { plans: mixedOptions }),
        },
      },
    )
    const hostEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
    ).email
    return {
      bookingId: result.booking.id,
      apiToken: result.manageToken as string,
      hostId: host.userId,
      organizationId: host.organizationId,
      hostEmail,
    }
  }

  const deps = (mailer: Mailer, now = NOW): NotificationDeps => ({
    db,
    mailer,
    publicUrl: PUBLIC_URL,
    secret: 'synthetic-notification-secret',
    now: () => now,
    log: () => {},
  })

  const records = (bookingId: string) =>
    db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('recipient')
      .execute()

  it('keeps pending and ready Teams notices private through reschedule and cancellation', async () => {
    const { bookingId, apiToken, hostId, hostEmail } = await booked({ guests: true })
    const url = 'https://teams.microsoft.com/l/meetup-join/synthetic-booking/0?context=abc'
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'microsoft_teams' }) })
      .where('id', '=', bookingId)
      .execute()
    const { calendarId } = await f.calendarBusy(hostId, [], { checkConflicts: false, now: NOW })
    await db
      .insertInto('booking_calendar_targets')
      .values({
        root_booking_id: bookingId,
        user_id: hostId,
        calendar_id: calendarId,
        microsoft_writeback: JSON.stringify({
          status: 'retrying',
          attempts: 1,
          updatedAt: NOW.toString(),
          teamsStatus: 'join_url_pending',
        }),
      })
      .execute()

    const { mailer, sent } = testMailer()
    const config = deps(mailer)
    await sendBookingNotification(config, bookingId, 'confirmed')
    expect(sent.map((message) => message.to)).toEqual([
      hostEmail,
      'ada@example.com',
      'charles@example.com',
    ])
    const pending = 'The Teams link will appear in the booking details when it’s ready.'
    const bookerEmail = sent.find(to('ada@example.com'))
    const token = tokenIn(bookerEmail)
    expect(token).toBeTruthy()
    expect(bookerEmail?.html).toContain(`href="${PUBLIC_URL}/booking#token=${token}"`)
    expect(sent.find(to('charles@example.com'))?.html).not.toContain('/booking#token=')
    for (const message of sent.filter((m) => m.to !== 'charles@example.com')) {
      expect(message.text).toContain(pending)
      expect(message.html).toContain(pending)
      expect(invitation(message)).toMatchObject({
        method: 'REQUEST',
        uid: `${bookingId}@hourmere`,
        sequence: 0,
        location: 'Microsoft Teams',
        description: expect.stringContaining(pending),
      })
    }
    expect(JSON.stringify(sent)).not.toContain(url)
    sent.length = 0

    await db
      .updateTable('booking_calendar_targets')
      .set({
        microsoft_writeback: JSON.stringify({
          status: 'succeeded',
          attempts: 2,
          updatedAt: NOW.toString(),
          teamsStatus: 'ready',
          teamsJoinUrl: url,
        }),
      })
      .where('root_booking_id', '=', bookingId)
      .execute()
    const moved = await rescheduleManagedBooking(ctx, apiToken, {
      start: instant('2026-11-03T13:00:00Z'),
    })
    const assertLocation = (method: 'REQUEST' | 'CANCEL', sequence: number) => {
      expect(sent.map((message) => message.to)).toEqual([
        hostEmail,
        'ada@example.com',
        'charles@example.com',
      ])
      for (const message of sent) {
        expect(message.sensitive).toBe(true)
        expect(message.text).toContain('Microsoft Teams')
        const calendar = invitation(message)
        expect(calendar).toMatchObject({ method, uid: `${bookingId}@hourmere`, sequence })
        if (method === 'CANCEL' || message.to === 'charles@example.com') {
          expect(message.text).not.toContain(url)
          expect(message.html).not.toContain(url)
          expect(calendar?.location).toBe('Microsoft Teams')
          expect(calendar?.description ?? '').not.toContain(url)
          continue
        }
        expect(message.text).toContain(url)
        expect(message.html).toContain(url)
        expect(calendar).toMatchObject({
          location: url,
          description: expect.stringContaining(url),
        })
      }
      sent.length = 0
    }
    await sendBookingNotification(config, moved.booking.id, 'rescheduled')
    assertLocation('REQUEST', 1)
    await sendBookingNotification(config, moved.booking.id, 'rescheduled')
    expect(sent).toHaveLength(0)

    await cancelManagedBooking(ctx, moved.manageToken as string, {})
    await sendBookingNotification(config, moved.booking.id, 'cancelled')
    assertLocation('CANCEL', 2)
    await sendBookingNotification(config, moved.booking.id, 'cancelled')
    expect(sent).toHaveLength(0)
  })

  it('ignores a ready Teams writeback target whose owner is not a booking host', async () => {
    const { bookingId, apiToken, hostId } = await booked()
    const { userId: otherId } = await f.host()
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'microsoft_teams' }) })
      .where('id', '=', bookingId)
      .execute()
    const target = async (userId: string, url: string) => {
      const { calendarId } = await f.calendarBusy(userId, [], { checkConflicts: false, now: NOW })
      await db
        .insertInto('booking_calendar_targets')
        .values({
          root_booking_id: bookingId,
          user_id: userId,
          calendar_id: calendarId,
          microsoft_writeback: JSON.stringify({
            status: 'succeeded',
            teamsStatus: 'ready',
            teamsJoinUrl: url,
            attempts: 1,
          }),
        })
        .execute()
    }
    await target(otherId, 'https://teams.microsoft.com/l/meetup-join/stale-target/0')
    const stale = await getManagedBooking(ctx, apiToken)
    expect(stale.location).toEqual({ kind: 'microsoft_teams', status: 'join_url_pending' })

    const url = 'https://teams.microsoft.com/l/meetup-join/current-host/0'
    await target(hostId, url)
    const current = await getManagedBooking(ctx, apiToken)
    expect(current.location).toEqual({ kind: 'microsoft_teams', status: 'ready', url })
  })

  it.each([
    ['retrying', 'teams_unavailable', 'join_url_pending'],
    ['succeeded', 'teams_unavailable', 'teams_unavailable'],
    ['failed', 'teams_unavailable', 'writeback_failed'],
    ['failed', 'join_url_pending', 'writeback_failed'],
  ])('projects Teams writeback %s with %s as %s', async (status, teamsStatus, expected) => {
    const { bookingId, apiToken, hostId } = await booked()
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'microsoft_teams' }) })
      .where('id', '=', bookingId)
      .execute()
    const { calendarId } = await f.calendarBusy(hostId, [], { checkConflicts: false, now: NOW })
    await db
      .insertInto('booking_calendar_targets')
      .values({
        root_booking_id: bookingId,
        user_id: hostId,
        calendar_id: calendarId,
        microsoft_writeback: JSON.stringify({ status, teamsStatus, attempts: 1 }),
      })
      .execute()

    const booking = await getManagedBooking(ctx, apiToken)
    expect(booking.location).toEqual({ kind: 'microsoft_teams', status: expected })
  })

  it.each([
    {
      id: 'call',
      option: { id: 'call', kind: 'phone', askInvitee: true },
      phone: '+14155550123',
      expected: '+14155550123',
    },
    {
      id: 'host-call',
      option: { id: 'host-call', kind: 'phone', number: '+14155550987' },
      phone: undefined,
      expected: '+14155550987',
    },
    {
      id: 'office',
      option: { id: 'office', kind: 'in_person', address: '100 Example Street' },
      phone: undefined,
      expected: '100 Example Street',
    },
    {
      id: 'link',
      option: { id: 'link', kind: 'link', url: 'https://meeting.example.test/chosen' },
      phone: undefined,
      expected: 'https://meeting.example.test/chosen',
    },
  ])(
    'keeps the chosen $id in host/invitee email and ICS after configuration edits and rescheduling',
    async ({ id, option, phone, expected }) => {
      const host = await f.host({ name: 'Location host' })
      await f.schedule(host.userId)
      const event = await f.eventType(host.organizationId, host.userId, {
        slug: 'choice',
        allowGuests: true,
      })
      await db
        .updateTable('event_types')
        .set({ locations: JSON.stringify([{ id: 'default', kind: 'google_meet' }, option]) })
        .where('id', '=', event)
        .execute()
      const created = await createPublicBooking(ctx, {
        handle: host.handle,
        slug: 'choice',
        start: instant(START),
        invitee: {
          name: 'Location invitee',
          email: 'location-invitee@example.com',
          timeZone: 'UTC',
        },
        guests: [
          { name: 'Guest one', email: 'guest-one@example.com' },
          { name: 'Guest two', email: 'guest-two@example.com' },
        ],
        locationOptionId: id,
        ...(phone ? { inviteePhone: phone } : {}),
      })
      await db
        .updateTable('event_types')
        .set({
          locations: JSON.stringify([
            { id: 'replacement', kind: 'phone', number: '+442079460123' },
          ]),
        })
        .where('id', '=', event)
        .execute()
      const { mailer, sent } = testMailer()
      const check = (cancelled = false, reminder = false) => {
        expect(sent).toHaveLength(4)
        for (const message of sent) {
          const guest = message.to.startsWith('guest-')
          const invitee = message.to === 'location-invitee@example.com'
          const phoneWording =
            id === 'call'
              ? guest
                ? 'Phone call — the host will call the invitee'
                : invitee
                  ? `Phone call — the host will call you at ${expected}`
                  : `Phone call — call the invitee at ${expected}`
              : id === 'host-call'
                ? invitee || guest
                  ? `Phone call — call the host at ${expected}`
                  : `Phone call — the invitee will call you at ${expected}`
                : expected
          if (!cancelled || id !== 'link') {
            expect(message.text).toContain(phoneWording)
            expect(message.html).toContain(phoneWording)
          }
          if (reminder) expect(message.attachments).toBeUndefined()
          else expect(invitation(message)?.location).toBe(phoneWording)
          if (id === 'call' && guest) expect(JSON.stringify(message)).not.toContain(expected)
          expect(JSON.stringify(message)).not.toContain('+442079460123')
        }
        sent.length = 0
      }
      await sendBookingNotification(deps(mailer), created.booking.id, 'confirmed')
      check()
      await sendBookingNotification(
        deps(mailer, instant(START).subtract({ hours: 24 })),
        created.booking.id,
        'reminder',
      )
      check(false, true)
      const moved = await rescheduleManagedBooking(ctx, created.manageToken as string, {
        start: instant('2026-11-03T13:00:00Z'),
      })
      await sendBookingNotification(deps(mailer), moved.booking.id, 'rescheduled')
      check()
      await cancelManagedBooking(ctx, moved.manageToken as string, {})
      await sendBookingNotification(deps(mailer), moved.booking.id, 'cancelled')
      check(true)
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'links every host notification to its admin booking in %s without sharing invitee links',
    async (locale) => {
      const { bookingId, apiToken, hostId, hostEmail, organizationId } = await booked({
        guests: true,
      })
      await db
        .updateTable('booking_attendees')
        .set({ time_zone: 'Pacific/Honolulu' })
        .where('booking_id', '=', bookingId)
        .where('is_booker', '=', false)
        .execute()
      await db.updateTable('profiles').set({ locale }).where('user_id', '=', hostId).execute()
      const { mailer, sent } = testMailer()
      const config = {
        ...deps(mailer),
        publicUrl: `${PUBLIC_URL}/ignored?source=fixture#ignored`,
      }
      const check = (id: string, moved = false) => {
        const host = sent.find(to(hostEmail))
        const url = `${PUBLIC_URL}/app/bookings/${id}`
        expect(host).toBeDefined()
        expect(host?.text).not.toContain('organizationId=')
        expect(host?.html).not.toContain('organizationId=')
        expect(host?.text).not.toContain(organizationId)
        expect(host?.html).not.toContain(organizationId)
        expect(host?.html?.includes(`href="${url}"`)).toBe(true)
        expect(host?.text?.includes(url)).toBe(true)
        const inviteeTime =
          locale === 'en'
            ? `Tue, Nov 3, ${moved ? '10' : '6'}:00 PM (Asia/Tokyo, GMT+09:00)`
            : `11月3日周二，${moved ? '22' : '18'}:00（Asia/Tokyo，GMT+09:00）`
        expect(host?.text).toContain(
          `${locale === 'en' ? "Invitee's time: " : '预约人当地时间：'}${inviteeTime}`,
        )
        expect(host?.html).toContain(inviteeTime)
        expect(host?.html).toContain(locale === 'en' ? 'Open in Hourmere' : '在 Hourmere 中打开')
        expect(/token=|\/booking#|source=fixture|#ignored/.test(`${host?.html}${host?.text}`)).toBe(
          false,
        )
        const attendees = sent.filter((message) => message.to !== hostEmail)
        expect(attendees.length).toBeGreaterThan(0)
        expect(attendees.every((message) => !`${message.html}${message.text}`.includes(url))).toBe(
          true,
        )
        sent.length = 0
      }
      for (const kind of ['confirmed', 'reminder'] as const) {
        await sendBookingNotification(config, bookingId, kind)
        check(bookingId)
      }

      // A logistical failure uses the same host destination, without a final invitation.
      await db
        .updateTable('bookings')
        .set({ location: { kind: 'google_meet', autoCreate: true } })
        .where('id', '=', bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: bookingId,
          booking_id: bookingId,
          organization_id: organizationId,
          organizer_user_id: hostId,
          state: 'failed',
          error_code: 'provider_unavailable',
        })
        .execute()
      await sendBookingNotification(config, bookingId, 'conference_failed')
      check(bookingId)
      await db.deleteFrom('booking_conferences').where('root_booking_id', '=', bookingId).execute()
      await db
        .updateTable('bookings')
        .set({ location: { kind: 'link', url: 'https://meet.example.com/abc' } })
        .where('id', '=', bookingId)
        .execute()

      const moved = await rescheduleManagedBooking(ctx, apiToken, {
        start: instant('2026-11-03T13:00:00Z'),
      })
      await sendBookingNotification(config, moved.booking.id, 'rescheduled')
      check(moved.booking.id, true)
      await cancelManagedBooking(ctx, moved.manageToken as string, {})
      await sendBookingNotification(config, moved.booking.id, 'cancelled')
      check(moved.booking.id, true)
    },
  )

  it('brands host and invitee mail only from the booking organization', async () => {
    const own = await booked()
    const other = await booked()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
      'base64',
    )
    const hash = createHash('sha256').update(png).digest('hex')
    await db
      .insertInto('organization_brand_logos')
      .values({ organization_id: own.organizationId, hash, data: png })
      .execute()
    await db
      .insertInto('organization_branding')
      .values([
        { organization_id: own.organizationId, brand_logo: hash, brand_primary_color: '#005544' },
        { organization_id: other.organizationId, brand_logo: null, brand_primary_color: '#770033' },
      ])
      .execute()
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), own.bookingId, 'confirmed')
    expect(sent).toHaveLength(2)
    for (const mail of sent) {
      expect(mail.html).toContain('background-color: #005544;')
      expect(mail.html).not.toContain('#770033')
      expect(mail.html).toContain('src="cid:organization-logo@hourmere"')
      const attached = Buffer.from(
        mail.attachments?.find((part) => part.cid)?.content as string,
        'base64',
      )
      expect(attached.length).toBeLessThanOrEqual(64 * 1024)
      expect(attached.subarray(0, 8)).toEqual(png.subarray(0, 8))
      expect(invitation(mail)?.method).toBe('REQUEST')
    }
    sent.length = 0
    await sendBookingNotification(deps(mailer), other.bookingId, 'confirmed')
    expect(sent).toHaveLength(2)
    for (const mail of sent) {
      expect(mail.html).toContain('background-color: #770033;')
      expect(mail.html).not.toContain('#005544')
      expect(mail.html).not.toContain('cid:')
      expect(mail.attachments?.some((part) => part.cid)).toBe(false)
    }
  })

  it('delivers explicit no-location wording without inventing a calendar location', async () => {
    const host = await f.host({ name: 'No-location host' })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'no-location', location: null })
    const created = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'no-location',
      start: instant(START),
      invitee: { name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' },
    })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), created.booking.id, 'confirmed')
    expect(sent).toHaveLength(2)
    for (const message of sent) {
      expect(message.text).toContain(
        'No location has been specified. Contact the host for meeting details.',
      )
      expect(message.html).toContain(
        'No location has been specified. Contact the host for meeting details.',
      )
      expect(invitation(message)?.location).toBeNull()
    }
  })

  it('renders mixed booking content per recipient in their own time zone', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true, mixedContent: true })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')

    // Hosts first, then the invitee, then guests.
    expect(sent.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com', 'charles@example.com'])
    const [toHost, toInvitee, toGuest] = sent
    expect(toInvitee?.subject).toBe(
      `Confirmed: ${mixedBooking.event} with ${mixedBooking.host} on Tue, Nov 3, 6:00 PM (Asia/Tokyo, GMT+09:00)`,
    )
    expect(toInvitee?.html).toContain(`<bdi>${mixedBooking.host}</bdi>`)
    expect(toInvitee?.text).toContain(`Where: ${mixedBooking.location}`)
    expect(toInvitee?.text).toMatch(
      /Reschedule: https:\/\/cal\.example\.com\/booking#token=[A-Za-z0-9_-]{43}&action=reschedule/,
    )
    expect(toGuest?.subject).toContain('(Asia/Tokyo, GMT+09:00)')
    expect(toGuest?.text.includes('token=')).toBe(false)
    expect(toHost?.subject).toBe(
      `New booking: ${mixedBooking.event} with ${mixedBooking.invitee} on Tue, Nov 3, 4:00 AM (America/New York, GMT-05:00)`,
    )
    expect(toHost?.text).toContain(`Invitee: ${mixedBooking.invitee} <ada@example.com>`)
    expect(toHost?.html).toContain(
      `<bdi>${mixedBooking.invitee}</bdi> &lt;<bdi dir="ltr">ada@example.com</bdi>&gt;`,
    )
    expect(toHost?.text).toContain(`Guests: ${mixedBooking.guest} <charles@example.com>`)
    expect(toHost?.html).toContain(
      `<bdi>${mixedBooking.guest}</bdi> &lt;<bdi dir="ltr">charles@example.com</bdi>&gt;`,
    )
    expect(toHost?.text).toContain(
      `${mixedBooking.question}\n  ${mixedBooking.answer.replaceAll('\n', '\n  ')}`,
    )
    expect(toHost?.html).toContain(`<bdi>${mixedBooking.question}</bdi>`)
    expect(toHost?.html).toContain(
      '<bdi>راسلني &lt;ada@example.com&gt;</bdi><br><bdi>راجع https://docs.example.test/brief?tab=2&amp;mode=review</bdi>',
    )
    expect(toHost?.text).toContain(`Plans\n  ${mixedOptions.join(', ')}`)
    expect(toHost?.html).toContain(mixedOptions.map((option) => `<bdi>${option}</bdi>`).join(', '))
    expect(toHost?.text).not.toContain('token=')

    for (const message of [toInvitee, toGuest]) {
      for (const body of [message?.html, message?.text]) {
        expect(body).not.toContain(mixedBooking.question)
        expect(body).not.toContain('docs.example.test')
        expect(body).not.toContain(mixedOptions[0])
      }
    }
    for (const m of sent) {
      expect(m.html).toContain('<bdi>📅 12 مراجعة (Review) &amp; צוות</bdi>')
      expect(m.html).toContain(`<bdi>${mixedBooking.location}</bdi>`)
      expect(invitation(m)).toMatchObject({
        method: 'REQUEST',
        // Not tied to PUBLIC_URL, so a domain change does not orphan calendar entries.
        uid: `${bookingId}@hourmere`,
        sequence: 0,
        location: mixedBooking.location,
      })
      expect(m.attachments?.[0]?.content).not.toMatch(/token=|docs\.example\.test/)
    }
    expect(invitation(toInvitee)?.summary).toBe(`${mixedBooking.event} with ${mixedBooking.host}`)
    expect(invitation(toHost)?.summary).toBe(`${mixedBooking.event} with ${mixedBooking.invitee}`)
  })

  it.each([
    ['', true],
    ['   ', true],
    ['', false],
    ['Updated display name', true],
  ])(
    'uses the current name, handle or email for the host in mail and ICS (%#)',
    async (name, hasProfile) => {
      const { bookingId, hostId, hostEmail } = await booked()
      const profile = await db
        .selectFrom('profiles')
        .select('handle')
        .where('user_id', '=', hostId)
        .executeTakeFirstOrThrow()
      await db.updateTable('auth.user').set({ name }).where('id', '=', hostId).execute()
      if (!hasProfile) await db.deleteFrom('profiles').where('user_id', '=', hostId).execute()
      const expected = name.trim() || (hasProfile ? profile.handle : hostEmail)
      const { mailer, sent } = testMailer()
      await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
      const invitee = sent.find(to('ada@example.com'))
      expect(invitee?.subject).toContain(`Intro call with ${expected} on `)
      expect(invitation(invitee)).toMatchObject({
        summary: `Intro call with ${expected}`,
        organizerName: expected,
      })
      expect(sent.every((message) => invitation(message)?.organizerName === expected)).toBe(true)
    },
  )

  it('leaves out hosts whose address is not verified', async () => {
    const { bookingId, hostId, hostEmail } = await booked()
    // A second host on the booking, whose address nobody proved.
    const other = await f.user('Mallory')
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', other)
      .execute()
    await db.insertInto('booking_hosts').values({ booking_id: bookingId, user_id: other }).execute()
    const otherEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', other)
        .executeTakeFirstOrThrow()
    ).email
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    for (const m of sent) {
      const event = new ICAL.Component(
        ICAL.parse(m.attachments?.[0]?.content ?? ''),
      ).getFirstSubcomponent('vevent')
      const people = [
        event?.getFirstPropertyValue('organizer'),
        ...(event?.getAllProperties('attendee') ?? []).map((p) => p.getFirstValue()),
      ].map(String)
      expect(people).toContain(`mailto:${hostEmail}`)
      expect(people).not.toContain(`mailto:${otherEmail}`)
    }

    // Without a verified host there is nobody to send on behalf of.
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', hostId)
      .execute()
    const later = testMailer()
    const lines: string[] = []
    await sendBookingNotification(
      { ...deps(later.mailer), log: (l) => lines.push(l) },
      bookingId,
      'reminder',
    )
    expect(later.sent).toEqual([])
    // Said once, with the booking, since the invitee hears nothing either.
    expect(lines).toEqual([
      expect.stringMatching(
        new RegExp(
          `WARN booking-notification: booking ${bookingId} has no host with a verified email address; not sending its reminder emails$`,
        ),
      ),
    ])
    expect(await records(bookingId)).toHaveLength(2)
  })

  it("gives the invitee a link secret of the email's own, stored only as a hash", async () => {
    const { bookingId, apiToken } = await booked()
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    const invitee = sent.find(to('ada@example.com'))
    expect(invitee?.text).toContain('Where: Online meeting')
    expect(invitee?.text).toContain('Join meeting\nhttps://meet.example.com/abc')
    expect(invitation(invitee)?.location).toBe('https://meet.example.com/abc')
    const token = tokenIn(invitee)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toBe(apiToken)
    const rows = await records(bookingId)
    const withHash = rows.filter((r) => r.manage_token_hash !== null)
    expect(withHash).toHaveLength(1)
    expect(withHash[0]?.recipient).toMatch(/^attendee:/)
    expect(withHash[0]?.manage_token_hash?.equals(sha256(token as string))).toBe(true)
    // The token the booking API returned still opens the booking.
    expect((await getManagedBooking(ctx, apiToken)).id).toBe(bookingId)
  })

  it('never sends the same email twice', async () => {
    const { bookingId } = await booked({ guests: true })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent).toHaveLength(3)
    expect(await records(bookingId)).toHaveLength(3)
  })

  it('retries only the emails that failed', async () => {
    const { bookingId, hostEmail } = await booked()
    const { mailer, sent, state } = testMailer()
    state.failFor = 'ada@example.com'
    await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
      'unavailable',
    )
    expect(sent.map((m) => m.to)).toEqual([hostEmail])
    expect((await records(bookingId)).map((r) => r.recipient)).toEqual([
      expect.stringMatching(/^host:/),
    ])
    state.failFor = undefined
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
  })

  describe('when the mail server refuses', () => {
    it('keeps going past an address refused for now, and the retry sends only to it', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      state.refuse.set('ada@example.com', GREYLISTED)
      const attempt = sendBookingNotification(deps(mailer), bookingId, 'confirmed')
      await expect(attempt).rejects.toBeInstanceOf(NotificationRetryError)
      await expect(attempt).rejects.toThrow(
        /refused 1 of 3 emails for now: attendee:[0-9a-f-]{36} \(450 4\.2\.0\)/,
      )
      await expect(attempt).rejects.not.toThrow(/ada@example\.com/)
      // The host and the guest got theirs on the first attempt.
      expect(sent.map((m) => m.to)).toEqual([hostEmail, 'charles@example.com'])

      state.refuse.clear()
      await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
      expect(sent.map((m) => m.to)).toEqual([hostEmail, 'charles@example.com', 'ada@example.com'])
      expect(tokenIn(sent[2])).toBeTruthy()
    })

    it('gives up on an address that does not exist, with one log line and no secret kept', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      state.refuse.set('ada@example.com', NO_SUCH_USER)
      const lines: string[] = []
      await sendBookingNotification(
        { ...deps(mailer), log: (l) => lines.push(l) },
        bookingId,
        'confirmed',
      )
      expect(sent.map((m) => m.to)).toEqual([hostEmail, 'charles@example.com'])
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        new RegExp(
          `refused the confirmed email for booking ${bookingId} to attendee:[0-9a-f-]{36} for good \\(550 5\\.1\\.1\\)`,
        ),
      )
      expect(lines[0]).not.toContain('ada@example.com')
      const rejected = (await records(bookingId)).filter((r) => r.outcome === 'rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.manage_token_hash).toBeNull()

      // Not tried again.
      state.refuse.clear()
      await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
      expect(sent).toHaveLength(2)
    })

    it('does not give up on everyone when every address is refused for good', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      for (const address of [hostEmail, 'ada@example.com', 'charles@example.com']) {
        state.refuse.set(address, NO_SUCH_USER)
      }
      await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
        /refused every recipient it was offered for good/,
      )
      expect(sent).toEqual([])
      expect(await records(bookingId)).toEqual([])
    })

    it('does not give up on an address when it is the only one tried and refused for good', async () => {
      const { bookingId, hostEmail } = await booked()
      const { mailer, sent, state } = testMailer()
      // First attempt: the host's email goes out, the invitee's is refused for now.
      state.refuse.set('ada@example.com', GREYLISTED)
      await expect(
        sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
      ).rejects.toBeInstanceOf(NotificationRetryError)
      expect(sent.map((m) => m.to)).toEqual([hostEmail])
      // The retry tries only the invitee, and a bare 550 (a server refusing everything would
      // say the same) is no reason to give up on them.
      state.refuse.set('ada@example.com', { responseCode: 550, atRecipient: true })
      await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
        /refused every recipient it was offered for good/,
      )
      expect((await records(bookingId)).map((r) => [r.recipient.split(':')[0], r.outcome])).toEqual(
        [['host', 'sent']],
      )
    })

    it('treats refused relaying as a mail server problem: stop and retry', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      state.refuse.set(hostEmail, RELAY_DENIED)
      state.refuse.set('ada@example.com', RELAY_DENIED)
      await expect(
        sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
      ).rejects.toBeInstanceOf(MailRejectedError)
      expect(sent).toEqual([])
      expect(await records(bookingId)).toEqual([])
    })

    it('treats a sending limit after DATA as a mail server problem: stop and retry', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      state.refuse.set('ada@example.com', DAILY_LIMIT)
      await expect(
        sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
      ).rejects.toBeInstanceOf(MailRejectedError)
      // The guest after the invitee was not tried; nothing was given up on.
      expect(sent.map((m) => m.to)).toEqual([hostEmail])
      expect((await records(bookingId)).map((r) => r.outcome)).toEqual(['sent'])
    })

    it('stops at once when the mail server fails for everyone', async () => {
      const { bookingId, hostEmail } = await booked({ guests: true })
      const { mailer, sent, state } = testMailer()
      state.failFor = hostEmail
      await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
        'unavailable',
      )
      expect(sent).toEqual([])
      expect(await records(bookingId)).toEqual([])
    })
  })

  it('sends one email when two attempts run at the same time', async () => {
    const { bookingId } = await booked()
    const { mailer, sent, state } = testMailer()
    let release!: () => void
    state.hold = new Promise((r) => {
      release = r
    })
    const both = Promise.all([
      sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
      sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
    ])
    await new Promise((r) => setTimeout(r, 200))
    release()
    await both
    expect(sent).toHaveLength(2)
  })

  it('does not hold up a cancellation while an email is being sent', async () => {
    const { bookingId, apiToken } = await booked()
    const { mailer, sent, state } = testMailer()
    let release!: () => void
    state.hold = new Promise((r) => {
      release = r
    })
    const started = new Promise<void>((r) => {
      state.started = r
    })
    const sending = sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    try {
      await started
      // The invitee cancels while the mail server is still taking the confirmation.
      const cancelled = await Promise.race([
        cancelManagedBooking(ctx, apiToken, {}).then(() => 'cancelled'),
        new Promise((r) => setTimeout(() => r('blocked'), 3000)),
      ])
      expect(cancelled).toBe('cancelled')
    } finally {
      release()
      await sending
    }
    expect(sent.length).toBeGreaterThan(0)
  })

  it('stops sending a confirmation once the booking is cancelled midway', async () => {
    const { bookingId, apiToken, hostEmail } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    // Cancelled while the host's email is going out.
    state.during = async (message) => {
      if (message.to === hostEmail) await cancelManagedBooking(ctx, apiToken, {})
    }
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual([hostEmail])
    expect((await records(bookingId)).map((r) => r.recipient)).toEqual([
      expect.stringMatching(/^host:/),
    ])
  })

  it('stops confirming once the meeting starts while the emails go out', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    let current = NOW
    // The host's email takes until after the start.
    state.during = (message) => {
      if (message.to === hostEmail) current = instant(START).add({ minutes: 1 })
    }
    await sendBookingNotification({ ...deps(mailer), now: () => current }, bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual([hostEmail])
    expect(await records(bookingId)).toHaveLength(1)
  })

  it('takes no further recipient once the job is told to stop', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    const controller = new AbortController()
    // The host's email goes out; the worker is told to stop while it does.
    state.during = () => controller.abort(new Error('shutting down'))
    await expect(
      sendBookingNotification(deps(mailer), bookingId, 'confirmed', { signal: controller.signal }),
    ).rejects.toThrow('shutting down')
    expect(sent.map((m) => m.to)).toEqual([hostEmail])
  })

  it('survives losing its database connection while the mail server answers', async () => {
    const { bookingId, hostEmail } = await booked()
    const { mailer, sent, state } = testMailer()
    let release!: () => void
    state.hold = new Promise((r) => {
      release = r
    })
    const started = new Promise<void>((r) => {
      state.started = r
    })
    const sending = sendBookingNotification(deps(mailer), bookingId, 'confirmed').then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await started
    // As a Postgres restart, failover or idle_in_transaction_session_timeout would.
    const terminated = await testDb.pool.query<{ ok: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
          AND backend_xid IS NOT NULL`,
    )
    expect(terminated.rows).toEqual([{ ok: true }])
    await new Promise((r) => setTimeout(r, 200))
    release()
    // The send went out, but its record could not be committed: the attempt fails.
    expect(await sending).toBeInstanceOf(Error)
    expect(sent.map((m) => m.to)).toEqual([hostEmail])
    expect(await records(bookingId)).toEqual([])

    // The retry sends again (the narrow duplicate window), and the database works again.
    const retry = testMailer()
    await sendBookingNotification(deps(retry.mailer), bookingId, 'confirmed')
    expect(retry.sent.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
  })

  it('tells both sides about a reschedule, with the old time and an updated invitation', async () => {
    const { bookingId, apiToken, hostEmail } = await booked()
    const moved = await rescheduleManagedBooking(ctx, apiToken, {
      start: instant('2026-11-03T13:00:00Z'),
    })
    const { mailer, sent } = testMailer()
    // The old booking's own notifications no longer apply.
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    await sendBookingNotification(deps(mailer), bookingId, 'reminder')
    await sendBookingNotification(deps(mailer), bookingId, 'cancelled')
    expect(sent).toEqual([])

    await sendBookingNotification(deps(mailer), moved.booking.id, 'rescheduled')
    expect(sent.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    const toInvitee = sent[1]
    expect(toInvitee?.subject).toBe(
      'Rescheduled: Intro call with Grace Hopper, now Tue, Nov 3, 10:00 PM (Asia/Tokyo, GMT+09:00)',
    )
    expect(toInvitee?.text).toContain(
      'Was: Tuesday, November 3, 2026, 6:00 PM – 6:30 PM (Asia/Tokyo, GMT+09:00)',
    )
    expect(tokenIn(toInvitee)).toBeTruthy()
    // Same calendar entry as the original booking, one version later.
    expect(invitation(toInvitee)).toMatchObject({
      method: 'REQUEST',
      uid: `${bookingId}@hourmere`,
      sequence: 1,
    })
  })

  it('sends no reschedule email for a booking that replaced nothing', async () => {
    const { bookingId } = await booked()
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'rescheduled')
    expect(sent).toEqual([])
  })

  it('sends no confirmation once the meeting has started', async () => {
    const { bookingId } = await booked()
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer, instant(START)), bookingId, 'confirmed')
    expect(sent).toEqual([])
  })

  it('cancels the calendar entry and leaves out manage links once cancelled', async () => {
    const { bookingId, apiToken } = await booked()
    await cancelManagedBooking(ctx, apiToken, { reason: 'Something came up.' })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent).toEqual([])
    await sendBookingNotification(deps(mailer), bookingId, 'cancelled')
    expect(sent).toHaveLength(2)
    for (const m of sent) {
      expect(m.text).toContain('Reason: Something came up.')
      expect(m.text).not.toContain('token=')
      expect(invitation(m)).toMatchObject({ method: 'CANCEL', sequence: 1 })
    }
    expect((await records(bookingId)).every((r) => r.manage_token_hash === null)).toBe(true)
  })

  it('reminds both sides without an invitation, and not once the meeting has started', async () => {
    const { bookingId } = await booked()
    const late = testMailer()
    await sendBookingNotification(deps(late.mailer, instant(START)), bookingId, 'reminder')
    expect(late.sent).toEqual([])

    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'reminder')
    expect(sent).toHaveLength(2)
    const toInvitee = sent.find(to('ada@example.com'))
    expect(toInvitee?.subject).toMatch(/^Reminder: Intro call with Grace Hopper on /)
    expect(tokenIn(toInvitee)).toBeTruthy()
    expect(sent.every((m) => m.attachments === undefined)).toBe(true)
  })

  it('does nothing for a booking that no longer exists', async () => {
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), '0199f0c4-7a2b-7000-8000-000000000000', 'confirmed')
    expect(sent).toEqual([])
  })

  describe('through the job queue', () => {
    it('queues the email and the reminder with the booking, and sends them from a worker', async () => {
      // pg-boss reads PostgreSQL time, so its delayed reminder must stay in the
      // database's future even when the application clock is shifted by the test runner.
      const { now: databaseTime } = (
        await testDb.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0] as { now: Date }
      const now = Temporal.Instant.fromEpochMilliseconds(databaseTime.getTime())
      const localNow = now.toZonedDateTimeISO('Europe/Berlin')
      const start = localNow
        .add({ days: 15 - localNow.dayOfWeek })
        .with({ hour: 10, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
        .toInstant()
      const { mailer, sent } = testMailer()
      const jobs = createJobs({
        connectionString: testDb.url,
        definitions: [bookingNotificationJob(deps(mailer, now))],
        work: true,
        migrate: true,
        pollingIntervalSeconds: 0.5,
        log: () => {},
      })
      await jobs.start()
      try {
        const { bookingId } = await booked({ now, start })
        // As the booking service will: inside the transaction that wrote the booking.
        await expect(
          db.transaction().execute(async (trx) => {
            await enqueueBookingNotifications(jobs, trx, { type: 'created', bookingId, start }, now)
            throw new Error('rolled back')
          }),
        ).rejects.toThrow('rolled back')
        const queued = () =>
          testDb.pool.query<{ data: unknown; start_after: Date; state: string }>(
            'SELECT data, start_after, state FROM pgboss.job WHERE name = $1 ORDER BY start_after',
            [BOOKING_NOTIFICATION_JOB],
          )
        expect((await queued()).rows).toEqual([])

        await db
          .transaction()
          .execute((trx) =>
            enqueueBookingNotifications(jobs, trx, { type: 'created', bookingId, start }, now),
          )
        const rows = (await queued()).rows
        // Only the booking id and the kind: no secret is ever stored in the queue.
        expect(rows.map((r) => r.data)).toEqual([
          { bookingId, kind: 'confirmed' },
          { bookingId, kind: 'reminder' },
        ])
        expect(rows[1]?.start_after.toISOString()).toBe(
          start.subtract({ hours: 24 }).toString({ fractionalSecondDigits: 3 }),
        )

        const deadline = Date.now() + 10_000
        while (sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
        expect(
          sent.map((m) => m.subject),
          'waiting for the worker to send host and invitee booking confirmations',
        ).toEqual([expect.stringMatching(/^New booking: /), expect.stringMatching(/^Confirmed: /)])
      } finally {
        await jobs.stop()
      }
    }, 20_000)

    it('rolls back and lets go of the database when a worker stops during a slow send', async () => {
      const { bookingId, apiToken } = await booked()
      await cancelManagedBooking(ctx, apiToken, {})
      const { mailer, sent, state } = testMailer()
      state.hold = new Promise(() => {})
      const started = new Promise<void>((r) => {
        state.started = r
      })
      // Its own pool, closed afterwards as the server closes its own on shutdown.
      const pool = createPool(testDb.url)
      const jobs = createJobs({
        connectionString: testDb.url,
        definitions: [bookingNotificationJob({ ...deps(mailer), db: createDb(pool) })],
        work: true,
        migrate: true,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 1000,
        log: () => {},
      })
      await jobs.start()
      await db
        .transaction()
        .execute((trx) =>
          enqueueBookingNotifications(jobs, trx, { type: 'cancelled', bookingId }, NOW),
        )
      await started
      const before = Date.now()
      await jobs.stop()
      await pool.end()
      expect(Date.now() - before).toBeLessThan(5000)
      expect(state.aborted).toBe(1)
      expect(sent).toEqual([])
      // Rolled back: the email is still owed, and the job will run again.
      expect(await records(bookingId)).toEqual([])
      const job = await testDb.pool.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name = $1 AND data->>'bookingId' = $2",
        [BOOKING_NOTIFICATION_JOB, bookingId],
      )
      expect(job.rows.map((r) => r.state)).toEqual(['retry'])
    })

    /** Records what enqueueBookingNotifications asks for. */
    function fakeQueue() {
      const queued: { kind: string; startAfter?: unknown }[] = []
      return {
        queued,
        async enqueue(
          _name: string,
          payload: { kind: string },
          options?: { startAfter?: unknown },
        ) {
          queued.push({ kind: payload.kind, startAfter: options?.startAfter })
          return 'id'
        },
      }
    }
    const bookingId = '0199f0c4-7a2b-7000-8000-000000000001'

    it('gives Teams confirmation a short writeback grace period for future starts', async () => {
      const { bookingId } = await booked()
      const queue = fakeQueue()
      await db.transaction().execute(async (trx) => {
        for (const seconds of [10, 21, 3600]) {
          await enqueueBookingNotifications(
            queue,
            trx,
            { type: 'created', bookingId, teamsMeeting: true, start: NOW.add({ seconds }) },
            NOW,
          )
        }
        await enqueueBookingNotifications(
          queue,
          trx,
          { type: 'created', bookingId, start: NOW.add({ hours: 1 }) },
          NOW,
        )
      })
      expect(queue.queued).toEqual([
        { kind: 'confirmed', startAfter: undefined },
        { kind: 'confirmed', startAfter: undefined },
        { kind: 'confirmed', startAfter: NOW.add({ seconds: 20 }) },
        { kind: 'confirmed', startAfter: undefined },
      ])
    })

    it('skips a reminder less than a day away, or due within an hour of the booking', async () => {
      const queue = fakeQueue()
      await db.transaction().execute(async (trx) => {
        for (const hours of [23, 24.5, 25.5]) {
          await enqueueBookingNotifications(
            queue,
            trx,
            { type: 'rescheduled', bookingId, start: NOW.add({ minutes: hours * 60 }) },
            NOW,
          )
        }
        await enqueueBookingNotifications(queue, trx, { type: 'cancelled', bookingId }, NOW)
      })
      expect(queue.queued).toEqual([
        { kind: 'rescheduled', startAfter: undefined },
        { kind: 'rescheduled', startAfter: undefined },
        { kind: 'rescheduled', startAfter: undefined },
        { kind: 'reminder', startAfter: NOW.add({ minutes: 90 }) },
        { kind: 'cancelled', startAfter: undefined },
      ])
    })

    it('refuses to queue outside a transaction', async () => {
      const queue = fakeQueue()
      await expect(
        enqueueBookingNotifications(queue, db, { type: 'cancelled', bookingId }, NOW),
      ).rejects.toThrow(/needs the transaction that writes the booking/)
      expect(queue.queued).toEqual([])
    })
  })
})
