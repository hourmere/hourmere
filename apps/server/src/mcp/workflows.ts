import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { getWorkflow, listWorkflows } from '@hourmere/workflows'
import {
  ListWorkflowsInput,
  WORKFLOWS_NOT_AVAILABLE,
  Workflow,
  WorkflowPage,
} from '../routes/workflows.ts'
import { workflowFeatureTools } from '../workflows.ts'
import { defineTool, type Tool } from './tools.ts'

/**
 * The booking workflow reads, with REST's validation and authorization. Always in the
 * catalog: while workflows are off, tools/list omits them and a direct call answers
 * `workflows_disabled` after the scope check (workflowFeatureTools).
 */
export function workflowTools({ db }: { db: Db }): Tool[] {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  return workflowFeatureTools([
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
      input: z.strictObject({ id: z.uuid().openapi({ description: 'The workflow ID' }) }),
      output: Workflow,
      annotations,
      run(args, call) {
        return getWorkflow({ db, principal: call.caller }, args.id)
      },
    }),
  ])
}
