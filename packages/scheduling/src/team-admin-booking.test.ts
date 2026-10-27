import { describe, expect, it } from 'vitest'
import {
  type TeamAdminBooking,
  TeamAdminBookingPageSchema,
  type TeamAdminBookingRecord,
  TeamAdminBookingSchema,
  toTeamAdminBooking,
} from './team-admin-booking.ts'

const BOOKING_ID = '01930000-0000-7000-8000-000000000001'
const EVENT_TYPE_ID = '01930000-0000-7000-8000-000000000002'
const HOST_ID = '01930000-0000-7000-8000-000000000003'
const SUCCESSOR_ID = '01930000-0000-7000-8000-000000000004'
const START = '2026-11-02T09:00:00.000Z'
const END = '2026-11-02T09:30:00.000Z'
const CANCELLED_AT = '2026-11-01T12:05:00.000Z'

function record(overrides: Partial<TeamAdminBookingRecord> = {}): TeamAdminBookingRecord {
  return {
    id: BOOKING_ID,
    status: 'confirmed',
    start_at: new Date(START),
    end_at: new Date(END),
    cancelled_at: null,
    event_type_id: EVENT_TYPE_ID,
    event_type_title: 'Team introduction',
    hosts: [{ user_id: HOST_ID, name: 'Ada' }],
    attendees: [
      { name: 'Invitee', email: 'invitee@example.com', time_zone: 'UTC', is_booker: true },
      {
        name: 'Guest',
        email: 'guest@example.com',
        time_zone: 'America/Los_Angeles',
        is_booker: false,
      },
    ],
    ...overrides,
  }
}

function expected(): TeamAdminBooking {
  return {
    id: BOOKING_ID,
    status: 'confirmed',
    start: START,
    end: END,
    cancelledAt: null,
    eventType: { id: EVENT_TYPE_ID, title: 'Team introduction' },
    hosts: [{ userId: HOST_ID, name: 'Ada' }],
    attendees: [
      { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC', isBooker: true },
      {
        name: 'Guest',
        email: 'guest@example.com',
        timeZone: 'America/Los_Angeles',
        isBooker: false,
      },
    ],
  }
}

function expectWhitelist(value: TeamAdminBooking) {
  expect(Object.keys(value).sort()).toEqual([
    'attendees',
    'cancelledAt',
    'end',
    'eventType',
    'hosts',
    'id',
    'start',
    'status',
  ])
  if (value.eventType) expect(Object.keys(value.eventType).sort()).toEqual(['id', 'title'])
  for (const host of value.hosts) expect(Object.keys(host).sort()).toEqual(['name', 'userId'])
  for (const attendee of value.attendees)
    expect(Object.keys(attendee).sort()).toEqual(['email', 'isBooker', 'name', 'timeZone'])
  // Assert as a boolean so a failure cannot print a private value from the source.
  expect(JSON.stringify(value).includes('private-only-')).toBe(false)
}

describe('toTeamAdminBooking', () => {
  it('maps only booking time, status, team event, hosts and handling participants', () => {
    const result = toTeamAdminBooking(record())
    expect(result).toStrictEqual(expected())
    expectWhitelist(result)
    expect(TeamAdminBookingSchema.safeParse(result).success).toBe(true)
  })

  it.each([
    [
      'management tokens and hashes',
      {
        manageToken: 'private-only-manage-token',
        manage_token_hash: 'private-only-manage-hash',
        notification_manage_token_hash: 'private-only-email-hash',
      },
    ],
    [
      'personal calendar copies and retry controls',
      {
        calendarCopy: { status: 'failed', canRetry: true, calendarId: 'private-only-copy' },
        booking_calendar_targets: [{ calendar_id: 'private-only-target' }],
        booking_calendar_events: [{ external_event_id: 'private-only-copy-event' }],
      },
    ],
    [
      'private calendar content and credentials',
      {
        calendar_busy: [{ title: 'private-only-title', description: 'private-only-description' }],
        calendar_name: 'private-only-calendar-name',
        credentials: 'private-only-calendar-credentials',
      },
    ],
    [
      'nonessential custom answers, title and free-text reasons',
      {
        responses: { medical_notes: 'private-only-answer', company: 'private-only-company' },
        title: 'private-only-custom-booking-title',
        cancel_reason: 'private-only-cancellation-reason',
      },
    ],
    [
      'conference-owner capabilities and identities',
      {
        conferenceCanRetry: true,
        conference: {
          provider: 'zoom',
          status: 'ready',
          startUrl: 'https://conference.example.test/private-only-owner',
          organizerUserId: 'private-only-organizer',
          zoomConnectionId: 'private-only-connection',
        },
      },
    ],
    [
      'other organization data and credential attribution',
      {
        organization_id: 'private-only-other-team',
        api_key_id: 'private-only-api-key-id',
        oauth_consent_id: 'private-only-consent',
        idempotency_key: 'private-only-idempotency',
        required_host_user_ids: ['private-only-required-host'],
      },
    ],
  ])('excludes %s from an enriched service record', (_, extras) => {
    const result = toTeamAdminBooking({ ...record(), ...extras })
    expectWhitelist(result)
    expect(JSON.stringify(result) === JSON.stringify(expected())).toBe(true)
  })

  it('rebuilds nested host and attendee objects using their own whitelists', () => {
    const source = {
      ...record(),
      hosts: [
        {
          user_id: HOST_ID,
          name: 'Ada',
          email: 'private-only-host@example.com',
          calendarCopy: { calendarId: 'private-only-host-copy', canRetry: true },
          credentials: 'private-only-host-credential',
        },
      ],
      attendees: [
        {
          name: 'Invitee',
          email: 'invitee@example.com',
          time_zone: 'UTC',
          is_booker: true,
          responses: { notes: 'private-only-nested-answer' },
          manage_token_hash: 'private-only-nested-hash',
          calendar_busy: [{ title: 'private-only-nested-title' }],
        },
      ],
    }
    const result = toTeamAdminBooking(source)
    expectWhitelist(result)
    expect(result.hosts).not.toBe(source.hosts)
    expect(result.hosts[0]).not.toBe(source.hosts[0])
    expect(result.attendees).not.toBe(source.attendees)
    expect(result.attendees[0]).not.toBe(source.attendees[0])
  })

  for (const provider of ['zoom', 'google_meet'] as const) {
    it.each(['current ready', 'stale revision', 'cancelled', 'not visible to caller'])(
      `omits ${provider} links when the conference is %s`,
      (state) => {
        const cancelled = state === 'cancelled'
        const source = {
          ...record({
            status: cancelled ? 'cancelled' : 'confirmed',
            cancelled_at: cancelled ? new Date(CANCELLED_AT) : null,
          }),
          location: { kind: provider, url: 'https://conference.example.test/private-only-join' },
          conference: {
            provider,
            status: 'ready',
            bookingId: BOOKING_ID,
            revision: state === 'stale revision' ? 2 : 1,
            appliedRevision: 1,
            visibleToCaller: state !== 'not visible to caller',
            joinUrl: 'https://conference.example.test/private-only-conference-join',
          },
        }
        const result = toTeamAdminBooking(source)
        expectWhitelist(result)
        expect(result.status).toBe(cancelled ? 'cancelled' : 'confirmed')
        expect(result.cancelledAt).toBe(cancelled ? CANCELLED_AT : null)
      },
    )

    it(`omits ${provider} links on both sides of a reschedule and later cancellation`, () => {
      const source = {
        ...record(),
        location: { kind: provider, url: 'https://conference.example.test/private-only-old' },
        conference: { provider, status: 'ready', bookingId: BOOKING_ID },
        rescheduled_to_id: SUCCESSOR_ID,
      }
      const before = toTeamAdminBooking(source)
      const predecessorRecord = {
        ...source,
        status: 'cancelled' as const,
        cancelled_at: new Date(CANCELLED_AT),
        conference: { ...source.conference, bookingId: SUCCESSOR_ID },
      }
      const predecessor = toTeamAdminBooking(predecessorRecord)
      const successorRecord = {
        ...source,
        id: SUCCESSOR_ID,
        start_at: new Date('2026-11-02T10:00:00Z'),
        end_at: new Date('2026-11-02T10:30:00Z'),
        rescheduled_from_id: BOOKING_ID,
        location: { kind: provider, url: 'https://conference.example.test/private-only-new' },
      }
      const successor = toTeamAdminBooking(successorRecord)
      const cancelledSuccessor = toTeamAdminBooking({
        ...successorRecord,
        status: 'cancelled',
        cancelled_at: new Date(CANCELLED_AT),
      })
      for (const result of [before, predecessor, successor, cancelledSuccessor])
        expectWhitelist(result)
      expect(before.status).toBe('confirmed')
      expect(predecessor.status).toBe('cancelled')
      expect(predecessor.id).toBe(BOOKING_ID)
      expect(successor.id).toBe(SUCCESSOR_ID)
      expect(successor.start).toBe('2026-11-02T10:00:00.000Z')
      expect(cancelledSuccessor.status).toBe('cancelled')
    })
  }

  it('detaches an existing response from later source changes', () => {
    const source = record()
    const result = toTeamAdminBooking(source)
    const host = source.hosts[0]
    const attendee = source.attendees[0]
    if (!host || !attendee) throw new Error('Missing fixture participants')
    Object.assign(host, { name: 'Changed host', credentials: 'private-only-later' })
    Object.assign(attendee, {
      name: 'Changed attendee',
      responses: { notes: 'private-only-later-answer' },
    })
    source.start_at.setUTCFullYear(2027)
    source.status = 'cancelled'
    source.cancelled_at = new Date(CANCELLED_AT)
    expectWhitelist(result)
    expect(result).toStrictEqual(expected())
  })

  it.each([
    ['an absent event type', null, null],
    ['a deleted event type with a retained id', EVENT_TYPE_ID, null],
  ] as const)('preserves %s without falling back to private booking text', (_, id, title) => {
    const source = {
      ...record({ event_type_id: id, event_type_title: title, hosts: [], attendees: [] }),
      title: 'private-only-booking-title',
    }
    const result = toTeamAdminBooking(source)
    expectWhitelist(result)
    expect(result.eventType).toEqual(id === null ? null : { id, title: null })
    expect(result.hosts).toEqual([])
    expect(result.attendees).toEqual([])
    expect(TeamAdminBookingSchema.safeParse(result).success).toBe(true)
  })
})

describe('TeamAdminBookingPageSchema', () => {
  it.each([null, 'opaque-cursor'])(
    'accepts the same DTO whitelist with cursor %s',
    (nextCursor) => {
      const page = { data: [expected()], nextCursor }
      expect(TeamAdminBookingPageSchema.parse(page)).toStrictEqual(page)
    },
  )

  it('accepts an empty final page', () => {
    expect(TeamAdminBookingPageSchema.parse({ data: [], nextCursor: null })).toStrictEqual({
      data: [],
      nextCursor: null,
    })
  })

  it('rejects unknown fields on the page', () => {
    expect(
      TeamAdminBookingPageSchema.safeParse({
        data: [expected()],
        nextCursor: null,
        calendarCopy: { calendarId: 'private-only-page-copy' },
      }).success,
    ).toBe(false)
  })

  it('rejects a booking with extra fields inside a list', () => {
    expect(
      TeamAdminBookingPageSchema.safeParse({
        data: [{ ...expected(), conferenceCanRetry: true }],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })

  it('rejects private fields nested inside a listed participant', () => {
    expect(
      TeamAdminBookingPageSchema.safeParse({
        data: [
          {
            ...expected(),
            attendees: [
              { ...expected().attendees[0], manage_token_hash: 'private-only-list-hash' },
            ],
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })

  it('requires an explicit next cursor', () => {
    expect(TeamAdminBookingPageSchema.safeParse({ data: [] }).success).toBe(false)
  })
})

describe('TeamAdminBookingSchema', () => {
  it('accepts the independent minimum response contract', () => {
    expect(TeamAdminBookingSchema.parse(expected())).toStrictEqual(expected())
  })

  it('accepts cancellation, a missing event and no remaining participants', () => {
    expect(
      TeamAdminBookingSchema.safeParse({
        ...expected(),
        status: 'cancelled',
        cancelledAt: CANCELLED_AT,
        eventType: null,
        hosts: [],
        attendees: [],
      }).success,
    ).toBe(true)
  })

  it.each([
    ['booking', { ...expected(), manageToken: 'private-only-schema-token' }],
    [
      'event type',
      {
        ...expected(),
        eventType: { ...expected().eventType, questions: [{ label: 'private-only-question' }] },
      },
    ],
    [
      'host',
      {
        ...expected(),
        hosts: [{ ...expected().hosts[0], calendarCopy: { calendarId: 'private-only-copy' } }],
      },
    ],
    [
      'attendee',
      {
        ...expected(),
        attendees: [{ ...expected().attendees[0], responses: { notes: 'private-only-answer' } }],
      },
    ],
  ])('rejects unknown fields at the %s boundary instead of silently filtering them', (_, value) => {
    expect(TeamAdminBookingSchema.safeParse(value).success).toBe(false)
  })

  it.each(['id', 'status', 'start', 'end', 'cancelledAt', 'eventType', 'hosts', 'attendees'])(
    'requires %s',
    (field) => {
      const value: Record<string, unknown> = { ...expected() }
      delete value[field]
      expect(TeamAdminBookingSchema.safeParse(value).success).toBe(false)
    },
  )

  it.each([
    ['unknown status', { ...expected(), status: 'pending' }],
    [
      'non-boolean booker',
      { ...expected(), attendees: [{ ...expected().attendees[0], isBooker: 1 }] },
    ],
    ['non-string event title', { ...expected(), eventType: { id: EVENT_TYPE_ID, title: 1 } }],
    ['non-array hosts', { ...expected(), hosts: {} }],
  ])('rejects %s', (_, value) => {
    expect(TeamAdminBookingSchema.safeParse(value).success).toBe(false)
  })
})
