import { api, type Schemas } from '../../api/client.ts'
import { RequestError, requestError } from '../../api/errors.ts'
import type { paths } from '../../api/schema.d.ts'

export type CreatePollBody =
  paths['/api/v1/meeting-polls']['post']['requestBody']['content']['application/json']
export type InvitePollBody =
  paths['/api/v1/meeting-polls/{id}/invitations']['post']['requestBody']['content']['application/json']

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export class PollCreateConflict extends RequestError {
  readonly pollId: string | null | undefined
  readonly unavailableStarts: string[]

  constructor(error: RequestError, pollId: string | null | undefined, unavailableStarts: string[]) {
    super(error.status, error.code, error.message)
    this.pollId = pollId
    this.unavailableStarts = unavailableStarts
  }
}

export function isUncertainPollWrite(error: unknown) {
  return !(error instanceof RequestError) || error.status >= 500 || error.status === 408
}

function headers(organizationId: string) {
  return { 'x-expected-organization-id': organizationId }
}

function idempotencyHeaders(organizationId: string, key: string) {
  return { ...headers(organizationId), 'idempotency-key': key }
}

async function pollWrite<T extends { poll: Schemas['MeetingPollHost'] }>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
  organizationId: string,
  id?: string,
) {
  const { data, error, response } = await call
  if (!response.ok) {
    const issue = requestError(response.status, error, response.headers.get('Retry-After'))
    if (
      id === undefined &&
      response.status === 409 &&
      (issue.code === 'poll_already_created' || issue.code === 'slot_unavailable')
    ) {
      const details = error as { pollId?: unknown; unavailableStarts?: unknown }
      const pollId = details.pollId
      throw new PollCreateConflict(
        issue,
        pollId === null || (typeof pollId === 'string' && uuidPattern.test(pollId))
          ? pollId
          : undefined,
        Array.isArray(details.unavailableStarts)
          ? details.unavailableStarts.filter((value): value is string => typeof value === 'string')
          : [],
      )
    }
    throw issue
  }
  if (!data?.poll || typeof data.poll.id !== 'string') {
    throw new Error('Missing meeting poll in write response')
  }
  if (data.poll.organizationId !== organizationId || (id && data.poll.id !== id)) {
    throw new RequestError(409, 'organization_context_changed', 'Organization context changed')
  }
  return data
}

function checkLink(result: Schemas['MeetingPollLink']) {
  const valid =
    result.poll.admissionMode === 'public_link'
      ? typeof result.publicLink === 'string' && result.publicLink.length > 0
      : result.publicLink === null
  if (!valid) throw new Error('Missing public link in meeting poll response')
  return result
}

export async function createPoll(organizationId: string, body: CreatePollBody, key: string) {
  return checkLink(
    await pollWrite(
      api.POST('/api/v1/meeting-polls', {
        cache: 'no-store',
        params: { header: idempotencyHeaders(organizationId, key) },
        body,
      }),
      organizationId,
    ),
  )
}

export function invitePollVoters(
  id: string,
  organizationId: string,
  body: InvitePollBody,
  key: string,
) {
  return pollWrite(
    api.POST('/api/v1/meeting-polls/{id}/invitations', {
      cache: 'no-store',
      params: { path: { id }, header: idempotencyHeaders(organizationId, key) },
      body,
    }),
    organizationId,
    id,
  )
}

export function resendPollInvitation(
  id: string,
  organizationId: string,
  voterId: string,
  expectedHostRevision: number,
  key: string,
) {
  return pollWrite(
    api.POST('/api/v1/meeting-polls/{id}/invitations/{voterId}/resend', {
      cache: 'no-store',
      params: { path: { id, voterId }, header: idempotencyHeaders(organizationId, key) },
      body: { expectedHostRevision },
    }),
    organizationId,
    id,
  )
}

export function removePollVoter(
  id: string,
  organizationId: string,
  voterId: string,
  expectedHostRevision: number,
) {
  return pollWrite(
    api.DELETE('/api/v1/meeting-polls/{id}/voters/{voterId}', {
      cache: 'no-store',
      params: { path: { id, voterId }, header: headers(organizationId) },
      body: { expectedHostRevision },
    }),
    organizationId,
    id,
  )
}

export function removeUnverifiedPollVoters(
  id: string,
  organizationId: string,
  expectedHostRevision: number,
) {
  return pollWrite(
    api.POST('/api/v1/meeting-polls/{id}/remove-unverified', {
      cache: 'no-store',
      params: { path: { id }, header: headers(organizationId) },
      body: { expectedHostRevision },
    }),
    organizationId,
    id,
  )
}

export async function rotatePollLink(
  id: string,
  organizationId: string,
  expectedHostRevision: number,
  key: string,
) {
  return checkLink(
    await pollWrite(
      api.POST('/api/v1/meeting-polls/{id}/rotate-link', {
        cache: 'no-store',
        params: { path: { id }, header: idempotencyHeaders(organizationId, key) },
        body: { expectedHostRevision },
      }),
      organizationId,
      id,
    ),
  )
}
