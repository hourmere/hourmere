import { api, type Schemas, unwrap } from './client.ts'
import { RequestError, requestError } from './errors.ts'
import type { paths } from './schema.d.ts'

type LeaveConflict =
  paths['/api/v1/teams/{teamId}/leave']['post']['responses'][409]['content']['application/json']
export type DepartureHandling = NonNullable<LeaveConflict['handling']>

/** Preserve the server's concrete recovery list alongside the ordinary request error. */
export class MemberActionError extends RequestError {
  readonly impact: Schemas['MemberDepartureImpact'] | undefined
  readonly handling: DepartureHandling | undefined

  constructor(error: RequestError, details: Pick<LeaveConflict, 'impact' | 'handling'> = {}) {
    super(error.status, error.code, error.message, error.displayMessage, error.codeAlias)
    this.name = 'MemberActionError'
    this.impact = details.impact
    this.handling = details.handling
  }
}

export function getDepartureImpact(
  organizationId: string,
  memberUserId: string,
  cursors: { eventTypesCursor?: string; bookingsCursor?: string } = {},
  signal?: AbortSignal,
): Promise<Schemas['MemberDepartureImpact']> {
  return unwrap(
    api.GET('/api/v1/team/members/{memberUserId}/departure-impact', {
      params: {
        path: { memberUserId },
        query: { teamId: organizationId, ...cursors },
      },
      signal,
    }),
  )
}

/** The opening organization binds the write, including retries after a failed request. */
export async function leaveTeam(organizationId: string, signal?: AbortSignal) {
  const { data, error, response } = await api.POST('/api/v1/teams/{teamId}/leave', {
    params: { path: { teamId: organizationId } },
    headers: { 'X-Expected-Organization-Id': organizationId },
    body: {},
    signal,
  })
  if (!response.ok || !data) {
    throw new MemberActionError(requestError(response.status, error), {
      impact: error && 'impact' in error ? error.impact : undefined,
      handling: error && 'handling' in error ? error.handling : undefined,
    })
  }
  return data
}

export function removeMember(
  organizationId: string,
  memberUserId: string,
  signal?: AbortSignal,
): Promise<Schemas['MemberRemoval']> {
  return unwrap(
    api.POST('/api/v1/team/members/{memberUserId}/removal', {
      params: {
        path: { memberUserId },
        header: { 'x-expected-organization-id': organizationId },
      },
      body: { teamId: organizationId },
      signal,
    }),
  )
}

export function getRemovalHandling(
  organizationId: string,
  operationId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<Schemas['MemberRemovalHandling']> {
  return unwrap(
    api.GET('/api/v1/team/member-removals/{operationId}', {
      params: {
        path: { operationId },
        query: { teamId: organizationId, ...(cursor && { cursor }) },
      },
      signal,
    }),
  )
}
