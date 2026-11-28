import { api, unwrap } from '../../api/client.ts'
import { requestError } from '../../api/errors.ts'
import type { operations } from '../../api/schema.d.ts'
import { unwrapSsoWrite } from '../../pages/sso/setup.ts'

const offerPath = '/api/v1/teams/{teamId}/ownership-transfer'
const confirmPath = '/api/v1/teams/{teamId}/ownership-transfer/{transferId}/confirm'
const revokePath = '/api/v1/teams/{teamId}/ownership-transfer/{transferId}/revoke'
const declinePath = '/api/v1/teams/{teamId}/ownership-transfer/{transferId}/decline'

export type TransferOffer = NonNullable<
  operations['getOwnershipTransfer']['responses'][200]['content']['application/json']['offer']
>

function headers(teamId: string) {
  return { 'x-expected-organization-id': teamId }
}

export function getTransferOffer(teamId: string, signal: AbortSignal, transferId?: string) {
  return unwrap(
    api.GET(offerPath, {
      params: {
        path: { teamId },
        header: headers(teamId),
        ...(transferId && { query: { transferId } }),
      },
      cache: 'no-store',
      signal,
    }),
  )
}

async function proofWrite<T>(call: Parameters<typeof unwrap<T>>[0]) {
  const result = await call
  if (result.response.status === 429)
    throw requestError(429, result.error, result.response.headers.get('Retry-After'))
  return unwrapSsoWrite(Promise.resolve(result))
}

export function offerTransfer(
  teamId: string,
  targetMembershipId: string,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  return proofWrite(
    api.POST(offerPath, {
      params: { path: { teamId }, header: headers(teamId) },
      body: { targetMembershipId, ...(proofAttemptId && { proofAttemptId }) },
      signal,
    }),
  )
}

export function confirmTransfer(
  teamId: string,
  transferId: string,
  signal: AbortSignal,
  proofAttemptId?: string,
) {
  return proofWrite(
    api.POST(confirmPath, {
      params: { path: { teamId, transferId }, header: headers(teamId) },
      body: proofAttemptId ? { proofAttemptId } : {},
      signal,
    }),
  )
}

export async function cancelTransfer(
  action: 'revoke' | 'decline',
  teamId: string,
  transferId: string,
  signal: AbortSignal,
) {
  const result = await api.POST(action === 'revoke' ? revokePath : declinePath, {
    params: { path: { teamId, transferId }, header: headers(teamId) },
    signal,
  })
  if (!result.response.ok)
    throw requestError(
      result.response.status,
      result.error,
      result.response.headers.get('Retry-After'),
    )
}
