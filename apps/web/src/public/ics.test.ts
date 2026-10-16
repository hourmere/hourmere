import { describe, expect, it } from 'vitest'
import { buildIcs, escapeText, foldLine, googleCalendarUrl, outlookCalendarUrl } from './ics.ts'

const event = {
  id: '01900000-0000-7000-8000-000000000001',
  title: 'Intro call with Ada Lovelace',
  start: Date.parse('2026-11-02T08:00:00Z'),
  end: Date.parse('2026-11-02T08:30:00Z'),
  description: 'Agenda; questions, answers\nand more',
  location: 'Phone call: +49 30 1234567',
}

describe('the .ics file', () => {
  it('holds one event in UTC with the UID the server’s invitation uses', () => {
    const ics = buildIcs(event, Date.parse('2026-10-20T10:00:00Z'))
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.split('\r\n')).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Hourmere//Booking page//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:01900000-0000-7000-8000-000000000001@hourmere',
      'DTSTAMP:20261020T100000Z',
      'DTSTART:20261102T080000Z',
      'DTEND:20261102T083000Z',
      'SUMMARY:Intro call with Ada Lovelace',
      'DESCRIPTION:Agenda\\; questions\\, answers\\nand more',
      'LOCATION:Phone call: +49 30 1234567',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ])
  })

  it('escapes text and folds long lines without splitting a character', () => {
    expect(escapeText('a\\b;c,d\r\ne\u0007')).toBe('a\\\\b\\;c\\,d\\ne')
    const line = `SUMMARY:${'é'.repeat(60)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n ')
    expect(parts.join('')).toBe(line)
    const octets = (s: string) => new TextEncoder().encode(s).length
    expect(octets(parts[0] as string)).toBeLessThanOrEqual(75)
    for (const part of parts.slice(1)) expect(octets(part)).toBeLessThanOrEqual(74)
  })

  it('links to Google Calendar and Outlook with the same details', () => {
    const google = new URL(googleCalendarUrl(event))
    expect(google.origin).toBe('https://calendar.google.com')
    expect(google.searchParams.get('dates')).toBe('20261102T080000Z/20261102T083000Z')
    expect(google.searchParams.get('text')).toBe(event.title)
    const outlook = new URL(outlookCalendarUrl(event))
    expect(outlook.searchParams.get('startdt')).toBe('2026-11-02T08:00:00.000Z')
    expect(outlook.searchParams.get('location')).toBe(event.location)
  })
})
