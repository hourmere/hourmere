import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  archiveRoutingForm,
  createRoutingForm,
  getRoutingForm,
  listRoutingForms,
  type ServiceContext,
  updateRoutingForm,
} from '@hourmere/scheduling'
import {
  ArchiveRoutingForm,
  CreateRoutingForm,
  ROUTING_FORMS_DISABLED,
  RoutingFormId,
  RoutingFormList,
  RoutingFormListInput,
  RoutingFormResponse,
  UpdateRoutingForm,
} from '../routes/routing-forms.ts'
import { routingFormTools } from '../routing-forms.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

export function routingFormConfigurationTools({
  db,
  routingFormsEnabled = false,
}: {
  db: Db
  routingFormsEnabled?: boolean | undefined
}): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    now: () => Temporal.Now.instant(),
  })
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const write = { ...read, readOnlyHint: false, idempotentHint: false }
  const description = `${ROUTING_FORMS_DISABLED} Only personal owners or current team owners/admins can manage forms in their credential's organization. Reads require read/full API-key scope; writes require full scope.`
  return routingFormTools(routingFormsEnabled, [
    defineTool({
      name: 'list_routing_forms',
      title: 'List routing forms',
      description: `${description} Returns newest-first summaries and current published target health. Continue with nextCursor as cursor.`,
      input: RoutingFormListInput,
      output: RoutingFormList,
      annotations: read,
      run: (args, call) => listRoutingForms(context(call.caller), args),
    }),
    defineTool({
      name: 'get_routing_form',
      title: 'Get a routing form',
      description: `${description} Returns its draft, revision and current published target health per rule and fallback.`,
      input: RoutingFormId,
      output: RoutingFormResponse,
      annotations: read,
      run: (args, call) => getRoutingForm(context(call.caller), args.id),
    }),
    defineTool({
      name: 'create_routing_form',
      title: 'Create a routing form',
      description: `${description} Retain a requestId UUID for safe retries: identical input replays the form, changed input conflicts. Creation does not publish or enable it.`,
      input: CreateRoutingForm,
      output: RoutingFormResponse,
      annotations: write,
      run: (args, call) => createRoutingForm(context(call.caller), args),
    }),
    defineTool({
      name: 'update_routing_form',
      title: 'Update a routing form',
      description: `${description} Supply the last-read expectedRevision. Draft arrays replace their previous values; stale revisions conflict. Enabling requires a published version.`,
      input: UpdateRoutingForm.extend(RoutingFormId.shape),
      output: RoutingFormResponse,
      annotations: write,
      run: ({ id, ...args }, call) => updateRoutingForm(context(call.caller), id, args),
    }),
    defineTool({
      name: 'archive_routing_form',
      title: 'Archive a routing form',
      description: `${description} Confirm the intended form and supply its expectedRevision. Disables it and removes it from active reads; retained history and slug remain.`,
      input: ArchiveRoutingForm.extend(RoutingFormId.shape),
      output: z.object({ archived: z.literal(true) }),
      annotations: { ...write, destructiveHint: true },
      async run({ id, ...args }, call) {
        await archiveRoutingForm(context(call.caller), id, args)
        return { archived: true as const }
      },
    }),
  ])
}
