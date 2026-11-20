import { api, type Schemas, unwrap } from '../../api/client.ts'

export type RoutingForm = Schemas['RoutingForm']
export type RoutingDraft = Pick<RoutingForm, 'title' | 'slug' | 'description' | 'questions'>

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
