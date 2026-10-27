import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TeamAdminBooking, TeamAdminBookingRecord } from './team-admin-booking.ts'

type BookingModule = Pick<
  typeof import('./team-admin-booking.ts'),
  'toTeamAdminBooking' | 'TeamAdminBookingSchema' | 'TeamAdminBookingPageSchema'
>

function sourceCopy(replacement?: [string, string]): BookingModule {
  let source = readFileSync('packages/scheduling/src/team-admin-booking.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function(
    'z',
    `${source}; return { toTeamAdminBooking, TeamAdminBookingSchema, TeamAdminBookingPageSchema }`,
  )(z) as BookingModule
}

const BOOKING_ID = '01930000-0000-7000-8000-000000000001'
const EVENT_ID = '01930000-0000-7000-8000-000000000002'
const HOST_ID = '01930000-0000-7000-8000-000000000003'
const SUCCESSOR_ID = '01930000-0000-7000-8000-000000000004'

function response(): TeamAdminBooking {
  return {
    id: BOOKING_ID,
    status: 'confirmed',
    start: '2026-11-02T09:00:00.000Z',
    end: '2026-11-02T09:30:00.000Z',
    cancelledAt: null,
    eventType: { id: EVENT_ID, title: 'Team meeting' },
    hosts: [{ userId: HOST_ID, name: 'Host' }],
    attendees: [{ name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC', isBooker: true }],
  }
}

function richRecord(overrides: Partial<TeamAdminBookingRecord> = {}) {
  return {
    id: BOOKING_ID,
    status: 'confirmed' as const,
    start_at: new Date('2026-11-02T09:00:00Z'),
    end_at: new Date('2026-11-02T09:30:00Z'),
    cancelled_at: null,
    event_type_id: EVENT_ID,
    event_type_title: 'Team meeting',
    manageToken: 'private-only-token',
    manage_token_hash: 'private-only-hash',
    notification_manage_token_hash: 'private-only-notification-hash',
    calendarCopy: { calendarId: 'private-only-copy', canRetry: true },
    calendar_busy: [{ title: 'private-only-calendar-title', content: 'private-only-content' }],
    responses: { notes: 'private-only-custom-answer' },
    title: 'private-only-custom-title',
    cancel_reason: 'private-only-free-text',
    conferenceCanRetry: true,
    conference: {
      provider: 'zoom',
      status: 'ready',
      bookingId: BOOKING_ID,
      startUrl: 'https://conference.example.test/private-only-owner',
    },
    location: { kind: 'zoom', url: 'https://conference.example.test/private-only-participant' },
    unrelatedTeam: { title: 'private-only-other-team' },
    hosts: [
      {
        user_id: HOST_ID,
        name: 'Host',
        email: 'private-only-host@example.com',
        calendarCopy: { calendarId: 'private-only-host-copy' },
      },
    ],
    attendees: [
      {
        name: 'Invitee',
        email: 'invitee@example.com',
        time_zone: 'UTC',
        is_booker: true,
        responses: { notes: 'private-only-attendee-answer' },
        manage_token_hash: 'private-only-attendee-hash',
      },
    ],
    ...overrides,
  }
}

function verify(copy: BookingModule) {
  const cancelledAt = new Date('2026-11-01T12:05:00Z')
  const current = richRecord()
  const cancelled = richRecord({ status: 'cancelled', cancelled_at: cancelledAt })
  const predecessor = {
    ...cancelled,
    rescheduled_to_id: SUCCESSOR_ID,
    conference: { ...current.conference, bookingId: SUCCESSOR_ID },
  }
  const successor = {
    ...richRecord({ id: SUCCESSOR_ID, start_at: new Date('2026-11-03T09:00:00Z') }),
    rescheduled_from_id: BOOKING_ID,
  }
  const cancelledSuccessor = {
    ...successor,
    status: 'cancelled' as const,
    cancelled_at: cancelledAt,
  }

  for (const source of [current, cancelled, predecessor, successor, cancelledSuccessor]) {
    const result = copy.toTeamAdminBooking(source)
    // Boolean assertions keep even intentional leak failures from printing capability values.
    expect(
      JSON.stringify(Object.keys(result).sort()) === JSON.stringify(Object.keys(response()).sort()),
    ).toBe(true)
    expect(JSON.stringify(Object.keys(result.hosts[0] ?? {}).sort()) === '["name","userId"]').toBe(
      true,
    )
    expect(
      JSON.stringify(Object.keys(result.attendees[0] ?? {}).sort()) ===
        '["email","isBooker","name","timeZone"]',
    ).toBe(true)
    expect(JSON.stringify(result).includes('private-only-')).toBe(false)
    expect(result.status).toBe(source.status)
    expect(result.id).toBe(source.id)
    expect(result.cancelledAt).toBe(source.cancelled_at?.toISOString() ?? null)
    expect(copy.TeamAdminBookingSchema.safeParse(result).success).toBe(true)
  }

  const valid = response()
  expect(copy.TeamAdminBookingSchema.safeParse(valid).success).toBe(true)
  expect(
    copy.TeamAdminBookingPageSchema.safeParse({ data: [valid], nextCursor: null }).success,
  ).toBe(true)
  for (const value of [
    { ...valid, manageToken: 'private-only-schema-token' },
    { ...valid, eventType: { ...valid.eventType, questions: ['private-only-question'] } },
    { ...valid, hosts: [{ ...valid.hosts[0], calendarCopy: 'private-only-schema-copy' }] },
    { ...valid, attendees: [{ ...valid.attendees[0], responses: 'private-only-schema-answer' }] },
  ]) {
    expect(copy.TeamAdminBookingSchema.safeParse(value).success).toBe(false)
    expect(
      copy.TeamAdminBookingPageSchema.safeParse({ data: [value], nextCursor: null }).success,
    ).toBe(false)
  }
  expect(
    copy.TeamAdminBookingPageSchema.safeParse({
      data: [valid],
      nextCursor: null,
      privateDetails: 'private-only-page',
    }).success,
  ).toBe(false)
}

const mapperStart = 'return {\n    id: record.id,'
const leak = (fields: string): [string, string] => [
  mapperStart,
  `return {\n    ${fields}\n    id: record.id,`,
]

describe('team admin booking source-copy mutations', () => {
  it('passes the shared privacy assertions for the unmodified source copy', () =>
    verify(sourceCopy()))

  it.each<[string, [string, string]]>([
    ['management token exclusion', leak('manageToken: record.manageToken,')],
    [
      'management and notification hash exclusion',
      leak(
        'manage_token_hash: record.manage_token_hash, notification_manage_token_hash: record.notification_manage_token_hash,',
      ),
    ],
    ['personal calendar copy exclusion', leak('calendarCopy: record.calendarCopy,')],
    ['private calendar content exclusion', leak('calendar_busy: record.calendar_busy,')],
    [
      'custom answer and free-text exclusion',
      leak('responses: record.responses, title: record.title, cancelReason: record.cancel_reason,'),
    ],
    [
      'conference-owner capability exclusion',
      leak('conferenceCanRetry: record.conferenceCanRetry,'),
    ],
    [
      'conference and location link exclusion',
      leak('conference: record.conference, location: record.location,'),
    ],
    ['root field whitelist', leak('...record,')],
    [
      'nested host field whitelist',
      [
        '({ userId: host.user_id, name: host.name })',
        '({ ...host, userId: host.user_id, name: host.name })',
      ],
    ],
    [
      'nested attendee field whitelist',
      [
        'attendees: record.attendees.map((attendee) => ({',
        'attendees: record.attendees.map((attendee) => ({ ...attendee,',
      ],
    ],
    [
      'strict booking schema',
      ['TeamAdminBookingSchema = z.strictObject({', 'TeamAdminBookingSchema = z.object({'],
    ],
    ['strict event schema', ['eventType: z\n    .strictObject({', 'eventType: z\n    .object({']],
    ['strict host schema', ['hosts: z.array(z.strictObject({', 'hosts: z.array(z.object({']],
    [
      'strict attendee schema',
      ['attendees: z.array(\n    z.strictObject({', 'attendees: z.array(\n    z.object({'],
    ],
    [
      'strict page schema',
      ['TeamAdminBookingPageSchema = z.strictObject({', 'TeamAdminBookingPageSchema = z.object({'],
    ],
  ])('detects removal of %s with a real assertion failure', (_, replacement) => {
    // Compile before entering the assertion-error check: syntax/load errors do not count.
    const mutated = sourceCopy(replacement)
    expect(() => verify(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
