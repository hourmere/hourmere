import { ApiKeyScopeError } from '@hourmere/auth'
import { validateTimeZone } from '@hourmere/core'
import { LOCATION_KINDS, MAX_ANSWER_LENGTH, MAX_GUESTS, MAX_QUESTIONS } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { z } from 'zod'
import { type WorkflowCreateContext, writableOwner } from './creates.ts'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionSchema,
  workflowMatches,
} from './definition.ts'
import { renderWorkflowEmail } from './email.ts'
import { workflowOperation } from './hard-off.ts'
import {
  WORKFLOW_MAIL_MAX_PER_HOUR,
  WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
  WORKFLOW_RECIPIENT_EMAILS_PER_DAY,
  WORKFLOW_RECIPIENT_EMAILS_PER_HOUR,
} from './limits.ts'
import {
  scopeSelectsEventType,
  uuidSchema,
  WORKFLOW_BOOKING_SOURCES,
  WorkflowOwnerSelectorSchema,
} from './ownership.ts'
import { WORKFLOW_RECIPIENT_CLASSES } from './variables.ts'
import { loadWorkflowDefinitionFacts } from './write-definition.ts'

const Example = z.strictObject({
  eventTypeId: uuidSchema
    .optional()
    .describe('Example event type identifier used only for matching'),
  eventTitle: z.string().max(200).optional(),
  publicPath: z.string().max(512).optional(),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
  source: z.enum(WORKFLOW_BOOKING_SOURCES).optional(),
  locationKind: z.enum(LOCATION_KINDS).nullable().optional(),
  guestCount: z.number().int().min(0).max(MAX_GUESTS).optional(),
  answers: z
    .record(
      z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      z.union([z.string().max(MAX_ANSWER_LENGTH.long_text), z.boolean(), z.number(), z.null()]),
    )
    .refine((answers) => Object.keys(answers).length <= MAX_QUESTIONS, {
      error: `Must have at most ${MAX_QUESTIONS} answers`,
    })
    .optional(),
  locale: z.string().max(64).optional(),
  timeZone: z.string().max(128).optional(),
  recipientName: z.string().max(200).optional(),
})

export const PreviewWorkflowInputSchema = WorkflowDefinitionSchema.extend({
  owner: WorkflowOwnerSelectorSchema,
  example: Example.optional().describe('Synthetic values used for matching and rendering'),
})

export const WorkflowPreviewSchema = z.object({
  synthetic: z.literal(true),
  match: z.enum(['matched', 'scope_mismatch', 'condition_false']),
  emails: z.array(
    z.object({
      recipientClass: z.enum(WORKFLOW_RECIPIENT_CLASSES),
      subject: z.string(),
      text: z.string(),
      html: z.string(),
      locale: z.string(),
      templateLocale: z.string(),
      contentSource: z.enum(['custom', 'built_in']),
      fallback: z.enum(['host_text_disabled', 'missing_translation']).optional(),
    }),
  ),
  estimates: z.object({
    emailRecipientClasses: z.number().int(),
    webhookDeliveriesPerMatch: z.number().int(),
    mailLimits: z
      .object({
        defaultInstancePerHour: z.number().int().describe('Published default workflow mail cap'),
        defaultOwnerPerHour: z.number().int().describe('Published default per-owner mail cap'),
        recipientPerHour: z.number().int(),
        recipientPerDay: z.number().int(),
      })
      .optional(),
  }),
})

const exampleNames = {
  booker: 'Example Booker',
  guests: 'Example Guest',
  hosts: 'Example Host',
}
const invalid = (message: string) => new DomainError('invalid', 'invalid_workflow', message)

/** Authorize and validate the candidate using live configuration, then render only fixture data. */
export async function previewWorkflowCandidate(
  ctx: Omit<WorkflowCreateContext, 'audit'>,
  input: unknown,
): Promise<z.output<typeof WorkflowPreviewSchema>> {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')
    throw new ApiKeyScopeError()
  const parsed = PreviewWorkflowInputSchema.safeParse(input)
  if (!parsed.success) throw invalid('Invalid workflow preview')
  const { owner: selector, example = {}, ...candidate } = parsed.data
  const { db, followUpHostNotesEnabled } = ctx
  const { definition, facts } = await db.transaction().execute(async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    const owner = await writableOwner(trx, ctx, selector)
    const facts = await loadWorkflowDefinitionFacts(trx, candidate, owner, followUpHostNotesEnabled)
    return { definition: validateWorkflowDefinition(candidate, facts), facts }
  })

  let start: Temporal.Instant
  let end: Temporal.Instant
  try {
    start = Temporal.Instant.from(example.start ?? '2030-01-15T15:00:00Z')
    end = example.end ? Temporal.Instant.from(example.end) : start.add({ minutes: 30 })
  } catch {
    throw invalid('Example dates must be valid instants')
  }
  if (Temporal.Instant.compare(start, end) >= 0) throw invalid('Example end must follow start')
  let timeZone: string
  try {
    timeZone = validateTimeZone(example.timeZone ?? 'UTC')
  } catch {
    throw invalid('Example time zone must be an IANA time zone')
  }

  const { owner } = facts
  const scopedEventType =
    definition.scope.type === 'event_type'
      ? facts.eventTypes.get(definition.scope.eventTypeId)
      : undefined
  const event = {
    id:
      example.eventTypeId ??
      scopedEventType?.id ??
      definition.conditions.find((condition) => condition.field === 'event_type')?.value ??
      '00000000-0000-4000-8000-000000000001',
    organizationId: owner.organizationId,
    ownerUserId: owner.kind === 'personal' ? owner.userId : null,
    bookingMode: 'individual',
    deleted: false,
    questions: [],
  }
  const booking = {
    eventTypeId: event.id,
    source: example.source ?? 'web',
    imported: false,
    groupSeat: false,
    responses: example.answers ?? {},
    locationKind: example.locationKind ?? null,
    guestCount: example.guestCount ?? 0,
  }
  const match = workflowMatches(owner, definition, event, booking)
    ? 'matched'
    : scopeSelectsEventType(owner, definition.scope, event)
      ? 'condition_false'
      : 'scope_mismatch'
  const emails = definition.actions.flatMap((action) =>
    action.type === 'email'
      ? action.recipients.map((recipientClass) => ({
          recipientClass,
          ...renderWorkflowEmail({
            action,
            trigger: definition.trigger.type,
            context: { owner: owner.kind, eventType: scopedEventType },
            ...(followUpHostNotesEnabled !== undefined && { followUpHostNotesEnabled }),
            recipient: {
              name: example.recipientName ?? exampleNames[recipientClass],
              timeZone,
              locale: example.locale ?? 'en',
            },
            eventType: {
              title: example.eventTitle ?? 'Example Consultation',
              publicPath: example.publicPath ?? '/example/consultation',
            },
            booking: { start, end },
            answers: booking.responses,
          }),
        }))
      : [],
  )
  return {
    synthetic: true,
    match,
    emails,
    estimates: {
      emailRecipientClasses: emails.length,
      webhookDeliveriesPerMatch: definition.actions.filter((action) => action.type === 'webhook')
        .length,
      ...(emails.length > 0 && {
        mailLimits: {
          defaultInstancePerHour: WORKFLOW_MAIL_MAX_PER_HOUR,
          defaultOwnerPerHour: WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
          recipientPerHour: WORKFLOW_RECIPIENT_EMAILS_PER_HOUR,
          recipientPerDay: WORKFLOW_RECIPIENT_EMAILS_PER_DAY,
        },
      }),
    },
  }
}

export const previewWorkflow = workflowOperation(previewWorkflowCandidate)
