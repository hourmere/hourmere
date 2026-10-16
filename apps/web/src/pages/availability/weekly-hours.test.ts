import { describe, expect, it } from 'vitest'
import {
  intervalDraft,
  intervalField,
  summarize,
  todayIn,
  toIntervals,
  validateIntervals,
} from './weekly-hours.ts'

describe('validateIntervals', () => {
  it('accepts separate and touching ranges, and an end at midnight', () => {
    expect(
      validateIntervals('d', [
        intervalDraft('09:00', '12:00'),
        intervalDraft('12:00', '13:00'),
        intervalDraft('20:00', '24:00'),
      ]),
    ).toEqual({})
  })

  it('names every overlap, in time order', () => {
    expect(
      validateIntervals('d', [
        intervalDraft('13:00', '15:00'),
        intervalDraft('09:00', '12:00'),
        intervalDraft('11:00', '14:00'),
      ]),
    ).toEqual({
      d: 'These hours overlap: 09:00–12:00 and 11:00–14:00; 11:00–14:00 and 13:00–15:00.',
    })
    expect(
      validateIntervals('d', [
        intervalDraft('09:00', '17:00'),
        intervalDraft('10:00', '11:00'),
        intervalDraft('12:00', '13:00'),
      ]),
    ).toEqual({
      d: 'These hours overlap: 09:00–17:00 and 10:00–11:00; 09:00–17:00 and 12:00–13:00.',
    })
  })

  it('refuses an end at or before the start, and missing times', () => {
    const same = intervalDraft('10:00', '10:00')
    const missing = { ...intervalDraft(), start: '' }
    expect(validateIntervals('d', [same, missing])).toEqual({
      [intervalField('d', same, 'end')]: 'End after the start time.',
      [intervalField('d', missing, 'start')]: 'Enter a start time.',
    })
  })
})

describe('toIntervals', () => {
  it('sends an end of 00:00 as 24:00', () => {
    expect(toIntervals([intervalDraft('22:00', '24:00'), intervalDraft('00:00', '01:00')])).toEqual(
      [
        { start: '22:00', end: '24:00' },
        { start: '00:00', end: '01:00' },
      ],
    )
  })
})

describe('summarize', () => {
  it('groups consecutive days with the same hours', () => {
    const nine = [{ start: '09:00', end: '17:00' }]
    expect(
      summarize({
        monday: nine,
        tuesday: nine,
        wednesday: [],
        thursday: nine,
        friday: nine,
        sunday: [{ start: '10:00', end: '12:00' }],
      }),
    ).toBe('Mon–Tue 09:00–17:00 · Thu–Fri 09:00–17:00 · Sun 10:00–12:00')
    expect(summarize({})).toBe('No hours set')
  })
})

describe('todayIn', () => {
  it('is the date in the zone, not in UTC', () => {
    const lateUtc = new Date('2030-03-04T23:30:00Z')
    expect(todayIn('UTC', lateUtc)).toBe('2030-03-04')
    expect(todayIn('Asia/Tokyo', lateUtc)).toBe('2030-03-05')
    expect(todayIn('America/Los_Angeles', lateUtc)).toBe('2030-03-04')
  })
})
