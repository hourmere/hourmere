import { parseEvents } from './events.ts'
import { parseSchedules } from './schedules.ts'
import type { MatchedUser, PlanProblem, SourceRow, SourceSnapshot } from './types.ts'

export const user: MatchedUser = {
  sourceId: 1,
  targetUserId: 'target-user',
  organizationId: 'personal-org',
  sourceTimezone: 'America/New_York',
  profile: { handle: 'host', timeZone: 'America/New_York', locale: 'en' },
  profileAction: 'preserve',
}
export const users = new Map([[1, user]])
export function snapshot(tables: SourceSnapshot['tables'] = {}): SourceSnapshot {
  return {
    sourceVersion: 'cal.diy-a5ee96f77edd',
    schemaFingerprint: 'test-fingerprint',
    extractedAt: '2026-10-31T00:00:00.000Z',
    cutoff: '2026-10-31T00:00:00.000Z',
    selectedUserIds: [1],
    tables: {
      users: [{ id: 1, defaultScheduleId: 10, timeZone: 'America/New_York' }],
      Schedule: [{ id: 10, userId: 1, name: 'Weekly hours', timeZone: 'America/New_York' }],
      Host: [{ eventTypeId: 20, userId: 1, scheduleId: null, memberId: null, groupId: null }],
      _user_eventtype: [{ A: 20, B: 1 }],
      Availability: [
        {
          id: 1,
          scheduleId: 10,
          userId: 1,
          eventTypeId: null,
          days: [1, 2, 3, 4, 5],
          startTime: '09:00:00',
          endTime: '17:00:00',
          date: null,
        },
      ],
      ...tables,
    },
  }
}
export const baseEvent: SourceRow = {
  id: 20,
  userId: 1,
  teamId: null,
  profileId: null,
  parentId: null,
  schedulingType: null,
  title: 'Consultation',
  slug: 'consultation',
  description: 'Plain text preserved.  ',
  position: 2,
  length: 30,
  multipleDuration: null,
  hideDurationSelectorInBookingPage: null,
  locations: [{ type: 'inPerson', address: '1 Example Street', displayLocationPublicly: true }],
  bookingFields: null,
  slotInterval: null,
  offsetStart: 0,
  beforeEventBuffer: 10,
  afterEventBuffer: 5,
  minimumBookingNotice: 120,
  periodType: 'unlimited',
  hidden: false,
  disableGuests: false,
  scheduleId: null,
  price: 0,
  isInstantEvent: false,
}
export function parseEvent(change: SourceRow = {}, tables: SourceSnapshot['tables'] = {}) {
  const source = snapshot({ EventType: [{ ...baseEvent, ...change }], ...tables })
  const problems: PlanProblem[] = []
  const schedules = parseSchedules(source, users, problems)
  return { events: parseEvents(source, users, schedules, problems), schedules, problems }
}
