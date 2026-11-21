import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  PreviewWorkflowInputSchema,
  previewWorkflow,
  requireWorkflowsEnabled,
  requireWorkflowUpdateAllowed,
  updateWorkflow,
  type WorkflowSettings,
} from '@hourmere/workflows'
import {
  CreateWorkflowInput,
  DeleteWorkflowInput,
  ListWorkflowRunsInput,
  ListWorkflowsInput,
  UpdateWorkflowInput,
  WORKFLOW_PREVIEW_DESCRIPTION,
  WORKFLOWS_AVAILABILITY,
  Workflow,
  WorkflowPage,
  WorkflowPreview,
  WorkflowRunHistoryPage,
} from '../routes/workflows.ts'
import { workflowFeatureTools } from '../workflows.ts'
import { defineTool, type Tool } from './tools.ts'

/**
 * The booking workflow operations, with REST's validation and authorization. Always in the
 * catalog. While workflows are off, tools/list omits them. Direct calls run the scope and
 * availability checks before reaching the services.
 */
export function workflowTools({
  db,
  followUpHostNotesEnabled,
  workflowRunCursorSecret,
  workflowsEnabled,
}: {
  db: Db
  followUpHostNotesEnabled?: boolean | undefined
  workflowRunCursorSecret?: string | undefined
} & WorkflowSettings): Tool[] {
  const settings = { workflowsEnabled }
  const requireAvailable = () => requireWorkflowsEnabled(settings)
  const writeContext = (principal: Principal) => ({
    db,
    followUpHostNotesEnabled,
    principal,
    ...settings,
  })
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const tools = [
    defineTool({
      name: 'create_workflow',
      title: 'Create a booking workflow',
      description: `${WORKFLOWS_AVAILABILITY} Requires full API-key scope. Creates a personal workflow for yourself or a team workflow as its current owner/admin in that team context. Supply owner, idempotencyKey and the definition fields. Keep the key for retries: identical normalized input returns the stored definition; changed input conflicts. IDs are server-generated. Unknown fields are rejected. Webhook actions require an active endpoint in the acting organization subscribed to workflow.executed. No email is sent by creation.`,
      input: CreateWorkflowInput,
      output: Workflow,
      requireAvailable,
      annotations: { ...annotations, readOnlyHint: false },
      run(args, call) {
        return createWorkflow(writeContext(call.caller), args)
      },
    }),
    defineTool({
      name: 'update_workflow',
      title: 'Edit, enable or disable a booking workflow',
      description: `${WORKFLOWS_AVAILABILITY} Requires full API-key scope. Supply id, expectedRevision and changed definition fields. Content edits append an immutable revision; enabled-only changes preserve the revision. A stale revision conflicts. Missing, foreign and mismatched owner contexts return workflow_not_found. Existing booking enrollments and execution rows stay unchanged. Webhook actions require an active endpoint in the acting organization subscribed to workflow.executed.`,
      input: UpdateWorkflowInput.extend({ id: z.string() }),
      output: Workflow,
      requireAvailable(input) {
        const { id: _id, ...patch } = (input ?? {}) as Record<string, unknown>
        requireWorkflowUpdateAllowed(settings, patch)
      },
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
      run({ id, ...args }, call) {
        return updateWorkflow(writeContext(call.caller), id, args)
      },
    }),
    defineTool({
      name: 'delete_workflow',
      title: 'Delete a booking workflow',
      description: `${WORKFLOWS_AVAILABILITY} Requires full API-key scope. Supply id and expectedRevision. Tombstones the definition and retires pending runs; authorized repeats are safe. Missing, foreign and mismatched owner contexts return workflow_not_found. Revisions and creation keys remain with the tombstone; minimal history follows retention.`,
      input: DeleteWorkflowInput.extend({ id: z.string() }),
      output: z.object({ deleted: z.literal(true) }),
      annotations: { ...annotations, readOnlyHint: false, destructiveHint: true },
      async run({ id, ...args }, call) {
        await deleteWorkflow({ db, principal: call.caller }, id, args)
        return { deleted: true as const }
      },
    }),
    defineTool({
      name: 'preview_workflow',
      title: 'Preview a booking workflow with synthetic data',
      description: WORKFLOW_PREVIEW_DESCRIPTION,
      input: PreviewWorkflowInputSchema,
      output: WorkflowPreview,
      requireAvailable,
      annotations,
      run(args, call) {
        return previewWorkflow(writeContext(call.caller), args)
      },
    }),
    defineTool({
      name: 'list_workflows',
      title: 'List booking workflows',
      description: `${WORKFLOWS_AVAILABILITY} Lists the workflows of the owner you act as, oldest first. Requires read or full API key scope. owner is {kind: "personal", id: your user ID} in your personal organization, or {kind: "team", id: the team ID} while acting in that team as a current owner or admin; any other owner gets insufficient_role. Pass nextCursor as cursor with the same owner for the next page.`,
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
      description: `${WORKFLOWS_AVAILABILITY} Reads one workflow of the owner you act as: its current revision, enabled flag, scope, trigger, conditions and action. Requires read or full API key scope. Another owner's or organization's workflow gets the same workflow_not_found as a missing one.`,
      // Any string, as in the REST path: a malformed ID is not found, like an unknown one.
      input: z.strictObject({ id: z.string().openapi({ description: 'The workflow ID' }) }),
      output: Workflow,
      annotations,
      run(args, call) {
        return getWorkflow({ db, principal: call.caller }, args.id)
      },
    }),
    defineTool({
      name: 'list_workflow_runs',
      title: 'List booking workflow runs',
      description: `${WORKFLOWS_AVAILABILITY} Lists retained terminal runs of a workflow you own or administer in the current organization. Requires read or full API key scope. Returns timestamps in UTC and fixed outcomes and counts, with no booking IDs or private booking details. Pass nextCursor as cursor with the same workflow ID for the next page.`,
      input: ListWorkflowRunsInput,
      output: WorkflowRunHistoryPage,
      annotations,
      run({ id, ...args }, call) {
        return listWorkflowRuns({ db, principal: call.caller, workflowRunCursorSecret }, id, args)
      },
    }),
  ]
  return workflowFeatureTools(tools, settings)
}
