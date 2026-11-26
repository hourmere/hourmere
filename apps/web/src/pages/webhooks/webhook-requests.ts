import { api, type Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { WebhookDraft, WebhookEndpoint, WebhookEvent } from './WebhookViews.tsx'

export type WebhookAction =
  | { type: 'create'; draft: WebhookDraft }
  | { type: 'events'; id: string; events: WebhookEvent[] }
  | { type: 'active'; id: string; isActive: boolean }
  | { type: 'delete'; id: string }
  | { type: 'rotate'; id: string }

type Outcome =
  | { type: 'create'; endpoint: WebhookEndpoint; secret: string }
  | { type: 'update'; endpoint: WebhookEndpoint }
  | { type: 'delete' }
  | { type: 'rotate'; secret: string }

export const webhookContextError = () =>
  new RequestError(409, 'organization_context_changed', 'Webhook organization changed')

const options = (organizationId: string, signal: AbortSignal) => ({
  signal,
  cache: 'no-store' as const,
  params: { header: { 'x-expected-organization-id': organizationId } },
})

async function dataFrom<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
  status: number,
): Promise<T> {
  const { data, error, response } = await call
  if (response.status !== status) {
    const code =
      error && typeof error === 'object' && 'error' in error && typeof error.error === 'string'
        ? error.error
        : undefined
    // Destinations can contain credentials. Keep only the machine-readable refusal code.
    throw new RequestError(response.status, code, 'Webhook request failed')
  }
  return data as T
}

function endpointFrom(
  endpoint: Schemas['Webhook'],
  organizationId: string,
  expectedId?: string,
): WebhookEndpoint {
  if (endpoint.organizationId !== organizationId || (expectedId && endpoint.id !== expectedId)) {
    throw webhookContextError()
  }
  const url = new URL(endpoint.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid webhook metadata')
  }
  return {
    id: endpoint.id,
    organizationId,
    origin: url.origin,
    events: endpoint.events,
    isActive: endpoint.isActive,
  }
}

function secretFrom(result: { secret: string }): string {
  if (typeof result.secret !== 'string' || !result.secret.trim()) {
    throw new Error('Missing webhook signing secret')
  }
  return result.secret
}

export async function readWebhooks(organizationId: string, signal: AbortSignal) {
  const rows = await dataFrom(api.GET('/api/v1/webhooks', options(organizationId, signal)), 200)
  return rows.map((row) => endpointFrom(row, organizationId))
}

export async function changeWebhook(
  organizationId: string,
  action: WebhookAction,
  signal: AbortSignal,
): Promise<Outcome> {
  const request = options(organizationId, signal)
  if (action.type === 'create') {
    const result = await dataFrom(
      api.POST('/api/v1/webhooks', { ...request, body: action.draft }),
      201,
    )
    return {
      type: 'create',
      endpoint: endpointFrom(result.webhook, organizationId),
      secret: secretFrom(result),
    }
  }

  const byId = { ...request, params: { ...request.params, path: { id: action.id } } }
  if (action.type === 'delete') {
    await dataFrom(api.DELETE('/api/v1/webhooks/{id}', byId), 204)
    return { type: 'delete' }
  }
  if (action.type === 'rotate') {
    const result = await dataFrom(api.POST('/api/v1/webhooks/{id}/rotate-secret', byId), 200)
    return { type: 'rotate', secret: secretFrom(result) }
  }

  const body = action.type === 'events' ? { events: action.events } : { isActive: action.isActive }
  const row = await dataFrom(api.PATCH('/api/v1/webhooks/{id}', { ...byId, body }), 200)
  return { type: 'update', endpoint: endpointFrom(row, organizationId, action.id) }
}
