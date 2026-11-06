import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createNotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertSeat,
  insertSlot,
  occupiedSlot,
  transaction,
} from '../../db/src/group-seats-fixtures.ts'
import {
  conferenceNotificationAllowed,
  dispatchConferenceNotifications,
  loadNotificationData,
  sendBookingNotification,
} from './index.ts'
import { deliverScheduledBookingEmail, enqueueScheduledBookingEmails } from './scheduled.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2031-12-30T10:00:00Z')
describe.skipIf(!serverUrl)('group seat mail privacy', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it('sends independent confirmations, cancellation and reminders with seat-only ICS and capabilities', async () => {
    const f = await groupFixture(owned.pool)
    await owned.pool.query(
      'INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,\'owner\',now())',
      [f.organization, f.host],
    )
    const { slot, bookings } = await occupiedSlot(f, 2)
    const [first, second] = bookings as [string, string]
    await owned.pool.query('UPDATE booking_attendees SET name=$2 WHERE booking_id=$1', [
      first,
      'First attendee private name',
    ])
    await owned.pool.query('UPDATE booking_attendees SET name=$2 WHERE booking_id=$1', [
      second,
      'Second attendee private name',
    ])
    const a = await loadNotificationData(db, first)
    const b = await loadNotificationData(db, second)
    expect(a?.hosts.map((h) => h.id)).toEqual([f.host])
    expect(a?.booking.groupSlotId).toBe(slot)
    expect(a?.attendees).toHaveLength(1)
    const messages: MailMessage[] = []
    const deps = {
      db,
      now: () => now,
      secret: 'group-seat-test-secret',
      publicUrl: 'https://example.test',
      mailer: {
        senderEmail: 'sender@example.test',
        async send(message: MailMessage) {
          messages.push(message)
        },
      },
    }
    await sendBookingNotification(deps, first, 'confirmed')
    await sendBookingNotification(deps, second, 'confirmed')
    await sendBookingNotification(deps, first, 'confirmed')
    expect(messages).toHaveLength(4)
    const firstMail = messages.find((m) => m.to === a?.attendees[0]?.email)
    const secondMail = messages.find((m) => m.to === b?.attendees[0]?.email)
    expect(firstMail).toBeDefined()
    expect(secondMail).toBeDefined()
    expect(JSON.stringify(firstMail)).not.toContain(b?.attendees[0]?.email)
    expect(JSON.stringify(firstMail)).not.toContain('Second attendee private name')
    expect(JSON.stringify(firstMail)).not.toContain(second)
    expect(JSON.stringify(secondMail)).not.toContain(a?.attendees[0]?.email)
    expect(JSON.stringify(secondMail)).not.toContain('First attendee private name')
    expect(firstMail?.attachments?.[0]?.content).toContain(`UID:${first}@hourmere`)
    expect(secondMail?.attachments?.[0]?.content).toContain(`UID:${second}@hourmere`)
    expect(firstMail?.text).toMatch(/#token=/)
    expect(firstMail?.text.match(/#token=([^&]+)/)?.[1]).not.toBe(
      secondMail?.text.match(/#token=([^&]+)/)?.[1],
    )
    for (const hostMail of messages.filter((m) => m.to === a?.hosts[0]?.email))
      expect(hostMail.attachments).toBeUndefined()
    messages.length = 0
    await sendBookingNotification(deps, first, 'reminder')
    await sendBookingNotification(deps, second, 'reminder')
    expect(messages.map((m) => m.to).sort()).toEqual(
      [a?.attendees[0]?.email, b?.attendees[0]?.email].sort(),
    )
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [first],
    )
    messages.length = 0
    await sendBookingNotification(deps, first, 'cancelled')
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages)).not.toContain(b?.attendees[0]?.email)
    expect(
      messages.find((m) => m.to === a?.attendees[0]?.email)?.attachments?.[0]?.content,
    ).toContain('METHOD:CANCEL')
    expect(
      (await owned.pool.query('SELECT state,active_seats FROM group_slots WHERE id=$1', [slot]))
        .rows,
    ).toEqual([{ state: 'open', active_seats: 1 }])
  })
  it('releases each live seat after shared readiness without count updates resending or cancelled seats receiving links', async () => {
    const f = await groupFixture(owned.pool)
    await owned.pool.query(
      'INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,\'owner\',now())',
      [f.organization, f.host],
    )
    const location = { kind: 'google_meet', autoCreate: true }
    const { slot, first, second } = await transaction(owned.pool, async (client) => {
      const slot = await insertSlot(client, f, {
        location,
        location_option: { id: 'legacy', ...location },
      })
      await client.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
        slot,
        f.host,
      ])
      const first = await insertSeat(client, f, slot, 'first-conference@example.test', { location })
      const second = await insertSeat(client, f, slot, 'second-conference@example.test', {
        location,
      })
      return { slot, first, second }
    })
    const host = await db
      .selectFrom('auth.user')
      .select(['name', 'email'])
      .where('id', '=', f.host)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('group_slot_conferences')
      .values({
        group_slot_id: slot,
        organization_id: f.organization,
        organizer_user_id: f.host,
        provider: 'google_meet',
        invitation_organizer_name: host.name,
        invitation_organizer_email: host.email,
      })
      .execute()
    for (const booking of [first, second])
      await db
        .insertInto('booking_conference_notifications')
        .values({ booking_id: booking, kind: 'confirmed', due_at: new Date(now.epochMilliseconds) })
        .execute()
    const sent: MailMessage[] = []
    const deps = {
      db,
      now: () => now,
      secret: 'group-conference-test-secret',
      publicUrl: 'https://example.test',
      mailer: {
        senderEmail: 'sender@example.test',
        async send(message: MailMessage) {
          sent.push(message)
        },
      },
    }
    expect(await conferenceNotificationAllowed(db, first, 'confirmed')).toBe(false)
    await dispatchConferenceNotifications(deps)
    expect(sent).toHaveLength(0)
    await db
      .updateTable('group_slot_conferences')
      .set({ state: 'ready', applied_revision: 1, join_url: 'https://meet.google.com/shared-link' })
      .where('group_slot_id', '=', slot)
      .execute()
    await dispatchConferenceNotifications(deps)
    expect(sent).toHaveLength(4)
    for (const message of sent.filter((m) => m.to !== host.email)) {
      expect(message.text).toContain('https://meet.google.com/shared-link')
      expect(JSON.stringify(message)).not.toContain(
        message.to === 'first-conference@example.test'
          ? 'second-conference@example.test'
          : 'first-conference@example.test',
      )
    }
    const before = (await loadNotificationData(db, second))?.conferenceRevision
    await owned.pool.query(
      "UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1",
      [first],
    )
    expect((await loadNotificationData(db, first))?.booking.location).toBeNull()
    expect(await conferenceNotificationAllowed(db, first, 'reminder')).toBe(false)
    expect(await conferenceNotificationAllowed(db, second, 'reminder')).toBe(true)
    expect((await loadNotificationData(db, second))?.conferenceRevision).toBe(before)
    sent.length = 0
    await dispatchConferenceNotifications(deps)
    expect(sent).toHaveLength(0)
    await sendBookingNotification(deps, second, 'reminder')
    expect(sent.map((m) => m.to)).toEqual(['second-conference@example.test'])
    expect(sent[0]?.text).toContain('https://meet.google.com/shared-link')
  })
  it('configured reminders deliver once per seat without duplicating the slot host recipient', async () => {
    const f = await groupFixture(owned.pool)
    await owned.pool.query(
      'INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,\'owner\',now())',
      [f.organization, f.host],
    )
    const { bookings } = await occupiedSlot(f, 2)
    const snapshot = createNotificationSnapshot({
      reminders: [
        {
          id: 'reminder',
          offsetMinutes: 1440,
          recipients: { host: true, invitee: true, guests: false },
        },
      ],
      followUps: [],
    })
    await db
      .updateTable('bookings')
      .set({ notification_snapshot: JSON.stringify(snapshot) })
      .where('id', 'in', bookings)
      .execute()
    const messageIds: string[] = []
    await db.transaction().execute(async (trx) => {
      for (const booking of bookings)
        await enqueueScheduledBookingEmails(
          {
            async enqueue(_name, payload) {
              messageIds.push(payload.messageId)
              return randomUUID()
            },
          },
          trx,
          booking,
          now,
        )
    })
    const sent: MailMessage[] = []
    const deps = {
      db,
      now: () => Temporal.Instant.from('2032-01-01T10:00:01Z'),
      secret: 'group-configured-test-secret',
      publicUrl: 'https://example.test',
      mailer: {
        async send(message: MailMessage) {
          sent.push(message)
        },
      },
    }
    for (const id of messageIds) await deliverScheduledBookingEmail(deps, id)
    expect(sent).toHaveLength(2)
    const invitees = (
      await db
        .selectFrom('booking_attendees')
        .select('email')
        .where('booking_id', 'in', bookings)
        .execute()
    )
      .map((a) => a.email)
      .sort()
    expect(sent.map((m) => m.to).sort()).toEqual(invitees)
    for (const message of sent)
      for (const email of invitees.filter((e) => e !== message.to))
        expect(JSON.stringify(message)).not.toContain(email)
    for (const id of messageIds) await deliverScheduledBookingEmail(deps, id)
    expect(sent).toHaveLength(2)
  })
})
