// Records as the API returns them, for the admin pages' tests.
import type { Booking, EventType, Schedule } from '../api/resources.ts'
import { ME } from './fake-api.tsx'

const CREATED = '2026-10-01T09:00:00.000Z'

export const EVENT_TYPE_ID = 'e0000000-0000-7000-8000-000000000001'
export const SCHEDULE_ID = 'c0000000-0000-7000-8000-000000000001'
export const OTHER_SCHEDULE_ID = 'c0000000-0000-7000-8000-000000000002'
export const BOOKING_ID = 'b0000000-0000-7000-8000-000000000001'

export function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: EVENT_TYPE_ID,
    organizationId: ME.organization.id,
    ownerUserId: ME.user.id,
    slug: 'intro-call',
    title: 'Intro call',
    description: null,
    durationMinutes: 30,
    slotStepMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingWindowDays: null,
    maxBookingsPerDay: null,
    schedulingType: 'individual',
    location: null,
    questions: [],
    isActive: true,
    isHidden: false,
    position: 0,
    scheduleId: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  }
}

const nineToFive = [{ start: '09:00', end: '17:00' }]

export function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    name: 'Working hours',
    timeZone: 'Europe/Berlin',
    weeklyHours: {
      monday: nineToFive,
      tuesday: nineToFive,
      wednesday: nineToFive,
      thursday: nineToFive,
      friday: nineToFive,
      saturday: [],
      sunday: [],
    },
    isDefault: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  }
}

/** A booking with Grace (and a guest), in the future unless `start` says otherwise. */
export function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: BOOKING_ID,
    eventTypeId: EVENT_TYPE_ID,
    status: 'confirmed',
    start: '2030-03-04T09:00:00.000Z',
    end: '2030-03-04T09:30:00.000Z',
    title: 'Intro call',
    location: { kind: 'phone', number: '+14155550123' },
    responses: {},
    attendees: [
      {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        timeZone: 'America/New_York',
        locale: 'en',
        isBooker: true,
      },
      {
        name: 'Alan Turing',
        email: 'alan@example.com',
        timeZone: 'America/New_York',
        locale: null,
        isBooker: false,
      },
    ],
    rescheduledFromId: null,
    cancelledAt: null,
    cancelReason: null,
    source: 'web',
    createdAt: '2030-02-01T12:00:00.000Z',
    ...over,
  }
}
