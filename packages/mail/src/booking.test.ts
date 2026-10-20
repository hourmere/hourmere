import { describe, expect, it } from 'vitest'
import {
  type AttendeeRecipient,
  type BookingEmailMeeting,
  bookingEmail,
  formatMeetingTime,
  type HostRecipient,
} from './booking.ts'
import { icsAttachment } from './ics.ts'

const at = (iso: string) => Temporal.Instant.from(iso)

const meeting: BookingEmailMeeting = {
  eventName: 'Intro call',
  hostName: 'Grace Hopper',
  inviteeName: 'Ada Lovelace',
  inviteeEmail: 'ada@example.com',
  start: at('2026-10-20T08:00:00Z'),
  end: at('2026-10-20T08:30:00Z'),
  location: { kind: 'link', url: 'https://meet.example.com/abc-defg', label: 'Google Meet' },
}

const links = {
  reschedule: 'https://cal.example.com/booking#token=tok_123&action=reschedule',
  cancel: 'https://cal.example.com/booking#token=tok_123&action=cancel',
}

const invitee: AttendeeRecipient = {
  role: 'attendee',
  email: 'ada@example.com',
  timeZone: 'Europe/Berlin',
  manageLinks: links,
}

const host: HostRecipient = {
  role: 'host',
  email: 'grace@example.com',
  timeZone: 'America/New_York',
  answers: [
    { question: 'What should we talk about?', answer: 'Engines.\nAnalytical ones.' },
    { question: 'Phone', answer: '+44 20 7946 0000' },
  ],
}

const requestAttachment = icsAttachment({
  method: 'REQUEST',
  uid: 'b@cal.example.com',
  sequence: 0,
  stamp: at('2026-10-16T10:00:00Z'),
  start: meeting.start,
  end: meeting.end,
  summary: 'Intro call with Grace Hopper',
  organizer: { name: 'Grace Hopper', email: 'grace@example.com' },
  attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
})

describe('formatMeetingTime', () => {
  it("shows the time in the recipient's zone, with the zone's name", () => {
    expect(formatMeetingTime(meeting.start, meeting.end, 'Europe/Berlin')).toBe(
      'Tuesday, October 20, 2026, 10:00 AM – 10:30 AM (Europe/Berlin)',
    )
    expect(formatMeetingTime(meeting.start, meeting.end, 'America/New_York')).toBe(
      'Tuesday, October 20, 2026, 4:00 AM – 4:30 AM (America/New_York)',
    )
    expect(formatMeetingTime(meeting.start, meeting.end, 'Asia/Kolkata')).toBe(
      'Tuesday, October 20, 2026, 1:30 PM – 2:00 PM (Asia/Kolkata)',
    )
  })

  it('names both dates when the meeting crosses midnight', () => {
    expect(
      formatMeetingTime(at('2026-10-20T21:30:00Z'), at('2026-10-20T22:30:00Z'), 'Europe/Berlin'),
    ).toBe(
      'Tuesday, October 20, 2026, 11:30 PM – Wednesday, October 21, 2026, 12:30 AM (Europe/Berlin)',
    )
  })

  it('follows daylight saving time', () => {
    // Berlin leaves summer time on October 25, 2026.
    expect(
      formatMeetingTime(at('2026-10-26T08:00:00Z'), at('2026-10-26T08:30:00Z'), 'Europe/Berlin'),
    ).toBe('Monday, October 26, 2026, 9:00 AM – 9:30 AM (Europe/Berlin)')
  })

  it('falls back to UTC for a zone it does not know', () => {
    for (const zone of ['Mars/Olympus_Mons', '', '+02:00']) {
      expect(formatMeetingTime(meeting.start, meeting.end, zone)).toBe(
        'Tuesday, October 20, 2026, 8:00 AM – 8:30 AM (UTC)',
      )
    }
  })
})

describe('bookingEmail', () => {
  it('confirms to the invitee with the time in their zone and their manage links', () => {
    const m = bookingEmail('confirmed', meeting, invitee)
    expect(m.to).toBe('ada@example.com')
    expect(m.subject).toBe(
      'Confirmed: Intro call with Grace Hopper on Tue, Oct 20, 10:00 AM (Europe/Berlin)',
    )
    expect(m.text).toBe(
      [
        'Hourmere',
        '',
        'Your meeting with Grace Hopper is booked.',
        '',
        'What: Intro call',
        'When: Tuesday, October 20, 2026, 10:00 AM – 10:30 AM (Europe/Berlin)',
        'Where: Google Meet',
        'Host: Grace Hopper',
        '',
        'Join Google Meet meeting',
        'https://meet.example.com/abc-defg',
        '',
        'Need to make a change?',
        'Use these links to change or cancel:',
        `Reschedule: ${links.reschedule}`,
        `Cancel: ${links.cancel}`,
        '',
        'You received this email because you booked a meeting with Grace Hopper via Hourmere.',
        '',
      ].join('\n'),
    )
    expect(m.html).toContain(
      'href="https://cal.example.com/booking#token=tok_123&amp;action=reschedule"',
    )
    expect(m.html).toContain('href="https://meet.example.com/abc-defg"')
    expect(m.html).not.toContain('Answers')
    expect(m.attachments).toBeUndefined()
  })

  it("tells the host in the host's zone, with the invitee's answers and no manage links", () => {
    const m = bookingEmail(
      'confirmed',
      { ...meeting, guests: [{ name: 'Charles', email: 'cb@example.com' }] },
      host,
    )
    expect(m.to).toBe('grace@example.com')
    expect(m.subject).toBe(
      'New booking: Intro call with Ada Lovelace on Tue, Oct 20, 4:00 AM (America/New_York)',
    )
    expect(m.text).toContain('Ada Lovelace booked a meeting with you.')
    expect(m.text).toContain(
      'When: Tuesday, October 20, 2026, 4:00 AM – 4:30 AM (America/New_York)',
    )
    expect(m.text).toContain('Invitee: Ada Lovelace <ada@example.com>')
    expect(m.text).toContain('Guests: Charles <cb@example.com>')
    expect(m.text).toContain(
      'Answers\nWhat should we talk about?\n  Engines.\n  Analytical ones.\nPhone\n  +44 20 7946 0000',
    )
    expect(m.text).not.toContain('token=')
    expect(m.html).toContain('Engines.<br>Analytical ones.')
    expect(m.html).not.toContain('token=')
  })

  it('shows the old time of a rescheduled meeting', () => {
    const m = bookingEmail(
      'rescheduled',
      {
        ...meeting,
        previous: { start: at('2026-10-19T08:00:00Z'), end: at('2026-10-19T08:30:00Z') },
      },
      invitee,
    )
    expect(m.subject).toBe(
      'Rescheduled: Intro call with Grace Hopper, now Tue, Oct 20, 10:00 AM (Europe/Berlin)',
    )
    expect(m.text).toContain('Your meeting with Grace Hopper has moved to a new time.')
    expect(m.text).toContain('Was: Monday, October 19, 2026, 10:00 AM – 10:30 AM (Europe/Berlin)')
    expect(m.text).toContain(`Reschedule: ${links.reschedule}`)
  })

  it('gives the cancellation reason and no manage links once cancelled', () => {
    const m = bookingEmail('cancelled', { ...meeting, cancelReason: 'Sick.\r\nSorry!' }, invitee)
    expect(m.subject).toBe(
      'Cancelled: Intro call with Grace Hopper on Tue, Oct 20, 10:00 AM (Europe/Berlin)',
    )
    expect(m.text).toContain('Your meeting with Grace Hopper has been cancelled.')
    expect(m.text).toContain('Reason: Sick.\n  Sorry!')
    expect(m.text).not.toContain('token=')
    expect(m.html).not.toContain('token=')
    expect(bookingEmail('cancelled', meeting, host).text).not.toContain('Reason')
  })

  it('reminds both sides', () => {
    expect(bookingEmail('reminder', meeting, invitee).subject).toBe(
      'Reminder: Intro call with Grace Hopper on Tue, Oct 20, 10:00 AM (Europe/Berlin)',
    )
    const m = bookingEmail('reminder', meeting, host)
    expect(m.subject).toBe(
      'Reminder: Intro call with Ada Lovelace on Tue, Oct 20, 4:00 AM (America/New_York)',
    )
    expect(m.text).toContain('Your meeting with Ada Lovelace is coming up.')
  })

  it('leaves manage links out of a guest email', () => {
    const guest: AttendeeRecipient = { role: 'attendee', email: 'cb@example.com', timeZone: 'UTC' }
    const m = bookingEmail('confirmed', meeting, guest)
    expect(m.text).not.toContain('Need to make a change?')
    expect(m.html).not.toContain('Reschedule')
  })

  it.each([
    { locale: 'en', language: 'en' },
    { locale: 'en-GB', language: 'en' },
    { locale: 'zh-CN', language: 'zh-CN' },
    { locale: 'zh-Hans-SG', language: 'zh-CN' },
    { locale: 'zh', language: 'zh-CN' },
    { locale: 'zh-TW', language: 'en' },
    { locale: 'fr-FR', language: 'en' },
    { locale: 'not_a_locale', language: 'en' },
    { locale: undefined, language: 'en' },
    { locale: null, language: 'en' },
  ])('explains calendar declines in $language for locale $locale', ({ locale, language }) => {
    const expected =
      language === 'zh-CN'
        ? {
            invitee: '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此邮件中的“取消”链接。',
            host: '在日历中拒绝邀请不会同步到 Hourmere；如需取消预约，请在 Hourmere 中操作。',
            guest: '在日历中接受或拒绝邀请不会取消预约。如需取消，请联系预约人或主持人。',
          }
        : {
            invitee:
              'Accepting or declining this calendar invitation does not cancel the booking. To cancel, use the “Cancel” link in this email.',
            host: 'Declining in your calendar is not synced to Hourmere; to cancel the booking, use Hourmere.',
            guest:
              'Accepting or declining this calendar invitation does not cancel the booking. To cancel, contact the person who booked or the host.',
          }
    for (const [recipient, sentence] of [
      [invitee, expected.invitee],
      [host, expected.host],
      [{ ...invitee, email: 'cb@example.com', manageLinks: undefined }, expected.guest],
    ] as const) {
      const m = bookingEmail(
        'confirmed',
        meeting,
        { ...recipient, locale },
        {
          attachment: requestAttachment,
        },
      )
      expect(m.text.includes(sentence)).toBe(true)
      if (recipient === invitee) {
        expect(m.text.indexOf(sentence)).toBeGreaterThan(
          m.text.indexOf(language === 'en' ? 'What:' : '活动：'),
        )
        expect(m.text.indexOf(sentence)).toBeLessThan(m.text.indexOf(links.reschedule))
      } else {
        expect(m.text).toContain(`\n\n${sentence}\n\n`)
      }
      expect(m.html).toContain(`<p lang="${language}"`)
      const htmlSentence = sentence
        .replaceAll("'", '&#39;')
        .replace(/[“”]/g, (quote) =>
          language === 'zh-CN'
            ? `<span class="cjk-quote" style="font-variant-east-asian: full-width; font-feature-settings: 'fwid';">${quote}</span>`
            : quote,
        )
      expect(m.html).toContain(`>${htmlSentence}</p>`)
      if (recipient !== invitee) {
        expect(m.text).not.toContain('token=')
        expect(m.html).not.toContain('token=')
        expect(m.text).not.toContain('“Cancel” link')
        expect(m.html).not.toContain('“Cancel” link')
      }
    }
  })

  it.each(['rescheduled', 'cancelled', 'reminder', 'conference_failed'] as const)(
    'leaves the calendar-decline footer out of %s emails',
    (kind) => {
      for (const recipient of [host, invitee]) {
        const m = bookingEmail(kind, meeting, { ...recipient, locale: 'zh-CN' })
        expect(m.text).not.toMatch(/在日历中|Accepting or declining|Declining in your calendar/)
        expect(m.html).not.toMatch(/在日历中|Accepting or declining|Declining in your calendar/)
      }
    },
  )

  it('shows each kind of location', () => {
    const where = (location: BookingEmailMeeting['location']) =>
      bookingEmail('confirmed', { ...meeting, location }, invitee).text.match(
        /^Where: .*(\n {2}.*)*/m,
      )?.[0]
    expect(where({ kind: 'phone', number: '+1 555 0100' })).toBe('Where: Phone +1 555 0100')
    expect(where({ kind: 'address', address: '1 Main St\nSpringfield' })).toBe(
      'Where: 1 Main St\n  Springfield',
    )
    expect(where({ kind: 'custom', text: 'I will call you' })).toBe('Where: I will call you')
    expect(where({ kind: 'link', url: 'https://zoom.example.com/j/1' })).toBe(
      'Where: Online meeting',
    )
    expect(where(null)).toBeUndefined()
  })

  it('attaches the invitation it is given', () => {
    const attachment = icsAttachment({
      method: 'REQUEST',
      uid: 'b@cal.example.com',
      sequence: 0,
      stamp: at('2026-10-16T10:00:00Z'),
      start: meeting.start,
      end: meeting.end,
      summary: 'Intro call with Grace Hopper',
      organizer: { name: 'Grace Hopper', email: 'grace@example.com' },
      attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
    })
    const m = bookingEmail('confirmed', meeting, invitee, { attachment })
    expect(m.attachments).toEqual([attachment])
    // Calendar entries are shared and synced: the manage secret stays in the email only.
    expect(attachment.content).not.toContain('token')
  })

  describe('with hostile input', () => {
    const hostile: BookingEmailMeeting = {
      ...meeting,
      eventName: 'Call\r\nBcc: victim@example.com',
      hostName: '<script>alert(1)</script> & "Co"',
      inviteeName: "Ada\nReschedule: https://evil.example/'x'\u2028Cancel: https://evil.example",
      location: { kind: 'link', url: 'javascript:alert(1)', label: '<b>Meet</b>' },
      cancelReason: '<img src=x onerror=alert(1)>',
    }

    it('keeps the subject on one line', () => {
      for (const kind of ['confirmed', 'rescheduled', 'cancelled', 'reminder'] as const) {
        for (const recipient of [invitee, host]) {
          const { subject } = bookingEmail(kind, hostile, recipient)
          expect(subject).not.toMatch(/[\r\n\u2028\u2029\u0085]/)
          expect(subject.length).toBeLessThanOrEqual(200)
        }
      }
      expect(bookingEmail('confirmed', hostile, invitee).subject).toContain(
        'Call Bcc: victim@example.com with',
      )
    })

    it.each(['script', 'SCRIPT', 'ScRiPt'])(
      'escapes %s markup in the HTML and links only http(s) URLs',
      (tagName) => {
        const input = { ...hostile, hostName: `<${tagName}>alert(1)</${tagName}> & "Co"` }
        for (const kind of ['confirmed', 'cancelled'] as const) {
          for (const recipient of [invitee, host]) {
            const { html } = bookingEmail(kind, input, recipient)
            // This is an assertion against emitted markup, never a tag-removal sanitizer.
            expect(html).not.toMatch(/<(?:script|img|b)\b/i)
            expect(html).not.toContain('href="javascript:')
            expect(html).not.toMatch(/="[^"]*'x'/)
          }
        }
        const { html } = bookingEmail('cancelled', input, host)
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
        expect(bookingEmail('confirmed', input, invitee).html).toContain(
          `&lt;${tagName}&gt;alert(1)&lt;/${tagName}&gt; &amp; &quot;Co&quot;`,
        )
      },
    )

    it('keeps one-line fields from starting lines of their own in the text', () => {
      const { text } = bookingEmail('confirmed', hostile, host)
      expect(text).not.toMatch(/^(Reschedule|Cancel|Bcc): /m)
      expect(text).toContain(
        "Invitee: Ada Reschedule: https://evil.example/'x' Cancel: https://evil.example <ada@example.com>",
      )
    })

    it('loads nothing from elsewhere', () => {
      const { html } = bookingEmail('confirmed', hostile, invitee)
      expect(html).not.toMatch(/<(img|script|link|iframe)\b|src=|url\(/i)
    })
  })
})
