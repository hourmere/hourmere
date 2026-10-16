// Test support for the public pages: API shapes and a slots endpoint that answers like the
// server (only slots fully inside the asked range).
import type { Schemas } from '../api/client.ts'
import { type Call, json, type Routes } from './fake-api.tsx'

export const TOKEN = 'tOkEn_0123456789abcdefghijklmnopqrstuvwxyzA'
export const NEW_TOKEN = 'nEwToKeN_123456789abcdefghijklmnopqrstuvwxy'

export const EVENT: Schemas['PublicEventType'] = {
  handle: 'ada',
  slug: 'intro',
  title: 'Intro call',
  description: 'A first conversation.',
  durationMinutes: 30,
  location: { kind: 'phone' },
  questions: [],
  host: { name: 'Ada Lovelace', timeZone: 'Europe/Berlin' },
}

/** One question of each kind. */
export const ALL_QUESTIONS: Schemas['Question'][] = [
  { id: 'topic', label: 'Topic', type: 'short_text', required: true },
  { id: 'notes', label: 'Anything else?', type: 'long_text', required: false },
  { id: 'phone', label: 'Phone', type: 'phone', required: false },
  { id: 'size', label: 'Team size', type: 'select', required: true, options: ['1–10', '11+'] },
  { id: 'tools', label: 'Tools', type: 'multi_select', required: false, options: ['MCP', 'API'] },
  { id: 'terms', label: 'I agree to the terms', type: 'checkbox', required: true },
]

export const slot = (start: string, minutes = 30): Schemas['Slot'] => ({
  start: new Date(Date.parse(start)).toISOString(),
  end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
})

/** Answers a slots request with those of `starts` that lie fully inside its range, sorted. */
export function slotsAnswer(starts: string[], minutes = 30) {
  return ({ path }: Call) => {
    const query = new URL(path, 'http://x').searchParams
    const from = Date.parse(query.get('start') ?? '')
    const to = Date.parse(query.get('end') ?? '')
    const data = starts
      .map((s) => slot(s, minutes))
      .filter((s) => Date.parse(s.start) >= from && Date.parse(s.end) <= to)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    return json(200, { data })
  }
}

export function booking(overrides: Partial<Schemas['Booking']> = {}): Schemas['Booking'] {
  return {
    id: '01900000-0000-7000-8000-0000000000b1',
    eventTypeId: '01900000-0000-7000-8000-0000000000e1',
    status: 'confirmed',
    start: '2026-11-02T14:00:00.000Z',
    end: '2026-11-02T14:30:00.000Z',
    title: 'Intro call with Grace Hopper',
    location: { kind: 'phone', number: '+49 30 1234567' },
    responses: {},
    attendees: [
      {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        timeZone: 'America/New_York',
        locale: 'en-US',
        isBooker: true,
      },
    ],
    rescheduledFromId: null,
    cancelledAt: null,
    cancelReason: null,
    source: 'web',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  }
}

export function managed(overrides: Partial<Schemas['Booking']> = {}): Schemas['ManagedBooking'] {
  return {
    ...booking(overrides),
    eventType: { title: 'Intro call', durationMinutes: 30 },
    hosts: [{ name: 'Ada Lovelace' }],
  }
}

export const eventRoutes = (event = EVENT, starts: string[] = []): Routes => ({
  [`GET /api/v1/public/${event.handle}/${event.slug}`]: () => json(200, event),
  [`GET /api/v1/public/${event.handle}/${event.slug}/slots`]: slotsAnswer(
    starts,
    event.durationMinutes,
  ),
})
