// Public, synthetic product examples only. Used with the helper-owned e2e database;
// the caller pins its browser clock to SCREENSHOT_NOW before the first navigation.
import type { Db } from '../../packages/db/src/index.ts'
import type { Fixtures } from '../../packages/scheduling/src/testing.ts'
import { AUDIT_NOW } from './audit-data.ts'

export const SCREENSHOT_NOW = AUDIT_NOW
export const SCREENSHOT_TIME_ZONE = 'UTC'
export const SCREENSHOT_HANDLE = 'avery'
export const SCREENSHOT_HOST = 'Avery Morgan'
export const SCREENSHOT_HOST_EMAIL = 'avery@hourmere.invalid'
export const SCREENSHOT_BOOKING_DAY = '2030-01-08'
export const SCREENSHOT_INVITEE = { name: 'Taylor Kim', email: 'taylor@hourmere.invalid' }

export const SCREENSHOT_EVENT_TYPES = [
  {
    slug: 'product-discovery',
    title: 'Product discovery',
    description: 'A focused conversation about your product goals, challenges, and next steps.',
    durationMinutes: 30,
    questions: [
      {
        id: 'topic',
        label: 'What would you like to explore?',
        type: 'long_text',
        required: false,
      },
    ],
  },
  {
    slug: 'design-review',
    title: 'Design review',
    description: 'Make time for thoughtful feedback on a work in progress.',
    durationMinutes: 45,
  },
  {
    slug: 'quick-chat',
    title: 'Quick chat',
    description: 'A little time to connect, ask a question, or share an idea.',
    durationMinutes: 15,
  },
] as const

export const SCREENSHOT_BOOKINGS = [
  {
    start: '2030-01-09T10:00:00.000Z',
    end: '2030-01-09T10:30:00.000Z',
    attendee: { name: 'Jordan Ellis', email: 'jordan@hourmere.invalid' },
  },
  {
    start: '2030-01-10T14:00:00.000Z',
    end: '2030-01-10T14:45:00.000Z',
    attendee: { name: 'Sam Rivera', email: 'sam@hourmere.invalid' },
  },
  {
    start: '2030-01-11T11:00:00.000Z',
    end: '2030-01-11T11:15:00.000Z',
    attendee: { name: 'Casey Chen', email: 'casey@hourmere.invalid' },
  },
] as const

export interface ScreenshotFixtureState {
  bookingPath: string
  eventTypeId: string
  scheduleId: string
}

/** Prepare once, before using the generic fixture's event types or creating bookings. */
export async function seedScreenshotData(
  db: Db,
  f: Fixtures,
  host: { userId: string; organizationId: string },
): Promise<ScreenshotFixtureState> {
  await db
    .updateTable('auth.user')
    .set({ name: SCREENSHOT_HOST, email: SCREENSHOT_HOST_EMAIL, image: null })
    .where('id', '=', host.userId)
    .execute()
  await db
    .updateTable('auth.organization')
    .set({ name: SCREENSHOT_HOST, slug: SCREENSHOT_HANDLE })
    .where('id', '=', host.organizationId)
    .execute()
  await db
    .updateTable('profiles')
    .set({ handle: SCREENSHOT_HANDLE, time_zone: SCREENSHOT_TIME_ZONE, locale: 'en' })
    .where('user_id', '=', host.userId)
    .execute()
  const schedule = await db
    .selectFrom('schedules')
    .select('id')
    .where('user_id', '=', host.userId)
    .where('is_default', '=', true)
    .executeTakeFirstOrThrow()
  const fullDay = [{ start: '09:00', end: '17:00' }]
  await db
    .updateTable('schedules')
    .set({
      name: 'Working hours',
      time_zone: SCREENSHOT_TIME_ZONE,
      weekly_hours: JSON.stringify({
        monday: fullDay,
        tuesday: fullDay,
        wednesday: fullDay,
        thursday: fullDay,
        friday: [{ start: '09:00', end: '15:00' }],
      }),
      created_at: SCREENSHOT_NOW,
    })
    .where('id', '=', schedule.id)
    .execute()
  // Inactive types still appear in the admin list. Replace only this host's personal
  // fixture types, before they have any bookings, and retain the unrelated team data.
  await db
    .deleteFrom('event_types')
    .where('organization_id', '=', host.organizationId)
    .where('owner_user_id', '=', host.userId)
    .execute()
  const eventTypeIds: string[] = []
  for (const [index, event] of SCREENSHOT_EVENT_TYPES.entries()) {
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: event.slug,
      title: event.title,
      description: event.description,
      durationMinutes: event.durationMinutes,
      questions: 'questions' in event ? [...event.questions] : [],
      minimumNoticeMinutes: 30,
    })
    await db
      .updateTable('event_types')
      .set({ position: (index + 1) * 10, created_at: SCREENSHOT_NOW })
      .where('id', '=', eventTypeId)
      .execute()
    eventTypeIds.push(eventTypeId)
  }
  for (const [index, booking] of SCREENSHOT_BOOKINGS.entries()) {
    const eventTypeId = eventTypeIds[index] as string
    const event = SCREENSHOT_EVENT_TYPES[index] as (typeof SCREENSHOT_EVENT_TYPES)[number]
    const bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      booking.start,
      booking.end,
      { eventTypeId, attendee: booking.attendee },
    )
    await db
      .updateTable('bookings')
      .set({
        title: `${event.title} with ${booking.attendee.name}`,
        source: 'web',
        created_at: SCREENSHOT_NOW,
      })
      .where('id', '=', bookingId)
      .execute()
  }
  return {
    bookingPath: `/${SCREENSHOT_HANDLE}/${SCREENSHOT_EVENT_TYPES[0].slug}`,
    eventTypeId: eventTypeIds[0] as string,
    scheduleId: schedule.id,
  }
}
