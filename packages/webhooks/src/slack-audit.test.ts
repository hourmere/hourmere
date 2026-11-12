import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { type AuditAction, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deliverWebhook } from './delivery.ts'
import {
  createSlackDestination,
  deleteSlackDestination,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'

const url = 'https://hooks.slack.com/services/TAUDIT/BAUDIT/private-audit-secret'
const replacement = 'https://hooks.slack.com/services/TAUDIT/BNEXT/replacement-audit-secret'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }
const now = Temporal.Instant.from('2026-11-01T12:00Z')
const queue = { enqueue: async () => null }
const signal = () => new AbortController().signal
const actions: AuditAction[] = [
  'slack_destination.created',
  'slack_destination.updated',
  'slack_destination.paused',
  'slack_destination.resumed',
  'slack_destination.tested',
  'slack_destination.deleted',
]

describe.skipIf(!process.env.DATABASE_URL)('Slack destination audit events', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture(
    principal?: (user: Awaited<ReturnType<typeof createTestUser>>) => Principal,
  ) {
    const user = await createTestUser(db)
    const ctx = {
      ...testContext(db, principal ? principal(user) : user.principal, () => now),
      requestId: randomUUID(),
    }
    return { user, ctx, organizationId: user.principal.organization.id }
  }
  const events = async (organizationId: string) =>
    (
      await owned.pool.query(
        `SELECT * FROM audit_events WHERE organization_id = $1 AND action LIKE 'slack_destination.%' ORDER BY id`,
        [organizationId],
      )
    ).rows
  const deliveries = (webhookId: string) =>
    db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', webhookId)
      .orderBy('id')
      .execute()

  it.each(['api_key', 'session'] as const)(
    'records every management change with %s attribution and only the subscribed events',
    async (kind) => {
      const sessionId = randomUUID()
      const f = await fixture((user) =>
        kind === 'session' ? { ...user.principal, kind, sessionId } : user.principal,
      )
      const destination = await createSlackDestination(f.ctx, settings, {
        url,
        events: ['booking.cancelled', 'booking.created'],
      })
      await updateSlackDestination(f.ctx, destination.id, { events: ['booking.created'] }, settings)
      await updateSlackDestination(f.ctx, destination.id, { isActive: false }, settings)
      await updateSlackDestination(f.ctx, destination.id, { isActive: false }, settings)
      await updateSlackDestination(
        f.ctx,
        destination.id.toUpperCase(),
        { isActive: true, events: ['booking.rescheduled'] },
        settings,
      )
      // Pausing while narrowing to one event type, then resuming with a replacement URL:
      // each request records the state change and the edit.
      const eventTypeId = await createFixtures(db).eventType(f.organizationId, f.user.id)
      await updateSlackDestination(
        f.ctx,
        destination.id,
        { isActive: false, eventTypeId },
        settings,
      )
      await updateSlackDestination(
        f.ctx,
        destination.id,
        { isActive: true, url: replacement },
        settings,
      )
      await updateSlackDestination(f.ctx, destination.id, { url: replacement }, settings)
      await testSlackDestination(f.ctx, settings, destination.id, queue)
      await deleteSlackDestination(f.ctx, destination.id)
      const rows = await events(f.organizationId)
      const rescheduled = { events: ['booking.rescheduled'] }
      expect(rows.map((row) => [row.action, row.details])).toEqual([
        ['slack_destination.created', { events: ['booking.cancelled', 'booking.created'] }],
        ['slack_destination.updated', { events: ['booking.created'] }],
        ['slack_destination.paused', { events: ['booking.created'] }],
        // Repeating a state is an ordinary update, never a second pause.
        ['slack_destination.updated', { events: ['booking.created'] }],
        ['slack_destination.resumed', rescheduled],
        ['slack_destination.updated', rescheduled],
        ['slack_destination.paused', rescheduled],
        ['slack_destination.updated', rescheduled],
        ['slack_destination.resumed', rescheduled],
        ['slack_destination.updated', rescheduled],
        ['slack_destination.updated', rescheduled],
        ['slack_destination.tested', rescheduled],
        ['slack_destination.deleted', rescheduled],
      ])
      const apiKey = f.ctx.principal.kind === 'api_key' ? f.ctx.principal.apiKeyId : ''
      for (const row of rows)
        expect(row).toMatchObject({
          actor_type: kind === 'session' ? 'user' : 'api_key',
          actor_id: kind === 'session' ? f.user.id : apiKey,
          credential_type: kind,
          credential_id: kind === 'session' ? sessionId : apiKey,
          credential_scope: kind === 'session' ? null : 'full',
          target_type: 'slack_destination',
          target_id: destination.id,
          request_id: f.ctx.requestId,
        })
      const serialized = JSON.stringify(rows)
      for (const secret of [url, replacement, 'TAUDIT', 'private-audit-secret', 'BNEXT'])
        expect(serialized.includes(secret)).toBe(false)
    },
  )

  it('records the automatic pause after Slack rejects the URL once, as the delivery system', async () => {
    const f = await fixture()
    const destination = await createSlackDestination(f.ctx, settings, {
      url,
      events: ['booking.created'],
    })
    // A failure that is not a URL rejection pauses nothing and records nothing.
    const retried = await testSlackDestination(f.ctx, settings, destination.id, queue)
    await expect(
      deliverWebhook(
        { db, ...settings, transport: async () => 500, now: () => now },
        retried.deliveryId,
        signal(),
      ),
    ).rejects.toThrow('Webhook delivery failed')
    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'failed' })
      .where('id', '=', retried.deliveryId)
      .execute()
    const sample = await testSlackDestination(f.ctx, settings, destination.id, queue)
    await deliverWebhook(
      { db, ...settings, transport: async () => 410, now: () => now },
      sample.deliveryId,
      signal(),
    )
    const rows = await events(f.organizationId)
    expect(rows.map((row) => row.action)).toEqual([
      'slack_destination.created',
      'slack_destination.tested',
      'slack_destination.tested',
      'slack_destination.paused',
    ])
    expect(rows.at(-1)).toMatchObject({
      organization_id: f.organizationId,
      actor_type: 'system',
      actor_id: 'webhook-delivery',
      credential_type: 'none',
      credential_id: null,
      target_type: 'slack_destination',
      target_id: destination.id,
      details: { events: ['booking.created'] },
      request_id: null,
    })
    // The destination is paused now: a later delivery is skipped and records nothing.
    await db
      .insertInto('webhook_deliveries')
      .values({
        webhook_id: destination.id,
        organization_id: f.organizationId,
        booking_id: null,
        event_id: randomUUID(),
        request_id: randomUUID(),
        event_type: 'booking.created',
        payload: '{}',
        created_at: new Date(now.epochMilliseconds),
      })
      .execute()
    const pending = (await deliveries(destination.id)).filter((row) => row.status === 'pending')
    expect(pending).toHaveLength(1)
    await deliverWebhook(
      { db, ...settings, transport: async () => 404, now: () => now },
      pending[0]?.id as string,
      signal(),
    )
    expect((await deliveries(destination.id)).at(-1)).toMatchObject({ status: 'skipped' })
    expect(await events(f.organizationId)).toHaveLength(rows.length)
  })

  it('records nothing for refused changes', async () => {
    const f = await fixture()
    const other = await fixture()
    const destination = await createSlackDestination(f.ctx, settings, {
      url,
      events: ['booking.created'],
    })
    const refusals: [string, () => Promise<unknown>][] = [
      [
        'slack_destination_exists',
        () => createSlackDestination(f.ctx, settings, { url, events: ['booking.created'] }),
      ],
      [
        'invalid_slack_destination',
        () =>
          updateSlackDestination(f.ctx, destination.id, { url: 'https://example.com/x' }, settings),
      ],
      [
        'slack_destination_not_found',
        () => updateSlackDestination(other.ctx, destination.id, { isActive: false }, settings),
      ],
      ['slack_destination_not_found', () => deleteSlackDestination(other.ctx, destination.id)],
      [
        'slack_destination_not_found',
        () => testSlackDestination(other.ctx, settings, destination.id, queue),
      ],
    ]
    await testSlackDestination(f.ctx, settings, destination.id, queue)
    // A second sample while the first is pending is refused.
    refusals.push([
      'slack_test_pending',
      () => testSlackDestination(f.ctx, settings, destination.id, queue),
    ])
    for (const [code, refused] of refusals)
      await expect(refused(), code).rejects.toMatchObject({ code })
    await updateSlackDestination(f.ctx, destination.id, { isActive: false }, settings)
    await expect(
      testSlackDestination(f.ctx, settings, destination.id, queue),
    ).rejects.toMatchObject({ code: 'slack_destination_disabled' })
    expect((await events(f.organizationId)).map((row) => row.action)).toEqual([
      'slack_destination.created',
      'slack_destination.tested',
      'slack_destination.paused',
    ])
    expect(await events(other.organizationId)).toEqual([])
  })

  it('rolls back each change, including the automatic pause, when its event cannot be written', async () => {
    const f = await fixture()
    const destination = await createSlackDestination(f.ctx, settings, {
      url,
      events: ['booking.created'],
    })
    const sample = await testSlackDestination(f.ctx, settings, destination.id, queue)
    const snapshot = async () => ({
      hooks: (
        await owned.pool.query('SELECT * FROM webhooks WHERE organization_id = $1 ORDER BY id', [
          f.organizationId,
        ])
      ).rows,
      deliveries: await deliveries(destination.id),
    })
    const before = await snapshot()
    await owned.pool.query(`CREATE FUNCTION reject_slack_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_slack_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_slack_audit()`)
    try {
      for (const change of [
        () => updateSlackDestination(f.ctx, destination.id, { isActive: false }, settings),
        () =>
          updateSlackDestination(
            f.ctx,
            destination.id,
            { events: ['booking.cancelled'] },
            settings,
          ),
        () => deleteSlackDestination(f.ctx, destination.id),
        () =>
          deliverWebhook(
            { db, ...settings, transport: async () => 404, now: () => now },
            sample.deliveryId,
            signal(),
          ),
      ])
        await expect(change()).rejects.toThrow('audit unavailable')
      const other = await fixture()
      await expect(
        createSlackDestination(other.ctx, settings, { url, events: ['booking.created'] }),
      ).rejects.toThrow('audit unavailable')
      expect(
        (
          await owned.pool.query('SELECT id FROM webhooks WHERE organization_id = $1', [
            other.organizationId,
          ])
        ).rows,
      ).toEqual([])
    } finally {
      await owned.pool.query(
        'DROP TRIGGER reject_slack_audit ON audit_events; DROP FUNCTION reject_slack_audit()',
      )
    }
    expect(await snapshot()).toEqual(before)
    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'failed' })
      .where('id', '=', sample.deliveryId)
      .execute()
    await owned.pool.query(`CREATE FUNCTION reject_slack_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_slack_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_slack_test_audit()`)
    try {
      await expect(testSlackDestination(f.ctx, settings, destination.id, queue)).rejects.toThrow(
        'audit unavailable',
      )
    } finally {
      await owned.pool.query(
        'DROP TRIGGER reject_slack_test_audit ON audit_events; DROP FUNCTION reject_slack_test_audit()',
      )
    }
    expect((await deliveries(destination.id)).map((row) => row.id)).toEqual([sample.deliveryId])
    expect((await events(f.organizationId)).map((row) => row.action)).toEqual([
      'slack_destination.created',
      'slack_destination.tested',
    ])
  })

  it('rejects detail keys other than the subscribed events in the application and the database', async () => {
    for (const action of actions) {
      for (const details of [
        { events: ['booking.created'], url },
        { events: ['booking.created'], eventTypeId: randomUUID() },
        { reason: 'url_rejected' },
      ]) {
        await expect(
          db.transaction().execute((trx) =>
            writeAuditEvent(trx, {
              organizationId: randomUUID(),
              actor: { type: 'system', id: 'webhook-delivery' },
              credential: { type: 'none' },
              action,
              targetType: 'slack_destination',
              targetId: randomUUID(),
              details,
            }),
          ),
        ).rejects.toThrow('allow-listed')
        await expect(
          owned.pool.query(
            `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
             VALUES ('system', 'test', 'none', $1, 'slack_destination', 'test', $2::jsonb)`,
            [action, JSON.stringify(details)],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'audit_events_details_check' })
      }
      await expect(
        owned.pool.query(
          `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
           VALUES ('system', 'test', 'none', $1, 'slack_destination', 'test', $2::jsonb)`,
          [action, JSON.stringify({ events: ['booking.created'] })],
        ),
      ).resolves.toMatchObject({ rowCount: 1 })
    }
  })
})
