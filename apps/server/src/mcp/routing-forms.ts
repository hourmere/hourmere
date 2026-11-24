import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  archiveRoutingForm,
  createRoutingForm,
  getPublicRoutingForm,
  getRoutingForm,
  listRoutingForms,
  previewRoutingForm,
  publishRoutingForm,
  type ServiceContext,
  updateRoutingForm,
} from '@hourmere/scheduling'
import {
  PersonalRoutingFormAddress,
  PublicRoutingForm,
  TeamRoutingFormAddress,
} from '../routes/public-routing-forms.ts'
import {
  findRoutingContinuationSlots,
  RoutingContinuation,
  RoutingContinuationInput,
  RoutingContinuationSlots,
  RoutingContinuationSlotsInput,
  readRoutingContinuation,
} from '../routes/routing-continuations.ts'
import {
  ArchiveRoutingForm,
  CreateRoutingForm,
  PreviewRoutingForm,
  PublishRoutingForm,
  ROUTING_FORM_PREVIEW_BEHAVIOR,
  ROUTING_FORM_PUBLICATION_BEHAVIOR,
  ROUTING_FORMS_DISABLED,
  RoutingFormId,
  RoutingFormList,
  RoutingFormListInput,
  RoutingFormPreview,
  RoutingFormPublication,
  RoutingFormResponse,
  UpdateRoutingForm,
} from '../routes/routing-forms.ts'
import {
  RoutingSubmission,
  RoutingSubmissionResponse,
  routingFormTools,
  submitPublicRoutingForm,
} from '../routing-forms.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

const publicAddress = {
  handle: PersonalRoutingFormAddress.shape.handle.optional(),
  teamSlug: TeamRoutingFormAddress.shape.teamSlug.optional(),
  slug: PersonalRoutingFormAddress.shape.slug,
}
const hasOneOwner = (input: z.infer<typeof PublicAddress>) =>
  (input.handle === undefined) !== (input.teamSlug === undefined)
const ownerRequirement = { message: 'Give exactly one of handle or teamSlug' }
const PublicAddress = z.strictObject(publicAddress)
const PublicRoutingFormInput = PublicAddress.refine(hasOneOwner, ownerRequirement)
const RouteLeadInput = PublicAddress.extend(RoutingSubmission.shape).refine(
  hasOneOwner,
  ownerRequirement,
)

function routingFormAddress({ handle, teamSlug, slug }: z.infer<typeof PublicAddress>) {
  return teamSlug === undefined ? { handle: handle as string, slug } : { teamSlug, slug }
}

export function routingFormConfigurationTools({
  db,
  routingFormsEnabled = false,
  routingSecret,
  publicUrl = 'http://localhost:3000',
  automaticMeet,
  automaticZoom,
  smsRemindersAvailable,
}: {
  db: Db
  routingFormsEnabled?: boolean | undefined
  routingSecret?: string | undefined
  publicUrl?: string | undefined
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  smsRemindersAvailable?: boolean | undefined
}): Tool[] {
  const now = () => Temporal.Now.instant()
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    ...(principal.scimResourcesEnabled && { scimResourcesEnabled: true }),
    now,
  })
  const continuation = {
    db,
    now,
    routingFormsEnabled,
    routingSecret,
    automaticMeet,
    automaticZoom,
    smsRemindersAvailable,
  }
  const privateContinuation = {
    privateInput: () => true,
    privateValidationMessage: 'Invalid routing continuation request',
    privateDiagnostics: true,
  }
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
    defineTool({
      name: 'publish_routing_form',
      title: 'Publish a routing form',
      description: `${description} ${ROUTING_FORM_PUBLICATION_BEHAVIOR}`,
      input: PublishRoutingForm.extend(RoutingFormId.shape),
      output: RoutingFormPublication,
      annotations: write,
      run: ({ id, ...args }, call) => publishRoutingForm(context(call.caller), id, args),
    }),
    defineTool({
      name: 'preview_routing_form',
      title: 'Preview a routing form draft',
      description: `${ROUTING_FORMS_DISABLED} ${ROUTING_FORM_PREVIEW_BEHAVIOR}`,
      input: PreviewRoutingForm.extend(RoutingFormId.shape),
      output: RoutingFormPreview,
      annotations: read,
      privateDiagnostics: true,
      run: ({ id, ...args }, call) => previewRoutingForm(context(call.caller), id, args),
    }),
    defineTool({
      name: 'get_public_routing_form',
      title: 'Read a public routing form',
      description: `${ROUTING_FORMS_DISABLED} Supply the form slug and exactly one of handle (personal) or teamSlug (team). Returns the current version ID, form text and published questions, with IDs and labels for answer choices. Accepts read, bookings or full keys, or an authorized MCP OAuth connection.`,
      input: PublicRoutingFormInput,
      output: PublicRoutingForm,
      annotations: read,
      privateDiagnostics: true,
      run: (args) => getPublicRoutingForm(db, routingFormAddress(args)),
    }),
    defineTool({
      name: 'route_lead',
      title: 'Submit answers to a public routing form',
      description: `${ROUTING_FORMS_DISABLED} Supply the form slug, exactly one of handle (personal) or teamSlug (team), the current versionId and answers keyed by question UUID. On routing_form_changed, reload the form and review the answers. Returns a plain-text message or a private, expiring routeToken and a server-built continuationUrl to share only with the invitee. Accepts bookings or full keys, or an authorized MCP OAuth connection.`,
      input: RouteLeadInput,
      // Keep structuredContent identical on both MCP protocol eras.
      output: RoutingSubmissionResponse.meta({ type: 'object' }),
      annotations: write,
      privateInput: () => true,
      privateValidationMessage: 'Invalid routing submission',
      privateDiagnostics: true,
      run: ({ handle, teamSlug, slug, ...input }) =>
        submitPublicRoutingForm(
          { db, routingFormsEnabled, routingSecret, publicUrl },
          routingFormAddress({ handle, teamSlug, slug }),
          input,
        ),
    }),
    defineTool({
      name: 'resolve_routing_continuation',
      title: 'Resolve a routing continuation',
      description: `${ROUTING_FORMS_DISABLED} Supply only the private routeToken from route_lead. Returns current booking fields, editable prefill and the original expiry. The token expires 30 minutes after issuance and reads do not consume or renew it. Accepts bookings or full keys, or an authorized MCP OAuth connection.`,
      input: RoutingContinuationInput,
      output: RoutingContinuation,
      annotations: read,
      ...privateContinuation,
      run: (args) => readRoutingContinuation(continuation, args),
    }),
    defineTool({
      name: 'find_routed_slots',
      title: 'Find slots for the selected event',
      description: `${ROUTING_FORMS_DISABLED} Supply the private routeToken from route_lead and start/end RFC 3339 instants. The event is selected by the capability. Use durationMinutes and locationOptionId from resolve_routing_continuation if needed. Available times are not reserved. Accepts bookings or full keys, or an authorized MCP OAuth connection.`,
      input: RoutingContinuationSlotsInput,
      output: RoutingContinuationSlots,
      annotations: read,
      ...privateContinuation,
      run: (args) => findRoutingContinuationSlots(continuation, args),
    }),
  ])
}
