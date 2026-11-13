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

// Invitees and guests of a collective booking reply to, and see in their calendar invitation,
// only the organizer, as with a single host. Co-host account addresses never reach them.
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

  /** A team with three required hosts; the organizer is the first by user ID. */
  async function team(hostCount = 3) {
    const created = []
    for (let i = 0; i < hostCount; i++) created.push(await f.host({ name: `Host ${i}` }))
    const organizationId = (created[0] as { organizationId: string }).organizationId
    for (const extra of created.slice(1)) await f.member(extra.userId, organizationId)
    const ids = created.map((h) => h.userId).sort()
    const names = ['Olivia Organizer', 'Carl Cohost', 'Cora Cohost']
    const hosts = []
    for (const [index, id] of ids.entries()) {
      // Distinct tokens: a partial or encoded leak still contains one of them.
      const token = `${index === 0 ? 'primaryhost' : `cohostaddr${index}`}${id.slice(0, 8)}`
      const email = `${token}@team.example.test`
      const name = names[index] as string
      await db.updateTable('auth.user').set({ name, email }).where('id', '=', id).execute()
      hosts.push({ id, email, token, name })
    }
    const [organizer, ...coHosts] = hosts as [(typeof hosts)[number], ...typeof hosts]
    return { organizationId, ids, organizer, coHosts, hosts }
  }

  async function book(
    t: Awaited<ReturnType<typeof team>>,
    start = START,
    end = END,
    rescheduledFrom?: string,
  ) {
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

  const attendeeMail = () => sent.filter((m) => m.to === INVITEE || m.to === GUEST)
  const hostMail = (email: string) => sent.filter((m) => m.to === email)

  /** The privacy contract, plus positive controls that the decoded search is meaningful. */
  function expectNoCoHostAddress(t: Awaited<ReturnType<typeof team>>, message: Raw) {
    // Positive control: the recipient's own address is found in the decoded message.
    expect(message.text).toContain(message.to.toLowerCase())
    for (const coHost of t.coHosts) {
      expect(message.text, `${coHost.email} in mail to ${message.to}`).not.toContain(
        coHost.token.toLowerCase(),
      )
    }
    for (const line of header(message, 'Reply-To'))
      for (const coHost of t.coHosts) expect(line.toLowerCase()).not.toContain(coHost.token)
  }

  it('keeps co-host addresses out of every lifecycle mail kind, headers, bodies and ICS, across a reschedule chain', async () => {
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
    const invitee = attendeeMail()
    expect(invitee).toHaveLength(8)
    for (const message of invitee) {
      expectNoCoHostAddress(t, message)
      // Reply-To is the organizer alone, as for a single host.
      expect(header(message, 'Reply-To')).toEqual([
        `Reply-To: ${t.organizer.name} <${t.organizer.email}>`,
      ])
      // Every host is still named in the body.
      for (const host of t.hosts) expect(message.text).toContain(host.name.toLowerCase())
    }

    // Calendar identity is unchanged: one UID; SEQUENCE follows the chain.
    const invitations = invitee.filter((m) => m.ics)
    expect(invitations).toHaveLength(6)
    for (const message of invitations) {
      const event = calendar(message)
      expect(event.getFirstPropertyValue('uid')).toBe(`${original}@hourmere`)
      expect(event.getFirstProperty('organizer')?.getFirstValue()).toBe(`mailto:${SENDER}`)
      expect(event.getFirstProperty('organizer')?.getParameter('cn')).toBe(t.organizer.name)
      const attendees = event
        .getAllProperties('attendee')
        .map((p) => [p.getFirstValue(), p.getParameter('role'), p.getParameter('rsvp')])
      expect(attendees).toEqual([
        [`mailto:${t.organizer.email}`, 'CHAIR', 'FALSE'],
        [`mailto:${INVITEE}`, 'REQ-PARTICIPANT', 'FALSE'],
        [`mailto:${GUEST}`, 'REQ-PARTICIPANT', 'FALSE'],
      ])
      // Co-hosts are named, without addresses, in SUMMARY (invitee) and DESCRIPTION.
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

  it('keeps co-host addresses out of the conference-failure notice', async () => {
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
    for (const message of invitee) {
      expectNoCoHostAddress(t, message)
      expect(message.ics).toBeUndefined()
      expect(header(message, 'Reply-To')).toEqual([
        `Reply-To: ${t.organizer.name} <${t.organizer.email}>`,
      ])
    }
  })

  it('keeps co-host addresses out of configured reminders and follow-ups', async () => {
    const t = await team()
    const id = await book(t)
    const roles = { host: true, invitee: true, guests: true }
    const settings: NotificationSettings = {
      reminders: [{ id: 'before', offsetMinutes: 120, recipients: roles }],
      followUps: [{ id: 'after', offsetMinutes: 5, recipients: roles }],
    }
    await db
      .updateTable('bookings')
      .set({ notification_snapshot: JSON.stringify(createNotificationSnapshot(settings)) })
      .where('id', '=', id)
      .execute()
    const queue: Partial<ScheduledEmailQueue> = { enqueue: async () => randomUUID() }
    await db.transaction().execute((trx) => enqueueScheduledBookingEmails(queue, trx, id, NOW))
    const rows = await db
      .selectFrom('booking_scheduled_messages')
      .select(['id', 'kind', 'due_at'])
      .where('booking_id', '=', id)
      .orderBy('due_at')
      .execute()
    expect(rows.map((r) => r.kind)).toEqual(['reminder', 'follow_up'])
    for (const row of rows) {
      now = Temporal.Instant.fromEpochMilliseconds(row.due_at.getTime())
      const before = sent.length
      await deliverScheduledBookingEmail(deps, row.id)
      const batch = sent.slice(before)
      expect(batch).toHaveLength(5)
      for (const message of batch.filter((m) => m.to === INVITEE || m.to === GUEST)) {
        expectNoCoHostAddress(t, message)
        expect(header(message, 'Reply-To')).toEqual([
          `Reply-To: ${t.organizer.name} <${t.organizer.email}>`,
        ])
      }
      for (const host of t.hosts)
        expect(header(hostMail(host.email).at(-1) as Raw, 'Reply-To')).toEqual([
          `Reply-To: Ivy Invitee <${INVITEE}>`,
        ])
    }
  })

  it('keeps co-host addresses out of the reschedule request sent to the invitee', async () => {
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
    expectNoCoHostAddress(t, sent[0] as Raw)
    expect(header(sent[0] as Raw, 'Reply-To')).toEqual([])
  })

  it('removes co-host addresses from later mail of a legacy (v1) collective root and keeps its pinned organizer', async () => {
    const t = await team()
    const original = await book(t)
    await db
      .updateTable('bookings')
      .set({
        ical_version: 1,
        ical_organizer_name: t.organizer.name,
        ical_organizer_email: t.organizer.email,
      })
      .where('id', '=', original)
      .execute()
    await cancel(original)
    const moved = await book(t, START.add({ hours: 24 }), END.add({ hours: 24 }), original)
    await sendBookingNotification(deps, moved, 'rescheduled')
    await cancel(moved)
    await sendBookingNotification(deps, moved, 'cancelled')
    const invitee = attendeeMail()
    expect(invitee).toHaveLength(4)
    for (const message of invitee) {
      expectNoCoHostAddress(t, message)
      const event = calendar(message)
      expect(event.getFirstPropertyValue('uid')).toBe(`${original}@hourmere`)
      // The pinned v1 ORGANIZER is retained, so clients update rather than duplicate.
      expect(event.getFirstProperty('organizer')?.getFirstValue()).toBe(
        `mailto:${t.organizer.email}`,
      )
      expect(event.getFirstProperty('organizer')?.getParameter('sent-by')).toBe(`mailto:${SENDER}`)
      expect(event.getAllProperties('attendee').map((p) => p.getFirstValue())).toEqual([
        `mailto:${INVITEE}`,
        `mailto:${GUEST}`,
      ])
    }
    expect(invitee.map((m) => calendar(m).getFirstPropertyValue('sequence'))).toEqual([1, 1, 2, 2])
    // Legacy host invitations still list the other hosts.
    for (const host of t.hosts)
      for (const message of hostMail(host.email))
        for (const other of t.hosts.filter((h) => h.id !== host.id && h.id !== t.organizer.id))
          expect(message.text).toContain(other.token)
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
    expect(
      calendar(message)
        .getAllProperties('attendee')
        .map((p) => p.getFirstValue()),
    ).toEqual([`mailto:${t.organizer.email}`, `mailto:${INVITEE}`])
  })
})
