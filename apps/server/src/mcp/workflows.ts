import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  PreviewWorkflowInputSchema,
  previewWorkflow,
  updateWorkflow,
  type WorkflowAuditPort,
} from '@hourmere/workflows'
import {
  CreateWorkflowInput,
  DeleteWorkflowInput,
  ListWorkflowsInput,
  UpdateWorkflowInput,
  WORKFLOW_PREVIEW_DESCRIPTION,
  WORKFLOWS_NOT_AVAILABLE,
  Workflow,
  WorkflowPage,
  WorkflowPreview,
} from '../routes/workflows.ts'
import { workflowFeatureTools } from '../workflows.ts'
import { defineTool, type Tool } from './tools.ts'

/**
 * The booking workflow operations, with REST's validation and authorization. Always in the
 * catalog: while workflows are off, tools/list omits them and a direct call answers
 * `workflows_disabled` after the scope check (workflowFeatureTools).
 */
export function workflowTools({
  db,
  audit,
  followUpHostNotesEnabled,
}: {
  db: Db
  audit?: WorkflowAuditPort
  followUpHostNotesEnabled?: boolean | undefined
}): Tool[] {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  return workflowFeatureTools([
    defineTool({
      name: 'create_workflow',
      title: 'Create a booking workflow',
      description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope. Creates a personal workflow for yourself or a team workflow as its current owner/admin in that team context. Supply owner, idempotencyKey and the definition fields. Keep the key for retries: identical normalized input returns the stored definition; changed input conflicts. IDs are server-generated. Unknown fields and webhook actions are rejected. No email is sent by creation.`,
      input: CreateWorkflowInput,
      output: Workflow,
      annotations: { ...annotations, readOnlyHint: false },
      run(args, call) {
        return createWorkflow({ db, audit, followUpHostNotesEnabled, principal: call.caller }, args)
      },
    }),
    defineTool({
      name: 'update_workflow',
      title: 'Edit, enable or disable a booking workflow',
      description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope. Supply id, expectedRevision and changed definition fields. Content edits append an immutable revision; enabled-only changes preserve the revision. A stale revision conflicts. Missing, foreign and mismatched owner contexts return workflow_not_found. Existing booking enrollments and execution rows stay unchanged. Webhook actions are rejected.`,
      input: UpdateWorkflowInput.extend({ id: z.string() }),
      output: Workflow,
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
      run({ id, ...args }, call) {
        return updateWorkflow(
          { db, audit, followUpHostNotesEnabled, principal: call.caller },
          id,
          args,
        )
      },
    }),
    defineTool({
      name: 'delete_workflow',
      title: 'Delete a booking workflow',
      description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope. Supply id and expectedRevision. Tombstones the definition and retires pending runs; authorized repeats are safe. Missing, foreign and mismatched owner contexts return workflow_not_found. Revisions and creation keys remain with the tombstone; minimal history follows retention.`,
      input: DeleteWorkflowInput.extend({ id: z.string() }),
      output: z.object({ deleted: z.literal(true) }),
      annotations: { ...annotations, readOnlyHint: false, destructiveHint: true },
      async run({ id, ...args }, call) {
        await deleteWorkflow({ db, audit, principal: call.caller }, id, args)
        return { deleted: true as const }
      },
    }),
    defineTool({
      name: 'preview_workflow',
      title: 'Preview a booking workflow with synthetic data',
      description: WORKFLOW_PREVIEW_DESCRIPTION,
      input: PreviewWorkflowInputSchema,
      output: WorkflowPreview,
      annotations,
      run(args, call) {
        return previewWorkflow(
          { db, audit, followUpHostNotesEnabled, principal: call.caller },
          args,
        )
      },
    }),
    defineTool({
      name: 'list_workflows',
      title: 'List booking workflows',
      description: `${WORKFLOWS_NOT_AVAILABLE} Lists the workflows of the owner you act as, oldest first. Requires read or full API key scope. owner is {kind: "personal", id: your user ID} in your personal organization, or {kind: "team", id: the team ID} while acting in that team as a current owner or admin; any other owner gets insufficient_role. Pass nextCursor as cursor with the same owner for the next page.`,
      input: ListWorkflowsInput,
      output: WorkflowPage,
      annotations,
      run(args, call) {
        return listWorkflows({ db, principal: call.caller }, args)
      },
    }),
    defineTool({
      name: 'get_workflow',
      title: 'Get a booking workflow',
      description: `${WORKFLOWS_NOT_AVAILABLE} Reads one workflow of the owner you act as: its current revision, enabled flag, scope, trigger, conditions and action. Requires read or full API key scope. Another owner's or organization's workflow gets the same workflow_not_found as a missing one.`,
      // Any string, as in the REST path: a malformed ID is not found, like an unknown one.
      input: z.strictObject({ id: z.string().openapi({ description: 'The workflow ID' }) }),
      output: Workflow,
      annotations,
      run(args, call) {
        return getWorkflow({ db, principal: call.caller }, args.id)
      },
    }),
  ])
}
