import type { ParseOptions, SourceRow, SourceSnapshot } from './types.ts'

/**
 * Source provenance (all rows contain only the importer's allowed projection):
 * - cal.diy a5ee96f77edd scripts/seed.ts:185-196: 30min event and future booking.
 * - packages/features/bookings/lib/handleCancelBooking/test/handleCancelBooking.test.ts:
 *   1414-1434: persisted Daily + Google Calendar reference pair, deleted: null.
 * - packages/features/bookings/lib/EventManager.ts:388-409: one reference per
 *   integration result; meetingUrl comes from createdEvent.url.
 * - packages/app-store/googlecalendar/lib/CalendarService.ts:330-332: url: ''.
 * - packages/app-store/{zoomvideo,dailyvideo,office365video}/lib/VideoApiAdapter.ts:
 *   523-526 / 260-263 / 251-254: video type and participant URL result shapes.
 * - BookingReference's nullable meetingUrl/deleted columns agree in a5ee96f77edd
 *   packages/prisma/schema.prisma:801-815 and v6.2.0 schema.prisma:818-832.
 * Dates, identities and participant URLs are deterministic synthetic replacements.
 * Credentials, passwords, external IDs and booking capabilities are not fixtures.
 */
export const referenceBaselines = ['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'] as const
export const videoReferences = [
  {
    type: 'zoom_video',
    location: 'integrations:zoom',
    meetingUrl: 'https://zoom.us/j/123456789',
  },
  {
    type: 'daily_video',
    location: 'integrations:daily',
    meetingUrl: 'https://api-demo.daily.co/ePR84NQ1bPigp79dDezz',
  },
  {
    type: 'office365_video',
    location: 'integrations:office365_video',
    meetingUrl: 'https://teams.microsoft.com/l/meetup-join/fixture',
  },
] as const
export const calendarReferenceTypes = ['google_calendar', 'office365_calendar'] as const
export function projectedCalendarReference(
  type: (typeof calendarReferenceTypes)[number],
): SourceRow {
  // Google produces ''; Office 365 can omit the participant URL. The fixed SQL
  // projection returns NULL in either case. No URL is fabricated for the row.
  return { id: 2, bookingId: 30, type, deleted: null, meetingUrl: null }
}
export function referenceFixture(
  sourceVersion: SourceSnapshot['sourceVersion'] = referenceBaselines[0],
  video: (typeof videoReferences)[number] = videoReferences[0],
  calendar: (typeof calendarReferenceTypes)[number] = calendarReferenceTypes[0],
): { snapshot: SourceSnapshot; options: ParseOptions } {
  const targetUserId = '019a4321-1234-7000-8000-000000000001'
  return {
    snapshot: {
      sourceVersion,
      schemaFingerprint: 'a'.repeat(64),
      cutoff: '2026-11-01T00:00:00.000Z',
      extractedAt: '2026-11-01T00:00:00.000Z',
      selectedUserIds: [1],
      tables: {
        users: [
          {
            id: 1,
            email: 'owner@example.com',
            emailVerified: '2026-01-01T00:00:00.000Z',
            username: 'owner',
            timeZone: 'UTC',
            locale: 'en',
            defaultScheduleId: 20,
          },
        ],
        EventType: [
          {
            id: 10,
            userId: 1,
            teamId: null,
            profileId: null,
            parentId: null,
            schedulingType: null,
            title: '30min',
            slug: '30min',
            length: 30,
            position: 0,
            hidden: false,
            disableGuests: false,
            offsetStart: 0,
            periodType: 'unlimited',
            scheduleId: 20,
            bookingFields: [],
            locations: [{ type: video.location }],
            price: 0,
          },
        ],
        _user_eventtype: [{ A: 10, B: 1 }],
        Schedule: [{ id: 20, userId: 1, name: 'Hours', timeZone: 'UTC' }],
        Availability: [
          {
            id: 21,
            scheduleId: 20,
            userId: 1,
            eventTypeId: null,
            days: [1],
            date: null,
            startTime: '09:00:00',
            endTime: '17:00:00',
          },
        ],
        Booking: [
          {
            id: 30,
            userId: 1,
            eventTypeId: 10,
            title: '30min',
            startTime: '2026-11-02T05:00:00.000Z',
            endTime: '2026-11-02T05:30:00.000Z',
            status: 'accepted',
            location: video.location,
            responses: {
              name: 'Booker',
              email: 'booker@example.com',
              location: { optionValue: '', value: video.location },
            },
            paid: false,
            rescheduled: false,
          },
        ],
        Attendee: [
          {
            id: 40,
            bookingId: 30,
            name: 'Booker',
            email: 'booker@example.com',
            timeZone: 'UTC',
            locale: 'en',
          },
        ],
        BookingReference: [
          { id: 1, bookingId: 30, type: video.type, meetingUrl: video.meetingUrl, deleted: null },
          projectedCalendarReference(calendar),
        ],
      },
    },
    options: {
      target: {
        users: [
          {
            id: targetUserId,
            email: 'owner@example.com',
            emailVerified: true,
            personalOrganizationId: '019a4321-1234-7000-8000-000000000002',
            authorized: true,
          },
        ],
        occupiedHandles: [],
        occupiedSlugs: [],
        busy: [],
      },
      bookingDecisions: [
        { sourceBookingId: 30, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
      ],
    },
  }
}
