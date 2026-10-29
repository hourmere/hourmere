import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
} from '@hourmere/notifications'
import * as scheduling from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeBookingConference } from '../../../packages/calendars/src/conferences.ts'
import { conferenceEncryptionKey } from '../../../packages/conferences/src/credentials.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../../packages/conferences/src/testing.ts'
import { credentials } from '../../../packages/conferences/src/tokens.ts'
import { createZoomConferenceWork } from '../../../packages/conferences/src/worker.ts'
import { zoomScopes } from '../../../packages/conferences/src/zoom.ts'
import { teamManagementAccess } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00Z')
const START = '2030-11-04T09:00Z'
const END = '2030-11-04T09:30Z'
const REASON = 'The original host is unavailable.'
const SECRET = 'synthetic-notification-secret'
type Cancel = typeof scheduling.cancelTeamAdminBooking

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const code = stripTypeScriptTypes(source).replace(/from '([^']+)'/g, (_, specifier: string) => {
    const resolved =
      replacements[specifier] ??
      (specifier.startsWith('.')
        ? new URL(specifier, location).href
        : import.meta.resolve(specifier))
    return `from '${resolved}'`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

describe.skipIf(!serverUrl)('team administrator cancellation notification transaction', () => {
  let owned: TestDatabase
  let db: Db
  let host: TestUser
  let admin: TestUser
  let team: TestTeam
  let principal: Principal
  let eventId: string
  let connectionId: string
  let jobs: ReturnType<typeof createJobs>
  let notify: scheduling.BookingNotifier
  const sent: MailMessage[] = []
  const mail = () =>
    bookingNotificationJob({
      db,
      secret: SECRET,
      publicUrl: 'https://hourmere.example',
      now: () => NOW,
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 100,
      mailer: {
        senderEmail: 'calendar@hourmere.example',
        async send(message) {
          sent.push(message)
        },
      },
      log: () => {},
    })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'admin_mail' })
    db = createDb(owned.pool)
    host = await createTestUser(db, 'Original Host')
    admin = await createTestUser(db, 'Acting Administrator')
    team = await createTestTeam(db, [
      { user: host, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    await db
      .insertInto('profiles')
      .values({ user_id: host.id, handle: 'original-host', time_zone: 'UTC' })
      .execute()
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: admin.id,
        token: `synthetic-${randomUUID()}`,
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    principal = { ...team.as(admin), kind: 'session', sessionId: session.id }
    eventId = await createFixtures(db).eventType(team.id, null, {
      title: 'Team coordination',
      hosts: [{ userId: host.id }],
    })
    connectionId = randomUUID()
    await db
      .insertInto('conference_connections')
      .values({
        id: connectionId,
        provider: 'zoom',
        user_id: host.id,
        external_user_id: 'synthetic-zoom-identity',
        mode: 'meetings',
        status: 'active',
        scopes: zoomScopes('meetings'),
        credentials: credentials(
          conferenceEncryptionKey(TEST_CONFERENCE_KEY),
          host.id,
          connectionId,
          'synthetic-zoom-identity',
          {
            accessToken: 'synthetic-zoom-access',
            refreshToken: 'synthetic-zoom-refresh',
            expiresAt: NOW.epochMilliseconds + 86_400_000,
            scopes: zoomScopes('meetings'),
          },
          'meetings',
        ),
      })
      .execute()
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [mail()],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
    notify = bookingNotifier(jobs)
  })

  afterAll(async () => {
    await jobs?.stop()
    await owned?.drop()
  })

  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
    await owned.pool.query('DELETE FROM pgboss.job')
    sent.length = 0
  })

  async function fixture() {
    const provider = fakeZoom('https://hourmere.example', () => NOW.epochMilliseconds)
    const meeting = await provider.meetings.create(
      'synthetic-zoom-access',
      'synthetic-zoom-identity',
      { topic: 'Team coordination', start: new Date(START), end: new Date(END) },
      new AbortController().signal,
    )
    const token = randomBytes(32).toString('base64url')
    const booking = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('bookings')
        .values({
          organization_id: team.id,
          event_type_id: eventId,
          start_at: START,
          end_at: END,
          title: 'Team coordination',
          source: 'api',
          api_key_id: randomUUID(),
          required_host_user_ids: [host.id],
          location: JSON.stringify({ kind: 'zoom', autoCreate: true, url: meeting.joinUrl }),
          responses: JSON.stringify({ private: 'synthetic-private-answer' }),
          manage_token_hash: createHash('sha256').update(token).digest(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('booking_hosts')
        .values({ booking_id: row.id, user_id: host.id })
        .execute()
      await trx
        .insertInto('booking_attendees')
        .values([
          {
            booking_id: row.id,
            name: 'Original Attendee',
            email: 'attendee@example.test',
            time_zone: 'UTC',
            is_booker: true,
          },
          {
            booking_id: row.id,
            name: 'Original Guest',
            email: 'guest@example.test',
            time_zone: 'UTC',
            is_booker: false,
          },
        ])
        .execute()
      await trx
        .insertInto('booking_conferences')
        .values({
          root_booking_id: row.id,
          booking_id: row.id,
          organization_id: team.id,
          organizer_user_id: host.id,
          provider: 'zoom',
          zoom_connection_id: connectionId,
          zoom_user_id: 'synthetic-zoom-identity',
          zoom_meeting_id: meeting.id,
          invitation_organizer_name: host.name,
          invitation_organizer_email: host.email,
          state: 'ready',
          revision: 0,
          applied_revision: 0,
          create_started: true,
        })
        .execute()
      return row
    })
    const work = {
      db,
      now: () => NOW.epochMilliseconds,
      zoomConferenceWork: createZoomConferenceWork(
        {
          db,
          now: () => NOW.epochMilliseconds,
          zoom: {
            client: provider.client,
            encryptionKey: TEST_CONFERENCE_KEY,
            meetingsEnabled: true,
          },
        },
        provider.meetings,
      ),
    }
    return { booking, token, provider, work }
  }

  const cancel = (
    id: string,
    service: Cancel = scheduling.cancelTeamAdminBooking,
    notifier: scheduling.BookingNotifier = notify,
    database = db,
  ) =>
    teamManagementAccess(database, async (_c, next) => next()).write(
      principal,
      team.id,
      (trx, actor) => service(trx, actor, id, () => NOW, { reason: REASON, notify: notifier }),
      { expectedOrganizationId: team.id },
    )

  const operationRows = (id: string) =>
    db.selectFrom('organization_operations').selectAll().where('booking_id', '=', id).execute()
  const conference = (id: string) =>
    db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', id)
      .executeTakeFirstOrThrow()

  async function queued(id: string) {
    return (
      await owned.pool.query<{ id: string; data: unknown }>(
        "SELECT id, data FROM pgboss.job WHERE name=$1 AND data->>'bookingId'=$2 ORDER BY id",
        [BOOKING_NOTIFICATION_JOB, id],
      )
    ).rows
  }

  async function drain(id: string) {
    const before = sent.length
    for (const row of await queued(id))
      await mail().handler(BookingNotificationPayload.parse(row.data), {
        id: row.id,
        attempt: 1,
        signal: new AbortController().signal,
      })
    return sent.slice(before)
  }

  async function verifyEffects(service: Cancel) {
    const f = await fixture()
    await cancel(f.booking.id, service)
    await expect(cancel(f.booking.id, service)).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'team_management_access_denied',
    })
    const jobs = await queued(f.booking.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toEqual({ bookingId: f.booking.id, kind: 'cancelled' })
    expect(await operationRows(f.booking.id)).toMatchObject([
      { actor_user_id: admin.id, source: 'web', operation: 'booking_cancelled' },
    ])
    expect(await conference(f.booking.id)).toMatchObject({
      organizer_user_id: host.id,
      revision: 1,
      state: 'pending',
      zoom_connection_id: connectionId,
    })
    const stored = await db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', f.booking.id)
      .executeTakeFirstOrThrow()
    expect(stored).toMatchObject({
      status: 'cancelled',
      cancelled_at: new Date(NOW.toString()),
      cancel_reason: REASON,
      cancelled_source: 'web',
      source: f.booking.source,
      api_key_id: f.booking.api_key_id,
      required_host_user_ids: [host.id],
      responses: f.booking.responses,
      location: f.booking.location,
    })
    expect(
      await db
        .selectFrom('booking_hosts')
        .select(['user_id', 'active'])
        .where('booking_id', '=', f.booking.id)
        .execute(),
    ).toEqual([{ user_id: host.id, active: false }])
    const messages = await drain(f.booking.id)
    expect(messages.map((message) => message.to)).toEqual([
      host.email,
      'attendee@example.test',
      'guest@example.test',
    ])
    for (const message of messages) {
      expect(message.subject).toMatch(/^Cancelled: Team coordination with /)
      expect(message.text).toContain(REASON)
      expect(message.text.includes(admin.name)).toBe(false)
      expect(message.text.includes('#token=')).toBe(false)
      expect(message.attachments?.[0]?.content).toContain('METHOD:CANCEL')
      expect(message.attachments?.[0]?.content).toContain(`UID:${f.booking.id}@hourmere`)
    }
    expect(await drain(f.booking.id)).toEqual([])
    expect(
      await db
        .selectFrom('booking_notifications')
        .select(['kind', 'outcome'])
        .where('booking_id', '=', f.booking.id)
        .execute(),
    ).toEqual(Array.from({ length: 3 }, () => ({ kind: 'cancelled', outcome: 'sent' })))
    await writeBookingConference(f.work, f.booking.id)
    await writeBookingConference(f.work, f.booking.id)
    expect(f.provider.calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
    expect(f.provider.controls.storedMeetings.size).toBe(0)
    expect(await conference(f.booking.id)).toMatchObject({
      revision: 1,
      applied_revision: 1,
      state: 'ready',
      organizer_user_id: host.id,
    })
  }

  it('keeps the original host and sends one cancellation and one conference cleanup across retries', async () => {
    await verifyEffects(scheduling.cancelTeamAdminBooking)
  })

  it('queues one notification set and cleanup after two controlled concurrent cancellations', async () => {
    const f = await fixture()
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    const paused: scheduling.BookingNotifier = async (trx, event, instant) => {
      await notify(trx, event, instant)
      entered = true
      await hold
    }
    const settle = (operation: Promise<void>) =>
      operation.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
    const first = settle(cancel(f.booking.id, scheduling.cancelTeamAdminBooking, paused))
    let second: ReturnType<typeof settle> | undefined
    try {
      await expect.poll(() => entered, { timeout: 3000, interval: 10 }).toBe(true)
      // Another connection sees no partial cancellation or outbox rows before commit.
      expect(await queued(f.booking.id)).toEqual([])
      expect(await operationRows(f.booking.id)).toEqual([])
      expect(await conference(f.booking.id)).toMatchObject({ revision: 0, state: 'ready' })
      second = settle(cancel(f.booking.id))
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query<{ waiting: boolean }>(`SELECT EXISTS (
                SELECT FROM pg_stat_activity WHERE datname=current_database()
                AND pid<>pg_backend_pid() AND wait_event_type='Lock'
                AND query LIKE '%auth%organization%for update%'
              ) AS waiting`)
            ).rows[0]?.waiting,
          { timeout: 3000, interval: 10 },
        )
        .toBe(true)
    } finally {
      release()
      await Promise.all([first, second])
    }
    expect(await first).toEqual({ ok: true })
    expect(await second).toMatchObject({
      ok: false,
      error: { kind: 'forbidden', code: 'team_management_access_denied' },
    })
    expect(await queued(f.booking.id)).toHaveLength(1)
    expect(await operationRows(f.booking.id)).toHaveLength(1)
    expect(await conference(f.booking.id)).toMatchObject({ revision: 1, state: 'pending' })
    expect(await drain(f.booking.id)).toHaveLength(3)
    expect(await drain(f.booking.id)).toEqual([])
    await writeBookingConference(f.work, f.booking.id)
    await writeBookingConference(f.work, f.booking.id)
    expect(f.provider.calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
  })

  it('retains the existing host and attendee cancellation content and attribution', async () => {
    const messages: MailMessage[][] = []
    for (const path of ['admin', 'host', 'attendee'] as const) {
      const f = await fixture()
      if (path === 'admin') await cancel(f.booking.id)
      else if (path === 'host')
        await scheduling.cancelHostBooking(
          { ...testContext(db, team.as(host), () => NOW), notify },
          f.booking.id,
          { reason: REASON },
        )
      else
        await scheduling.cancelManagedBooking({ db, now: () => NOW, notify }, f.token, {
          reason: REASON,
        })
      expect((await operationRows(f.booking.id))[0]).toMatchObject({
        actor_user_id: path === 'admin' ? admin.id : path === 'host' ? host.id : null,
        source: path === 'host' ? 'api' : 'web',
      })
      messages.push(
        (await drain(f.booking.id)).map((message) =>
          JSON.parse(JSON.stringify(message).replaceAll(f.booking.id, 'booking-id')),
        ),
      )
    }
    expect(messages[0]).toHaveLength(3)
    expect(messages[0]).toEqual(messages[1])
    expect(messages[0]).toEqual(messages[2])
  })

  async function snapshot(id: string) {
    return {
      booking: await db
        .selectFrom('bookings')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
      hosts: await db
        .selectFrom('booking_hosts')
        .selectAll()
        .where('booking_id', '=', id)
        .execute(),
      conference: await conference(id),
      operations: await operationRows(id),
      jobs: await queued(id),
      receipts: await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', id)
        .execute(),
    }
  }

  async function verifyOutboxRollback(service: Cancel) {
    const f = await fixture()
    const before = await snapshot(f.booking.id)
    const messagesBefore = sent.length
    let inserted = false
    const failing: scheduling.BookingNotifier = async (trx, event, instant) => {
      await notify(trx, event, instant)
      const inside = await trx
        .selectFrom('organization_operations')
        .select('actor_user_id')
        .where('booking_id', '=', f.booking.id)
        .execute()
      expect(inside).toEqual([{ actor_user_id: admin.id }])
      const pending = await trx
        .selectFrom('booking_conferences')
        .select(['revision', 'state'])
        .where('root_booking_id', '=', f.booking.id)
        .executeTakeFirstOrThrow()
      expect(pending).toEqual({ revision: 1, state: 'pending' })
      inserted = true
      expect(await queued(f.booking.id)).toEqual([])
      throw new Error('synthetic outbox failure after insert')
    }
    await expect(cancel(f.booking.id, service, failing)).rejects.toThrow(
      'synthetic outbox failure after insert',
    )
    expect(inserted).toBe(true)
    expect(await snapshot(f.booking.id)).toEqual(before)
    expect(sent).toHaveLength(messagesBefore)
    expect(f.provider.calls.filter((call) => call.init.method === 'DELETE')).toEqual([])
    await verifyRetry(f)
  }

  it('rolls back the booking, operation and cleanup when the outbox fails after its real insert', async () => {
    await verifyOutboxRollback(scheduling.cancelTeamAdminBooking)
  })

  async function verifyRetry(f: Awaited<ReturnType<typeof fixture>>) {
    await cancel(f.booking.id)
    expect(await queued(f.booking.id)).toHaveLength(1)
    expect(await operationRows(f.booking.id)).toHaveLength(1)
    expect(await conference(f.booking.id)).toMatchObject({ revision: 1, state: 'pending' })
    expect(await drain(f.booking.id)).toHaveLength(3)
    await writeBookingConference(f.work, f.booking.id)
    expect(f.provider.calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
  }

  async function verifyCleanupRollback(service: Cancel) {
    const f = await fixture()
    const before = await snapshot(f.booking.id)
    const messagesBefore = sent.length
    const cleanupUpdates = new WeakSet<object>()
    let failedAfterUpdate = false
    const failing = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === 'UpdateQueryNode' &&
          JSON.stringify(node).includes('"name":"booking_conferences"')
        )
          cleanupUpdates.add(queryId)
        return node
      },
      async transformResult({ result, queryId }) {
        if (cleanupUpdates.has(queryId)) {
          failedAfterUpdate = true
          throw new Error('synthetic cleanup failure after update')
        }
        return result
      },
    })
    await expect(cancel(f.booking.id, service, notify, failing)).rejects.toThrow(
      'synthetic cleanup failure after update',
    )
    expect(failedAfterUpdate).toBe(true)
    expect(await snapshot(f.booking.id)).toEqual(before)
    expect(sent).toHaveLength(messagesBefore)
    expect(f.provider.calls.filter((call) => call.init.method === 'DELETE')).toEqual([])
    await verifyRetry(f)
  }

  it('rolls back every write when conference cleanup fails after changing its real intent', async () => {
    await verifyCleanupRollback(scheduling.cancelTeamAdminBooking)
  })

  // Source copies are imported through data URLs: no working files or other test workers
  // are changed. The control runs the same end-to-end assertions as every mutant.
  async function sourceCopy(
    before: string,
    after: string,
    target: 'shared' | 'service' = 'shared',
  ): Promise<Cancel> {
    const bookingLocation = new URL('../../../packages/scheduling/src/bookings.ts', import.meta.url)
    const source = readFileSync(bookingLocation, 'utf8')
    if (target === 'shared')
      expect(source.includes(before), 'mutation matches the shared cancellation source').toBe(true)
    const bookingUrl = moduleUrl(
      target === 'shared' ? source.replace(before, after) : source,
      bookingLocation,
    )
    const serviceLocation = new URL(
      '../../../packages/scheduling/src/team-bookings.ts',
      import.meta.url,
    )
    let serviceSource = readFileSync(serviceLocation, 'utf8')
    if (target === 'service') {
      expect(serviceSource.includes(before), 'mutation matches the administration service').toBe(
        true,
      )
      serviceSource = serviceSource.replace(before, after)
    }
    const copy = await import(
      moduleUrl(serviceSource, serviceLocation, { './bookings.ts': bookingUrl })
    )
    return copy.cancelTeamAdminBooking
  }

  it('runs unchanged source copies through the real notification and cleanup assertions', async () => {
    const source = '  await cancelBookingConference(db, row.id, now)'
    await verifyEffects(await sourceCopy(source, source))
  })

  it.each([
    ['notification enqueue', "  await notify?.(db, { type: 'cancelled', bookingId: row.id }, now)"],
    ['conference cleanup', '  await cancelBookingConference(db, row.id, now)'],
    ['real acting administrator', '    actor.userId,'],
  ])(
    'detects omitted %s in a source copy with a real assertion failure',
    async (_label, source) => {
      await expect(
        verifyEffects(await sourceCopy(source, source.includes('actor.userId') ? '    null,' : '')),
      ).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it.each([
    [
      'forwarded cancellation reason and notifier',
      '    await cancelTeamBookingInTransaction(trx, actor, id, now, options)',
      '    await cancelTeamBookingInTransaction(trx, actor, id, now, {})',
    ],
    [
      'delegation to the shared cancellation transaction',
      '    await cancelTeamBookingInTransaction(trx, actor, id, now, options)',
      '',
    ],
  ])('detects lost %s in a service source copy', async (_label, before, after) => {
    await expect(verifyEffects(await sourceCopy(before, after, 'service'))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('runs unchanged source copies through both partial-write rollback assertions', async () => {
    const source = '  await cancelBookingConference(db, row.id, now)'
    const copy = await sourceCopy(source, source)
    await verifyOutboxRollback(copy)
    await verifyCleanupRollback(copy)
  })

  it('detects a swallowed outbox failure in a source copy', async () => {
    const source = "  await notify?.(db, { type: 'cancelled', bookingId: row.id }, now)"
    await expect(
      verifyOutboxRollback(await sourceCopy(source, `${source}.catch(() => {})`)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects a swallowed cleanup failure in a source copy', async () => {
    const source = '  await cancelBookingConference(db, row.id, now)'
    await expect(
      verifyCleanupRollback(await sourceCopy(source, `${source}.catch(() => {})`)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
