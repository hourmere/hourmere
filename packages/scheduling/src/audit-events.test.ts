import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelTeamBookingInTransaction,
  createPublicBooking,
  rescheduleHostBooking,
} from './bookings.ts'
import {
  activateRoundRobin,
  createEventType,
  deleteEventType,
  setEventTypeNotifications,
  setEventTypeWaitlist,
  updateEventType,
} from './event-types.ts'
import { leaveTeamMember } from './member-leave.ts'
import { DEFAULT_NOTIFICATIONS } from './notification-settings.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
describe.skipIf(!serverUrl)('scheduling audit events', () => {
  let testDb: TestDatabase
  let db: Db
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  const events = async (id: string) =>
    (
      await sql<{
        action: string
        actor_type: string
        actor_id: string
        credential_type: string
        credential_id: string
        credential_scope: string
        details: unknown
        request_id: string
      }>`SELECT * FROM audit_events WHERE target_id = ${id} ORDER BY occurred_at, id`.execute(db)
    ).rows

  it.each([
    'created',
    'updated',
    'visibility',
    'hosts',
    'notifications_updated',
    'waitlist_updated',
    'deleted',
    'round_robin_activated',
  ] as const)(
    'records event type %s with actor, credential and allowed details',
    async (action) => {
      const user = await createTestUser(db)
      const team = await createTestTeam(db, [{ user, role: 'owner' }])
      const ctx = {
        ...testContext(
          db,
          action === 'round_robin_activated' ? team.as(user) : user.principal,
          now,
        ),
        requestId: randomUUID(),
      }
      const event = await createEventType(ctx, {
        slug: 'audit',
        title: 'Private title',
        durationMinutes: 30,
        ...(action === 'round_robin_activated' ? { schedulingType: 'round_robin' as const } : {}),
      })
      if (action === 'updated') await updateEventType(ctx, event.id, { title: 'Private update' })
      if (action === 'visibility') await updateEventType(ctx, event.id, { isHidden: true })
      if (action === 'hosts') await updateEventType(ctx, event.id, { hosts: [{ userId: user.id }] })
      if (action === 'notifications_updated')
        await setEventTypeNotifications(ctx, event.id, DEFAULT_NOTIFICATIONS)
      if (action === 'waitlist_updated')
        await setEventTypeWaitlist(ctx, event.id, { enabled: true })
      if (action === 'deleted') await deleteEventType(ctx, event.id)
      if (action === 'round_robin_activated') await activateRoundRobin(ctx, event.id)
      const rows = await events(event.id)
      expect(rows.map((r) => r.action)).toEqual(
        action === 'created'
          ? ['event_type.created']
          : [
              'event_type.created',
              `event_type.${action === 'visibility' || action === 'hosts' ? 'updated' : action}`,
            ],
      )
      for (const row of rows)
        expect(row).toMatchObject({
          actor_type: 'api_key',
          actor_id: user.principal.kind === 'api_key' ? user.principal.apiKeyId : '',
          credential_type: 'api_key',
          credential_scope: 'full',
          details: {},
          request_id: ctx.requestId,
        })
    },
  )

  it('records safe member departure under the live session', async () => {
    const owner = await createTestUser(db),
      member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const sessionId = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        id: sessionId,
        userId: member.id,
        token: randomUUID(),
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const principal: Principal = { ...team.as(member), kind: 'session', sessionId }
    await leaveTeamMember(testContext(db, principal), {
      teamId: team.id,
      expectedOrganizationId: team.id,
    })
    expect(await events(member.id)).toEqual([
      expect.objectContaining({
        action: 'membership.left',
        actor_type: 'user',
        actor_id: member.id,
        credential_type: 'session',
        credential_id: sessionId,
        details: {},
      }),
    ])
  })

  it.each([
    'create',
    'reschedule',
    'cancel',
    'team_cancel',
    'group_reschedule',
    'group_cancel',
    'explicit_origin',
  ] as const)('records booking %s and preserves agent credentials on replay', async (operation) => {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'audit' })
    if (operation.startsWith('group_'))
      await db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 3 })
        .where('id', '=', eventId)
        .execute()
    const principal: Principal = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'bookings',
      user: { id: host.userId, name: 'Host', email: 'private@example.com' },
      organization: { id: host.organizationId, name: 'Space', slug: 'space', personal: true },
    }
    const ctx = { db, now, principal }
    const origin = {
      source: 'mcp' as const,
      apiKeyId: principal.apiKeyId,
      audit: auditActor(principal),
    }
    // Attribution FKs require a real key row.
    await db
      .insertInto('auth.apikey')
      .values({
        id: principal.apiKeyId,
        referenceId: host.userId,
        configId: 'default',
        key: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()
    const input = {
      handle: host.handle,
      slug: 'audit',
      start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
      invitee: { name: 'Secret name', email: 'secret@example.com', timeZone: 'UTC' },
      idempotencyKey: randomUUID(),
    }
    const created = await createPublicBooking(ctx, input, origin)
    await createPublicBooking(ctx, input, origin)
    expect((await events(created.booking.id)).map((r) => r.action)).toEqual(['booking.created'])
    if (operation === 'create') {
      expect(await events(created.booking.id)).toEqual([
        expect.objectContaining({
          action: 'booking.created',
          actor_id: principal.apiKeyId,
          credential_scope: 'bookings',
          details: {},
        }),
      ])
      return
    }
    if (operation === 'team_cancel') {
      await db
        .transaction()
        .execute((trx) =>
          cancelTeamBookingInTransaction(
            trx,
            { userId: host.userId, organizationId: host.organizationId },
            created.booking.id,
            now,
          ),
        )
      expect((await events(created.booking.id)).at(-1)).toMatchObject({
        action: 'booking.cancelled',
        actor_type: 'user',
        actor_id: host.userId,
        credential_type: 'session',
        details: {},
      })
      return
    }
    const managedOrigin =
      operation === 'explicit_origin' ? { source: 'web' as const, apiKeyId: null } : origin
    const moved = await rescheduleHostBooking(
      ctx,
      created.booking.id,
      { start: Temporal.Instant.from('2026-11-02T10:00:00Z'), idempotencyKey: randomUUID() },
      managedOrigin,
    )
    if (operation === 'reschedule' || operation === 'group_reschedule') {
      expect(await events(moved.booking.id)).toEqual([
        expect.objectContaining({
          action: 'booking.rescheduled',
          actor_id: principal.apiKeyId,
          credential_scope: 'bookings',
          details: {},
        }),
      ])
      return
    }
    await cancelHostBooking(
      ctx,
      moved.booking.id,
      { reason: 'Private cancellation text' },
      managedOrigin,
    )
    if (operation === 'explicit_origin') {
      const provenance = await db
        .selectFrom('bookings')
        .select(['cancelled_source', 'cancelled_api_key_id', 'cancelled_oauth_consent_id'])
        .where('id', 'in', [created.booking.id, moved.booking.id])
        .execute()
      expect(provenance).toEqual([
        { cancelled_source: 'web', cancelled_api_key_id: null, cancelled_oauth_consent_id: null },
        { cancelled_source: 'web', cancelled_api_key_id: null, cancelled_oauth_consent_id: null },
      ])
    }
    const rows = [...(await events(created.booking.id)), ...(await events(moved.booking.id))]
    expect(rows.map((r) => r.action)).toEqual([
      'booking.created',
      'booking.rescheduled',
      'booking.cancelled',
    ])
    for (const row of rows)
      expect(row).toMatchObject({
        actor_type: 'api_key',
        actor_id: principal.apiKeyId,
        credential_id: principal.apiKeyId,
        credential_scope: 'bookings',
        details: {},
      })
  })

  it('rolls back changes when the audit INSERT fails, and isolates organizations', async () => {
    const a = await createTestUser(db),
      b = await createTestUser(db)
    const event = await createEventType(testContext(db, a.principal), {
      slug: 'audit',
      title: 'Original',
      durationMinutes: 30,
    })
    await expect(
      updateEventType(testContext(db, b.principal), event.id, { title: 'Unauthorized' }),
    ).rejects.toBeDefined()
    await sql`CREATE FUNCTION reject_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`.execute(
      db,
    )
    await sql`CREATE TRIGGER reject_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_test()`.execute(
      db,
    )
    try {
      await expect(
        updateEventType(testContext(db, a.principal), event.id, { title: 'Rolled back' }),
      ).rejects.toThrow('audit unavailable')
    } finally {
      await sql`DROP TRIGGER reject_audit_test ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_audit_test()`.execute(db)
    }
    expect(
      (
        await db
          .selectFrom('event_types')
          .select('title')
          .where('id', '=', event.id)
          .executeTakeFirstOrThrow()
      ).title,
    ).toBe('Original')
    expect((await events(event.id)).map((r) => r.action)).toEqual(['event_type.created'])
  })
})
