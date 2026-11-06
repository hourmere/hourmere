import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { ConferenceWork } from '@hourmere/scheduling/conferences'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authorizeZoomMeetings, type ConferenceDeps, finishZoomConnection } from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { zoomScopes } from './zoom.ts'

const target =
  process.env.HOURMERE_SILENCE_MUTATION_TARGET === 'worker.ts'
    ? (process.env.HOURMERE_SILENCE_MUTATION_FILE as string)
    : './worker.ts'
const { createZoomConferenceWork }: typeof import('./worker.ts') = await import(target)
const now = Date.parse('2030-11-03T12:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)(
  'imported bookings stay local across Zoom workers',
  () => {
    let database: TestDatabase
    let db: Db
    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'silent_zoom',
      })
      db = createDb(database.pool)
    })
    afterAll(async () => database?.drop())
    it('Zoom work refuses stale imported roots before token refresh or any provider call', async () => {
      const owner = await conferenceTestSession(db)
      await db
        .updateTable('auth.session')
        .set({ expiresAt: new Date('2035-01-01T00:00Z') })
        .where('id', '=', owner.sessionId)
        .execute()
      const provider = fakeZoom('http://localhost:5173', () => now)
      provider.controls.token.scope = zoomScopes('meetings').join(' ')
      const deps: ConferenceDeps = {
        db,
        now: () => now,
        zoom: {
          client: provider.client,
          encryptionKey: TEST_CONFERENCE_KEY,
          meetingsEnabled: true,
        },
      }
      const auth = new URL((await authorizeZoomMeetings(deps, owner)).authorizationUrl)
      expect(
        await finishZoomConnection(
          deps,
          owner,
          new URLSearchParams({ state: auth.searchParams.get('state') as string, code: 'fake' }),
        ),
      ).toBe('connected')
      const connection = await db
        .selectFrom('conference_connections')
        .select('id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirstOrThrow()
      const root = await createFixtures(db).booking(
        owner.organization.id,
        [owner.user.id],
        '2030-11-04T09:00Z',
        '2030-11-04T09:30Z',
        { source: 'import' },
      )
      const work: ConferenceWork = {
        rootBookingId: root,
        organizerUserId: owner.user.id,
        connectionId: connection.id,
        externalUserId: provider.controls.identity.id as string,
        meetingId: null,
        create: true,
        createStarted: true,
        booking: {
          title: 'Synthetic imported booking',
          start_at: new Date('2030-11-04T09:00Z'),
          end_at: new Date('2030-11-04T09:30Z'),
          status: 'confirmed',
        },
      }
      provider.calls.length = 0
      expect(
        await createZoomConferenceWork(deps, provider.meetings)(work, new AbortController().signal),
      ).toEqual({ error: 'imported_booking_read_only', knownNoCreate: true })
      expect(provider.calls).toEqual([])
      expect(provider.controls.storedMeetings.size).toBe(0)
    })
  },
)
