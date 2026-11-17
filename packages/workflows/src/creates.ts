// Creation is guarded at the public entry point; tests inject dependencies into the internal
// service. Keys retain the initial request fingerprint and return the current representation.
import { createHash } from 'node:crypto'
import { ApiKeyScopeError, type Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { lockWorkflowOwner, parseQuestions } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { hardOffWorkflowAuditPort, type WorkflowAuditPort } from './audit.ts'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionSchema,
  workflowReferences,
} from './definition.ts'
import { workflowOperation } from './hard-off.ts'
import { WORKFLOW_MAX_DEFINITIONS_PER_OWNER, WORKFLOW_MAX_ENABLED_PER_EVENT } from './limits.ts'
import { type WorkflowOwner, WorkflowOwnerSelectorSchema } from './ownership.ts'
import { type WorkflowView, workflowView } from './reads.ts'

export const CreateWorkflowInputSchema = WorkflowDefinitionSchema.extend({
  owner: WorkflowOwnerSelectorSchema,
  idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,255}$/),
})
export type CreateWorkflowInput = z.input<typeof CreateWorkflowInputSchema>
export interface WorkflowCreateContext {
  db: Db
  principal: Principal
  audit?: WorkflowAuditPort | undefined
  prepareOrganizationWrite?: ((trx: Db) => Promise<void>) | undefined
  authorizeOrganizationWrite?: ((trx: Db, organizationId: string) => Promise<void>) | undefined
}
const notFound = () => new DomainError('not_found', 'workflow_not_found', 'No such workflow')
const invalid = () => new DomainError('invalid', 'invalid_workflow', 'Invalid workflow definition')
const limitReached = () => new DomainError('conflict', 'workflow_limit_reached')

/** Stable object-key order, with the request's documented normalization independent of facts. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  return value
}
function fingerprint(input: z.output<typeof CreateWorkflowInputSchema>): Buffer {
  const { idempotencyKey: _, ...request } = input
  const normalized = {
    ...request,
    name: request.name.trim(),
    actions: request.actions.map((action) => {
      if (action.type !== 'email') return action
      return {
        ...action,
        recipients: [...action.recipients].sort(),
        ...(action.content
          ? {
              content: Object.fromEntries(
                Object.entries(action.content).map(([locale, entry]) => [
                  locale,
                  entry
                    ? {
                        subject: entry.subject.trim(),
                        body: entry.body.replace(/\r\n?/g, '\n').trim(),
                      }
                    : entry,
                ]),
              ),
            }
          : {}),
      }
    }),
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(normalized)))
    .digest()
}

/** Parent/owner locks precede membership and definition rows, with a late role recheck. */
export async function writableOwner(
  trx: Db,
  ctx: WorkflowCreateContext,
  selector: CreateWorkflowInput['owner'],
): Promise<WorkflowOwner> {
  const actor = await trx
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', ctx.principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!actor?.emailVerified) throw notFound()
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', ctx.principal.organization.id)
    .forKeyShare()
    .executeTakeFirst()
  if (!organization) throw notFound()
  const personal = await trx
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', organization.id)
    .executeTakeFirst()
  const owner: WorkflowOwner = personal
    ? { kind: 'personal', userId: personal.user_id, organizationId: organization.id }
    : { kind: 'team', organizationId: organization.id }
  if (
    selector.kind !== owner.kind ||
    selector.id !== (owner.kind === 'personal' ? owner.userId : owner.organizationId) ||
    (owner.kind === 'personal' && owner.userId !== ctx.principal.user.id)
  )
    throw notFound()
  await lockWorkflowOwner(
    trx,
    owner.organizationId,
    owner.kind === 'personal' ? owner.userId : null,
  )
  await ctx.authorizeOrganizationWrite?.(trx, organization.id)
  const member = await trx
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', organization.id)
    .where('userId', '=', ctx.principal.user.id)
    .forShare()
    .executeTakeFirst()
  const roles = member?.role.split(',').map((role) => role.trim()) ?? []
  if (!member || (owner.kind === 'team' && !roles.includes('owner') && !roles.includes('admin')))
    throw notFound()
  return owner
}

export async function createWorkflowDefinition(
  ctx: WorkflowCreateContext,
  input: unknown,
): Promise<WorkflowView> {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')
    throw new ApiKeyScopeError()
  const parsed = CreateWorkflowInputSchema.safeParse(input)
  if (!parsed.success) throw invalid()
  const request = parsed.data
  const digest = fingerprint(request)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    const owner = await writableOwner(trx, ctx, request.owner)
    const credential =
      ctx.principal.kind === 'api_key'
        ? ctx.principal.apiKeyId
        : ctx.principal.kind === 'oauth'
          ? ctx.principal.oauthConsentId
          : null
    const key = await trx
      .selectFrom('workflow_creation_keys')
      .select(['workflow_id', 'request_fingerprint'])
      .where('organization_id', '=', owner.organizationId)
      .where('actor_user_id', '=', ctx.principal.user.id)
      .where('credential_kind', '=', ctx.principal.kind)
      .where('credential_id', credential === null ? 'is' : '=', credential)
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirst()
    if (key) {
      if (!key.request_fingerprint.equals(digest))
        throw new DomainError('conflict', 'idempotency_key_reused')
      const row = await trx
        .selectFrom('workflow_definitions as d')
        .innerJoin('workflow_revisions as r', (join) =>
          join
            .onRef('r.workflow_id', '=', 'd.id')
            .onRef('r.revision', '=', 'd.revision')
            .onRef('r.organization_id', '=', 'd.organization_id'),
        )
        .select(['d.id', 'd.revision', 'd.enabled', 'd.created_at', 'd.updated_at', 'r.definition'])
        .where('d.id', '=', key.workflow_id)
        .executeTakeFirstOrThrow()
      return workflowView(owner, row)
    }
    const { owner: _, idempotencyKey: __, ...candidate } = request
    if (candidate.actions.some((action) => action.type === 'webhook')) throw invalid()
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
    const definition = validateWorkflowDefinition(candidate, {
      owner,
      webhooks: new Map(),
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
    })
    const existing = await trx
      .selectFrom('workflow_definitions as d')
      .innerJoin('workflow_revisions as r', (join) =>
        join.onRef('r.workflow_id', '=', 'd.id').onRef('r.revision', '=', 'd.revision'),
      )
      .select(['d.enabled', 'r.definition'])
      .where('d.organization_id', '=', owner.organizationId)
      .where(
        'd.owner_user_id',
        owner.kind === 'personal' ? '=' : 'is',
        owner.kind === 'personal' ? owner.userId : null,
      )
      .where('d.deleted_at', 'is', null)
      .execute()
    if (existing.length >= WORKFLOW_MAX_DEFINITIONS_PER_OWNER) throw limitReached()
    if (definition.enabled) {
      const scopes = existing
        .filter((row) => row.enabled)
        .map(
          (row) =>
            WorkflowDefinitionSchema.parse({ ...(row.definition as object), enabled: true }).scope,
        )
      const all = scopes.filter((scope) => scope.type === 'all_event_types').length
      const perEvent = new Map<string, number>()
      for (const scope of scopes)
        if (scope.type === 'event_type')
          perEvent.set(scope.eventTypeId, (perEvent.get(scope.eventTypeId) ?? 0) + 1)
      const count =
        definition.scope.type === 'event_type'
          ? all + (perEvent.get(definition.scope.eventTypeId) ?? 0)
          : all + Math.max(0, ...perEvent.values())
      if (count >= WORKFLOW_MAX_ENABLED_PER_EVENT) throw limitReached()
    }
    const row = await trx
      .insertInto('workflow_definitions')
      .values({
        organization_id: owner.organizationId,
        owner_user_id: owner.kind === 'personal' ? owner.userId : null,
        enabled: definition.enabled,
      })
      .returning(['id', 'revision', 'enabled', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()
    const { enabled: ___, ...revision } = definition
    await trx
      .insertInto('workflow_revisions')
      .values({
        organization_id: owner.organizationId,
        workflow_id: row.id,
        revision: 1,
        definition: sql`${JSON.stringify(revision)}::jsonb`,
      })
      .execute()
    await trx
      .insertInto('workflow_creation_keys')
      .values({
        organization_id: owner.organizationId,
        workflow_id: row.id,
        actor_user_id: ctx.principal.user.id,
        credential_kind: ctx.principal.kind,
        credential_id: credential,
        idempotency_key: request.idempotencyKey,
        request_fingerprint: digest,
      })
      .execute()
    const actor = ctx.principal
    await (ctx.audit ?? hardOffWorkflowAuditPort()).record(trx, {
      event: 'workflow.created',
      occurredAt: Temporal.Now.instant(),
      owner,
      workflowId: row.id,
      revision: 1,
      trigger: definition.trigger.type,
      actor:
        actor.kind === 'api_key'
          ? { kind: actor.kind, userId: actor.user.id, apiKeyId: actor.apiKeyId }
          : actor.kind === 'oauth'
            ? { kind: actor.kind, userId: actor.user.id, clientId: actor.clientId }
            : { kind: actor.kind, userId: actor.user.id },
    })
    return workflowView(owner, { ...row, definition: revision })
  })
}
export const createWorkflow = workflowOperation(createWorkflowDefinition)
