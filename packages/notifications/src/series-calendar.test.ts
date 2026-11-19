import ICAL from 'ical.js'
import { expect, it } from 'vitest'
import { type SeriesCalendarMember, seriesCalendarSnapshot } from './series-calendar.ts'

const organizer = { name: 'Studio', email: 'calendar@example.test' }
const guest = { name: 'Guest', email: 'guest@example.test', role: 'guest', locale: 'en' } as const
const host = { ...organizer, role: 'host', locale: 'en' } as const
const start = Temporal.Instant.from('2030-03-11T13:00Z')
const end = start.add({ minutes: 30 })
const sentAt = new Date('2030-03-01T08:00:00.100Z')
const join = 'https://meet.example.test/studio'

function member(
  ordinal: number,
  overrides: Partial<SeriesCalendarMember> = {},
): SeriesCalendarMember {
  return {
    ordinal,
    rootId: `root-${ordinal}`,
    depth: 2,
    start,
    end,
    state: 'confirmed',
    organizer,
    hasProviderCopy: false,
    ...overrides,
  }
}

it('adds ready links to the same independent entries with a newer calendar timestamp', () => {
  const original = seriesCalendarSnapshot(
    { kind: 'confirmed' },
    [member(1, { conference: { state: 'pending' } })],
    guest,
    'Studio hours',
    'Booker',
    sentAt,
  )
  const action = { kind: 'link_update', previousReportAt: sentAt } as const
  const changed = [
    member(1, { conference: { state: 'ready', url: join } }),
    member(2, { conference: { state: 'failed' } }),
    member(3, { state: 'started', conference: { state: 'ready', url: join } }),
    member(4, { state: 'updated_separately', conference: { state: 'ready', url: join } }),
  ]
  const updated = seriesCalendarSnapshot(
    action,
    changed,
    guest,
    'Studio hours',
    'Booker',
    new Date('2030-03-01T08:00:00.900Z'),
  )

  function parseOnlyEntry(snapshot: typeof updated) {
    expect(snapshot.ordinals).toEqual([1])
    expect(snapshot.attachment?.contentType).toBe('text/calendar; charset=UTF-8')
    const calendar = new ICAL.Component(ICAL.parse(snapshot.attachment?.content ?? ''))
    expect(calendar.name).toBe('vcalendar')
    expect(calendar.hasProperty('method')).toBe(false)
    const entries = calendar.getAllSubcomponents()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (!entry) throw new Error('Expected a calendar entry')
    expect(entry.name).toBe('vevent')
    expect(entry.getFirstPropertyValue('uid')).toBe('root-1@hourmere')
    expect(entry.getFirstPropertyValue('sequence')).toBe(2)
    expect(entry.getFirstPropertyValue('status')).toBe('CONFIRMED')
    expect(entry.getFirstPropertyValue('organizer')).toBe('mailto:calendar@example.test')
    expect(entry.getFirstPropertyValue('dtstart')?.toString()).toBe('2030-03-11T13:00:00Z')
    expect(entry.getFirstPropertyValue('dtend')?.toString()).toBe('2030-03-11T13:30:00Z')
    expect(entry.getAllProperties('attendee').map((p) => p.getFirstValue())).toEqual([
      'mailto:guest@example.test',
    ])
    return entry
  }

  const before = parseOnlyEntry(original)
  const after = parseOnlyEntry(updated)
  expect(before.getFirstPropertyValue('dtstamp')?.toString()).toBe('2030-03-01T08:00:00Z')
  expect(after.getFirstPropertyValue('dtstamp')?.toString()).toBe('2030-03-01T08:00:01Z')
  expect(before.getFirstPropertyValue('description')).toBe('Meeting link pending')
  expect(before.hasProperty('location')).toBe(false)
  expect(after.getFirstPropertyValue('description')).toBe(join)
  expect(after.getFirstPropertyValue('location')).toBe(join)

  expect(
    seriesCalendarSnapshot(
      action,
      changed.map((m) => ({ ...m, hasProviderCopy: true })),
      host,
      'Studio hours',
      'Booker',
      sentAt,
    ),
  ).toEqual({ attachment: undefined, ordinals: [] })
})
