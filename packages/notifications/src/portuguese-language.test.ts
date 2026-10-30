import { acceptLanguage } from '@hourmere/core/language'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer, MailMessage } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type NotificationDeps, sendBookingNotification } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
const start = Temporal.Instant.from('2026-11-03T13:00:00Z')

function invitation(message: MailMessage) {
  const content = message.attachments?.[0]?.content
  expect(content).toBeDefined()
  const calendar = new ICAL.Component(ICAL.parse(content as string))
  const event = calendar.getFirstSubcomponent('vevent')
  return {
    method: calendar.getFirstPropertyValue('method'),
    summary: event?.getFirstPropertyValue('summary'),
    description: event?.getFirstPropertyValue('description'),
    uid: event?.getFirstPropertyValue('uid'),
    sequence: event?.getFirstPropertyValue('sequence'),
  }
}

describe.skipIf(!serverUrl)('Brazilian Portuguese booking notification language', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: Fixtures
  let context: PublicContext
  const sent: MailMessage[] = []
  const mailer: Mailer = {
    senderEmail: 'calendar@example.org',
    async send(message) {
      sent.push(message)
    },
  }
  const deps = (): NotificationDeps => ({
    db,
    mailer,
    publicUrl: 'https://cal.example.org',
    secret: 'synthetic-portuguese-notification-secret',
    now: () => now,
    log: () => {},
  })

  beforeAll(async () => {
    // All scenarios share the helper's one bounded pool; no auth or worker pool is needed.
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
    context = { db, now: () => now }
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
    sent.length = 0
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function book(locale: string, hostLocale = 'en', guests = false) {
    const host = await fixtures.host({ name: 'Grace Hopper', timeZone: 'America/Sao_Paulo' })
    await db
      .updateTable('profiles')
      .set({ locale: hostLocale })
      .where('user_id', '=', host.userId)
      .execute()
    await fixtures.schedule(host.userId, { timeZone: 'America/Sao_Paulo' })
    await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro call',
      allowGuests: guests,
    })
    const result = await createPublicBooking(context, {
      handle: host.handle,
      slug: 'intro',
      start,
      invitee: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        timeZone: 'America/Sao_Paulo',
        locale,
      },
      guests: guests ? [{ name: 'Alex', email: 'alex@example.com' }] : [],
    })
    const hostRow = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', host.userId)
      .executeTakeFirstOrThrow()
    return { ...result, hostEmail: hostRow.email }
  }

  const storedLocale = async (bookingId: string) =>
    (
      await db
        .selectFrom('booking_attendees')
        .select('locale')
        .where('booking_id', '=', bookingId)
        .where('is_booker', '=', true)
        .executeTakeFirstOrThrow()
    ).locale

  it.each(['pt-BR', 'pt', 'PT-br', 'pt-Latn-BR', 'pt-AO'])(
    'delivers the stored %s booking choice to the invitee and guests',
    async (locale) => {
      const booked = await book(locale, 'en', true)
      expect(await storedLocale(booked.booking.id)).toBe(locale)
      await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
      expect(sent).toHaveLength(3)
      const host = sent.find((message) => message.to === booked.hostEmail)
      expect(host?.subject).toMatch(/^New booking: /)
      expect(host?.html).toContain('<html lang="en">')
      for (const email of ['ada@example.com', 'alex@example.com']) {
        const message = sent.find((candidate) => candidate.to === email)
        expect(message).toBeDefined()
        expect(message?.subject).toMatch(/^Confirmado: Intro call com Grace Hopper — /)
        expect(message?.text).toContain('Sua reunião com Grace Hopper está agendada.')
        expect(message?.text).toContain('terça-feira, 3 de novembro de 2026')
        expect(message?.text).toContain('10:00')
        expect(message?.html).toContain('<html lang="pt-BR">')
        expect(message?.html).toContain('Sua reunião com Grace Hopper está agendada.')
        expect(invitation(message as MailMessage)).toMatchObject({
          summary: 'Intro call com Grace Hopper',
          description: expect.stringContaining('Agendado com Grace Hopper pelo Hourmere.'),
          method: 'REQUEST',
          sequence: 0,
        })
      }
    },
  )

  it('delivers a negotiated language choice through booking storage to email', async () => {
    const locale = acceptLanguage('qaa,pt-BR;q=0.9,en;q=0.5', 'public')
    expect(locale).toBe('pt-BR')
    const booked = await book(locale)
    expect(await storedLocale(booked.booking.id)).toBe('pt-BR')
    await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
    const invitee = sent.find((message) => message.to === 'ada@example.com')
    expect(invitee?.html).toContain('<html lang="pt-BR">')
    expect(invitee?.subject).toMatch(/^Confirmado: /)
  })

  it('skips a European Portuguese negotiation preference before storing the chosen language', async () => {
    const locale = acceptLanguage('pt-PT,fr;q=0.8,en;q=0.5', 'public')
    expect(locale).toBe('fr')
    const booked = await book(locale)
    expect(await storedLocale(booked.booking.id)).toBe('fr')
    await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
    expect(sent.find((message) => message.to === 'ada@example.com')?.html).toContain(
      '<html lang="fr">',
    )
  })

  it('uses a Brazilian Portuguese host profile independently of the English booking choice', async () => {
    const booked = await book('en', 'pt-BR')
    await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
    expect(sent).toHaveLength(2)
    const host = sent.find((message) => message.to === booked.hostEmail)
    const invitee = sent.find((message) => message.to === 'ada@example.com')
    expect(host?.subject).toMatch(/^Novo agendamento: Intro call com Ada Lovelace — /)
    expect(host?.text).toContain('Ada Lovelace agendou uma reunião com você.')
    expect(host?.html).toContain('<html lang="pt-BR">')
    expect(invitation(host as MailMessage).summary).toBe('Intro call com Ada Lovelace')
    expect(invitee?.subject).toMatch(/^Confirmed: /)
    expect(invitee?.html).toContain('<html lang="en">')
    expect(invitation(invitee as MailMessage).summary).toBe('Intro call with Grace Hopper')
  })

  it.each(['pt-PT', 'pt-Latn-PT', 'tlh'])(
    'falls back to English for unsupported stored attendee and host language %s',
    async (locale) => {
      const booked = await book(locale, locale)
      expect(await storedLocale(booked.booking.id)).toBe(locale)
      await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
      expect(sent).toHaveLength(2)
      expect(sent.map((message) => message.subject)).toEqual([
        expect.stringMatching(/^New booking: /),
        expect.stringMatching(/^Confirmed: /),
      ])
      for (const message of sent) {
        expect(message.html).toContain('<html lang="en">')
        expect(invitation(message).summary).toMatch(/^Intro call with /)
      }
    },
  )

  it('preserves Brazilian Portuguese through real rescheduling, reminders and cancellation', async () => {
    const booked = await book('pt-BR', 'pt-BR')
    await sendBookingNotification(deps(), booked.booking.id, 'confirmed')
    if (!booked.manageToken) throw new Error('A new fixture booking must return its manage token')
    const moved = await rescheduleManagedBooking(context, booked.manageToken, {
      start: start.add({ hours: 1 }),
    })
    expect(await storedLocale(moved.booking.id)).toBe('pt-BR')
    await sendBookingNotification(deps(), moved.booking.id, 'rescheduled')
    await sendBookingNotification(deps(), moved.booking.id, 'reminder')
    if (!moved.manageToken) throw new Error('An invitee fixture move must return its manage token')
    await cancelManagedBooking(context, moved.manageToken, { reason: 'Mudança de planos' })
    expect(await storedLocale(moved.booking.id)).toBe('pt-BR')
    await sendBookingNotification(deps(), moved.booking.id, 'cancelled')
    expect(sent).toHaveLength(8)
    for (const [stage, messages] of [
      sent.slice(0, 2),
      sent.slice(2, 4),
      sent.slice(4, 6),
      sent.slice(6),
    ].entries()) {
      for (const message of messages) {
        expect(message.html).toContain('<html lang="pt-BR">')
        expect(message.text).toContain('terça-feira, 3 de novembro de 2026')
        if (stage === 1) {
          expect(message.subject).toMatch(/^Reagendado: .+, agora: ter\., 3 de nov\., /)
          expect(message.text).toContain('10:00')
          expect(message.text).toContain('11:00')
        }
        if (stage === 2) {
          expect(message.subject).toMatch(/^Lembrete: /)
          expect(message.attachments).toBeUndefined()
        } else {
          expect(invitation(message)).toMatchObject({
            summary: expect.stringMatching(/^Intro call com /),
            uid: `${booked.booking.id}@hourmere`,
            method: stage === 3 ? 'CANCEL' : 'REQUEST',
            sequence: stage === 3 ? 2 : stage,
          })
        }
        if (stage === 3) {
          expect(message.subject).toMatch(/^Cancelado: /)
          expect(message.text).toContain('Mudança de planos')
          expect(message.text.includes('#token=')).toBe(false)
        }
      }
    }
  })
})
