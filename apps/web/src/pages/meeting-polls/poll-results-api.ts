import { api, type Schemas, unwrap } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { operations } from '../../api/schema.d.ts'

export type PollResults = Schemas['MeetingPollHostResults']
export type PollVoter = PollResults['roster'][number]
export type PollCandidate = PollResults['candidates'][number]
export type FinalizeBody =
  operations['finalizeMeetingPoll']['requestBody']['content']['application/json']
export type FinalizeAttempt = { key: string; body: FinalizeBody }
export type LifecycleAction = 'close' | 'cancel' | 'delete'

export const POLL_STATUS = {
  open: 'Voting open',
  closed: 'Voting closed',
  scheduled: 'Poll scheduled',
  canceled: 'Poll canceled',
} as const

export async function loadPollResults(id: string, organizationId: string, signal: AbortSignal) {
  const results = await unwrap(
    api.GET('/api/v1/meeting-polls/{id}/results', {
      params: { path: { id } },
      signal,
      cache: 'no-store',
    }),
  )
  // The read uses the current session space. Discard a response from a different space.
  if (results.poll.organizationId !== organizationId)
    throw new RequestError(409, 'organization_context_changed', 'Organization context changed')
  return results
}

export async function changePoll(
  id: string,
  organizationId: string,
  expectedHostRevision: number,
  action: LifecycleAction,
) {
  const request = {
    params: { path: { id }, header: { 'x-expected-organization-id': organizationId } },
    body: { expectedHostRevision },
  }
  if (action === 'delete') {
    await unwrap(api.DELETE('/api/v1/meeting-polls/{id}', request))
    return
  }
  await unwrap(
    action === 'close'
      ? api.POST('/api/v1/meeting-polls/{id}/close', request)
      : api.POST('/api/v1/meeting-polls/{id}/cancel', request),
  )
}

export async function finalizePoll(id: string, organizationId: string, attempt: FinalizeAttempt) {
  const result = await unwrap(
    api.POST('/api/v1/meeting-polls/{id}/finalize', {
      params: {
        path: { id },
        header: {
          'x-expected-organization-id': organizationId,
          'idempotency-key': attempt.key,
        },
      },
      body: attempt.body,
    }),
  )
  if (!result?.booking?.id) throw new Error('Missing booking in finalization response')
  return result
}

export function eligibleVoters(roster: PollVoter[], slotId: string) {
  return roster.filter(
    (voter) =>
      voter.status === 'verified' &&
      voter.submittedAt !== null &&
      voter.consentedAt !== null &&
      voter.votes.some(
        (vote) => vote.slotId === slotId && (vote.value === 'yes' || vote.value === 'if_need_be'),
      ),
  )
}
