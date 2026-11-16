import { createHash } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  cancelManagedBooking,
  createPublicBooking,
  getManagedBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverGroupHostMail } from './group-host-mail.ts'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotifier,
  type NotificationDeps,
  type NotificationKind,
  sendBookingNotification,
} from './index.ts'
import { headerValues, type RawMessage, rawMailCapture } from './testing/raw-mime.ts'
import { alignSmtpDateNowWithDatabase } from './testing-clock.ts'

// A group session: one host, one time, several invitees, each with an independent seat.
// Every assertion reads the raw MIME the real SMTP mailer wrote, every part decoded and every
// folded line joined, so an address hidden in an encoded header or a folded ICS line counts.

const SENDER = 'calendar@sender.example.test'
const NOW = Temporal.Instant.from('2027-11-01T12:00:00Z')
// Friday 5 November 2027: New York is still on daylight time (10:00 EDT = 14:00 UTC).
const START = Temporal.Instant.from('2027-11-05T14:00:00Z')
// Monday 8 November 2027, after the US change: 10:00 EST = 15:00 UTC, same wall clock.
const MOVED = Temporal.Instant.from('2027-11-08T15:00:00Z')

interface Person {
  name: string
  email: string
  timeZone: string
}
const ALPHA: Person = {
  name: 'Ivy Alphaname',
  email: 'ivy.alphaaddr@people.example.test',
  timeZone: 'America/New_York',
}
const OTHERS: Person[] = [
  { name: 'Oscar Bravoname', email: 'oscar.bravoaddr@people.example.test', timeZone: 'Asia/Tokyo' },
  {
    name: 'Pia Charliename',
    email: 'pia.charlieaddr@people.example.test',
    timeZone: 'Europe/Berlin',
  },
  { name: 'Dan Deltaname', email: 'dan.deltaaddr@people.example.test', timeZone: 'UTC' },
]

interface Seat {
  person: Person
  id: string
  root: string
  token: string
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()

function vevent(message: RawMessage) {
  if (!message.ics) throw new Error(`no calendar part for ${message.to}`)
  return new ICAL.Component(ICAL.parse(message.ics)).getFirstSubcomponent(
    'vevent',
  ) as ICAL.Component
}
const mailto = (value: string) => value.replace(/^mailto:/i, '').toLowerCase()

describe.skipIf(!process.env.DATABASE_URL)('group session mail and calendar privacy', () => {
  let fixture: TestDatabase
  let db: Db
  let f: Fixtures
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  let now: Temporal.Instant
  let deps: NotificationDeps
  let ctx: PublicContext
  let jobs: { bookingId: string; kind: NotificationKind; startAfter?: Temporal.Instant }[]

  beforeAll(async () => {
    fixture = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(fixture.pool)
    f = createFixtures(db)
    capture = await rawMailCapture(SENDER)
    deps = {
      db,
      secret: 'synthetic-group-session-secret',
      publicUrl: 'https://hourmere.example.test',
      now: () => now,
      log: () => {},
      mailer: capture.mailer,
    }
    ctx = {
      db,
      now: () => now,
      notify: bookingNotifier({
        async enqueue(name, payload, options) {
          expect(name).toBe(BOOKING_NOTIFICATION_JOB)
          if ('kind' in payload && !('requestId' in payload))
            jobs.push({
              bookingId: payload.bookingId,
              kind: payload.kind as NotificationKind,
              ...(options?.startAfter && {
                startAfter:
                  options.startAfter instanceof Date
                    ? Temporal.Instant.fromEpochMilliseconds(options.startAfter.getTime())
                    : options.startAfter,
              }),
            })
          return null
        },
      }),
    }
  })
  beforeEach(async () => {
    await alignSmtpDateNowWithDatabase(db)
    now = NOW
    capture.sent.length = 0
    jobs = []
    await db.deleteFrom('notification_email_sends').execute()
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await capture?.close()
    await fixture?.drop()
  })

  async function session(capacity = 3) {
    const host = await f.host({ name: 'Hana Hostname', timeZone: 'Europe/Berlin' })
    const hostEmail = `hana.hostaddr.${host.userId.slice(0, 8)}@team.example.test`
    await db
      .updateTable('auth.user')
      .set({ email: hostEmail })
      .where('id', '=', host.userId)
      .execute()
    await f.schedule(host.userId)
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'workshop',
      title: 'Pottery workshop',
      durationMinutes: 60,
      location: { kind: 'link', url: 'https://class.example.test/room' },
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: capacity })
      .where('id', '=', eventId)
      .execute()
    const book = (person: Person, start = START) =>
      createPublicBooking(ctx, {
        handle: host.handle,
        slug: 'workshop',
        start,
        invitee: person,
      })
    return { host: { ...host, email: hostEmail }, eventId, book }
  }

  /** Runs every queued booking notification that is due, as the worker would. */
  async function drain() {
    const due = jobs.filter(
      (j) => !j.startAfter || Temporal.Instant.compare(j.startAfter, now) <= 0,
    )
    jobs = jobs.filter((j) => !due.includes(j))
    for (const job of due) await sendBookingNotification(deps, job.bookingId, job.kind)
    return due
  }

  async function slotOf(bookingId: string) {
    return await db
      .selectFrom('bookings as b')
      .innerJoin('group_slots as s', 's.id', 'b.group_slot_id')
      .select(['s.id', 's.revision', 's.active_seats', 's.state'])
      .where('b.id', '=', bookingId)
      .executeTakeFirstOrThrow()
  }

  async function deliverHostCalendar(slot: string) {
    const row = await db
      .selectFrom('group_slot_host_messages')
      .select('id')
      .where('group_slot_id', '=', slot)
      .where('kind', '=', 'calendar')
      .executeTakeFirstOrThrow()
    await sql`UPDATE group_slot_host_messages SET next_attempt_at=${new Date(now.epochMilliseconds)} WHERE id=${row.id}`.execute(
      db,
    )
    await deliverGroupHostMail(deps, row.id)
  }

  const to = (email: string) => capture.sent.filter((m) => m.to === email)
  const one = (email: string) => {
    const messages = to(email)
    expect(messages, `exactly one message to ${email}`).toHaveLength(1)
    return messages[0] as RawMessage
  }

  /** Nothing in this message identifies any other seat of the session. */
  function expectOnlyOwnSeat(message: RawMessage, self: Seat, others: Seat[], hostEmail: string) {
    expect(message.envelope).toEqual([self.person.email])
    expect(headerValues(message, 'To').join(' ').toLowerCase()).toContain(self.person.email)
    expect(headerValues(message, 'Cc')).toEqual([])
    expect(headerValues(message, 'Bcc')).toEqual([])
    const replyTo = headerValues(message, 'Reply-To').join(' ').toLowerCase()
    expect(replyTo).toContain(hostEmail)
    for (const other of others) {
      const [local] = other.person.email.split('@') as [string]
      for (const secret of [
        other.person.email,
        local,
        ...other.person.name.toLowerCase().split(' '),
        other.id,
        other.root,
        other.token.toLowerCase(),
        encodeURIComponent(other.token).toLowerCase(),
      ])
        expect(message.text, `${self.person.email} must not see ${secret}`).not.toContain(
          secret.toLowerCase(),
        )
    }
    if (!message.ics) return
    const event = vevent(message)
    expect(event.getFirstPropertyValue('uid')).toBe(`${self.root}@hourmere`)
    expect(mailto(String(event.getFirstPropertyValue('organizer')))).toBe(SENDER)
    const attendees = event.getAllProperties('attendee')
    expect(attendees.map((a) => mailto(String(a.getFirstValue()))).sort()).toEqual(
      [hostEmail, self.person.email].sort(),
    )
    for (const attendee of attendees) expect(attendee.getParameter('rsvp')).toBe('FALSE')
    const chair = attendees.find((a) => mailto(String(a.getFirstValue())) === hostEmail)
    expect(chair?.getParameter('role')).toBe('CHAIR')
  }

  /** The management capability in this message, matched against its stored hash. */
  async function manageToken(bookingId: string, message: RawMessage) {
    const hashes = await db
      .selectFrom('booking_notifications')
      .select('manage_token_hash')
      .where('booking_id', '=', bookingId)
      .where('manage_token_hash', 'is not', null)
      .execute()
    const token = [...message.decoded.matchAll(/#token=([A-Za-z0-9_%-]{20,})/g)]
      .map((m) => decodeURIComponent(m[1] as string))
      .find((c) => hashes.some((h) => h.manage_token_hash?.equals(sha256(c))))
    if (!token) throw new Error(`no stored management capability for ${message.to}`)
    return token
  }

  it('keeps every seat private through joins, a full session, a DST move and the last exit', async () => {
    const s = await session(3)
    // The first seat creates the occurrence; the remaining seats race for the last two.
    const alpha = await s.book(ALPHA)
    const raced = await Promise.allSettled(OTHERS.map((person) => s.book(person)))
    const won = raced.flatMap((r, i) => (r.status === 'fulfilled' ? [{ r: r.value, i }] : []))
    const lost = raced.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(2)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'slot_taken' })
    const slot = await slotOf(alpha.booking.id)
    expect(slot).toMatchObject({ active_seats: 3, state: 'open' })

    // Deliver every confirmation twice, the second time concurrently: one message each.
    const confirmations = [...jobs]
    await drain()
    await Promise.all(
      confirmations
        .filter((j) => j.kind === 'confirmed')
        .flatMap((j) => [
          sendBookingNotification(deps, j.bookingId, 'confirmed'),
          sendBookingNotification(deps, j.bookingId, 'confirmed'),
        ]),
    )
    const people = [ALPHA, ...won.map((w) => OTHERS[w.i] as Person)]
    const ids = [alpha.booking.id, ...won.map((w) => w.r.booking.id)]
    const seats: Seat[] = []
    for (const [index, person] of people.entries()) {
      const id = ids[index] as string
      const message = one(person.email)
      seats.push({ person, id, root: id, token: await manageToken(id, message) })
    }
    for (const seat of seats) {
      const message = one(seat.person.email)
      expectOnlyOwnSeat(
        message,
        seat,
        seats.filter((s) => s !== seat),
        s.host.email,
      )
      expect(vevent(message).getFirstPropertyValue('sequence')).toBe(0)
      expect((await getManagedBooking(ctx, seat.token)).id).toBe(seat.id)
      expect(message.text).toContain('https://class.example.test/room')
    }
    // Before the US change: 10:00 New York daylight time.
    expect(one(ALPHA.email).decoded).toMatch(
      /Friday, November 5, 2027,\s10:00\sAM\s–\s11:00\sAM \(America\/New York, GMT-04:00\)/,
    )
    const loser = OTHERS[raced.findIndex((r) => r.status === 'rejected')] as Person
    expect(to(loser.email)).toEqual([])
    // Hosts get a per-seat notice without a calendar file; their calendar item is the slot's.
    const hostSeatMail = to(s.host.email)
    expect(hostSeatMail).toHaveLength(3)
    for (const message of hostSeatMail) expect(message.ics).toBeUndefined()

    // One coalesced host calendar item for the full session, delivered once.
    capture.sent.length = 0
    await Promise.all([deliverHostCalendar(slot.id), deliverHostCalendar(slot.id)])
    const hostIcs = one(s.host.email)
    let hostEvent = vevent(hostIcs)
    expect(hostEvent.getFirstPropertyValue('uid')).toBe(`group-${slot.id}@hourmere`)
    expect(hostEvent.getFirstPropertyValue('sequence')).toBe(Number(slot.revision))
    expect(hostIcs.text).toContain('booked seats: 3.')
    expect(mailto(String(hostEvent.getFirstPropertyValue('organizer')))).toBe(SENDER)
    // The sender is the pinned organizer here, so nobody sends on its behalf.
    expect(hostEvent.getFirstProperty('organizer')?.getParameter('sent-by')).toBeUndefined()
    expect(
      hostEvent.getAllProperties('attendee').map((a) => mailto(String(a.getFirstValue()))),
    ).toEqual([s.host.email])
    for (const seat of seats)
      for (const secret of [seat.person.email, seat.person.name.toLowerCase(), seat.id])
        expect(hostIcs.text).not.toContain(secret)
    const firstSequence = Number(slot.revision)

    // Move the New York seat across the US daylight-saving change: same wall clock.
    capture.sent.length = 0
    now = NOW.add({ hours: 1 })
    const [alphaSeat] = seats as [Seat, ...Seat[]]
    const moved = await rescheduleManagedBooking(ctx, alphaSeat.token, {
      start: MOVED,
      idempotencyKey: 'move-alpha-across-dst',
    })
    await drain()
    const rescheduled = one(ALPHA.email)
    const movedSeat: Seat = { ...alphaSeat, id: moved.booking.id }
    expectOnlyOwnSeat(rescheduled, movedSeat, seats.slice(1), s.host.email)
    // The same wall clock after the change, and the previous time in its own offset.
    expect(rescheduled.decoded).toMatch(
      /Monday, November 8, 2027,\s10:00\sAM\s–\s11:00\sAM \(America\/New York, GMT-05:00\)/,
    )
    expect(rescheduled.decoded).toMatch(
      /Friday, November 5, 2027,\s10:00\sAM\s–\s11:00\sAM \(America\/New York, GMT-04:00\)/,
    )
    const alphaEvent = vevent(rescheduled)
    expect(alphaEvent.getFirstPropertyValue('sequence')).toBe(1)
    expect(String(alphaEvent.getFirstPropertyValue('dtstart'))).toBe('2027-11-08T15:00:00Z')
    expect(String(vevent(one(ALPHA.email)).getFirstPropertyValue('uid'))).toBe(
      `${alphaSeat.root}@hourmere`,
    )
    for (const seat of seats.slice(1)) expect(to(seat.person.email)).toEqual([])
    const source = await slotOf(alphaSeat.id)
    const destination = await slotOf(moved.booking.id)
    expect(source).toMatchObject({ active_seats: 2, state: 'open' })
    expect(destination.id).not.toBe(source.id)
    capture.sent.length = 0
    await deliverHostCalendar(source.id)
    await deliverHostCalendar(destination.id)
    const [sourceIcs, destinationIcs] = to(s.host.email) as [RawMessage, RawMessage]
    hostEvent = vevent(sourceIcs)
    expect(hostEvent.getFirstPropertyValue('uid')).toBe(`group-${source.id}@hourmere`)
    expect(hostEvent.getFirstPropertyValue('sequence')).toBeGreaterThan(firstSequence)
    expect(sourceIcs.text).toContain('booked seats: 2.')
    expect(vevent(destinationIcs).getFirstPropertyValue('uid')).toBe(
      `group-${destination.id}@hourmere`,
    )
    expect(destinationIcs.text).toContain('booked seats: 1.')

    // The default reminder of a surviving seat goes to that invitee only.
    const [, bravo, charlie] = seats as [Seat, Seat, Seat]
    capture.sent.length = 0
    now = START.subtract({ hours: 24 })
    await sendBookingNotification(deps, bravo.id, 'reminder')
    const reminder = one(bravo.person.email)
    expect(capture.sent).toHaveLength(1)
    expectOnlyOwnSeat(reminder, bravo, [movedSeat, charlie], s.host.email)

    // A non-final exit: only that invitee's calendar entry is cancelled.
    capture.sent.length = 0
    now = NOW.add({ hours: 2 })
    await cancelManagedBooking(ctx, bravo.token)
    await drain()
    const bravoCancel = one(bravo.person.email)
    expectOnlyOwnSeat(bravoCancel, bravo, [movedSeat, charlie], s.host.email)
    expect(vevent(bravoCancel).getFirstPropertyValue('sequence')).toBe(1)
    expect(bravoCancel.raw).toMatch(/METHOD:CANCEL/)
    expect(to(charlie.person.email)).toEqual([])
    capture.sent.length = 0
    await deliverHostCalendar(source.id)
    const survivorIcs = one(s.host.email)
    expect(survivorIcs.ics).toMatch(/METHOD:REQUEST/)
    expect(survivorIcs.text).toContain('booked seats: 1.')

    // The last exit cancels the host's slot item; the moved seat's chain cancels on its UID.
    capture.sent.length = 0
    await cancelManagedBooking(ctx, charlie.token)
    await cancelManagedBooking(ctx, alphaSeat.token)
    await drain()
    expect(vevent(one(charlie.person.email)).getFirstPropertyValue('sequence')).toBe(1)
    const alphaCancel = vevent(one(ALPHA.email))
    expect(alphaCancel.getFirstPropertyValue('uid')).toBe(`${alphaSeat.root}@hourmere`)
    expect(alphaCancel.getFirstPropertyValue('sequence')).toBe(2)
    capture.sent.length = 0
    await deliverHostCalendar(source.id)
    await deliverHostCalendar(destination.id)
    const finals = to(s.host.email)
    expect(finals).toHaveLength(2)
    for (const message of finals) expect(message.ics).toMatch(/METHOD:CANCEL/)
    expect((await slotOf(charlie.id)).state).toBe('retired')
  })

  it('keeps one message per seat and one current host item when seats come and go at once', async () => {
    // Room for every arrival whichever way the race goes.
    const s = await session(4)
    const [bravoPerson, charliePerson, deltaPerson] = OTHERS as [Person, Person, Person]
    const a = await s.book(ALPHA)
    const b = await s.book(bravoPerson)
    await drain()
    const tokens = {
      a: await manageToken(a.booking.id, one(ALPHA.email)),
      b: await manageToken(b.booking.id, one(bravoPerson.email)),
    }
    const first = await slotOf(a.booking.id)
    await deliverHostCalendar(first.id)
    const pinned = vevent(to(s.host.email).at(-1) as RawMessage)
    expect(pinned.getFirstPropertyValue('sequence')).toBe(Number(first.revision))

    // A later MAIL_FROM signs as SENT-BY; the pinned organizer of every UID stays, and
    // only a UID first sent after the change pins the new mailbox.
    const LATER = 'later-sender@sender.example.test'
    const expectOrganizer = (event: ICAL.Component, pinnedBefore: boolean) => {
      const organizer = event.getFirstProperty('organizer')
      expect(mailto(String(organizer?.getFirstValue()))).toBe(pinnedBefore ? SENDER : LATER)
      if (pinnedBefore) expect(mailto(String(organizer?.getParameter('sent-by')))).toBe(LATER)
      else expect(organizer?.getParameter('sent-by')).toBeUndefined()
    }
    const later = await rawMailCapture(LATER)
    try {
      deps.mailer = later.mailer
      capture.sent.length = 0
      // Both seats leave while two more arrive, all at once.
      const settled = await Promise.allSettled([
        cancelManagedBooking(ctx, tokens.a),
        cancelManagedBooking(ctx, tokens.b),
        s.book(charliePerson),
        s.book(deltaPerson),
      ])
      expect(settled.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ])
      const c = (settled[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof s.book>>>).value
      const d = (settled[3] as PromiseFulfilledResult<Awaited<ReturnType<typeof s.book>>>).value
      const queued = jobs.filter((j) => !j.startAfter)
      await drain()
      // A replayed worker run sends nothing new.
      for (const job of queued) await sendBookingNotification(deps, job.bookingId, job.kind)
      const people: [Person, string][] = [
        [ALPHA, a.booking.id],
        [bravoPerson, b.booking.id],
        [charliePerson, c.booking.id],
        [deltaPerson, d.booking.id],
      ]
      for (const [person, id] of people) {
        const messages = later.sent.filter((m) => m.to === person.email)
        expect(messages, person.email).toHaveLength(1)
        const message = messages[0] as RawMessage
        expect(message.envelope).toEqual([person.email])
        for (const [other, otherId] of people.filter(([p]) => p !== person))
          for (const secret of [other.email, other.name.toLowerCase(), otherId])
            expect(message.text).not.toContain(secret)
        const event = vevent(message)
        expect(event.getFirstPropertyValue('uid')).toBe(`${id}@hourmere`)
        expectOrganizer(event, id === a.booking.id || id === b.booking.id)
      }
      // However the race ordered itself, every slot involved ends with one current item.
      const slots = new Set<string>()
      for (const [, id] of people) slots.add((await slotOf(id)).id)
      later.sent.length = 0
      for (const slot of slots) {
        await Promise.all([deliverHostCalendar(slot), deliverHostCalendar(slot)])
        await deliverHostCalendar(slot)
      }
      const hostItems = later.sent.filter((m) => m.to === s.host.email)
      expect(hostItems).toHaveLength(slots.size)
      for (const message of hostItems) {
        const event = vevent(message)
        const slot = String(event.getFirstPropertyValue('uid')).replace(/^group-|@hourmere$/g, '')
        const current = await db
          .selectFrom('group_slots')
          .select(['revision', 'state', 'active_seats'])
          .where('id', '=', slot)
          .executeTakeFirstOrThrow()
        expect(event.getFirstPropertyValue('sequence')).toBe(Number(current.revision))
        expect(message.ics).toMatch(current.state === 'open' ? /METHOD:REQUEST/ : /METHOD:CANCEL/)
        if (current.state === 'open')
          expect(message.text).toContain(`booked seats: ${current.active_seats}.`)
        expectOrganizer(event, slot === first.id)
        for (const [person, id] of people)
          for (const secret of [person.email, person.name.toLowerCase(), id])
            expect(message.text).not.toContain(secret)
      }
      if (slots.has(first.id))
        expect(
          Number(
            (
              await db
                .selectFrom('group_slots')
                .select('revision')
                .where('id', '=', first.id)
                .executeTakeFirstOrThrow()
            ).revision,
          ),
        ).toBeGreaterThan(Number(first.revision))
    } finally {
      deps.mailer = capture.mailer
      await later.close()
    }
  })

  it('stays a single-host booking, so the collective no-host-address rule never applies', async () => {
    // Seat mail names exactly one host (Reply-To and CHAIR), the single-host rule. The
    // database keeps it that way: a group event cannot become collective or take guests.
    const s = await session(3)
    for (const change of [{ scheduling_type: 'collective' }, { allow_guests: true }])
      await expect(
        db.updateTable('event_types').set(change).where('id', '=', s.eventId).execute(),
      ).rejects.toMatchObject({ constraint: 'event_types_group_capacity' })
  })
})
