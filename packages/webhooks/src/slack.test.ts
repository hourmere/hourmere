import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encryptWebhookSecret } from './crypto.ts'
import {
  deliverWebhook,
  webhookAttendeeNoShowNotifier,
  webhookBookingNotifier,
} from './delivery.ts'
import { deleteWebhook, listWebhooks, rotateWebhookSecret, updateWebhook } from './service.ts'
import {
  createSlackDestination,
  deleteSlackDestination,
  listSlackDestinations,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'
import { escapeSlackText, slackPayload, slackUrl } from './slack-format.ts'

const url = 'https://hooks.slack.com/services/TTEST/BTEST/synthetic-secret'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
const now = Temporal.Instant.from('2026-11-01T12:00Z')
it('accepts only documented incoming webhook hosts and exact credential paths', () => {
  expect(slackUrl(url)).toBe(url)
  expect(slackUrl(url.replace('slack.com', 'slack-gov.com'))).toBeUndefined()
  for (const bad of [
    url.replace('https:', 'http:'),
    `${url}?x=y`,
    `${url}#x`,
    `${url}/`,
    url.replace('slack.com', 'slack.com.evil.com'),
    url.replace('hooks.slack.com', '127.0.0.1'),
    url.replace('/TTEST/', '/%54TEST/'),
    url.replace('hooks.slack.com', 'user@hooks.slack.com'),
    url.replace('hooks.slack.com', 'hooks.slack.com:444'),
    `${url}\n`,
  ])
    expect(slackUrl(bad)).toBeUndefined()
})
it('neutralizes markup, mentions and links and uses plain text with no data expansion', () => {
  const attack = '<!channel> <@U123> @channel @here & <https://evil.test|click>'
  const safe = escapeSlackText(attack)
  expect(safe).not.toMatch(/[<>@]/)
  expect(safe).toContain('&amp;')
  const payload = JSON.parse(
    slackPayload({
      type: attack,
      bookingId: 'safe-id',
      start: 'UTC',
      end: 'UTC',
      status: attack,
      ...{ answers: attack, title: attack, email: 'private@example.com' },
    }),
  )
  expect(payload.mrkdwn).toBe(false)
  expect(payload.blocks[0].text.type).toBe('plain_text')
  expect(payload.text).not.toMatch(/[<>@]/)
  expect(JSON.stringify(payload)).not.toContain('private@example.com')
})
describe.skipIf(!process.env.DATABASE_URL)(
  'Slack durable destinations',
  { timeout: 60_000 },
  () => {
    let owned: TestDatabase
    let db: Db
    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(owned.pool)
    })
    afterAll(async () => {
      await owned?.drop()
    })
    async function fixture() {
      const user = await createTestUser(db)
      const ctx = testContext(db, user.principal, () => now)
      const destination = await createSlackDestination(ctx, settings, {
        url,
        events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
      })
      const bookingId = await createFixtures(db).booking(
        user.principal.organization.id,
        [user.id],
        '2026-11-03T09:00Z',
        '2026-11-03T09:30Z',
      )
      return { ctx, destination, bookingId }
    }
    const queue = { enqueue: vi.fn(async () => null) }
    it('encrypts and masks URLs; enforces roles, isolation and one destination under concurrent creation', async () => {
      const { ctx, destination } = await fixture()
      expect(JSON.stringify(destination)).not.toContain('synthetic-secret')
      expect((await listSlackDestinations(ctx))[0]?.url).toBe(
        'https://hooks.slack.com/services/••••',
      )
      const row = await db
        .selectFrom('webhooks')
        .selectAll()
        .where('id', '=', destination.id)
        .executeTakeFirstOrThrow()
      expect(row.url_ciphertext?.toString()).not.toContain(url)
      expect(await listWebhooks(ctx)).toEqual([])
      for (const op of [
        () => updateWebhook(ctx, destination.id, { isActive: false }),
        () => deleteWebhook(ctx, destination.id),
        () => rotateWebhookSecret(ctx, { ...settings, enabled: true }, destination.id),
      ])
        await expect(op()).rejects.toMatchObject({ code: 'webhook_not_found' })
      const other = await fixture()
      await expect(deleteSlackDestination(other.ctx, destination.id)).rejects.toMatchObject({
        code: 'slack_destination_not_found',
      })
      await expect(
        updateSlackDestination(other.ctx, destination.id, { isActive: false }, settings),
      ).rejects.toMatchObject({ code: 'slack_destination_not_found' })
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('userId', '=', ctx.principal.user.id)
        .execute()
      await expect(listSlackDestinations(ctx)).rejects.toMatchObject({ code: 'insufficient_role' })
      const user = await createTestUser(db)
      const fresh = testContext(db, user.principal)
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          createSlackDestination(fresh, settings, { url, events: ['booking.created'] }),
        ),
      )
      expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((v) => v.status === 'rejected')).toHaveLength(1)
    })
    it('captures transactionally with the operator switch enabled, deduplicates replay, and respects filters and disable', async () => {
      const { ctx, destination, bookingId } = await fixture()
      const notify = webhookBookingNotifier(queue, settings)
      const event = { type: 'created' as const, bookingId, start: now }
      await expect(
        db.transaction().execute(async (trx) => {
          await notify(trx, event, now)
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      const rows = () =>
        db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('webhook_id', '=', destination.id)
          .execute()
      expect(await rows()).toHaveLength(0)
      for (const type of ['created', 'created', 'rescheduled', 'cancelled'] as const)
        await db.transaction().execute((trx) => notify(trx, { ...event, type }, now))
      expect(await rows()).toHaveLength(3)
      const payload = JSON.parse((await rows())[0]?.payload ?? '{}')
      expect(payload.text).toContain(bookingId)
      expect(payload.text).not.toContain('rescheduledFromId')
      const other = await createTestUser(db)
      const foreign = await createFixtures(db).eventType(other.principal.organization.id, other.id)
      await expect(
        updateSlackDestination(ctx, destination.id, { eventTypeId: foreign }, settings),
      ).rejects.toMatchObject({ code: 'invalid_slack_destination' })
      await updateSlackDestination(ctx, destination.id, { isActive: false }, settings)
      await expect(
        testSlackDestination(ctx, settings, destination.id, queue),
      ).rejects.toMatchObject({
        code: 'slack_destination_disabled',
      })
    })
    it('keeps attendee no-show changes off Slack, even for a row widened outside the service', async () => {
      const { ctx, destination, bookingId } = await fixture()
      const noShow = 'booking.attendee_no_show_changed'
      for (const op of [
        () => createSlackDestination(ctx, settings, { url, events: [noShow] }),
        () =>
          updateSlackDestination(
            ctx,
            destination.id,
            { events: ['booking.created', noShow] },
            settings,
          ),
      ])
        await expect(op()).rejects.toMatchObject({ code: 'invalid_slack_destination' })
      // 0070's events check accepts the kind on every row; capture must still skip Slack.
      await db
        .updateTable('webhooks')
        .set({ events: ['booking.created', noShow] })
        .where('id', '=', destination.id)
        .execute()
      const enqueue = vi.fn(async () => null)
      const change = {
        bookingId,
        attendeeId: randomUUID(),
        noShowMarkedAt: now.toString(),
        noShowMarkedBy: ctx.principal.user.id,
      }
      await db
        .transaction()
        .execute((trx) => webhookAttendeeNoShowNotifier({ enqueue }, settings)(trx, change, now))
      const rows = () =>
        db
          .selectFrom('webhook_deliveries')
          .select('event_type')
          .where('webhook_id', '=', destination.id)
          .execute()
      expect(await rows()).toEqual([])
      expect(enqueue).not.toHaveBeenCalled()
      // The same destination still receives its lifecycle events.
      await db
        .transaction()
        .execute((trx) =>
          webhookBookingNotifier({ enqueue }, settings)(
            trx,
            { type: 'created', bookingId, start: now },
            now,
          ),
        )
      expect(await rows()).toEqual([{ event_type: 'booking.created' }])
      expect(enqueue).toHaveBeenCalledTimes(1)
    })
    it('queues samples atomically, retries safely, gives up, rechecks URL and omits signature and private exceptions', async () => {
      const { ctx, destination } = await fixture()
      await expect(
        testSlackDestination(ctx, settings, destination.id, {
          enqueue: async () => {
            throw new Error('queue failed')
          },
        }),
      ).rejects.toThrow('queue failed')
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('webhook_id', '=', destination.id)
          .execute(),
      ).toHaveLength(0)
      const { deliveryId } = await testSlackDestination(ctx, settings, destination.id, queue)
      const transport = vi.fn(
        async (request: { url: string; headers: unknown; privateTargets?: unknown }) => {
          throw new Error(request.url)
        },
      )
      const deps = { db, ...settings, now: () => now, transport }
      for (let attempt = 1; attempt <= 13; attempt++)
        await expect(
          deliverWebhook(deps, deliveryId, new AbortController().signal, attempt),
        ).rejects.toThrow('Webhook delivery failed')
      const row = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', deliveryId)
        .executeTakeFirstOrThrow()
      expect(row.status).toBe('failed')
      expect(row.attempts).toBe(13)
      expect(JSON.stringify(row)).not.toContain(url)
      await deliverWebhook(deps, deliveryId, new AbortController().signal)
      expect(transport).toHaveBeenCalledTimes(13)
      expect(transport.mock.calls[0]?.[0]).toMatchObject({ url, headers: {}, privateTargets: [] })
      const second = await testSlackDestination(ctx, settings, destination.id, queue)
      await db
        .updateTable('webhooks')
        .set({
          url_ciphertext: encryptWebhookSecret(
            'https://evil.example.com/services/T/B/C',
            settings.encryptionKey,
            `${destination.id}:url`,
            destination.organizationId,
          ),
        })
        .where('id', '=', destination.id)
        .execute()
      await expect(
        deliverWebhook(deps, second.deliveryId, new AbortController().signal),
      ).rejects.toThrow('Webhook delivery failed')
      expect(transport).toHaveBeenCalledTimes(13)
    })
    it('rechecks filters at capture and delivery, while synthetic tests bypass event filters', async () => {
      const { ctx, destination, bookingId } = await fixture()
      const notify = webhookBookingNotifier(queue, settings)
      await db
        .transaction()
        .execute((trx) => notify(trx, { type: 'created', bookingId, start: now }, now))
      const eventTypeId = await createFixtures(db).eventType(
        ctx.principal.organization.id,
        ctx.principal.user.id,
      )
      await updateSlackDestination(ctx, destination.id, { eventTypeId }, settings)
      const pending = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', destination.id)
        .executeTakeFirstOrThrow()
      const transport = vi.fn(async () => 200)
      await deliverWebhook(
        { db, ...settings, now: () => now, transport },
        pending.id,
        new AbortController().signal,
      )
      expect(transport).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select(['status', 'last_error'])
          .where('id', '=', pending.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'skipped', last_error: 'disabled' })
      await db.transaction().execute((trx) => notify(trx, { type: 'cancelled', bookingId }, now))
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('webhook_id', '=', destination.id)
          .execute(),
      ).toHaveLength(1)
      const sample = await testSlackDestination(ctx, settings, destination.id, queue)
      await deliverWebhook(
        { db, ...settings, now: () => now, transport },
        sample.deliveryId,
        new AbortController().signal,
      )
      await deliverWebhook(
        { db, ...settings, now: () => now, transport },
        sample.deliveryId,
        new AbortController().signal,
      )
      expect(transport).toHaveBeenCalledTimes(1)
    })
    it('keeps team messages within the team administrator whitelist', async () => {
      const owner = await createTestUser(db)
      const member = await createTestUser(db)
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: member, role: 'member' },
      ])
      const ctx = testContext(db, team.as(owner), () => now)
      const destination = await createSlackDestination(ctx, settings, {
        url,
        events: ['booking.created'],
      })
      await expect(listSlackDestinations(testContext(db, team.as(member)))).rejects.toMatchObject({
        code: 'insufficient_role',
      })
      const bookingId = await createFixtures(db).booking(
        team.id,
        [member.id],
        '2026-11-01T08:30Z',
        '2026-11-01T09:30Z',
        { attendee: { name: '<!channel> @here', email: 'private@example.com' } },
      )
      await db
        .updateTable('bookings')
        .set({ title: 'PRIVATE_TITLE', responses: JSON.stringify({ secret: 'PRIVATE_ANSWER' }) })
        .where('id', '=', bookingId)
        .execute()
      await db
        .transaction()
        .execute((trx) =>
          webhookBookingNotifier(queue, settings)(
            trx,
            { type: 'created', bookingId, start: now },
            now,
          ),
        )
      const row = await db
        .selectFrom('webhook_deliveries')
        .select('payload')
        .where('webhook_id', '=', destination.id)
        .executeTakeFirstOrThrow()
      for (const privateText of [
        'PRIVATE_TITLE',
        'PRIVATE_ANSWER',
        'private@example.com',
        '<!channel>',
        '@here',
        'rescheduledFromId',
      ])
        expect(row.payload).not.toContain(privateText)
      expect(row.payload).toContain('2026-11-01T08:30+00:00[UTC]')
      expect(row.payload).toContain('2026-11-01T09:30+00:00[UTC]')
    })
    it('rechecks session authorization after waiting for an endpoint lock', async () => {
      const { ctx, destination } = await fixture()
      const client = await owned.pool.connect()
      let change: Promise<unknown> | undefined
      let allowed = true
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM webhooks WHERE id=$1 FOR UPDATE', [destination.id])
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]
          ?.pid
        const authorizeOrganizationWrite = vi.fn(async () => {
          if (!allowed) throw new Error('session revoked')
        })
        change = updateSlackDestination(
          { ...ctx, authorizeOrganizationWrite },
          destination.id,
          { isActive: false },
          settings,
        ).catch((error) => error)
        await vi.waitFor(
          async () => {
            const result = await owned.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',
              [pid],
            )
            expect(result.rows.length).toBeGreaterThan(0)
          },
          { timeout: 15_000, interval: 10 },
        )
        allowed = false
        await client.query('COMMIT')
        expect(await change).toEqual(new Error('session revoked'))
        expect((await listSlackDestinations(ctx))[0]?.isActive).toBe(true)
      } finally {
        await client.query('ROLLBACK')
        client.release()
        await change
      }
    })
  },
)
