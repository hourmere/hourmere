import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import type { BookingNotifier } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONFERENCE_JOB,
  conferenceBookingNotifier,
  retryBookingConference,
  writeBookingConference,
} from '../../calendars/src/conferences.ts'
import type { EnqueueOptions } from '../../jobs/src/index.ts'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotifier,
  sendBookingNotification,
} from '../../notifications/src/index.ts'
import { applyDepartureHandoff } from '../../scheduling/src/departure-handoff-apply.ts'
import {
  createHandoffTestFixture,
  createHandoffTestStorage,
  HANDOFF_NOW,
  handoffTestSession,
} from '../../scheduling/src/departure-handoff-apply-test-fixture.ts'
import { conferenceEncryptionKey } from './credentials.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'
import { credentials } from './tokens.ts'
import { createZoomConferenceWork } from './worker.ts'
import { zoomScopes } from './zoom.ts'

const databaseUrl = process.env.DATABASE_URL
const now = () => HANDOFF_NOW.epochMilliseconds

describe.skipIf(!databaseUrl)('departure handoff Zoom lifecycle (real Postgres)', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  function zoomOwner(identity: string) {
    const fake = fakeZoom(undefined, now)
    fake.controls.identity.id = identity
    const zoom = { client: fake.client, encryptionKey: TEST_CONFERENCE_KEY, meetingsEnabled: true }
    return { fake, identity, work: createZoomConferenceWork({ db, now, zoom }, fake.meetings) }
  }

  async function pinZoom(eventTypeId: string, hostId: string, identity: string) {
    const connectionId = randomUUID()
    const scopes = zoomScopes('meetings')
    await db
      .insertInto('conference_connections')
      .values({
        id: connectionId,
        user_id: hostId,
        provider: 'zoom',
        mode: 'meetings',
        external_user_id: identity,
        status: 'active',
        scopes,
        credentials: credentials(
          conferenceEncryptionKey(TEST_CONFERENCE_KEY),
          hostId,
          connectionId,
          identity,
          {
            accessToken: 'synthetic-access',
            refreshToken: 'synthetic-refresh',
            expiresAt: now() + 60 * 60_000,
            scopes,
          },
          'meetings',
        ),
      })
      .execute()
    await db
      .updateTable('event_types')
      .set({
        location: JSON.stringify({ kind: 'zoom', autoCreate: true }),
        zoom_connection_id: connectionId,
      })
      .where('id', '=', eventTypeId)
      .execute()
    return connectionId
  }

  const intent = (rootId: string) =>
    db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', rootId)
      .executeTakeFirstOrThrow()

  it('reconciles each root under its own grant and never repeats an ambiguous create', async () => {
    const oldOwner = zoomOwner('synthetic-departing-zoom')
    const newOwner = zoomOwner('synthetic-successor-zoom')
    const jobs: { name: string; payload: unknown; singletonKey: string | undefined }[] = []
    const queue = {
      async enqueue(name: string, payload: unknown, options?: EnqueueOptions) {
        expect(options?.transaction).toHaveProperty('isTransaction', true)
        jobs.push({ name, payload, singletonKey: options?.singletonKey })
        return null
      },
    }
    const notifyConference = conferenceBookingNotifier(queue)
    const notifyEmail = bookingNotifier(queue)
    const notify: BookingNotifier = async (trx, event, instant) => {
      await notifyConference(trx, event)
      await notifyEmail(trx, event, instant)
    }
    const storage = await createHandoffTestStorage(db)
    let oldConnectionId: string | undefined
    let newConnectionId: string | undefined
    const fixture = await createHandoffTestFixture(db, {
      sourceContext: { automaticZoom: true },
      applyContext: { automaticZoom: true },
      configureSource: async ({ eventTypeId, departing }) => {
        oldConnectionId = await pinZoom(eventTypeId, departing.id, oldOwner.identity)
      },
      configureTarget: async ({ eventTypeId, candidate }) => {
        newConnectionId = await pinZoom(eventTypeId, candidate.id, newOwner.identity)
      },
    })
    const { booking, candidate, ctx, departing, input, team } = fixture
    const applyContext = { ...ctx, notify }
    const sourceId = booking.id
    const work = { db, now, zoomConferenceWork: oldOwner.work }
    await writeBookingConference(work, sourceId)
    const oldReady = await intent(sourceId)
    expect(oldReady).toMatchObject({
      state: 'ready',
      organizer_user_id: departing.id,
      zoom_connection_id: oldConnectionId,
      zoom_user_id: oldOwner.identity,
      zoom_meeting_id: expect.any(String),
    })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', departing.id)
      .execute()
    const providerCallsBeforeApply = oldOwner.fake.calls.length
    await storage.offer(ctx, input, { departingUserId: departing.id })
    const applied = await applyDepartureHandoff(applyContext, input, storage.store)
    expect(oldOwner.fake.calls).toHaveLength(providerCallsBeforeApply)
    expect(newOwner.fake.calls).toHaveLength(0)

    const replacement = await db
      .selectFrom('bookings')
      .select(['id', 'location', 'rescheduled_from_id'])
      .where('organization_id', '=', team.id)
      .where('status', '=', 'confirmed')
      .executeTakeFirstOrThrow()
    expect(replacement).toMatchObject({
      location: { kind: 'zoom', autoCreate: true },
      rescheduled_from_id: null,
    })
    expect(replacement.location).not.toHaveProperty('url')
    expect(await intent(replacement.id)).toMatchObject({
      state: 'pending',
      organizer_user_id: candidate.id,
      zoom_connection_id: newConnectionId,
      zoom_user_id: newOwner.identity,
      zoom_meeting_id: null,
    })
    expect(await intent(sourceId)).toMatchObject({
      state: 'pending',
      zoom_connection_id: oldReady.zoom_connection_id,
      zoom_meeting_id: oldReady.zoom_meeting_id,
    })
    expect(jobs).toEqual(
      expect.arrayContaining([
        {
          name: CONFERENCE_JOB,
          payload: { rootBookingId: sourceId },
          singletonKey: sourceId,
        },
        {
          name: CONFERENCE_JOB,
          payload: { rootBookingId: replacement.id },
          singletonKey: replacement.id,
        },
        {
          name: BOOKING_NOTIFICATION_JOB,
          payload: { bookingId: sourceId, kind: 'cancelled' },
          singletonKey: `${sourceId}:cancelled`,
        },
        {
          name: BOOKING_NOTIFICATION_JOB,
          payload: { bookingId: replacement.id, kind: 'confirmed' },
          singletonKey: `${replacement.id}:confirmed`,
        },
      ]),
    )
    const enqueued = jobs.length
    expect(await applyDepartureHandoff(applyContext, input, storage.store)).toEqual(applied)
    expect(jobs).toHaveLength(enqueued)

    let unlocked: boolean[] = []
    newOwner.fake.controls.meetingHook = async (_url, init) => {
      unlocked = await db.transaction().execute(async (trx) => {
        const available = []
        for (const hostId of [departing.id, candidate.id].sort()) {
          const lock = await sql<{
            acquired: boolean
          }>`select pg_try_advisory_xact_lock(hashtextextended(${`booking-host:${hostId}`}, 0)) as acquired`.execute(
            trx,
          )
          available.push(lock.rows[0]?.acquired === true)
        }
        return available
      })
      // The provider stored the meeting but its response did not acknowledge creation.
      newOwner.fake.controls.storedMeetings.set('81234567900', JSON.parse(String(init.body)))
      return Response.json({}, { status: 503 })
    }
    const newWork = { db, now, zoomConferenceWork: newOwner.work }
    await writeBookingConference(newWork, replacement.id)
    expect(unlocked).toEqual([true, true])
    const failed = await intent(replacement.id)
    expect(failed).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      create_started: true,
      zoom_meeting_id: null,
    })
    newOwner.fake.controls.meetingHook = undefined
    await expect(retryBookingConference(ctx, replacement.id)).rejects.toMatchObject({
      code: 'conference_not_found',
    })
    const candidateSession = await handoffTestSession(
      db,
      candidate,
      team.as(candidate).organization,
    )
    await retryBookingConference({ ...ctx, principal: candidateSession }, replacement.id)
    await writeBookingConference(newWork, replacement.id)
    expect(await intent(replacement.id)).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      request_id: failed.request_id,
    })
    expect(newOwner.fake.calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1)
    expect(newOwner.fake.controls.storedMeetings.size).toBe(1)

    const sent: MailMessage[] = []
    const mail = {
      db,
      publicUrl: 'https://hourmere.example.test',
      secret: 'synthetic-notification-secret',
      now: () => HANDOFF_NOW,
      mailer: {
        send: async (message: MailMessage) => {
          sent.push(message)
        },
      },
    }
    await sendBookingNotification(mail, replacement.id, 'confirmed')
    expect(sent).toHaveLength(0)
    await sendBookingNotification(mail, replacement.id, 'conference_failed')
    expect(sent.length).toBeGreaterThan(0)
    for (const message of sent) {
      expect(message.attachments ?? []).toHaveLength(0)
      expect(message.text).not.toContain('https://us02web.zoom.us/j/')
      expect(message.html ?? '').not.toContain('https://us02web.zoom.us/j/')
    }

    await writeBookingConference(work, sourceId)
    expect(oldOwner.fake.calls.filter(({ init }) => init.method === 'DELETE')).toHaveLength(1)
    expect(oldOwner.fake.controls.storedMeetings.size).toBe(0)
    expect(newOwner.fake.controls.storedMeetings.size).toBe(1)
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', team.id)
        .orderBy('status')
        .execute(),
    ).toEqual([
      { id: sourceId, status: 'cancelled' },
      { id: replacement.id, status: 'confirmed' },
    ])
  })
})
