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
  requestReschedule,
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
      // Writes accept any UUID spelling; the journal must name the stored id.
      if (action === 'notifications_updated')
        await setEventTypeNotifications(ctx, event.id.toUpperCase(), DEFAULT_NOTIFICATIONS)
      if (action === 'waitlist_updated')
        await setEventTypeWaitlist(ctx, event.id.toUpperCase(), { enabled: true })
      if (action === 'deleted') await deleteEventType(ctx, event.id.toUpperCase())
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
    'external_key',
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
    const keyOwner = operation === 'external_key' ? await f.host() : host
    // Attribution FKs require a real key row.
    await db
      .insertInto('auth.apikey')
      .values({
        id: principal.apiKeyId,
        referenceId: keyOwner.userId,
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
    const actualOrigin = operation === 'external_key' ? { ...origin, apiKeyId: null } : origin
    const created = await createPublicBooking(ctx, input, actualOrigin)
    await createPublicBooking(ctx, input, actualOrigin)
    if (operation === 'external_key') {
      expect(await events(created.booking.id)).toEqual([
        expect.objectContaining({
          actor_type: 'external_api_key',
          actor_id: null,
          credential_type: 'none',
          credential_id: null,
          credential_scope: null,
        }),
      ])
      return
    }
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
      const sessionId = randomUUID()
      await db
        .transaction()
        .execute((trx) =>
          cancelTeamBookingInTransaction(
            trx,
            { userId: host.userId, organizationId: host.organizationId },
            created.booking.id,
            now,
            { sessionId },
          ),
        )
      expect((await events(created.booking.id)).at(-1)).toMatchObject({
        action: 'booking.cancelled',
        actor_type: 'user',
        actor_id: host.userId,
        credential_type: 'session',
        credential_id: sessionId,
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

  it.each(['same', 'foreign', 'unresolved'] as const)(
    'records a %s-organization OAuth booking without foreign identifiers',
    async (kind) => {
      const f = createFixtures(db)
      const host = await f.host()
      await f.schedule(host.userId)
      await f.eventType(host.organizationId, host.userId, { slug: 'oauth-audit' })
      const caller = kind === 'same' ? host : await f.host()
      const clientId = 'https://client.test/metadata.json'
      const grantId =
        kind === 'unresolved'
          ? randomUUID()
          : (
              await db
                .insertInto('mcp_oauth_grants')
                .values({
                  user_id: caller.userId,
                  organization_id: caller.organizationId,
                  client_id: clientId,
                })
                .returning('id')
                .executeTakeFirstOrThrow()
            ).id
      const principal: Principal = {
        kind: 'oauth',
        oauthConsentId: grantId,
        clientId,
        scopes: ['mcp:tools'],
        user: { id: caller.userId, name: 'Caller', email: 'caller@example.com' },
        organization: { id: caller.organizationId, name: 'Space', slug: 'space', personal: true },
      }
      // The MCP create_booking origin for "someone's event type".
      const origin = {
        source: 'mcp' as const,
        apiKeyId: null,
        oauthConsentId: grantId,
        audit: auditActor(principal),
        actorUserId: caller.userId,
      }
      const created = await createPublicBooking(
        { db, now },
        {
          handle: host.handle,
          slug: 'oauth-audit',
          start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
          invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        },
        origin,
      )
      const rows = (
        await sql<
          Record<string, unknown>
        >`SELECT * FROM audit_events WHERE target_id = ${created.booking.id}`.execute(db)
      ).rows
      expect(rows).toHaveLength(1)
      if (kind === 'same') {
        expect(rows[0]).toMatchObject({
          organization_id: host.organizationId,
          action: 'booking.created',
          actor_type: 'user',
          actor_id: caller.userId,
          credential_type: 'oauth',
          oauth_client_id: clientId,
          oauth_grant_id: grantId,
        })
        return
      }
      expect(rows[0], 'foreign OAuth booking audit').toMatchObject({
        organization_id: host.organizationId,
        action: 'booking.created',
        actor_type: 'external_oauth_client',
        actor_id: null,
        credential_type: 'none',
        credential_id: null,
        oauth_client_id: null,
        oauth_grant_id: null,
        details: {},
      })
      const serialized = JSON.stringify(rows)
      for (const foreign of [caller.userId, grantId, clientId])
        expect(serialized.includes(foreign), 'foreign OAuth booking audit').toBe(false)
    },
  )

  it('records a host reschedule request once, inside its transaction', async () => {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'request-audit' })
    const principal: Principal = {
      kind: 'session',
      sessionId: randomUUID(),
      user: { id: host.userId, name: 'Host', email: 'host@example.com' },
      organization: { id: host.organizationId, name: 'Space', slug: 'space', personal: true },
    }
    const ctx = { db, now, principal, requestId: randomUUID() }
    const book = (hour: string) =>
      createPublicBooking(
        { db, now },
        {
          handle: host.handle,
          slug: 'request-audit',
          start: Temporal.Instant.from(`2026-11-02T${hour}:00:00Z`),
          invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        },
      )
    const created = await book('09')
    const request = { idempotencyKey: randomUUID(), note: 'Private request note' }
    await requestReschedule(ctx, created.booking.id.toUpperCase(), request)
    await requestReschedule(ctx, created.booking.id, request)
    const rows = (await events(created.booking.id)).filter(
      (row) => row.action === 'booking.reschedule_requested',
    )
    expect(rows, 'reschedule request audit').toEqual([
      expect.objectContaining({
        actor_type: 'user',
        actor_id: host.userId,
        credential_type: 'session',
        credential_id: principal.sessionId,
        details: {},
        request_id: ctx.requestId,
      }),
    ])
    expect(JSON.stringify(rows)).not.toContain('Private request note')
    const other = await book('10')
    await sql`CREATE FUNCTION reject_request_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request audit unavailable'; END $$`.execute(
      db,
    )
    await sql`CREATE TRIGGER reject_request_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_request_audit_test()`.execute(
      db,
    )
    try {
      await expect(
        requestReschedule(ctx, other.booking.id, { idempotencyKey: randomUUID() }),
      ).rejects.toThrow('request audit unavailable')
    } finally {
      await sql`DROP TRIGGER reject_request_audit_test ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_request_audit_test()`.execute(db)
    }
    expect(
      await db
        .selectFrom('booking_reschedule_requests')
        .select('id')
        .where('booking_id', '=', other.booking.id)
        .execute(),
    ).toEqual([])
  })

  it('compares API key organization metadata in canonical UUID form', async () => {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'key-spelling' })
    const principal: Principal = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'bookings',
      user: { id: host.userId, name: 'Host', email: 'host@example.com' },
      organization: { id: host.organizationId, name: 'Space', slug: 'space', personal: true },
    }
    await db
      .insertInto('auth.apikey')
      .values({
        id: principal.apiKeyId,
        referenceId: host.userId,
        configId: 'default',
        key: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({
          organizationId: host.organizationId.toUpperCase(),
          scope: 'bookings',
        }),
      })
      .execute()
    const created = await createPublicBooking(
      { db, now },
      {
        handle: host.handle,
        slug: 'key-spelling',
        start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
        invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      },
      { source: 'mcp', apiKeyId: principal.apiKeyId, audit: auditActor(principal) },
    )
    expect(await events(created.booking.id)).toEqual([
      expect.objectContaining({
        action: 'booking.created',
        actor_type: 'api_key',
        actor_id: principal.apiKeyId,
        credential_id: principal.apiKeyId,
        credential_scope: 'bookings',
      }),
    ])
  })

  it.each(['create', 'reschedule', 'cancel'] as const)(
    'rolls back booking %s and its journal on audit or commit failure',
    async (operation) => {
      for (const failure of ['audit', 'commit']) {
        const f = createFixtures(db)
        const host = await f.host()
        await f.schedule(host.userId)
        await f.eventType(host.organizationId, host.userId, { slug: 'rollback' })
        const principal: Principal = {
          kind: 'session',
          sessionId: randomUUID(),
          user: { id: host.userId, name: 'Host', email: 'host@example.com' },
          organization: { id: host.organizationId, name: 'Space', slug: 'space', personal: true },
        }
        const ctx = { db, now, principal }
        const input = {
          handle: host.handle,
          slug: 'rollback',
          start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
          invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
          idempotencyKey: randomUUID(),
        }
        const original = operation === 'create' ? undefined : await createPublicBooking(ctx, input)
        const beforeBookings = await db
          .selectFrom('bookings')
          .selectAll()
          .where('organization_id', '=', host.organizationId)
          .execute()
        const beforeEvents = await db
          .selectFrom('audit_events')
          .selectAll()
          .where('organization_id', '=', host.organizationId)
          .execute()
        await sql`CREATE FUNCTION reject_booking_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$`.execute(
          db,
        )
        if (failure === 'audit') {
          await sql`CREATE TRIGGER reject_booking_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_booking_audit_test()`.execute(
            db,
          )
        } else {
          // A deferred failure occurs after the audit INSERT. A separate audit transaction
          // would commit an orphan event and therefore fail the unchanged-journal assertion.
          await sql`CREATE CONSTRAINT TRIGGER reject_booking_audit_test AFTER INSERT OR UPDATE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_booking_audit_test()`.execute(
            db,
          )
        }
        try {
          await expect(
            operation === 'create'
              ? createPublicBooking(ctx, input)
              : operation === 'reschedule'
                ? rescheduleHostBooking(ctx, original?.booking.id ?? '', {
                    start: Temporal.Instant.from('2026-11-02T10:00:00Z'),
                    idempotencyKey: randomUUID(),
                  })
                : cancelHostBooking(ctx, original?.booking.id ?? ''),
          ).rejects.toThrow('forced rollback')
        } finally {
          await sql`DROP TRIGGER reject_booking_audit_test ON ${sql.table(failure === 'audit' ? 'audit_events' : 'bookings')}`.execute(
            db,
          )
          await sql`DROP FUNCTION reject_booking_audit_test()`.execute(db)
        }
        expect(
          await db
            .selectFrom('bookings')
            .selectAll()
            .where('organization_id', '=', host.organizationId)
            .execute(),
        ).toEqual(beforeBookings)
        expect(
          await db
            .selectFrom('audit_events')
            .selectAll()
            .where('organization_id', '=', host.organizationId)
            .execute(),
        ).toEqual(beforeEvents)
      }
    },
  )

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
