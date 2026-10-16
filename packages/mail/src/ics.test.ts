import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { buildIcs, foldIcsLine, type IcsEvent, icsAttachment } from './ics.ts'

const base: IcsEvent = {
  method: 'REQUEST',
  uid: '0199f0c4-7a2b-7000-8000-000000000001@cal.example.com',
  sequence: 0,
  stamp: Temporal.Instant.from('2026-10-16T10:15:30.123Z'),
  start: Temporal.Instant.from('2026-10-20T08:00:00Z'),
  end: Temporal.Instant.from('2026-10-20T08:30:00Z'),
  summary: 'Intro call with Grace Hopper',
  organizer: { name: 'Grace Hopper', email: 'grace@example.com' },
  attendees: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
}

const physicalLines = (ics: string) => ics.split('\r\n').slice(0, -1)
const unfold = (ics: string) => ics.replaceAll('\r\n ', '')
const contentLines = (ics: string) => physicalLines(unfold(ics))

/** Structure every invitation must have, whatever it contains. */
function expectWellFormed(ics: string) {
  expect(ics.endsWith('\r\n')).toBe(true)
  // CRLF only: no bare CR or LF anywhere.
  expect(ics.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
  for (const line of physicalLines(ics)) {
    expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(75)
    // A line that ended inside a surrogate pair (half an emoji) would not survive UTF-8.
    expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line)
  }
  const lines = contentLines(ics)
  expect(lines[0]).toBe('BEGIN:VCALENDAR')
  expect(lines.at(-1)).toBe('END:VCALENDAR')
  expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1)
  for (const line of lines) expect(line).toMatch(/^[A-Z-]+[;:]/)
}

function parse(ics: string) {
  const calendar = new ICAL.Component(ICAL.parse(ics))
  const event = calendar.getFirstSubcomponent('vevent')
  if (!event) throw new Error('no VEVENT')
  return { calendar, event }
}

describe('buildIcs', () => {
  it('writes a REQUEST with UTC times, the UID and the sequence', () => {
    const ics = buildIcs(base)
    expectWellFormed(ics)
    expect(contentLines(ics)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Hourmere//Hourmere//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:0199f0c4-7a2b-7000-8000-000000000001@cal.example.com',
      'SEQUENCE:0',
      'DTSTAMP:20261016T101530Z',
      'DTSTART:20261020T080000Z',
      'DTEND:20261020T083000Z',
      'SUMMARY:Intro call with Grace Hopper',
      'ORGANIZER;CN="Grace Hopper":mailto:grace@example.com',
      'ATTENDEE;CN="Ada Lovelace";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:ada@example.com',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
      'END:VCALENDAR',
    ])
    const { calendar, event } = parse(ics)
    expect(calendar.getFirstPropertyValue('method')).toBe('REQUEST')
    expect(event.getFirstPropertyValue('uid')).toBe(base.uid)
    expect(event.getFirstPropertyValue('sequence')).toBe(0)
    const start = event.getFirstPropertyValue('dtstart') as ICAL.Time
    const end = event.getFirstPropertyValue('dtend') as ICAL.Time
    expect(start.toJSDate().toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect(end.toJSDate().toISOString()).toBe('2026-10-20T08:30:00.000Z')
    expect(start.zone?.tzid).toBe('UTC')
  })

  it('writes a CANCEL with the sequence given and a cancelled status', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 2 })
    expectWellFormed(ics)
    const { calendar, event } = parse(ics)
    expect(calendar.getFirstPropertyValue('method')).toBe('CANCEL')
    expect(event.getFirstPropertyValue('sequence')).toBe(2)
    expect(event.getFirstPropertyValue('status')).toBe('CANCELLED')
    expect(event.getFirstPropertyValue('uid')).toBe(base.uid)
  })

  it('escapes commas, semicolons, backslashes and line breaks in text', () => {
    const ics = buildIcs({
      ...base,
      summary: 'a,b;c\\d',
      description: 'line 1\nline 2\r\nline 3\rline 4\\n is not a break',
      location: 'Room 1, Floor 2; Building \\ A',
    })
    expectWellFormed(ics)
    const lines = contentLines(ics)
    expect(lines).toContain('SUMMARY:a\\,b\\;c\\\\d')
    expect(lines).toContain(
      'DESCRIPTION:line 1\\nline 2\\nline 3\\nline 4\\\\n is not a break',
    )
    expect(lines).toContain('LOCATION:Room 1\\, Floor 2\\; Building \\\\ A')
    const { event } = parse(ics)
    expect(event.getFirstPropertyValue('summary')).toBe('a,b;c\\d')
    expect(event.getFirstPropertyValue('description')).toBe(
      'line 1\nline 2\nline 3\nline 4\\n is not a break',
    )
    expect(event.getFirstPropertyValue('location')).toBe('Room 1, Floor 2; Building \\ A')
  })

  it('drops control characters that text values may not contain', () => {
    const ics = buildIcs({
      ...base,
      summary: 'bell\u0007 nul\u0000 esc\u001b del\u007f sep\u2028 bidi\u202e tab\tend',
    })
    expectWellFormed(ics)
    expect(ics).not.toMatch(/[\u0000\u0007\u001b\u007f\u2028\u202e]/)
    // A line separator is a line break; the bidi override is dropped.
    expect(parse(ics).event.getFirstPropertyValue('summary')).toBe(
      'bell nul esc del sep\n bidi tab\tend',
    )
  })

  it('folds long lines at 75 octets without splitting UTF-8 sequences', () => {
    const summary = `Ünïcödé ${'😀'.repeat(40)} ${'会议'.repeat(50)} 👩\u200d👩\u200d👧\u200d👦 ${'a'.repeat(300)}`
    const description = `${'Ö,;\\'.repeat(100)}\n${'العربية '.repeat(30)}`
    const ics = buildIcs({ ...base, summary, description })
    expectWellFormed(ics)
    expect(physicalLines(ics).length).toBeGreaterThan(30)
    const { event } = parse(ics)
    expect(event.getFirstPropertyValue('summary')).toBe(summary)
    expect(event.getFirstPropertyValue('description')).toBe(description)
  })

  it('quotes names in parameters, replacing what a quoted value cannot hold', () => {
    const ics = buildIcs({
      ...base,
      organizer: { name: 'Grace "Amazing" Hopper; PhD: Navy, Ret.', email: 'grace@example.com' },
      attendees: [
        { name: 'Ada\r\nLovelace', email: 'ada@example.com' },
        { name: '李小龍 🐉', email: 'bruce+test@example.com' },
      ],
    })
    expectWellFormed(ics)
    const { event } = parse(ics)
    const organizer = event.getFirstProperty('organizer')
    expect(organizer?.getParameter('cn')).toBe("Grace 'Amazing' Hopper; PhD: Navy, Ret.")
    expect(organizer?.getFirstValue()).toBe('mailto:grace@example.com')
    const attendees = event.getAllProperties('attendee')
    expect(attendees.map((a) => a.getParameter('cn'))).toEqual(['Ada  Lovelace', '李小龍 🐉'])
    expect(attendees.map((a) => a.getFirstValue())).toEqual([
      'mailto:ada@example.com',
      'mailto:bruce+test@example.com',
    ])
    expect(attendees.map((a) => a.getParameter('partstat'))).toEqual(['ACCEPTED', 'ACCEPTED'])
  })

  it('survives every special character at once', () => {
    const nasty = 'A "quote", a; semicolon: colon \\ backslash\n\ttab, 😀 emoji, 中文, end'
    const ics = buildIcs({
      ...base,
      summary: nasty.repeat(5),
      description: nasty,
      location: nasty,
      uid: 'odd,uid;with\\specials@cal.example.com',
    })
    expectWellFormed(ics)
    const { event } = parse(ics)
    expect(event.getFirstPropertyValue('summary')).toBe(nasty.repeat(5))
    expect(event.getFirstPropertyValue('description')).toBe(nasty)
    expect(event.getFirstPropertyValue('location')).toBe(nasty)
    expect(event.getFirstPropertyValue('uid')).toBe('odd,uid;with\\specials@cal.example.com')
  })

  it('leaves out an empty description and location', () => {
    const lines = contentLines(buildIcs({ ...base, description: '', location: undefined }))
    expect(lines.some((l) => l.startsWith('DESCRIPTION') || l.startsWith('LOCATION'))).toBe(false)
  })
})

describe('foldIcsLine', () => {
  it('folds only past 75 octets, and continuation lines carry a space and 74', () => {
    expect(foldIcsLine('x'.repeat(75))).toBe('x'.repeat(75))
    expect(foldIcsLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`)
    expect(foldIcsLine('x'.repeat(75 + 74 + 1))).toBe(
      `${'x'.repeat(75)}\r\n ${'x'.repeat(74)}\r\n x`,
    )
  })

  it('moves a multi-byte character that would cross the limit to the next line', () => {
    // 74 + 3 octets: the CJK character does not fit on the first line.
    expect(foldIcsLine(`${'a'.repeat(74)}会`)).toBe(`${'a'.repeat(74)}\r\n 会`)
    // 72 + 4: neither does the emoji.
    expect(foldIcsLine(`${'a'.repeat(72)}😀`)).toBe(`${'a'.repeat(72)}\r\n 😀`)
    expect(foldIcsLine(`${'a'.repeat(71)}😀`)).toBe(`${'a'.repeat(71)}😀`)
  })
})

describe('icsAttachment', () => {
  it('names the method in the content type', () => {
    expect(icsAttachment(base)).toMatchObject({
      filename: 'invite.ics',
      contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
    })
    expect(icsAttachment({ ...base, method: 'CANCEL' })).toMatchObject({
      filename: 'cancel.ics',
      contentType: 'text/calendar; method=CANCEL; charset=UTF-8',
    })
  })
})
