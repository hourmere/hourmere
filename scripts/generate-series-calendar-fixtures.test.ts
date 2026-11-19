import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { generateSeriesCalendarFixtures } from './generate-series-calendar-fixtures.ts'

const files = generateSeriesCalendarFixtures()

function read(filename: string, method: string | null = null) {
  const source = files[filename]
  if (!source) throw new Error(`Missing calendar fixture ${filename}`)
  const calendar = new ICAL.Component(ICAL.parse(source))
  expect(calendar.getFirstPropertyValue('method')).toBe(method)
  return calendar.getAllSubcomponents('vevent').map((event) => ({
    uid: event.getFirstPropertyValue('uid'),
    sequence: event.getFirstPropertyValue('sequence'),
    stamp: event.getFirstPropertyValue('dtstamp')?.toString(),
    start: event.getFirstPropertyValue('dtstart')?.toString(),
    end: event.getFirstPropertyValue('dtend')?.toString(),
    status: event.getFirstPropertyValue('status'),
    description: event.getFirstPropertyValue('description'),
  }))
}

describe('synthetic series calendar files', () => {
  it('makes a twelve-entry import with two link updates and one ordinary move', () => {
    const confirmation = read('confirmation.ics')
    expect(confirmation).toHaveLength(12)
    expect(new Set(confirmation.map(({ uid }) => uid)).size).toBe(12)
    for (const [index, entry] of confirmation.entries()) {
      const start = Temporal.Instant.from('2030-01-07T10:00Z').add({ hours: 168 * index })
      expect(entry).toMatchObject({
        sequence: 0,
        stamp: '2030-01-06T08:00:00Z',
        start: start.toString(),
        end: start.add({ minutes: 30 }).toString(),
        status: 'CONFIRMED',
        description: [1, 4].includes(index)
          ? 'Meeting link pending'
          : `https://calendar-check.invalid/meet/${index + 1}`,
      })
    }
    expect(read('link-update.ics')).toEqual(
      [1, 4].map((index) => ({
        ...confirmation[index],
        stamp: '2030-01-06T09:00:00Z',
        description: `https://calendar-check.invalid/meet/${index + 1}`,
      })),
    )
    expect(read('single-move.ics', 'REQUEST')).toEqual([
      expect.objectContaining({
        uid: confirmation[5]?.uid,
        sequence: 1,
        stamp: '2030-01-06T10:00:00Z',
        start: '2030-02-11T12:00:00Z',
        end: '2030-02-11T12:30:00Z',
        status: 'CONFIRMED',
      }),
    ])
  })

  it('models a tail cancellation with the previously absent date in the body only', () => {
    const confirmation = read('tail-confirmation.ics')
    expect(confirmation).toHaveLength(11)
    expect(read('tail-cancel.ics')).toEqual(
      confirmation.slice(9).map((entry) => ({
        ...entry,
        sequence: 1,
        stamp: '2030-01-06T11:00:00Z',
        status: 'CANCELLED',
        description: 'Cancelled',
      })),
    )
    const cancelledDates = files['tail-cancel.txt']?.split('Unchanged dates')[0]
    expect(cancelledDates).toContain(
      'March 25, 2030, 10:00 AM – 10:30 AM (UTC, GMT+00:00)\n  Cancelled',
    )
    expect(files['tail-confirmation.ics']).not.toContain('DTSTART:20300325')
    expect(files['tail-cancel.ics']).not.toContain('DTSTART:20300325')
  })
})
