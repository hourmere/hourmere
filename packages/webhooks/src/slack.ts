import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import type { ServiceContext } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { z } from 'zod'
import { encryptWebhookSecret } from './crypto.ts'
import { WEBHOOK_DELIVERY_JOB, type WebhookQueue } from './delivery.ts'
import {
  lockAuthorizationParents,
  requireAdmin,
  WEBHOOK_EVENTS,
  type WebhookServiceContext,
  type WebhookSettings,
  type WebhookView,
} from './service.ts'
import { slackPayload, slackUrl } from './slack-format.ts'

const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .refine((v) => new Set(v).size === v.length)
export const SlackCreateInput = z.strictObject({
  url: z.string(),
  events,
  isActive: z.boolean().optional(),
  eventTypeId: z.uuid().nullable().optional(),
})
export const SlackUpdateInput = SlackCreateInput.partial().refine((v) => Object.keys(v).length > 0)
/** Known automatic pause causes; new values may appear and still mean paused. */
export const SLACK_PAUSE_REASONS = ['url_rejected'] as const
export interface SlackDestinationView extends WebhookView {
  eventTypeId: string | null
  /** `url_rejected` while Slack's 404/410 keeps it paused; null for manual pauses. */
  pauseReason: string | null
}
const invalid = () =>
  new DomainError('invalid', 'invalid_slack_destination', 'Invalid Slack destination configuration')
const missing = () => new DomainError('not_found', 'slack_destination_not_found')
const columns = [
  'id',
  'organization_id',
  'url',
  'events',
  'event_type_id',
  'is_active',
  'pause_reason',
  'created_at',
  'updated_at',
] as const
function view(row: {
  id: string
  organization_id: string
  url: string
  events: string[]
  event_type_id: string | null
  is_active: boolean
  pause_reason: string | null
  created_at: Date
  updated_at: Date
}): SlackDestinationView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    events: row.events,
    eventTypeId: row.event_type_id,
    isActive: row.is_active,
    pauseReason: row.pause_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}
function key(settings: WebhookSettings) {
  if (!settings.encryptionKey)
    throw new DomainError(
      'conflict',
      'slack_unavailable',
      'Slack requires a configured webhook encryption key',
    )
  return settings.encryptionKey
}
async function authorize(trx: Db, ctx: WebhookServiceContext, deferFinal = false) {
  await ctx.prepareOrganizationWrite?.(trx)
  // API keys, MCP OAuth and CLI have no session context check: refuse non-admins before
  // they take or wait for any organization or destination lock.
  if (ctx.principal.kind !== 'session' || !ctx.authorizeOrganizationWrite)
    await requireAdmin(trx, ctx)
  // Only creation needs to serialize the organization-wide destination limit.
  await lockAuthorizationParents(trx, ctx, !deferFinal)
  if (!deferFinal) {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)
    await requireAdmin(trx, ctx, true)
  }
}
async function filter(trx: Db, ctx: ServiceContext, id: string | null | undefined) {
  if (!id) return
  const found = await trx
    .selectFrom('event_types')
    .select('id')
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('deleted_at', 'is', null)
    .forKeyShare()
    .executeTakeFirst()
  if (!found) throw invalid()
}
async function locked(trx: Db, ctx: WebhookServiceContext, id: unknown) {
  await authorize(trx, ctx, true)
  if (!z.uuid().safeParse(id).success) throw missing()
  const row = await trx
    .selectFrom('webhooks')
    .select(columns)
    .where('destination_kind', '=', 'slack')
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('id', '=', id as string)
    .forUpdate()
    .executeTakeFirst()
  // A demotion or removal committed while this call waited for the destination must win.
  await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)
  await requireAdmin(trx, ctx, true)
  if (!row) throw missing()
  return row
}
export async function listSlackDestinations(ctx: ServiceContext) {
  await requireAdmin(ctx.db, ctx)
  return (
    await ctx.db
      .selectFrom('webhooks')
      .select(columns)
      .where('destination_kind', '=', 'slack')
      .where('organization_id', '=', ctx.principal.organization.id)
      .orderBy('id')
      .execute()
  ).map(view)
}
export async function createSlackDestination(
  ctx: WebhookServiceContext,
  settings: WebhookSettings,
  input: unknown,
) {
  const parsed = SlackCreateInput.safeParse(input)
  if (!parsed.success) throw invalid()
  const url = slackUrl(parsed.data.url)
  if (!url) throw invalid()
  const encryptionKey = key(settings)
  return ctx.db.transaction().execute(async (trx) => {
    await authorize(trx, ctx)
    await filter(trx, ctx, parsed.data.eventTypeId)
    if (
      await trx
        .selectFrom('webhooks')
        .select('id')
        .where('organization_id', '=', ctx.principal.organization.id)
        .where('destination_kind', '=', 'slack')
        .executeTakeFirst()
    )
      throw new DomainError(
        'conflict',
        'slack_destination_exists',
        'Only one Slack destination per organization',
      )
    const id = randomUUID()
    const ciphertext = encryptWebhookSecret(
      url,
      encryptionKey,
      `${id}:url`,
      ctx.principal.organization.id,
    )
    return view(
      await trx
        .insertInto('webhooks')
        .values({
          id,
          organization_id: ctx.principal.organization.id,
          destination_kind: 'slack',
          url: `https://${new URL(url).hostname}/services/••••`,
          url_ciphertext: ciphertext,
          secret_ciphertext: Buffer.alloc(0),
          events: [...parsed.data.events].sort(),
          event_type_id: parsed.data.eventTypeId ?? null,
          is_active: parsed.data.isActive ?? true,
        })
        .returning(columns)
        .executeTakeFirstOrThrow(),
    )
  })
}
export async function updateSlackDestination(
  ctx: WebhookServiceContext,
  id: unknown,
  input: unknown,
  settings: WebhookSettings,
) {
  const parsed = SlackUpdateInput.safeParse(input)
  if (!parsed.success) throw invalid()
  const data = parsed.data
  const url = data.url === undefined ? undefined : slackUrl(data.url)
  if (data.url !== undefined && !url) throw invalid()
  return ctx.db.transaction().execute(async (trx) => {
    const row = await locked(trx, ctx, id)
    await filter(trx, ctx, data.eventTypeId)
    return view(
      await trx
        .updateTable('webhooks')
        .set({
          ...(url && {
            url: `https://${new URL(url).hostname}/services/••••`,
            url_ciphertext: encryptWebhookSecret(
              url,
              key(settings),
              `${row.id}:url`,
              row.organization_id,
            ),
          }),
          ...(data.events && { events: [...data.events].sort() }),
          ...(data.eventTypeId !== undefined && { event_type_id: data.eventTypeId }),
          ...(data.isActive !== undefined && { is_active: data.isActive }),
          // A replacement URL or an explicit enable resolves an automatic 404/410 pause.
          ...((url || data.isActive) && { pause_reason: null }),
          updated_at: new Date(ctx.now().epochMilliseconds),
        })
        .where('id', '=', row.id)
        .returning(columns)
        .executeTakeFirstOrThrow(),
    )
  })
}
export async function deleteSlackDestination(ctx: WebhookServiceContext, id: unknown) {
  await ctx.db.transaction().execute(async (trx) => {
    const row = await locked(trx, ctx, id)
    await trx.deleteFrom('webhooks').where('id', '=', row.id).execute()
  })
}
/**
 * `admit` runs only after the caller passed the final owner/admin check for an existing
 * destination, so refused or missing-destination calls never use the test budget. It may
 * throw to refuse the attempt; nothing has been written at that point.
 */
export async function testSlackDestination(
  ctx: WebhookServiceContext,
  settings: WebhookSettings,
  id: unknown,
  queue?: WebhookQueue,
  admit?: () => void,
) {
  key(settings)
  if (!settings.enabled || !queue)
    throw new DomainError('conflict', 'slack_unavailable', 'Slack delivery is unavailable')
  return ctx.db.transaction().execute(async (trx) => {
    const row = await locked(trx, ctx, id)
    admit?.()
    if (!row.is_active)
      throw new DomainError(
        'conflict',
        'slack_destination_disabled',
        'Enable the Slack destination before testing',
      )
    // The destination lock serializes samples across processes, including retries.
    if (
      await trx
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', row.id)
        .where('booking_id', 'is', null)
        .where('status', '=', 'pending')
        .executeTakeFirst()
    )
      throw new DomainError(
        'conflict',
        'slack_test_pending',
        'A Slack test message is already pending for this destination',
      )
    const eventType = row.events[0] as string
    const eventId = randomUUID()
    const delivery = await trx
      .insertInto('webhook_deliveries')
      .values({
        webhook_id: row.id,
        organization_id: row.organization_id,
        booking_id: null,
        event_id: eventId,
        // Deliveries are unique on (webhook_id, booking_id, event_type, request_id) with
        // NULLS NOT DISTINCT (migration 0064). A sample has no booking, so its own event ID
        // is the discriminator that lets a new test follow a finished one. On rows with a
        // null booking_id, request_id is this sample marker, never a reschedule-request ID.
        request_id: eventId,
        event_type: eventType,
        payload: slackPayload({ type: eventType }),
        created_at: new Date(ctx.now().epochMilliseconds),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await queue.enqueue(
      WEBHOOK_DELIVERY_JOB,
      { deliveryId: delivery.id },
      { transaction: trx, singletonKey: delivery.id },
    )
    return { deliveryId: delivery.id }
  })
}
