import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const service: typeof import('./service.ts') = await import(
  process.env.HOURMERE_WEBHOOK_AUDIT_MUTATION_FILE ?? './service.ts'
)
const { createWebhook, updateWebhook, rotateWebhookSecret, deleteWebhook } = service
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 7).toString('base64') }
const input = {
  url: 'https://hooks.example.com/private-path?token=private-query',
  events: ['booking.created'],
}
const operations = ['create', 'update', 'pause', 'rotate', 'delete'] as const

describe.skipIf(!process.env.DATABASE_URL)('webhook management audit', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  async function fixture() {
    const user = await createTestUser(db)
    const ctx = { ...testContext(db, user.principal), requestId: randomUUID() }
    return { user, ctx }
  }
  async function events(organizationId: string) {
    return (
      await owned.pool.query(
        'SELECT * FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at, id',
        [organizationId],
      )
    ).rows
  }
  async function run(
    operation: (typeof operations)[number],
    ctx: ReturnType<typeof testContext>,
    id: string,
  ) {
    if (operation === 'create') return createWebhook(ctx, settings, input).then(() => undefined)
    if (operation === 'update') return updateWebhook(ctx, id, { events: ['booking.cancelled'] })
    if (operation === 'pause') return updateWebhook(ctx, id, { isActive: false })
    if (operation === 'rotate') return rotateWebhookSecret(ctx, settings, id).then(() => undefined)
    return deleteWebhook(ctx, id)
  }

  it.each(['api_key', 'session'] as const)(
    'records all management operations with %s attribution and only event details',
    async (kind) => {
      const { user, ctx } = await fixture()
      const sessionId = randomUUID()
      const principal: Principal =
        kind === 'session' ? { ...user.principal, kind, sessionId } : user.principal
      const context = { ...ctx, principal }
      const created = await createWebhook(context, settings, input)
      await updateWebhook(context, created.webhook.id, {
        events: ['booking.cancelled', 'booking.rescheduled'],
      })
      const rotated = await rotateWebhookSecret(context, settings, created.webhook.id)
      await deleteWebhook(context, created.webhook.id)
      const rows = await events(principal.organization.id)
      expect(rows.map((row) => row.action)).toEqual([
        'webhook.created',
        'webhook.updated',
        'webhook.secret_rotated',
        'webhook.deleted',
      ])
      for (const [index, row] of rows.entries()) {
        expect(row).toMatchObject({
          actor_type: kind === 'session' ? 'user' : 'api_key',
          actor_id: principal.kind === 'api_key' ? principal.apiKeyId : user.id,
          credential_type: kind,
          credential_id: principal.kind === 'api_key' ? principal.apiKeyId : sessionId,
          target_type: 'webhook',
          target_id: created.webhook.id,
          request_id: ctx.requestId,
          details: {
            events:
              index === 0 ? ['booking.created'] : ['booking.cancelled', 'booking.rescheduled'],
          },
        })
      }
      const serialized = JSON.stringify(rows)
      for (const sensitive of [
        input.url,
        'private-path',
        'private-query',
        created.secret,
        rotated.secret,
      ])
        expect(serialized.includes(sensitive)).toBe(false)
    },
  )

  it('records pausing and resuming separately from event edits', async () => {
    const { user, ctx } = await fixture()
    const { webhook } = await createWebhook(ctx, settings, input)
    await updateWebhook(ctx, webhook.id, { isActive: false })
    await updateWebhook(ctx, webhook.id, { isActive: false })
    await updateWebhook(ctx, webhook.id, { isActive: true, events: ['booking.cancelled'] })
    await updateWebhook(ctx, webhook.id, { isActive: true })
    const rows = await events(user.principal.organization.id)
    expect(rows.map((row) => [row.action, row.details])).toEqual([
      ['webhook.created', { events: ['booking.created'] }],
      ['webhook.paused', { events: ['booking.created'] }],
      // Repeating a state is an ordinary update, never a second pause or resume.
      ['webhook.updated', { events: ['booking.created'] }],
      ['webhook.resumed', { events: ['booking.cancelled'] }],
      ['webhook.updated', { events: ['booking.cancelled'] }],
      ['webhook.updated', { events: ['booking.cancelled'] }],
    ])
    for (const row of rows)
      expect(row).toMatchObject({ target_type: 'webhook', target_id: webhook.id })
    expect(new Set(rows.map((row) => row.request_id))).toEqual(new Set([ctx.requestId]))
  })

  it('rejects another organization without recording its attempted operation', async () => {
    const a = await fixture(),
      b = await fixture()
    const { webhook } = await createWebhook(a.ctx, settings, input)
    for (const operation of ['update', 'rotate', 'delete'] as const)
      await expect(run(operation, b.ctx, webhook.id)).rejects.toMatchObject({
        code: 'webhook_not_found',
      })
    expect(await events(b.user.principal.organization.id)).toEqual([])
    expect(await events(a.user.principal.organization.id)).toHaveLength(1)
  })

  it.each(operations)('%s rolls back the domain change when auditing fails', async (operation) => {
    const { user, ctx } = await fixture()
    const { webhook } = await createWebhook(ctx, settings, input)
    const before = await db
      .selectFrom('webhooks')
      .selectAll()
      .where('organization_id', '=', user.principal.organization.id)
      .execute()
    await owned.pool.query(`CREATE FUNCTION reject_webhook_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_webhook_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_webhook_audit()`)
    try {
      await expect(run(operation, ctx, webhook.id)).rejects.toThrow('audit unavailable')
    } finally {
      await owned.pool.query(
        'DROP TRIGGER reject_webhook_audit ON audit_events; DROP FUNCTION reject_webhook_audit()',
      )
    }
    expect(
      await db
        .selectFrom('webhooks')
        .selectAll()
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toEqual(before)
    expect(await events(user.principal.organization.id)).toHaveLength(1)
  })

  it.each(operations)('%s rolls back its audit if the domain commit fails', async (operation) => {
    const { user, ctx } = await fixture()
    const { webhook } = await createWebhook(ctx, settings, input)
    const before = await db
      .selectFrom('webhooks')
      .selectAll()
      .where('organization_id', '=', user.principal.organization.id)
      .execute()
    await owned.pool.query(`CREATE FUNCTION reject_webhook_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'domain commit unavailable'; END $$;
      CREATE CONSTRAINT TRIGGER reject_webhook_commit AFTER INSERT OR UPDATE OR DELETE ON webhooks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_webhook_commit()`)
    try {
      await expect(run(operation, ctx, webhook.id)).rejects.toThrow('domain commit unavailable')
    } finally {
      await owned.pool.query(
        'DROP TRIGGER reject_webhook_commit ON webhooks; DROP FUNCTION reject_webhook_commit()',
      )
    }
    expect(
      await db
        .selectFrom('webhooks')
        .selectAll()
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toEqual(before)
    expect(await events(user.principal.organization.id)).toHaveLength(1)
  })
})
