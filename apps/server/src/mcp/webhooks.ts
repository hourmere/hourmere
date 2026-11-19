import { z } from '@hono/zod-openapi'
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  updateWebhook,
  WebhookCreateInput,
  type WebhookSettings,
  WebhookUpdateInput,
} from '@hourmere/webhooks'
import { type ServiceDeps, serviceContext } from '../openapi.ts'
import { Webhook, WebhookCreated } from '../routes/webhooks.ts'
import { defineTool, type Tool } from './tools.ts'

export function webhookTools(deps: ServiceDeps & WebhookSettings): Tool[] {
  return [
    defineTool({
      name: 'list_webhooks',
      title: 'List booking webhooks',
      description:
        'List signed booking webhooks in the organization bound to this credential. Requires a current organization owner or admin and read or full API key scope. Returns endpoint metadata in data; signing secrets are omitted.',
      input: z.strictObject({}),
      output: z.object({ data: z.array(Webhook) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(_args, call) {
        const rows = await listWebhooks(serviceContext(deps, call.caller))
        return { data: rows.map((row) => Webhook.parse(row)) }
      },
    }),
    defineTool({
      name: 'create_webhook',
      title: 'Create a booking webhook',
      description:
        'Create a signed booking webhook in the organization bound to this credential. Requires a current organization owner or admin and full API key scope. Supply a public HTTPS destination URL (or an operator-allowed private target) and distinct booking event kinds. The destination is immutable. Store the one-time signing secret securely.',
      input: WebhookCreateInput,
      output: WebhookCreated,
      privateDiagnostics: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      async run(args, call) {
        return WebhookCreated.parse(
          await createWebhook(serviceContext(deps, call.caller), deps, args),
        )
      },
    }),
    defineTool({
      name: 'update_webhook',
      title: 'Edit a booking webhook',
      description:
        'Change the subscriptions or enabled state of a webhook in the organization bound to this credential. Requires a current organization owner or admin and full API key scope. Supply the webhook id and at least one of events or isActive. Omitted fields are preserved. The destination URL is immutable. Use isActive: false alone to pause a webhook whose destination is no longer allowed.',
      input: WebhookUpdateInput.extend({ id: z.string() }),
      output: Webhook,
      privateDiagnostics: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      async run({ id, ...args }, call) {
        return Webhook.parse(await updateWebhook(serviceContext(deps, call.caller), id, args, deps))
      },
    }),
    defineTool({
      name: 'delete_webhook',
      title: 'Delete a booking webhook',
      description:
        'Delete the webhook and retained delivery records from the organization bound to this credential. Requires a current organization owner or admin and full API key scope. Supply the webhook id. Pending jobs safely skip; missing and foreign webhooks both return webhook_not_found.',
      input: z.strictObject({ id: z.string() }),
      output: z.object({ deleted: z.literal(true) }),
      privateDiagnostics: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run({ id }, call) {
        await deleteWebhook(serviceContext(deps, call.caller), id)
        return { deleted: true as const }
      },
    }),
  ]
}
