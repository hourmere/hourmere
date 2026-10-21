import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeBookingCalendar } from './booking-events.ts'
import { writeBookingConference } from './conferences.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = '2030-11-04T09:00:00Z'
const END = '2030-11-04T09:30:00Z'
const JOIN = 'https://meet.google.com/abc-defg-hij'

describe.skipIf(!serverUrl)('timed writeback replaces synced all-day dates', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it.each(['booking', 'conference', 'mirror'] as const)(
    'clears both date bounds when %s restores the booking times',
    async (kind) => {
      const f = createFixtures(db)
      const host = await f.host()
      const recipient = kind === 'mirror' ? await f.host() : host
      if (recipient !== host) await f.member(recipient.userId, host.organizationId)
      const eventTypeId = await f.eventType(host.organizationId, host.userId)
      const root = await f.booking(
        host.organizationId,
        recipient === host ? [host.userId] : [host.userId, recipient.userId],
        START,
        END,
        { eventTypeId },
      )
      const account = `synthetic-${recipient.userId}`
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: recipient.userId,
          provider: 'google',
          external_account_id: account,
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
          credentials: encryptCredential(
            Buffer.from(TEST_CALENDAR_KEY, 'base64'),
            tokenAad(recipient.userId, account),
            JSON.stringify({
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
              expiresAt: NOW.epochMilliseconds + 86_400_000,
            }),
          ),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: connection.id,
          external_id: 'synthetic-calendar',
          name: 'Synthetic calendar',
          access_role: 'owner',
          supports_google_meet: true,
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const provider = fakeGoogle()
      provider.controls.storedEvents.set('busy-event', {
        id: 'busy-event',
        iCalUID: `${root}@hourmere`,
        etag: '"v1"',
        start: { date: '2030-11-04' },
        end: { date: '2030-11-05' },
      })
      await db
        .insertInto('calendar_busy')
        .values({
          calendar_id: calendar.id,
          external_event_id: 'busy-event',
          period: null,
          all_day_start: '2030-11-04',
          all_day_end: '2030-11-05',
        })
        .execute()
      const deps: CalendarDeps = {
        db,
        now: () => NOW.epochMilliseconds,
        google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      }
      if (kind === 'booking') {
        await db
          .insertInto('booking_calendar_targets')
          .values({
            root_booking_id: root,
            user_id: host.userId,
            calendar_id: calendar.id,
          })
          .execute()
        await expect(writeBookingCalendar(deps, root)).resolves.toBeUndefined()
      } else {
        const organizer = await db
          .selectFrom('auth.user')
          .select(['email', 'name'])
          .where('id', '=', host.userId)
          .executeTakeFirstOrThrow()
        await db
          .insertInto('booking_conferences')
          .values({
            root_booking_id: root,
            booking_id: root,
            organization_id: host.organizationId,
            organizer_user_id: host.userId,
            calendar_id: kind === 'conference' ? calendar.id : null,
            connection_id: kind === 'conference' ? connection.id : null,
            external_event_id: kind === 'conference' ? 'busy-event' : null,
            create_started: true,
            state: kind === 'mirror' ? 'ready' : 'pending',
            applied_revision: kind === 'mirror' ? 0 : null,
            invitation_organizer_email: organizer.email,
            invitation_organizer_name: organizer.name,
          })
          .execute()
        if (kind === 'conference')
          await expect(writeBookingConference(deps, root)).resolves.toBeUndefined()
        else {
          await db
            .updateTable('bookings')
            .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true, url: JOIN }) })
            .where('id', '=', root)
            .execute()
          await db
            .insertInto('booking_conference_mirrors')
            .values({
              root_booking_id: root,
              user_id: recipient.userId,
              calendar_id: calendar.id,
              connection_id: connection.id,
              external_event_id: 'busy-event',
              create_started: true,
            })
            .execute()
          await expect(writeBookingCalendar(deps, root)).resolves.toBeUndefined()
          expect(
            await db
              .selectFrom('booking_conference_mirrors')
              .select('state')
              .where('root_booking_id', '=', root)
              .executeTakeFirstOrThrow(),
          ).toEqual({ state: 'ready' })
        }
      }
      const busy = await db
        .selectFrom('calendar_busy')
        .select([
          'all_day_start',
          'all_day_end',
          sql<Date>`lower(period)`.as('start'),
          sql<Date>`upper(period)`.as('end'),
        ])
        .where('calendar_id', '=', calendar.id)
        .executeTakeFirstOrThrow()
      expect(busy.all_day_start).toBeNull()
      expect(busy.all_day_end).toBeNull()
      expect(busy.start.toISOString()).toBe('2030-11-04T09:00:00.000Z')
      expect(busy.end.toISOString()).toBe('2030-11-04T09:30:00.000Z')
    },
  )
})
