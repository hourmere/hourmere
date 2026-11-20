import {
  checkSlotRange,
  eventSlots,
  findOneTimeEventType,
  type PublicEventType,
  type SlotView,
  toInstant,
} from './availability.ts'
import { MAX_NAME } from './bookings.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { publicLocationOptions } from './location-options.ts'
import { InvalidStoredQuestionsError } from './questions.ts'
import {
  loadRoutingTargetEvents,
  routingMappingProblem,
  routingTargetProblem,
} from './routing-form-targets.ts'
import {
  isRoutingReceiptToken,
  routingReceiptCheckedAt,
  validateRoutingReceiptSnapshot,
} from './routing-receipt.ts'
import { openRoutingAnswers, routingTokenDigest } from './routing-receipt-crypto.ts'
import { cleanText } from './text.ts'

export interface RoutingContinuationContext extends PublicContext {
  routingFormsEnabled?: boolean | undefined
  routingSecret?: string | undefined
  /** Fixture clock. Production validates expiry against the same database clock as issuance. */
  receiptNow?: (() => Temporal.Instant) | undefined
}

export type RoutingContinuationEventType = Pick<
  PublicEventType,
  | 'title'
  | 'description'
  | 'durationMinutes'
  | 'allowedDurationsMinutes'
  | 'location'
  | 'locations'
  | 'questions'
  | 'allowGuests'
  | 'smsRemindersEnabled'
> & { host?: PublicEventType['host'] }

interface RoutingContinuationPrefill {
  inviteeName?: string
  inviteeEmail?: string
  responses: Record<string, string>
}

const unavailable = () => new DomainError('conflict', 'routing_unavailable')

function requireContinuationSecret(ctx: RoutingContinuationContext): string {
  if (ctx.routingFormsEnabled !== true) throw new DomainError('not_found', 'routing_forms_disabled')
  if (!ctx.routingSecret) throw new Error('Routing continuations require the server secret')
  return ctx.routingSecret
}

function readOnlySnapshot(ctx: RoutingContinuationContext) {
  return ctx.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only')
}

async function readContinuation(
  ctx: RoutingContinuationContext,
  secret: string,
  routeToken: string,
) {
  if (!isRoutingReceiptToken(routeToken)) throw unavailable()
  const checkedAt = routingReceiptCheckedAt(ctx.receiptNow)
  const receipt = await ctx.db
    .selectFrom('routing_receipts as r')
    .innerJoin('routing_forms as f', (join) =>
      join.onRef('f.id', '=', 'r.form_id').onRef('f.organization_id', '=', 'r.organization_id'),
    )
    .innerJoin('routing_form_versions as v', (join) =>
      join
        .onRef('v.id', '=', 'r.version_id')
        .onRef('v.form_id', '=', 'r.form_id')
        .onRef('v.organization_id', '=', 'r.organization_id'),
    )
    .select([
      'r.id as receiptId',
      'r.organization_id as organizationId',
      'r.form_id as formId',
      'r.version_id as versionId',
      'r.resolved_target as resolvedTarget',
      'r.answers_ciphertext as ciphertext',
      'r.expires_at as expiresAt',
      'v.questions',
    ])
    .where('r.token_hash', '=', routingTokenDigest(secret, 'continuation', routeToken))
    .where('r.consumed_booking_id', 'is', null)
    .where('r.expires_at', '>', checkedAt)
    .where('f.archived_at', 'is', null)
    .where('f.enabled', '=', true)
    .executeTakeFirst()
  if (!receipt) throw unavailable()

  const decrypted = openRoutingAnswers(secret, 'continuation', receipt, receipt.ciphertext)
  if (decrypted === undefined) throw unavailable()
  const { sources, target, answers } = validateRoutingReceiptSnapshot(
    receipt.questions,
    receipt.resolvedTarget,
    decrypted,
  )

  try {
    const targets = await loadRoutingTargetEvents(ctx.db, [target.eventTypeId])
    if (routingTargetProblem(receipt.organizationId, targets.get(target.eventTypeId)))
      throw unavailable()
    // Like one-time links, resolve the event by its capability-bound ID. This also checks
    // current host eligibility and activation without relying on a reusable booking address.
    const event = await findOneTimeEventType(ctx.db, target.eventTypeId)
    if (!event) throw unavailable()
    return { event, sources, target, answers, expiresAt: toInstant(receipt.expiresAt).toString() }
  } catch (error) {
    if (error instanceof InvalidStoredQuestionsError) throw unavailable()
    throw error
  }
}

export async function resolveRoutingContinuation(
  ctx: RoutingContinuationContext,
  routeToken: string,
) {
  const secret = requireContinuationSecret(ctx)
  return readOnlySnapshot(ctx).execute(async (db) => {
    const { event, sources, target, answers, expiresAt } = await readContinuation(
      { ...ctx, db },
      secret,
      routeToken,
    )
    const sourceById = new Map(sources.map((question) => [question.id, question]))
    const prefill: RoutingContinuationPrefill = { responses: Object.create(null) }
    for (const mapping of target.mappings) {
      const source = sourceById.get(mapping.questionId)
      const answer = answers[mapping.questionId]
      if (
        !source ||
        answer === undefined ||
        routingMappingProblem(source, mapping, event.questions)
      )
        continue

      const { destination } = mapping
      switch (destination.kind) {
        case 'inviteeName': {
          const name = cleanText(answer, { max: MAX_NAME })
          if (name !== undefined) prefill.inviteeName = name
          break
        }
        case 'inviteeEmail':
          prefill.inviteeEmail = answer
          break
        case 'question': {
          const value = source.type === 'select' ? mapping.options?.[answer] : answer
          if (value !== undefined) prefill.responses[destination.questionId] = value
          break
        }
      }
    }
    const eventType: RoutingContinuationEventType = {
      title: event.title,
      description: event.description,
      durationMinutes: event.durationMinutes,
      ...(event.allowedDurationsMinutes.length > 1 && {
        allowedDurationsMinutes: [...event.allowedDurationsMinutes].sort((a, b) => a - b),
      }),
      location: event.location && { kind: event.location.kind },
      locations: publicLocationOptions(event.locations),
      questions: event.questions,
      allowGuests: event.allowGuests,
      smsRemindersEnabled: ctx.smsRemindersAvailable === true && event.smsRemindersEnabled,
      // A personal page falls back to its reusable handle when the display name is blank.
      ...(event.schedulingType === 'individual' &&
        event.hostName !== event.handle && {
          host: {
            name: event.hostName,
            timeZone: event.hostTimeZone,
            ...(event.hostImage && { image: event.hostImage }),
          },
        }),
    }
    return { eventType, prefill, expiresAt }
  })
}

export async function listRoutingContinuationSlots(
  ctx: RoutingContinuationContext,
  input: {
    routeToken: string
    start: Temporal.Instant
    end: Temporal.Instant
    durationMinutes?: number
    locationOptionId?: string
  },
): Promise<SlotView[]> {
  const secret = requireContinuationSecret(ctx)
  return readOnlySnapshot(ctx).execute(async (db) => {
    const publicContext = { ...ctx, db }
    const { routeToken, ...slotQuery } = input
    const { event } = await readContinuation(publicContext, secret, routeToken)
    checkSlotRange(slotQuery.start, slotQuery.end)
    return eventSlots(publicContext, slotQuery, event)
  })
}
