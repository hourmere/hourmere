import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { sendBookingNotification } from '@hourmere/notifications'
import { cancelTeamAdminBooking } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  calendarBookingNotifier,
  writeBookingCalendar,
} from '../../../packages/calendars/src/booking-events.ts'
import { writeBookingConference } from '../../../packages/calendars/src/conferences.ts'
import {
  calendarEncryptionKey,
  encryptCredential,
} from '../../../packages/calendars/src/credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../../packages/calendars/src/testing.ts'
import { migrationsDir, runMigrations } from '../../../packages/db/src/migrate.ts'
import { seedEarly } from '../../../packages/db/src/upgrade-path-seed-early.ts'
import { teamManagementAccess } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00Z')
const START = '2030-11-04T09:00Z'
const END = '2030-11-04T09:30Z'
type Send = typeof sendBookingNotification

describe.skipIf(!serverUrl)('team cancellation removed-host security audit', () => {
  let owned: TestDatabase
  let db: Db
  let host: Awaited<ReturnType<typeof createTestUser>>
  let manager: typeof host
  let team: Awaited<ReturnType<typeof createTestTeam>>
  let principal: Principal
  let connectionId: string
  let calendarId: string
  let provider: ReturnType<typeof fakeGoogle>
  const queued: string[] = []
  const sent: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'cancel_audit' })
    db = createDb(owned.pool)
    host = await createTestUser(db, 'Removed original host')
    manager = await createTestUser(db, 'Acting team owner')
    team = await createTestTeam(db, [
      { user: manager, role: 'owner' },
      { user: host, role: 'member' },
    ])
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: manager.id,
        token: `synthetic-${randomUUID()}`,
        activeOrganizationId: team.id,
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    principal = { ...team.as(manager), kind: 'session', sessionId: session.id }
    connectionId = randomUUID()
    calendarId = randomUUID()
    await db
      .insertInto('calendar_connections')
      .values({
        id: connectionId,
        user_id: host.id,
        provider: 'google',
        external_account_id: 'synthetic-host-calendar',
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          `google:${host.id}:synthetic-host-calendar`,
          JSON.stringify({
            accessToken: 'synthetic-access',
            refreshToken: 'synthetic-refresh',
            expiresAt: NOW.epochMilliseconds + 86_400_000,
          }),
        ),
      })
      .execute()
    await db
      .insertInto('calendars')
      .values({
        id: calendarId,
        connection_id: connectionId,
        external_id: 'synthetic-host-calendar',
        name: 'Private calendar',
        access_role: 'owner',
        supports_google_meet: true,
      })
      .execute()
    await db
      .insertInto('profiles')
      .values({
        user_id: host.id,
        handle: 'removed-audit-host',
        time_zone: 'UTC',
        destination_calendar_id: calendarId,
      })
      .execute()
  })

  afterAll(async () => {
    await owned?.drop()
  })

  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', host.id)
      .execute()
    await db
      .insertInto('auth.member')
      .values({ organizationId: team.id, userId: host.id, role: 'member', createdAt: new Date() })
      .execute()
    provider = fakeGoogle()
    sent.length = 0
    queued.length = 0
  })

  const deps = () => ({
    db,
    now: () => NOW.epochMilliseconds,
    google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
  })

  async function fixture(automatic: boolean, savedOrganizer = true) {
    const id = await createFixtures(db).booking(team.id, [host.id], START, END)
    if (savedOrganizer)
      await db
        .updateTable('bookings')
        .set({ ical_organizer_name: 'Hourmere', ical_organizer_email: 'calendar@hourmere.example' })
        .where('id', '=', id)
        .execute()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Additional guest',
        email: 'guest@example.test',
        time_zone: 'UTC',
        is_booker: false,
      })
      .execute()
    if (automatic) {
      provider.controls.storedEvents.set('existing-meet-event', {
        id: 'existing-meet-event',
        iCalUID: `${id}@hourmere`,
        etag: '"v1"',
        status: 'confirmed',
        start: { dateTime: START },
        end: { dateTime: END },
      })
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: id,
          booking_id: id,
          organization_id: team.id,
          organizer_user_id: host.id,
          connection_id: connectionId,
          calendar_id: calendarId,
          external_event_id: 'existing-meet-event',
          invitation_organizer_name: host.name,
          invitation_organizer_email: host.email,
          state: 'ready',
          applied_revision: 0,
          create_started: true,
        })
        .execute()
    } else {
      await db
        .transaction()
        .execute((trx) =>
          calendarBookingNotifier({ enqueue: async () => null })(trx, { bookingId: id }),
        )
      await writeBookingCalendar(deps(), id)
      expect([...provider.controls.storedEvents.values()]).toMatchObject([{ status: 'confirmed' }])
    }
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', host.id)
      .execute()
    await teamManagementAccess(db, async (_c, next) => next()).write(
      principal,
      team.id,
      (trx, actor) =>
        cancelTeamAdminBooking(trx, actor, id, () => NOW, {
          expectedOrganizationId: team.id,
          reason: 'Original host has left the team',
          notify: async (transaction, event) => {
            expect(transaction.isTransaction).toBe(true)
            expect(event).toEqual({ type: 'cancelled', bookingId: id })
            queued.push(id)
            await calendarBookingNotifier({ enqueue: async () => null })(transaction, event)
          },
        }),
      { expectedOrganizationId: team.id },
    )
    return id
  }

  async function verifyRecipients(send: Send = sendBookingNotification, savedOrganizer = true) {
    const id = await fixture(false, savedOrganizer)
    await send(
      {
        db,
        secret: 'synthetic-audit-notification-secret',
        publicUrl: 'https://hourmere.example',
        now: () => NOW,
        mailMaxPerHour: 0,
        mailRecipientMaxPerHour: 100,
        mailer: { senderEmail: 'calendar@hourmere.example', send: async (m) => void sent.push(m) },
        log: () => {},
      },
      id,
      'cancelled',
    )
    expect(sent.map((message) => message.to)).toEqual(['invitee@example.com', 'guest@example.test'])
    for (const message of sent) {
      expect(message.text).toContain('Original host has left the team')
      expect(message.text.includes(manager.name)).toBe(false)
      expect(message.text.includes('#token=')).toBe(false)
      if (savedOrganizer) expect(message.attachments?.[0]?.content).toContain('METHOD:CANCEL')
      else expect(message.attachments).toBeUndefined()
    }
    expect(queued).toEqual([id])
    return id
  }

  it('emails only the booker and guest after host removal and cancels the saved calendar copy', async () => {
    const id = await verifyRecipients()
    await writeBookingCalendar(deps(), id)
    expect([...provider.controls.storedEvents.values()]).toMatchObject([{ status: 'cancelled' }])
    expect(await db.selectFrom('calendar_busy').selectAll().execute()).toEqual([])
    expect(
      await db
        .selectFrom('booking_hosts')
        .select(['user_id', 'active'])
        .where('booking_id', '=', id)
        .execute(),
    ).toEqual([{ user_id: host.id, active: false }])
  })

  it('cancels the pinned Google Meet event after its organizer leaves, with no new meeting', async () => {
    const id = await fixture(true)
    await writeBookingConference(deps(), id)
    await writeBookingConference(deps(), id)
    expect([...provider.controls.storedEvents.values()]).toMatchObject([
      { id: 'existing-meet-event', status: 'cancelled' },
    ])
    expect(provider.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0)
    expect(provider.calls.filter((call) => call.init.method === 'PATCH')).toHaveLength(1)
    expect(
      await db
        .selectFrom('booking_conferences')
        .select(['organizer_user_id', 'state', 'revision', 'applied_revision'])
        .where('root_booking_id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ organizer_user_id: host.id, state: 'ready', revision: 1, applied_revision: 1 })
  })

  it('still sends text cancellations when the lone removed host has no saved invitation organizer', async () => {
    await verifyRecipients(sendBookingNotification, false)
  })

  it('still notifies the booker after the only host account is deleted', async () => {
    const deleted = await createTestUser(db, 'Deleted original host')
    await db
      .insertInto('auth.member')
      .values({
        organizationId: team.id,
        userId: deleted.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const { id } = await db
      .insertInto('bookings')
      .values({
        organization_id: team.id,
        title: 'Deleted host booking',
        start_at: START,
        end_at: END,
        source: 'api',
        manage_token_hash: Buffer.alloc(32, 1),
        required_host_user_ids: [deleted.id],
        ical_organizer_name: 'Hourmere',
        ical_organizer_email: 'calendar@hourmere.example',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db.insertInto('booking_hosts').values({ booking_id: id, user_id: deleted.id }).execute()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Invitee',
        email: 'invitee@example.com',
        time_zone: 'UTC',
        is_booker: true,
      })
      .execute()
    await db.deleteFrom('auth.user').where('id', '=', deleted.id).execute()
    await teamManagementAccess(db, async (_c, next) => next()).write(
      principal,
      team.id,
      (trx, actor) =>
        cancelTeamAdminBooking(trx, actor, id, () => NOW, {
          expectedOrganizationId: team.id,
          notify: async () => {},
        }),
      { expectedOrganizationId: team.id },
    )
    await sendBookingNotification(
      {
        db,
        secret: 'synthetic-deletion-secret',
        publicUrl: 'https://hourmere.example',
        now: () => NOW,
        mailMaxPerHour: 0,
        mailer: {
          senderEmail: 'calendar@hourmere.example',
          send: async (message) => void sent.push(message),
        },
        log: () => {},
      },
      id,
      'cancelled',
    )
    expect(sent.map((message) => message.to)).toEqual(['invitee@example.com'])
    expect(sent[0]?.attachments?.[0]?.content).toContain('METHOD:CANCEL')
    expect(
      await db.selectFrom('booking_hosts').selectAll().where('booking_id', '=', id).execute(),
    ).toEqual([])
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('required_host_user_ids')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).required_host_user_ids,
    ).toEqual([deleted.id])
  })

  async function notificationCopy(
    before: string,
    after: string,
    bypassFinalMembership = false,
  ): Promise<Send> {
    const location = new URL('../../../packages/notifications/src/index.ts', import.meta.url)
    const source = readFileSync(location, 'utf8')
    expect(source.includes(before)).toBe(true)
    if (bypassFinalMembership)
      expect(source.includes('if (!member) throw new RecipientUnavailable()')).toBe(true)
    const changed = source
      .replace(before, after)
      .replace(
        'if (!member) throw new RecipientUnavailable()',
        bypassFinalMembership ? '' : 'if (!member) throw new RecipientUnavailable()',
      )
    const code = stripTypeScriptTypes(changed).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
    )
    return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))
      .sendBookingNotification
  }

  it('checks the unchanged notification source through the removed-host assertions', async () => {
    const source = ".innerJoin('auth.member as member', (j) =>"
    await verifyRecipients(await notificationCopy(source, source))
  })

  it('detects removed membership protection in a source copy with the same recipient assertions', async () => {
    const source = `.innerJoin('auth.member as member', (j) =>
        j.onRef('member.userId', '=', 'u.id').on('member.organizationId', '=', b.organization_id),
      )`
    await expect(verifyRecipients(await notificationCopy(source, '', true))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})

describe.skipIf(!serverUrl)('team launch historical booking and invitation audit', () => {
  it('cancels an actual pre-host-snapshot booking and preserves legacy invitations without sending them', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-team-launch-old-'))
    let owned: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      owned = await createTestDatabase(serverUrl as string, predecessor, { tag: 'team_old_audit' })
      await seedEarly(owned.pool)
      await owned.pool.query(`INSERT INTO auth.invitation
        ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        SELECT "organizationId",'historical-'||fixture.status||'@example.test','member',
          fixture.status,CASE WHEN fixture.status='pending' THEN now()-interval '1 day'
            ELSE now()+interval '1 day' END,"createdAt","inviterId"
        FROM auth.invitation CROSS JOIN (VALUES ('pending'),('accepted'),('canceled'),('rejected')) fixture(status)`)
      const invitations = async () =>
        (
          await owned?.pool.query(
            'SELECT to_jsonb(i)::text AS value FROM auth.invitation i ORDER BY id',
          )
        )?.rows
      const beforeInvitations = await invitations()
      const { rows: historical } = await owned.pool.query(`SELECT id,organization_id,source,
        responses,manage_token_hash,created_at::text,updated_at::text FROM bookings
        WHERE title='Upgrade booking 5'`)
      expect(historical).toHaveLength(1)
      const booking = historical[0]
      expect(await runMigrations(owned.pool)).toEqual(
        files.filter((file) => file.slice(0, 4) > '0012'),
      )
      expect(await invitations()).toEqual(beforeInvitations)
      expect(
        (
          await owned.pool.query(`SELECT generation,state,attempts,last_error_code,last_attempt_at
        FROM invitation_deliveries`)
        ).rows,
      ).toEqual([
        {
          generation: 1,
          state: 'failed',
          attempts: 0,
          last_error_code: 'legacy_delivery_unknown',
          last_attempt_at: null,
        },
      ])
      expect((await owned.pool.query("SELECT to_regnamespace('pgboss') AS queue")).rows).toEqual([
        { queue: null },
      ])
      const db = createDb(owned.pool)
      const admin = await db
        .selectFrom('auth.user')
        .select(['id', 'name', 'email'])
        .where('email', '=', 'upgrade-host-2@example.test')
        .executeTakeFirstOrThrow()
      const organization = await db
        .selectFrom('auth.organization')
        .select(['id', 'name', 'slug'])
        .where('id', '=', booking.organization_id)
        .executeTakeFirstOrThrow()
      const session = await db
        .selectFrom('auth.session')
        .select('id')
        .where('userId', '=', admin.id)
        .executeTakeFirstOrThrow()
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: organization.id })
        .where('id', '=', session.id)
        .execute()
      const principal: Principal = {
        kind: 'session',
        sessionId: session.id,
        user: admin,
        organization: { ...organization, personal: false },
      }
      const queued: string[] = []
      await teamManagementAccess(db, async (_c, next) => next()).write(
        principal,
        organization.id,
        (trx, actor) =>
          cancelTeamAdminBooking(
            trx,
            actor,
            booking.id,
            () => Temporal.Instant.from('2029-01-01T00:00Z'),
            {
              expectedOrganizationId: organization.id,
              notify: async (_trx, event) => {
                queued.push(event.bookingId)
              },
            },
          ),
        { expectedOrganizationId: organization.id },
      )
      expect(queued).toEqual([booking.id])
      const stored = await db
        .selectFrom('bookings')
        .selectAll()
        .where('id', '=', booking.id)
        .executeTakeFirstOrThrow()
      expect(stored).toMatchObject({
        status: 'cancelled',
        source: booking.source,
        responses: booking.responses,
        ical_version: 1,
        cancelled_source: 'web',
      })
      expect(stored.manage_token_hash?.equals(booking.manage_token_hash)).toBe(true)
      const hosts = await db
        .selectFrom('booking_hosts')
        .select(['user_id', 'active'])
        .where('booking_id', '=', booking.id)
        .execute()
      expect(stored.required_host_user_ids).toEqual(hosts.map((host) => host.user_id).sort())
      expect(hosts.every((host) => !host.active)).toBe(true)
      const messages: MailMessage[] = []
      await sendBookingNotification(
        {
          db,
          secret: 'synthetic-upgrade-secret',
          publicUrl: 'https://hourmere.example',
          now: () => Temporal.Instant.from('2029-01-01T00:00Z'),
          mailMaxPerHour: 0,
          mailer: {
            senderEmail: 'calendar@hourmere.example',
            send: async (message) => void messages.push(message),
          },
          log: () => {},
        },
        booking.id,
        'cancelled',
      )
      expect(messages.map((message) => message.to)).toEqual([
        'upgrade-host-1@example.test',
        'booker@example.test',
        'guest@example.test',
      ])
      expect(
        messages.every((message) => message.attachments?.[0]?.content.includes('METHOD:CANCEL')),
      ).toBe(true)
      expect(await runMigrations(owned.pool)).toEqual([])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 30_000)
})
