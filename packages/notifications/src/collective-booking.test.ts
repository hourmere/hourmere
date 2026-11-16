import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sendBookingNotification } from './index.ts'

const now = Temporal.Instant.from('2026-11-01T12:00Z')
const languages = [
  ['en', 'Liam LA and Berta Berlin', 'Co-hosts'],
  ['zh-CN', 'Liam LA和Berta Berlin', '共同主持人'],
  ['de', 'Liam LA und Berta Berlin', 'Weitere gastgebende Personen'],
  ['fr', 'Liam LA et Berta Berlin', 'Autres hôtes'],
  ['es', 'Liam LA y Berta Berlin', 'Otros anfitriones'],
  ['pt-BR', 'Liam LA e Berta Berlin', 'Outros anfitriões'],
] as const
function event(message: MailMessage) {
  const calendar = new ICAL.Component(ICAL.parse(message.attachments?.[0]?.content ?? ''))
  return calendar.getFirstSubcomponent('vevent') as ICAL.Component
}

describe.skipIf(!process.env.DATABASE_URL)('collective booking notification delivery', () => {
  let fixture: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    fixture = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'collective_mail',
    })
    db = createDb(fixture.pool)
    f = createFixtures(db)
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
  })
  afterAll(async () => {
    await fixture?.drop()
  })

  it.each(languages)(
    '%s carries all hosts through confirm, remind, reschedule and cancel',
    async (locale, names, coHostLabel) => {
      const first = await f.host({ name: 'Liam LA', timeZone: 'America/Los_Angeles' })
      const second = await f.host({ name: 'Berta Berlin', timeZone: 'Europe/Berlin' })
      await f.member(second.userId, first.organizationId)
      const ordered = [first.userId, second.userId].sort()
      // Host ordering is stable by user ID; assign fixture names to that order.
      const [liam, berta] = ordered
      if (!liam || !berta) throw new Error('Missing fixture host')
      await db
        .updateTable('auth.user')
        .set({ name: 'Liam LA', email: `liam-${liam}@example.test` })
        .where('id', '=', liam)
        .execute()
      await db
        .updateTable('auth.user')
        .set({ name: 'Berta Berlin', email: `berta-${berta}@example.test` })
        .where('id', '=', berta)
        .execute()
      await db.updateTable('profiles').set({ locale }).where('user_id', 'in', ordered).execute()
      const sent: MailMessage[] = []
      const deps = {
        db,
        secret: 'synthetic-collective-mail-secret',
        publicUrl: 'https://hourmere.example.test',
        now: () => now,
        mailer: {
          senderEmail: 'calendar@example.test',
          async send(message: MailMessage) {
            sent.push(message)
          },
        },
      }
      async function booking(start: string, end: string) {
        const id = await f.booking(first.organizationId, ordered, start, end, {
          attendee: { name: 'Ivy Invitee', email: 'ivy@example.test' },
        })
        await db
          .updateTable('booking_attendees')
          .set({ locale, time_zone: 'Asia/Shanghai' })
          .where('booking_id', '=', id)
          .execute()
        return id
      }
      const original = await booking('2026-11-04T17:00Z', '2026-11-04T17:30Z')
      await sendBookingNotification(deps, original, 'confirmed')
      await sendBookingNotification(deps, original, 'reminder')
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: new Date(now.epochMilliseconds) })
        .where('id', '=', original)
        .execute()
      const moved = await booking('2026-11-05T17:00Z', '2026-11-05T17:30Z')
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: original })
        .where('id', '=', moved)
        .execute()
      await sendBookingNotification(deps, moved, 'rescheduled')
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: new Date(now.epochMilliseconds) })
        .where('id', '=', moved)
        .execute()
      await sendBookingNotification(deps, moved, 'cancelled')
      expect(sent).toHaveLength(12)
      for (const message of sent) {
        expect(message.text).not.toContain(first.organizationId)
        expect(message.html).not.toContain(first.organizationId)
        if (message.to === 'ivy@example.test') {
          expect(message.subject).toContain(names)
          expect(message.text).toContain(names)
          // No host address reaches the invitee of a collective booking.
          expect(message.replyTo).toBeUndefined()
        } else {
          expect(message.text).toContain(coHostLabel)
          expect(message.text).toContain(
            message.to.startsWith('liam-') ? 'Berta Berlin' : 'Liam LA',
          )
          expect(message.text).not.toContain(`liam-${liam}@example.test`)
          expect(message.text).not.toContain(`berta-${berta}@example.test`)
          expect(message.replyTo).toEqual({ name: 'Ivy Invitee', email: 'ivy@example.test' })
          expect(message.text).not.toContain('organizationId=')
          expect(message.html).not.toContain('organizationId=')
        }
        if (message.attachments?.length) {
          const component = event(message)
          if (message.to === 'ivy@example.test')
            expect(component.getFirstPropertyValue('summary')).toContain(names)
          expect(component.getFirstPropertyValue('description')).toContain(names)
          expect(component.getFirstProperty('organizer')?.getParameter('cn')).toBe('Liam LA')
          expect(component.getFirstProperty('organizer')?.getFirstValue()).toBe(
            'mailto:calendar@example.test',
          )
          expect(component.getAllProperties('attendee')).toHaveLength(
            message.to === 'ivy@example.test' ? 1 : 3,
          )
        }
      }
    },
  )

  it('never substitutes an unlabelled co-host email for a visible name', async () => {
    const first = await f.host({ name: 'Liam LA' })
    const second = await f.host({ name: 'Berta Berlin', handle: null })
    await f.member(second.userId, first.organizationId)
    await db.updateTable('auth.user').set({ name: '' }).where('id', '=', second.userId).execute()
    const id = await f.booking(
      first.organizationId,
      [first.userId, second.userId],
      '2026-11-06T17:00Z',
      '2026-11-06T17:30Z',
    )
    const sent: MailMessage[] = []
    await sendBookingNotification(
      {
        db,
        secret: 'synthetic-collective-mail-secret',
        publicUrl: 'https://hourmere.example.test',
        now: () => now,
        mailer: {
          async send(message) {
            sent.push(message)
          },
        },
      },
      id,
      'confirmed',
    )
    const firstUser = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', first.userId)
      .executeTakeFirstOrThrow()
    const secondUser = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', second.userId)
      .executeTakeFirstOrThrow()
    const mail = sent.find((message) => message.to === firstUser.email)
    expect(mail?.text).toContain('Co-hosts: Host')
    expect(mail?.text).not.toContain(secondUser.email)
  })
})
