import { describe, expect, it } from 'vitest'
import { parseCalDavBusy } from './caldav-events.ts'

const options = { start: '2026-03-01T00:00:00Z', end: '2026-04-01T00:00:00Z' }
const event = (body: string) => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`
const calendar = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const timed = 'UID:private-uid\r\nDTSTART:20260308T160000Z\r\nDTEND:20260308T170000Z'

describe('expanded CalDAV busy data', () => {
  it('retains only busy data and unfolds content lines', () => {
    const result = parseCalDavBusy(
      calendar(
        event(
          `${timed}\r\nSUMMARY:private\r\n title\r\nDESCRIPTION:secret\r\nATTENDEE;CN="A:B;C":mailto:other@example.com`,
        ),
      ),
      options,
    )
    expect(result).toEqual([
      {
        instanceId: '["private-uid",null]',
        kind: 'timed',
        start: '2026-03-08T16:00:00Z',
        end: '2026-03-08T17:00:00Z',
      },
    ])
    expect(JSON.stringify(result)).not.toMatch(/title|secret|other@example.com/)
  })
  it('accepts expanded recurrence, exclusions and moved overrides across DST', () => {
    const result = parseCalDavBusy(
      calendar(
        event(
          'UID:series\r\nRECURRENCE-ID:20260301T140000Z\r\nDTSTART;TZID=America/New_York:20260301T090000\r\nDTEND;TZID=America/New_York:20260301T100000',
        ),
        event(
          'UID:series\r\nRECURRENCE-ID:20260308T130000Z\r\nDTSTART;TZID=America/New_York:20260308T110000\r\nDTEND;TZID=America/New_York:20260308T120000',
        ),
        event('UID:series\r\nRECURRENCE-ID:20260315T130000Z\r\nSTATUS:CANCELLED'),
      ),
      options,
    )
    expect(result.map((v) => v.start)).toEqual(['2026-03-01T14:00:00Z', '2026-03-08T15:00:00Z'])
  })
  it('preserves all-day dates and exclusive end dates, including expanded recurrence', () => {
    expect(
      parseCalDavBusy(
        calendar(
          event(
            'UID:days\r\nRECURRENCE-ID;VALUE=DATE:20260308\r\nDTSTART;VALUE=DATE:20260308\r\nDTEND;VALUE=DATE:20260310',
          ),
        ),
        options,
      ),
    ).toMatchObject([{ kind: 'all_day', start: '2026-03-08', end: '2026-03-10' }])
    expect(
      parseCalDavBusy(calendar(event('UID:day\r\nDTSTART;VALUE=DATE:20260308')), options)[0]?.end,
    ).toBe('2026-03-09')
  })
  it('excludes transparent, canceled and only verified owner declines', () => {
    const declined = calendar(
      event(`${timed}\r\nATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.com`),
    )
    expect(parseCalDavBusy(declined, options)).toHaveLength(1)
    expect(
      parseCalDavBusy(declined, { ...options, ownerAddresses: ['mailto:someone@example.com'] }),
    ).toHaveLength(1)
    expect(
      parseCalDavBusy(declined, { ...options, ownerAddresses: ['mailto:OWNER@example.com'] }),
    ).toEqual([])
    for (const property of ['TRANSP:TRANSPARENT', 'STATUS:CANCELLED'])
      expect(parseCalDavBusy(calendar(event(`${timed}\r\n${property}`)), options)).toEqual([])
  })
  it('requires a verified timezone for floating values and rejects ambiguous DST times', () => {
    const body = calendar(event('UID:floating\r\nDTSTART:20260308T090000\r\nDTEND:20260308T100000'))
    expect(() => parseCalDavBusy(body, options)).toThrow('CalDAV')
    expect(parseCalDavBusy(body, { ...options, timeZone: 'America/New_York' })[0]?.start).toBe(
      '2026-03-08T13:00:00Z',
    )
    expect(() =>
      parseCalDavBusy(
        calendar(
          event(
            'UID:gap\r\nDTSTART;TZID=America/New_York:20260308T023000\r\nDTEND;TZID=America/New_York:20260308T033000',
          ),
        ),
        options,
      ),
    ).toThrow()
  })
  it.each(['RRULE:FREQ=DAILY', 'RDATE:20260309T160000Z', 'EXDATE:20260308T160000Z'])(
    'fails incomplete server expansion: %s',
    (rule) => {
      expect(() => parseCalDavBusy(calendar(event(`${timed}\r\n${rule}`)), options)).toThrow()
    },
  )
  it('rejects unknown and embedded timezone semantics instead of inventing offsets', () => {
    const value = event(
      'UID:custom\r\nDTSTART;TZID=Custom/Private:20260308T090000\r\nDTEND;TZID=Custom/Private:20260308T100000',
    )
    expect(() => parseCalDavBusy(calendar(value), options)).toThrow()
    expect(() =>
      parseCalDavBusy(
        calendar(
          'BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nEND:VTIMEZONE',
          event(
            'UID:custom\r\nDTSTART;TZID=America/New_York:20260308T090000\r\nDTEND;TZID=America/New_York:20260308T100000',
          ),
        ),
        options,
      ),
    ).toThrow()
  })
  it('fails oversized, malformed, duplicate and invalid resources with sanitized errors', () => {
    for (const input of [
      'secret credential',
      'x'.repeat(1_048_577),
      calendar(event(timed), event(timed)),
      calendar(event(`${timed}\r\nDTSTART:20260308T180000Z`)),
      calendar(event('UID:bad\r\nDTSTART:20260230T090000Z\r\nDTEND:20260301T090000Z')),
      calendar(event(timed)).replace('END:VEVENT', 'END:VTODO'),
    ]) {
      expect(() => parseCalDavBusy(input, options)).toThrow()
      try {
        parseCalDavBusy(input, options)
      } catch (error) {
        expect(String(error)).not.toMatch(/credential|private-uid|20260230/)
      }
    }
  })
  it('supports bounded durations and rejects uncertain local calendar-day durations', () => {
    expect(
      parseCalDavBusy(
        calendar(event('UID:duration\r\nDTSTART:20260308T160000Z\r\nDURATION:PT1H')),
        options,
      )[0]?.end,
    ).toBe('2026-03-08T17:00:00Z')
    expect(
      parseCalDavBusy(
        calendar(event('UID:duration\r\nDTSTART;VALUE=DATE:20260308\r\nDURATION:P2D')),
        options,
      )[0]?.end,
    ).toBe('2026-03-10')
    expect(() =>
      parseCalDavBusy(
        calendar(
          event('UID:duration\r\nDTSTART;TZID=America/New_York:20260307T090000\r\nDURATION:P1D'),
        ),
        options,
      ),
    ).toThrow()
  })
  it('rejects year zero and malformed VALUE parameters before persistence', () => {
    for (const value of [
      'DTSTART;VALUE=DATE:00000308',
      'DTSTART;VALUE=INVALID:20260308T160000Z',
      'DTSTART;VALUE=DATE:20260308T160000Z',
    ]) {
      expect(() => parseCalDavBusy(calendar(event(`UID:invalid\r\n${value}`)), options)).toThrow()
    }
  })
  it('bounds the horizon and removes out-of-range timed occurrences', () => {
    expect(
      parseCalDavBusy(calendar(event(timed.replaceAll('20260308', '20260508'))), options),
    ).toEqual([])
    expect(() =>
      parseCalDavBusy(calendar(event(timed)), {
        start: options.start,
        end: '2028-01-01T00:00:00Z',
      }),
    ).toThrow()
  })
})
