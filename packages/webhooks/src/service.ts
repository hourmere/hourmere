import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import type { ServiceContext } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { z } from 'zod'
import { encryptWebhookSecret, newWebhookSecret } from './crypto.ts'
import { webhookUrl } from './transport.ts'

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
] as const
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]
export const WebhookCreateInput = z.strictObject({
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  isActive: z.boolean().optional(),
})
export const WebhookUpdateInput = z.strictObject({
  events: z.array(z.enum(WEBHOOK_EVENTS)).optional(),
  isActive: z.boolean().optional(),
})
export interface WebhookSettings {
  enabled: boolean
  encryptionKey?: string | undefined
}
export interface WebhookView {
  id: string
  organizationId: string
  url: string
  events: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && z.uuid().safeParse(value).success
const missing = () => new DomainError('not_found', 'webhook_not_found')
const invalid = () => new DomainError('invalid', 'invalid_webhook', 'Invalid webhook configuration')
const insufficientRole = () =>
  new DomainError(
    'forbidden',
    'insufficient_role',
    'Only organization owners and admins can manage webhooks',
  )

/** Check current verified membership; a stale resolver principal cannot retain admin rights. */
async function requireAdmin(db: Db, ctx: ServiceContext, lock = false) {
  let query = db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select('m.role')
    .where('m.organizationId', '=', ctx.principal.organization.id)
    .where('m.userId', '=', ctx.principal.user.id)
    .where('u.emailVerified', '=', true)
  if (lock) query = query.forShare('m')
  const membership = await query.executeTakeFirst()
  const roles = membership?.role.split(',').map((role) => role.trim()) ?? []
  if (!roles.includes('owner') && !roles.includes('admin')) throw insufficientRole()
}

/**
 * All mutations take authorization parents before any endpoint/member lock. User deletion
 * starts at user; organization deletion starts at organization then cascades to members
 * and endpoints. Taking those parents first avoids an inverse cascade lock order. A
 * shared user lock also serializes email unverification with the eventual mutation.
 * Membership is deliberately locked/rechecked AFTER waiting for the organization and
 * endpoint: a demotion or removal already committed during that wait must win.
 */
async function lockAuthorizationParents(
  trx: Db,
  ctx: ServiceContext,
  exclusiveOrganization = false,
) {
  const user = await trx
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', ctx.principal.user.id)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
  if (!user) throw insufficientRole()
  let organization = trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', ctx.principal.organization.id)
  organization = exclusiveOrganization ? organization.forUpdate() : organization.forKeyShare()
  if (!(await organization.executeTakeFirst())) throw insufficientRole()
}

function requireEnabled(settings: WebhookSettings): string {
  if (!settings.enabled || !settings.encryptionKey)
    throw new DomainError('conflict', 'webhooks_disabled', 'Webhooks are disabled on this instance')
  return settings.encryptionKey
}

function eventsOf(events: unknown): WebhookEventType[] {
  const parsed = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(3).safeParse(events)
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) throw invalid()
  return [...parsed.data].sort()
}

const view = (row: {
  id: string
  organization_id: string
  url: string
  events: string[]
  is_active: boolean
  created_at: Date
  updated_at: Date
}): WebhookView => ({
  id: row.id,
  organizationId: row.organization_id,
  url: row.url,
  events: row.events,
  isActive: row.is_active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
})
const visibleColumns = [
  'id',
  'organization_id',
  'url',
  'events',
  'is_active',
  'created_at',
  'updated_at',
] as const

export async function listWebhooks(ctx: ServiceContext): Promise<WebhookView[]> {
  await requireAdmin(ctx.db, ctx)
  return (
    await ctx.db
      .selectFrom('webhooks')
      .select(visibleColumns)
      .where('organization_id', '=', ctx.principal.organization.id)
      .orderBy('id')
      .limit(10)
      .execute()
  ).map(view)
}

export async function createWebhook(
  ctx: ServiceContext,
  settings: WebhookSettings,
  input: unknown,
) {
  const parsed = WebhookCreateInput.safeParse(input)
  if (!parsed.success) throw invalid()
  const url = webhookUrl(parsed.data.url)
  const events = eventsOf(parsed.data.events)
  if (!url) throw invalid()
  const encryptionKey = requireEnabled(settings)
  return ctx.db.transaction().execute(async (trx) => {
    await requireAdmin(trx, ctx)
    // Exclusive organization lock also serializes the cap across concurrent creates.
    await lockAuthorizationParents(trx, ctx, true)
    await requireAdmin(trx, ctx, true)
    const rows = await trx
      .selectFrom('webhooks')
      .select('id')
      .where('organization_id', '=', ctx.principal.organization.id)
      .limit(10)
      .execute()
    if (rows.length >= 10)
      throw new DomainError(
        'conflict',
        'webhook_limit_reached',
        'At most ten webhooks per organization',
      )
    const id = randomUUID()
    const secret = newWebhookSecret()
    const row = await trx
      .insertInto('webhooks')
      .values({
        id,
        organization_id: ctx.principal.organization.id,
        url,
        events,
        is_active: parsed.data.isActive ?? true,
        secret_ciphertext: encryptWebhookSecret(
          secret,
          encryptionKey,
          id,
          ctx.principal.organization.id,
        ),
      })
      .returning(visibleColumns)
      .executeTakeFirstOrThrow()
    return { webhook: view(row), secret }
  })
}

async function lockedWebhook(trx: Db, ctx: ServiceContext, id: unknown) {
  await requireAdmin(trx, ctx)
  if (!uuid(id)) throw missing()
  await lockAuthorizationParents(trx, ctx)
  const row = await trx
    .selectFrom('webhooks')
    .select(visibleColumns)
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .forUpdate()
    .executeTakeFirst()
  await requireAdmin(trx, ctx, true)
  if (!row) throw missing()
  return row
}

/** URL is immutable: changing destinations means creating a new endpoint and deleting the old. */
export async function updateWebhook(ctx: ServiceContext, id: unknown, input: unknown) {
  const parsed = WebhookUpdateInput.safeParse(input)
  if (!parsed.success || Object.keys(parsed.data).length === 0) throw invalid()
  const events = parsed.data.events === undefined ? undefined : eventsOf(parsed.data.events)
  return ctx.db.transaction().execute(async (trx) => {
    const row = await lockedWebhook(trx, ctx, id)
    const updated = await trx
      .updateTable('webhooks')
      .set({
        ...(events && { events }),
        ...(parsed.data.isActive !== undefined && { is_active: parsed.data.isActive }),
        updated_at: new Date(ctx.now().epochMilliseconds),
      })
      .where('id', '=', row.id)
      .returning(visibleColumns)
      .executeTakeFirstOrThrow()
    return view(updated)
  })
}

export async function rotateWebhookSecret(
  ctx: ServiceContext,
  settings: WebhookSettings,
  id: unknown,
) {
  const encryptionKey = requireEnabled(settings)
  return ctx.db.transaction().execute(async (trx) => {
    const row = await lockedWebhook(trx, ctx, id)
    const secret = newWebhookSecret()
    await trx
      .updateTable('webhooks')
      .set({
        secret_ciphertext: encryptWebhookSecret(secret, encryptionKey, row.id, row.organization_id),
        updated_at: new Date(ctx.now().epochMilliseconds),
      })
      .where('id', '=', row.id)
      .execute()
    return { secret }
  })
}

export async function deleteWebhook(ctx: ServiceContext, id: unknown) {
  await ctx.db.transaction().execute(async (trx) => {
    const row = await lockedWebhook(trx, ctx, id)
    await trx.deleteFrom('webhooks').where('id', '=', row.id).execute()
  })
}

/** Metadata only: snapshots and signatures are deliberately absent. */
export async function listWebhookDeliveries(ctx: ServiceContext, id: unknown, after?: string) {
  await requireAdmin(ctx.db, ctx)
  if (!uuid(id)) throw missing()
  const endpoint = await ctx.db
    .selectFrom('webhooks')
    .select('id')
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (!endpoint) throw missing()
  if (after !== undefined && !uuid(after))
    throw new DomainError('invalid', 'invalid_cursor', 'after must be a UUID')
  let query = ctx.db
    .selectFrom('webhook_deliveries')
    .select([
      'id',
      'event_id',
      'event_type',
      'booking_id',
      'status',
      'attempts',
      'http_status',
      'last_error',
      'created_at',
      'last_attempt_at',
      'delivered_at',
    ])
    .where('webhook_id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('created_at', '>=', new Date(ctx.now().subtract({ hours: 24 * 30 }).epochMilliseconds))
    .orderBy('id', 'desc')
    .limit(51)
  if (after !== undefined) query = query.where('id', '<', after)
  const rows = await query.execute()
  const page = rows.slice(0, 50)
  return {
    data: page.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      bookingId: row.booking_id,
      status: row.status,
      attempts: row.attempts,
      httpStatus: row.http_status,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
      deliveredAt: row.delivered_at?.toISOString() ?? null,
    })),
    nextAfter: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
  }
}
