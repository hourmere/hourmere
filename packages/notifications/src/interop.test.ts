import { readFileSync } from 'node:fs'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createSmtpMailer, type Mailer, type MailMessage } from '@hourmere/mail'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import type { KyselyPlugin } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fakeSmtpServer } from '../../mail/src/smtp-testing.ts'
import { sendBookingNotification } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-10-19T12:00:00Z')
const senderEmail = 'calendar@scheduler.example.org'
const hostEmail = 'grace@gmail.com'
const responseDescriptions = {
  en: 'Calendar responses do not cancel this booking. Use the cancellation link in the original Hourmere email.',
  'zh-CN': '日历回应不会取消此预约。如需取消，请使用 Hourmere 原邮件中的取消链接。',
}

function event(message: MailMessage) {
  const content = message.attachments?.[0]?.content
  if (!content) throw new Error('missing invitation')
  // Validate the wire format as well as round-tripping through an independent parser.
  expect(content.endsWith('\r\n')).toBe(true)
  expect(content.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
  for (const line of content.split('\r\n'))
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
  const calendar = new ICAL.Component(ICAL.parse(content))
  expect(calendar.getFirstPropertyValue('version')).toBe('2.0')
  expect(calendar.getAllSubcomponents('vevent')).toHaveLength(1)
  const component = calendar.getFirstSubcomponent('vevent') as ICAL.Component
  for (const name of ['uid', 'dtstamp', 'dtstart', 'dtend', 'organizer', 'summary', 'sequence'])
    expect(component.getAllProperties(name), name).toHaveLength(1)
  expect(component.getAllProperties('attendee').length).toBeGreaterThan(0)
  expect(component.getFirstPropertyValue('dtstart')).toBeInstanceOf(ICAL.Time)
  expect(component.getFirstPropertyValue('dtend')).toBeInstanceOf(ICAL.Time)
  expect(message.attachments?.[0]?.contentType).toContain(
    `method=${calendar.getFirstPropertyValue('method')}`,
  )
  return component
}

describe.skipIf(!serverUrl)('iMIP interoperability', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  const users: string[] = []
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterEach(async () => {
    if (users.length) await db.deleteFrom('auth.user').where('id', 'in', users.splice(0)).execute()
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(multi = false) {
    const host = await f.host({ name: 'Grace Hopper' })
    users.push(host.userId)
    await db
      .updateTable('auth.user')
      .set({ email: hostEmail })
      .where('id', '=', host.userId)
      .execute()
    const ids = [host.userId]
    if (multi) {
      const second = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      await db
        .insertInto('auth.user')
        .values({ id: second, name: 'Alan Turing', email: 'alan@example.net', emailVerified: true })
        .execute()
      users.push(second)
      await f.member(second, host.organizationId)
      await db
        .updateTable('auth.user')
        .set({ email: 'alan@example.net' })
        .where('id', '=', second)
        .execute()
      ids.push(second)
    }
    const booking = await f.booking(
      host.organizationId,
      ids,
      '2026-10-27T08:00Z',
      '2026-10-27T08:30Z',
      { attendee: { name: 'Ada Lovelace', email: 'ada@outlook.com' } },
    )
    return { host, ids, booking }
  }

  function capture(email = senderEmail) {
    const sent: MailMessage[] = []
    const mailer: Mailer = {
      senderEmail: email,
      async send(message) {
        sent.push(message)
      },
    }
    return {
      sent,
      send: (bookingId: string, kind: 'confirmed' | 'rescheduled' | 'cancelled') =>
        sendBookingNotification(
          { db, mailer, publicUrl: 'https://scheduler.example.org', now: () => now },
          bookingId,
          kind,
        ),
    }
  }

  async function move(info: Awaited<ReturnType<typeof setup>>) {
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
      .where('id', '=', info.booking)
      .execute()
    const next = await f.booking(
      info.host.organizationId,
      info.ids,
      '2026-11-03T09:00Z',
      '2026-11-03T09:30Z',
      { attendee: { name: 'Ada Lovelace', email: 'ada@outlook.com' } },
    )
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: info.booking })
      .where('id', '=', next)
      .execute()
    return next
  }

  it.each([false, true])(
    'matches golden new/move/cancel invitations for every recipient (multi=%s)',
    async (multi) => {
      const info = await setup(multi)
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      const next = await move(info)
      await mail.send(next, 'rescheduled')
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
        .where('id', '=', next)
        .execute()
      await mail.send(next, 'cancelled')
      const size = multi ? 3 : 2
      expect(mail.sent).toHaveLength(size * 3)
      for (const [revision, kind] of ['new', 'reschedule', 'cancel'].entries()) {
        const messages = mail.sent.slice(revision * size, (revision + 1) * size)
        for (const role of ['invitee', 'host']) {
          const message = messages.find(
            (m) => m.to === (role === 'host' ? hostEmail : 'ada@outlook.com'),
          ) as MailMessage
          const component = event(message)
          expect(component.getFirstPropertyValue('uid')).toBe(`${info.booking}@hourmere`)
          expect(component.getFirstPropertyValue('sequence')).toBe(revision)
          expect(component.getFirstPropertyValue('summary')).toBe(
            `Fixture booking with ${role === 'host' ? 'Ada Lovelace' : 'Grace Hopper'}`,
          )
          expect(component.getFirstProperty('organizer')?.getFirstValue()).toBe(
            `mailto:${senderEmail}`,
          )
          expect(message.replyTo).toEqual(
            role === 'host'
              ? { name: 'Ada Lovelace', email: 'ada@outlook.com' }
              : { name: 'Grace Hopper', email: hostEmail },
          )
          const content = message.attachments?.[0]?.content.replaceAll(info.booking, 'ROOT-BOOKING')
          expect(content).toBe(
            readFileSync(
              new URL(
                `./fixtures/${kind}-${multi ? 'multi' : 'single'}-${role}.ics`,
                import.meta.url,
              ),
              'utf8',
            ),
          )
          expect(content).not.toMatch(/token|manage|answers/i)
        }
        for (const message of messages) {
          expect(event(message).getFirstPropertyValue('summary')).toBe(
            `Fixture booking with ${message.to === 'ada@outlook.com' ? 'Grace Hopper' : 'Ada Lovelace'}`,
          )
        }
      }
    },
  )

  it('delivers host and invitee mail for an accepted 65-character local part', async () => {
    const info = await setup()
    const inviteeEmail = `${'a'.repeat(65)}@example.com`
    await db
      .updateTable('booking_attendees')
      .set({ email: inviteeEmail })
      .where('booking_id', '=', info.booking)
      .execute()
    const { server, received, sockets } = fakeSmtpServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: senderEmail })
    const messages: { to: string; raw: string }[] = []
    try {
      await sendBookingNotification(
        {
          db,
          publicUrl: 'https://scheduler.example.org',
          now: () => now,
          mailer: {
            senderEmail: mailer.senderEmail,
            async send(message, options) {
              await mailer.send(message, options)
              messages.push({ to: message.to, raw: received.data ?? '' })
            },
          },
        },
        info.booking,
        'confirmed',
      )
      expect(messages.map((m) => m.to)).toEqual([hostEmail, inviteeEmail])
      expect(received.to).toEqual([`RCPT TO:<${hostEmail}>`, `RCPT TO:<${inviteeEmail}>`])
      expect(/^Reply-To:/im.test(messages[0]?.raw ?? '')).toBe(false)
      expect(/^Reply-To: Grace Hopper <grace@gmail.com>/im.test(messages[1]?.raw ?? '')).toBe(true)
      expect(
        await db
          .selectFrom('booking_notifications')
          .select('outcome')
          .where('booking_id', '=', info.booking)
          .execute(),
      ).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }])
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it.each(['en', 'zh-CN'])(
    'uses each recipient role and locale for the decline footer (host %s)',
    async (locale) => {
      const info = await setup()
      const attendeeLocale = locale === 'en' ? 'zh-CN' : 'en'
      await db
        .updateTable('profiles')
        .set({ locale })
        .where('user_id', '=', info.host.userId)
        .execute()
      await db
        .updateTable('booking_attendees')
        .set({ locale: attendeeLocale })
        .where('booking_id', '=', info.booking)
        .execute()
      const guestEmail = 'charles@example.net'
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: info.booking,
          name: 'Charles Babbage',
          email: guestEmail,
          time_zone: 'UTC',
          // A guest has no interface choice; even a legacy independent locale is ignored.
          locale,
          is_booker: false,
        })
        .execute()
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      expect(mail.sent.map((message) => message.to)).toEqual([
        hostEmail,
        'ada@outlook.com',
        guestEmail,
      ])
      for (const message of mail.sent) {
        const isHost = message.to === hostEmail
        const isGuest = message.to === guestEmail
        const chinese = (isHost ? locale : attendeeLocale) === 'zh-CN'
        const expected = isHost
          ? chinese
            ? '日历中的拒绝尚未同步到 Hourmere；如需取消，请在 Hourmere 中操作。'
            : 'Calendar declines are not synced to Hourmere yet; cancel the booking in Hourmere.'
          : isGuest
            ? chinese
              ? '日历回应不会取消此预约。如需取消，请联系预约人或主持人。'
              : 'Calendar responses do not cancel this booking. To cancel, contact the booker or host.'
            : chinese
              ? '在日历中拒绝此邀请不会取消预约。如需取消，请使用此邮件中的“取消”链接。'
              : "Declining this invitation in your calendar won't cancel the booking. To cancel, use the Cancel link in this email."
        expect(message.text.includes(expected)).toBe(true)
        expect(message.html?.includes(`>${expected.replaceAll("'", '&#39;')}</p>`)).toBe(true)
        expect(message.html?.includes(`lang="${chinese ? 'zh-CN' : 'en'}"`)).toBe(true)
        expect(message.text.includes('token=')).toBe(!isHost && !isGuest)
        expect(message.html?.includes('token=')).toBe(!isHost && !isGuest)
      }
    },
  )

  it.each([
    [1, 'en'],
    [1, 'zh-CN'],
    [2, 'en'],
    [2, 'zh-CN'],
  ] as const)(
    'localizes every lifecycle invitation per recipient and preserves v%s identity (%s booking)',
    async (version, language) => {
      const info = await setup()
      if (version === 1) {
        await db
          .updateTable('bookings')
          .set({
            ical_version: 1,
            ical_organizer_name: 'Grace Hopper',
            ical_organizer_email: hostEmail,
          })
          .where('id', '=', info.booking)
          .execute()
      }
      const hostLanguage = language === 'en' ? 'zh-CN' : 'en'
      await db
        .updateTable('profiles')
        .set({ locale: hostLanguage })
        .where('user_id', '=', info.host.userId)
        .execute()
      const addLanguageAndGuest = async (bookingId: string) => {
        await db
          .updateTable('booking_attendees')
          .set({ locale: language, time_zone: 'Asia/Tokyo' })
          .where('booking_id', '=', bookingId)
          .execute()
        await db
          .insertInto('booking_attendees')
          .values({
            booking_id: bookingId,
            name: 'Charles Babbage',
            email: 'charles@example.net',
            time_zone: 'America/Los_Angeles',
            locale: null,
            is_booker: false,
          })
          .execute()
      }
      await addLanguageAndGuest(info.booking)
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      const next = await move(info)
      await addLanguageAndGuest(next)
      await mail.send(next, 'rescheduled')
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
        .where('id', '=', next)
        .execute()
      await mail.send(next, 'cancelled')
      expect(mail.sent).toHaveLength(9)
      for (const [revision, message] of mail.sent.entries()) {
        const stage = Math.floor(revision / 3)
        const isHost = message.to === hostEmail
        const locale = isHost ? hostLanguage : language
        const chinese = locale === 'zh-CN'
        const other = isHost ? 'Ada Lovelace' : 'Grace Hopper'
        const component = event(message)
        const summary = chinese ? `Fixture booking（与 ${other}）` : `Fixture booking with ${other}`
        const context =
          version === 2
            ? chinese
              ? '通过 Hourmere 与 Grace Hopper 预约。'
              : 'Booked with Grace Hopper using Hourmere.'
            : undefined
        const description =
          [context, stage !== 2 ? responseDescriptions[locale] : undefined]
            .filter(Boolean)
            .join('\n\n') || null
        expect(component.getFirstPropertyValue('summary')).toBe(summary)
        expect(component.getFirstPropertyValue('description')).toBe(description)
        const content = message.attachments?.[0]?.content ?? ''
        // Freeze the original v1/v2 iTIP fields, including every attendee's status/RSVP.
        // A locale-specific DESCRIPTION must not change the identity or response policy.
        expect(
          content
            .replaceAll('\r\n ', '')
            .split('\r\n')
            .filter((line) => /^(UID|SEQUENCE|ORGANIZER|ATTENDEE)[;:]/.test(line)),
        ).toEqual([
          `UID:${info.booking}@hourmere`,
          `SEQUENCE:${stage}`,
          version === 2
            ? `ORGANIZER;CN="Grace Hopper":mailto:${senderEmail}`
            : `ORGANIZER;CN="Grace Hopper";SENT-BY="mailto:${senderEmail}":mailto:${hostEmail}`,
          ...(version === 2
            ? [
                `ATTENDEE;CN="Grace Hopper";ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${hostEmail}`,
              ]
            : []),
          `ATTENDEE;CN="Ada Lovelace";ROLE=REQ-PARTICIPANT;PARTSTAT=${version === 2 ? 'NEEDS-ACTION' : 'ACCEPTED'};RSVP=FALSE:mailto:ada@outlook.com`,
          `ATTENDEE;CN="Charles Babbage";ROLE=REQ-PARTICIPANT;PARTSTAT=${version === 2 ? 'NEEDS-ACTION' : 'ACCEPTED'};RSVP=FALSE:mailto:charles@example.net`,
        ])
        expect(/token|#|\/booking[/?]/i.test(content)).toBe(false)
        if (message.to !== 'ada@outlook.com') {
          expect(/token=|\/booking#/.test(message.text)).toBe(false)
          expect(/token=|\/booking#/.test(message.html ?? '')).toBe(false)
        }
        expect(component.getFirstPropertyValue('status')).toBe(
          stage === 2 ? 'CANCELLED' : 'CONFIRMED',
        )
        expect(message.html).toContain(`<html lang="${locale}">`)
        expect(message.subject).toContain(
          chinese
            ? stage === 0
              ? isHost
                ? '新预约'
                : '已确认'
              : stage === 1
                ? '已改期'
                : '已取消'
            : stage === 0
              ? isHost
                ? 'New booking'
                : 'Confirmed'
              : stage === 1
                ? 'Rescheduled'
                : 'Cancelled',
        )
        const zone = isHost
          ? 'Europe/Berlin'
          : message.to === 'ada@outlook.com'
            ? 'Asia/Tokyo'
            : 'America/Los_Angeles'
        expect(message.text).toContain(zone)
        const roleHint = isHost
          ? chinese
            ? '日历中的拒绝尚未同步到 Hourmere'
            : 'Calendar declines are not synced to Hourmere yet'
          : message.to === 'ada@outlook.com'
            ? chinese
              ? '在日历中拒绝此邀请不会取消预约。'
              : 'Declining this invitation'
            : chinese
              ? '请联系预约人或主持人。'
              : 'contact the booker or host.'
        expect(message.text.includes(roleHint)).toBe(stage !== 2)
        expect(message.html?.includes(roleHint)).toBe(stage !== 2)
        if (chinese) expect(`${summary}\n${description ?? ''}`).not.toMatch(/[,:;.!?()]/)
      }
    },
  )

  it.each([null, 'fr-FR', 'zh-Hant-TW', 'invalid_locale'])(
    'falls back to English independently for unsupported or absent locales (%s)',
    async (locale) => {
      const info = await setup()
      await db
        .updateTable('profiles')
        .set({ locale: locale ?? '' })
        .where('user_id', '=', info.host.userId)
        .execute()
      await db
        .updateTable('booking_attendees')
        .set({ locale })
        .where('booking_id', '=', info.booking)
        .execute()
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: info.booking,
          name: 'Charles',
          email: 'charles@example.net',
          time_zone: 'UTC',
          locale: 'zh-CN',
          is_booker: false,
        })
        .execute()
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      expect(mail.sent).toHaveLength(3)
      for (const message of mail.sent) {
        expect(message.html).toContain('<html lang="en">')
        expect(event(message).getFirstPropertyValue('description')).toBe(
          `Booked with Grace Hopper using Hourmere.\n\n${responseDescriptions.en}`,
        )
      }
    },
  )

  it.each([
    {
      hostName: 'Grace Hopper',
      inviteeName: 'Ada Lovelace',
      title: 'Fixture booking',
      hostSummary: 'Fixture booking（与 Ada Lovelace）',
      attendeeSummary: 'Fixture booking（与 Grace Hopper）',
      description: '通过 Hourmere 与 Grace Hopper 预约。',
    },
    {
      hostName: '王小明',
      inviteeName: '李雷',
      title: '项目预约',
      hostSummary: '项目预约（与李雷）',
      attendeeSummary: '项目预约（与王小明）',
      description: '通过 Hourmere 与王小明预约。',
    },
    {
      hostName: 'Élodie王',
      inviteeName: '王Ada',
      title: 'Alpha项目',
      hostSummary: 'Alpha项目（与王Ada）',
      attendeeSummary: 'Alpha项目（与 Élodie王）',
      description: '通过 Hourmere 与 Élodie王预约。',
    },
    {
      hostName: '王Élodie',
      inviteeName: 'Ada王',
      title: '项目Alpha',
      hostSummary: '项目Alpha（与 Ada王）',
      attendeeSummary: '项目Alpha（与王Élodie）',
      description: '通过 Hourmere 与王Élodie 预约。',
    },
  ])(
    'spaces only generated Chinese/Latin invitation boundaries ($hostName / $inviteeName)',
    async ({ hostName, inviteeName, title, hostSummary, attendeeSummary, description }) => {
      const info = await setup()
      await db
        .updateTable('auth.user')
        .set({ name: hostName })
        .where('id', '=', info.host.userId)
        .execute()
      await db
        .updateTable('profiles')
        .set({ locale: 'zh-CN' })
        .where('user_id', '=', info.host.userId)
        .execute()
      const prepare = async (bookingId: string) => {
        await db.updateTable('bookings').set({ title }).where('id', '=', bookingId).execute()
        await db
          .updateTable('booking_attendees')
          .set({ name: inviteeName, locale: 'zh-CN' })
          .where('booking_id', '=', bookingId)
          .execute()
      }
      await prepare(info.booking)
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      const next = await move(info)
      await prepare(next)
      await mail.send(next, 'rescheduled')
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
        .where('id', '=', next)
        .execute()
      await mail.send(next, 'cancelled')
      expect(mail.sent).toHaveLength(6)
      for (const [index, message] of mail.sent.entries()) {
        const component = event(message)
        expect(component.getFirstPropertyValue('summary')).toBe(
          message.to === hostEmail ? hostSummary : attendeeSummary,
        )
        expect(component.getFirstPropertyValue('description')).toBe(
          index < 4 ? `${description}\n\n${responseDescriptions['zh-CN']}` : description,
        )
        expect(component.getFirstPropertyValue('uid')).toBe(`${info.booking}@hourmere`)
        expect(component.getFirstPropertyValue('sequence')).toBe(Math.floor(index / 2))
      }
    },
  )

  it.each(['en', 'zh-CN'])(
    'localizes generated answers using the host language and preserves user text (%s)',
    async (locale) => {
      const info = await setup()
      const typeId = await f.eventType(info.host.organizationId, info.host.userId, {
        questions: [{ id: 'consent', label: 'Custom label?', type: 'checkbox', required: false }],
      })
      await db
        .updateTable('profiles')
        .set({ locale })
        .where('user_id', '=', info.host.userId)
        .execute()
      await db
        .updateTable('bookings')
        .set({
          event_type_id: typeId,
          responses: {
            consent: true,
            removed: false,
            options: ['Settings', 'a,b'],
            text: 'Yes. Keep me!',
          },
        })
        .where('id', '=', info.booking)
        .execute()
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      const host = mail.sent.find((m) => m.to === hostEmail) as MailMessage
      expect(host.text).toContain(`Custom label?\n  ${locale === 'zh-CN' ? '是' : 'Yes'}`)
      expect(host.text).toContain(`removed\n  ${locale === 'zh-CN' ? '否' : 'No'}`)
      expect(host.text).toContain(
        `options\n  ${locale === 'zh-CN' ? 'Settings、a,b' : 'Settings, a,b'}`,
      )
      expect(host.text).toContain('text\n  Yes. Keep me!')
      expect(mail.sent.find((m) => m.to === 'ada@outlook.com')?.text).not.toContain('Custom label?')
    },
  )

  it('localizes the generated host fallback when no current host survives cancellation', async () => {
    const info = await setup()
    await capture().send(info.booking, 'confirmed')
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', info.host.userId)
      .execute()
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
      .where('id', '=', info.booking)
      .execute()
    await db
      .updateTable('booking_attendees')
      .set({ locale: 'zh-CN' })
      .where('booking_id', '=', info.booking)
      .execute()
    const mail = capture()
    await mail.send(info.booking, 'cancelled')
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]?.text).toContain('主持人')
    expect(mail.sent[0]?.text).not.toContain('Host')
    expect(event(mail.sent[0] as MailMessage).getFirstPropertyValue('summary')).toBe(
      'Fixture booking（与主持人）',
    )
  })

  it('pins the new organizer across reschedule, host edits and MAIL_FROM changes', async () => {
    const info = await setup()
    await capture().send(info.booking, 'confirmed')
    await db
      .updateTable('auth.user')
      .set({ name: 'New name', email: 'new-host@example.net' })
      .where('id', '=', info.host.userId)
      .execute()
    const next = await move(info)
    const mail = capture('new-sender@other-instance.example')
    await mail.send(next, 'rescheduled')
    const component = event(mail.sent.find((m) => m.to === 'ada@outlook.com') as MailMessage)
    const organizer = component.getFirstProperty('organizer')
    expect(organizer?.getFirstValue()).toBe(`mailto:${senderEmail}`)
    expect(organizer?.getParameter('cn')).toBe('Grace Hopper')
    expect(organizer?.getParameter('sent-by')).toBe('mailto:new-sender@other-instance.example')
    expect(component.getFirstPropertyValue('uid')).toBe(`${info.booking}@hourmere`)
    expect(component.getFirstPropertyValue('sequence')).toBe(1)
    expect(mail.sent.find((m) => m.to === 'ada@outlook.com')?.replyTo).toEqual({
      name: 'New name',
      email: 'new-host@example.net',
    })
  })

  it('uses the winning organizer when a worker loaded an unpinned root before another sent', async () => {
    const info = await setup()
    let secondRead!: () => void
    const secondLoaded = new Promise<void>((resolve) => {
      secondRead = resolve
    })
    let firstFinished!: () => void
    const firstSent = new Promise<void>((resolve) => {
      firstFinished = resolve
    })
    const barrier = (second: boolean): KyselyPlugin => ({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (result.rows.some((row) => 'depth' in row && 'ical_version' in row)) {
          if (second) {
            secondRead()
            await firstSent
          } else await secondLoaded
        }
        return result
      },
    })
    const messages: MailMessage[] = []
    const send = (second: boolean) =>
      sendBookingNotification(
        {
          db: db.withPlugin(barrier(second)),
          publicUrl: 'https://scheduler.example.org',
          now: () => now,
          mailer: {
            senderEmail: second ? 'second@other-instance.example' : senderEmail,
            async send(message) {
              // Leave one recipient for the stale worker, to verify both the CAS and winner re-read.
              if (!second && message.to === 'ada@outlook.com')
                throw new Error('Synthetic first-worker interruption')
              messages.push(message)
            },
          },
        },
        info.booking,
        'confirmed',
      )
    const sending = send(false)
    const waiting = send(true)
    try {
      await expect(sending).rejects.toThrow('Synthetic first-worker interruption')
    } finally {
      firstFinished()
    }
    await waiting
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => event(m).getFirstProperty('organizer')?.getFirstValue())).toEqual([
      `mailto:${senderEmail}`,
      `mailto:${senderEmail}`,
    ])
    const pinned = await db
      .selectFrom('bookings')
      .select('ical_organizer_email')
      .where('id', '=', info.booking)
      .executeTakeFirstOrThrow()
    expect(pinned.ical_organizer_email).toBe(senderEmail)
  })

  it('retains a legacy organizer, attendee status and host update/cancel even with SMTP enabled', async () => {
    const info = await setup()
    await db
      .updateTable('bookings')
      .set({
        ical_version: 1,
        ical_organizer_name: 'Legacy Grace',
        ical_organizer_email: hostEmail,
      })
      .where('id', '=', info.booking)
      .execute()
    const { calendarId } = await f.calendarBusy(info.host.userId, [])
    await db
      .insertInto('booking_calendar_targets')
      .values({ root_booking_id: info.booking, user_id: info.host.userId, calendar_id: calendarId })
      .execute()
    const next = await move(info)
    const mail = capture()
    await mail.send(next, 'rescheduled')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
      .where('id', '=', next)
      .execute()
    await mail.send(next, 'cancelled')
    expect(mail.sent).toHaveLength(4)
    for (const [index, message] of mail.sent.entries()) {
      const component = event(message)
      expect(component.getFirstPropertyValue('uid')).toBe(`${info.booking}@hourmere`)
      expect(component.getFirstPropertyValue('sequence')).toBe(index < 2 ? 1 : 2)
      expect(component.getFirstProperty('organizer')?.getFirstValue()).toBe(`mailto:${hostEmail}`)
      expect(component.getFirstProperty('organizer')?.getParameter('cn')).toBe('Legacy Grace')
      expect(component.getFirstProperty('organizer')?.getParameter('sent-by')).toBe(
        `mailto:${senderEmail}`,
      )
      expect(component.getFirstProperty('attendee')?.getParameter('partstat')).toBe('ACCEPTED')
      expect(component.getFirstProperty('attendee')?.getParameter('rsvp')).toBe('FALSE')
    }
  })

  it('omits new host invitations when writeback has a pinned destination', async () => {
    const info = await setup()
    const { calendarId } = await f.calendarBusy(info.host.userId, [])
    await db
      .insertInto('booking_calendar_targets')
      .values({ root_booking_id: info.booking, user_id: info.host.userId, calendar_id: calendarId })
      .execute()
    const mail = capture()
    await mail.send(info.booking, 'confirmed')
    const next = await move(info)
    await mail.send(next, 'rescheduled')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: '2026-10-19T12:00Z' })
      .where('id', '=', next)
      .execute()
    await mail.send(next, 'cancelled')
    expect(mail.sent.filter((m) => m.to === hostEmail)).toHaveLength(3)
    expect(mail.sent.filter((m) => m.to === hostEmail).every((m) => !m.attachments)).toBe(true)
    expect(
      mail.sent
        .filter((m) => m.to === hostEmail)
        .every((m) => !m.text.includes('Declining this invitation')),
    ).toBe(true)
    expect(
      mail.sent.filter((m) => m.to === 'ada@outlook.com').every((m) => m.attachments?.length === 1),
    ).toBe(true)
  })

  it.each([false, true])(
    'lists a host booking their own event once as an accepted chair (sender=host %s)',
    async (sameSender) => {
      const info = await setup()
      await db
        .updateTable('booking_attendees')
        .set({ email: hostEmail })
        .where('booking_id', '=', info.booking)
        .execute()
      const mail = capture(sameSender ? hostEmail : senderEmail)
      await mail.send(info.booking, 'confirmed')
      for (const message of mail.sent) {
        const attendees = event(message).getAllProperties('attendee')
        expect(attendees).toHaveLength(1)
        expect(attendees[0]?.getParameter('role')).toBe('CHAIR')
        expect(attendees[0]?.getParameter('partstat')).toBe('ACCEPTED')
        expect(attendees[0]?.getParameter('rsvp')).toBe('FALSE')
      }
    },
  )

  it.each(['google_meet', 'zoom'] as const)(
    'retains the email calendar path for unconfigured %s copies',
    async (provider) => {
      const info = await setup(provider === 'google_meet')
      const { calendarId } = await f.calendarBusy(info.host.userId, [])
      const calendar = await db
        .selectFrom('calendars')
        .select('connection_id')
        .where('id', '=', calendarId)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: info.booking,
          booking_id: info.booking,
          organization_id: info.host.organizationId,
          organizer_user_id: info.host.userId,
          provider,
          state: 'ready',
          applied_revision: 0,
          ...(provider === 'google_meet'
            ? { calendar_id: calendarId, connection_id: calendar.connection_id }
            : { zoom_connection_id: info.host.userId, zoom_user_id: 'synthetic-zoom-user' }),
        })
        .execute()
      const noCopyHost = info.ids.at(-1) as string
      await db
        .insertInto('booking_conference_mirrors')
        .values({
          root_booking_id: info.booking,
          user_id: noCopyHost,
          state: 'not_configured',
          error_code: 'not_configured',
        })
        .execute()
      const mail = capture()
      await mail.send(info.booking, 'confirmed')
      if (provider === 'google_meet')
        expect(mail.sent.find((m) => m.to === hostEmail)?.attachments).toBeUndefined()
      expect(
        mail.sent.find((m) => m.to === (provider === 'zoom' ? hostEmail : 'alan@example.net'))
          ?.attachments,
      ).toHaveLength(1)
    },
  )

  it('omits both email invitations when a host books their own event with writeback', async () => {
    const info = await setup()
    await db
      .updateTable('booking_attendees')
      .set({ email: hostEmail })
      .where('booking_id', '=', info.booking)
      .execute()
    const { calendarId } = await f.calendarBusy(info.host.userId, [])
    await db
      .insertInto('booking_calendar_targets')
      .values({ root_booking_id: info.booking, user_id: info.host.userId, calendar_id: calendarId })
      .execute()
    const mail = capture()
    await mail.send(info.booking, 'confirmed')
    expect(mail.sent).toHaveLength(2)
    expect(mail.sent.every((m) => !m.attachments)).toBe(true)
    expect(mail.sent.every((m) => !m.text.includes('Declining this invitation'))).toBe(true)
  })
})
