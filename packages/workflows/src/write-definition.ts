import type { Db } from '@hourmere/db'
import { parseQuestions } from '@hourmere/scheduling'
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowValidationContext,
  workflowReferences,
} from './definition.ts'
import type { WorkflowOwner } from './ownership.ts'

/** Load and lock the live references a definition's acceptance depends on. */
export async function validateWorkflowWriteDefinition(
  trx: Db,
  candidate: WorkflowDefinition,
  owner: WorkflowOwner,
  followUpHostNotesEnabled: boolean | undefined,
): Promise<WorkflowDefinition> {
  return validateWorkflowDefinition(
    candidate,
    await loadWorkflowDefinitionFacts(trx, candidate, owner, followUpHostNotesEnabled),
  )
}

/** Load only the configuration metadata referenced by the candidate. */
export async function loadWorkflowDefinitionFacts(
  trx: Db,
  candidate: WorkflowDefinition,
  owner: WorkflowOwner,
  followUpHostNotesEnabled: boolean | undefined,
): Promise<WorkflowValidationContext> {
  const refs = workflowReferences(candidate)
  const events = refs.eventTypeIds.length
    ? await trx
        .selectFrom('event_types')
        .select([
          'id',
          'organization_id',
          'owner_user_id',
          'booking_mode',
          'deleted_at',
          'questions',
        ])
        .where('id', 'in', refs.eventTypeIds)
        .forShare()
        .execute()
    : []
  const endpoints = refs.webhookIds.length
    ? await trx
        .selectFrom('webhooks')
        .select(['id', 'organization_id', 'is_active', 'events'])
        .where('id', 'in', refs.webhookIds)
        .where('organization_id', '=', owner.organizationId)
        .where('destination_kind', '=', 'webhook')
        .forShare()
        .execute()
    : []
  return {
    owner,
    followUpHostNotesEnabled,
    webhooks: new Map(
      endpoints.map((endpoint) => [
        endpoint.id,
        {
          id: endpoint.id,
          organizationId: endpoint.organization_id,
          isActive: endpoint.is_active,
          events: endpoint.events,
        },
      ]),
    ),
    eventTypes: new Map(
      events.map((event) => [
        event.id,
        {
          id: event.id,
          organizationId: event.organization_id,
          ownerUserId: event.owner_user_id,
          bookingMode: event.booking_mode,
          deleted: event.deleted_at !== null,
          questions: parseQuestions(event.questions),
        },
      ]),
    ),
  }
}
