import { api, type Schemas, unwrap } from '../../api/client.ts'

export type RoutingForm = Schemas['RoutingForm']
export type RoutingDraft = Pick<
  RoutingForm,
  'title' | 'slug' | 'description' | 'questions' | 'rules' | 'fallback'
>

const collection = '/api/v1/routing-forms'
const record = '/api/v1/routing-forms/{id}'

function organizationHeader(organizationId: string) {
  return { 'x-expected-organization-id': organizationId }
}

export function listRoutingForms(organizationId: string, signal: AbortSignal) {
  return unwrap(
    api.GET(collection, {
      cache: 'no-store',
      signal,
      params: {
        header: organizationHeader(organizationId),
        // The active-form quota is 100, including disabled forms.
        query: { limit: 100 },
      },
    }),
  )
}

export function getRoutingForm(organizationId: string, id: string, signal: AbortSignal) {
  return unwrap(
    api.GET(record, {
      cache: 'no-store',
      signal,
      params: { header: organizationHeader(organizationId), path: { id } },
    }),
  )
}

export function createRoutingForm(organizationId: string, body: Schemas['CreateRoutingForm']) {
  return unwrap(
    api.POST(collection, {
      cache: 'no-store',
      params: { header: organizationHeader(organizationId) },
      body,
    }),
  )
}

export function saveRoutingForm(
  organizationId: string,
  id: string,
  expectedRevision: number,
  draft: RoutingDraft,
) {
  return unwrap(
    api.PATCH(record, {
      cache: 'no-store',
      params: { header: organizationHeader(organizationId), path: { id } },
      body: { ...draft, expectedRevision },
    }),
  )
}

export function setRoutingFormEnabled(
  organizationId: string,
  id: string,
  expectedRevision: number,
  enabled: boolean,
) {
  return unwrap(
    api.PATCH(record, {
      cache: 'no-store',
      params: { header: organizationHeader(organizationId), path: { id } },
      body: { expectedRevision, enabled },
    }),
  )
}

export function publishRoutingForm(
  organizationId: string,
  id: string,
  body: Schemas['PublishRoutingForm'],
) {
  return unwrap(
    api.POST('/api/v1/routing-forms/{id}/publish', {
      cache: 'no-store',
      params: { header: organizationHeader(organizationId), path: { id } },
      body,
    }),
  )
}

export function previewRoutingForm(
  organizationId: string,
  id: string,
  answers: Schemas['PreviewRoutingForm']['answers'],
  signal: AbortSignal,
) {
  return unwrap(
    api.POST('/api/v1/routing-forms/{id}/preview', {
      cache: 'no-store',
      signal,
      params: { header: organizationHeader(organizationId), path: { id } },
      body: { answers },
    }),
  )
}

export async function archiveRoutingForm(
  organizationId: string,
  id: string,
  expectedRevision: number,
): Promise<void> {
  await unwrap(
    api.DELETE(record, {
      cache: 'no-store',
      params: { header: organizationHeader(organizationId), path: { id } },
      body: { expectedRevision },
    }),
  )
}
