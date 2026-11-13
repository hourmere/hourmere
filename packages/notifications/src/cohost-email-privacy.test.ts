import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createSmtpMailer, type Mailer } from '@hourmere/mail'
import {
  createNotificationSnapshot,
  type NotificationSettings,
} from '@hourmere/scheduling/notification-settings'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSmtpServer } from '../../mail/src/smtp-testing.ts'
import { type NotificationDeps, type NotificationKind, sendBookingNotification } from './index.ts'
import { sendRescheduleRequestNotification } from './reschedule-request.ts'
import {
  deliverScheduledBookingEmail,
  enqueueScheduledBookingEmails,
  type ScheduledEmailQueue,
} from './scheduled.ts'
import { alignSmtpDateNowWithDatabase } from './testing-clock.ts'

// Invitees and guests of a collective booking get no host address at all: no host Reply-To,
// no host ATTENDEE (legacy v1 roots keep only their pinned ORGANIZER). Hosts are named.
// Every assertion reads the raw MIME the real SMTP mailer wrote, with each part decoded.

const NOW = Temporal.Instant.from('2026-11-01T12:00Z')
const START = NOW.add({ hours: 72 })
const END = START.add({ minutes: 30 })
const SENDER = 'calendar@sender.example.test'
const INVITEE = 'ivy-invitee@people.example.test'
const GUEST = 'gus-guest@people.example.test'

interface Raw {
  to: string
  raw: string
  /** The raw message plus every decoded part, unfolded and lower-cased. */
  text: string
  /** The decoded text/calendar part, if any. */
  ics: string | undefined
}

const unfold = (value: string) => value.replace(/\r?\n[ \t]/g, '')

function decodeQuotedPrintable(body: string) {
  const bytes: number[] = []
  const soft = body.replace(/=\r?\n/g, '')
  for (let i = 0; i < soft.length; i++) {
    const hex = soft[i] === '=' ? soft.slice(i + 1, i + 3) : ''
    if (/^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      i += 2
    } else bytes.push(...Buffer.from(soft[i] as string, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Every MIME part's body decoded, plus RFC 2047 encoded-word headers, for searching. */
function decodeMime(raw: string): Raw {
  const parts: string[] = [unfold(raw)]
  let ics: string | undefined
  const partPattern = /((?:^[^\r\n]+\r\n)+)\r\n([\s\S]*?)(?=\r\n--|$(?![\s\S]))/gm
  for (const [, headers = '', body = ''] of raw.matchAll(partPattern)) {
    const head = unfold(headers)
    const encoding = head.match(/^Content-Transfer-Encoding:\s*([\w-]+)/im)?.[1]?.toLowerCase()
    const decoded =
      encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
        : encoding === 'quoted-printable'
          ? decodeQuotedPrintable(body)
          : body
    if (/^Content-Type:\s*text\/calendar/im.test(head)) ics ??= decoded
    parts.push(unfold(decoded))
  }
  for (const [, charset, kind, word = ''] of raw.matchAll(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi))
    parts.push(
      charset && kind?.toUpperCase() === 'B'
        ? Buffer.from(word, 'base64').toString('utf8')
        : decodeQuotedPrintable(word.replaceAll('_', ' ')),
    )
  return { to: '', raw, text: parts.join('\n').toLowerCase(), ics }
}

const header = (message: Raw, name: string) =>
  unfold(message.raw.split('\r\n\r\n')[0] ?? '')
    .split('\r\n')
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))

function calendar(message: Raw) {
  if (!message.ics) throw new Error(`no calendar part for ${message.to}`)
  const component = new ICAL.Component(ICAL.parse(message.ics))
  return component.getFirstSubcomponent('vevent') as ICAL.Component
}

describe.skipIf(!process.env.DATABASE_URL)('co-host addresses in invitee-facing mail', () => {
  let fixture: TestDatabase
  let db: Db
  let f: Fixtures
  let smtp: ReturnType<typeof fakeSmtpServer>
  let smtpMailer: Mailer
  let now: Temporal.Instant
  let sent: Raw[]
  let deps: NotificationDeps

  beforeAll(async () => {
    fixture = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'cohost_privacy',
    })
    db = createDb(fixture.pool)
    f = createFixtures(db)
    smtp = fakeSmtpServer()
    await new Promise<void>((resolve) => smtp.server.listen(0, '127.0.0.1', resolve))
    const port = (smtp.server.address() as { port: number }).port
    smtpMailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: SENDER })
    deps = {
      db,
      secret: 'synthetic-cohost-privacy-secret',
      publicUrl: 'https://hourmere.example.test',
      now: () => now,
      log: () => {},
      mailer: {
        senderEmail: smtpMailer.senderEmail,
        async send(message, options) {
          smtp.received.data = undefined
          await smtpMailer.send(message, options)
          sent.push({ ...decodeMime(smtp.received.data ?? ''), to: message.to })
        },
      },
    }
  })
  beforeEach(async () => {
    await alignSmtpDateNowWithDatabase(db)
    now = NOW
    sent = []
    await db.deleteFrom('notification_email_sends').execute()
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    for (const socket of smtp?.sockets ?? []) socket.destroy()
    await new Promise<void>((resolve) => (smtp ? smtp.server.close(() => resolve()) : resolve()))
    await fixture?.drop()
  })

  type Team = Awaited<ReturnType<typeof team>>

  /**
   * A team with required hosts. `hosts` is in user-ID order; `organizer` is the host the
   * notification worker treats as organizer (the first by ID unless a conference names another).
   */
  async function team(hostCount = 3) {
    const created = []
    for (let i = 0; i < hostCount; i++) created.push(await f.host({ name: `Host ${i}` }))
    const organizationId = (created[0] as { organizationId: string }).organizationId
    for (const extra of created.slice(1)) await f.member(extra.userId, organizationId)
    const ids = created.map((h) => h.userId).sort()
    const names = ['Olivia First', 'Carl Second', 'Cora Third']
    const hosts = []
    for (const [index, id] of ids.entries()) {
      // Distinct tokens: a partial or encoded leak still contains one of them.
      const token = `hostaddr${index}x${id.slice(0, 8)}`
      const email = `${token}@team.example.test`
      const name = names[index] as string
      await db.updateTable('auth.user').set({ name, email }).where('id', '=', id).execute()
      hosts.push({ id, email, token, name })
    }
    return { organizationId, ids, organizer: hosts[0] as (typeof hosts)[number], hosts }
  }

  async function book(t: Team, start = START, end = END, rescheduledFrom?: string) {
    const id = await f.booking(t.organizationId, t.ids, start.toString(), end.toString(), {
      attendee: { name: 'Ivy Invitee', email: INVITEE },
    })
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Gus Guest',
        email: GUEST,
        time_zone: 'UTC',
        is_booker: false,
      })
      .execute()
    if (rescheduledFrom)
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: rescheduledFrom })
        .where('id', '=', id)
        .execute()
    return id
  }

  const cancel = (id: string) =>
    db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(NOW.epochMilliseconds) })
      .where('id', '=', id)
      .execute()

  async function configure(id: string, settings: NotificationSettings) {
    await db
      .updateTable('bookings')
      .set({ notification_snapshot: JSON.stringify(createNotificationSnapshot(settings)) })
      .where('id', '=', id)
      .execute()
    const queue: Partial<ScheduledEmailQueue> = { enqueue: async () => randomUUID() }
    await db.transaction().execute((trx) => enqueueScheduledBookingEmails(queue, trx, id, NOW))
    return db
      .selectFrom('booking_scheduled_messages')
      .select(['id', 'kind', 'due_at'])
      .where('booking_id', '=', id)
      .orderBy('due_at')
      .execute()
  }

  async function deliverScheduled(row: { id: string; due_at: Date }) {
    now = Temporal.Instant.fromEpochMilliseconds(row.due_at.getTime())
    await deliverScheduledBookingEmail(deps, row.id)
    now = NOW
  }

  const attendeeMail = () => sent.filter((m) => m.to === INVITEE || m.to === GUEST)
  const hostMail = (email: string) => sent.filter((m) => m.to === email)
  const NOTICE = 'replies to this email are not delivered to the hosts.'
  const NOTICE_LINKS = 'to reschedule or cancel, use the links in this email.'

  /** Host addresses (by token) found anywhere in the decoded messages. */
  function hostAddressesSeen(t: Team, messages: Raw[]) {
    const seen = new Set<string>()
    for (const message of messages) {
      // Positive control: the recipient's own address is found in the decoded message.
      expect(message.text).toContain(message.to.toLowerCase())
      for (const host of t.hosts) if (message.text.includes(host.token)) seen.add(host.email)
    }
    return seen
  }

  /** Collective invitee/guest mail: no Reply-To, the notice, and links where they apply. */
  function expectNoHostReply(message: Raw, links: boolean) {
    expect(header(message, 'Reply-To')).toEqual([])
    expect(message.text).toContain(NOTICE)
    expect(message.text.includes(NOTICE_LINKS)).toBe(links)
    expect(message.text.includes('#token=')).toBe(links)
  }

  it('sends a collective v2 invitee and guest no host address through every lifecycle kind', async () => {
    const t = await team()
    const original = await book(t)
    await sendBookingNotification(deps, original, 'confirmed')
    await sendBookingNotification(deps, original, 'reminder')
    await cancel(original)
    const moved = await book(t, START.add({ hours: 24 }), END.add({ hours: 24 }), original)
    await sendBookingNotification(deps, moved, 'rescheduled')
    await cancel(moved)
    await sendBookingNotification(deps, moved, 'cancelled')

    // Three hosts and two attendees for each of the four kinds.
    expect(sent).toHaveLength(20)
    const attendees = attendeeMail()
    expect(attendees).toHaveLength(8)
    expect(hostAddressesSeen(t, attendees)).toEqual(new Set())
    for (const [index, message] of attendees.entries()) {
      const kind = Math.floor(index / 2)
      expectNoHostReply(message, message.to === INVITEE && kind !== 3)
      // Every host is still named in the body.
      for (const host of t.hosts) expect(message.text).toContain(host.name.toLowerCase())
    }

    // Calendar identity is unchanged: one UID, the pinned MAIL_FROM ORGANIZER, SEQUENCE
    // following the chain. Only the invitee and guest are attendees.
    const invitations = attendees.filter((m) => m.ics)
    expect(invitations).toHaveLength(6)
    for (const message of invitations) {
      const event = calendar(message)
      expect(event.getFirstPropertyValue('uid')).toBe(`${original}@hourmere`)
      expect(event.getFirstProperty('organizer')?.getFirstValue()).toBe(`mailto:${SENDER}`)
      expect(event.getFirstProperty('organizer')?.getParameter('cn')).toBe(t.organizer.name)
      expect(
        event
          .getAllProperties('attendee')
          .map((p) => [p.getFirstValue(), p.getParameter('role'), p.getParameter('rsvp')]),
      ).toEqual([
        [`mailto:${INVITEE}`, 'REQ-PARTICIPANT', 'FALSE'],
        [`mailto:${GUEST}`, 'REQ-PARTICIPANT', 'FALSE'],
      ])
      for (const host of t.hosts)
        expect(String(event.getFirstPropertyValue('description'))).toContain(host.name)
      expect(event.getAllProperties('contact')).toHaveLength(0)
    }
    expect(invitations.map((m) => calendar(m).getFirstPropertyValue('sequence'))).toEqual([
      0, 0, 1, 1, 2, 2,
    ])

    // Hosts may still see each other: their mail and invitation are unchanged.
    for (const host of t.hosts) {
      const mail = hostMail(host.email)
      expect(mail).toHaveLength(4)
      for (const message of mail) {
        expect(header(message, 'Reply-To')).toEqual([`Reply-To: Ivy Invitee <${INVITEE}>`])
        expect(message.text).not.toContain(NOTICE)
        for (const other of t.hosts.filter((h) => h !== host))
          expect(message.text).toContain(other.name.toLowerCase())
      }
      for (const message of mail.filter((m) => m.ics)) {
        const listed = calendar(message)
          .getAllProperties('attendee')
          .map((p) => p.getFirstValue())
        expect(listed).toEqual([
          ...t.hosts.map((h) => `mailto:${h.email}`),
          `mailto:${INVITEE}`,
          `mailto:${GUEST}`,
        ])
      }
    }
  })

  it('shows no host address when the meeting organizer is not the first host, through confirmation, reminder, reschedule, follow-up and cancellation', async () => {
    const t = await team()
    // The conference organizer is the third host by ID, so lifecycle mail and follow-ups
    // would pick different hosts if either still chose one.
    const organizer = t.hosts[2] as Team['hosts'][number]
    const roles = { host: true, invitee: true, guests: true }
    const settings: NotificationSettings = {
      reminders: [{ id: 'before', offsetMinutes: 120, recipients: roles }],
      followUps: [{ id: 'after', offsetMinutes: 5, recipients: roles }],
    }
    const original = await book(t)
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: original,
        booking_id: original,
        organization_id: t.organizationId,
        organizer_user_id: organizer.id,
        invitation_organizer_name: organizer.name,
        invitation_organizer_email: organizer.email,
      })
      .execute()
    const originalRows = await configure(original, settings)
    await sendBookingNotification(deps, original, 'confirmed')
    await deliverScheduled(originalRows[0] as (typeof originalRows)[number])
    await cancel(original)
    const moved = await book(t, START.add({ hours: 24 }), END.add({ hours: 24 }), original)
    await db
      .updateTable('booking_conferences')
      .set({ booking_id: moved })
      .where('root_booking_id', '=', original)
      .execute()
    const movedRows = await configure(moved, settings)
    await sendBookingNotification(deps, moved, 'rescheduled')
    await deliverScheduled(movedRows[1] as (typeof movedRows)[number])
    await cancel(moved)
    await sendBookingNotification(deps, moved, 'cancelled')

    const invitee = sent.filter((m) => m.to === INVITEE)
    // confirmation, configured reminder, reschedule, follow-up, cancellation
    expect(invitee).toHaveLength(5)
    expect(hostAddressesSeen(t, attendeeMail())).toEqual(new Set())
    for (const [index, message] of invitee.entries())
      expectNoHostReply(message, index === 0 || index === 1 || index === 2)
    for (const message of sent.filter((m) => m.to === GUEST)) expectNoHostReply(message, false)
    for (const message of invitee.filter((m) => m.ics))
      expect(calendar(message).getFirstProperty('organizer')?.getParameter('cn')).toBe(
        organizer.name,
      )
    // Hosts' reminder and follow-up still reply to the invitee.
    for (const host of t.hosts)
      for (const message of hostMail(host.email))
        expect(header(message, 'Reply-To')).toEqual([`Reply-To: Ivy Invitee <${INVITEE}>`])
  })

  it('sends no host address in the conference-failure notice', async () => {
    const t = await team()
    const id = await book(t)
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', id)
      .execute()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: t.organizationId,
        organizer_user_id: t.organizer.id,
        state: 'failed',
        error_code: 'provider_unavailable',
      })
      .execute()
    await sendBookingNotification(deps, id, 'conference_failed')
    const invitee = sent.filter((m) => m.to === INVITEE)
    expect(invitee).toHaveLength(1)
    expect(hostAddressesSeen(t, invitee)).toEqual(new Set())
    expect(invitee[0]?.ics).toBeUndefined()
    expectNoHostReply(invitee[0] as Raw, true)
  })

  it('sends no host address in the reschedule request to the invitee', async () => {
    const t = await team()
    const id = await book(t)
    const requestId = randomUUID()
    await sql`INSERT INTO booking_reschedule_requests(id,booking_id,idempotency_key,note,state,created_at,expires_at)
      VALUES (${requestId}::uuid,${id}::uuid,${randomUUID()}::uuid,'Please move',
        'pending',${new Date(NOW.epochMilliseconds)},${new Date(NOW.add({ hours: 48 }).epochMilliseconds)})`.execute(
      db,
    )
    await sendRescheduleRequestNotification(deps, {
      bookingId: id,
      requestId,
      kind: 'reschedule_requested',
    })
    expect(sent.map((m) => m.to)).toEqual([INVITEE])
    expect(hostAddressesSeen(t, sent)).toEqual(new Set())
    expectNoHostReply(sent[0] as Raw, true)
  })

  it('shows a legacy (v1) collective invitee only its pinned organizer, also after the hosts change', async () => {
    const t = await team()
    const pinned = t.hosts[0] as Team['hosts'][number]
    const original = await book(t)
    await db
      .updateTable('bookings')
      .set({
        ical_version: 1,
        ical_organizer_name: pinned.name,
        ical_organizer_email: pinned.email,
      })
      .where('id', '=', original)
      .execute()
    // The pinned host has left: a surviving host must not be revealed in its place.
    await db.deleteFrom('auth.member').where('userId', '=', pinned.id).execute()
    await sendBookingNotification(deps, original, 'confirmed')
    await sendBookingNotification(deps, original, 'reminder')
    await cancel(original)
    const moved = await book(t, START.add({ hours: 24 }), END.add({ hours: 24 }), original)
    await sendBookingNotification(deps, moved, 'rescheduled')
    await cancel(moved)
    await sendBookingNotification(deps, moved, 'cancelled')
    const attendees = attendeeMail()
    expect(attendees).toHaveLength(8)
    expect(hostAddressesSeen(t, attendees)).toEqual(new Set([pinned.email]))
    for (const message of attendees) expect(header(message, 'Reply-To')).toEqual([])
    const invitations = attendees.filter((m) => m.ics)
    for (const message of invitations) {
      const event = calendar(message)
      expect(event.getFirstPropertyValue('uid')).toBe(`${original}@hourmere`)
      // The pinned v1 ORGANIZER is retained, so clients update rather than duplicate.
      expect(event.getFirstProperty('organizer')?.getFirstValue()).toBe(`mailto:${pinned.email}`)
      expect(event.getFirstProperty('organizer')?.getParameter('sent-by')).toBe(`mailto:${SENDER}`)
      expect(event.getAllProperties('attendee').map((p) => p.getFirstValue())).toEqual([
        `mailto:${INVITEE}`,
        `mailto:${GUEST}`,
      ])
    }
    expect(invitations.map((m) => calendar(m).getFirstPropertyValue('sequence'))).toEqual([
      0, 0, 1, 1, 2, 2,
    ])
    // Legacy host invitations still list the other hosts.
    const [, second, third] = t.hosts as [Team['hosts'][number], ...Team['hosts']]
    for (const message of hostMail(second?.email ?? '').filter((m) => m.ics))
      expect(message.text).toContain(third?.token)
  })

  it('pins the instance mailbox, not a host, for an unpinned legacy (v1) collective root', async () => {
    const t = await team()
    const id = await book(t)
    await db.updateTable('bookings').set({ ical_version: 1 }).where('id', '=', id).execute()
    await sendBookingNotification(deps, id, 'confirmed')
    expect(hostAddressesSeen(t, attendeeMail())).toEqual(new Set())
    expect(
      await db
        .selectFrom('bookings')
        .select(['ical_organizer_name', 'ical_organizer_email'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ ical_organizer_name: t.organizer.name, ical_organizer_email: SENDER })
  })

  it('keeps a collective booking private after it is down to one verified host', async () => {
    const t = await team(2)
    const id = await book(t)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', (t.hosts[1] as Team['hosts'][number]).id)
      .execute()
    await sendBookingNotification(deps, id, 'confirmed')
    expect(hostAddressesSeen(t, attendeeMail())).toEqual(new Set())
    for (const message of attendeeMail()) expect(header(message, 'Reply-To')).toEqual([])
  })

  it('leaves a single assigned team host (round-robin) exactly as a personal booking', async () => {
    const t = await team(1)
    const id = await f.booking(t.organizationId, t.ids, START.toString(), END.toString(), {
      attendee: { name: 'Ivy Invitee', email: INVITEE },
    })
    await sendBookingNotification(deps, id, 'confirmed' satisfies NotificationKind)
    const message = sent.find((m) => m.to === INVITEE) as Raw
    expect(header(message, 'Reply-To')).toEqual([
      `Reply-To: ${t.organizer.name} <${t.organizer.email}>`,
    ])
    expect(message.text).not.toContain(NOTICE)
    expect(calendar(message).getFirstProperty('organizer')?.getFirstValue()).toBe(
      `mailto:${SENDER}`,
    )
    expect(
      calendar(message)
        .getAllProperties('attendee')
        .map((p) => p.getFirstValue()),
    ).toEqual([`mailto:${t.organizer.email}`, `mailto:${INVITEE}`])
  })
})
