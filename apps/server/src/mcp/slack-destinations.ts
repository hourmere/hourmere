import { z } from '@hono/zod-openapi'
import {
  createSlackDestination,
  deleteSlackDestination,
  listSlackDestinations,
  SlackCreateInput,
  SlackUpdateInput,
  testSlackDestination,
  updateSlackDestination,
  type WebhookQueue,
  type WebhookSettings,
} from '@hourmere/webhooks'
import { type ServiceDeps, serviceContext } from '../openapi.ts'
import { SlackDestination } from '../routes/slack-destinations.ts'
import { slackTestLimiter } from '../slack-test-limit.ts'
import { defineTool, RateLimited, type Tool } from './tools.ts'

export function slackDestinationTools(
  deps: ServiceDeps & WebhookSettings & { queue?: WebhookQueue },
): Tool[] {
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }
  return [
    defineTool({
      name: 'list_slack_destinations',
      title: 'List Slack destinations',
      description:
        'List this organization’s Slack destinations as an owner/admin. Requires read or full API key scope. URLs are always masked.',
      input: z.strictObject({}),
      output: z.object({ data: z.array(SlackDestination) }),
      privateInput: () => true,
      privateDiagnostics: true,
      privateValidationMessage: 'Invalid Slack configuration',
      annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
      async run(_args, call) {
        return {
          data: (await listSlackDestinations(serviceContext(deps, call.caller))).map((row) =>
            SlackDestination.parse(row),
          ),
        }
      },
    }),
    defineTool({
      name: 'create_slack_destination',
      title: 'Create Slack destination',
      description:
        'Save an encrypted Slack incoming-webhook URL for this organization as an owner/admin. Requires full API key scope. URL is a bearer secret: supply privately and never quote it. Returns only a masked URL. No Slack OAuth or app installation in Hourmere is needed.',
      input: SlackCreateInput,
      output: SlackDestination,
      privateInput: () => true,
      privateDiagnostics: true,
      privateValidationMessage: 'Invalid Slack configuration',
      annotations,
      async run(args, call) {
        return SlackDestination.parse(
          await createSlackDestination(serviceContext(deps, call.caller), deps, args),
        )
      },
    }),
    defineTool({
      name: 'update_slack_destination',
      title: 'Update Slack destination',
      description:
        'Change the URL, subscriptions, event-type filter or enabled state of this organization’s Slack destination as an owner/admin. Requires full API key scope. Omitted fields are preserved. URLs are secrets and are only returned masked.',
      input: SlackUpdateInput.safeExtend({ id: z.uuid() }),
      output: SlackDestination,
      privateInput: () => true,
      privateDiagnostics: true,
      privateValidationMessage: 'Invalid Slack configuration',
      annotations: { ...annotations, idempotentHint: true },
      async run({ id, ...args }, call) {
        return SlackDestination.parse(
          await updateSlackDestination(serviceContext(deps, call.caller), id, args, deps),
        )
      },
    }),
    defineTool({
      name: 'delete_slack_destination',
      title: 'Delete Slack destination',
      description:
        'Delete this organization’s Slack destination and retained delivery records as an owner/admin. Requires full API key scope. Pending jobs safely skip.',
      input: z.strictObject({ id: z.uuid() }),
      output: z.object({ deleted: z.boolean() }),
      privateInput: () => true,
      privateDiagnostics: true,
      privateValidationMessage: 'Invalid Slack configuration',
      annotations: { ...annotations, destructiveHint: true, idempotentHint: true },
      async run({ id }, call) {
        await deleteSlackDestination(serviceContext(deps, call.caller), id)
        return { deleted: true }
      },
    }),
    defineTool({
      name: 'test_slack_destination',
      title: 'Test Slack destination',
      description:
        'Queue one synthetic sample notification for this enabled Slack destination as an owner/admin. Requires full API key scope. Delivery is asynchronous with bounded retries; this does not confirm Slack received it. At most five authorized attempts per organization per minute, shared with REST on this server; refused and unknown-destination calls are not counted. Returns slack_test_pending while a sample is pending.',
      input: z.strictObject({ id: z.uuid() }),
      output: z.object({ deliveryId: z.uuid() }),
      privateInput: () => true,
      privateDiagnostics: true,
      privateValidationMessage: 'Invalid Slack configuration',
      annotations: { ...annotations, openWorldHint: true },
      async run({ id }, call) {
        return testSlackDestination(
          serviceContext(deps, call.caller),
          deps,
          id,
          deps.queue,
          // Counted only after the final owner/admin check found the destination.
          () => {
            const retryAfter = slackTestLimiter.hit(call.caller.organization.id)
            if (retryAfter !== undefined) throw new RateLimited(retryAfter)
          },
        )
      },
    }),
  ]
}
