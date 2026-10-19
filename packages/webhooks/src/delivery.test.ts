import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookSignature } from './crypto.ts'
import {
  deliverWebhook,
  WEBHOOK_DELIVERY_JOB,
  type WebhookDeps,
  webhookBookingNotifier,
  webhookCleanupJob,
  webhookDeliveryJob,
} from './delivery.ts'
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  updateWebhook,
  WEBHOOK_EVENTS,
} from './service.ts'
import type { WebhookRequest } from './transport.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const key = Buffer.alloc(32, 9).toString('base64')
const settings = { enabled: true, encryptionKey: key }
const signal = () => new AbortController().signal

describe.skipIf(!serverUrl)('durable organization booking webhooks', () => {
  let testDb: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<ReturnType<typeof webhookDeliveryJob>[]>>
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    jobs = createJobs({
      connectionString: testDb.url,
      definitions: [webhookDeliveryJob({ db, ...settings })],
      work: false,
      migrate: true,
    })
    await jobs.start()
  })
  afterAll(async () => {
    await jobs?.stop()
    await testDb?.drop()
  })
  async function fixture() {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, () => NOW)
    const { webhook, secret } = await createWebhook(ctx, settings, {
      url: 'https://hooks.example.com/bookings?credential=synthetic',
      events: [...WEBHOOK_EVENTS],
    })
    const f = createFixtures(db)
    const bookingId = await f.booking(
      user.principal.organization.id,
      [user.id],
      '2026-11-03T09:00Z',
      '2026-11-03T09:30Z',
    )
    return { user, ctx, webhook, secret, bookingId }
  }
  async function captured() {
    const data = await fixture()
    await db.transaction().execute((trx) =>
      webhookBookingNotifier(jobs, settings)(
        trx,
        {
          type: 'created',
          bookingId: data.bookingId,
          start: Temporal.Instant.from('2026-11-03T09:00Z'),
        },
        NOW,
      ),
    )
    const delivery = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', data.webhook.id)
      .executeTakeFirstOrThrow()
    return { ...data, delivery }
  }
  const deps = (transport: WebhookDeps['transport'], now = () => NOW): WebhookDeps => ({
    db,
    ...settings,
    transport,
    now,
  })
  async function waitForBlocked(query: string) {
    await expect
      .poll(
        async () =>
          (
            await testDb.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event_type='Lock'
                  AND query ILIKE $1) AS blocked`,
              [query],
            )
          ).rows[0]?.blocked,
        { timeout: 3000 },
      )
      .toBe(true)
  }

  it('requires a fresh owner/admin membership for configuration and delivery reads', async () => {
    const { user, webhook } = await fixture()
    const member = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user, role: 'owner' },
      { user: member, role: 'member' },
      { user: admin, role: 'member,admin' },
    ])
    const memberCtx = testContext(db, team.as(member), () => NOW)
    for (const operation of [
      () => listWebhooks(memberCtx),
      () =>
        createWebhook(memberCtx, settings, {
          url: 'https://hooks.example.com/',
          events: ['booking.created'],
        }),
      () => updateWebhook(memberCtx, webhook.id, { isActive: false }),
      () => deleteWebhook(memberCtx, webhook.id),
      () => rotateWebhookSecret(memberCtx, settings, webhook.id),
      () => listWebhookDeliveries(memberCtx, webhook.id),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'insufficient_role' })
    expect(await listWebhooks(testContext(db, team.as(admin)))).toEqual([])
    // Personal organizations protect their owner; revoked team membership remains testable.
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(listWebhooks(testContext(db, team.as(admin)))).rejects.toMatchObject({
      code: 'insufficient_role',
    })
  })

  it('isolates organizations, never returns stored secrets, and validates the service directly', async () => {
    const { ctx, webhook, secret } = await fixture()
    const other = testContext(db, (await createTestUser(db)).principal)
    await expect(updateWebhook(other, webhook.id, { isActive: false })).rejects.toMatchObject({
      code: 'webhook_not_found',
    })
    await expect(listWebhookDeliveries(other, webhook.id)).rejects.toMatchObject({
      code: 'webhook_not_found',
    })
    const stored = await db
      .selectFrom('webhooks')
      .select('secret_ciphertext')
      .where('id', '=', webhook.id)
      .executeTakeFirstOrThrow()
    expect(stored.secret_ciphertext.includes(Buffer.from(secret))).toBe(false)
    const list = JSON.stringify(await listWebhooks(ctx))
    expect(list.includes(secret) || list.includes('secret_ciphertext')).toBe(false)
    for (const input of [
      { url: 'https://127.0.0.1/', events: ['booking.created'] },
      { url: 'https://hooks.example.com/', events: [] },
      { url: 'https://hooks.example.com/', events: ['booking.created', 'booking.created'] },
      {
        url: 'https://hooks.example.com/',
        events: ['booking.created'],
        secret: 'chosen-by-attacker',
      },
    ])
      await expect(createWebhook(ctx, settings, input)).rejects.toMatchObject({
        code: 'invalid_webhook',
      })
    await expect(updateWebhook(ctx, webhook.id, {})).rejects.toMatchObject({
      code: 'invalid_webhook',
    })
    await expect(
      updateWebhook(ctx, webhook.id, { url: 'https://other.example.com/' }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' })
    await expect(
      createWebhook(
        ctx,
        { enabled: false },
        { url: 'https://hooks.example.com/', events: ['booking.created'] },
      ),
    ).rejects.toMatchObject({ code: 'webhooks_disabled' })
  })

  it('enforces the ten-endpoint cap under concurrent creates', async () => {
    const ctx = testContext(db, (await createTestUser(db)).principal)
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        createWebhook(ctx, settings, {
          url: 'https://hooks.example.com/',
          events: ['booking.created'],
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .every(
          (result) =>
            result.status === 'rejected' && result.reason.code === 'webhook_limit_reached',
        ),
    ).toBe(true)
  })

  it('commits an immutable minimal snapshot and an ID-only pg-boss job atomically', async () => {
    const { delivery, ctx, webhook } = await captured()
    const payload = JSON.parse(delivery.payload)
    expect(payload).toMatchObject({
      id: delivery.event_id,
      type: 'booking.created',
      data: { status: 'confirmed', source: 'api' },
    })
    expect(Object.keys(payload).sort()).toEqual(['data', 'id', 'occurredAt', 'type'])
    expect(Object.keys(payload.data).sort()).toEqual(
      [
        'bookingId',
        'end',
        'eventTypeId',
        'organizationId',
        'rescheduledFromId',
        'source',
        'start',
        'status',
      ].sort(),
    )
    const queued = await testDb.pool.query(
      "SELECT data FROM pgboss.job WHERE name=$1 AND data->>'deliveryId'=$2",
      [WEBHOOK_DELIVERY_JOB, delivery.id],
    )
    expect(queued.rows.map((row) => row.data)).toEqual([{ deliveryId: delivery.id }])
    const listing = await listWebhookDeliveries(ctx, webhook.id)
    expect(
      JSON.stringify(listing).includes('payload') || JSON.stringify(listing).includes('signature'),
    ).toBe(false)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('id', '=', delivery.booking_id)
      .execute()
    expect(
      (
        await db
          .selectFrom('webhook_deliveries')
          .select('payload')
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow()
      ).payload,
    ).toBe(delivery.payload)
  })

  it('rolls capture and jobs back together and captures nothing while disabled', async () => {
    const { bookingId, webhook } = await fixture()
    const notify = webhookBookingNotifier(jobs, settings)
    let rolledBackId = ''
    await expect(
      db.transaction().execute(async (trx) => {
        await notify(trx, { type: 'cancelled', bookingId }, NOW)
        const pending = await trx
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('webhook_id', '=', webhook.id)
          .executeTakeFirstOrThrow()
        rolledBackId = pending.id
        const outside = await testDb.pool.query(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND data->>'deliveryId'=$2",
          [WEBHOOK_DELIVERY_JOB, pending.id],
        )
        expect(outside.rows[0]?.n).toBe(0)
        throw new Error('rollback fixture')
      }),
    ).rejects.toThrow('rollback fixture')
    const orphan = await testDb.pool.query(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND data->>'deliveryId'=$2",
      [WEBHOOK_DELIVERY_JOB, rolledBackId],
    )
    expect(orphan.rows[0]?.n).toBe(0)
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', webhook.id)
        .execute(),
    ).toHaveLength(0)
    await db
      .transaction()
      .execute((trx) =>
        webhookBookingNotifier(jobs, { enabled: false })(
          trx,
          { type: 'cancelled', bookingId },
          NOW,
        ),
      )
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', webhook.id)
        .execute(),
    ).toHaveLength(0)
    await expect(notify(db, { type: 'cancelled', bookingId }, NOW)).rejects.toThrow('transaction')
  })

  it('captures real create/reschedule/cancel services once, including safe create replays', async () => {
    const { ctx, user, webhook } = await fixture()
    const f = createFixtures(db)
    const handle = `webhooks-${user.id.slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'Europe/Berlin' })
      .execute()
    await f.schedule(user.id)
    await f.eventType(ctx.principal.organization.id, user.id, { slug: 'intro' })
    const pub = { db, now: () => NOW, notify: webhookBookingNotifier(jobs, settings) }
    const input = {
      handle,
      slug: 'intro',
      start: Temporal.Instant.from('2026-11-04T09:00Z'),
      invitee: { name: 'Synthetic Invitee', email: 'webhook-invitee@example.com', timeZone: 'UTC' },
      idempotencyKey: randomUUID(),
    }
    const result = await createPublicBooking(pub, input)
    expect((await createPublicBooking(pub, input)).replayed).toBe(true)
    const moved = await rescheduleManagedBooking(pub, result.manageToken as string, {
      start: Temporal.Instant.from('2026-11-05T10:00Z'),
    })
    await cancelManagedBooking(pub, moved.manageToken as string, {})
    const rows = await db
      .selectFrom('webhook_deliveries')
      .select(['event_type', 'payload'])
      .where('webhook_id', '=', webhook.id)
      .orderBy('id')
      .execute()
    expect(rows.map((row) => row.event_type)).toEqual([
      'booking.created',
      'booking.rescheduled',
      'booking.cancelled',
    ])
    expect(JSON.stringify(rows).includes(result.manageToken as string)).toBe(false)
    expect(JSON.parse(rows[1]?.payload ?? '{}').data.rescheduledFromId).toBe(result.booking.id)
  })

  it('rolls an actual booking back if enqueue fails', async () => {
    const { ctx, user } = await fixture()
    const f = createFixtures(db)
    const handle = `rollback-${user.id.slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'Europe/Berlin' })
      .execute()
    await f.schedule(user.id)
    await f.eventType(ctx.principal.organization.id, user.id, { slug: 'intro' })
    const notify = webhookBookingNotifier(
      {
        enqueue: async () => {
          throw new Error('queue fixture failed')
        },
      },
      settings,
    )
    await expect(
      createPublicBooking(
        { db, now: () => NOW, notify },
        {
          handle,
          slug: 'intro',
          start: Temporal.Instant.from('2026-11-04T09:00Z'),
          invitee: { name: 'Synthetic', email: 'rollback@example.com', timeZone: 'UTC' },
        },
      ),
    ).rejects.toThrow('queue fixture failed')
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', ctx.principal.organization.id)
        .execute(),
    ).toHaveLength(1)
  })

  it('signs exact bytes with stable IDs, fresh timestamps, and suppresses successful duplicates', async () => {
    const { delivery, secret } = await captured()
    const requests: WebhookRequest[] = []
    const transport = async (request: WebhookRequest) => {
      requests.push(request)
      return requests.length === 1 ? 503 : 204
    }
    let now = NOW
    const d = deps(transport, () => now)
    await expect(deliverWebhook(d, delivery.id, signal())).rejects.toThrow(
      /^Webhook delivery failed$/,
    )
    now = now.add({ minutes: 1 })
    await deliverWebhook(d, delivery.id, signal())
    await deliverWebhook(d, delivery.id, signal())
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toBe(requests[1]?.body)
    expect(requests[0]?.headers['webhook-id']).toBe(requests[1]?.headers['webhook-id'])
    expect(requests[0]?.headers['webhook-event-id']).toBe(delivery.event_id)
    expect(
      requests[0]?.headers['webhook-timestamp'] === requests[1]?.headers['webhook-timestamp'],
    ).toBe(false)
    expect(
      requests.every(
        (r) =>
          r.headers['webhook-signature'] ===
          webhookSignature(secret, r.headers['webhook-timestamp'] ?? '', r.body),
      ),
    ).toBe(true)
    const row = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', delivery.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      status: 'delivered',
      attempts: 2,
      http_status: 204,
      last_error: null,
    })
  })

  it('serializes duplicate jobs and never sends the same successful delivery concurrently', async () => {
    const { delivery } = await captured()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let count = 0
    const d = deps(async () => {
      count++
      started.resolve()
      await release.promise
      return 204
    })
    const first = deliverWebhook(d, delivery.id, signal())
    await started.promise
    const second = deliverWebhook(d, delivery.id, signal())
    try {
      await waitForBlocked('%from "webhook_deliveries"%for update%')
      expect(count).toBe(1)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
    expect(count).toBe(1)
  })

  it.each(['disable', 'rotate', 'delete'] as const)(
    'makes %s wait for an already-started send, then honors the new state',
    async (operation) => {
      const { delivery, ctx, webhook, secret } = await captured()
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let capturedRequest: WebhookRequest | undefined
      const running = deliverWebhook(
        deps(async (request) => {
          capturedRequest = request
          started.resolve()
          await release.promise
          return 503
        }),
        delivery.id,
        signal(),
      )
      const runningResult = expect(running).rejects.toThrow('Webhook delivery failed')
      await started.promise
      let finished = false
      const change = (
        operation === 'disable'
          ? updateWebhook(ctx, webhook.id, { isActive: false })
          : operation === 'delete'
            ? deleteWebhook(ctx, webhook.id)
            : rotateWebhookSecret(ctx, settings, webhook.id)
      ).then((result) => {
        finished = true
        return result
      })
      try {
        await waitForBlocked('%from "webhooks"%for update%')
        expect(finished).toBe(false)
      } finally {
        release.resolve()
        await runningResult
        await change
      }
      const changed = await change
      expect(
        capturedRequest?.headers['webhook-signature'] ===
          webhookSignature(
            secret,
            capturedRequest?.headers['webhook-timestamp'] ?? '',
            capturedRequest?.body ?? '',
          ),
      ).toBe(true)
      let sends = 0
      await deliverWebhook(
        deps(async (request) => {
          sends++
          if (operation === 'rotate' && changed && 'secret' in changed)
            expect(
              request.headers['webhook-signature'] ===
                webhookSignature(
                  changed.secret,
                  request.headers['webhook-timestamp'] ?? '',
                  request.body,
                ),
            ).toBe(true)
          return 204
        }),
        delivery.id,
        signal(),
      )
      expect(sends).toBe(operation === 'rotate' ? 1 : 0)
    },
  )

  it('does not revive skipped deliveries when re-enabled or their subscription returns', async () => {
    const { delivery, webhook, ctx } = await captured()
    await updateWebhook(ctx, webhook.id, { events: ['booking.cancelled'] })
    let sends = 0
    const d = deps(async () => {
      sends++
      return 204
    })
    await deliverWebhook(d, delivery.id, signal())
    await updateWebhook(ctx, webhook.id, { events: [...WEBHOOK_EVENTS] })
    await deliverWebhook(d, delivery.id, signal())
    expect(sends).toBe(0)
  })

  it('gives up after thirteen total attempts and stores only safe error codes', async () => {
    const { delivery } = await captured()
    let sends = 0
    const d = deps(async () => {
      sends++
      throw new Error('external body credential=synthetic-secret')
    })
    for (let attempt = 0; attempt < 13; attempt++)
      await expect(deliverWebhook(d, delivery.id, signal())).rejects.toThrow(
        /^Webhook delivery failed$/,
      )
    await deliverWebhook(d, delivery.id, signal())
    expect(sends).toBe(13)
    const row = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', delivery.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      attempts: 13,
      status: 'failed',
      last_error: 'transport_error',
      http_status: null,
    })
    expect(JSON.stringify(row).includes('synthetic-secret')).toBe(false)
  })

  it('skips globally disabled and expired deliveries, and periodically removes old snapshots', async () => {
    const { delivery } = await captured()
    let sends = 0
    const d = deps(async () => {
      sends++
      return 204
    })
    await deliverWebhook({ ...d, enabled: false }, delivery.id, signal())
    expect(sends).toBe(0)
    const old = await captured()
    const later = NOW.add({ hours: 24 * 31 })
    await deliverWebhook({ ...d, now: () => later }, old.delivery.id, signal())
    expect(sends).toBe(0)
    expect(
      (await listWebhookDeliveries({ ...old.ctx, now: () => later }, old.webhook.id)).data,
    ).toEqual([])
    await webhookCleanupJob(db, () => later).handler(
      {},
      { id: randomUUID(), attempt: 1, signal: signal() },
    )
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('id', '=', old.delivery.id)
        .execute(),
    ).toEqual([])
    await deliverWebhook(d, old.delivery.id, signal())
  })

  it.each([200, 204, 299])(
    'records a late %i acknowledgement after shutdown as delivered',
    async (status) => {
      const { delivery } = await captured()
      const abort = new AbortController()
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<number>()
      let sends = 0
      const d = deps(async () => {
        sends++
        started.resolve()
        return response.promise
      })
      const running = deliverWebhook(d, delivery.id, abort.signal, 13)
      await started.promise
      abort.abort()
      response.resolve(status)
      await expect(running).resolves.toBeUndefined()
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        attempts: 13,
        status: 'delivered',
        http_status: status,
        last_error: null,
        delivered_at: new Date(NOW.epochMilliseconds),
      })
      await deliverWebhook(d, delivery.id, signal())
      expect(sends).toBe(1)
    },
  )

  it.each([199, 300, 503, null])(
    'counts shutdown without a successful acknowledgement (%s)',
    async (status) => {
      const { delivery } = await captured()
      const abort = new AbortController()
      await expect(
        deliverWebhook(
          deps(async () => {
            abort.abort()
            if (status === null) throw new Error('synthetic aborted transport')
            return status
          }),
          delivery.id,
          abort.signal,
        ),
      ).rejects.toThrow(/^Webhook delivery interrupted$/)
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        attempts: 1,
        status: 'pending',
        http_status: null,
        last_error: 'interrupted',
        delivered_at: null,
      })
    },
  )

  it('retries after decryption failure without leaking keys', async () => {
    const { delivery } = await captured()
    await expect(
      deliverWebhook(
        { ...deps(async () => 204), encryptionKey: Buffer.alloc(32, 8).toString('base64') },
        delivery.id,
        signal(),
      ),
    ).rejects.toThrow(/^Webhook delivery failed$/)
    const row = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', delivery.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ attempts: 1, status: 'pending', last_error: 'secret_unavailable' })
  })

  it('includes killed runs in the pg-boss attempt budget and fails the last retry', async () => {
    const { delivery } = await captured()
    let sends = 0
    const job = webhookDeliveryJob(
      deps(async () => {
        sends++
        return 503
      }),
    )
    // A killed first run left no committed delivery metadata. pg-boss starts retry #1.
    for (let attempt = 2; attempt <= 13; attempt++)
      await expect(
        job.handler({ deliveryId: delivery.id }, { id: randomUUID(), attempt, signal: signal() }),
      ).rejects.toThrow(/^Webhook delivery failed$/)
    await job.handler(
      { deliveryId: delivery.id },
      { id: randomUUID(), attempt: 14, signal: signal() },
    )
    expect(sends).toBe(12)
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      attempts: 13,
      status: 'failed',
      last_error: 'http_error',
    })
  })

  it('commits an interrupted final attempt as failed and does not send when already aborted', async () => {
    const { delivery } = await captured()
    const abort = new AbortController()
    abort.abort()
    let sends = 0
    const job = webhookDeliveryJob(
      deps(async () => {
        sends++
        return 204
      }),
    )
    await expect(
      job.handler(
        { deliveryId: delivery.id },
        { id: randomUUID(), attempt: 13, signal: abort.signal },
      ),
    ).rejects.toThrow(/^Webhook delivery interrupted$/)
    expect(sends).toBe(0)
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      attempts: 13,
      status: 'failed',
      last_error: 'interrupted',
      http_status: null,
    })
  })

  it('reconciles missing and terminal jobs while preserving created, delayed retries and active jobs', async () => {
    const cleanup = webhookCleanupJob(db, () => NOW)
    expect(cleanup.schedule?.cron).toBe('*/15 * * * *')
    const cases = []
    for (const state of [
      'missing',
      'failed',
      'cancelled',
      'completed',
      'created',
      'retry',
      'active',
    ]) {
      const { delivery, ctx, webhook } = await captured()
      if (state === 'missing')
        await testDb.pool.query('DELETE FROM pgboss.job WHERE name=$1 AND singleton_key=$2', [
          WEBHOOK_DELIVERY_JOB,
          delivery.id,
        ])
      else
        await testDb.pool.query(
          `UPDATE pgboss.job SET state=$3::pgboss.job_state,
             retry_count=CASE WHEN $3='failed' THEN 12 ELSE 0 END,
             started_on=CASE WHEN $3 IN ('failed','completed','active','retry') THEN now() ELSE NULL END,
             start_after=now()+interval '1 hour'
           WHERE name=$1 AND singleton_key=$2`,
          [WEBHOOK_DELIVERY_JOB, delivery.id, state],
        )
      cases.push({ state, delivery, ctx, webhook })
    }
    await cleanup.handler({}, { id: randomUUID(), attempt: 1, signal: signal() })
    await cleanup.handler({}, { id: randomUUID(), attempt: 1, signal: signal() })
    for (const { state, delivery, ctx, webhook } of cases) {
      const row = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow()
      if (['created', 'retry', 'active'].includes(state))
        expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
      else {
        expect(row).toMatchObject({ status: 'failed', last_error: 'job_missing' })
        expect(row.attempts).toBe(
          ['missing', 'cancelled'].includes(state) ? 0 : state === 'failed' ? 13 : 1,
        )
        expect((await listWebhookDeliveries(ctx, webhook.id)).data[0]).toMatchObject({
          status: 'failed',
          lastError: 'job_missing',
          attempts: row.attempts,
        })
      }
    }
  })

  it('does not overwrite an in-flight acknowledgement during reconciliation', async () => {
    const { delivery } = await captured()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const running = deliverWebhook(
      deps(async () => {
        entered.resolve()
        await release.promise
        return 204
      }),
      delivery.id,
      signal(),
    )
    await entered.promise
    try {
      await testDb.pool.query(
        "UPDATE pgboss.job SET state='failed', retry_count=12 WHERE name=$1 AND singleton_key=$2",
        [WEBHOOK_DELIVERY_JOB, delivery.id],
      )
      await webhookCleanupJob(db, () => NOW).handler(
        {},
        { id: randomUUID(), attempt: 1, signal: signal() },
      )
    } finally {
      release.resolve()
      await running
    }
    await webhookCleanupJob(db, () => NOW).handler(
      {},
      { id: randomUUID(), attempt: 1, signal: signal() },
    )
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'delivered',
      attempts: 1,
      last_error: null,
    })
  })
})
